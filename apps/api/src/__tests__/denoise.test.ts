import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { photos } from "../db/schema";
import { createDenoiseRouter } from "../routes/denoise";
import type { ExportDependencies } from "../routes/exports";
import {
	defaultRawEditSettings,
	readRawEdit,
	saveRawEdit,
} from "../services/raw-edits";
import { createTestDb } from "./setup";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function fixture() {
	const { db, sqlite } = createTestDb();
	const directory = mkdtempSync(join(tmpdir(), "pb-denoise-"));
	cleanup.push(() => {
		sqlite.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const photo = db
		.insert(photos)
		.values({
			path: "photo.ARW",
			name: "photo.ARW",
			size: 3,
			isRaw: true,
			createdAt: new Date(),
			modifiedAt: new Date(),
		})
		.returning()
		.get();
	writeFileSync(join(directory, photo.path), "raw");
	let finish: (value: {
		data: Uint8Array<ArrayBuffer>;
		engine: "adobe";
		token: string;
	}) => void = () => {};
	let signal: AbortSignal | undefined;
	const deps: ExportDependencies = {
		database: db,
		photoDirectory: directory,
		renderer: {} as ExportDependencies["renderer"],
		rawDevelop: {
			engine: "adobe",
			denoiseModelDir: "/external/models",
			denoiseCacheDir: "/external/cache",
		},
		smartPreviews: {
			runCancellable: async (s, _operation, _path, _quality, options) => {
				signal = s;
				expect(options?.denoiseAmount).toBe(50);
				if (!options?.denoiseProgress)
					throw new Error("Missing progress counters");
				Atomics.store(options.denoiseProgress, 0, 2);
				Atomics.store(options.denoiseProgress, 1, 40);
				return new Promise((resolve, reject) => {
					finish = resolve;
					s.addEventListener("abort", () => reject(new Error("cancelled")), {
						once: true,
					});
				});
			},
		},
	};
	const app = new Hono().route("/api/v1", createDenoiseRouter(deps));
	const path = `/api/v1/photos/${photo.id}/denoise`;
	const start = () =>
		app.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ amount: 50, revision: 0 }),
		});
	return {
		app,
		path,
		start,
		db,
		photo,
		directory,
		signal: () => signal,
		finish: () =>
			finish({
				data: new Uint8Array([1, 2, 3]),
				engine: "adobe",
				token: "opaque",
			}),
	};
}
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 20));
}
test("Denoise progress, bounded admission, explicit save and old-client guard", async () => {
	const f = fixture();
	const response = await f.start();
	expect(response.status).toBe(202);
	const job = await response.json();
	expect(job.completed).toBe(2);
	expect(job.total).toBe(40);
	expect((await f.start()).status).toBe(503);
	expect(readRawEdit(f.db, f.photo.id, "adobe").revision).toBe(0);
	f.finish();
	await settle();
	expect(
		(await (await f.app.request(`${f.path}/${job.id}`)).json()).status,
	).toBe("complete");
	const preview = await f.app.request(`${f.path}/${job.id}/preview`);
	expect(preview.status).toBe(200);
	expect(preview.headers.get("ETag")).toBe('"opaque"');
	expect(readRawEdit(f.db, f.photo.id, "adobe").revision).toBe(0);
	const settings = {
		...defaultRawEditSettings,
		version: 2 as const,
		denoise: 50,
	};
	saveRawEdit(f.db, f.photo.id, 0, settings, "adobe");
	expect(readRawEdit(f.db, f.photo.id, "adobe").settings).toEqual(settings);
	expect(() =>
		saveRawEdit(f.db, f.photo.id, 1, defaultRawEditSettings, "adobe"),
	).toThrow("RAW_RECIPE_UPGRADE_REQUIRED");
	expect((await f.app.request(`${f.path}/${job.id}/preview`)).status).toBe(409);
});
test("Denoise cancellation never publishes a partial preview", async () => {
	const f = fixture();
	const job = await (await f.start()).json();
	await f.app.request(`${f.path}/${job.id}`, { method: "DELETE" });
	await settle();
	expect(f.signal()?.aborted).toBe(true);
	expect(
		(await (await f.app.request(`${f.path}/${job.id}`)).json()).status,
	).toBe("cancelled");
	expect((await f.app.request(`${f.path}/${job.id}/preview`)).status).toBe(409);
	expect(readRawEdit(f.db, f.photo.id, "adobe").revision).toBe(0);
});
test("Denoise fences source changes and hides file identities", async () => {
	const f = fixture();
	const job = await (await f.start()).json();
	writeFileSync(join(f.directory, f.photo.path), "changed source");
	f.finish();
	await settle();
	const status = await (await f.app.request(`${f.path}/${job.id}`)).json();
	expect(status.status).toBe("failed");
	expect(JSON.stringify(status)).not.toContain(f.directory);
	expect((await f.app.request(`${f.path}/${job.id}/preview`)).status).toBe(409);
	expect((await f.app.request(`${f.path}/missing`)).status).toBe(404);
});
