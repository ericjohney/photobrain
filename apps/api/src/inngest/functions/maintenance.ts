import { config } from "../../config";
import { db } from "../../db";
import { recoverQueuedScans } from "../../services/scan-jobs";
import { collectThumbnailGarbage } from "../../services/thumbnail-gc";
import { inngest } from "../client";

/** A queued job younger than this may still be mid-dispatch in `startScan`. */
export const QUEUED_SCAN_RECOVERY_DELAY_MS = 5 * 60 * 1000;

/**
 * Hourly (or on `photos/maintenance.requested`) library upkeep:
 * 1. re-sends scans left `queued` by a crash before their event was sent, and
 *    fails ones too old to re-send safely;
 * 2. deletes thumbnail generations no row references (superseded, abandoned,
 *    or belonging to removed photos). Collection skips itself while any scan
 *    holds a manifest.
 */
export const libraryMaintenanceFunction = inngest.createFunction(
	{ id: "library-maintenance-v1", concurrency: { limit: 1 } },
	[{ cron: "17 * * * *" }, { event: "photos/maintenance.requested" }],
	async ({ step }) => {
		const scans = await step.run("recover-queued-scans-v1", () =>
			recoverQueuedScans(db, (event) => inngest.send(event), {
				photoDirectory: config.PHOTO_DIRECTORY,
				thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
				queuedBefore: new Date(Date.now() - QUEUED_SCAN_RECOVERY_DELAY_MS),
			}),
		);
		const thumbnails = await step.run("collect-thumbnail-garbage-v1", () =>
			collectThumbnailGarbage(db, config.THUMBNAILS_DIRECTORY),
		);
		if (thumbnails.deleted > 0)
			console.log(
				`Thumbnail GC: deleted ${thumbnails.deleted} generations (${thumbnails.bytes} bytes)`,
			);
		return { scans, thumbnails };
	},
);
