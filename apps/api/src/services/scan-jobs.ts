import path from "node:path";
import { and, desc, eq, notInArray } from "drizzle-orm";
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
			createdAt: now,
			updatedAt: now,
		});
		jobCreated = true;

		const event: ScanRequestedEvent = {
			id: jobId,
			name: "photos/scan.requested",
			data: {
				directory: path.resolve(options.photoDirectory),
				thumbnailsDir: path.resolve(options.thumbnailsDirectory),
				jobId,
				force: options.force ?? false,
			},
		};
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
