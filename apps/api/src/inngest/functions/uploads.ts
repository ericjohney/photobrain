import { config } from "../../config";
import { db } from "../../db";
import { startScan } from "../../services/scan-jobs";
import { inngest } from "../client";

/**
 * Imports phone backup uploads with the existing incremental scan. Each
 * created upload sends `photos/uploaded`; the 60 s debounce runs once after a
 * burst of uploads goes quiet, through the same `startScan` as tRPC/v1.
 */
export const scanAfterUploadFunction = inngest.createFunction(
	{ id: "scan-after-upload-v1", debounce: { period: "60s" } },
	{ event: "photos/uploaded" },
	async ({ step }) =>
		step.run("start-scan-after-upload-v1", async () => {
			const result = await startScan(db, (event) => inngest.send(event), {
				force: false,
				photoDirectory: config.PHOTO_DIRECTORY,
				thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
			});
			if (!result.success) throw new Error(result.error);
			return result;
		}),
);
