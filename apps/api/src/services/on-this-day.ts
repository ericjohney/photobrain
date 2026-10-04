import { type SQL, sql } from "drizzle-orm";
import { capturedDateSql, capturedMonthDaySql } from "../db/schema";
import type { CollectionCover } from "./collections";
import {
	type ApiDatabase,
	capturedDateCondition,
	isValidCapturedDate,
	pairStackingCondition,
} from "./photo-catalog";

/** At most this many year groups, most recent first. */
export const ON_THIS_DAY_MAX_YEARS = 20;

export type OnThisDayYear = {
	year: number;
	/** `date`'s year minus `year`; always >= 1. */
	yearsAgo: number;
	/** The `capturedDate` filter value that opens this group in the grid. */
	capturedDate: string;
	count: number;
	cover: CollectionCover;
};

/** `onThisDay` / `GET /api/v1/on-this-day` response. */
export type OnThisDayResult = { date: string; years: OnThisDayYear[] };

type OnThisDayRow = {
	year: string;
	captured_date: string;
	photo_count: number;
	cover_photo_id: number;
	cover_thumbnail_updated_at: number | null;
};

/**
 * Photos captured on `date`'s month and day in earlier years, one group per
 * year (most recent first, at most `ON_THIS_DAY_MAX_YEARS`, only years with a
 * photo). `date` is the client's local today as a real `YYYY-MM-DD` date.
 *
 * The capture date is the EXIF `date_taken` wall-clock date (`capturedDateSql`);
 * rows whose capture date is not `YYYY-MM-DD` digits, is before 1900, or is a
 * Feb 29 in a non-leap year never appear. Candidates come from the
 * `idx_exif_month_day` expression index, never a `photo_exif` scan.
 *
 * Feb 29 rule: on Feb 28 of a non-leap year, Feb 29 photos of earlier (leap)
 * years join those years' groups. Such a group's `capturedDate` is the year's
 * Feb 28 when it has any Feb 28 photo (its count then includes both days, while
 * the grid opened by `capturedDate` shows only Feb 28), else its Feb 29. A Feb 29
 * request matches only Feb 29; a leap-year Feb 28 request matches only Feb 28.
 *
 * Counted photos stack RAW+JPEG pairs exactly like the listing filtered by the
 * photo's own capture date (a RAW is dropped when its partner was captured on
 * the same date) and then exclude rejects, so `count` is the number of rows the
 * grid shows for `capturedDate` minus its rejects. The cover is the highest
 * `rating`, then latest capture time, then highest ID among counted photos.
 */
export function onThisDay(
	database: ApiDatabase,
	date: string,
): OnThisDayResult {
	if (!isValidCapturedDate(date)) {
		throw new RangeError(`Invalid date: ${date}`);
	}
	const year = Number(date.slice(0, 4));
	const monthDay = date.slice(5);
	// Feb 29 photos join Feb 28 only in years without a Feb 29.
	const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const monthDays =
		monthDay === "02-28" && !leapYear ? ["02-28", "02-29"] : [monthDay];
	const dateTaken = sql`candidate.date_taken`;
	const capturedDate = capturedDateSql(dateTaken);
	const yearText = sql`substr(${dateTaken}, 1, 4)`;
	const conditions: SQL[] = [
		sql`${capturedMonthDaySql(dateTaken)} IN (${sql.join(
			monthDays.map((value) => sql`${value}`),
			sql`, `,
		)})`,
		sql`${capturedDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
		sql`${yearText} >= '1900'`,
		sql`${yearText} < ${String(year)}`,
		// Feb 29 exists only in leap years.
		sql`(${capturedMonthDaySql(dateTaken)} <> '02-29' OR (CAST(${yearText} AS INTEGER) % 4 = 0 AND (CAST(${yearText} AS INTEGER) % 100 <> 0 OR CAST(${yearText} AS INTEGER) % 400 = 0)))`,
		sql`(photos.flag IS NULL OR photos.flag <> 'reject')`,
		// The listing's stacking scoped to `capturedDate = <this row's date>`.
		pairStackingCondition([capturedDateCondition(capturedDate)]),
	];
	const rows = database.all<OnThisDayRow>(sql`
		SELECT year, captured_date, photo_count, cover_photo_id, cover_thumbnail_updated_at
		FROM (
			SELECT
				year,
				min(captured_date) OVER (PARTITION BY year) AS captured_date,
				count(*) OVER (PARTITION BY year) AS photo_count,
				id AS cover_photo_id,
				thumbnail_updated_at AS cover_thumbnail_updated_at,
				row_number() OVER (
					PARTITION BY year
					ORDER BY rating DESC, captured_date DESC, capture_time DESC, id DESC
				) AS cover_rank
			FROM (
				SELECT
					photos.id AS id,
					photos.rating AS rating,
					photos.thumbnail_updated_at AS thumbnail_updated_at,
					${yearText} AS year,
					${capturedDate} AS captured_date,
					substr(${dateTaken}, 12) AS capture_time
				FROM photo_exif candidate
				INNER JOIN photos ON photos.id = candidate.photo_id
				WHERE ${sql.join(conditions, sql` AND `)}
			)
		)
		WHERE cover_rank = 1
		ORDER BY year DESC
		LIMIT ${ON_THIS_DAY_MAX_YEARS}
	`);
	return {
		date,
		years: rows.map((row) => ({
			year: Number(row.year),
			yearsAgo: year - Number(row.year),
			capturedDate: row.captured_date,
			count: row.photo_count,
			cover: {
				photoId: row.cover_photo_id,
				// Drizzle timestamp columns store whole seconds.
				thumbnailUpdatedAt:
					row.cover_thumbnail_updated_at === null
						? null
						: new Date(row.cover_thumbnail_updated_at * 1000),
			},
		})),
	};
}
