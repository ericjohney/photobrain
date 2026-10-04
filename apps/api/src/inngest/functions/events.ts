import { db } from "../../db";
import { detectEvents } from "../../services/events";
import { inngest } from "../client";

/**
 * Recomputes every automatic event in one step: one streamed candidate read
 * and one transaction replacing `events`/`event_photos`, so retries and
 * duplicate events are idempotent and readers never see a partial set.
 */
export const detectEventsFunction = inngest.createFunction(
	{ id: "detect-events-v1", concurrency: { limit: 1 } },
	{ event: "photos/events.requested" },
	async ({ step }) => step.run("detect-events-v1", () => detectEvents(db)),
);
