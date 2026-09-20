import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { getAllThumbnailSizes, getThumbnailPath } from "@photobrain/utils";
import { eq } from "drizzle-orm";
import {
	photoEmbedding,
	photoExif,
	photoPhash,
	photos,
	scanItems,
	scanJobs,
	scanManifests,
} from "../db/schema";
import {
	saveEmbeddingBatch,
	saveScanBatch,
} from "../services/import-persistence";
import type { PhotoStreamInput } from "../services/native-executor";
import { createTestDb } from "./setup";

type Progress = { phase: string; current: number; total: number };
type EmbeddingEvent = {
	name: string;
	data: { photoIds: number[]; thumbnailsDir: string; jobId: string };
};
type Steps = {
	run<T>(id: string, work: () => T | Promise<T>): Promise<T>;
	sendEvent(id: string, event: EmbeddingEvent): Promise<void>;
};
type Context = {
	event: {
		data: {
			directory: string;
			thumbnailsDir: string;
			jobId: string;
			force?: boolean;
		};
	};
	step: Steps;
	publish(message: { data: Progress }): Promise<void>;
};
type FailureContext = Omit<Context, "event"> & {
	event: { data: { event: Context["event"] } };
	error: Error;
};
type ScanFunction = {
	handler(context: Context): Promise<{ processed: number; successful: number }>;
	onFailure(context: FailureContext): Promise<void>;
};

// Native/client/database mocks are process-wide in Bun. Isolate them from the
// router/executor suites; these tests prove workflow/SQLite behavior, not native
// scheduling, HTTP delivery, or real Inngest replay.
if (process.env.PHOTOBRAIN_SCAN_TEST_CHILD !== "1") {
	test("scan workflow preserves durable per-photo receipts across output checkpoints", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_SCAN_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
	}, 60_000);
} else {
	const { db, sqlite } = createTestDb();
	let jobId: string;
	let fixtureRoot: string;
	let sourceRoot: string;
	let thumbnailsRoot: string;
	let paths: string[] = [];
	let failures = new Set<string>();
	let discoveries = 0;
	let loads: PhotoStreamInput[][] = [];
	let completions: string[] = [];
	let windows: number[] = [];
	let cancellations = 0;
	let cancellationError: Error | undefined;
	let session: PhotoStreamInput[] | undefined;
	let completionOrder: (inputs: PhotoStreamInput[]) => PhotoStreamInput[] = (
		inputs,
	) => inputs;
	let beforeResult: (input: PhotoStreamInput) => void = () => {};
	let afterResult: (input: PhotoStreamInput) => void = () => {};
	let failAfter = -1;

	function result(path: string): PhotoProcessingResult {
		return {
			success: !failures.has(path),
			path,
			name: path,
			size: existsSync(join(sourceRoot, path))
				? statSync(join(sourceRoot, path)).size
				: 100,
			createdAt: Date.UTC(2024, 0, 1),
			modifiedAt: existsSync(join(sourceRoot, path))
				? statSync(join(sourceRoot, path)).mtimeMs
				: Date.UTC(2024, 0, 1),
			width: 100,
			height: 80,
			mimeType: "image/jpeg",
			isRaw: false,
			exif: { cameraMake: "Scan fixture" },
			phash: "YWJjZA==",
		};
	}

	function sourceFiles() {
		for (const path of paths) {
			const file = join(sourceRoot, path);
			if (existsSync(file)) continue;
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, `source:${path}`);
		}
		return {
			filePaths: paths.map((path) => join(sourceRoot, path)),
			relativePaths: [...paths],
		};
	}

	function thumbnails(input: PhotoStreamInput) {
		if (!input.thumbnailKey) throw new Error("Missing attempt thumbnail key");
		for (const size of getAllThumbnailSizes()) {
			const file = join(
				thumbnailsRoot,
				getThumbnailPath(input.thumbnailKey, size),
			);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(
				file,
				`${size}:${input.relativePath}:${input.thumbnailKey}`,
			);
		}
	}

	async function initialize() {
		return initializeScanWork(
			db,
			jobId,
			await createScanPlan(db, sourceFiles(), sourceRoot, thumbnailsRoot),
		);
	}

	mock.module("../db", () => ({ db }));
	mock.module("../services/native-executor", () => ({
		nativeExecutor: {
			run: async (operation: string, inputs?: unknown[]) => {
				if (operation === "validateThumbnails")
					return inputs?.map(() => true) ?? [];
				if (operation !== "discoverPhotos")
					throw new Error(`Unexpected operation ${operation}`);
				discoveries++;
				return {
					...sourceFiles(),
					totalCount: paths.length,
				};
			},
			consumePhotos: async (
				_jobId: string,
				thumbnailsDir: string,
				load: () => PhotoStreamInput[] | Promise<PhotoStreamInput[]>,
				onResult: (
					id: number,
					value: PhotoProcessingResult,
					thumbnailKey?: string,
				) => void | Promise<void>,
				maxResults = 20,
			) => {
				expect(thumbnailsDir).toBe(thumbnailsRoot);
				if (!session) {
					const inputs = await load();
					loads.push(inputs);
					for (const input of inputs)
						expect(input.filePath).toBe(join(sourceRoot, input.relativePath));
					session = completionOrder([...inputs]);
				}
				let processed = 0;
				try {
					while (session.length > 0 && processed < maxResults) {
						const input = session.shift();
						if (!input) throw new Error("Missing fixture input");
						beforeResult(input);
						if (!failures.has(input.relativePath)) thumbnails(input);
						await onResult(
							input.id,
							result(input.relativePath),
							input.thumbnailKey,
						);
						completions.push(input.relativePath);
						processed++;
						afterResult(input);
						if (completions.length === failAfter) {
							failAfter = -1;
							throw new Error("Worker stopped after receipt ACK");
						}
					}
					windows.push(processed);
					return { processed, done: session.length === 0 };
				} catch (error) {
					session = undefined;
					throw error;
				}
			},
			cancelPhotos: async () => {
				cancellations++;
				session = undefined;
				if (cancellationError) throw cancellationError;
			},
		},
	}));
	mock.module("../inngest/client", () => ({
		inngest: {
			createFunction: (
				options: { onFailure: ScanFunction["onFailure"] },
				_trigger: unknown,
				handler: ScanFunction["handler"],
			) => ({ handler, onFailure: options.onFailure }),
		},
	}));
	// Static imports here would initialize the production database and native
	// worker before the isolated module-loading boundary installs its mocks.
	const { scanPhotosFunction } = await import("../inngest/functions/scan");
	const scan = scanPhotosFunction as unknown as ScanFunction;
	const { updateJobProgress } = await import("../inngest/progress");
	const { createScanPlan } = await import("../services/scan-planner");
	const {
		commitScanResult,
		getScanWorkProgress,
		initializeScanWork,
		pendingScanWork,
	} = await import("../services/scan-work");

	function job() {
		return db.select().from(scanJobs).where(eq(scanJobs.id, jobId)).get();
	}
	function harness(force = false) {
		const checkpoints = new Map<string, unknown>();
		const published: Progress[] = [];
		const dispatched: EmbeddingEvent[] = [];
		const eventIds = new Set<string>();
		let depth = 0;
		let publishIndex = 0;
		const controls = {
			loseCheckpoint: "",
			onPublish: async (_progress: Progress) => {},
			onDispatch: async (_event: EmbeddingEvent) => {},
			failDispatch: false,
		};
		const step: Steps = {
			async run<T>(id: string, work: () => T | Promise<T>): Promise<T> {
				if (checkpoints.has(id)) return checkpoints.get(id) as T;
				depth++;
				let value: T;
				try {
					value = await work();
				} finally {
					depth--;
				}
				if (controls.loseCheckpoint && id.startsWith(controls.loseCheckpoint)) {
					controls.loseCheckpoint = "";
					throw new Error("Lost checkpoint after commit");
				}
				const stored =
					value === undefined ? null : JSON.parse(JSON.stringify(value));
				checkpoints.set(id, stored);
				return stored as T;
			},
			async sendEvent(id, event) {
				await step.run(id, async () => {
					if (controls.failDispatch) {
						controls.failDispatch = false;
						throw new Error("Dispatch unavailable");
					}
					// Model idempotent step event delivery even if its response is lost.
					if (!eventIds.has(id)) {
						eventIds.add(id);
						dispatched.push(event);
						await controls.onDispatch(event);
					}
				});
			},
		};
		const context: Context = {
			event: {
				data: {
					directory: sourceRoot,
					thumbnailsDir: thumbnailsRoot,
					jobId,
					force,
				},
			},
			step,
			async publish({ data }) {
				const work = async () => {
					await controls.onPublish(data);
					published.push(data);
				};
				// Installed realtime middleware only creates a checkpoint outside a step.
				if (depth > 0) await work();
				else await step.run(`publish-${publishIndex++}`, work);
			},
		};
		return {
			checkpoints,
			published,
			dispatched,
			controls,
			execute: () => {
				publishIndex = 0;
				return scan.handler(context);
			},
			fail: (error: Error) =>
				scan.onFailure({
					...context,
					event: { data: { event: context.event } },
					error,
				}),
		};
	}

	beforeEach(() => {
		jobId = crypto.randomUUID();
		fixtureRoot = mkdtempSync(join(tmpdir(), "photobrain-scan-"));
		sourceRoot = join(fixtureRoot, "sources");
		thumbnailsRoot = join(fixtureRoot, "thumbnails");
		mkdirSync(sourceRoot);
		mkdirSync(thumbnailsRoot);
		sqlite.exec("DROP TRIGGER IF EXISTS fail_scan");
		db.delete(scanItems).run();
		db.delete(scanManifests).run();
		db.delete(photoExif).run();
		db.delete(photoPhash).run();
		db.delete(photoEmbedding).run();
		db.delete(photos).run();
		db.delete(scanJobs).run();
		db.insert(scanJobs)
			.values({ id: jobId, createdAt: new Date(), updatedAt: new Date() })
			.run();
		paths = [];
		failures = new Set();
		discoveries = 0;
		loads = [];
		completions = [];
		windows = [];
		cancellations = 0;
		session = undefined;
		failAfter = -1;
		cancellationError = undefined;
		completionOrder = (inputs) => inputs;
		beforeResult = () => {};
		afterResult = () => {};
	});
	afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }));
	afterAll(() => sqlite.close());

	test("unchanged rescans finish without media or embedding dispatch; missing vectors recover without re-encoding", async () => {
		paths = ["a.jpg"];
		await harness().execute();
		const photo = db.select().from(photos).get();
		if (!photo) throw new Error("Expected committed photo");
		saveEmbeddingBatch(
			db,
			[{ id: photo.id, thumbnailKey: photo.thumbnailKey }],
			[Array(512).fill(0.25)],
		);
		const completed = db.select().from(photos).get();
		if (!completed) throw new Error("Expected completed photo");
		const artifact = join(
			thumbnailsRoot,
			getThumbnailPath(photo.thumbnailKey ?? "", "large"),
		);
		const before = statSync(artifact, { bigint: true });
		jobId = crypto.randomUUID();
		db.insert(scanJobs)
			.values({ id: jobId, createdAt: new Date(), updatedAt: new Date() })
			.run();
		const unchanged = harness();
		expect(await unchanged.execute()).toEqual({ processed: 1, successful: 1 });
		expect(loads).toHaveLength(1);
		expect(unchanged.dispatched).toEqual([]);
		expect(job()?.status).toBe("completed");
		expect(db.select().from(photos).get()).toEqual(completed);
		expect(statSync(artifact, { bigint: true })).toEqual(before);

		db.delete(photoEmbedding).run();
		jobId = crypto.randomUUID();
		db.insert(scanJobs)
			.values({ id: jobId, createdAt: new Date(), updatedAt: new Date() })
			.run();
		const recovery = harness();
		expect(await recovery.execute()).toEqual({ processed: 1, successful: 1 });
		expect(loads).toHaveLength(1);
		expect(recovery.dispatched.map((event) => event.data.photoIds)).toEqual([
			[photo.id],
		]);
		expect(db.select().from(photos).get()).toEqual({
			...completed,
			embeddingStatus: "pending",
		});
		expect(statSync(artifact, { bigint: true })).toEqual(before);
	});

	test("force rescans commit a fresh generation without replacing the previous artifacts", async () => {
		paths = ["a.jpg"];
		await harness().execute();
		const photo = db.select().from(photos).get();
		if (!photo?.thumbnailKey) throw new Error("Expected committed generation");
		const artifact = join(
			thumbnailsRoot,
			getThumbnailPath(photo.thumbnailKey, "large"),
		);
		const before = statSync(artifact, { bigint: true });
		jobId = crypto.randomUUID();
		db.insert(scanJobs)
			.values({ id: jobId, createdAt: new Date(), updatedAt: new Date() })
			.run();
		const forced = harness(true);
		expect(await forced.execute()).toEqual({ processed: 1, successful: 1 });
		const updated = db.select().from(photos).get();
		expect(updated?.id).toBe(photo.id);
		expect(updated?.thumbnailKey).not.toBe(photo.thumbnailKey);
		expect(statSync(artifact, { bigint: true })).toEqual(before);
		expect(forced.dispatched.map((event) => event.data.photoIds)).toEqual([
			[photo.id],
		]);
		expect(loads).toHaveLength(2);
	});

	test("dispatches new paths first but commits fast existing and later inputs before a slow first input", async () => {
		const [oldId] = saveScanBatch(db, [result("old.jpg")]);
		paths = ["old.jpg", "slow.jpg", "fast.jpg", "broken.jpg"];
		failures.add("broken.jpg");
		completionOrder = (inputs) => [inputs[1], inputs[3], inputs[2], inputs[0]];
		const run = harness();
		const visible: string[][] = [];
		run.controls.onPublish = async (progress) => {
			if (progress.phase !== "processing" || progress.current === 0) return;
			visible.push(
				db
					.select({ path: photos.path })
					.from(photos)
					.all()
					.map((photo) => photo.path),
			);
			expect(job()?.current).toBeGreaterThanOrEqual(progress.current);
		};
		beforeResult = (input) => {
			if (input.relativePath === "slow.jpg") {
				expect(job()?.current).toBe(3);
				expect(
					db.select().from(photos).where(eq(photos.path, "fast.jpg")).get()
						?.thumbnailStatus,
				).toBe("completed");
			}
		};
		run.controls.onDispatch = async (event) => {
			expect(run.published.at(-1)?.phase).toBe("scan-complete");
			expect(job()).toMatchObject({
				phase: "scan-complete",
				current: 4,
				total: 4,
			});
			const savedIds = db
				.select({ id: photos.id })
				.from(photos)
				.all()
				.map((photo) => photo.id);
			expect([...event.data.photoIds].sort((a, b) => a - b)).toEqual(
				savedIds.sort((a, b) => a - b),
			);
			await updateJobProgress(jobId, "completed", 3, 3);
		};
		expect(await run.execute()).toEqual({ processed: 4, successful: 3 });
		expect(loads[0].map((input) => input.relativePath)).toEqual([
			"slow.jpg",
			"fast.jpg",
			"broken.jpg",
			"old.jpg",
		]);
		expect(completions).toEqual([
			"fast.jpg",
			"old.jpg",
			"broken.jpg",
			"slow.jpg",
		]);
		expect(new Set(visible[0])).toEqual(new Set(["old.jpg", "fast.jpg"]));
		expect(
			db.select().from(photos).where(eq(photos.path, "old.jpg")).get()?.id,
		).toBe(oldId);
		expect(job()).toMatchObject({ phase: "completed", current: 3 });
		expect(run.dispatched).toHaveLength(1);
		expect(db.select().from(scanManifests).all()).toEqual([]);
	});

	test("slow realtime delivery does not block receipt ACKs and stays bounded across output windows", async () => {
		paths = Array.from({ length: 41 }, (_, index) => `${index}.jpg`);
		const run = harness();
		let release!: () => void;
		const slowPublish = new Promise<void>((resolve) => {
			release = resolve;
		});
		let active = 0;
		let peak = 0;
		run.controls.onPublish = async (progress) => {
			active++;
			peak = Math.max(peak, active);
			try {
				if (progress.phase === "processing" && progress.current === 1)
					await slowPublish;
			} finally {
				active--;
			}
		};
		afterResult = () => {
			if (completions.length === 20) {
				expect(job()?.current).toBe(20);
				expect(active).toBe(1);
				release();
			}
		};
		expect(await run.execute()).toEqual({ processed: 41, successful: 41 });
		expect(peak).toBe(1);
		expect(loads).toHaveLength(1);
		expect(windows).toEqual([20, 20, 1]);
		const counts = run.published
			.filter((progress) => progress.phase === "processing")
			.map((progress) => progress.current);
		expect(counts.slice(0, 3)).toEqual([0, 1, 20]);
		expect(counts.at(-1)).toBe(41);
		expect(counts).toEqual([...counts].sort((a, b) => a - b));
	});

	test("worker restart after partial commit reloads only pending receipts with stable IDs and counts", async () => {
		paths = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"];
		failAfter = 2;
		const run = harness();
		await expect(run.execute()).rejects.toThrow(
			"Worker stopped after receipt ACK",
		);
		const saved = db
			.select({ id: photos.id, path: photos.path })
			.from(photos)
			.all();
		expect(getScanWorkProgress(db, jobId)).toEqual({
			total: 4,
			processed: 2,
			successful: 2,
			pending: 2,
		});
		expect(job()?.current).toBe(2);
		paths.push("arrived-after-discovery.jpg");
		expect(await run.execute()).toEqual({ processed: 4, successful: 4 });
		expect(discoveries).toBe(1);
		expect(loads[1].map((input) => input.relativePath)).toEqual([
			"c.jpg",
			"d.jpg",
		]);
		expect(completions).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
		expect(
			db
				.select({ id: photos.id, path: photos.path })
				.from(photos)
				.all()
				.slice(0, 2),
		).toEqual(saved);
		expect(new Set(run.dispatched[0].data.photoIds).size).toBe(4);
	});

	test.each([
		"scan_items",
		"scan_jobs",
	])("rolls back photo, sidecars, receipt and progress when %s update fails", async (table) => {
		paths = ["a.jpg", "b.jpg"];
		sqlite.exec(`CREATE TRIGGER fail_scan BEFORE UPDATE ON ${table}
			WHEN EXISTS (SELECT 1 FROM photos WHERE path = 'b.jpg')
			BEGIN SELECT RAISE(ABORT, 'receipt transaction failure'); END`);
		const run = harness();
		await expect(run.execute()).rejects.toThrow("receipt transaction failure");
		const first = db.select().from(photos).all();
		expect(first.map((photo) => photo.path)).toEqual(["a.jpg"]);
		expect(db.select().from(photoExif).all()).toHaveLength(1);
		expect(db.select().from(photoPhash).all()).toHaveLength(1);
		expect(getScanWorkProgress(db, jobId)).toEqual({
			total: 2,
			processed: 1,
			successful: 1,
			pending: 1,
		});
		expect(job()).toMatchObject({ phase: "processing", current: 1, total: 2 });
		expect(
			pendingScanWork(db, jobId).map((input) => input.relativePath),
		).toEqual(["b.jpg"]);
		sqlite.exec("DROP TRIGGER fail_scan");
		expect(await run.execute()).toEqual({ processed: 2, successful: 2 });
		expect(
			db.select().from(photos).where(eq(photos.path, "a.jpg")).get()?.id,
		).toBe(first[0].id);
		expect(loads[1].map((input) => input.relativePath)).toEqual(["b.jpg"]);
	});

	test("lost output checkpoint reuses receipts and the live session without double counting", async () => {
		paths = Array.from({ length: 23 }, (_, index) => `${index}.jpg`);
		const run = harness();
		run.controls.loseCheckpoint = "consume-photo-results";
		await expect(run.execute()).rejects.toThrow("Lost checkpoint after commit");
		expect(job()?.current).toBe(20);
		const firstIds = db
			.select({ id: photos.id })
			.from(photos)
			.all()
			.map((photo) => photo.id);
		expect(await run.execute()).toEqual({ processed: 23, successful: 23 });
		expect(loads).toHaveLength(1);
		expect(completions).toEqual(paths);
		expect(new Set(run.dispatched[0].data.photoIds.slice(0, 20))).toEqual(
			new Set(firstIds),
		);
		expect(new Set(run.dispatched[0].data.photoIds).size).toBe(23);
	});

	test("publication rejection retries from durable receipts even when the whole window committed", async () => {
		paths = ["a.jpg", "b.jpg", "c.jpg"];
		const run = harness();
		let rejectPublication = true;
		run.controls.onPublish = async (progress) => {
			if (
				progress.phase === "processing" &&
				progress.current === 1 &&
				rejectPublication
			) {
				rejectPublication = false;
				throw new Error("Realtime unavailable");
			}
		};
		await expect(run.execute()).rejects.toThrow("Realtime unavailable");
		expect(job()?.current).toBe(3);
		expect(cancellations).toBe(1);
		expect(run.dispatched).toEqual([]);
		expect(await run.execute()).toEqual({ processed: 3, successful: 3 });
		expect(loads[1]).toEqual([]);
		expect(completions).toEqual(paths);
		expect(
			run.published.some(
				(progress) => progress.phase === "processing" && progress.current === 3,
			),
		).toBe(true);
	});

	test("retains final IDs until dispatch is checkpointed and never regresses a fast child on replay", async () => {
		paths = ["a.jpg", "b.jpg"];
		const run = harness();
		run.controls.failDispatch = true;
		await expect(run.execute()).rejects.toThrow("Dispatch unavailable");
		expect(db.select().from(scanItems).all()).toHaveLength(2);
		const ids = db
			.select({ id: photos.id })
			.from(photos)
			.all()
			.map((photo) => photo.id);
		run.controls.loseCheckpoint = "trigger-embeddings";
		run.controls.onDispatch = async () => {
			await updateJobProgress(jobId, "completed", 2, 2);
		};
		await expect(run.execute()).rejects.toThrow("Lost checkpoint after commit");
		expect(db.select().from(scanItems).all()).toHaveLength(2);
		expect(await run.execute()).toEqual({ processed: 2, successful: 2 });
		expect(run.dispatched).toHaveLength(1);
		expect(run.dispatched[0].data.photoIds).toEqual(ids);
		expect(job()).toMatchObject({ phase: "completed", current: 2, total: 2 });
		expect(db.select().from(scanItems).all()).toEqual([]);
	});

	test("an empty durable manifest stays frozen after losing discovery's checkpoint", async () => {
		const run = harness();
		run.controls.loseCheckpoint = "initialize-scan-work";
		await expect(run.execute()).rejects.toThrow("Lost checkpoint after commit");
		expect(db.select().from(scanManifests).all()).toHaveLength(1);
		paths = ["arrived-late.jpg"];
		expect(await run.execute()).toEqual({ processed: 0, successful: 0 });
		expect(discoveries).toBe(1);
		expect(loads).toEqual([]);
		expect(job()).toMatchObject({ status: "completed", current: 0, total: 0 });
		expect(run.dispatched).toEqual([]);
		expect(db.select().from(scanManifests).all()).toEqual([]);
	});

	test("empty completion survives a lost terminal checkpoint and still publishes completion", async () => {
		const run = harness();
		run.controls.loseCheckpoint = "mark-scan-finished";
		await expect(run.execute()).rejects.toThrow("Lost checkpoint after commit");
		expect(job()).toMatchObject({ status: "completed", current: 0, total: 0 });
		expect(await run.execute()).toEqual({ processed: 0, successful: 0 });
		expect(run.published.at(-1)?.phase).toBe("completed");
		expect(run.dispatched).toEqual([]);
		expect(db.select().from(scanManifests).all()).toEqual([]);
	});

	test("rejects misaligned discovery before persisting a manifest", async () => {
		await expect(
			createScanPlan(
				db,
				{
					filePaths: [join(sourceRoot, "a.jpg")],
					relativePaths: [],
				},
				sourceRoot,
				thumbnailsRoot,
			),
		).rejects.toThrow();
		expect(db.select().from(scanManifests).all()).toEqual([]);
	});

	test("idempotent receipts ignore duplicate results and reject mismatched pending paths", async () => {
		paths = ["a.jpg", "b.jpg"];
		await initialize();
		const [first, second] = pendingScanWork(db, jobId);
		thumbnails(first);
		const saved = await commitScanResult(
			db,
			jobId,
			first.id,
			result("a.jpg"),
			first.thumbnailKey,
		);
		expect(saved).toMatchObject({
			processed: 1,
			successful: 1,
			committed: true,
		});
		expect(
			await commitScanResult(
				db,
				jobId,
				first.id,
				result("a.jpg"),
				first.thumbnailKey,
			),
		).toMatchObject({ processed: 1, successful: 1, committed: false });
		thumbnails(second);
		await expect(
			commitScanResult(
				db,
				jobId,
				second.id,
				result("wrong.jpg"),
				second.thumbnailKey,
			),
		).rejects.toThrow();
		expect(job()?.current).toBe(1);
		expect(
			db
				.select()
				.from(photos)
				.all()
				.map((photo) => photo.path),
		).toEqual(["a.jpg"]);
	});

	test.each([
		"missing",
		"completed",
		"failed",
	])("does not discover or process a %s job", async (status) => {
		if (status === "missing") db.delete(scanJobs).run();
		else db.update(scanJobs).set({ phase: status, status }).run();
		paths = ["a.jpg"];
		const run = harness();
		expect(await run.execute()).toEqual({ processed: 0, successful: 0 });
		expect(discoveries).toBe(0);
		expect(loads).toEqual([]);
		expect(run.published).toEqual([]);
		expect(run.dispatched).toEqual([]);
	});

	test("terminal transition during a stream prevents later photo persistence", async () => {
		paths = ["a.jpg", "b.jpg"];
		beforeResult = (input) => {
			if (input.relativePath === "b.jpg")
				db.update(scanJobs).set({ status: "failed", phase: "failed" }).run();
		};
		const run = harness();
		expect(await run.execute()).toEqual({ processed: 1, successful: 1 });
		expect(
			db
				.select()
				.from(photos)
				.all()
				.map((photo) => photo.path),
		).toEqual(["a.jpg"]);
		expect(job()).toMatchObject({
			status: "failed",
			phase: "failed",
			current: 1,
		});
		expect(cancellations).toBeGreaterThan(0);
		expect(run.dispatched).toEqual([]);
	});

	test("all-failed scans are terminal without embeddings and release the ledger", async () => {
		paths = ["broken.jpg"];
		failures = new Set(paths);
		const run = harness();
		expect(await run.execute()).toEqual({ processed: 1, successful: 0 });
		expect(job()).toMatchObject({
			status: "failed",
			phase: "failed",
			current: 1,
			total: 1,
		});
		expect(run.published.at(-1)?.phase).toBe("failed");
		expect(run.dispatched).toEqual([]);
		expect(db.select().from(photos).all()).toEqual([]);
		expect(db.select().from(scanManifests).all()).toEqual([]);
	});

	test("exhausted failure cancels native work and clears receipts without regressing terminal children", async () => {
		paths = ["a.jpg"];
		await initialize();
		const run = harness();
		await run.fail(new Error("native worker died"));
		expect(cancellations).toBe(1);
		expect(job()).toMatchObject({
			phase: "failed",
			status: "failed",
			error: "native worker died",
		});
		expect(run.published.at(-1)?.phase).toBe("failed");
		expect(db.select().from(scanManifests).all()).toEqual([]);
		expect(await updateJobProgress(jobId, "processing", 1, 2)).toBe(false);
		db.update(scanJobs)
			.set({ phase: "completed", status: "completed", error: null })
			.run();
		const late = harness();
		await late.fail(new Error("late dispatch failure"));
		expect(job()).toMatchObject({
			phase: "completed",
			status: "completed",
			error: null,
		});
		expect(late.published).toEqual([]);
	});

	test("exhausted failure remains durable when native cancellation also fails", async () => {
		paths = ["a.jpg"];
		await initialize();
		cancellationError = new Error("Native executor is busy");
		const run = harness();
		await run.fail(new Error("native worker died"));
		expect(job()).toMatchObject({
			phase: "failed",
			status: "failed",
			error: "native worker died",
		});
		expect(run.published.at(-1)?.phase).toBe("failed");
		expect(db.select().from(scanManifests).all()).toEqual([]);
	});

	test("7961 inputs fit the checkpoint ceiling without embedding native results or manifest paths", async () => {
		paths = Array.from({ length: 7961 }, (_, index) => `${index}.jpg`);
		failures = new Set(paths);
		const run = harness();
		expect(await run.execute()).toEqual({ processed: 7961, successful: 0 });
		expect(windows).toHaveLength(399);
		expect(windows.at(-1)).toBe(1);
		expect(loads).toHaveLength(1);
		expect(run.checkpoints.size).toBeLessThan(1000);
		expect(
			[...run.checkpoints.keys()].filter((id) =>
				id.startsWith("consume-photo-results-v5-"),
			),
		).toHaveLength(399);
		for (const [id, value] of run.checkpoints) {
			if (!id.startsWith("consume-photo-results-v5-")) continue;
			expect(JSON.stringify(value).length).toBeLessThan(120);
		}
	}, 30_000);
}
