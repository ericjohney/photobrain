import type * as NativeAddon from "@photobrain/image-processing";
import type { NearDuplicateGroup } from "@photobrain/image-processing";
import { sql } from "drizzle-orm";
import {
	duplicateDismissals,
	type PublicPhotoWithExif,
	photos as photosTable,
	publicPhotoColumns,
} from "../db/schema";
import {
	type ApiDatabase,
	pairedPhotoExtras,
	pairedPhotoIdSql,
	photoIdsWithPartnersSql,
} from "./photo-catalog";
import { QUALITY_VERSION } from "./processing-versions";

export const DUPLICATE_KINDS = ["duplicate", "burst"] as const;
export type DuplicateKind = (typeof DUPLICATE_KINDS)[number];
export const DUPLICATE_ACTIONS = ["keep", "dismiss"] as const;
export type DuplicateAction = (typeof DUPLICATE_ACTIONS)[number];

/**
 * Hamming bits (of the 40-bit DoubleGradient 8x8 pHash) within which two photos
 * are near-duplicates. Calibrated on real photos; see "Duplicates and Bursts"
 * in apps/api/AGENTS.md before changing it.
 */
export const DUPLICATE_MAX_DISTANCE = 1;
/** Largest gap between consecutive same-camera `date_taken` values in a burst. */
export const BURST_MAX_GAP_SECONDS = 2;
export const BURST_MIN_SIZE = 3;
export const DUPLICATE_GROUPS_DEFAULT_LIMIT = 50;
export const DUPLICATE_GROUPS_MAX_LIMIT = 200;
/** Opaque cursors are decimal group offsets into the ordered, filtered list. */
export const DUPLICATE_CURSOR_PATTERN = /^\d{1,9}$/;
/** Transport bound on group keys (about 100,000 member IDs). */
export const MAX_DUPLICATE_KEY_LENGTH = 1_000_000;

/** Groups index-aligned base64 pHashes; the native addon in production. */
export type HashGrouper = (
	ids: number[],
	hashes: string[],
	maxDistance: number,
) => NearDuplicateGroup[];

let nativeAddon: typeof NativeAddon | undefined;
/**
 * Loads the addon on first use so transports and tests that never group do
 * not load native code. Multi-index grouping of 50,000 hashes takes a few
 * milliseconds, so it runs synchronously on the API thread.
 */
export const nativeHashGrouper: HashGrouper = (ids, hashes, maxDistance) => {
	nativeAddon ??= require("@photobrain/image-processing") as typeof NativeAddon;
	return nativeAddon.groupNearDuplicates(ids, hashes, maxDistance);
};

export type DuplicateGroupErrorCode = "GROUP_CHANGED" | "INVALID_KEEP_IDS";

export class DuplicateGroupError extends Error {
	constructor(
		readonly code: DuplicateGroupErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DuplicateGroupError";
	}
}

/** Stable while membership is unchanged; `ids` must be ascending. */
export function duplicateGroupKey(kind: DuplicateKind, ids: readonly number[]) {
	return `${kind}:${ids.join(",")}`;
}

type CandidateRow = {
	id: number;
	hash: string;
	rating: number;
	flag: "pick" | null;
	isRaw: number | null;
	width: number | null;
	height: number | null;
	size: number;
	sharpness: number | null;
	cameraMake: string | null;
	cameraModel: string | null;
	dateTaken: string | null;
};

type ComputedGroup = {
	key: string;
	kind: DuplicateKind;
	/** Ascending. */
	ids: number[];
	maxDistance: number | null;
};

/**
 * Every grouping input (a still with a pHash row and a flag other than
 * `reject`) with the keeper and burst attributes, in one statement. Videos are
 * never inputs: similar poster frames do not make two clips duplicates.
 * Sharpness counts only for a current-version measurement of the committed
 * thumbnail generation. A RAW whose pair partner is itself a candidate is not a
 * candidate: the pair is one photo, represented by its standard file.
 */
function loadCandidates(database: Pick<ApiDatabase, "all">): CandidateRow[] {
	return database.all<CandidateRow>(sql`
		SELECT
			photos.id AS id,
			photo_phash.hash AS hash,
			photos.rating AS rating,
			photos.flag AS flag,
			photos.is_raw AS isRaw,
			photos.width AS width,
			photos.height AS height,
			photos.size AS size,
			photo_quality.sharpness AS sharpness,
			photo_exif.camera_make AS cameraMake,
			photo_exif.camera_model AS cameraModel,
			photo_exif.date_taken AS dateTaken
		FROM photo_phash
		JOIN photos ON photos.id = photo_phash.photo_id
		LEFT JOIN photo_exif ON photo_exif.photo_id = photos.id
		LEFT JOIN photo_quality ON photo_quality.photo_id = photos.id
			AND photo_quality.thumbnail_key = photos.thumbnail_key
			AND photo_quality.quality_version = ${QUALITY_VERSION}
		WHERE photos.flag IS NOT 'reject'
			AND photos.media_type = 'photo'
			AND NOT (
				ifnull(photos.is_raw, 0) = 1
				AND ifnull(${pairedPhotoIdSql()} IN (
					SELECT photo_phash.photo_id FROM photo_phash
					JOIN photos ON photos.id = photo_phash.photo_id
					WHERE photos.flag IS NOT 'reject'
				), 0)
			)
	`);
}

const EXIF_DATE_PATTERN =
	/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;

/**
 * Seconds since the epoch for an EXIF `YYYY:MM:DD HH:MM:SS` (or ISO-like)
 * value read as UTC, or `null` for missing, malformed, or out-of-range values
 * such as the `0000:00:00 00:00:00` placeholder. Only differences matter.
 */
function parseExifSeconds(value: string | null): number | null {
	const match = value === null ? null : EXIF_DATE_PATTERN.exec(value);
	if (!match) return null;
	const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
	const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
	const roundTrips =
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day &&
		date.getUTCHours() === hour &&
		date.getUTCMinutes() === minute &&
		date.getUTCSeconds() === second;
	return roundTrips ? date.getTime() / 1000 : null;
}

/**
 * Maximal runs of at least `BURST_MIN_SIZE` same-camera photos whose
 * consecutive capture times are at most `BURST_MAX_GAP_SECONDS` apart. Photos
 * with neither camera make nor model, or an unparsable date, are ignored.
 */
function burstGroups(candidates: readonly CandidateRow[]): ComputedGroup[] {
	const byCamera = new Map<string, { id: number; seconds: number }[]>();
	for (const candidate of candidates) {
		if (candidate.cameraMake === null && candidate.cameraModel === null) {
			continue;
		}
		const seconds = parseExifSeconds(candidate.dateTaken);
		if (seconds === null) continue;
		const camera = `${candidate.cameraMake ?? ""}\u0000${candidate.cameraModel ?? ""}`;
		let shots = byCamera.get(camera);
		if (!shots) {
			shots = [];
			byCamera.set(camera, shots);
		}
		shots.push({ id: candidate.id, seconds });
	}
	const groups: ComputedGroup[] = [];
	for (const shots of byCamera.values()) {
		shots.sort(
			(left, right) => left.seconds - right.seconds || left.id - right.id,
		);
		let start = 0;
		for (let index = 1; index <= shots.length; index++) {
			if (
				index < shots.length &&
				shots[index].seconds - shots[index - 1].seconds <= BURST_MAX_GAP_SECONDS
			) {
				continue;
			}
			if (index - start >= BURST_MIN_SIZE) {
				const ids = shots
					.slice(start, index)
					.map((shot) => shot.id)
					.sort((left, right) => left - right);
				groups.push({
					key: duplicateGroupKey("burst", ids),
					kind: "burst",
					ids,
					maxDistance: null,
				});
			}
			start = index;
		}
	}
	return groups;
}

function computeGroups(
	candidates: readonly CandidateRow[],
	groupHashes: HashGrouper,
	kind?: DuplicateKind,
): ComputedGroup[] {
	const groups: ComputedGroup[] = [];
	if (kind !== "burst") {
		const native = groupHashes(
			candidates.map((candidate) => candidate.id),
			candidates.map((candidate) => candidate.hash),
			DUPLICATE_MAX_DISTANCE,
		);
		for (const group of native) {
			const ids = [...group.ids].sort((left, right) => left - right);
			groups.push({
				key: duplicateGroupKey("duplicate", ids),
				kind: "duplicate",
				ids,
				maxDistance: group.maxDistance,
			});
		}
	}
	if (kind !== "duplicate") groups.push(...burstGroups(candidates));
	return groups;
}

/**
 * Suggested-keeper order: rating, pick, RAW, pixel count, sharpness (missing
 * last), file size, then lowest ID.
 */
function compareKeepers(left: CandidateRow, right: CandidateRow): number {
	return (
		right.rating - left.rating ||
		Number(right.flag === "pick") - Number(left.flag === "pick") ||
		Number(Boolean(right.isRaw)) - Number(Boolean(left.isRaw)) ||
		(right.width ?? 0) * (right.height ?? 0) -
			(left.width ?? 0) * (left.height ?? 0) ||
		// Two missing values give NaN, which is falsy and falls through.
		(right.sharpness ?? Number.NEGATIVE_INFINITY) -
			(left.sharpness ?? Number.NEGATIVE_INFINITY) ||
		right.size - left.size ||
		left.id - right.id
	);
}

export type DuplicateGroup = {
	key: string;
	kind: DuplicateKind;
	/** Suggested keeper first, then ascending ID. */
	photos: PublicPhotoWithExif[];
	suggestedKeeperId: number;
	/** Largest pairwise pHash distance; `null` for bursts. */
	maxDistance: number | null;
};

export type DuplicateGroupsInput = {
	kind?: DuplicateKind;
	limit?: number;
	cursor?: string;
};

export type DuplicateGroupsResult = {
	groups: DuplicateGroup[];
	counts: Record<DuplicateKind, number>;
	nextCursor: string | null;
};

/**
 * Lists undismissed duplicate and burst groups: larger groups first, then the
 * newest (highest member ID). Three statements: candidates, dismissed keys
 * among the computed groups, and the page's public photos with EXIF.
 */
export async function duplicateGroups(
	database: ApiDatabase,
	input: DuplicateGroupsInput = {},
	groupHashes: HashGrouper = nativeHashGrouper,
): Promise<DuplicateGroupsResult> {
	const limit = input.limit ?? DUPLICATE_GROUPS_DEFAULT_LIMIT;
	if (
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > DUPLICATE_GROUPS_MAX_LIMIT
	) {
		throw new RangeError(
			`Limit must be an integer from 1 to ${DUPLICATE_GROUPS_MAX_LIMIT}`,
		);
	}
	if (
		input.cursor !== undefined &&
		!DUPLICATE_CURSOR_PATTERN.test(input.cursor)
	) {
		throw new RangeError("Invalid duplicate group cursor");
	}
	if (input.kind !== undefined && !DUPLICATE_KINDS.includes(input.kind)) {
		throw new RangeError(`Unknown duplicate group kind ${input.kind}`);
	}

	const candidates = loadCandidates(database);
	const computed = computeGroups(candidates, groupHashes);
	const dismissed = new Set(
		database
			.all<{ key: string }>(sql`
				SELECT group_key AS key FROM duplicate_dismissals
				WHERE group_key IN (SELECT value FROM json_each(${JSON.stringify(
					computed.map((group) => group.key),
				)}))
			`)
			.map((row) => row.key),
	);
	const visible = computed.filter((group) => !dismissed.has(group.key));
	const counts = { duplicate: 0, burst: 0 };
	for (const group of visible) counts[group.kind]++;

	const ordered = visible
		.filter((group) => input.kind === undefined || group.kind === input.kind)
		.sort(
			(left, right) =>
				right.ids.length - left.ids.length ||
				(right.ids.at(-1) ?? 0) - (left.ids.at(-1) ?? 0) ||
				// A photo set can form both kinds; list its duplicate group first.
				DUPLICATE_KINDS.indexOf(left.kind) -
					DUPLICATE_KINDS.indexOf(right.kind),
		);
	const offset = Number(input.cursor ?? 0);
	const page = ordered.slice(offset, offset + limit);

	const candidateById = new Map(
		candidates.map((candidate) => [candidate.id, candidate]),
	);
	const members = page.map((group) => {
		const keeper = group.ids
			.map((id) => candidateById.get(id) as CandidateRow)
			.sort(compareKeepers)[0].id;
		return {
			group,
			keeper,
			ids: [keeper, ...group.ids.filter((id) => id !== keeper)],
		};
	});
	const pageIds = [...new Set(members.flatMap((member) => member.ids))];
	const rows = pageIds.length
		? await database.query.photos.findMany({
				columns: publicPhotoColumns,
				extras: pairedPhotoExtras,
				with: { exif: true },
				where: sql`photos.id IN (SELECT value FROM json_each(${JSON.stringify(pageIds)}))`,
			})
		: [];
	const photoById = new Map(rows.map((photo) => [photo.id, photo]));

	return {
		groups: members.map(({ group, keeper, ids }) => ({
			key: group.key,
			kind: group.kind,
			photos: ids.flatMap((id) => photoById.get(id) ?? []),
			suggestedKeeperId: keeper,
			maxDistance: group.maxDistance,
		})),
		counts,
		nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
	};
}

export type ResolveDuplicateGroupInput = {
	key: string;
	action: DuplicateAction;
	keepIds?: readonly number[];
};

export type ResolveDuplicateGroupResult =
	| { rejected: number[] }
	| { dismissed: string };

/**
 * Recomputes the key's kind inside one transaction and requires a current
 * group with exactly that membership (`GROUP_CHANGED` otherwise). `keep`
 * rejects every member not in `keepIds` (1+ members, else `INVALID_KEEP_IDS`)
 * and their RAW+JPEG pair partners in one UPDATE, and dismisses the group the
 * kept members form, so a decision to keep several photos is not asked again
 * until membership changes; `dismiss` records the key. Files are never touched.
 */
export function resolveDuplicateGroup(
	database: ApiDatabase,
	input: ResolveDuplicateGroupInput,
	groupHashes: HashGrouper = nativeHashGrouper,
): ResolveDuplicateGroupResult {
	const kind = DUPLICATE_KINDS.find((candidate) =>
		input.key.startsWith(`${candidate}:`),
	);
	const changed = () =>
		new DuplicateGroupError(
			"GROUP_CHANGED",
			"The group changed since it was listed",
		);
	if (!kind) throw changed();
	if (input.action === "keep" && !input.keepIds?.length) {
		throw new DuplicateGroupError(
			"INVALID_KEEP_IDS",
			"Keep requires at least one member ID",
		);
	}

	return database.transaction((tx) => {
		const group = computeGroups(loadCandidates(tx), groupHashes, kind).find(
			(candidate) => candidate.key === input.key,
		);
		if (!group) throw changed();

		const dismiss = (key: string) =>
			tx
				.insert(duplicateDismissals)
				.values({ groupKey: key, dismissedAt: new Date() })
				.onConflictDoNothing()
				.run();
		if (input.action === "dismiss") {
			dismiss(group.key);
			return { dismissed: group.key };
		}
		if (input.action !== "keep") {
			throw new RangeError(`Unknown duplicate action ${String(input.action)}`);
		}
		const keep = new Set(input.keepIds);
		if ([...keep].some((id) => !group.ids.includes(id))) {
			throw new DuplicateGroupError(
				"INVALID_KEEP_IDS",
				"Keep IDs must be members of the group",
			);
		}
		if (keep.size > 1) {
			dismiss(
				`${kind}:${[...keep].sort((left, right) => left - right).join(",")}`,
			);
		}
		const others = group.ids.filter((id) => !keep.has(id));
		if (others.length === 0) return { rejected: [] };
		const rejected = tx
			.update(photosTable)
			.set({ flag: "reject" })
			.where(sql`${photosTable.id} IN (${photoIdsWithPartnersSql(others)})`)
			.returning({ id: photosTable.id })
			.all()
			.map((photo) => photo.id)
			.sort((left, right) => left - right);
		return { rejected };
	});
}
