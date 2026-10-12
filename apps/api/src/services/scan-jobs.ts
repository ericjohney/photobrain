import path from "node:path";
import { and, asc, desc, eq, lt, notInArray } from "drizzle-orm";
import type { db as productionDb } from "../db";
import { scanJobs } from "../db/schema";

export type ScanDatabase = typeof productionDb;

export type ScanRequestedEvent = {
	id: string;
	name: "photos/scan.requested";
	data: {
		directory: string;
		thumbnailsDir: string;
		jobId: string;
		force: boolean;
	};
};

export type ScanEventDispatcher = (
	event: ScanRequestedEvent,
) => Promise<unknown>;

export type StartScanResult =
	| { success: true; jobId: string }
	| {
			success: false;
			reason: "creation" | "dispatch";
			error: string;
			jobId?: string;
	  };

/**
 * The scan event for a job. Its `id` is the job ID, so Inngest deduplicates a
 * re-send of the same job (within its 24 h event-ID window).
 */
function scanRequestedEvent(
	jobId: string,
	force: boolean,
	options: { photoDirectory: string; thumbnailsDirectory: string },
): ScanRequestedEvent {
	return {
		id: jobId,
		name: "photos/scan.requested",
		data: {
			directory: path.resolve(options.photoDirectory),
			thumbnailsDir: path.resolve(options.thumbnailsDirectory),
			jobId,
			force,
		},
	};
}

export async function startScan(
	database: ScanDatabase,
	dispatch: ScanEventDispatcher,
	options: {
		force?: boolean;
		photoDirectory: string;
		thumbnailsDirectory: string;
	},
): Promise<StartScanResult> {
	const jobId = crypto.randomUUID();
	let jobCreated = false;
	try {
		const now = new Date();
		await database.insert(scanJobs).values({
			id: jobId,
			phase: "queued",
			current: 0,
			total: 0,
			status: "queued",
			force: options.force ?? false,
			createdAt: now,
			updatedAt: now,
		});
		jobCreated = true;

		const event = scanRequestedEvent(jobId, options.force ?? false, options);
		let dispatchError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await dispatch(event);
				dispatchError = null;
				break;
			} catch (error) {
				dispatchError = error;
			}
		}
		if (dispatchError) throw dispatchError;
		return { success: true, jobId };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		if (jobCreated) {
			const markedFailed = await database
				.update(scanJobs)
				.set({
					phase: "failed",
					status: "failed",
					error: message,
					updatedAt: new Date(),
				})
				.where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "queued")))
				.returning({ id: scanJobs.id });
			if (markedFailed.length === 0) return { success: true, jobId };
		}
		return {
			success: false,
			reason: jobCreated ? "dispatch" : "creation",
			error: message,
			...(jobCreated ? { jobId } : {}),
		};
	}
}

export async function getScan(database: ScanDatabase, jobId: string) {
	return (
		(await database.query.scanJobs.findFirst({
			where: eq(scanJobs.id, jobId),
		})) ?? null
	);
}

export async function listActiveScans(database: ScanDatabase) {
	return database.query.scanJobs.findMany({
		where: notInArray(scanJobs.status, ["completed", "failed"]),
		orderBy: [
			desc(scanJobs.updatedAt),
			desc(scanJobs.createdAt),
			desc(scanJobs.id),
		],
	});
}

/** Queued jobs older than this were never delivered; fail rather than re-send. */
export const QUEUED_SCAN_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type RecoveredScans = { resent: string[]; expired: string[] };

/**
 * Repairs scans left `queued` by a crash between inserting the job and
 * sending its event (there is no outbox). Jobs queued before `queuedBefore`
 * are re-sent with their original mode; the event ID is the job ID, so a job
 * whose event did arrive is deduplicated by Inngest, and a duplicate run that
 * slips past the window finds the job no longer queued and claims nothing new.
 * Jobs older than `QUEUED_SCAN_EXPIRY_MS` (beyond the dedupe window) fail.
 * A failed re-send leaves the job queued for the next attempt.
 */
export async function recoverQueuedScans(
	database: ScanDatabase,
	dispatch: ScanEventDispatcher,
	options: {
		photoDirectory: string;
		thumbnailsDirectory: string;
		queuedBefore: Date;
		now?: Date;
	},
): Promise<RecoveredScans> {
	const now = options.now ?? new Date();
	const stale = await database
		.select({
			id: scanJobs.id,
			force: scanJobs.force,
			createdAt: scanJobs.createdAt,
		})
		.from(scanJobs)
		.where(
			and(
				eq(scanJobs.status, "queued"),
				lt(scanJobs.createdAt, options.queuedBefore),
			),
		)
		.orderBy(asc(scanJobs.createdAt), asc(scanJobs.id));
	const recovered: RecoveredScans = { resent: [], expired: [] };
	for (const job of stale) {
		if (now.getTime() - job.createdAt.getTime() > QUEUED_SCAN_EXPIRY_MS) {
			const failed = await database
				.update(scanJobs)
				.set({
					phase: "failed",
					status: "failed",
					error: "Scan was never started",
					updatedAt: now,
				})
				.where(and(eq(scanJobs.id, job.id), eq(scanJobs.status, "queued")))
				.returning({ id: scanJobs.id });
			if (failed.length > 0) recovered.expired.push(job.id);
			continue;
		}
		try {
			await dispatch(scanRequestedEvent(job.id, job.force, options));
			recovered.resent.push(job.id);
		} catch (error) {
			console.error(`Failed to re-send queued scan ${job.id}:`, error);
		}
	}
	return recovered;
}
