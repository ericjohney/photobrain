import { desc, inArray, type SQL, sql } from "drizzle-orm";
import {
	type PublicPhotoWithExif,
	photos as photosTable,
	publicPhotoColumns,
} from "../db/schema";
import {
	type ApiDatabase,
	pairedPhotoExtras,
	pairedPhotoIdSql,
} from "./photo-catalog";
import { MAX_CURATION_IDS, updatePhotoCuration } from "./photo-curation";
import { QUALITY_VERSION } from "./processing-versions";

/** Review reasons, in the order they are reported for a photo. */
export const JUNK_REASONS = [
	"screenshot",
	"document",
	"blurry",
	"dark",
] as const;
export type JunkReason = (typeof JUNK_REASONS)[number];
export const JUNK_ACTIONS = ["reject", "keep"] as const;
export type JunkAction = (typeof JUNK_ACTIONS)[number];

/** Minimum CLIP tag probability for a tag-based reason. */
export const JUNK_TAG_MIN_SCORE = 0.5;
/**
 * Laplacian variance and mean luma limits, measured on the committed `medium`
 * thumbnail. Calibrated on real photos; see "Junk Review" in apps/api/AGENTS.md.
 */
export const BLUR_THRESHOLD = 40;
export const DARK_THRESHOLD = 40;
export const JUNK_REVIEW_DEFAULT_LIMIT = 200;
export const JUNK_REVIEW_MAX_LIMIT = 500;
export const MAX_JUNK_RESOLVE_IDS = MAX_CURATION_IDS;
const DOCUMENT_TAGS = ["document", "receipt", "whiteboard", "text"] as const;

export type JunkCounts = { all: number } & Record<JunkReason, number>;

// Every fragment references the `photos` alias used by both the relational
// page query and the raw counts query. A RAW with a pair partner is never a
// candidate: the pair is reviewed once through its standard file, and
// `reject` (via `updatePhotoCuration`) flags both files. Videos are never
// candidates: their poster frame says nothing about the clip's quality.
const CANDIDATE = sql`photos.media_type = 'photo' AND photos.junk_dismissed = 0 AND photos.flag IS NULL AND photos.rating = 0 AND NOT (ifnull(photos.is_raw, 0) = 1 AND ${pairedPhotoIdSql()} IS NOT NULL)`;

const tagReason = (tags: readonly string[]) =>
	sql`EXISTS (SELECT 1 FROM photo_tags WHERE photo_tags.photo_id = photos.id AND photo_tags.tag IN (${sql.join(
		tags.map((tag) => sql`${tag}`),
		sql`, `,
	)}) AND photo_tags.score >= ${JUNK_TAG_MIN_SCORE})`;

// Only a measurement of the committed generation at the current version counts.
const qualityReason = (condition: SQL) =>
	sql`EXISTS (SELECT 1 FROM photo_quality WHERE photo_quality.photo_id = photos.id AND photo_quality.thumbnail_key = photos.thumbnail_key AND photo_quality.quality_version = ${QUALITY_VERSION} AND ${condition})`;

const REASON_SQL: Record<JunkReason, SQL> = {
	screenshot: tagReason(["screenshot"]),
	document: tagReason(DOCUMENT_TAGS),
	blurry: qualityReason(sql`photo_quality.sharpness < ${BLUR_THRESHOLD}`),
	dark: qualityReason(sql`photo_quality.brightness < ${DARK_THRESHOLD}`),
};

const ANY_REASON = sql`(${sql.join(
	JUNK_REASONS.map((reason) => REASON_SQL[reason]),
	sql` OR `,
)})`;

export type JunkReviewInput = {
	reason?: JunkReason;
	limit?: number;
	cursor?: number;
};

export type JunkReviewPhoto = PublicPhotoWithExif & {
	junkReasons: JunkReason[];
};

export type JunkReviewResult = {
	photos: JunkReviewPhoto[];
	nextCursor: number | null;
	counts: JunkCounts;
};

/**
 * Candidates: not dismissed, unflagged, unrated photos with at least one reason.
 * Pages are photo ID descending (newest import first; `listPhotos` has no date
 * order to share), keyset-paginated by `cursor` (exclusive). Counts cover every
 * candidate regardless of `reason` and `cursor`. Two statements: the page with
 * EXIF hydration, and the counts.
 */
export async function junkReview(
	database: ApiDatabase,
	input: JunkReviewInput = {},
): Promise<JunkReviewResult> {
	const limit = input.limit ?? JUNK_REVIEW_DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > JUNK_REVIEW_MAX_LIMIT) {
		throw new RangeError(
			`Limit must be an integer from 1 to ${JUNK_REVIEW_MAX_LIMIT}`,
		);
	}
	if (
		input.cursor !== undefined &&
		(!Number.isInteger(input.cursor) || input.cursor < 1)
	) {
		throw new RangeError("Cursor must be a positive photo ID");
	}
	if (input.reason !== undefined && !JUNK_REASONS.includes(input.reason)) {
		throw new RangeError(`Unknown junk reason ${input.reason}`);
	}

	const conditions = [
		CANDIDATE,
		input.reason ? REASON_SQL[input.reason] : ANY_REASON,
	];
	if (input.cursor !== undefined) {
		conditions.push(sql`photos.id < ${input.cursor}`);
	}
	const rows = await database.query.photos.findMany({
		columns: publicPhotoColumns,
		with: { exif: true },
		extras: {
			...pairedPhotoExtras,
			junkScreenshot: sql<number>`${REASON_SQL.screenshot}`.as(
				"junk_screenshot",
			),
			junkDocument: sql<number>`${REASON_SQL.document}`.as("junk_document"),
			junkBlurry: sql<number>`${REASON_SQL.blurry}`.as("junk_blurry"),
			junkDark: sql<number>`${REASON_SQL.dark}`.as("junk_dark"),
		},
		where: sql.join(conditions, sql` AND `),
		orderBy: desc(photosTable.id),
		limit: limit + 1,
	});
	const page = rows.slice(0, limit);
	const photos = page.map(
		({
			junkScreenshot,
			junkDocument,
			junkBlurry,
			junkDark,
			...photo
		}): JunkReviewPhoto => {
			const flags = [junkScreenshot, junkDocument, junkBlurry, junkDark];
			return {
				...photo,
				junkReasons: JUNK_REASONS.filter((_, index) => Boolean(flags[index])),
			};
		},
	);
	return {
		photos,
		nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
		counts: junkCounts(database),
	};
}

/** Per-reason and total candidate counts in one statement. */
export function junkCounts(database: ApiDatabase): JunkCounts {
	// MATERIALIZED keeps each EXISTS evaluated once per candidate rather than
	// re-inlined into every aggregate. The aggregate always yields one row.
	const [counts] = database.all<JunkCounts>(sql`
		WITH reasons AS MATERIALIZED (
			SELECT
				${REASON_SQL.screenshot} AS screenshot,
				${REASON_SQL.document} AS document,
				${REASON_SQL.blurry} AS blurry,
				${REASON_SQL.dark} AS dark
			FROM photos
			WHERE ${CANDIDATE}
		)
		SELECT
			count(*) AS "all",
			coalesce(sum(screenshot), 0) AS screenshot,
			coalesce(sum(document), 0) AS document,
			coalesce(sum(blurry), 0) AS blurry,
			coalesce(sum(dark), 0) AS dark
		FROM reasons
		WHERE screenshot OR document OR blurry OR dark
	`);
	return counts;
}

/**
 * `reject` flags photos through the curation service; `keep` dismisses them
 * from review permanently. Unknown IDs are ignored; `updated` lists existing
 * photos written, ascending.
 */
export function resolveJunk(
	database: ApiDatabase,
	photoIds: readonly number[],
	action: JunkAction,
): { updated: number[] } {
	const ids = [...new Set(photoIds)];
	if (ids.length === 0 || ids.length > MAX_JUNK_RESOLVE_IDS) {
		throw new RangeError(
			`Expected 1-${MAX_JUNK_RESOLVE_IDS} photo IDs, received ${ids.length}`,
		);
	}
	if (action === "reject") {
		const { updated } = updatePhotoCuration(database, ids, { flag: "reject" });
		return { updated: updated.map((photo) => photo.id) };
	}
	if (action !== "keep") {
		throw new RangeError(`Unknown junk action ${String(action)}`);
	}
	const updated = database.transaction((tx) =>
		tx
			.update(photosTable)
			.set({ junkDismissed: true })
			.where(inArray(photosTable.id, ids))
			.returning({ id: photosTable.id })
			.all(),
	);
	return {
		updated: updated
			.map((photo) => photo.id)
			.sort((left, right) => left - right),
	};
}
