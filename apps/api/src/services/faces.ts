import path from "node:path";
import type * as NativeAddon from "@photobrain/image-processing";
import type {
	FaceBox,
	FaceDetectionResult,
} from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { type SQL, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema";
import { photoFaceScan, photoFaces } from "../db/schema";
import { type ApiDatabase, pairStackingCondition } from "./photo-catalog";
import { embeddingFromBlob } from "./photo-tagging";
import { FACE_MODEL_VERSION } from "./processing-versions";

/** The executor shared by the API database and its synchronous transactions. */
type Executor = BaseSQLiteDatabase<"sync", void, typeof schema>;

/** Photos read, detected, and written per `detect-faces-v1` step. */
export const FACE_BATCH_SIZE = 32;
/** Thumbnail size faces are detected in and cropped from. */
export const FACE_THUMBNAIL_SIZE = "large";
/** SFace embedding dimension; every stored face embedding is 128 float32 values. */
export const FACE_EMBEDDING_DIMENSION = 128;
/** Minimum cosine between an `auto` face and a person centroid to join that person (LFW leave-one-out: 0% open-set false assignment, 0.991 recall). */
export const FACE_ASSIGN_THRESHOLD = 0.5;
/** Cosine edge threshold of `clusterFaceEmbeddings` for new people. */
export const FACE_CLUSTER_THRESHOLD = 0.48;
/** Smallest group of unassigned faces that becomes a new unnamed person. */
export const FACE_MIN_CLUSTER_SIZE = 3;
/** A rescanned face inherits an old face's person and assignment at this IoU. */
export const FACE_CARRY_IOU = 0.5;
export const MAX_PERSON_NAME_LENGTH = 80;
export const MAX_MERGE_SOURCE_IDS = 50;
/** `GET /api/faces/:id/crop` sizes. */
export const FACE_CROP_SIZES = [128, 256] as const;
export const FACE_CROP_DEFAULT_SIZE = 256;

/** `auto` faces belong to automation; `manual` and `rejected` are user decisions. */
export const FACE_ASSIGNMENTS = ["auto", "manual", "rejected"] as const;
export type FaceAssignment = (typeof FACE_ASSIGNMENTS)[number];

export type Person = {
	id: number;
	name: string | null;
	hidden: boolean;
	/** Distinct photos the library lists for `personId` (RAW+JPEG pairs once). */
	photoCount: number;
	faceCount: number;
	/** The person's highest-score face (lowest id on ties). */
	coverFaceId: number | null;
};

export type PhotoFace = {
	id: number;
	box: FaceBox;
	personId: number | null;
	personName: string | null;
	assignment: FaceAssignment;
};

export type PersonPatch = {
	/** `null` clears the name; omitted keeps it. */
	name?: string | null;
	hidden?: boolean;
};

/** `personId` assigns (manual); `name` creates a named person; `personId: null` rejects. */
export type FaceAssignmentInput = {
	personId?: number | null;
	name?: string;
};

export type FaceErrorCode = "PERSON_NOT_FOUND" | "FACE_NOT_FOUND";

/** Domain failure that both transports map to their own status codes. */
export class FaceError extends Error {
	constructor(
		readonly code: FaceErrorCode,
		message: string,
	) {
		super(message);
		this.name = "FaceError";
	}
}

const personNotFound = () =>
	new FaceError("PERSON_NOT_FOUND", "Person not found");

/** Detects faces in index-aligned thumbnail paths; the native executor in production. */
export type DetectFaces = (paths: string[]) => Promise<FaceDetectionResult[]>;

/** Groups packed embeddings into index lists; the native addon in production. */
export type FaceClusterer = (
	embeddings: Float32Array,
	dimension: number,
	threshold: number,
	minClusterSize: number,
) => number[][];

let nativeAddon: typeof NativeAddon | undefined;
/**
 * Loads the addon on first use so transports and tests that never cluster do
 * not load native code. Clustering is a synchronous call on the API thread
 * inside the cluster step's transaction.
 */
export const nativeFaceClusterer: FaceClusterer = (
	embeddings,
	dimension,
	threshold,
	minClusterSize,
) => {
	nativeAddon ??= require("@photobrain/image-processing") as typeof NativeAddon;
	return nativeAddon.clusterFaceEmbeddings(
		embeddings,
		dimension,
		threshold,
		minClusterSize,
	);
};

/** Trims and bounds a person name; transports validate first, this keeps the service safe. */
export function normalizePersonName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_PERSON_NAME_LENGTH) {
		throw new RangeError(
			`Person name must be 1-${MAX_PERSON_NAME_LENGTH} characters`,
		);
	}
	return trimmed;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Detection batches

export type FaceScanRow = {
	photoId: number;
	thumbnailKey: string;
	thumbnailRoot: string | null;
};

/**
 * Photos needing a face scan after the keyset cursor: stills with a committed
 * thumbnail generation whose scan receipt is missing or from another
 * generation or FACE_MODEL_VERSION. Only stack representatives qualify (the
 * listing's stacking condition), so a RAW+JPEG pair is scanned once, through
 * its standard file.
 */
export function readFaceScanBatch(
	database: ApiDatabase,
	afterPhotoId: number,
	limit = FACE_BATCH_SIZE,
): FaceScanRow[] {
	return database.all<FaceScanRow>(sql`
		SELECT photos.id AS photoId, photos.thumbnail_key AS thumbnailKey,
			photos.thumbnail_root AS thumbnailRoot
		FROM photos
		LEFT JOIN photo_face_scan scan ON scan.photo_id = photos.id
		WHERE photos.id > ${afterPhotoId}
			AND photos.media_type = 'photo'
			AND photos.thumbnail_status = 'completed'
			AND photos.thumbnail_key IS NOT NULL
			AND (
				scan.photo_id IS NULL
				OR scan.thumbnail_key != photos.thumbnail_key
				OR scan.model_version != ${FACE_MODEL_VERSION}
			)
			AND ${pairStackingCondition([])}
		ORDER BY photos.id
		LIMIT ${limit}
	`);
}

/** Intersection over union of two normalized boxes. */
export function boxIou(left: FaceBox, right: FaceBox): number {
	const width =
		Math.min(left.x + left.width, right.x + right.width) -
		Math.max(left.x, right.x);
	const height =
		Math.min(left.y + left.height, right.y + right.height) -
		Math.max(left.y, right.y);
	if (width <= 0 || height <= 0) return 0;
	const intersection = width * height;
	const union =
		left.width * left.height + right.width * right.height - intersection;
	return union > 0 ? intersection / union : 0;
}

type OldFace = FaceBox & {
	personId: number | null;
	assignment: FaceAssignment;
};

/**
 * For each new box, the old face it inherits from: pairs with IoU at least
 * FACE_CARRY_IOU, matched greedily by descending IoU (then lowest indexes) so
 * every old face is inherited at most once.
 */
function carryOver(
	oldFaces: readonly OldFace[],
	boxes: readonly FaceBox[],
): (OldFace | undefined)[] {
	const pairs: { iou: number; oldIndex: number; newIndex: number }[] = [];
	for (const [oldIndex, old] of oldFaces.entries()) {
		for (const [newIndex, box] of boxes.entries()) {
			const iou = boxIou(old, box);
			if (iou >= FACE_CARRY_IOU) pairs.push({ iou, oldIndex, newIndex });
		}
	}
	pairs.sort(
		(left, right) =>
			right.iou - left.iou ||
			left.newIndex - right.newIndex ||
			left.oldIndex - right.oldIndex,
	);
	const inherited: (OldFace | undefined)[] = new Array(boxes.length);
	const used = new Set<number>();
	for (const { oldIndex, newIndex } of pairs) {
		if (used.has(oldIndex) || inherited[newIndex]) continue;
		used.add(oldIndex);
		inherited[newIndex] = oldFaces[oldIndex];
	}
	return inherited;
}

function invalidDetection(result: FaceDetectionResult): string | null {
	for (const face of result.faces) {
		if (face.embedding.length !== FACE_EMBEDDING_DIMENSION) {
			return `Face embedding has ${face.embedding.length} values, expected ${FACE_EMBEDDING_DIMENSION}`;
		}
	}
	return null;
}

/**
 * Writes one batch of detection results in one transaction. Each photo is
 * re-checked against its current committed generation, so a thumbnail
 * regenerated between detection and write is skipped (and picked up by the
 * next run). A success replaces the photo's faces (carrying person/assignment
 * over by IoU) and its receipt; a failure records a `failed` receipt and keeps
 * the existing faces.
 */
export function saveFaceScanBatch(
	database: ApiDatabase,
	rows: readonly { photoId: number; thumbnailKey: string }[],
	results: readonly FaceDetectionResult[],
): { scanned: number; failed: number; faces: number } {
	return database.transaction((tx) => {
		const counts = { scanned: 0, failed: 0, faces: 0 };
		const scannedAt = new Date();
		for (const [index, { photoId, thumbnailKey }] of rows.entries()) {
			const result = results[index];
			// Drizzle's raw `get` yields positional arrays on bun-sqlite; `all` yields objects.
			const [current] = tx.all<{ id: number }>(sql`
				SELECT id FROM photos
				WHERE id = ${photoId}
					AND media_type = 'photo'
					AND thumbnail_status = 'completed'
					AND thumbnail_key = ${thumbnailKey}
			`);
			if (!current) continue;
			const error = result.success
				? invalidDetection(result)
				: (result.error ?? "Face detection failed");
			const receipt = {
				thumbnailKey,
				modelVersion: FACE_MODEL_VERSION,
				faceCount: error === null ? result.faces.length : 0,
				status: error === null ? ("completed" as const) : ("failed" as const),
				error,
				scannedAt,
			};
			tx.insert(photoFaceScan)
				.values({ photoId, ...receipt })
				.onConflictDoUpdate({ target: photoFaceScan.photoId, set: receipt })
				.run();
			counts.scanned++;
			if (error !== null) {
				counts.failed++;
				continue;
			}
			const oldFaces = tx.all<OldFace>(sql`
				SELECT x, y, width, height, person_id AS personId, assignment
				FROM photo_faces WHERE photo_id = ${photoId}
				ORDER BY id
			`);
			tx.run(sql`DELETE FROM photo_faces WHERE photo_id = ${photoId}`);
			if (result.faces.length === 0) continue;
			const inherited = carryOver(
				oldFaces,
				result.faces.map((face) => face.box),
			);
			tx.insert(photoFaces)
				.values(
					result.faces.map((face, faceIndex) => ({
						photoId,
						thumbnailKey,
						modelVersion: FACE_MODEL_VERSION,
						x: face.box.x,
						y: face.box.y,
						width: face.box.width,
						height: face.box.height,
						score: face.score,
						embedding: Buffer.from(new Float32Array(face.embedding).buffer),
						personId: inherited[faceIndex]?.personId ?? null,
						assignment: inherited[faceIndex]?.assignment ?? "auto",
						createdAt: scannedAt,
					})),
				)
				.run();
			counts.faces += result.faces.length;
		}
		return counts;
	});
}

/**
 * One detection step: read up to `limit` eligible photos after the cursor,
 * detect faces in their committed `large` thumbnails, and persist the results
 * in one generation-fenced transaction.
 */
export async function detectFaceBatch(
	database: ApiDatabase,
	detect: DetectFaces,
	thumbnailsDirectory: string,
	afterPhotoId: number,
	limit = FACE_BATCH_SIZE,
): Promise<{
	read: number;
	scanned: number;
	failed: number;
	faces: number;
	cursor: number;
}> {
	const rows = readFaceScanBatch(database, afterPhotoId, limit);
	if (rows.length === 0) {
		return { read: 0, scanned: 0, failed: 0, faces: 0, cursor: afterPhotoId };
	}
	const results = await detect(
		rows.map((row) =>
			path.join(
				row.thumbnailRoot ?? thumbnailsDirectory,
				getThumbnailPath(row.thumbnailKey, FACE_THUMBNAIL_SIZE),
			),
		),
	);
	if (results.length !== rows.length) {
		throw new Error(
			`Face detection returned ${results.length} results for ${rows.length} paths`,
		);
	}
	return {
		read: rows.length,
		...saveFaceScanBatch(database, rows, results),
		cursor: rows[rows.length - 1].photoId,
	};
}

// ---------------------------------------------------------------------------
// Cluster step

export type ClusterFacesResult = {
	/** Unassigned `auto` faces joined to an existing person's centroid. */
	assigned: number;
	/** Faces placed in new unnamed people. */
	clustered: number;
	/** New unnamed people. */
	created: number;
	/** Unnamed people deleted for having no faces. */
	deleted: number;
};

/** Copies a stored embedding into `target` at `offset`; false when malformed. */
function readEmbedding(
	blob: Uint8Array,
	target: Float32Array | Float64Array,
	offset: number,
): boolean {
	if (blob.byteLength !== FACE_EMBEDDING_DIMENSION * 4) return false;
	target.set(embeddingFromBlob(blob), offset);
	return true;
}

/**
 * The cluster step, in one transaction:
 * 1. Every `auto` face without a person joins the person whose centroid (the
 *    normalized mean of its `manual` and `auto` embeddings) is most similar,
 *    when that cosine is at least FACE_ASSIGN_THRESHOLD (compared at float32
 *    precision, the precision of the stored embeddings).
 * 2. The remaining unassigned `auto` faces are grouped by `cluster` with
 *    FACE_CLUSTER_THRESHOLD and FACE_MIN_CLUSTER_SIZE; each group becomes a
 *    new unnamed person.
 * 3. Unnamed people without faces are deleted.
 * `manual` and `rejected` faces are never changed. Embeddings are read once:
 * assigned faces stream into per-person sums, and unassigned faces load into
 * one packed array (faces x 512 bytes) that is compacted in place for
 * clustering.
 */
export function clusterFaces(
	database: ApiDatabase,
	cluster: FaceClusterer,
): ClusterFacesResult {
	const client = database.$client;
	const dimension = FACE_EMBEDDING_DIMENSION;
	return database.transaction(() => {
		const result: ClusterFacesResult = {
			assigned: 0,
			clustered: 0,
			created: 0,
			deleted: 0,
		};

		// Centroids: per-person sums of manual + auto embeddings, then normalized.
		const sums = new Map<number, Float64Array>();
		const vector = new Float64Array(dimension);
		const assignedRows = client
			.query<{ person_id: number; embedding: Uint8Array }, []>(
				`SELECT person_id, embedding FROM photo_faces
				WHERE person_id IS NOT NULL AND assignment IN ('auto', 'manual')`,
			)
			.iterate();
		for (const row of assignedRows) {
			if (!readEmbedding(row.embedding, vector, 0)) continue;
			let sum = sums.get(row.person_id);
			if (!sum) {
				sum = new Float64Array(dimension);
				sums.set(row.person_id, sum);
			}
			for (let index = 0; index < dimension; index++)
				sum[index] += vector[index];
		}
		const centroidIds: number[] = [];
		const centroids = new Float64Array(sums.size * dimension);
		for (const [personId, sum] of sums) {
			let norm = 0;
			for (let index = 0; index < dimension; index++) norm += sum[index] ** 2;
			if (norm === 0) continue;
			const scale = 1 / Math.sqrt(norm);
			const offset = centroidIds.length * dimension;
			for (let index = 0; index < dimension; index++) {
				centroids[offset + index] = sum[index] * scale;
			}
			centroidIds.push(personId);
		}

		// Unassigned auto faces, packed once.
		const { count } = client
			.query<{ count: number }, []>(
				`SELECT count(*) AS count FROM photo_faces
				WHERE assignment = 'auto' AND person_id IS NULL`,
			)
			.get() ?? { count: 0 };
		const faceIds: number[] = [];
		const packed = new Float32Array(count * dimension);
		const unassignedRows = client
			.query<{ id: number; embedding: Uint8Array }, []>(
				`SELECT id, embedding FROM photo_faces
				WHERE assignment = 'auto' AND person_id IS NULL
				ORDER BY id`,
			)
			.iterate();
		for (const row of unassignedRows) {
			if (faceIds.length === count) break;
			if (!readEmbedding(row.embedding, packed, faceIds.length * dimension))
				continue;
			faceIds.push(row.id);
		}

		const setPerson = client.query<unknown, [number, number]>(
			`UPDATE photo_faces SET person_id = ?
			WHERE id = ? AND assignment = 'auto' AND person_id IS NULL`,
		);

		// 1. Centroid assignment; unmatched faces are compacted to the front.
		const threshold = Math.fround(FACE_ASSIGN_THRESHOLD);
		const people = centroidIds.length;
		let remaining = 0;
		for (let face = 0; face < faceIds.length; face++) {
			const faceOffset = face * dimension;
			let best = -1;
			let bestSimilarity = Number.NEGATIVE_INFINITY;
			for (let person = 0; person < people; person++) {
				const centroidOffset = person * dimension;
				let similarity = 0;
				for (let index = 0; index < dimension; index++) {
					similarity +=
						packed[faceOffset + index] * centroids[centroidOffset + index];
				}
				if (similarity > bestSimilarity) {
					bestSimilarity = similarity;
					best = person;
				}
			}
			if (best >= 0 && bestSimilarity >= threshold) {
				setPerson.run(centroidIds[best], faceIds[face]);
				result.assigned++;
				continue;
			}
			if (remaining !== face) {
				packed.copyWithin(
					remaining * dimension,
					faceOffset,
					faceOffset + dimension,
				);
				faceIds[remaining] = faceIds[face];
			}
			remaining++;
		}

		// 2. New unnamed people from groups of the remaining faces.
		if (remaining > 0) {
			const groups = cluster(
				packed.subarray(0, remaining * dimension),
				dimension,
				FACE_CLUSTER_THRESHOLD,
				FACE_MIN_CLUSTER_SIZE,
			);
			const createPerson = client.query<{ id: number }, [number, number]>(
				`INSERT INTO people (name, hidden, created_at, updated_at)
				VALUES (NULL, 0, ?, ?) RETURNING id`,
			);
			const now = nowSeconds();
			for (const group of groups) {
				const members = group.filter(
					(member) =>
						Number.isInteger(member) && member >= 0 && member < remaining,
				);
				if (members.length === 0) continue;
				const person = createPerson.get(now, now);
				if (!person) throw new Error("Person insert returned no row");
				result.created++;
				for (const member of members) {
					setPerson.run(person.id, faceIds[member]);
					result.clustered++;
				}
			}
		}

		// 3. Unnamed people left without faces.
		result.deleted = client
			.query(
				`DELETE FROM people WHERE name IS NULL
				AND NOT EXISTS (SELECT 1 FROM photo_faces WHERE photo_faces.person_id = people.id)`,
			)
			.run().changes;
		return result;
	});
}

// ---------------------------------------------------------------------------
// People

type PersonRow = {
	id: number;
	name: string | null;
	hidden: number;
	photoCount: number;
	faceCount: number;
	coverFaceId: number | null;
};

/**
 * People rows matching `where`, with counts and cover in correlated subqueries
 * over `idx_photo_faces_person_photo`. `photoCount` applies exactly the
 * listing's `personId` filter and stacking, so it equals that listing's total.
 */
function peopleSql(where: SQL, listedOnly: boolean): SQL {
	// The listing's `personId` condition, correlated to the outer person.
	const personScope = sql`photos.id IN (SELECT photo_id FROM photo_faces WHERE photo_faces.person_id = people.id)`;
	const listed = listedOnly
		? sql` AND (person.faceCount > 0 OR person.name IS NOT NULL)`
		: sql``;
	return sql`
		SELECT * FROM (
			SELECT people.id AS id, people.name AS name, people.hidden AS hidden,
				(SELECT count(*) FROM photo_faces WHERE photo_faces.person_id = people.id) AS faceCount,
				(SELECT count(*) FROM photos
					WHERE ${personScope} AND ${pairStackingCondition([personScope])}) AS photoCount,
				(SELECT photo_faces.id FROM photo_faces WHERE photo_faces.person_id = people.id
					ORDER BY photo_faces.score DESC, photo_faces.id LIMIT 1) AS coverFaceId
			FROM people
			WHERE ${where}
		) person
		WHERE 1 = 1${listed}
		ORDER BY person.name IS NULL, person.photoCount DESC, person.id
	`;
}

const toPerson = (row: PersonRow): Person => ({
	id: row.id,
	name: row.name,
	hidden: row.hidden === 1,
	photoCount: row.photoCount,
	faceCount: row.faceCount,
	coverFaceId: row.coverFaceId,
});

/**
 * People with faces (or a name), named first, then by photo count descending,
 * then id. Hidden people are omitted unless `includeHidden`.
 */
export function listPeople(
	database: ApiDatabase,
	options: { includeHidden?: boolean } = {},
): { people: Person[] } {
	const where = options.includeHidden ? sql`1 = 1` : sql`people.hidden = 0`;
	return {
		people: database.all<PersonRow>(peopleSql(where, true)).map(toPerson),
	};
}

/** One person by id (hidden or not), or `null`. */
export function getPerson(database: Executor, id: number): Person | null {
	const [row] = database.all<PersonRow>(
		peopleSql(sql`people.id = ${id}`, false),
	);
	return row ? toPerson(row) : null;
}

function requirePerson(database: Executor, id: number): Person {
	const person = getPerson(database, id);
	if (!person) throw personNotFound();
	return person;
}

/** Renames (`null` clears) and/or hides a person in one transaction. */
export function updatePerson(
	database: ApiDatabase,
	id: number,
	patch: PersonPatch,
): Person {
	const name =
		patch.name === undefined || patch.name === null
			? patch.name
			: normalizePersonName(patch.name);
	return database.transaction((tx) => {
		const [exists] = tx.all<{ id: number }>(
			sql`SELECT id FROM people WHERE id = ${id}`,
		);
		if (!exists) throw personNotFound();
		if (name !== undefined || patch.hidden !== undefined) {
			tx.run(sql`
				UPDATE people SET
					name = ${name === undefined ? sql`name` : name},
					hidden = ${patch.hidden === undefined ? sql`hidden` : patch.hidden ? 1 : 0},
					updated_at = ${nowSeconds()}
				WHERE id = ${id}
			`);
		}
		return requirePerson(tx, id);
	});
}

/**
 * Moves every face of `sourceIds` to `targetId` as `manual` and deletes the
 * sources, in one transaction. An unnamed target takes the first named
 * source's name (in `sourceIds` order). `sourceIds` must hold 1-50 distinct
 * ids without the target (`RangeError`); any unknown id is PERSON_NOT_FOUND.
 */
export function mergePeople(
	database: ApiDatabase,
	targetId: number,
	sourceIds: readonly number[],
): Person {
	if (
		sourceIds.length < 1 ||
		sourceIds.length > MAX_MERGE_SOURCE_IDS ||
		new Set(sourceIds).size !== sourceIds.length ||
		sourceIds.includes(targetId)
	) {
		throw new RangeError(
			`Merge needs 1-${MAX_MERGE_SOURCE_IDS} distinct source ids other than the target`,
		);
	}
	const sources = JSON.stringify(sourceIds);
	return database.transaction((tx) => {
		const rows = tx.all<{ id: number; name: string | null }>(sql`
			SELECT id, name FROM people
			WHERE id = ${targetId} OR id IN (SELECT value FROM json_each(${sources}))
		`);
		if (rows.length !== sourceIds.length + 1) throw personNotFound();
		const names = new Map(rows.map((row) => [row.id, row.name]));
		const inherited =
			names.get(targetId) ??
			sourceIds.map((id) => names.get(id)).find((name) => name != null) ??
			null;
		tx.run(sql`
			UPDATE photo_faces SET person_id = ${targetId}, assignment = 'manual'
			WHERE person_id IN (SELECT value FROM json_each(${sources}))
		`);
		tx.run(
			sql`DELETE FROM people WHERE id IN (SELECT value FROM json_each(${sources}))`,
		);
		tx.run(sql`
			UPDATE people SET name = ${inherited}, updated_at = ${nowSeconds()}
			WHERE id = ${targetId}
		`);
		return requirePerson(tx, targetId);
	});
}

// ---------------------------------------------------------------------------
// Faces

type PhotoFaceRow = {
	id: number;
	x: number;
	y: number;
	width: number;
	height: number;
	personId: number | null;
	personName: string | null;
	assignment: FaceAssignment;
};

function photoFacesSql(where: SQL): SQL {
	return sql`
		SELECT photo_faces.id AS id, photo_faces.x AS x, photo_faces.y AS y,
			photo_faces.width AS width, photo_faces.height AS height,
			photo_faces.person_id AS personId, people.name AS personName,
			photo_faces.assignment AS assignment
		FROM photo_faces
		LEFT JOIN people ON people.id = photo_faces.person_id
		WHERE ${where}
		ORDER BY photo_faces.x, photo_faces.id
	`;
}

const toPhotoFace = (row: PhotoFaceRow): PhotoFace => ({
	id: row.id,
	box: { x: row.x, y: row.y, width: row.width, height: row.height },
	personId: row.personId,
	personName: row.personName,
	assignment: row.assignment,
});

/** A photo's faces left to right (by box x, then id), or `null` for an unknown photo. */
export function getPhotoFaces(
	database: ApiDatabase,
	photoId: number,
): { faces: PhotoFace[] } | null {
	const [photo] = database.all<{ id: number }>(
		sql`SELECT id FROM photos WHERE id = ${photoId}`,
	);
	if (!photo) return null;
	return {
		faces: database
			.all<PhotoFaceRow>(photoFacesSql(sql`photo_faces.photo_id = ${photoId}`))
			.map(toPhotoFace),
	};
}

/**
 * Corrects one face in one transaction: `personId` assigns it to that person,
 * `name` (without `personId`) creates a named person for it, both as
 * `manual`; `personId: null` rejects it (no person). Exactly one of
 * `personId`/`name` must be given (`RangeError`).
 */
export function assignFace(
	database: ApiDatabase,
	faceId: number,
	input: FaceAssignmentInput,
): PhotoFace {
	if ((input.personId !== undefined) === (input.name !== undefined)) {
		throw new RangeError("Provide exactly one of personId or name");
	}
	const name =
		input.name === undefined ? undefined : normalizePersonName(input.name);
	return database.transaction((tx) => {
		const [face] = tx.all<{ id: number }>(
			sql`SELECT id FROM photo_faces WHERE id = ${faceId}`,
		);
		if (!face) throw new FaceError("FACE_NOT_FOUND", "Face not found");
		let personId: number | null;
		if (name !== undefined) {
			const now = nowSeconds();
			const [created] = tx.all<{ id: number }>(sql`
				INSERT INTO people (name, hidden, created_at, updated_at)
				VALUES (${name}, 0, ${now}, ${now}) RETURNING id
			`);
			personId = created.id;
		} else {
			personId = input.personId ?? null;
			if (personId !== null) {
				const [person] = tx.all<{ id: number }>(
					sql`SELECT id FROM people WHERE id = ${personId}`,
				);
				if (!person) throw personNotFound();
			}
		}
		tx.run(sql`
			UPDATE photo_faces SET person_id = ${personId},
				assignment = ${personId === null ? "rejected" : "manual"}
			WHERE id = ${faceId}
		`);
		const [row] = tx.all<PhotoFaceRow>(
			photoFacesSql(sql`photo_faces.id = ${faceId}`),
		);
		return toPhotoFace(row);
	});
}

export type FaceCropSource = {
	path: string;
	box: FaceBox;
	thumbnailKey: string;
};

/** The committed `large` thumbnail of the face's own generation and its box, or `null`. */
export function getFaceCropSource(
	database: ApiDatabase,
	faceId: number,
	thumbnailsDirectory: string,
): FaceCropSource | null {
	const [row] = database.all<
		FaceBox & { thumbnailKey: string; thumbnailRoot: string | null }
	>(sql`
		SELECT photo_faces.x AS x, photo_faces.y AS y, photo_faces.width AS width,
			photo_faces.height AS height, photo_faces.thumbnail_key AS thumbnailKey,
			photos.thumbnail_root AS thumbnailRoot
		FROM photo_faces
		INNER JOIN photos ON photos.id = photo_faces.photo_id
		WHERE photo_faces.id = ${faceId}
	`);
	if (!row) return null;
	return {
		path: path.join(
			row.thumbnailRoot ?? thumbnailsDirectory,
			getThumbnailPath(row.thumbnailKey, FACE_THUMBNAIL_SIZE),
		),
		box: { x: row.x, y: row.y, width: row.width, height: row.height },
		thumbnailKey: row.thumbnailKey,
	};
}
