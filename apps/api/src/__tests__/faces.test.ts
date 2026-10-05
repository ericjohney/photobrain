import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import * as schema from "../db/schema";
import {
	people,
	photoEmbedding,
	photoFaceScan,
	photoFaces,
	photos,
} from "../db/schema";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb, perfBudgetMs } from "./setup";

const PERF_LOG_PREFIX = "[faces-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";
const DIMENSION = 128;

type FaceBox = { x: number; y: number; width: number; height: number };
type Detection = {
	path: string;
	success: boolean;
	faces: { box: FaceBox; score: number; embedding: number[] }[];
	error?: string | null;
};
type FaceStep = { run<T>(id: string, work: () => T | Promise<T>): Promise<T> };
type FaceFunction = {
	options: { id: string; concurrency: { limit: number } };
	trigger: { event: string };
	handler(context: {
		event: { data: Record<string, never> };
		step: FaceStep;
	}): Promise<Record<string, number>>;
};

// Mocks of the native addon, executor, ../db and the Inngest client are
// process-wide; run the suite in an isolated child like the tags suite.
if (process.env.PHOTOBRAIN_FACES_TEST_CHILD !== "1") {
	test("faces: detection batches, clustering, people, filters, crops and contract", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_FACES_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
		for (const line of `${stdout}\n${stderr}`.split("\n")) {
			if (line.startsWith(PERF_LOG_PREFIX)) console.log(line);
		}
	}, 180_000);
} else {
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);
	sqlite.run("PRAGMA foreign_keys = ON");

	let queryVector = [1, 0, 0, 0];
	let detectImpl: (paths: string[]) => Detection[] = (paths) =>
		paths.map((path) => ({ path, success: true, faces: [], error: null }));
	const detectCalls: string[][] = [];
	let clusterImpl: (
		embeddings: Float32Array,
		dimension: number,
		threshold: number,
		minClusterSize: number,
	) => number[][] = () => [];
	class FakeBusyError extends Error {
		constructor() {
			super("Native executor is busy; retry this batch");
			this.name = "NativeExecutorBusyError";
		}
	}
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => queryVector,
		clusterFaceEmbeddings: (
			embeddings: Float32Array,
			dimension: number,
			threshold: number,
			minClusterSize: number,
		) => clusterImpl(embeddings, dimension, threshold, minClusterSize),
	}));
	mock.module("../services/native-executor", () => ({
		MAX_NATIVE_REQUESTS: 8,
		NativeExecutorBusyError: FakeBusyError,
		nativeExecutor: {
			run: async (operation: string, paths: string[]) => {
				if (operation !== "detectFaces") {
					throw new Error(`Unexpected native operation ${operation}`);
				}
				detectCalls.push(paths);
				return detectImpl(paths);
			},
		},
	}));
	mock.module("../db", () => ({ db }));
	mock.module("../inngest/client", () => ({
		inngest: {
			send: async () => undefined,
			createFunction: (
				options: unknown,
				trigger: unknown,
				handler: FaceFunction["handler"],
			) => ({ options, trigger, handler }),
		},
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, executor, production
	// database and Inngest client before these mocks (intentional boundary).
	const faces = await import("../services/faces");
	const {
		assignFace,
		boxIou,
		clusterFaces,
		detectFaceBatch,
		FACE_ASSIGN_THRESHOLD,
		FACE_BATCH_SIZE,
		FACE_CLUSTER_THRESHOLD,
		FACE_MIN_CLUSTER_SIZE,
		FaceError,
		getPerson,
		getPhotoFaces,
		listPeople,
		mergePeople,
		readFaceScanBatch,
		saveFaceScanBatch,
		updatePerson,
	} = faces;
	const { FACE_MODEL_VERSION } = await import(
		"../services/processing-versions"
	);
	const { detectFacesFunction } = await import("../inngest/functions/faces");
	const { listPhotos } = await import("../services/photo-catalog");
	const { searchPhotosByText, findSimilarToPhoto } = await import(
		"../services/vector-search"
	);
	const { createSmartAlbum } = await import("../services/smart-albums");
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");
	const { createFacesRouter } = await import("../routes/faces");
	const v1Schemas = await import("../routes/v1-schemas");

	const caller = appRouter.createCaller({ db });
	const app = new Hono();
	app.route(
		"/api/v1",
		createV1Router({
			database: db,
			searchPhotos: (query, limit, filters, representation) =>
				searchPhotosByText(db, query, limit, filters, representation),
			dispatchScan: async () => undefined,
			photoDirectory: "../../test-photos",
			thumbnailsDirectory: "./test-thumbnails",
			nativeScanMutationsEnabled: false,
		}),
	);
	const thumbnailsRoot = mkdtempSync(join(tmpdir(), "photobrain-faces-"));

	afterAll(() => {
		sqlite.close();
		rmSync(thumbnailsRoot, { recursive: true, force: true });
	});
	beforeEach(() => {
		db.delete(photoFaces).run();
		db.delete(photoFaceScan).run();
		db.delete(people).run();
		db.delete(photoEmbedding).run();
		db.delete(photos).run();
		detectCalls.length = 0;
		detectImpl = (paths) =>
			paths.map((path) => ({ path, success: true, faces: [], error: null }));
		clusterImpl = () => [];
		queryVector = [1, 0, 0, 0];
	});

	function addPhoto(
		path: string,
		overrides: Partial<typeof photos.$inferInsert> = {},
	) {
		return db
			.insert(photos)
			.values({
				path,
				name: path.split("/").at(-1) ?? path,
				size: 1,
				createdAt: new Date(0),
				modifiedAt: new Date(0),
				isRaw: /\.(arw|cr2|nef)$/.test(path),
				thumbnailStatus: "completed",
				thumbnailKey: `.versions/${path}`,
				...overrides,
			})
			.returning()
			.get();
	}

	/** A 128-d unit vector `cos * e_axis + sin * e_(axis+1)`. */
	function unit(axis: number, cos = 1): number[] {
		const vector = new Array<number>(DIMENSION).fill(0);
		vector[axis % DIMENSION] = cos;
		vector[(axis + 1) % DIMENSION] = Math.sqrt(Math.max(0, 1 - cos * cos));
		return vector;
	}

	function addPerson(name: string | null, hidden = false) {
		const now = new Date(0);
		return db
			.insert(people)
			.values({ name, hidden, createdAt: now, updatedAt: now })
			.returning()
			.get().id;
	}

	function addFace(
		photoId: number,
		options: {
			box?: Partial<FaceBox>;
			score?: number;
			embedding?: number[];
			personId?: number | null;
			assignment?: "auto" | "manual" | "rejected";
		} = {},
	) {
		return db
			.insert(photoFaces)
			.values({
				photoId,
				thumbnailKey: "k",
				modelVersion: FACE_MODEL_VERSION,
				x: options.box?.x ?? 0.1,
				y: options.box?.y ?? 0.1,
				width: options.box?.width ?? 0.2,
				height: options.box?.height ?? 0.2,
				score: options.score ?? 0.9,
				embedding: Buffer.from(
					new Float32Array(options.embedding ?? unit(0)).buffer,
				),
				personId: options.personId ?? null,
				assignment: options.assignment ?? "auto",
				createdAt: new Date(0),
			})
			.returning()
			.get().id;
	}

	const faceRow = (id: number) =>
		db.select().from(photoFaces).where(eq(photoFaces.id, id)).get();
	const ids = (result: { photos: { id: number }[] }) =>
		result.photos.map((photo) => photo.id).sort((a, b) => a - b);
	const detection = (
		path: string,
		boxes: FaceBox[],
		embedding = unit(0),
	): Detection => ({
		path,
		success: true,
		faces: boxes.map((box) => ({ box, score: 0.9, embedding })),
		error: null,
	});

	async function trpcCode(promise: Promise<unknown>) {
		const error = await promise.then(
			() => null,
			(caught: unknown) => caught,
		);
		if (!(error instanceof TRPCError)) {
			throw new Error(`Expected a TRPCError, received ${String(error)}`);
		}
		return error.code;
	}

	async function send(method: string, path: string, body?: unknown) {
		const response = await app.request(`/api/v1${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	}

	describe("detection batches", () => {
		test("selects stack-representative stills with a committed thumbnail and a missing or outdated scan", () => {
			const still = addPhoto("a/still.jpg");
			addPhoto("a/clip.mov", { mediaType: "video", durationMs: 10_000 });
			addPhoto("a/pending.jpg", { thumbnailStatus: "pending" });
			addPhoto("a/keyless.jpg", { thumbnailKey: null });
			const pairRaw = addPhoto("a/pair.arw");
			const pairJpg = addPhoto("a/pair.jpg");
			const loneRaw = addPhoto("a/lone.arw");
			const selected = () => readFaceScanBatch(db, 0).map((row) => row.photoId);
			expect(selected()).toEqual([still.id, pairJpg.id, loneRaw.id]);
			expect(selected()).not.toContain(pairRaw.id);

			// A completed scan of the current generation and model is skipped.
			saveFaceScanBatch(
				db,
				readFaceScanBatch(db, 0),
				readFaceScanBatch(db, 0).map((row) =>
					detection(String(row.photoId), []),
				),
			);
			expect(selected()).toEqual([]);

			// A regenerated thumbnail or another model version triggers a rescan.
			db.update(photos)
				.set({ thumbnailKey: ".versions/new/still.jpg" })
				.where(eq(photos.id, still.id))
				.run();
			db.update(photoFaceScan)
				.set({ modelVersion: "old-model" })
				.where(eq(photoFaceScan.photoId, loneRaw.id))
				.run();
			expect(selected()).toEqual([still.id, loneRaw.id]);
			// The keyset cursor and limit apply.
			expect(
				readFaceScanBatch(db, still.id, 1).map((row) => row.photoId),
			).toEqual([loneRaw.id]);
		});

		test("detectFaceBatch detects in the committed large thumbnail and records failures", async () => {
			const rooted = addPhoto("b/one.jpg", {
				thumbnailKey: ".versions/u1/photo.jpg",
				thumbnailRoot: "/committed",
			});
			const failing = addPhoto("b/two.jpg", {
				thumbnailKey: ".versions/u2/photo.heic",
			});
			// Existing faces of a failed photo are kept.
			const kept = addFace(failing.id);
			const box = { x: 0.5, y: 0.25, width: 0.25, height: 0.25 };
			const result = await detectFaceBatch(
				db,
				async (paths) => [
					detection(paths[0], [box, { ...box, x: 0.1 }]),
					{ path: paths[1], success: false, faces: [], error: "unreadable" },
				],
				"/configured",
				0,
			);
			expect(result).toEqual({
				read: 2,
				scanned: 2,
				failed: 1,
				faces: 2,
				cursor: failing.id,
			});
			expect(getPhotoFaces(db, rooted.id)?.faces).toEqual([
				expect.objectContaining({
					box: { ...box, x: 0.1 },
					personId: null,
					personName: null,
					assignment: "auto",
				}),
				expect.objectContaining({ box, assignment: "auto" }),
			]);
			const scans = db.select().from(photoFaceScan).all();
			expect(
				scans.map(
					({
						photoId,
						thumbnailKey,
						modelVersion,
						faceCount,
						status,
						error,
					}) => ({
						photoId,
						thumbnailKey,
						modelVersion,
						faceCount,
						status,
						error,
					}),
				),
			).toEqual([
				{
					photoId: rooted.id,
					thumbnailKey: ".versions/u1/photo.jpg",
					modelVersion: FACE_MODEL_VERSION,
					faceCount: 2,
					status: "completed",
					error: null,
				},
				{
					photoId: failing.id,
					thumbnailKey: ".versions/u2/photo.heic",
					modelVersion: FACE_MODEL_VERSION,
					faceCount: 0,
					status: "failed",
					error: "unreadable",
				},
			]);
			expect(faceRow(kept)).toBeDefined();
			// Failures are not retried until the generation or model changes.
			expect(readFaceScanBatch(db, 0)).toEqual([]);
			const stored = sqlite
				.query<{ bytes: number }, [number]>(
					"SELECT length(embedding) AS bytes FROM photo_faces WHERE photo_id = ?",
				)
				.get(rooted.id);
			expect(stored?.bytes).toBe(DIMENSION * 4);
		});

		test("a malformed embedding fails the photo instead of storing it", () => {
			const photo = addPhoto("c/bad.jpg");
			const [row] = readFaceScanBatch(db, 0);
			expect(
				saveFaceScanBatch(
					db,
					[row],
					[
						{
							path: "x",
							success: true,
							faces: [
								{
									box: { x: 0, y: 0, width: 1, height: 1 },
									score: 1,
									embedding: [1, 0],
								},
							],
							error: null,
						},
					],
				),
			).toEqual({ scanned: 1, failed: 1, faces: 0 });
			expect(getPhotoFaces(db, photo.id)?.faces).toEqual([]);
			expect(db.select().from(photoFaceScan).get()?.error).toContain(
				"expected 128",
			);
		});

		test("detection paths come from the committed root and large thumbnail path", async () => {
			addPhoto("d/one.jpg", {
				thumbnailKey: ".versions/u1/photo.jpg",
				thumbnailRoot: "/committed",
			});
			addPhoto("d/two.jpg", { thumbnailKey: ".versions/u2/photo.jpg" });
			let seen: string[] = [];
			await detectFaceBatch(
				db,
				async (paths) => {
					seen = paths;
					return paths.map((path) => detection(path, []));
				},
				"/configured",
				0,
			);
			expect(seen).toEqual([
				"/committed/large/.versions/u1/photo.webp",
				"/configured/large/.versions/u2/photo.webp",
			]);
		});

		test("rescans carry manual assignments over by IoU >= 0.5", () => {
			const photo = addPhoto("e/group.jpg");
			const ann = addPerson("Ann");
			const bob = addPerson("Bob");
			addFace(photo.id, {
				box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
				personId: ann,
				assignment: "manual",
			});
			addFace(photo.id, {
				box: { x: 0.6, y: 0.6, width: 0.2, height: 0.2 },
				personId: bob,
				assignment: "manual",
			});
			// Exactly IoU 0.5 (binary-exact boxes) still carries over.
			addFace(photo.id, {
				box: { x: 0, y: 0.5, width: 0.75, height: 0.5 },
				personId: null,
				assignment: "rejected",
			});
			expect(
				boxIou(
					{ x: 0, y: 0.5, width: 0.75, height: 0.5 },
					{ x: 0.25, y: 0.5, width: 0.75, height: 0.5 },
				),
			).toBe(0.5);
			db.update(photos)
				.set({ thumbnailKey: ".versions/regenerated.jpg" })
				.where(eq(photos.id, photo.id))
				.run();
			const rows = readFaceScanBatch(db, 0);
			expect(rows.map((row) => row.thumbnailKey)).toEqual([
				".versions/regenerated.jpg",
			]);
			saveFaceScanBatch(db, rows, [
				detection("p", [
					// IoU 0.818 with Ann's face.
					{ x: 0.12, y: 0.1, width: 0.2, height: 0.2 },
					// IoU 0.333 with Bob's face: a new auto face.
					{ x: 0.7, y: 0.6, width: 0.2, height: 0.2 },
					{ x: 0.25, y: 0.5, width: 0.75, height: 0.5 },
				]),
			]);
			expect(
				getPhotoFaces(db, photo.id)?.faces.map(
					({ box, personId, personName, assignment }) => ({
						x: box.x,
						personId,
						personName,
						assignment,
					}),
				),
			).toEqual([
				{ x: 0.12, personId: ann, personName: "Ann", assignment: "manual" },
				{ x: 0.25, personId: null, personName: null, assignment: "rejected" },
				{ x: 0.7, personId: null, personName: null, assignment: "auto" },
			]);
			expect(
				db
					.select()
					.from(photoFaces)
					.all()
					.map((row) => row.thumbnailKey),
			).toEqual(Array(3).fill(".versions/regenerated.jpg"));
		});

		test("a result for a stale thumbnail generation is not written", async () => {
			const photo = addPhoto("f/raced.jpg");
			const existing = addFace(photo.id);
			const result = await detectFaceBatch(
				db,
				async (paths) => {
					// The scan regenerates the thumbnail while detection runs.
					db.update(photos)
						.set({ thumbnailKey: ".versions/newer.jpg" })
						.where(eq(photos.id, photo.id))
						.run();
					return paths.map((path) =>
						detection(path, [{ x: 0.5, y: 0.5, width: 0.1, height: 0.1 }]),
					);
				},
				"/thumbs",
				0,
			);
			expect(result).toMatchObject({ read: 1, scanned: 0, faces: 0 });
			expect(db.select().from(photoFaceScan).all()).toEqual([]);
			expect(
				db
					.select()
					.from(photoFaces)
					.all()
					.map((row) => row.id),
			).toEqual([existing]);
			// The newer generation is picked up by the next run.
			expect(readFaceScanBatch(db, 0)[0].thumbnailKey).toBe(
				".versions/newer.jpg",
			);
		});

		test("detect-faces-v1 pages 32-photo steps and finishes with one cluster step", async () => {
			const fn = detectFacesFunction as unknown as FaceFunction;
			expect(fn.options).toEqual({
				id: "detect-faces-v1",
				concurrency: { limit: 1 },
			});
			expect(fn.trigger).toEqual({ event: "photos/faces.requested" });
			for (let index = 0; index < FACE_BATCH_SIZE + 3; index++) {
				addPhoto(`g/${index}.jpg`);
			}
			detectImpl = (paths) =>
				paths.map((path, index) =>
					index === 0
						? { path, success: false, faces: [], error: "bad" }
						: detection(path, [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }]),
				);
			clusterImpl = (embeddings, dimension) => [
				Array.from({ length: embeddings.length / dimension }, (_, i) => i),
			];
			const steps: string[] = [];
			const result = await fn.handler({
				event: { data: {} },
				step: {
					run: async (id, work) => {
						steps.push(id);
						return JSON.parse(JSON.stringify(await work()));
					},
				},
			});
			expect(steps).toEqual([
				"detect-faces-batch-v1-0",
				"detect-faces-batch-v1-1",
				"cluster-faces-v1",
			]);
			expect(detectCalls.map((paths) => paths.length)).toEqual([32, 3]);
			expect(result).toEqual({
				scanned: 35,
				failed: 2,
				assigned: 0,
				clustered: 33,
				created: 1,
				deleted: 0,
			});
			expect(listPeople(db).people).toEqual([
				expect.objectContaining({ name: null, faceCount: 33, photoCount: 33 }),
			]);
		});
	});

	describe("cluster step", () => {
		/** The float32 value one ULP below `value`'s float32 rounding. */
		function float32Below(value: number) {
			const bits = new Float32Array([value]);
			const view = new Int32Array(bits.buffer);
			view[0] -= 1;
			return bits[0];
		}

		test("assigns at the threshold boundary, leaves manual/rejected faces, clusters the rest, prunes empty unnamed people", () => {
			const photo = addPhoto("h/one.jpg");
			const ann = addPerson("Ann");
			const cara = addPerson("Cara");
			const emptyUnnamed = addPerson(null);
			const emptyNamed = addPerson("Kept");
			// Ann's centroid points at axis 0; Cara's at axis 64.
			addFace(photo.id, {
				embedding: unit(0),
				personId: ann,
				assignment: "manual",
			});
			addFace(photo.id, {
				embedding: unit(64),
				personId: cara,
				assignment: "auto",
			});
			const threshold = Math.fround(FACE_ASSIGN_THRESHOLD);
			const atThreshold = addFace(photo.id, { embedding: unit(0, threshold) });
			const belowThreshold = addFace(photo.id, {
				embedding: unit(0, float32Below(FACE_ASSIGN_THRESHOLD)),
			});
			const toCara = addFace(photo.id, { embedding: unit(64, 0.9) });
			// User decisions are never changed, however similar.
			const rejected = addFace(photo.id, {
				embedding: unit(0),
				assignment: "rejected",
			});
			const manualElsewhere = addFace(photo.id, {
				embedding: unit(0),
				personId: cara,
				assignment: "manual",
			});
			const loneA = addFace(photo.id, { embedding: unit(100) });
			const loneB = addFace(photo.id, { embedding: unit(100) });
			const loneC = addFace(photo.id, { embedding: unit(110) });
			let received:
				| {
						length: number;
						dimension: number;
						threshold: number;
						min: number;
						first: number[];
				  }
				| undefined;
			clusterImpl = (embeddings, dimension, threshold, min) => {
				received = {
					length: embeddings.length,
					dimension,
					threshold,
					min,
					first: [embeddings[0], embeddings[1]].map((value) =>
						Math.fround(value),
					),
				};
				// Remaining faces in id order: below, loneA, loneB, loneC.
				return [[1, 2]];
			};
			expect(clusterFaces(db, clusterImpl)).toEqual({
				assigned: 2,
				clustered: 2,
				created: 1,
				deleted: 1,
			});
			expect(received).toEqual({
				length: 4 * DIMENSION,
				dimension: DIMENSION,
				threshold: FACE_CLUSTER_THRESHOLD,
				min: FACE_MIN_CLUSTER_SIZE,
				first: [
					Math.fround(float32Below(FACE_ASSIGN_THRESHOLD)),
					Math.fround(Math.sqrt(1 - float32Below(FACE_ASSIGN_THRESHOLD) ** 2)),
				],
			});
			expect(faceRow(atThreshold)).toMatchObject({
				personId: ann,
				assignment: "auto",
			});
			expect(faceRow(belowThreshold)).toMatchObject({
				personId: null,
				assignment: "auto",
			});
			expect(faceRow(toCara)).toMatchObject({
				personId: cara,
				assignment: "auto",
			});
			expect(faceRow(rejected)).toMatchObject({
				personId: null,
				assignment: "rejected",
			});
			expect(faceRow(manualElsewhere)).toMatchObject({
				personId: cara,
				assignment: "manual",
			});
			const created = faceRow(loneA)?.personId;
			expect(created).not.toBeNull();
			expect(faceRow(loneB)).toMatchObject({
				personId: created,
				assignment: "auto",
			});
			expect(faceRow(loneC)?.personId).toBeNull();
			expect(getPerson(db, created as number)).toMatchObject({
				name: null,
				faceCount: 2,
			});
			expect(getPerson(db, emptyUnnamed)).toBeNull();
			expect(getPerson(db, emptyNamed)).toMatchObject({
				name: "Kept",
				faceCount: 0,
			});

			// Centroids include auto members: with `atThreshold` in Ann's centroid,
			// the face just below the threshold now joins her on the next run.
			clusterImpl = () => [];
			expect(clusterFaces(db, clusterImpl)).toEqual({
				assigned: 1,
				clustered: 0,
				created: 0,
				deleted: 0,
			});
			expect(faceRow(belowThreshold)).toMatchObject({
				personId: ann,
				assignment: "auto",
			});
			expect(faceRow(loneC)?.personId).toBeNull();
			expect(faceRow(rejected)).toMatchObject({
				personId: null,
				assignment: "rejected",
			});
			// Then the step is a fixed point.
			expect(clusterFaces(db, clusterImpl)).toEqual({
				assigned: 0,
				clustered: 0,
				created: 0,
				deleted: 0,
			});
		});

		test("no unassigned faces skips the clusterer", () => {
			addPerson(null);
			let calls = 0;
			expect(
				clusterFaces(db, () => {
					calls++;
					return [];
				}),
			).toEqual({ assigned: 0, clustered: 0, created: 0, deleted: 1 });
			expect(calls).toBe(0);
		});
	});

	describe("people", () => {
		test("orders named first, then photo count, then id; counts stacked photos; hides hidden", async () => {
			const one = addPhoto("p/one.jpg");
			const two = addPhoto("p/two.jpg");
			const pairJpg = addPhoto("p/pair.jpg");
			addPhoto("p/pair.arw");
			const zed = addPerson("Zed");
			const amy = addPerson("Amy");
			const unnamedBig = addPerson(null);
			const unnamedSmall = addPerson(null);
			const hidden = addPerson("Hidden", true);
			addPerson(null); // no faces: omitted
			const namedEmpty = addPerson("Empty");
			addFace(one.id, { personId: zed, score: 0.5 });
			const zedCover = addFace(one.id, { personId: zed, score: 0.95 });
			addFace(two.id, { personId: zed, score: 0.95 });
			addFace(pairJpg.id, { personId: zed, score: 0.7, assignment: "manual" });
			const amyCover = addFace(one.id, { personId: amy });
			for (const photo of [one, two, pairJpg]) {
				addFace(photo.id, { personId: unnamedBig });
			}
			addFace(two.id, { personId: unnamedSmall });
			addFace(two.id, { personId: hidden });

			const visible = listPeople(db).people;
			expect(visible.map((person) => person.id)).toEqual([
				zed,
				amy,
				namedEmpty,
				unnamedBig,
				unnamedSmall,
			]);
			expect(visible[0]).toEqual({
				id: zed,
				name: "Zed",
				hidden: false,
				photoCount: 3,
				faceCount: 4,
				coverFaceId: zedCover,
			});
			expect(visible[1]).toMatchObject({
				photoCount: 1,
				coverFaceId: amyCover,
			});
			expect(visible[2]).toEqual({
				id: namedEmpty,
				name: "Empty",
				hidden: false,
				photoCount: 0,
				faceCount: 0,
				coverFaceId: null,
			});
			// photoCount equals the stacked personId listing total.
			expect((await listPhotos(db, { personId: zed })).total).toBe(3);
			expect(
				listPeople(db, { includeHidden: true }).people.map((p) => p.id),
			).toEqual([zed, amy, hidden, namedEmpty, unnamedBig, unnamedSmall]);
			expect(
				(await caller.people({ includeHidden: true })).people,
			).toHaveLength(6);
			expect((await caller.people()).people).toEqual(visible);
			expect(await caller.person({ id: hidden })).toMatchObject({
				hidden: true,
			});
			expect(await trpcCode(caller.person({ id: 999_999 }))).toBe("NOT_FOUND");

			const v1 = await send("GET", "/people");
			expect(v1).toEqual({ status: 200, body: { people: visible } });
			expect(
				(await send("GET", "/people?includeHidden=true")).body.people,
			).toHaveLength(6);
			expect((await send("GET", "/people?includeHidden=yes")).status).toBe(400);
			expect(await send("GET", `/people/${zed}`)).toEqual({
				status: 200,
				body: visible[0],
			});
			expect(await send("GET", "/people/999999")).toEqual({
				status: 404,
				body: {
					error: { code: "PERSON_NOT_FOUND", message: "Person not found" },
				},
			});
			expect((await send("GET", "/people/abc")).status).toBe(400);
		});

		test("updatePerson trims, clears, hides, and validates", async () => {
			const id = addPerson(null);
			expect(updatePerson(db, id, { name: "  Ann  " })).toMatchObject({
				name: "Ann",
				hidden: false,
			});
			expect(updatePerson(db, id, { hidden: true })).toMatchObject({
				name: "Ann",
				hidden: true,
			});
			expect(updatePerson(db, id, { name: null })).toMatchObject({
				name: null,
				hidden: true,
			});
			expect(
				await caller.updatePerson({ id, name: "B", hidden: false }),
			).toMatchObject({
				name: "B",
				hidden: false,
			});
			expect(() => updatePerson(db, id, { name: "   " })).toThrow(RangeError);
			expect(() => updatePerson(db, id, { name: "x".repeat(81) })).toThrow(
				RangeError,
			);
			expect(updatePerson(db, id, { name: "x".repeat(80) }).name).toHaveLength(
				80,
			);
			expect(() => updatePerson(db, 999_999, { hidden: true })).toThrow(
				FaceError,
			);
			expect(await trpcCode(caller.updatePerson({ id, name: " " }))).toBe(
				"BAD_REQUEST",
			);
			expect(await trpcCode(caller.updatePerson({ id: 999_999 }))).toBe(
				"NOT_FOUND",
			);
			expect(
				await send("PATCH", `/people/${id}`, { name: " Cy ", hidden: true }),
			).toEqual({
				status: 200,
				body: expect.objectContaining({ name: "Cy", hidden: true }),
			});
			for (const body of [
				{ name: "" },
				{ name: 3 },
				{ hidden: "yes" },
				{ other: 1 },
			]) {
				expect((await send("PATCH", `/people/${id}`, body)).status).toBe(400);
			}
			expect(
				(await send("PATCH", "/people/999999", { hidden: true })).status,
			).toBe(404);
		});

		test("mergePeople moves faces as manual, deletes sources, and inherits a name", async () => {
			const photo = addPhoto("m/one.jpg");
			const target = addPerson(null);
			const unnamedSource = addPerson(null);
			const firstNamed = addPerson("First");
			const secondNamed = addPerson("Second");
			addFace(photo.id, { personId: target });
			const moved = [
				addFace(photo.id, { personId: unnamedSource }),
				addFace(photo.id, { personId: secondNamed, assignment: "manual" }),
				addFace(photo.id, { personId: firstNamed }),
			];
			// The first named source in sourceIds order wins.
			const merged = mergePeople(db, target, [
				unnamedSource,
				secondNamed,
				firstNamed,
			]);
			expect(merged).toMatchObject({
				id: target,
				name: "Second",
				faceCount: 4,
			});
			for (const face of moved) {
				expect(faceRow(face)).toMatchObject({
					personId: target,
					assignment: "manual",
				});
			}
			for (const source of [unnamedSource, firstNamed, secondNamed]) {
				expect(getPerson(db, source)).toBeNull();
			}
			// A named target keeps its name.
			const other = addPerson("Other");
			expect(mergePeople(db, target, [other]).name).toBe("Second");

			for (const sources of [
				[],
				[target],
				[other, other],
				Array.from({ length: 51 }, (_, i) => 1000 + i),
			]) {
				expect(() => mergePeople(db, target, sources)).toThrow(RangeError);
			}
			const survivor = addPerson("Survivor");
			addFace(photo.id, { personId: survivor });
			expect(() => mergePeople(db, target, [survivor, 999_999])).toThrow(
				FaceError,
			);
			// The failed merge changed nothing.
			expect(getPerson(db, survivor)).toMatchObject({ faceCount: 1 });
			expect(() => mergePeople(db, 999_999, [survivor])).toThrow(FaceError);

			expect(
				await trpcCode(
					caller.mergePeople({ targetId: target, sourceIds: [target] }),
				),
			).toBe("BAD_REQUEST");
			expect(
				await trpcCode(
					caller.mergePeople({ targetId: target, sourceIds: [999_999] }),
				),
			).toBe("NOT_FOUND");
			expect(
				await send("POST", `/people/${target}/merge`, {
					sourceIds: [survivor],
				}),
			).toEqual({
				status: 200,
				body: expect.objectContaining({ id: target, faceCount: 5 }),
			});
			for (const body of [
				{ sourceIds: [] },
				{ sourceIds: [target] },
				{ sourceIds: [5, 5] },
				{ sourceIds: [0] },
				{},
			]) {
				expect(
					(await send("POST", `/people/${target}/merge`, body)).status,
				).toBe(400);
			}
			expect(
				(
					await send("POST", `/people/${target}/merge`, {
						sourceIds: [999_999],
					})
				).status,
			).toBe(404);
		});

		test("assignFace assigns, creates a named person, or rejects; 404s for unknown ids", async () => {
			const photo = addPhoto("x/one.jpg");
			const ann = addPerson("Ann");
			const right = addFace(photo.id, { box: { x: 0.7 } });
			const left = addFace(photo.id, { box: { x: 0.2 } });
			expect(assignFace(db, right, { personId: ann })).toEqual({
				id: right,
				box: { x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
				personId: ann,
				personName: "Ann",
				assignment: "manual",
			});
			const named = assignFace(db, left, { name: "  Newcomer " });
			expect(named).toMatchObject({
				personName: "Newcomer",
				assignment: "manual",
			});
			expect(getPerson(db, named.personId as number)).toMatchObject({
				name: "Newcomer",
				faceCount: 1,
			});
			expect(assignFace(db, right, { personId: null })).toMatchObject({
				personId: null,
				personName: null,
				assignment: "rejected",
			});
			// Left to right by x.
			expect(getPhotoFaces(db, photo.id)?.faces.map((face) => face.id)).toEqual(
				[left, right],
			);
			expect(getPhotoFaces(db, 999_999)).toBeNull();
			expect(() => assignFace(db, 999_999, { personId: ann })).toThrow(
				FaceError,
			);
			expect(() => assignFace(db, right, { personId: 999_999 })).toThrow(
				FaceError,
			);
			expect(() => assignFace(db, right, {})).toThrow(RangeError);
			expect(() =>
				assignFace(db, right, { personId: ann, name: "Both" }),
			).toThrow(RangeError);

			expect(
				await caller.assignFace({ faceId: right, personId: ann }),
			).toMatchObject({
				personId: ann,
			});
			expect(await trpcCode(caller.assignFace({ faceId: right }))).toBe(
				"BAD_REQUEST",
			);
			expect(
				await trpcCode(caller.assignFace({ faceId: 999_999, personId: null })),
			).toBe("NOT_FOUND");
			expect(
				(await caller.photoFaces({ photoId: photo.id })).faces,
			).toHaveLength(2);
			expect(await trpcCode(caller.photoFaces({ photoId: 999_999 }))).toBe(
				"NOT_FOUND",
			);

			expect(
				await send("PUT", `/faces/${right}/person`, { personId: null }),
			).toEqual({
				status: 200,
				body: expect.objectContaining({
					id: right,
					personId: null,
					assignment: "rejected",
				}),
			});
			expect(
				(await send("PUT", `/faces/${right}/person`, { name: "Via V1" })).body,
			).toMatchObject({ personName: "Via V1", assignment: "manual" });
			for (const body of [
				{},
				{ personId: ann, name: "x" },
				{ name: " " },
				{ personId: 0 },
			]) {
				expect((await send("PUT", `/faces/${right}/person`, body)).status).toBe(
					400,
				);
			}
			expect(
				await send("PUT", "/faces/999999/person", { personId: ann }),
			).toEqual({
				status: 404,
				body: { error: { code: "FACE_NOT_FOUND", message: "Face not found" } },
			});
			expect(
				await send("PUT", `/faces/${right}/person`, { personId: 999_999 }),
			).toEqual({
				status: 404,
				body: {
					error: { code: "PERSON_NOT_FOUND", message: "Person not found" },
				},
			});
			expect(await send("GET", `/photos/${photo.id}/faces`)).toEqual({
				status: 200,
				body: { faces: getPhotoFaces(db, photo.id)?.faces },
			});
			expect((await send("GET", "/photos/999999/faces")).status).toBe(404);
		});

		test("deleting a person keeps its faces unassigned; deleting a photo removes its faces", () => {
			const photo = addPhoto("y/one.jpg");
			const ann = addPerson("Ann");
			const face = addFace(photo.id, { personId: ann });
			db.delete(people).where(eq(people.id, ann)).run();
			expect(faceRow(face)?.personId).toBeNull();
			db.delete(photos).where(eq(photos.id, photo.id)).run();
			expect(faceRow(face)).toBeUndefined();
		});
	});

	describe("personId filter (tag precedent)", () => {
		let photoIds: Record<string, number>;
		let ann: number;
		beforeEach(() => {
			ann = addPerson("Ann");
			const bob = addPerson("Bob");
			photoIds = {};
			for (const [name, path, vector, owners] of [
				["a", "trips/a.jpg", [1, 0, 0, 0], [ann]],
				["b", "trips/b.jpg", [0.9, 0.1, 0, 0], [ann, bob]],
				["c", "home/c.jpg", [0.8, 0.2, 0, 0], [bob]],
				["d", "home/d.jpg", [0, 1, 0, 0], []],
			] as const) {
				const photo = addPhoto(path, {
					embeddingStatus: "completed",
					thumbnailKey: `key-${name}`,
				});
				photoIds[name] = photo.id;
				db.insert(photoEmbedding)
					.values({
						photoId: photo.id,
						embedding: Buffer.from(new Float32Array(vector).buffer),
						modelVersion: EMBEDDING_MODEL_VERSION,
						thumbnailKey: `key-${name}`,
						createdAt: new Date(0),
					})
					.run();
				for (const owner of owners) addFace(photo.id, { personId: owner });
			}
		});

		test("listing filters on service, tRPC and v1 and composes with folder", async () => {
			expect(ids(await listPhotos(db, { personId: ann }))).toEqual([
				photoIds.a,
				photoIds.b,
			]);
			expect(
				ids(await caller.photos({ personId: ann, folder: "trips" })),
			).toEqual([photoIds.a, photoIds.b]);
			expect((await listPhotos(db, { personId: 999_999 })).total).toBe(0);
			const response = await send("GET", `/photos?personId=${ann}`);
			expect(response.status).toBe(200);
			expect(ids(response.body)).toEqual([photoIds.a, photoIds.b]);
			for (const invalid of ["0", "-1", "abc", "1.5"]) {
				expect((await send("GET", `/photos?personId=${invalid}`)).status).toBe(
					400,
				);
			}
			await expect(caller.photos({ personId: 0 })).rejects.toThrow();
			expect((await caller.photoLocations({ personId: ann })).total).toBe(0);
			expect((await caller.gearStats({ personId: ann })).total).toBe(2);
			expect((await send("GET", `/locations?personId=${ann}`)).status).toBe(
				200,
			);
			expect((await send("GET", `/gear-stats?personId=${ann}`)).status).toBe(
				200,
			);
		});

		test("search and similar photos honor personId before LIMIT", async () => {
			queryVector = [0, 1, 0, 0];
			const unfiltered = await caller.searchPhotos({ query: "x", limit: 1 });
			expect(unfiltered.photos.map((photo) => photo.id)).toEqual([photoIds.d]);
			const filtered = await caller.searchPhotos({
				query: "x",
				limit: 1,
				personId: ann,
			});
			expect(filtered.photos.map((photo) => photo.id)).toEqual([photoIds.b]);
			const v1 = await send("POST", "/search", {
				query: "x",
				limit: 10,
				personId: ann,
			});
			expect(v1.status).toBe(200);
			expect(v1.body.photos.map((photo: { id: number }) => photo.id)).toEqual([
				photoIds.b,
				photoIds.a,
			]);
			expect(
				(await send("POST", "/search", { query: "x", personId: 0 })).status,
			).toBe(400);
			const similar = await findSimilarToPhoto(db, photoIds.a, 10, {
				personId: ann,
			});
			expect(similar?.photos.map((photo) => photo.id)).toEqual([photoIds.b]);
			expect(
				(
					await caller.similarPhotos({ photoId: photoIds.c, personId: ann })
				).photos.map((photo) => photo.id),
			).toEqual([photoIds.b, photoIds.a]);
			const v1Similar = await send(
				"GET",
				`/photos/${photoIds.d}/similar?personId=${ann}`,
			);
			expect(
				v1Similar.body.photos.map((photo: { id: number }) => photo.id),
			).toEqual([photoIds.b, photoIds.a]);
		});

		test("smart albums save personId like tag and count its photos", async () => {
			const album = createSmartAlbum(db, {
				name: "Ann",
				filters: { personId: ann },
			});
			expect(album).toMatchObject({
				filters: { personId: ann },
				photoCount: 2,
			});
			expect(() =>
				createSmartAlbum(db, { name: "Bad", filters: { personId: 0 } }),
			).toThrow(RangeError);
			expect(
				await caller.createSmartAlbum({
					name: "Ann 2",
					filters: { personId: ann },
				}),
			).toMatchObject({ photoCount: 2 });
			expect(
				await trpcCode(
					caller.createSmartAlbum({ name: "Bad", filters: { personId: -1 } }),
				),
			).toBe("BAD_REQUEST");
			const created = await send("POST", "/smart-albums", {
				name: "Ann 3",
				filters: { personId: ann, folder: "trips" },
			});
			expect(created.status).toBe(201);
			expect(created.body).toMatchObject({
				filters: { personId: ann, folder: "trips" },
				photoCount: 2,
			});
			expect(
				(
					await send("POST", "/smart-albums", {
						name: "Bad",
						filters: { personId: "1" },
					})
				).status,
			).toBe(400);
		});
	});

	describe("face crop route", () => {
		const renders: unknown[][] = [];
		let renderImpl: () => Promise<Uint8Array<ArrayBuffer>> = async () =>
			new Uint8Array([82, 73, 70, 70]);
		const crops = new Hono();
		crops.route(
			"/api",
			createFacesRouter({
				database: db,
				thumbnailsDirectory: "/unused",
				renderer: {
					run: async (...args) => {
						renders.push(args);
						return renderImpl();
					},
				},
			}),
		);
		beforeEach(() => {
			renders.length = 0;
			renderImpl = async () => new Uint8Array([82, 73, 70, 70]);
		});

		function addCroppableFace() {
			const photo = addPhoto("crop/one.jpg", {
				thumbnailKey: ".versions/u9/photo.jpg",
				thumbnailRoot: thumbnailsRoot,
			});
			const face = addFace(photo.id, {
				box: { x: 0.25, y: 0.5, width: 0.125, height: 0.25 },
			});
			db.update(photoFaces)
				.set({ thumbnailKey: ".versions/u9/photo.jpg" })
				.where(eq(photoFaces.id, face))
				.run();
			const file = join(thumbnailsRoot, "large/.versions/u9/photo.webp");
			mkdirSync(join(thumbnailsRoot, "large/.versions/u9"), {
				recursive: true,
			});
			writeFileSync(file, "webp");
			return { face, file };
		}

		test("renders the face's generation with immutable caching headers", async () => {
			const { face, file } = addCroppableFace();
			const response = await crops.request(`/api/faces/${face}/crop`);
			expect(response.status).toBe(200);
			expect(Object.fromEntries(response.headers)).toMatchObject({
				"content-type": "image/webp",
				"content-length": "4",
				"cache-control": "public, max-age=31536000, immutable",
				etag: `"face-${face}-.versions/u9/photo.jpg-256"`,
			});
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				new Uint8Array([82, 73, 70, 70]),
			);
			expect(renders).toEqual([
				[
					"renderFaceCrop",
					file,
					{ x: 0.25, y: 0.5, width: 0.125, height: 0.25 },
					256,
				],
			]);
			const small = await crops.request(`/api/faces/${face}/crop?size=128`);
			expect(small.headers.get("etag")).toBe(
				`"face-${face}-.versions/u9/photo.jpg-128"`,
			);
			expect(renders.at(-1)?.[3]).toBe(128);
			const cached = await crops.request(`/api/faces/${face}/crop`, {
				headers: {
					"If-None-Match": `"face-${face}-.versions/u9/photo.jpg-256"`,
				},
			});
			expect(cached.status).toBe(304);
			expect(renders).toHaveLength(2);
		});

		test("400 for invalid ids and sizes, 404 for unknown faces or missing files, 503 when busy", async () => {
			const { face, file } = addCroppableFace();
			for (const path of [
				"/api/faces/abc/crop",
				"/api/faces/0/crop",
				`/api/faces/${face}/crop?size=64`,
				`/api/faces/${face}/crop?size=512`,
				`/api/faces/${face}/crop?size=`,
			]) {
				const response = await crops.request(path);
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual({
					error: {
						code: "INVALID_REQUEST",
						message: "Request validation failed",
					},
				});
			}
			const unknown = await crops.request("/api/faces/999999/crop");
			expect(unknown.status).toBe(404);
			expect(await unknown.json()).toEqual({
				error: { code: "FACE_NOT_FOUND", message: "Face not found" },
			});
			renderImpl = async () => {
				throw new FakeBusyError();
			};
			const busy = await crops.request(`/api/faces/${face}/crop`);
			expect(busy.status).toBe(503);
			expect(busy.headers.get("retry-after")).toBe("1");
			expect(busy.headers.get("cache-control")).toBe("no-store");
			expect(await busy.json()).toMatchObject({ error: { code: "FACE_BUSY" } });
			rmSync(file);
			const missing = await crops.request(`/api/faces/${face}/crop`);
			expect(missing.status).toBe(404);
		});
	});

	describe("v1 DTOs match the checked-in OpenAPI document", () => {
		test("schemas, routes and personId parameters", async () => {
			type JsonSchema = {
				required?: string[];
				properties?: Record<string, JsonSchema>;
				enum?: string[];
				$ref?: string;
			};
			const document = (await Bun.file(
				new URL("../routes/openapi-v1.json", import.meta.url),
			).json()) as {
				paths: Record<
					string,
					Record<
						string,
						{
							parameters?: {
								name: string;
								in: string;
								schema: { minimum?: number };
							}[];
							responses: Record<string, unknown>;
						}
					>
				>;
				components: { schemas: Record<string, JsonSchema> };
			};
			const schemas = document.components.schemas;
			const keys = (schema: { shape: Record<string, unknown> }) =>
				Object.keys(schema.shape).sort();
			expect([...(schemas.Person.required ?? [])].sort()).toEqual(
				keys(v1Schemas.personSchema),
			);
			expect(Object.keys(schemas.Person.properties ?? {}).sort()).toEqual(
				keys(v1Schemas.personSchema),
			);
			expect([...(schemas.Face.required ?? [])].sort()).toEqual(
				keys(v1Schemas.faceSchema),
			);
			expect(schemas.Face.properties?.assignment.enum).toEqual([
				"auto",
				"manual",
				"rejected",
			]);
			expect(schemas.PeopleResponse.required).toEqual(["people"]);
			expect(schemas.PhotoFacesResponse.required).toEqual(["faces"]);
			expect(
				Object.keys(schemas.UpdatePersonRequest.properties ?? {}).sort(),
			).toEqual(["hidden", "name"]);
			expect(schemas.MergePeopleRequest.required).toEqual(["sourceIds"]);
			expect(
				Object.keys(schemas.AssignFaceRequest.properties ?? {}).sort(),
			).toEqual(["name", "personId"]);
			const responses = (path: string, method: string) =>
				Object.keys(document.paths[path][method].responses).sort();
			expect(responses("/api/v1/people", "get")).toEqual(["200", "400", "500"]);
			expect(responses("/api/v1/people/{id}", "get")).toEqual([
				"200",
				"400",
				"404",
				"500",
			]);
			expect(responses("/api/v1/people/{id}", "patch")).toEqual([
				"200",
				"400",
				"404",
				"500",
			]);
			expect(responses("/api/v1/people/{id}/merge", "post")).toEqual([
				"200",
				"400",
				"404",
				"500",
			]);
			expect(responses("/api/v1/faces/{id}/person", "put")).toEqual([
				"200",
				"400",
				"404",
				"500",
			]);
			expect(responses("/api/v1/photos/{id}/faces", "get")).toEqual([
				"200",
				"400",
				"404",
				"500",
			]);
			// Wherever `tag` is a query parameter or filter property, `personId` is too.
			for (const [path, methods] of Object.entries(document.paths)) {
				for (const operation of Object.values(methods)) {
					const names = (operation.parameters ?? []).map((p) => p.name);
					expect([path, names.includes("personId")]).toEqual([
						path,
						names.includes("tag"),
					]);
				}
			}
			for (const name of [
				"SearchRequest",
				"SmartAlbumFilters",
				"SmartAlbumFiltersInput",
			]) {
				expect(schemas[name].properties?.personId).toBeDefined();
			}
			// Live DTOs parse through the runtime schemas the routes serialize with.
			const photo = addPhoto("dto/one.jpg");
			const person = addPerson("Dto");
			addFace(photo.id, { personId: person });
			const listed = (await send("GET", "/people")).body;
			expect(v1Schemas.peopleResponseSchema.strict().parse(listed)).toEqual(
				listed,
			);
			const facesBody = (await send("GET", `/photos/${photo.id}/faces`)).body;
			expect(Object.keys(facesBody.faces[0]).sort()).toEqual(
				keys(v1Schemas.faceSchema),
			);
			expect(Object.keys(facesBody.faces[0].box).sort()).toEqual(
				[...(schemas.FaceBox.required ?? [])].sort(),
			);
		});
	});

	test("perf: 20,000 photos, 30,000 faces, 300 people in a file database", async () => {
		const directory = mkdtempSync(join(tmpdir(), "photobrain-faces-perf-"));
		const file = new Database(join(directory, "perf.db"));
		try {
			file.run("PRAGMA journal_mode = WAL");
			// The logger records each statement with its bound parameters so EXPLAIN
			// QUERY PLAN runs exactly what the services ran.
			let captured: { query: string; params: unknown[] }[] | null = null;
			const perfDb = drizzle(file, {
				schema,
				logger: {
					logQuery: (query, params) => {
						captured?.push({ query, params });
					},
				},
			});
			migrate(perfDb, { migrationsFolder: MIGRATIONS_FOLDER });
			// Same schema and driver as the shared test database; only the logger differs.
			const database = perfDb as unknown as typeof db;
			const PHOTOS = 20_000;
			const PEOPLE = 300;
			const FACES_PER_PHOTO = 2;
			const FACED_PHOTOS = 15_000;
			const UNASSIGNED = 3_000;
			const insertPhoto = file.prepare(
				`INSERT INTO photos (path, name, size, created_at, modified_at, thumbnail_status, thumbnail_key, media_type)
				 VALUES (?, ?, 1, 0, 0, 'completed', ?, 'photo') RETURNING id`,
			);
			const insertPerson = file.prepare(
				"INSERT INTO people (name, hidden, created_at, updated_at) VALUES (?, 0, 0, 0)",
			);
			const insertFace = file.prepare(
				`INSERT INTO photo_faces (photo_id, thumbnail_key, model_version, x, y, width, height, score, embedding, person_id, assignment, created_at)
				 VALUES (?, 'k', ?, ?, 0.1, 0.1, 0.1, ?, ?, ?, 'auto', 0)`,
			);
			// Deterministic pseudo-random unit vectors: one base per person.
			let seed = 42;
			const random = () => {
				seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
				return seed / 2_147_483_648 - 0.5;
			};
			const normalize = (vector: Float32Array) => {
				let norm = 0;
				for (const value of vector) norm += value * value;
				const scale = 1 / Math.sqrt(norm);
				for (let i = 0; i < vector.length; i++) vector[i] *= scale;
				return vector;
			};
			const bases = Array.from({ length: PEOPLE }, () =>
				normalize(Float32Array.from({ length: DIMENSION }, random)),
			);
			const near = (base: Float32Array) =>
				normalize(base.map((value) => value + random() * 0.08));
			file.transaction(() => {
				for (let p = 0; p < PEOPLE; p++) {
					insertPerson.run(p % 2 === 0 ? `Person ${p}` : null);
				}
				let face = 0;
				const total = FACED_PHOTOS * FACES_PER_PHOTO;
				for (let index = 0; index < PHOTOS; index++) {
					const { id } = insertPhoto.get(
						`perf/${index % 50}/${index}.jpg`,
						`${index}.jpg`,
						`.versions/${index}.jpg`,
					) as { id: number };
					if (index >= FACED_PHOTOS) continue;
					for (let slot = 0; slot < FACES_PER_PHOTO; slot++, face++) {
						const person = face % PEOPLE;
						const unassigned = face >= total - UNASSIGNED;
						// Half the unassigned faces resemble a person; half are strangers.
						const embedding =
							unassigned && face % 2 === 1
								? normalize(Float32Array.from({ length: DIMENSION }, random))
								: near(bases[person]);
						insertFace.run(
							id,
							FACE_MODEL_VERSION,
							slot * 0.5,
							0.5 + random(),
							Buffer.from(embedding.buffer),
							unassigned ? null : person + 1,
						);
					}
				}
			})();
			file.run("ANALYZE");

			const capture = async (run: () => unknown) => {
				const statements: { query: string; params: unknown[] }[] = [];
				captured = statements;
				try {
					await run();
				} finally {
					captured = null;
				}
				return statements;
			};
			const plan = (statement: { query: string; params: unknown[] }) =>
				file
					.query<{ detail: string }, never[]>(
						`EXPLAIN QUERY PLAN ${statement.query}`,
					)
					.all(...(statement.params as never[]))
					.map((row) => row.detail)
					.join("\n");
			const time = async (run: () => unknown, repeat = 5) => {
				await run();
				const samples: number[] = [];
				for (let i = 0; i < repeat; i++) {
					const started = performance.now();
					await run();
					samples.push(performance.now() - started);
				}
				return samples.sort((a, b) => a - b)[Math.floor(repeat / 2)];
			};

			const [peopleStatement] = await capture(() => listPeople(database));
			const peoplePlan = plan(peopleStatement);
			const peopleMs = await time(() => listPeople(database));
			const peopleResult = listPeople(database).people;
			expect(peopleResult).toHaveLength(PEOPLE);
			expect(peopleMs).toBeLessThan(perfBudgetMs(30));

			const target = peopleResult[0].id;
			const listingStatement = (
				await capture(() => listPhotos(database, { personId: target }))
			).find((statement) => /from "photos"/i.test(statement.query));
			if (!listingStatement) throw new Error("listing statement not captured");
			const listingPlan = plan(listingStatement);
			expect(listingPlan).toMatch(
				/SEARCH photo_faces USING (COVERING )?INDEX idx_photo_faces_person_photo \(person_id=\?\)/,
			);
			expect(listingPlan).not.toMatch(/SCAN photos(\s|$)/m);
			const listingMs = await time(() =>
				listPhotos(database, { personId: target }),
			);
			expect((await listPhotos(database, { personId: target })).total).toBe(
				peopleResult[0].photoCount,
			);
			expect(listingMs).toBeLessThan(perfBudgetMs(50));

			// Cluster step (fake clusterer: no native time) over 3,000 unassigned faces.
			let clusterNativeMs = 0;
			const started = performance.now();
			const clustered = clusterFaces(database, (embeddings, dimension) => {
				const begin = performance.now();
				const count = embeddings.length / dimension;
				const groups: number[][] = [];
				for (let i = 0; i + 2 < count; i += 3) groups.push([i, i + 1, i + 2]);
				clusterNativeMs += performance.now() - begin;
				return groups;
			});
			const clusterMs = performance.now() - started - clusterNativeMs;
			expect(clustered.assigned).toBeGreaterThan(0);
			expect(clusterMs).toBeLessThan(perfBudgetMs(3_000));
			console.log(
				`${PERF_LOG_PREFIX} people (${PEOPLE} people, ${FACED_PHOTOS * FACES_PER_PHOTO} faces, ${PHOTOS} photos): ${peopleMs.toFixed(2)} ms median\n${peoplePlan}`,
			);
			console.log(
				`${PERF_LOG_PREFIX} listPhotos personId (${peopleResult[0].photoCount} rows incl. EXIF hydration): ${listingMs.toFixed(2)} ms median\n${listingPlan}`,
			);
			console.log(
				`${PERF_LOG_PREFIX} cluster-faces-v1 excluding native: ${clusterMs.toFixed(1)} ms (${JSON.stringify(clustered)})`,
			);
		} finally {
			file.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);

	test("migration 0018 creates the face tables and indexes", () => {
		const tables = sqlite
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'photo_faces' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		expect(tables).toEqual(
			expect.arrayContaining([
				"idx_photo_faces_person_photo",
				"idx_photo_faces_photo_id",
			]),
		);
		expect(
			sqlite
				.query<{ table: string; on_delete: string }, []>(
					'SELECT "table", on_delete FROM pragma_foreign_key_list(\'photo_faces\') ORDER BY "table"',
				)
				.all(),
		).toEqual([
			{ table: "people", on_delete: "SET NULL" },
			{ table: "photos", on_delete: "CASCADE" },
		]);
		expect(() =>
			db.run(
				sql`INSERT INTO photo_face_scan (photo_id, thumbnail_key, model_version, face_count, status, scanned_at) VALUES (1, 'k', 'm', 0, 'bogus', 0)`,
			),
		).toThrow();
	});
}
