import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAllThumbnailSizes, getThumbnailPath } from "@photobrain/utils";
import { eq } from "drizzle-orm";
import type { db } from "../db";
import { photoPhash, photos } from "../db/schema";
import { nativeExecutor } from "./native-executor";
import { MEDIA_VERSION } from "./processing-versions";

export type PlannedPhoto = {
	filePath: string;
	relativePath: string;
	photoId: number | null;
	previousThumbnailKey: string | null;
	previousSourceFingerprint: string | null;
	sourceFingerprint: string | null;
	thumbnailKey: string | null;
	thumbnailFingerprint: string | null;
	action: "media" | "reuse" | "failed";
	adopt: boolean;
	error: string | null;
};

export type ScanPlan = {
	sourceRoot: string;
	thumbnailsRoot: string;
	items: PlannedPhoto[];
};

export type SourceIdentity = {
	fingerprint: string;
	size: bigint;
	modifiedSeconds: bigint;
	changedNs: bigint;
};

export async function sourceIdentity(
	filePath: string,
): Promise<SourceIdentity> {
	const metadata = await stat(filePath, { bigint: true });
	if (!metadata.isFile()) throw new Error("Source is not a regular file");
	return {
		fingerprint: `${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`,
		size: metadata.size,
		modifiedSeconds: metadata.mtimeNs / 1_000_000_000n,
		changedNs: metadata.ctimeNs,
	};
}

export async function thumbnailIdentity(
	baseDir: string,
	key: string,
	sourceChangedNs?: bigint,
) {
	const parts = await Promise.all(
		getAllThumbnailSizes().map(async (size) => {
			const metadata = await stat(join(baseDir, getThumbnailPath(key, size)), {
				bigint: true,
			});
			if (!metadata.isFile() || metadata.size === 0n) {
				throw new Error(`Missing ${size} thumbnail`);
			}
			if (
				sourceChangedNs !== undefined &&
				metadata.mtimeNs <= sourceChangedNs
			) {
				throw new Error("Legacy thumbnails predate the source's last change");
			}
			return `${size}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
		}),
	);
	return `${resolve(baseDir)}|${parts.join("|")}`;
}

export async function createScanPlan(
	database: typeof db,
	discovery: { filePaths: string[]; relativePaths: string[] },
	directory: string,
	thumbnailsDir: string,
	force = false,
): Promise<ScanPlan> {
	if (discovery.filePaths.length !== discovery.relativePaths.length) {
		throw new Error("Scan discovery paths must have matching lengths");
	}
	const sourceRoot = await realpath(directory);
	const thumbnailsRoot = resolve(thumbnailsDir);
	const existing = database
		.select({ photo: photos, phash: photoPhash.hash })
		.from(photos)
		.leftJoin(photoPhash, eq(photoPhash.photoId, photos.id))
		.all();
	const byPath = new Map(existing.map((row) => [row.photo.path, row]));
	// Legacy stem-based paths are unsafe if any known/discovered source shares them.
	const owners = new Map<string, Set<string>>();
	for (const relativePath of new Set([
		...byPath.keys(),
		...discovery.relativePaths,
	])) {
		const key = getThumbnailPath(relativePath, "large")
			.normalize("NFC")
			.toLowerCase();
		const paths = owners.get(key) ?? new Set<string>();
		paths.add(relativePath);
		owners.set(key, paths);
	}
	const items: PlannedPhoto[] = [];
	const legacy: { item: PlannedPhoto; width: number; height: number }[] = [];
	// Bound filesystem fan-out independently of the native processing pool.
	for (let offset = 0; offset < discovery.filePaths.length; offset += 16) {
		const chunk = await Promise.all(
			discovery.filePaths
				.slice(offset, offset + 16)
				.map(async (filePath, index) => {
					const relativePath = discovery.relativePaths[offset + index];
					const known = byPath.get(relativePath);
					const photo = known?.photo;
					const item: PlannedPhoto = {
						filePath,
						relativePath,
						photoId: photo?.id ?? null,
						previousThumbnailKey: photo?.thumbnailKey ?? null,
						previousSourceFingerprint: photo?.sourceFingerprint ?? null,
						sourceFingerprint: null,
						thumbnailKey: null,
						thumbnailFingerprint: null,
						action: "media",
						adopt: false,
						error: null,
					};
					let source: SourceIdentity;
					try {
						source = await sourceIdentity(filePath);
						item.sourceFingerprint = source.fingerprint;
					} catch (error) {
						item.action = "failed";
						item.error = error instanceof Error ? error.message : String(error);
						return item;
					}
					if (
						force ||
						!photo ||
						photo.thumbnailStatus !== "completed" ||
						photo.phashStatus !== "completed" ||
						!known.phash ||
						!photo.width ||
						!photo.height ||
						(photo.isRaw && photo.rawStatus !== "converted")
					)
						return item;
					const isLegacy =
						photo.sourceRoot === null &&
						photo.sourceFingerprint === null &&
						photo.mediaVersion === null &&
						photo.thumbnailKey === null &&
						photo.thumbnailRoot === null &&
						photo.thumbnailFingerprint === null;
					const current =
						photo.sourceRoot === sourceRoot &&
						photo.sourceFingerprint === source.fingerprint &&
						photo.mediaVersion === MEDIA_VERSION &&
						photo.thumbnailKey !== null &&
						photo.thumbnailRoot === thumbnailsRoot;
					if (
						!current &&
						!(
							isLegacy &&
							BigInt(photo.size) === source.size &&
							BigInt(Math.floor(photo.modifiedAt.getTime() / 1000)) ===
								source.modifiedSeconds &&
							photo.thumbnailUpdatedAt !== null &&
							owners.get(
								getThumbnailPath(relativePath, "large")
									.normalize("NFC")
									.toLowerCase(),
							)?.size === 1
						)
					)
						return item;
					const key = photo.thumbnailKey ?? relativePath;
					try {
						item.thumbnailFingerprint = await thumbnailIdentity(
							thumbnailsRoot,
							key,
							isLegacy ? source.changedNs : undefined,
						);
					} catch {
						return item; // Missing/incomplete artifacts need media repair, not a skip.
					}
					if (
						current &&
						item.thumbnailFingerprint === photo.thumbnailFingerprint
					) {
						item.thumbnailKey = key;
						item.action = "reuse";
					} else if (isLegacy) {
						legacy.push({ item, width: photo.width, height: photo.height });
					}
					return item;
				}),
		);
		items.push(...chunk);
	}
	for (let offset = 0; offset < legacy.length; offset += 64) {
		const chunk = legacy.slice(offset, offset + 64);
		const valid = await nativeExecutor.run(
			"validateThumbnails",
			chunk.map(({ item, width, height }) => ({
				path: item.relativePath,
				width,
				height,
			})),
			thumbnailsRoot,
		);
		if (valid.length !== chunk.length)
			throw new Error("Thumbnail validation results must align");
		await Promise.all(
			chunk.map(async ({ item }, index) => {
				if (!valid[index]) return;
				try {
					if (
						(await sourceIdentity(item.filePath)).fingerprint !==
							item.sourceFingerprint ||
						(await thumbnailIdentity(thumbnailsRoot, item.relativePath)) !==
							item.thumbnailFingerprint
					)
						return;
					item.thumbnailKey = item.relativePath;
					item.action = "reuse";
					item.adopt = true;
				} catch {
					// Re-processing performs the usual failure handling if a source vanished.
				}
			}),
		);
	}
	return { sourceRoot, thumbnailsRoot, items };
}
