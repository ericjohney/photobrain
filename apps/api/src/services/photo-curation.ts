import { sql } from "drizzle-orm";
import { photos } from "../db/schema";
import { type ApiDatabase, photoIdsWithPartnersSql } from "./photo-catalog";

export const MAX_CURATION_IDS = 500;
export const PHOTO_FLAGS = ["pick", "reject"] as const;

export type PhotoFlag = (typeof PHOTO_FLAGS)[number];

export type PhotoCurationPatch = {
	rating?: number;
	flag?: PhotoFlag | null;
};

export type PhotoCuration = {
	id: number;
	rating: number;
	flag: PhotoFlag | null;
};

export type PhotoCurationResult = { updated: PhotoCuration[] };

/**
 * Applies a rating and/or flag to every listed photo and its RAW+JPEG pair
 * partner in one UPDATE statement, so both files of a pair stay in step.
 * Unknown IDs are ignored; `updated` lists only rows that exist after the
 * write, partners included, ascending by ID. Transports validate input first;
 * these checks keep the service safe for any caller.
 */
export function updatePhotoCuration(
	database: ApiDatabase,
	photoIds: readonly number[],
	patch: PhotoCurationPatch,
): PhotoCurationResult {
	const ids = [...new Set(photoIds)];
	if (ids.length === 0 || ids.length > MAX_CURATION_IDS) {
		throw new RangeError(
			`Expected 1-${MAX_CURATION_IDS} photo IDs, received ${ids.length}`,
		);
	}
	const set: PhotoCurationPatch = {};
	if (patch.rating !== undefined) {
		if (
			!Number.isInteger(patch.rating) ||
			patch.rating < 0 ||
			patch.rating > 5
		) {
			throw new RangeError("Rating must be an integer from 0 to 5");
		}
		set.rating = patch.rating;
	}
	if (patch.flag !== undefined) {
		if (patch.flag !== null && !PHOTO_FLAGS.includes(patch.flag)) {
			throw new RangeError("Flag must be pick, reject, or null");
		}
		set.flag = patch.flag;
	}
	if (Object.keys(set).length === 0) {
		throw new RangeError("Curation patch must set rating or flag");
	}

	// Bun SQLite transactions are synchronous; RETURNING yields only existing rows.
	const updated = database.transaction((tx) =>
		tx
			.update(photos)
			.set(set)
			.where(sql`${photos.id} IN (${photoIdsWithPartnersSql(ids)})`)
			.returning({ id: photos.id, rating: photos.rating, flag: photos.flag })
			.all(),
	);
	updated.sort((left, right) => left.id - right.id);
	return { updated };
}
