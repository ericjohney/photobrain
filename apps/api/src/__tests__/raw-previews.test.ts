import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAllThumbnailSizes, getThumbnailPath } from "@photobrain/utils";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { photoPhash, photoRawPreviews, photos, scanJobs } from "../db/schema";
import { createExportsRouter } from "../routes/exports";
import { deletePhotos } from "../services/library-reconciliation";
import { MEDIA_VERSION } from "../services/processing-versions";
import { defaultRawEditSettings, saveRawEdit } from "../services/raw-edits";
import {
	developNextRawPreview,
	getPreviewRevision,
	type PreviewRenderer,
	pendingRawPreviewEmbeddings,
	type RawPreviewConfig,
	rawPreviewConfigKey,
	storedRawPreview,
} from "../services/raw-previews";
import { createScanPlan, sourceIdentity } from "../services/scan-planner";
import { createTestDb } from "./setup";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
async function fixture(paired = false) {
	const { db, sqlite } = createTestDb();
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pb-raw-previews-")));
	cleanup.push(() => {
		sqlite.close();
		rmSync(root, { recursive: true, force: true });
	});
	const config: RawPreviewConfig = {
		photoDirectory: root,
		thumbnailsDirectory: root,
		options: { engine: "adobe" },
	};
	const key = await rawPreviewConfigKey(config);
	async function photo(path: string, raw: boolean) {
		writeFileSync(join(root, path), "original");
		return db
			.insert(photos)
			.values({
				path,
				name: path,
				isRaw: raw,
				rawStatus: raw ? "converted" : null,
				size: 8,
				createdAt: new Date(),
				modifiedAt: new Date(),
				width: 100,
				height: 80,
				sourceRoot: root,
				sourceFingerprint: (await sourceIdentity(join(root, path))).fingerprint,
				thumbnailKey: path,
				thumbnailRoot: root,
				thumbnailStatus: "completed",
				thumbnailUpdatedAt: new Date(1000),
				embeddingStatus: "completed",
			})
			.returning()
			.get();
	}
	const raw = await photo("photo.ARW", true);
	const pair = paired ? await photo("photo.JPG", false) : undefined;
	let calls = 0;
	const render: PreviewRenderer = async (_path, key, root, options) => {
		calls++;
		expect(options.maxEdge).toBeUndefined();
		for (const size of getAllThumbnailSizes()) {
			const path = join(root, getThumbnailPath(key, size));
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "developed");
		}
		writeFileSync(
			join(root, "large", key).replace(/\.[^/.]+$/, ".jpg"),
			"developed-jpeg",
		);
		return { width: 2048, height: 1365, engine: options.engine! };
	};
	return {
		db,
		root,
		raw,
		pair,
		config,
		key,
		render,
		calls: () => calls,
		get: () => db.select().from(photos).where(eq(photos.id, raw.id)).get()!,
		run: (renderer = render, now?: Date) =>
			developNextRawPreview(db, renderer, config, key, now),
	};
}

test("publishes previews and stacked JPEG atomically; replay does no work", async () => {
	const f = await fixture(true);
	expect(getPreviewRevision(f.db)).toEqual({ revision: 0 });
	expect(
		(
			await f.run(async (...args) => {
				expect(f.get().thumbnailKey).toBe(f.raw.thumbnailKey);
				expect(getPreviewRevision(f.db).revision).toBe(0);
				return f.render(...args);
			})
		).kind,
	).toBe("published");
	const raw = f.get();
	expect(raw.thumbnailKey).toStartWith(".versions/");
	const pair = f.db
		.select()
		.from(photos)
		.where(eq(photos.id, f.pair!.id))
		.get()!;
	expect(pair.thumbnailKey).toBe(raw.thumbnailKey);
	expect(raw.sourceFingerprint).toBe(f.raw.sourceFingerprint);
	expect(raw.thumbnailUpdatedAt!.getTime()).toBeGreaterThan(
		f.raw.thumbnailUpdatedAt!.getTime(),
	);
	expect(pendingRawPreviewEmbeddings(f.db).map((p) => p.id)).toEqual([
		raw.id,
		pair.id,
	]);
	expect(getPreviewRevision(f.db).revision).toBe(1);
	expect(storedRawPreview(f.db, raw.id, f.root)?.contentType).toBe(
		"image/jpeg",
	);
	expect((await f.run()).kind).toBe("idle");
	expect(f.calls()).toBe(1);
});

test("saved edits invalidate previews, including edits during development", async () => {
	const f = await fixture();
	await f.run();
	const previousKey = f.get().thumbnailKey;
	saveRawEdit(
		f.db,
		f.raw.id,
		0,
		{ ...defaultRawEditSettings, exposure: 1 },
		"adobe",
	);
	expect(
		(
			await f.run(async (...args) => {
				saveRawEdit(
					f.db,
					f.raw.id,
					1,
					{ ...defaultRawEditSettings, exposure: 2 },
					"adobe",
				);
				return f.render(...args);
			})
		).kind,
	).toBe("stale");
	expect(f.get().thumbnailKey).toBe(previousKey);
	expect((await f.run()).kind).toBe("published");
	expect(f.db.select().from(photoRawPreviews).get()?.recipeRevision).toBe(2);
});

test.each([
	"reimport",
	"delete",
	"source change",
	"pair reimport",
	"root change",
])("rejects a result after %s", async (mode) => {
	const f = await fixture(mode === "pair reimport");
	await f.run(async (...args) => {
		if (mode === "delete") deletePhotos(f.db, [f.raw.id]);
		else if (mode === "source change")
			writeFileSync(join(f.root, f.raw.path), "changed-source");
		else if (mode === "root change")
			f.db
				.update(photos)
				.set({ thumbnailRoot: "/new-root" })
				.where(eq(photos.id, f.raw.id))
				.run();
		else
			f.db
				.update(photos)
				.set({ thumbnailKey: "new-import" })
				.where(eq(photos.id, mode === "pair reimport" ? f.pair!.id : f.raw.id))
				.run();
		return f.render(...args);
	});
	expect(getPreviewRevision(f.db).revision).toBe(0);
	expect(f.db.select().from(photoRawPreviews).get()?.status).not.toBe(
		"completed",
	);
});

test("failure retains first-pass preview with bounded retries; deletion clears receipt", async () => {
	const f = await fixture();
	const fail: PreviewRenderer = async () => {
		throw Error("Unsupported camera");
	};
	const now = Date.now();
	for (let attempt = 0; attempt < 3; attempt++) {
		expect((await f.run(fail, new Date(now + attempt * 3601_000))).kind).toBe(
			"failed",
		);
		expect((await f.run(fail, new Date(now + attempt * 3601_000))).kind).toBe(
			"idle",
		);
	}
	expect((await f.run(fail, new Date(now + 9 * 3601_000))).kind).toBe("idle");
	expect(f.get().thumbnailKey).toBe(f.raw.thumbnailKey);
	expect(getPreviewRevision(f.db).revision).toBe(0);
	expect(storedRawPreview(f.db, f.raw.id, f.root)?.contentType).toBe(
		"image/webp",
	);
	deletePhotos(f.db, [f.raw.id]);
	expect(f.db.select().from(photoRawPreviews).all()).toEqual([]);
});

test("incomplete artifact sets never replace the first pass", async () => {
	const f = await fixture();
	expect(
		(
			await f.run(async (...args) => {
				const result = await f.render(...args);
				rmSync(join(args[2], getThumbnailPath(args[1], "tiny")));
				return result;
			})
		).kind,
	).toBe("failed");
	expect(f.get().thumbnailKey).toBe(f.raw.thumbnailKey);
});

test("viewer GET reads stored files; full-resolution download still renders", async () => {
	const f = await fixture();
	await f.run();
	let calls = 0;
	const app = new Hono().route(
		"/api",
		createExportsRouter({
			database: f.db,
			photoDirectory: f.root,
			storedPreviews: { thumbnailsDirectory: f.root },
			renderer: {
				run: async () => new Uint8Array(),
				runWhenAdmitted: async () => new Uint8Array(),
			},
			developer: {
				runCancellable: async () => {
					calls++;
					return {
						jpeg: new Uint8Array([1]),
						width: 4000,
						height: 3000,
						engine: "adobe",
					};
				},
			},
		}),
	);
	const response = await app.request(`/api/photos/${f.raw.id}/developed`);
	expect(await response.text()).toBe("developed-jpeg");
	expect(response.headers.get("X-Developed-Width")).toBe("2048");
	expect(calls).toBe(0);
	expect(
		(await app.request(`/api/photos/${f.raw.id}/developed?download=1`)).status,
	).toBe(200);
	expect(calls).toBe(1);
});

test.each([
	"queued",
	"processing",
	"embedding",
])("defers during %s import jobs", async (phase) => {
	const f = await fixture();
	f.db
		.insert(scanJobs)
		.values({
			id: "active",
			phase,
			status: phase === "queued" ? "queued" : "running",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	expect((await f.run()).kind).toBe("paused");
	expect(f.calls()).toBe(0);
	f.db.update(scanJobs).set({ status: "completed" }).run();
	expect((await f.run()).kind).toBe("published");
});

test("a scan starting during development prevents publication", async () => {
	const f = await fixture();
	expect(
		(
			await f.run(async (...args) => {
				f.db
					.insert(scanJobs)
					.values({
						id: "active",
						status: "queued",
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.run();
				return f.render(...args);
			})
		).kind,
	).toBe("stale");
	expect(f.get().thumbnailKey).toBe(f.raw.thumbnailKey);
	expect(getPreviewRevision(f.db).revision).toBe(0);
	f.db.update(scanJobs).set({ status: "failed" }).run();
	expect((await f.run()).kind).toBe("published");
});

test("incremental imports reuse the developed RAW and paired generations", async () => {
	const f = await fixture(true);
	for (const photo of [f.raw, f.pair!]) {
		f.db
			.update(photos)
			.set({ mediaVersion: MEDIA_VERSION, phashStatus: "completed" })
			.where(eq(photos.id, photo.id))
			.run();
		f.db
			.insert(photoPhash)
			.values({ photoId: photo.id, hash: "1234567890", createdAt: new Date() })
			.run();
	}
	await f.run();
	const paths = [f.raw.path, f.pair!.path];
	const plan = await createScanPlan(
		f.db,
		{
			filePaths: paths.map((path) => join(f.root, path)),
			relativePaths: paths,
		},
		f.root,
		f.root,
	);
	expect(plan.items.map((item) => item.action)).toEqual(["reuse", "reuse"]);
	expect(plan.items.map((item) => item.thumbnailKey)).toEqual([
		f.get().thumbnailKey,
		f.get().thumbnailKey,
	]);
});

test("failed indexing remains eligible for background recovery", async () => {
	const f = await fixture();
	await f.run();
	f.db
		.update(photos)
		.set({ embeddingStatus: "failed" })
		.where(eq(photos.id, f.raw.id))
		.run();
	expect(pendingRawPreviewEmbeddings(f.db).map((photo) => photo.id)).toEqual([
		f.raw.id,
	]);
	f.db
		.update(photos)
		.set({ embeddingStatus: "completed" })
		.where(eq(photos.id, f.raw.id))
		.run();
	expect(pendingRawPreviewEmbeddings(f.db)).toEqual([]);
});
