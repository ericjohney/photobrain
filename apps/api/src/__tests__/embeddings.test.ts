import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import * as sqliteVec from "sqlite-vec";
import {
	photoEmbedding,
	photoExif,
	photoPhash,
	photos,
	scanJobs,
} from "../db/schema";
import { saveEmbeddingBatch } from "../services/import-persistence";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

type Progress = { phase: string; current: number; total: number };
type Context = {
	event: { data: { photoIds: number[]; thumbnailsDir: string; jobId: string } };
	step: { run<T>(id: string, work: () => T | Promise<T>): Promise<T> };
	publish(message: { data: Progress }): Promise<void>;
};
type EmbeddingFunction = {
	handler(context: Context): Promise<{ processed: number; successful: number }>;
};

// Isolate process-wide Bun mocks from router and native-executor suites.
if (process.env.PHOTOBRAIN_EMBEDDING_TEST_CHILD !== "1") {
	test("embedding generations, search eligibility and checkpoint budget", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_EMBEDDING_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
	}, 30_000);
} else {
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);
	const jobId = "embedding-test";
	let inferencePaths: string[][] = [];
	let infer: (paths: string[]) => (number[] | null)[] = (paths) =>
		paths.map(() => [1, 0]);

	mock.module("../db", () => ({ db }));
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => [1, 0],
	}));
	mock.module("../services/native-executor", () => ({
		nativeExecutor: {
			run: async (_operation: string, paths: string[]) => {
				inferencePaths.push(paths);
				return infer(paths);
			},
		},
	}));
	mock.module("../inngest/client", () => ({
		inngest: {
			createFunction: (
				_options: unknown,
				_trigger: unknown,
				handler: EmbeddingFunction["handler"],
			) => ({ handler }),
		},
	}));
	// Static imports would initialize the production database/native dependencies
	// before this isolated module-loading boundary installs the test mocks.
	const { generateEmbeddingsFunction } = await import(
		"../inngest/functions/embeddings"
	);
	const embedding = generateEmbeddingsFunction as unknown as EmbeddingFunction;
	const { findSimilarPhotos } = await import("../services/vector-search");

	beforeEach(() => {
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photoPhash).run();
		db.delete(photos).run();
		db.delete(scanJobs).run();
		db.insert(scanJobs)
			.values({
				id: jobId,
				createdAt: new Date(0),
				updatedAt: new Date(0),
				status: "running",
				phase: "scan-complete",
				current: 0,
				total: 0,
			})
			.run();
		inferencePaths = [];
		infer = (paths) => paths.map(() => [1, 0]);
	});
	afterAll(() => sqlite.close());

	function addPhoto(
		path: string,
		thumbnailKey: string | null = null,
		thumbnailRoot: string | null = null,
	) {
		return db
			.insert(photos)
			.values({
				path,
				name: path,
				size: 100,
				createdAt: new Date(0),
				modifiedAt: new Date(0),
				thumbnailKey,
				thumbnailRoot,
				embeddingStatus: "pending",
			})
			.returning()
			.get();
	}

	function harness(photoIds: number[], thumbnailsDir = "/thumbs") {
		const checkpoints = new Map<string, unknown>();
		const published: Progress[] = [];
		let depth = 0;
		let publicationCheckpoints = 0;
		const controls = { loseBatchCheckpoint: false, failPublication: false };
		const context: Context = {
			event: { data: { photoIds, thumbnailsDir, jobId } },
			step: {
				async run<T>(id: string, work: () => T | Promise<T>): Promise<T> {
					if (depth !== 0) throw new Error("Nested step.run");
					if (checkpoints.has(id)) return checkpoints.get(id) as T;
					depth++;
					try {
						const value = await work();
						if (controls.loseBatchCheckpoint && inferencePaths.length > 0) {
							controls.loseBatchCheckpoint = false;
							throw new Error("Lost batch checkpoint");
						}
						checkpoints.set(id, structuredClone(value));
						return value;
					} finally {
						depth--;
					}
				},
			},
			async publish({ data }) {
				// Inngest publications outside a running step consume a checkpoint.
				if (depth === 0) publicationCheckpoints++;
				if (controls.failPublication) throw new Error("Realtime unavailable");
				published.push(data);
			},
		};
		return {
			controls,
			published,
			run: () => embedding.handler(context),
			checkpointCount: () => checkpoints.size + publicationCheckpoints,
		};
	}

	test("in-flight results use immutable thumbnail paths and cannot replace a new generation", async () => {
		const versioned = addPhoto("trip/photo.jpg", ".versions/old/photo.jpg");
		const legacy = addPhoto("legacy.jpg");
		infer = (paths) => {
			db.update(photos)
				.set({ thumbnailKey: ".versions/new/photo.jpg" })
				.where(eq(photos.id, versioned.id))
				.run();
			saveEmbeddingBatch(
				db,
				[{ id: versioned.id, thumbnailKey: ".versions/new/photo.jpg" }],
				[[0, 1]],
			);
			return paths.map(() => [1, 0]);
		};
		const run = harness([versioned.id, legacy.id]);
		expect(await run.run()).toEqual({ processed: 2, successful: 1 });
		expect(inferencePaths).toEqual([
			["/thumbs/large/.versions/old/photo.webp", "/thumbs/large/legacy.webp"],
		]);
		expect(
			db
				.select()
				.from(photoEmbedding)
				.where(eq(photoEmbedding.photoId, versioned.id))
				.get(),
		).toMatchObject({
			thumbnailKey: ".versions/new/photo.jpg",
			embedding: Buffer.from(new Float32Array([0, 1]).buffer),
		});
		expect(
			db.select().from(photos).where(eq(photos.id, versioned.id)).get()
				?.embeddingStatus,
		).toBe("completed");
		expect(run.published.at(-1)).toEqual({
			phase: "completed",
			current: 2,
			total: 2,
		});
	});

	test("an old event uses the newer generation's committed root instead of failing its current vector", async () => {
		const photo = addPhoto(
			"moved.jpg",
			".versions/current/moved.jpg",
			"/root-b",
		);
		saveEmbeddingBatch(db, [photo], [[0, 1]]);
		infer = (paths) =>
			paths.map((path) =>
				path === "/root-b/large/.versions/current/moved.webp" ? [0, 1] : null,
			);
		const run = harness([photo.id], "/root-a");
		expect(await run.run()).toEqual({ processed: 1, successful: 1 });
		expect(inferencePaths).toEqual([
			["/root-b/large/.versions/current/moved.webp"],
		]);
		expect(
			db.select().from(photos).where(eq(photos.id, photo.id)).get(),
		).toMatchObject({
			thumbnailRoot: "/root-b",
			embeddingStatus: "completed",
		});
		expect(
			(await findSimilarPhotos([0, 1])).map((result) => result.id),
		).toEqual([photo.id]);
		expect(run.published.at(-1)).toEqual({
			phase: "completed",
			current: 1,
			total: 1,
		});
	});

	test("lost checkpoint replay retains captured generation and cannot overwrite replacement", async () => {
		const photo = addPhoto("replay.jpg", ".versions/old/replay.jpg");
		const run = harness([photo.id]);
		run.controls.loseBatchCheckpoint = true;
		await expect(run.run()).rejects.toThrow("Lost batch checkpoint");
		db.update(photos)
			.set({ thumbnailKey: ".versions/new/replay.jpg" })
			.where(eq(photos.id, photo.id))
			.run();
		saveEmbeddingBatch(
			db,
			[{ id: photo.id, thumbnailKey: ".versions/new/replay.jpg" }],
			[[0, 1]],
		);
		expect(await run.run()).toEqual({ processed: 1, successful: 0 });
		expect(inferencePaths).toEqual([
			["/thumbs/large/.versions/old/replay.webp"],
			["/thumbs/large/.versions/old/replay.webp"],
		]);
		expect(db.select().from(photoEmbedding).get()).toMatchObject({
			thumbnailKey: ".versions/new/replay.jpg",
			embedding: Buffer.from(new Float32Array([0, 1]).buffer),
		});
	});

	test("failed inference hides retained vectors and still persists terminal progress when Realtime fails", async () => {
		const photo = addPhoto("failed.jpg");
		saveEmbeddingBatch(db, [photo], [[1, 0]]);
		infer = () => [null];
		const run = harness([photo.id]);
		run.controls.failPublication = true;
		expect(await run.run()).toEqual({ processed: 1, successful: 0 });
		expect(db.select().from(scanJobs).get()).toMatchObject({
			status: "failed",
			current: 1,
			total: 1,
		});
		expect(db.select().from(photoEmbedding).get()?.embedding).toEqual(
			Buffer.from(new Float32Array([1, 0]).buffer),
		);
		expect(await findSimilarPhotos([1, 0])).toEqual([]);
	});

	test("terminal jobs do not start inference or change state", async () => {
		const photo = addPhoto("terminal.jpg");
		db.update(scanJobs).set({ status: "completed", phase: "completed" }).run();
		const run = harness([photo.id]);
		expect(await run.run()).toEqual({ processed: 0, successful: 0 });
		expect(inferencePaths).toEqual([]);
		expect(run.published).toEqual([]);
		expect(db.select().from(scanJobs).get()?.status).toBe("completed");
	});

	test("7,961 photos complete within the 1,000 checkpoint ceiling", async () => {
		const ids = db.transaction(() =>
			Array.from(
				{ length: 7_961 },
				(_, index) =>
					addPhoto(`library/${index}.jpg`, `.versions/${index}/photo.jpg`).id,
			),
		);
		const run = harness(ids);
		expect(await run.run()).toEqual({ processed: 7_961, successful: 7_961 });
		expect(run.checkpointCount()).toBeLessThan(1_000);
		expect(run.published.at(-1)).toEqual({
			phase: "completed",
			current: 7_961,
			total: 7_961,
		});
		expect(db.select().from(scanJobs).get()).toMatchObject({
			status: "completed",
			current: 7_961,
			total: 7_961,
		});
	}, 20_000);

	test("search filters missing, failed, pending, outdated and mismatched vectors before limiting", async () => {
		const current = addPhoto("current.jpg", ".versions/current/photo.jpg");
		const legacy = addPhoto("legacy.jpg");
		saveEmbeddingBatch(
			db,
			[current, legacy],
			[
				[0.8, 0.2],
				[0.7, 0.3],
			],
		);
		for (const entry of [
			{
				path: "failed.jpg",
				status: "failed",
				photoKey: null,
				vectorKey: null,
				model: EMBEDDING_MODEL_VERSION,
			},
			{
				path: "pending.jpg",
				status: "pending",
				photoKey: null,
				vectorKey: null,
				model: EMBEDDING_MODEL_VERSION,
			},
			{
				path: "outdated.jpg",
				status: "completed",
				photoKey: null,
				vectorKey: null,
				model: "old-model",
			},
			{
				path: "changed.jpg",
				status: "completed",
				photoKey: "new",
				vectorKey: "old",
				model: EMBEDDING_MODEL_VERSION,
			},
			{
				path: "upgraded.jpg",
				status: "completed",
				photoKey: "new",
				vectorKey: null,
				model: EMBEDDING_MODEL_VERSION,
			},
			{
				path: "reset.jpg",
				status: "completed",
				photoKey: null,
				vectorKey: "old",
				model: EMBEDDING_MODEL_VERSION,
			},
		]) {
			const photo = addPhoto(entry.path, entry.photoKey);
			db.update(photos)
				.set({ embeddingStatus: entry.status })
				.where(eq(photos.id, photo.id))
				.run();
			db.insert(photoEmbedding)
				.values({
					photoId: photo.id,
					embedding: Buffer.from(new Float32Array([1, 0]).buffer),
					modelVersion: entry.model,
					thumbnailKey: entry.vectorKey,
					createdAt: new Date(0),
				})
				.run();
		}
		const missing = addPhoto("missing.jpg");
		db.update(photos)
			.set({ embeddingStatus: "completed" })
			.where(eq(photos.id, missing.id))
			.run();
		expect(
			(await findSimilarPhotos([1, 0], 2)).map((photo) => photo.id),
		).toEqual([current.id, legacy.id]);
	});
}
