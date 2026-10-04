import { randomUUID } from "node:crypto";
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	rm,
	statfs,
	utimes,
} from "node:fs/promises";
import path from "node:path";
import type * as NativeAddon from "@photobrain/image-processing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uploadAssets, uploads } from "../db/schema";
import type { ApiDatabase } from "./photo-catalog";

export const UPLOAD_RESOURCES = [
	"photo",
	"video",
	"pairedVideo",
	"alternatePhoto",
] as const;
export type UploadResource = (typeof UPLOAD_RESOURCES)[number];

/** Library folder holding uploaded originals: `Uploads/{device}/{YYYY}/{MM}/`. */
export const UPLOADS_FOLDER = "Uploads";
/** Hidden (so never scanned) temp folder under `Uploads/` for in-flight bodies. */
export const INCOMING_FOLDER = ".incoming";
/** Free space that must remain after an upload of the announced size. */
export const UPLOAD_FREE_SPACE_MARGIN_BYTES = 1024 ** 3;
/** Startup cleanup removes `.incoming` entries older than this. */
export const INCOMING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_DEVICE_NAME_LENGTH = 64;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_ASSET_ID_LENGTH = 256;
export const MAX_KNOWN_ASSET_IDS = 1000;
/** Byte bound of a sanitized path segment (device folder or file name). */
export const MAX_SEGMENT_BYTES = 120;
/** Extensions longer than this are treated as part of the stem when truncating. */
const MAX_EXTENSION_BYTES = 16;
/** Highest `stem (n).ext` collision suffix tried before failing. */
const MAX_COLLISION_SUFFIX = 10_000;
const DEFAULT_DEVICE_FOLDER = "Device";

/** The native extension rule; tests inject a fixture like other native seams. */
export type MediaSupport = {
	isSupportedMedia(path: string): boolean;
	getSupportedExtensions(): string[];
};

let nativeAddon: typeof NativeAddon | undefined;
function addon() {
	nativeAddon ??= require("@photobrain/image-processing") as typeof NativeAddon;
	return nativeAddon;
}

/** Loads the addon on first use so modules that never upload load no native code. */
export const nativeMediaSupport: MediaSupport = {
	isSupportedMedia: (file) => addon().isSupportedMedia(file),
	getSupportedExtensions: () => addon().getSupportedExtensions(),
};

/** Bytes available to unprivileged writers on the filesystem holding `directory`. */
export type FreeSpaceProbe = (directory: string) => Promise<number>;

export const statfsFreeBytes: FreeSpaceProbe = async (directory) => {
	const stats = await statfs(directory);
	return stats.bavail * stats.bsize;
};

export type UploadStore = {
	database: ApiDatabase;
	photoDirectory: string;
	media: MediaSupport;
	freeBytes: FreeSpaceProbe;
	/** Server clock for the `YYYY/MM` folder when `capturedAt` is absent. */
	now?: () => Date;
};

export type UploadInput = {
	deviceId: string;
	deviceName: string;
	filename: string;
	assetId?: string;
	resource?: UploadResource;
	/** ISO-8601 with offset; its own local date picks the folder. */
	capturedAt?: string;
	contentLength: number;
};

export type UploadOutcome = {
	status: "created" | "duplicate";
	/** Library-relative path of the stored (or already stored) file. */
	path: string;
	size: number;
};

export type UploadErrorCode =
	| "UNSUPPORTED_MEDIA"
	| "INSUFFICIENT_STORAGE"
	| "UPLOAD_INCOMPLETE";

export class UploadError extends Error {
	constructor(
		readonly code: UploadErrorCode,
		message: string,
	) {
		super(message);
		this.name = "UploadError";
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String(error.code)
		: undefined;
}

/**
 * A concurrent upload won a unique key first: `uploads.sha256`/`relative_path`
 * (UNIQUE) or the `upload_assets` asset key (PRIMARY KEY).
 */
function isKeyConflict(error: unknown): boolean {
	for (
		let current: unknown = error;
		current instanceof Error;
		current = current.cause
	) {
		const code = errorCode(current);
		if (
			code === "SQLITE_CONSTRAINT_UNIQUE" ||
			code === "SQLITE_CONSTRAINT_PRIMARYKEY"
		) {
			return true;
		}
	}
	return false;
}

/**
 * One safe path segment: NFC, control characters removed, `/` and `\` replaced
 * by `_`, trimmed, no leading dots, at most 120 UTF-8 bytes with the extension
 * kept. Returns an empty string when nothing usable remains.
 */
export function sanitizePathSegment(value: string): string {
	const cleaned = value
		.normalize("NFC")
		.replace(/\p{Cc}/gu, "")
		.replace(/[/\\]/g, "_")
		.trim()
		.replace(/^[.\s]+/, "");
	if (Buffer.byteLength(cleaned) <= MAX_SEGMENT_BYTES) return cleaned;
	const [stem, extension] = splitExtension(cleaned);
	const kept = Buffer.byteLength(extension) <= MAX_EXTENSION_BYTES;
	const suffix = kept ? extension : "";
	const head = truncateUtf8(
		kept ? stem : cleaned,
		MAX_SEGMENT_BYTES - Buffer.byteLength(suffix),
	).trimEnd();
	return `${head}${suffix}`;
}

/** Longest prefix of whole code points fitting in `maxBytes` UTF-8 bytes. */
function truncateUtf8(value: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character);
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += character.length;
	}
	return value.slice(0, end);
}

/** `IMG_1.HEIC` -> [`IMG_1`, `.HEIC`]; a name without a dot has no extension. */
function splitExtension(name: string): [string, string] {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** `YYYY/MM` of `capturedAt`'s own wall clock, else of the server's local clock. */
function monthFolder(capturedAt: string | undefined, now: Date): string {
	if (capturedAt) return `${capturedAt.slice(0, 4)}/${capturedAt.slice(5, 7)}`;
	const month = String(now.getMonth() + 1).padStart(2, "0");
	return `${String(now.getFullYear()).padStart(4, "0")}/${month}`;
}

type StoredUpload = { id: number; relativePath: string; size: number };

const storedColumns = {
	id: uploads.id,
	relativePath: uploads.relativePath,
	size: uploads.size,
};

function findAssetUpload(
	database: ApiDatabase,
	deviceId: string,
	assetId: string,
	resource: UploadResource,
): StoredUpload | undefined {
	return database
		.select(storedColumns)
		.from(uploadAssets)
		.innerJoin(uploads, eq(uploads.id, uploadAssets.uploadId))
		.where(
			and(
				eq(uploadAssets.deviceId, deviceId),
				eq(uploadAssets.assetId, assetId),
				eq(uploadAssets.resource, resource),
			),
		)
		.get();
}

/** Path of the first stored resource of an asset; it fixes the asset's stem. */
function firstAssetPath(
	database: ApiDatabase,
	deviceId: string,
	assetId: string,
): string | undefined {
	return database
		.select({ relativePath: uploads.relativePath })
		.from(uploadAssets)
		.innerJoin(uploads, eq(uploads.id, uploadAssets.uploadId))
		.where(
			and(
				eq(uploadAssets.deviceId, deviceId),
				eq(uploadAssets.assetId, assetId),
			),
		)
		.orderBy(sql`${uploadAssets}.rowid`)
		.limit(1)
		.get()?.relativePath;
}

/**
 * The upload already holding this request: its asset key, else identical bytes
 * (recording the asset key against that row so `knownUploads` reports it).
 */
function findExisting(
	database: ApiDatabase,
	input: { deviceId: string; assetId?: string; resource?: UploadResource },
	sha256: string,
): StoredUpload | undefined {
	const { deviceId, assetId, resource } = input;
	if (assetId && resource) {
		const keyed = findAssetUpload(database, deviceId, assetId, resource);
		if (keyed) return keyed;
	}
	const same = database
		.select(storedColumns)
		.from(uploads)
		.where(eq(uploads.sha256, sha256))
		.get();
	if (same && assetId && resource) {
		database
			.insert(uploadAssets)
			.values({
				deviceId,
				assetId,
				resource,
				uploadId: same.id,
				createdAt: new Date(),
			})
			.onConflictDoNothing()
			.run();
	}
	return same;
}

function discard(body: ReadableStream<Uint8Array> | null) {
	body?.cancel().catch(() => undefined);
}

function incomplete() {
	return new UploadError(
		"UPLOAD_INCOMPLETE",
		"The upload body did not match Content-Length",
	);
}

/**
 * Streams `body` into a new `tempPath`, hashing incrementally, so memory stays
 * constant whatever the size. Any byte count other than `expected` (short
 * body, client abort, or excess) is `UPLOAD_INCOMPLETE`.
 */
async function receiveToFile(
	body: ReadableStream<Uint8Array> | null,
	tempPath: string,
	expected: number,
): Promise<{ sha256: string; size: number }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let size = 0;
	const file = await open(tempPath, "wx", 0o644);
	try {
		if (body) {
			const reader = body.getReader();
			try {
				for (;;) {
					const result = await reader.read().catch(() => {
						throw incomplete();
					});
					if (result.done) break;
					const chunk = result.value;
					size += chunk.byteLength;
					if (size > expected) throw incomplete();
					hasher.update(chunk);
					for (let offset = 0; offset < chunk.byteLength; ) {
						const { bytesWritten } = await file.write(
							chunk,
							offset,
							chunk.byteLength - offset,
						);
						offset += bytesWritten;
					}
				}
			} catch (error) {
				reader.cancel().catch(() => undefined);
				throw error;
			}
		}
		if (size !== expected) throw incomplete();
		// The client treats 201/200 as "backed up"; make the bytes durable first.
		await file.datasync();
	} finally {
		await file.close();
	}
	return { sha256: hasher.digest("hex"), size };
}

/**
 * Stores one uploaded original under `{photoDirectory}/Uploads/...` for the
 * next incremental scan, or reports the upload already holding it.
 *
 * Order: unsupported extension (415) and a recorded asset key (duplicate) are
 * answered without reading the body; then free space (507); then the body is
 * streamed to `Uploads/.incoming/<uuid>` while hashing. Identical bytes become
 * a duplicate. Otherwise the temp is hard-linked into place under the first
 * free `stem.ext`, `stem (2).ext`, ... (`EEXIST` means taken, so nothing is
 * ever overwritten), and the `uploads`/`upload_assets` rows are inserted in
 * one transaction. A unique-constraint race against a concurrent identical
 * upload unlinks the placed file and reports the winner. The temp is removed
 * on every path.
 */
export async function storeUpload(
	store: UploadStore,
	request: UploadInput,
	body: ReadableStream<Uint8Array> | null,
): Promise<UploadOutcome> {
	const { database, photoDirectory } = store;
	const input = { ...request, deviceId: request.deviceId.toLowerCase() };
	const { deviceId, assetId, resource } = input;
	const filename = sanitizePathSegment(input.filename);
	const [filenameStem, extension] = splitExtension(filename);
	if (!filenameStem || !store.media.isSupportedMedia(filename)) {
		discard(body);
		throw new UploadError("UNSUPPORTED_MEDIA", "Unsupported file type");
	}
	if (assetId && resource) {
		const keyed = findAssetUpload(database, deviceId, assetId, resource);
		if (keyed) {
			discard(body);
			return {
				status: "duplicate",
				path: keyed.relativePath,
				size: keyed.size,
			};
		}
	}

	const incoming = path.join(photoDirectory, UPLOADS_FOLDER, INCOMING_FOLDER);
	await mkdir(incoming, { recursive: true });
	if (
		(await store.freeBytes(incoming)) <
		input.contentLength + UPLOAD_FREE_SPACE_MARGIN_BYTES
	) {
		discard(body);
		throw new UploadError(
			"INSUFFICIENT_STORAGE",
			"Not enough free space for this upload",
		);
	}

	const tempPath = path.join(incoming, randomUUID());
	try {
		const { sha256, size } = await receiveToFile(
			body,
			tempPath,
			input.contentLength,
		);
		const existing = findExisting(database, input, sha256);
		if (existing) {
			return {
				status: "duplicate",
				path: existing.relativePath,
				size: existing.size,
			};
		}

		const fixed = assetId
			? firstAssetPath(database, deviceId, assetId)
			: undefined;
		const directory = fixed
			? path.posix.dirname(fixed)
			: path.posix.join(
					UPLOADS_FOLDER,
					sanitizePathSegment(input.deviceName) || DEFAULT_DEVICE_FOLDER,
					monthFolder(input.capturedAt, store.now?.() ?? new Date()),
				);
		const stem = fixed
			? splitExtension(path.posix.basename(fixed))[0]
			: filenameStem;
		if (input.capturedAt) {
			const captured = new Date(input.capturedAt);
			await utimes(tempPath, captured, captured);
		}
		await mkdir(path.join(photoDirectory, directory), { recursive: true });

		for (let attempt = 1; attempt <= MAX_COLLISION_SUFFIX; attempt++) {
			const name =
				attempt === 1
					? `${stem}${extension}`
					: `${stem} (${attempt})${extension}`;
			const relativePath = path.posix.join(directory, name);
			const destination = path.join(photoDirectory, relativePath);
			try {
				await link(tempPath, destination);
			} catch (error) {
				if (errorCode(error) === "EEXIST") continue;
				throw error;
			}
			try {
				database.transaction((tx) => {
					const now = new Date();
					const upload = tx
						.insert(uploads)
						.values({ sha256, size, relativePath, deviceId, createdAt: now })
						.returning({ id: uploads.id })
						.get();
					if (assetId && resource) {
						tx.insert(uploadAssets)
							.values({
								deviceId,
								assetId,
								resource,
								uploadId: upload.id,
								createdAt: now,
							})
							.run();
					}
				});
				return { status: "created", path: relativePath, size };
			} catch (error) {
				await rm(destination, { force: true });
				if (!isKeyConflict(error)) throw error;
				const winner = findExisting(database, input, sha256);
				if (winner) {
					return {
						status: "duplicate",
						path: winner.relativePath,
						size: winner.size,
					};
				}
				// The path is recorded for a file deleted from disk; never reuse it.
			}
		}
		throw new Error(`No free upload filename for ${directory}/${filename}`);
	} catch (error) {
		if (errorCode(error) === "ENOSPC") {
			throw new UploadError(
				"INSUFFICIENT_STORAGE",
				"Not enough free space for this upload",
			);
		}
		throw error;
	} finally {
		await rm(tempPath, { force: true });
	}
}

export type KnownUploadAsset = {
	assetId: string;
	resources: UploadResource[];
};

/**
 * Recorded resources of `assetIds` for a device, in request order (duplicates
 * collapsed), omitting assets with none. Resources follow `UPLOAD_RESOURCES`.
 */
export function knownUploads(
	database: ApiDatabase,
	deviceId: string,
	assetIds: string[],
): KnownUploadAsset[] {
	const ids = [...new Set(assetIds)];
	const rows = database
		.select({ assetId: uploadAssets.assetId, resource: uploadAssets.resource })
		.from(uploadAssets)
		.where(
			and(
				eq(uploadAssets.deviceId, deviceId.toLowerCase()),
				inArray(uploadAssets.assetId, ids),
			),
		)
		.all();
	const byAsset = new Map<string, Set<UploadResource>>();
	for (const { assetId, resource } of rows) {
		const resources = byAsset.get(assetId) ?? new Set<UploadResource>();
		resources.add(resource);
		byAsset.set(assetId, resources);
	}
	return ids.flatMap((assetId) => {
		const resources = byAsset.get(assetId);
		return resources
			? [
					{
						assetId,
						resources: UPLOAD_RESOURCES.filter((kind) => resources.has(kind)),
					},
				]
			: [];
	});
}

/**
 * Deletes `Uploads/.incoming` entries last modified more than 24 hours ago:
 * bodies abandoned by a crash. Runs once at API start, before any upload.
 */
export async function cleanIncomingUploads(
	photoDirectory: string,
	now = Date.now(),
): Promise<number> {
	const incoming = path.join(photoDirectory, UPLOADS_FOLDER, INCOMING_FOLDER);
	let entries: string[];
	try {
		entries = await readdir(incoming);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return 0;
		throw error;
	}
	let removed = 0;
	for (const name of entries) {
		const entry = path.join(incoming, name);
		try {
			const stats = await lstat(entry);
			if (now - stats.mtimeMs <= INCOMING_MAX_AGE_MS) continue;
			await rm(entry, { recursive: true, force: true });
			removed++;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
	return removed;
}
