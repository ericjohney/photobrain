/**
 * Timeline grouping and capture-date calendar logic for the library grid.
 *
 * A photo's capture date is the wall-clock EXIF `dateTaken` (`YYYY:MM:DD
 * HH:MM:SS` or ISO-like `YYYY-MM-DD...`), read from its digits and never
 * converted between time zones. The timeline falls back to `modifiedAt`,
 * then `createdAt`, in local time; the calendar counts EXIF dates only,
 * because the API's `capturedDate` filter matches only EXIF.
 */

export type TimelineGrouping = "years" | "months" | "all";
export type TimelineSort = "captured" | "added";

export const TIMELINE_GROUPINGS: readonly TimelineGrouping[] = [
	"years",
	"months",
	"all",
];
export const TIMELINE_SORTS: readonly TimelineSort[] = ["captured", "added"];

/** The photo fields the timeline reads (a subset of the photo DTO). */
export interface TimelinePhoto {
	id: number;
	createdAt: Date | null;
	modifiedAt: Date | null;
	exif: { dateTaken: string | null } | null;
}

export interface TimelineSection<T> {
	/** `2023-10` (months), `2023` (years), or `unknown`. */
	id: string;
	/** "October 2023", "2023", or "Unknown date". */
	title: string;
	/** Calendar year, or null for the "Unknown date" section. */
	year: number | null;
	photos: T[];
}

export interface Timeline<T> {
	/** Every photo in display order: what the grid, loupe, and filmstrip walk. */
	photos: T[];
	/** Sections in display order; null for a single ungrouped grid. */
	sections: TimelineSection<T>[] | null;
}

export const UNKNOWN_DATE_TITLE = "Unknown date";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year: number, month: number) {
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
}

/** Integer value of `length` ASCII digits at `start`, or -1 if any is not a digit. */
function digitsAt(value: string, start: number, length: number) {
	let result = 0;
	for (let i = start; i < start + length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return -1;
		result = result * 10 + code - 48;
	}
	return result;
}

/**
 * The capture day of an EXIF `dateTaken`: its first 10 characters with `:`
 * as `-` (the API's `capturedDateSql`), only when that is a real
 * `YYYY-MM-DD` date in year 1900 or later (what `capturedDate` accepts).
 */
export function capturedDayKey(
	dateTaken: string | null | undefined,
): string | null {
	if (!dateTaken || dateTaken.length < 10) return null;
	const key = dateTaken.slice(0, 10).replace(/:/g, "-");
	if (key.charCodeAt(4) !== 45 || key.charCodeAt(7) !== 45) return null;
	const year = digitsAt(key, 0, 4);
	const month = digitsAt(key, 5, 2);
	const day = digitsAt(key, 8, 2);
	if (year < 1900 || month < 1 || month > 12 || day < 1) return null;
	return day <= daysInMonth(year, month) ? key : null;
}

/**
 * Wall-clock milliseconds (local time expressed as if it were UTC), so EXIF
 * wall-clock times and local fallback dates compare on one scale.
 */
function exifWallClock(dateTaken: string, dayKey: string) {
	const year = digitsAt(dayKey, 0, 4);
	const month = digitsAt(dayKey, 5, 2);
	const day = digitsAt(dayKey, 8, 2);
	// Time is optional: `HH:MM[:SS]` after a `T` or space separator.
	let hours = digitsAt(dateTaken, 11, 2);
	let minutes = digitsAt(dateTaken, 14, 2);
	let seconds =
		dateTaken.charCodeAt(16) === 58 ? digitsAt(dateTaken, 17, 2) : 0;
	if (
		hours < 0 ||
		hours > 23 ||
		dateTaken.charCodeAt(13) !== 58 ||
		minutes < 0 ||
		minutes > 59 ||
		seconds < 0 ||
		seconds > 59
	) {
		hours = 0;
		minutes = 0;
		seconds = 0;
	}
	return Date.UTC(year, month - 1, day, hours, minutes, seconds);
}

function validDate(value: Date | null | undefined): value is Date {
	return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The timeline date of `photo` as wall-clock milliseconds: the EXIF capture
 * time, else `modifiedAt`, else `createdAt` in local time; null when none is
 * usable ("Unknown date").
 */
export function timelineWallClock(photo: TimelinePhoto): number | null {
	const dateTaken = photo.exif?.dateTaken;
	const dayKey = capturedDayKey(dateTaken);
	if (dateTaken && dayKey) return exifWallClock(dateTaken, dayKey);
	const fallback = validDate(photo.modifiedAt)
		? photo.modifiedAt
		: validDate(photo.createdAt)
			? photo.createdAt
			: null;
	if (!fallback) return null;
	return fallback.getTime() - fallback.getTimezoneOffset() * 60_000;
}

const monthTitleFormat = new Intl.DateTimeFormat(undefined, {
	month: "long",
	year: "numeric",
	timeZone: "UTC",
});

/** Localized month title, e.g. "October 2023" (month is 1-12). */
export function formatTimelineMonth(year: number, month: number) {
	const date = new Date(Date.UTC(2000, month - 1, 1));
	// Two-digit years would otherwise map to 19xx.
	date.setUTCFullYear(year);
	return monthTitleFormat.format(date);
}

/** True when `photos` is already in ascending ID order. */
function sortedById(photos: readonly TimelinePhoto[]) {
	for (let i = 1; i < photos.length; i++) {
		if (photos[i - 1].id > photos[i].id) return false;
	}
	return true;
}

/**
 * Orders and groups the library for display.
 *
 * - `added`: ascending photo ID, one ungrouped grid.
 * - `captured`: ascending timeline date with ID tiebreak (oldest first),
 *   photos without any usable date last; grouped into years or months, or
 *   one ungrouped grid for `all`. Undated photos form a final "Unknown date"
 *   section.
 */
export function groupPhotos<T extends TimelinePhoto>(
	photos: T[],
	grouping: TimelineGrouping,
	sort: TimelineSort,
): Timeline<T> {
	if (sort === "added") {
		return {
			photos: sortedById(photos)
				? photos
				: [...photos].sort((a, b) => a.id - b.id),
			sections: null,
		};
	}

	const count = photos.length;
	// Undated photos sort last; NaN never compares, so use +Infinity.
	const keys = new Float64Array(count);
	const order = new Array<number>(count);
	for (let i = 0; i < count; i++) {
		keys[i] = timelineWallClock(photos[i]) ?? Number.POSITIVE_INFINITY;
		order[i] = i;
	}
	order.sort(
		(a, b) =>
			(keys[a] === keys[b] ? 0 : keys[a] < keys[b] ? -1 : 1) ||
			photos[a].id - photos[b].id,
	);
	const sorted = order.map((index) => photos[index]);
	if (grouping === "all") return { photos: sorted, sections: null };

	const sections: TimelineSection<T>[] = [];
	for (let i = 0; i < count; i++) {
		const key = keys[order[i]];
		let id: string;
		let year: number | null = null;
		let month = 0;
		if (key === Number.POSITIVE_INFINITY) {
			id = "unknown";
		} else {
			const date = new Date(key);
			year = date.getUTCFullYear();
			month = date.getUTCMonth() + 1;
			id =
				grouping === "years"
					? String(year)
					: `${year}-${String(month).padStart(2, "0")}`;
		}
		const current = sections[sections.length - 1];
		if (current?.id === id) {
			current.photos.push(sorted[i]);
		} else {
			sections.push({
				id,
				title:
					year === null
						? UNKNOWN_DATE_TITLE
						: grouping === "years"
							? String(year)
							: formatTimelineMonth(year, month),
				year,
				photos: [sorted[i]],
			});
		}
	}
	return { photos: sorted, sections };
}

/**
 * Photos per EXIF capture day (`YYYY-MM-DD`), counted from `photos` only:
 * fallback dates are not capture dates, so they are never counted.
 */
export function countCapturedDays(
	photos: readonly TimelinePhoto[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const photo of photos) {
		const day = capturedDayKey(photo.exif?.dateTaken);
		if (day) counts.set(day, (counts.get(day) ?? 0) + 1);
	}
	return counts;
}

/** Ascending `YYYY-MM` months that have at least one counted day. */
export function capturedMonths(counts: ReadonlyMap<string, number>): string[] {
	const months = new Set<string>();
	for (const day of counts.keys()) months.add(day.slice(0, 7));
	return [...months].sort();
}

/**
 * The calendar's first month: the month of the active `capturedDate` filter,
 * else the newest month with photos, else null.
 */
export function initialCalendarMonth(
	months: readonly string[],
	capturedDate: string | null,
): string | null {
	if (capturedDate) return capturedDate.slice(0, 7);
	return months.length > 0 ? months[months.length - 1] : null;
}

/**
 * The nearest month before (`-1`) or after (`1`) `month` that has photos,
 * skipping empty months; null at either end. `months` is ascending.
 */
export function adjacentCalendarMonth(
	months: readonly string[],
	month: string,
	direction: -1 | 1,
): string | null {
	if (direction === 1) return months.find((m) => m > month) ?? null;
	for (let i = months.length - 1; i >= 0; i--) {
		if (months[i] < month) return months[i];
	}
	return null;
}

/**
 * Calendar weeks for `month` (`YYYY-MM`): `YYYY-MM-DD` day keys, with null
 * padding before the first and after the last day. `firstWeekday` is
 * 0 (Sunday) to 6 (Saturday).
 */
export function calendarWeeks(
	month: string,
	firstWeekday: number,
): (string | null)[][] {
	const year = Number(month.slice(0, 4));
	const monthNumber = Number(month.slice(5, 7));
	const first = new Date(Date.UTC(2000, monthNumber - 1, 1));
	first.setUTCFullYear(year);
	const leading = (first.getUTCDay() - firstWeekday + 7) % 7;
	const cells: (string | null)[] = new Array(leading).fill(null);
	const days = daysInMonth(year, monthNumber);
	for (let day = 1; day <= days; day++) {
		cells.push(`${month}-${String(day).padStart(2, "0")}`);
	}
	while (cells.length % 7 !== 0) cells.push(null);
	const weeks: (string | null)[][] = [];
	for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
	return weeks;
}

type WeekInfoLocale = Intl.Locale & {
	getWeekInfo?: () => { firstDay: number };
	weekInfo?: { firstDay: number };
};

/**
 * The locale's first day of the week, 0 (Sunday) to 6 (Saturday); Monday
 * when the runtime does not expose week data.
 */
export function localeFirstWeekday(
	locale = new Intl.DateTimeFormat().resolvedOptions().locale,
): number {
	try {
		const info = new Intl.Locale(locale) as WeekInfoLocale;
		const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
		// Intl week data numbers days 1 (Monday) to 7 (Sunday).
		if (firstDay !== undefined && firstDay >= 1 && firstDay <= 7) {
			return firstDay % 7;
		}
	} catch {
		// Fall through to Monday.
	}
	return 1;
}

const weekdayFormat = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	timeZone: "UTC",
});

/** Localized short weekday names starting at `firstWeekday`. */
export function weekdayLabels(firstWeekday: number): string[] {
	// January 1, 2023 was a Sunday.
	return Array.from({ length: 7 }, (_, i) =>
		weekdayFormat.format(
			new Date(Date.UTC(2023, 0, 1 + ((firstWeekday + i) % 7))),
		),
	);
}

const dayLabelFormat = new Intl.DateTimeFormat(undefined, {
	dateStyle: "long",
	timeZone: "UTC",
});

/** Localized long date for a `YYYY-MM-DD` day key, e.g. "October 3, 2023". */
export function formatCalendarDay(day: string) {
	const date = new Date(
		Date.UTC(2000, Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))),
	);
	date.setUTCFullYear(Number(day.slice(0, 4)));
	return dayLabelFormat.format(date);
}

/** Localized title of a `YYYY-MM` calendar month, e.g. "October 2023". */
export function formatCalendarMonth(month: string) {
	return formatTimelineMonth(
		Number(month.slice(0, 4)),
		Number(month.slice(5, 7)),
	);
}
