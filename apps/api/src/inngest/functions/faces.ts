import { config } from "../../config";
import { db } from "../../db";
import {
	clusterFaces,
	detectFaceBatch,
	FACE_BATCH_SIZE,
	nativeFaceClusterer,
} from "../../services/faces";
import { nativeExecutor } from "../../services/native-executor";
import { inngest } from "../client";

/**
 * Detects faces in the committed `large` thumbnail of every stack-representative
 * still whose face scan is missing or from another generation/model version.
 * Each step reads, detects (off the API thread through the native executor),
 * and writes at most 32 photos past a keyset cursor in one generation-fenced
 * transaction, so retries and duplicate events are idempotent. A final step
 * assigns new faces to existing people, groups the rest into new unnamed
 * people, and deletes unnamed people left without faces.
 */
export const detectFacesFunction = inngest.createFunction(
	{ id: "detect-faces-v1", concurrency: { limit: 1 } },
	{ event: "photos/faces.requested" },
	async ({ step }) => {
		let cursor = 0;
		let scanned = 0;
		let failed = 0;
		for (let batch = 0; ; batch++) {
			const result = await step.run(`detect-faces-batch-v1-${batch}`, () =>
				detectFaceBatch(
					db,
					(paths) => nativeExecutor.run("detectFaces", paths),
					config.THUMBNAILS_DIRECTORY,
					cursor,
					FACE_BATCH_SIZE,
				),
			);
			scanned += result.scanned;
			failed += result.failed;
			cursor = result.cursor;
			if (result.read < FACE_BATCH_SIZE) break;
		}
		const clustered = await step.run("cluster-faces-v1", () =>
			clusterFaces(db, nativeFaceClusterer),
		);
		return { scanned, failed, ...clustered };
	},
);
