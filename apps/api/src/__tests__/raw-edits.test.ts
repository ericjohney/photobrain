import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevelopedRawOptions } from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { photoRawEdits, photos } from "../db/schema";
import { createExportsRouter } from "../routes/exports";
import { createRawEditsRouter } from "../routes/raw-edits";
import type { ExportRenderer } from "../services/exports";
import { deletePhotos } from "../services/library-reconciliation";
import {
	defaultRawEditSettings,
	readRawEdit,
	saveRawEdit,
} from "../services/raw-edits";
import { createTestDb } from "./setup";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const { db, sqlite } = createTestDb();
	const dir = mkdtempSync(join(tmpdir(), "pb-raw-edits-"));
	directories.push(dir);
	const photo = db
		.insert(photos)
		.values({
			path: "photo.ARW",
			name: "photo.ARW",
			size: 10,
			createdAt: new Date(),
			modifiedAt: new Date(),
			isRaw: true,
		})
		.returning()
		.get();
	writeFileSync(join(dir, photo.path), "raw");
	const calls: (DevelopedRawOptions | undefined)[] = [];
	const app = new Hono();
	app.route("/api/v1", createRawEditsRouter(db, "adobe"));
	app.route(
		"/api",
		createExportsRouter({
			database: db,
			photoDirectory: dir,
			rawDevelop: { engine: "adobe", adobeProfileDir: "/profiles" },
			renderer: {} as ExportRenderer,
			developer: {
				runCancellable: async (
					_signal,
					_operation,
					_path,
					_quality,
					options,
				) => {
					calls.push(options);
					return {
						jpeg: new Uint8Array([255, 216, 255, 217]),
						width: 300,
						height: 200,
						engine: options?.engine ?? "apple",
					};
				},
			},
		}),
	);
	const path = `/api/v1/photos/${photo.id}/raw-edit`;
	function save(body: unknown) {
		return app.request(path, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}
	return { db, sqlite, app, photo, calls, path, save };
}

describe("nondestructive RAW edits", () => {
	test("saves a versioned recipe, prevents lost updates, and survives media updates", async () => {
		const f = fixture();
		expect(await (await f.app.request(f.path)).json()).toEqual({
			settings: defaultRawEditSettings,
			revision: 0,
			engine: "adobe",
			supportsTone: true,
		});
		const settings = {
			...defaultRawEditSettings,
			exposure: 0.7,
			highlights: -50,
			shadows: 40,
		};
		expect((await f.save({ revision: 0, settings })).status).toBe(200);
		const stale = await f.save({
			revision: 0,
			settings: defaultRawEditSettings,
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			error: { code: "RAW_EDIT_CONFLICT" },
		});
		f.db
			.update(photos)
			.set({ thumbnailKey: "new-generation", size: 20 })
			.where(eq(photos.id, f.photo.id))
			.run();
		expect(readRawEdit(f.db, f.photo.id, "apple")).toEqual({
			settings,
			revision: 1,
			engine: "adobe",
			supportsTone: true,
		});
		// Explicit deletion works even on connections without FK enforcement.
		deletePhotos(f.db, [f.photo.id]);
		expect(f.db.select().from(photoRawEdits).all()).toEqual([]);
		f.sqlite.close();
	});

	test("strict validation rejects unsupported fields, values, revisions and malformed JSON", async () => {
		const f = fixture();
		for (const settings of [
			{ ...defaultRawEditSettings, exposure: 5.01 },
			{ ...defaultRawEditSettings, exposure: 0.001 },
			{ ...defaultRawEditSettings, highlights: 0.5 },
			{ ...defaultRawEditSettings, contrast: -101 },
			{ ...defaultRawEditSettings, version: 2 },
			{ ...defaultRawEditSettings, engine: "adobe" },
		]) {
			expect((await f.save({ revision: 0, settings })).status).toBe(400);
		}
		expect(
			(await f.save({ revision: -1, settings: defaultRawEditSettings })).status,
		).toBe(400);
		expect(
			(await f.app.request(f.path, { method: "PUT", body: "{" })).status,
		).toBe(400);
		const oversized = await f.app.request(f.path, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: " ".repeat(4097),
		});
		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({
			error: { code: "INVALID_REQUEST" },
		});
		expect(f.db.select().from(photoRawEdits).all()).toHaveLength(0);
		f.sqlite.close();
	});

	test("previews do not save; viewing and downloading replay the saved settings at full resolution", async () => {
		const f = fixture();
		const endpoint = `/api/photos/${f.photo.id}/developed`;
		const settings = {
			...defaultRawEditSettings,
			exposure: 1.25,
			contrast: 30,
			shadows: 25,
		};
		for (const refined of [false, true]) {
			const response = await f.app.request(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ settings, refined }),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			expect(f.calls.at(-1)?.maxEdge).toBe(refined ? 2048 : 1024);
			expect(JSON.parse(f.calls.at(-1)?.settingsJson ?? "null")).toMatchObject({
				exposure: 1.25,
				adobe_tone: { contrast: 30, shadows: 25 },
			});
		}
		expect(readRawEdit(f.db, f.photo.id, "adobe").revision).toBe(0);
		await f.save({ settings, revision: 0 });
		const downloaded = await f.app.request(`${endpoint}?download=1`);
		expect(downloaded.status).toBe(200);
		expect(downloaded.headers.get("Content-Disposition")).toContain(
			"photo_developed.jpg",
		);
		expect(f.calls.at(-1)?.maxEdge).toBeUndefined();
		expect(JSON.parse(f.calls.at(-1)?.settingsJson ?? "null").exposure).toBe(
			1.25,
		);
		expect(f.calls.at(-1)?.adobeProfileDir).toBe("/profiles");
		f.sqlite.close();
	});

	test("ProRAW stays Apple and rejects silently ignored tone edits", async () => {
		const f = fixture();
		f.db
			.update(photos)
			.set({ path: "phone.DNG", name: "phone.DNG" })
			.where(eq(photos.id, f.photo.id))
			.run();
		expect(readRawEdit(f.db, f.photo.id, "adobe")).toMatchObject({
			engine: "apple",
			supportsTone: false,
		});
		expect(
			(
				await f.save({
					revision: 0,
					settings: { ...defaultRawEditSettings, contrast: 20 },
				})
			).status,
		).toBe(422);
		expect(
			(
				await f.save({
					revision: 0,
					settings: { ...defaultRawEditSettings, exposure: 1 },
				})
			).status,
		).toBe(200);
		f.sqlite.close();
	});

	test("missing photos and non-RAWs have stable errors; reset is another revision", async () => {
		const f = fixture();
		expect((await f.app.request("/api/v1/photos/999/raw-edit")).status).toBe(
			404,
		);
		saveRawEdit(
			f.db,
			f.photo.id,
			0,
			{ ...defaultRawEditSettings, exposure: 2 },
			"adobe",
		);
		expect(
			(await f.save({ revision: 1, settings: defaultRawEditSettings })).status,
		).toBe(200);
		expect(readRawEdit(f.db, f.photo.id, "adobe").revision).toBe(2);
		f.db
			.update(photos)
			.set({ isRaw: false })
			.where(eq(photos.id, f.photo.id))
			.run();
		expect((await f.app.request(f.path)).status).toBe(422);
		f.sqlite.close();
	});
});
