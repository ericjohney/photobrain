import { and, eq, notInArray } from "drizzle-orm";
import { db } from "../db";
import { scanJobs } from "../db/schema";

const TERMINAL_STATUSES = ["completed", "failed"];

export async function updateJobProgress(
	jobId: string,
	phase: string,
	current: number,
	total: number,
) {
	const updated = await db
		.update(scanJobs)
		.set({
			phase,
			current,
			total,
			status:
				phase === "completed"
					? "completed"
					: phase === "failed"
						? "failed"
						: phase === "queued"
							? "queued"
							: "running",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(scanJobs.id, jobId),
				notInArray(scanJobs.status, TERMINAL_STATUSES),
			),
		)
		.returning({ id: scanJobs.id });
	return updated.length > 0;
}

export async function failJob(jobId: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const [updated] = await db
		.update(scanJobs)
		.set({
			phase: "failed",
			status: "failed",
			error: message,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(scanJobs.id, jobId),
				notInArray(scanJobs.status, TERMINAL_STATUSES),
			),
		)
		.returning({ current: scanJobs.current, total: scanJobs.total });
	return updated ?? null;
}
