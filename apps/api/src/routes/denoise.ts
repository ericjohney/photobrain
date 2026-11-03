import { stat } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { originalFilePath } from "../services/photo-files";
import { readRawEdit } from "../services/raw-edits";
import type { ExportDependencies } from "./exports";
import { rawEditBodyLimit } from "./raw-edits";
import { photoIdSchema } from "./v1-schemas";

type Job = {
	id: string;
	photoId: number;
	revision: number;
	amount: number;
	status: "processing" | "complete" | "cancelled" | "failed";
	progress: Int32Array<SharedArrayBuffer>;
	controller: AbortController;
	source: string;
	path: string;
	expires: number;
	result?: { data: Uint8Array<ArrayBuffer>; engine: string; token: string };
	message?: string;
};
const inputSchema = z
	.object({
		amount: z.number().int().min(0).max(100),
		revision: z.number().int().nonnegative(),
	})
	.strict();
async function fingerprint(path: string) {
	const s = await stat(path, { bigint: true });
	return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

/** One admitted inference, two retained previews. Jobs are ephemeral: restart/expiry
 * returns 404 and clients can retry against the persistent native camera cache.
 * Neither completion nor cancellation writes a saved recipe. */
export function createDenoiseRouter(deps: ExportDependencies) {
	const router = new Hono();
	const jobs = new Map<string, Job>();
	const fail = (
		code: string,
		message: string,
		status: 400 | 404 | 409 | 422 | 503,
	) =>
		Response.json(
			{ error: { code, message } },
			{ status, headers: { "Cache-Control": "no-store" } },
		);
	const prune = () => {
		for (const [id, job] of jobs)
			if (job.expires < Date.now()) {
				job.controller.abort();
				jobs.delete(id);
			}
	};
	const dto = (job: Job) => ({
		id: job.id,
		status: job.status,
		amount: job.amount,
		completed: Atomics.load(job.progress, 0),
		total: Atomics.load(job.progress, 1),
		message: job.message,
	});
	async function current(job: Job) {
		const photo = await deps.database.query.photos.findFirst({
			where: (p, { eq }) => eq(p.id, job.photoId),
		});
		return (
			!!photo &&
			originalFilePath(photo, deps.photoDirectory) === job.path &&
			readRawEdit(deps.database, job.photoId, "adobe").revision ===
				job.revision &&
			(await fingerprint(job.path)) === job.source
		);
	}
	router.use("/photos/:id/denoise*", async (c, next) => {
		c.header("Cache-Control", "private, no-store");
		prune();
		await next();
	});
	router.post("/photos/:id/denoise", rawEditBodyLimit, async (c) => {
		if (!deps.rawDevelop?.denoiseModelDir || !deps.smartPreviews)
			return fail(
				"DENOISE_UNAVAILABLE",
				"Denoise is not enabled on this server",
				503,
			);
		const photoId = photoIdSchema.safeParse(c.req.param("id"));
		const input = inputSchema.safeParse(await c.req.json().catch(() => null));
		if (!photoId.success || !input.success)
			return fail("INVALID_REQUEST", "Invalid Denoise request", 400);
		const photo = await deps.database.query.photos.findFirst({
			where: (p, { eq }) => eq(p.id, photoId.data),
		});
		if (!photo) return fail("PHOTO_NOT_FOUND", "Photo not found", 404);
		if (!photo.isRaw || /\.dng$/i.test(photo.path))
			return fail(
				"DENOISE_UNSUPPORTED",
				"This RAW layout does not support Denoise",
				422,
			);
		const recipe = readRawEdit(deps.database, photoId.data, "adobe");
		if (recipe.engine !== "adobe")
			return fail(
				"DENOISE_UNSUPPORTED",
				"Denoise requires the Adobe renderer",
				422,
			);
		if (recipe.revision !== input.data.revision)
			return fail(
				"RAW_EDIT_CONFLICT",
				"Reopen the editor to load the latest adjustments",
				409,
			);
		if ([...jobs.values()].some((j) => j.status === "processing"))
			return fail(
				"DENOISE_BUSY",
				"Another Denoise job is running; retry shortly",
				503,
			);
		const path = originalFilePath(photo, deps.photoDirectory);
		let source: string;
		try {
			source = await fingerprint(path);
		} catch {
			return fail("SOURCE_MISSING", "Original RAW is unavailable", 404);
		}
		while (jobs.size >= 2) {
			const first = jobs.keys().next().value;
			if (first) jobs.delete(first);
		}
		const job: Job = {
			id: crypto.randomUUID(),
			photoId: photoId.data,
			revision: input.data.revision,
			amount: input.data.amount,
			status: "processing",
			progress: new Int32Array(new SharedArrayBuffer(8)),
			controller: new AbortController(),
			path,
			source,
			expires: Date.now() + 30 * 60_000,
		};
		jobs.set(job.id, job);
		const timeout = setTimeout(() => job.controller.abort(), 30 * 60_000);
		timeout.unref();
		void deps.smartPreviews
			.runCancellable(job.controller.signal, "prepareSmartPreview", path, 0, {
				...deps.rawDevelop,
				engine: "adobe",
				denoiseAmount: job.amount,
				denoiseProgress: job.progress,
			})
			.then(async (result) => {
				if (job.controller.signal.aborted) {
					job.status = "cancelled";
					return;
				}
				if (!(await current(job))) {
					job.status = "failed";
					job.message =
						"The source or saved adjustments changed. Reopen the editor.";
					return;
				}
				if (job.controller.signal.aborted) {
					job.status = "cancelled";
					return;
				}
				job.result = result;
				job.status = "complete";
			})
			.catch((error) => {
				job.status = job.controller.signal.aborted ? "cancelled" : "failed";
				job.message =
					job.status === "failed"
						? "Denoise failed. This camera/readout may be unsupported, or the server assets are unavailable."
						: undefined;
				if (job.status === "failed")
					console.error("Denoise job failed:", error);
			})
			.finally(() => clearTimeout(timeout));
		return c.json(dto(job), 202);
	});
	router.on(["GET", "DELETE"], "/photos/:id/denoise/:job", async (c) => {
		const job = jobs.get(c.req.param("job"));
		if (!job || String(job.photoId) !== c.req.param("id"))
			return fail(
				"DENOISE_JOB_MISSING",
				"Job expired or server restarted. Apply again to retry.",
				404,
			);
		if (c.req.method === "DELETE") {
			job.controller.abort();
			job.result = undefined;
			// Keep processing admission until native cancellation settles.
			if (job.status !== "processing") job.status = "cancelled";
		}
		return c.json(dto(job));
	});
	router.get("/photos/:id/denoise/:job/preview", async (c) => {
		const job = jobs.get(c.req.param("job"));
		if (!job || String(job.photoId) !== c.req.param("id"))
			return fail("DENOISE_JOB_MISSING", "Job expired; apply again", 404);
		if (job.status !== "complete" || !job.result)
			return fail("DENOISE_NOT_READY", "Denoise preview is not ready", 409);
		if (!(await current(job).catch(() => false)))
			return fail(
				"RAW_EDIT_CONFLICT",
				"Source or adjustments changed; reopen the editor",
				409,
			);
		return new Response(job.result.data, {
			headers: {
				"Content-Type": "application/vnd.photobrain.smart-preview",
				"Cache-Control": "private, no-store",
				"X-Developed-Engine": job.result.engine,
				"X-Denoise-Amount": String(job.amount),
				ETag: `"${job.result.token}"`,
			},
		});
	});
	return router;
}
