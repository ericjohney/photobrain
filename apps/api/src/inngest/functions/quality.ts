import { config } from "../../config";
import { db } from "../../db";
import { nativeExecutor } from "../../services/native-executor";
import {
	analyzeQualityBatch,
	QUALITY_BACKFILL_BATCH_SIZE,
} from "../../services/photo-quality";
import { inngest } from "../client";

/**
 * Measures sharpness/brightness of every committed `medium` thumbnail lacking
 * a current-generation, current-version quality row. Each step reads,
 * measures (off the API thread through the native executor), and writes at
 * most 200 rows past a keyset cursor in one generation-fenced transaction, so
 * retries and duplicate events are idempotent.
 */
export const analyzeQualityFunction = inngest.createFunction(
	{ id: "analyze-quality-v1", concurrency: { limit: 1 } },
	{ event: "photos/quality.requested" },
	async ({ step }) => {
		let cursor = 0;
		let measured = 0;
		for (let batch = 0; ; batch++) {
			const result = await step.run(`analyze-quality-batch-v1-${batch}`, () =>
				analyzeQualityBatch(
					db,
					(paths) => nativeExecutor.run("analyzeImageQuality", paths),
					config.THUMBNAILS_DIRECTORY,
					cursor,
					QUALITY_BACKFILL_BATCH_SIZE,
				),
			);
			measured += result.measured;
			cursor = result.cursor;
			if (result.read < QUALITY_BACKFILL_BATCH_SIZE) break;
		}
		return { measured };
	},
);
