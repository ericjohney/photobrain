import { createHash, randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DevelopedRawOptions } from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { and, desc, eq, sql } from "drizzle-orm";
import {
	photoRawEdits,
	photoRawPreviews,
	photos,
	previewRevision,
	scanJobs,
	scanManifests,
} from "../db/schema";
import { type ApiDatabase, pairedPhotoIdSql } from "./photo-catalog";
import { originalFilePath } from "./photo-files";
import {
	denoiseAmount,
	rawDevelopSettingsJson,
	readRawEdit,
} from "./raw-edits";
import { sourceIdentity, thumbnailIdentity } from "./scan-planner";

// Bump for changes to development, colour encoding, or artifact layout.
export const RAW_PREVIEW_VERSION = "raw-display-v1";
export type RawPreviewConfig = {
	photoDirectory: string;
	thumbnailsDirectory: string;
	options: DevelopedRawOptions & { engine: "apple" | "adobe" };
};
export type PreviewRenderer = (
	path: string,
	key: string,
	root: string,
	options: DevelopedRawOptions,
) => Promise<{ width: number; height: number; engine: string }>;

/** Asset metadata and settings remain server-private; only a revision number is public. */
export async function rawPreviewConfigKey(config: RawPreviewConfig) {
	const assets: unknown[] = [];
	for (const directory of [
		config.options.adobeProfileDir,
		config.options.denoiseModelDir,
	]) {
		if (!directory) continue;
		for (const name of (await readdir(directory)).sort()) {
			const path = join(directory, name);
			const info = await stat(path, { bigint: true });
			assets.push([
				path,
				String(info.size),
				String(info.mtimeNs),
				String(info.ctimeNs),
			]);
		}
	}
	return createHash("sha256")
		.update(
			JSON.stringify([
				RAW_PREVIEW_VERSION,
				config.options,
				process.env.DENOISE_BACKEND ?? "auto",
				assets,
			]),
		)
		.digest("hex");
}

export function getPreviewRevision(database: ApiDatabase) {
	return {
		revision:
			database
				.select()
				.from(previewRevision)
				.where(eq(previewRevision.id, 1))
				.get()?.revision ?? 0,
	};
}

/** No per-request RAW work: the viewer reads the last published JPEG or the first-pass WebP. */
export function storedRawPreview(
	database: ApiDatabase,
	photoId: number,
	thumbnailsDirectory: string,
) {
	const row = database
		.select({ photo: photos, preview: photoRawPreviews })
		.from(photos)
		.leftJoin(photoRawPreviews, eq(photoRawPreviews.photoId, photos.id))
		.where(eq(photos.id, photoId))
		.get();
	if (!row?.photo.isRaw || row.photo.thumbnailStatus !== "completed")
		return null;
	const { photo, preview } = row;
	const root = photo.thumbnailRoot ?? thumbnailsDirectory;
	const key = photo.thumbnailKey ?? photo.path;
	const developed =
		preview?.status === "completed" && preview.thumbnailKey === key;
	return {
		path: developed
			? join(root, "large", key).replace(/\.[^/.]+$/, ".jpg")
			: join(root, getThumbnailPath(key, "large")),
		contentType: developed ? "image/jpeg" : "image/webp",
		width: developed ? preview.width : null,
		height: developed ? preview.height : null,
		engine: developed ? preview.engine : "embedded",
	};
}

/** Keep both first-pass media and its frozen embedding generations stable. */
export function rawPreviewImportActive(database: Pick<ApiDatabase, "select">) {
	return Boolean(
		database
			.select({ id: scanJobs.id })
			.from(scanJobs)
			.where(sql`${scanJobs.status} NOT IN ('completed', 'failed')`)
			.limit(1)
			.get() ||
			database
				.select({ id: scanManifests.jobId })
				.from(scanManifests)
				.limit(1)
				.get(),
	);
}

/** One image per durable step. The first-pass import always owns the catalog while scanning. */
export async function developNextRawPreview(
	database: ApiDatabase,
	render: PreviewRenderer,
	config: RawPreviewConfig,
	configKey: string,
	now = new Date(),
) {
	if ((await rawPreviewConfigKey(config)) !== configKey)
		return { kind: "paused" as const };
	if (rawPreviewImportActive(database)) return { kind: "paused" as const };
	const partner = pairedPhotoIdSql();
	const pairKey = sql`(SELECT thumbnail_key FROM photos partner WHERE partner.id = ${partner})`;
	const candidate = database
		.select({
			photo: photos,
			receipt: photoRawPreviews,
			pairId: sql<number | null>`${partner}`,
		})
		.from(photos)
		.leftJoin(photoRawEdits, eq(photoRawEdits.photoId, photos.id))
		.leftJoin(photoRawPreviews, eq(photoRawPreviews.photoId, photos.id))
		.where(sql`${photos.isRaw} = 1 AND ${photos.thumbnailStatus} = 'completed'
			AND ${photos.sourceFingerprint} IS NOT NULL AND ${photos.thumbnailKey} IS NOT NULL
			AND (lower(${photos.path}) GLOB '*.raf' OR lower(${photos.path}) GLOB '*.arw' OR lower(${photos.path}) GLOB '*.dng')
			AND (${photoRawPreviews.photoId} IS NULL
				OR ${photoRawPreviews.thumbnailKey} IS NOT ${photos.thumbnailKey}
				OR ${photoRawPreviews.sourceFingerprint} IS NOT ${photos.sourceFingerprint}
				OR ${photoRawPreviews.configKey} != ${configKey}
				OR ${photoRawPreviews.recipeRevision} != coalesce(${photoRawEdits.revision}, 0)
				OR ${photoRawPreviews.pairPhotoId} IS NOT ${partner}
				OR ${photoRawPreviews.pairThumbnailKey} IS NOT ${pairKey}
				OR (${photoRawPreviews.status} = 'failed' AND ${photoRawPreviews.attempts} < 3 AND ${photoRawPreviews.retryAt} <= ${Math.floor(now.getTime() / 1000)}))`)
		.orderBy(desc(photos.id))
		.limit(1)
		.get();
	if (!candidate) return { kind: "idle" as const };
	const photo = candidate.photo;
	const { sourceFingerprint, thumbnailKey } = photo;
	if (sourceFingerprint === null || thumbnailKey === null)
		return { kind: "stale" as const };
	const pair = candidate.pairId
		? database
				.select()
				.from(photos)
				.where(eq(photos.id, candidate.pairId))
				.get()
		: undefined;
	const recipe = readRawEdit(database, photo.id, config.options.engine);
	const root = photo.thumbnailRoot ?? resolve(config.thumbnailsDirectory);
	const key = `.versions/${randomUUID()}/photo.image`;
	const source = originalFilePath(photo, config.photoDirectory);
	const sameAttempt =
		candidate.receipt?.thumbnailKey === photo.thumbnailKey &&
		candidate.receipt?.sourceFingerprint === photo.sourceFingerprint &&
		candidate.receipt?.pairPhotoId === (pair?.id ?? null) &&
		candidate.receipt?.pairThumbnailKey === (pair?.thumbnailKey ?? null) &&
		candidate.receipt?.recipeRevision === recipe.revision &&
		candidate.receipt?.configKey === configKey;
	const matches = (tx: Pick<ApiDatabase, "select">) => {
		if (rawPreviewImportActive(tx)) return false;
		for (const original of [photo, ...(pair ? [pair] : [])]) {
			const current = tx
				.select()
				.from(photos)
				.where(eq(photos.id, original.id))
				.get();
			if (
				!current ||
				current.path !== original.path ||
				current.sourceRoot !== original.sourceRoot ||
				current.sourceFingerprint !== original.sourceFingerprint ||
				current.thumbnailRoot !== original.thumbnailRoot ||
				current.thumbnailKey !== original.thumbnailKey
			)
				return false;
		}
		const currentPair = tx
			.select({ id: sql<number | null>`${pairedPhotoIdSql()}` })
			.from(photos)
			.where(eq(photos.id, photo.id))
			.get();
		return (
			currentPair?.id === (pair?.id ?? null) &&
			readRawEdit(tx, photo.id, config.options.engine).revision ===
				recipe.revision
		);
	};
	const receipt = {
		photoId: photo.id,
		sourceFingerprint,
		recipeRevision: recipe.revision,
		configKey,
		pairPhotoId: pair?.id ?? null,
		pairThumbnailKey: pair?.thumbnailKey ?? null,
	};
	try {
		if ((await sourceIdentity(source)).fingerprint !== photo.sourceFingerprint)
			throw new Error("RAW source changed; waiting for reimport");
		if (
			pair &&
			(await sourceIdentity(originalFilePath(pair, config.photoDirectory)))
				.fingerprint !== pair.sourceFingerprint
		)
			throw new Error("Paired source changed; waiting for reimport");
		const result = await render(source, key, root, {
			...config.options,
			engine: recipe.engine,
			settingsJson: rawDevelopSettingsJson(recipe.settings, recipe.engine),
			denoiseAmount: denoiseAmount(recipe.settings),
		});
		const fingerprint = await thumbnailIdentity(root, key);
		if ((await rawPreviewConfigKey(config)) !== configKey)
			return { kind: "paused" as const };
		if (
			!(await stat(join(root, "large", key).replace(/\.[^/.]+$/, ".jpg"))).size
		)
			throw new Error("Missing developed viewer preview");
		if ((await sourceIdentity(source)).fingerprint !== photo.sourceFingerprint)
			throw new Error("RAW source changed during development");
		if (
			pair &&
			(await sourceIdentity(originalFilePath(pair, config.photoDirectory)))
				.fingerprint !== pair.sourceFingerprint
		)
			throw new Error("Paired source changed during development");
		const published = database.transaction((tx) => {
			if (!matches(tx)) return false;
			for (const target of [photo, ...(pair ? [pair] : [])]) {
				tx.update(photos)
					.set({
						thumbnailKey: key,
						thumbnailRoot: root,
						thumbnailFingerprint: fingerprint,
						thumbnailUpdatedAt: new Date(
							Math.max(
								now.getTime(),
								(target.thumbnailUpdatedAt?.getTime() ?? 0) + 1000,
							),
						),
						embeddingStatus: "pending",
					})
					.where(eq(photos.id, target.id))
					.run();
			}
			const values = {
				...receipt,
				thumbnailKey: key,
				pairThumbnailKey: pair ? key : null,
				status: "completed" as const,
				attempts: 0,
				retryAt: null,
				error: null,
				...result,
			};
			tx.insert(photoRawPreviews)
				.values(values)
				.onConflictDoUpdate({ target: photoRawPreviews.photoId, set: values })
				.run();
			tx.insert(previewRevision)
				.values({ id: 1, revision: 1 })
				.onConflictDoUpdate({
					target: previewRevision.id,
					set: { revision: sql`${previewRevision.revision} + 1` },
				})
				.run();
			return true;
		});
		return { kind: published ? ("published" as const) : ("stale" as const) };
	} catch (error) {
		database.transaction((tx) => {
			if (!matches(tx)) return;
			const values = {
				...receipt,
				thumbnailKey,
				status: "failed" as const,
				attempts: sameAttempt ? (candidate.receipt?.attempts ?? 0) + 1 : 1,
				retryAt: new Date(now.getTime() + 3600_000),
				error: String(error).slice(0, 1000),
				width: null,
				height: null,
				engine: recipe.engine,
			};
			tx.insert(photoRawPreviews)
				.values(values)
				.onConflictDoUpdate({ target: photoRawPreviews.photoId, set: values })
				.run();
		});
		return { kind: "failed" as const };
	}
}

/** Generation-fenced embedding input, including a stacked JPEG sharing the RAW artifacts. */
export function pendingRawPreviewEmbeddings(database: ApiDatabase) {
	return database
		.select({
			id: photos.id,
			path: photos.path,
			thumbnailRoot: photos.thumbnailRoot,
			thumbnailKey: photos.thumbnailKey,
		})
		.from(photos)
		.where(
			and(
				sql`${photos.embeddingStatus} IN ('pending', 'failed')`,
				sql`EXISTS (SELECT 1 FROM photo_raw_previews p WHERE p.status = 'completed' AND p.thumbnail_key = ${photos.thumbnailKey} AND (p.photo_id = ${photos.id} OR p.pair_photo_id = ${photos.id}))`,
			),
		)
		.limit(16)
		.all();
}
