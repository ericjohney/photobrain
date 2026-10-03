import { db } from "../../db";
import {
	TAG_BACKFILL_BATCH_SIZE,
	tagPhotoBatch,
} from "../../services/photo-tagging";
import { loadTagLabelMatrix } from "../../services/tag-labels";
import { inngest } from "../client";

/**
 * Tags every committed current-model vector lacking current-vocabulary tags.
 * Each step reads, scores, and writes at most 1,000 rows past a keyset cursor
 * in one generation-fenced transaction, so retries and duplicate events are
 * idempotent and replays only redo the unfinished step.
 */
export const tagPhotosFunction = inngest.createFunction(
	{ id: "tag-photos-v1", concurrency: { limit: 1 } },
	{ event: "photos/tags.requested" },
	async ({ step }) => {
		let cursor = 0;
		let tagged = 0;
		for (let batch = 0; ; batch++) {
			const result = await step.run(`tag-photos-batch-v1-${batch}`, () =>
				tagPhotoBatch(
					db,
					loadTagLabelMatrix(),
					cursor,
					TAG_BACKFILL_BATCH_SIZE,
				),
			);
			tagged += result.tagged;
			cursor = result.cursor;
			if (result.read < TAG_BACKFILL_BATCH_SIZE) break;
		}
		return { tagged };
	},
);
