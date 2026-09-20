import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { getAllThumbnailSizes, getThumbnailPath } from "@photobrain/utils";
import { eq } from "drizzle-orm";
import type { db } from "../db";
import {
	photoEmbedding,
	photoExif,
	photoPhash,
	photos,
	scanItems,
	scanJobs,
} from "../db/schema";
import {
	saveEmbeddingBatch,
	saveScanBatch,
} from "../services/import-persistence";
import type { PhotoStreamInput } from "../services/native-executor";
import { createTestDb } from "./setup";

// Bun module mocks are process-wide. Keep native validation isolated from other suites.
if (process.env.PHOTOBRAIN_PLANNER_TEST_CHILD !== "1") {
	test("incremental planning preserves committed files and fences stale generations", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_PLANNER_TEST_CHILD: "1" },
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
	let database: { db: typeof db; sqlite: Database };
	let root: string;
	let sourceRoot: string;
	let thumbnailsRoot: string;
	let validationCalls: string[][];
	let validLegacy: boolean;
	let duringValidation: () => void;

	mock.module("../services/native-executor", () => ({
		nativeExecutor: {
			run: async (
				operation: string,
				inputs: { path: string }[],
				destination: string,
			) => {
				if (operation !== "validateThumbnails")
					throw new Error(`Unexpected native operation: ${operation}`);
				expect(destination).toBe(thumbnailsRoot);
				validationCalls.push(inputs.map((input) => input.path));
				duringValidation();
				return inputs.map(() => validLegacy);
			},
		},
	}));
	// Static imports would initialize the native executor before this isolated mock.
	const { createScanPlan } = await import("../services/scan-planner");
	const {
		clearScanWork,
		commitScanResult,
		getScanWorkProgress,
		initializeScanWork,
		pendingScanWork,
		scanEmbeddingPhotoIds,
	} = await import("../services/scan-work");

	beforeEach(() => {
		database = createTestDb();
		root = mkdtempSync(join(tmpdir(), "photobrain-planner-"));
		sourceRoot = join(root, "sources");
		thumbnailsRoot = join(root, "thumbnails");
		mkdirSync(sourceRoot);
		mkdirSync(thumbnailsRoot);
		validationCalls = [];
		validLegacy = true;
		duringValidation = () => {};
	});
	afterEach(() => {
		database.sqlite.close();
		rmSync(root, { recursive: true, force: true });
	});

	function source(path = "photo.jpg") {
		const file = join(sourceRoot, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, "original source");
		utimesSync(file, 1_700_000_000.125, 1_700_000_000.125);
		return file;
	}

	function result(path = "photo.jpg"): PhotoProcessingResult {
		const metadata = statSync(join(sourceRoot, path));
		return {
			success: true,
			path,
			name: path,
			size: metadata.size,
			createdAt: metadata.birthtimeMs,
			modifiedAt: metadata.mtimeMs,
			width: 100,
			height: 80,
			mimeType: "image/jpeg",
			isRaw: false,
			exif: { cameraMake: "Planner fixture" },
			phash: "YWJjZA==",
		};
	}

	function artifacts(key: string) {
		for (const size of getAllThumbnailSizes()) {
			const file = join(thumbnailsRoot, getThumbnailPath(key, size));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `${key}:${size}`);
		}
	}

	function snapshot(key: string) {
		return getAllThumbnailSizes().map((size) => {
			const file = join(thumbnailsRoot, getThumbnailPath(key, size));
			const bytes = readFileSync(file);
			const metadata = statSync(file, { bigint: true });
			return {
				bytes,
				size: metadata.size,
				mtime: metadata.mtimeNs,
				ctime: metadata.ctimeNs,
			};
		});
	}

	async function plan(
		paths = ["photo.jpg"],
		force = false,
		directory = sourceRoot,
		destination = thumbnailsRoot,
	) {
		return createScanPlan(
			database.db,
			{
				filePaths: paths.map((path) => join(directory, path)),
				relativePaths: paths,
			},
			directory,
			destination,
			force,
		);
	}

	async function start(paths = ["photo.jpg"], force = false) {
		const jobId = crypto.randomUUID();
		database.db
			.insert(scanJobs)
			.values({ id: jobId, createdAt: new Date(), updatedAt: new Date() })
			.run();
		initializeScanWork(database.db, jobId, await plan(paths, force));
		return jobId;
	}

	async function finish(jobId: string, input: PhotoStreamInput) {
		if (!input.thumbnailKey) throw new Error("Missing attempt thumbnail key");
		artifacts(input.thumbnailKey);
		return commitScanResult(
			database.db,
			jobId,
			input.id,
			result(input.relativePath),
			input.thumbnailKey,
		);
	}

	async function seed(embedded = true) {
		source();
		const jobId = await start();
		const [input] = pendingScanWork(database.db, jobId);
		expect(await finish(jobId, input)).toMatchObject({
			successful: 1,
			committed: true,
		});
		const photo = database.db.select().from(photos).get();
		if (!photo?.thumbnailKey) throw new Error("Expected committed generation");
		if (embedded)
			saveEmbeddingBatch(
				database.db,
				[{ id: photo.id, thumbnailKey: photo.thumbnailKey }],
				[Array(512).fill(0.25)],
			);
		clearScanWork(database.db, jobId);
		return { ...photo, thumbnailKey: photo.thumbnailKey };
	}

	function legacy() {
		source();
		const [id] = saveScanBatch(database.db, [result()]);
		artifacts("photo.jpg");
		// Explicit ordering avoids filesystem timestamp-resolution races in adoption.
		const generatedAt =
			Math.ceil(statSync(join(sourceRoot, "photo.jpg")).ctimeMs / 1000) + 1;
		for (const size of getAllThumbnailSizes()) {
			utimesSync(
				join(thumbnailsRoot, getThumbnailPath("photo.jpg", size)),
				generatedAt,
				generatedAt,
			);
		}
		saveEmbeddingBatch(
			database.db,
			[{ id, thumbnailKey: null }],
			[Array(512).fill(0.25)],
		);
		return id;
	}

	test("unchanged media and vectors skip work without touching rows, cache keys, sidecars or files", async () => {
		const photo = await seed();
		const before = database.db.select().from(photos).get();
		const files = snapshot(photo.thumbnailKey);
		const vector = database.db.select().from(photoEmbedding).get();
		const exif = database.db.select().from(photoExif).get();
		const phash = database.db.select().from(photoPhash).get();
		const jobId = await start();
		expect(getScanWorkProgress(database.db, jobId)).toEqual({
			total: 1,
			processed: 1,
			successful: 1,
			pending: 0,
		});
		expect(pendingScanWork(database.db, jobId)).toEqual([]);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
		expect(database.db.select().from(photos).get()).toEqual(before);
		expect(database.db.select().from(photoEmbedding).get()).toEqual(vector);
		expect(database.db.select().from(photoExif).get()).toEqual(exif);
		expect(database.db.select().from(photoPhash).get()).toEqual(phash);
		expect(snapshot(photo.thumbnailKey)).toEqual(files);
		expect(validationCalls).toEqual([]);
	});

	test.each([
		"missing",
		"failed",
		"wrong-generation",
		"wrong-model",
		"truncated",
	])("recovers %s embeddings without scheduling media", async (reason) => {
		const photo = await seed();
		const before = database.db.select().from(photos).get();
		if (!before) throw new Error("Expected seeded photo");
		const files = snapshot(photo.thumbnailKey);
		if (reason === "missing") database.db.delete(photoEmbedding).run();
		if (reason === "failed")
			database.db.update(photos).set({ embeddingStatus: "failed" }).run();
		if (reason === "wrong-generation")
			database.db
				.update(photoEmbedding)
				.set({ thumbnailKey: "older.image" })
				.run();
		if (reason === "wrong-model")
			database.db
				.update(photoEmbedding)
				.set({ modelVersion: "obsolete-model" })
				.run();
		if (reason === "truncated")
			database.db
				.update(photoEmbedding)
				.set({ embedding: Buffer.alloc(4) })
				.run();
		const jobId = await start();
		expect(pendingScanWork(database.db, jobId)).toEqual([]);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([photo.id]);
		expect(database.db.select().from(photos).get()).toEqual({
			...before,
			embeddingStatus: "pending",
		});
		expect(snapshot(photo.thumbnailKey)).toEqual(files);
	});

	test("adopts validated unambiguous legacy files and their vector without re-encoding or cache invalidation", async () => {
		const id = legacy();
		const before = database.db.select().from(photos).get();
		const vector = database.db.select().from(photoEmbedding).get();
		if (!before || !vector) throw new Error("Expected legacy photo and vector");
		const files = snapshot("photo.jpg");
		const jobId = await start();
		expect(validationCalls).toEqual([["photo.jpg"]]);
		expect(pendingScanWork(database.db, jobId)).toEqual([]);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
		const adopted = database.db.select().from(photos).get();
		expect(adopted).toMatchObject({
			id,
			thumbnailKey: "photo.jpg",
			thumbnailRoot: thumbnailsRoot,
			thumbnailUpdatedAt: before?.thumbnailUpdatedAt,
			embeddingStatus: "completed",
		});
		expect(database.db.select().from(photoEmbedding).get()).toEqual({
			...vector,
			thumbnailKey: "photo.jpg",
		});
		expect(snapshot("photo.jpg")).toEqual(files);
		const next = await start();
		expect(pendingScanWork(database.db, next)).toEqual([]);
		expect(scanEmbeddingPhotoIds(database.db, next)).toEqual([]);
		expect(validationCalls).toEqual([["photo.jpg"]]);
	});

	test.each([
		"collision",
		"mixed-case-collision",
		"metadata",
		"decode",
		"validation-race",
	])("does not adopt unsafe legacy artifacts: %s", async (reason) => {
		legacy();
		const before = database.db.select().from(photos).get();
		if (!before) throw new Error("Expected legacy photo");
		let paths = ["photo.jpg"];
		if (reason === "collision" || reason === "mixed-case-collision") {
			const otherPath = reason === "collision" ? "photo.png" : "PHOTO.png";
			source(otherPath);
			paths = ["photo.jpg", otherPath];
		}
		if (reason === "metadata")
			database.db.update(photos).set({ size: 999 }).run();
		if (reason === "decode") validLegacy = false;
		if (reason === "validation-race")
			duringValidation = () =>
				writeFileSync(
					join(sourceRoot, "photo.jpg"),
					"changed during validation",
				);
		const jobId = await start(paths);
		expect(
			pendingScanWork(database.db, jobId)
				.map((input) => input.relativePath)
				.sort(),
		).toEqual([...paths].sort());
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
		expect(database.db.select().from(photos).get()).toEqual(
			reason === "metadata" ? { ...before, size: 999 } : before,
		);
	});

	test("legacy source changes after artifact generation cannot reuse matching size and whole-second mtime", async () => {
		legacy();
		const before = database.db.select().from(photos).get();
		if (!before) throw new Error("Expected legacy photo");
		for (const size of getAllThumbnailSizes()) {
			const file = join(thumbnailsRoot, getThumbnailPath("photo.jpg", size));
			utimesSync(file, 1_700_000_001, 1_700_000_001);
		}
		const file = join(sourceRoot, "photo.jpg");
		writeFileSync(file, "modified source");
		utimesSync(file, 1_700_000_000.875, 1_700_000_000.875);
		const metadata = statSync(file);
		expect(metadata.size).toBe(before.size);
		expect(Math.floor(metadata.mtimeMs / 1000)).toBe(
			before.modifiedAt.getTime() / 1000,
		);
		const files = snapshot("photo.jpg");
		const jobId = await start();
		expect(
			pendingScanWork(database.db, jobId).map((input) => input.relativePath),
		).toEqual(["photo.jpg"]);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
		expect(database.db.select().from(photos).get()).toEqual(before);
		expect(snapshot("photo.jpg")).toEqual(files);
		expect(validationCalls).toEqual([]);
	});

	test("same-size source modifications within one stored timestamp second require new media", async () => {
		const photo = await seed();
		const file = join(sourceRoot, "photo.jpg");
		const before = statSync(file);
		writeFileSync(file, "modified source");
		utimesSync(file, 1_700_000_000.875, 1_700_000_000.875);
		const after = statSync(file);
		expect(after.size).toBe(before.size);
		expect(Math.floor(after.mtimeMs / 1000)).toBe(
			Math.floor(before.mtimeMs / 1000),
		);
		const jobId = await start();
		const [input] = pendingScanWork(database.db, jobId);
		expect(input.relativePath).toBe("photo.jpg");
		expect(await finish(jobId, input)).toMatchObject({ successful: 1 });
		const updated = database.db.select().from(photos).get();
		expect(updated?.id).toBe(photo.id);
		expect(updated?.thumbnailKey).not.toBe(photo.thumbnailKey);
		expect(updated?.sourceFingerprint).not.toBe(photo.sourceFingerprint);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([photo.id]);
	});

	test.each([
		"missing",
		"changed",
	])("repairs %s artifacts rather than skipping otherwise unchanged media", async (reason) => {
		const photo = await seed();
		const file = join(
			thumbnailsRoot,
			getThumbnailPath(photo.thumbnailKey, "small"),
		);
		if (reason === "missing") rmSync(file);
		else writeFileSync(file, "externally replaced artifact");
		const jobId = await start();
		const [input] = pendingScanWork(database.db, jobId);
		expect(input.relativePath).toBe("photo.jpg");
		expect(await finish(jobId, input)).toMatchObject({ successful: 1 });
		expect(database.db.select().from(photos).get()?.thumbnailKey).not.toBe(
			photo.thumbnailKey,
		);
	});

	test.each([
		"source",
		"thumbnails",
	])("changing the %s root invalidates reuse", async (kind) => {
		await seed();
		const moved = join(root, "moved");
		cpSync(kind === "source" ? sourceRoot : thumbnailsRoot, moved, {
			recursive: true,
			preserveTimestamps: true,
		});
		const planned = await plan(
			["photo.jpg"],
			false,
			kind === "source" ? moved : sourceRoot,
			kind === "thumbnails" ? moved : thumbnailsRoot,
		);
		expect(planned.items.map((item) => item.action)).toEqual(["media"]);
	});

	test("a recorded thumbnail root mismatch requires repair even when artifact fingerprints match", async () => {
		const photo = await seed();
		database.db
			.update(photos)
			.set({ thumbnailRoot: join(root, "previous-thumbnails") })
			.run();
		const files = snapshot(photo.thumbnailKey);
		const jobId = await start();
		expect(
			pendingScanWork(database.db, jobId).map((input) => input.relativePath),
		).toEqual(["photo.jpg"]);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
		expect(snapshot(photo.thumbnailKey)).toEqual(files);
	});

	test("force allocates new artifacts and preserves the committed generation until replacement succeeds", async () => {
		const photo = await seed();
		const before = database.db.select().from(photos).get();
		const files = snapshot(photo.thumbnailKey);
		const jobId = await start(["photo.jpg"], true);
		const [input] = pendingScanWork(database.db, jobId);
		expect(input.thumbnailKey).not.toBe(photo.thumbnailKey);
		expect(database.db.select().from(photos).get()).toEqual(before);
		expect(await finish(jobId, input)).toMatchObject({ successful: 1 });
		expect(database.db.select().from(photos).get()?.thumbnailKey).toBe(
			input.thumbnailKey,
		);
		expect(snapshot(photo.thumbnailKey)).toEqual(files);
	});

	test("a superseded attempt cannot commit or overwrite the replacement attempt's files", async () => {
		source();
		const jobId = await start();
		const [stale] = pendingScanWork(database.db, jobId);
		const [current] = pendingScanWork(database.db, jobId);
		expect(stale.thumbnailKey).not.toBe(current.thumbnailKey);
		expect(await finish(jobId, stale)).toMatchObject({
			processed: 0,
			committed: false,
		});
		expect(database.db.select().from(photos).all()).toEqual([]);
		expect(await finish(jobId, current)).toMatchObject({
			processed: 1,
			successful: 1,
			committed: true,
		});
		const photo = database.db.select().from(photos).get();
		const files = snapshot(current.thumbnailKey ?? "");
		expect(await finish(jobId, stale)).toMatchObject({
			processed: 1,
			successful: 1,
			committed: false,
		});
		expect(database.db.select().from(photos).get()).toEqual(photo);
		expect(snapshot(current.thumbnailKey ?? "")).toEqual(files);
	});

	test("a late scan cannot replace a newer committed generation or schedule embeddings for it", async () => {
		const photo = await seed();
		const oldJob = await start(["photo.jpg"], true);
		const [stale] = pendingScanWork(database.db, oldJob);
		const newJob = await start(["photo.jpg"], true);
		const [current] = pendingScanWork(database.db, newJob);
		expect(await finish(newJob, current)).toMatchObject({ successful: 1 });
		const before = database.db.select().from(photos).get();
		const files = snapshot(current.thumbnailKey ?? "");
		expect(await finish(oldJob, stale)).toMatchObject({
			processed: 1,
			successful: 0,
		});
		expect(database.db.select().from(photos).get()).toEqual(before);
		expect(snapshot(current.thumbnailKey ?? "")).toEqual(files);
		expect(scanEmbeddingPhotoIds(database.db, oldJob)).toEqual([]);
		expect(scanEmbeddingPhotoIds(database.db, newJob)).toEqual([photo.id]);
	});

	test("source changes during processing fail the receipt and preserve the last usable generation", async () => {
		const photo = await seed();
		const before = database.db.select().from(photos).get();
		const files = snapshot(photo.thumbnailKey);
		const jobId = await start(["photo.jpg"], true);
		const [input] = pendingScanWork(database.db, jobId);
		writeFileSync(join(sourceRoot, "photo.jpg"), "changed after planning");
		expect(await finish(jobId, input)).toMatchObject({
			processed: 1,
			successful: 0,
			committed: true,
		});
		expect(
			database.db
				.select()
				.from(scanItems)
				.where(eq(scanItems.jobId, jobId))
				.get()?.status,
		).toBe("failed");
		expect(database.db.select().from(photos).get()).toEqual(before);
		expect(snapshot(photo.thumbnailKey)).toEqual(files);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
	});

	test("native success with incomplete artifacts fails without replacing usable media", async () => {
		const photo = await seed();
		const before = database.db.select().from(photos).get();
		const files = snapshot(photo.thumbnailKey);
		const jobId = await start(["photo.jpg"], true);
		const [input] = pendingScanWork(database.db, jobId);
		if (!input.thumbnailKey) throw new Error("Missing attempt thumbnail key");
		artifacts(input.thumbnailKey);
		rmSync(join(thumbnailsRoot, getThumbnailPath(input.thumbnailKey, "tiny")));
		expect(
			await commitScanResult(
				database.db,
				jobId,
				input.id,
				result(),
				input.thumbnailKey,
			),
		).toMatchObject({
			processed: 1,
			successful: 0,
			committed: true,
		});
		expect(database.db.select().from(photos).get()).toEqual(before);
		expect(snapshot(photo.thumbnailKey)).toEqual(files);
		expect(scanEmbeddingPhotoIds(database.db, jobId)).toEqual([]);
	});
}
