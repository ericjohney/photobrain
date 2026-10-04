import { db } from "../../db";
import {
	PLACE_BACKFILL_BATCH_SIZE,
	placePhotoBatch,
} from "../../services/photo-places";
import { loadPlaceIndex } from "../../services/place-lookup";
import { inngest } from "../client";

/**
 * Brings every photo's offline place up to date: geocodes valid locations
 * lacking a current place (missing, older dataset version, or computed from
 * different coordinate texts) and deletes places whose location was removed,
 * became invalid, or no longer has a city within 100 km. Each step handles at
 * most 1,000 photos past a keyset cursor in one transaction, so retries and
 * duplicate events are idempotent and replays only redo the unfinished step.
 * Events are requested only afterwards, because event labels and place-based
 * scene splits read the current places.
 */
export const placePhotosFunction = inngest.createFunction(
	{ id: "place-photos-v1", concurrency: { limit: 1 } },
	{ event: "photos/places.requested" },
	async ({ step }) => {
		let cursor = 0;
		let placed = 0;
		let removed = 0;
		for (let batch = 0; ; batch++) {
			const result = await step.run(`place-photos-batch-v1-${batch}`, () =>
				placePhotoBatch(
					db,
					loadPlaceIndex(),
					cursor,
					PLACE_BACKFILL_BATCH_SIZE,
				),
			);
			placed += result.placed;
			removed += result.removed;
			cursor = result.cursor;
			if (result.read < PLACE_BACKFILL_BATCH_SIZE) break;
		}
		await step.sendEvent("trigger-events-v1", {
			name: "photos/events.requested",
			data: {},
		});
		return { placed, removed };
	},
);
