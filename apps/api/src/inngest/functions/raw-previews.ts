import { join } from "node:path";
import { getThumbnailPath } from "@photobrain/utils";
import { config } from "../../config";
import { db } from "../../db";
import { saveEmbeddingBatch } from "../../services/import-persistence";
import { nativeExecutor } from "../../services/native-executor";
import {
	developNextRawPreview,
	pendingRawPreviewEmbeddings,
	type RawPreviewConfig,
	rawPreviewConfigKey,
	rawPreviewImportActive,
} from "../../services/raw-previews";
import { loadTagLabelMatrix } from "../../services/tag-labels";
import { inngest } from "../client";

const settings: RawPreviewConfig = {
	photoDirectory: config.PHOTO_DIRECTORY,
	thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
	options: {
		engine: config.RAW_DEVELOP_ENGINE,
		adobeProfileDir: config.ADOBE_PROFILE_DIR,
		denoiseModelDir: config.DENOISE_MODEL_DIR,
		denoiseCacheDir: config.DENOISE_CACHE_DIR,
	},
};

/** Bounded runs recover from disk/recipe receipts; cron also backfills existing libraries. */
export const developRawPreviewsFunction = inngest.createFunction(
	{ id: "develop-raw-previews-v1", concurrency: { limit: 1 } },
	[{ event: "photos/raw-previews.requested" }, { cron: "*/5 * * * *" }],
	async ({ step }) => {
		const configKey = await step.run("configuration", () =>
			rawPreviewConfigKey(settings),
		);
		let processed = 0;
		let paused = false;
		for (; processed < 100; processed++) {
			const result = await step.run(`develop-${processed}`, () =>
				developNextRawPreview(
					db,
					(path, key, root, options) =>
						nativeExecutor.runWhenAdmitted(
							undefined,
							"generateDevelopedPreviews",
							path,
							key,
							root,
							options,
						),
					settings,
					configKey,
				),
			);
			if (result.kind === "paused") {
				paused = true;
				break;
			}
			// Repair pending embeddings even after a crash immediately following publication.
			await step.run(`index-${processed}`, async () => {
				if (rawPreviewImportActive(db)) return;
				const targets = pendingRawPreviewEmbeddings(db);
				if (!targets.length) return;
				const paths = targets.map((photo) =>
					join(
						photo.thumbnailRoot ?? config.THUMBNAILS_DIRECTORY,
						getThumbnailPath(photo.thumbnailKey ?? photo.path, "large"),
					),
				);
				const vectors = await nativeExecutor.runWhenAdmitted(
					undefined,
					"batchGenerateClipEmbeddings",
					paths,
				);
				let labels = null;
				try {
					labels = loadTagLabelMatrix();
				} catch (error) {
					console.error("RAW preview tag labels unavailable", error);
				}
				saveEmbeddingBatch(db, targets, vectors, labels);
			});
			if (result.kind === "idle") break;
		}
		if (!paused)
			await step.sendEvent("refresh-analysis", [
				{ name: "photos/quality.requested", data: {} },
				{ name: "photos/faces.requested", data: {} },
				{ name: "photos/tags.requested", data: {} },
			]);
		if (processed === 100)
			await step.sendEvent("continue", {
				name: "photos/raw-previews.requested",
				data: {},
			});
		return { processed, paused };
	},
);
