import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import {
	collectionPhotos,
	collections,
	photoEmbedding,
	photoExif,
	photos,
} from "../db/schema";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[similar-perf]";

// Other suites mock ../services/vector-search process-wide; run the real module in
// an isolated child so these assertions exercise actual sqlite-vec SQL.
if (process.env.PHOTOBRAIN_SIMILAR_TEST_CHILD !== "1") {
	test("similar-photo KNN over real sqlite-vec vectors", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_SIMILAR_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
		for (const line of stdout.split("\n")) {
			if (line.startsWith(PERF_LOG_PREFIX)) console.log(line);
		}
	}, 60_000);
} else {
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);

	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => [1, 0, 0, 0],
	}));
	mock.module("../inngest/client", () => ({
		inngest: { send: async () => undefined },
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon and Inngest client before
	// these process-wide mocks are installed; this is an intentional loading boundary.
	const { findSimilarToPhoto } = await import("../services/vector-search");
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");

	const app = new Hono();
	app.route(
		"/api/v1",
		createV1Router({
			database: db,
			searchPhotos: async () => [],
			dispatchScan: async () => undefined,
			photoDirectory: "../../test-photos",
			thumbnailsDirectory: "./test-thumbnails",
			nativeScanMutationsEnabled: false,
		}),
	);
	const caller = appRouter.createCaller({ db });

	const PRIVATE_FIELDS = [
		"sourceRoot",
		"sourceFingerprint",
		"mediaVersion",
		"thumbnailKey",
		"thumbnailRoot",
		"thumbnailFingerprint",
	];

	type Vector = number[] | Float32Array;
	type PhotoFixture = {
		name: string;
		vector?: Vector;
		status?: string;
		model?: string;
		vectorKey?: string | null;
	};

	function addPhoto(name: string, status = "completed") {
		return db
			.insert(photos)
			.values({
				path: `similar/${name}`,
				name,
				size: 1,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
				embeddingStatus: status,
				sourceRoot: "/private/source",
				sourceFingerprint: `fp-${name}`,
				mediaVersion: "private-media",
				thumbnailKey: `key-${name}`,
				thumbnailRoot: "/private/thumbnails",
				thumbnailFingerprint: `thumb-${name}`,
			})
			.returning()
			.get();
	}

	function addVector(
		photoId: number,
		vector: Vector,
		model: string,
		vectorKey: string | null,
	) {
		const floats =
			vector instanceof Float32Array ? vector : new Float32Array(vector);
		db.insert(photoEmbedding)
			.values({
				photoId,
				embedding: Buffer.from(floats.buffer),
				modelVersion: model,
				thumbnailKey: vectorKey,
				createdAt: new Date(0),
			})
			.run();
	}

	function addFixture(fixture: PhotoFixture) {
		const photo = addPhoto(fixture.name, fixture.status);
		if (fixture.vector) {
			addVector(
				photo.id,
				fixture.vector,
				fixture.model ?? EMBEDDING_MODEL_VERSION,
				fixture.vectorKey === undefined
					? `key-${fixture.name}`
					: fixture.vectorKey,
			);
		}
		return photo.id;
	}

	function similarIds(result: { photos: Array<{ id: number }> } | null) {
		return result?.photos.map((photo) => photo.id);
	}

	async function responseJson(response: Response) {
		return JSON.parse(await response.text()) as unknown;
	}

	afterAll(() => sqlite.close());

	describe("findSimilarToPhoto", () => {
		// Unit axes in 4D: distances from SOURCE are exact and hand-checkable.
		const SOURCE = [1, 0, 0, 0];
		let ids: Record<string, number>;

		beforeEach(() => {
			db.delete(photoEmbedding).run();
			db.delete(photoExif).run();
			db.delete(photos).run();
			ids = {};
			for (const fixture of [
				{ name: "source.jpg", vector: SOURCE },
				{ name: "far.jpg", vector: [-1, 0, 0, 0] }, // distance 2
				{ name: "near.jpg", vector: [1, 0.1, 0, 0] }, // distance 0.1
				{ name: "twin.jpg", vector: [1, 0, 0, 0] }, // distance 0
				{ name: "mid.jpg", vector: [1, 0.2, 0, 0] }, // distance 0.2
				// Stale candidates sit at distance 0 so any leak would rank first.
				{ name: "old-model.jpg", vector: SOURCE, model: "clip-legacy" },
				{ name: "old-key.jpg", vector: SOURCE, vectorKey: "previous-gen" },
				{ name: "pending.jpg", vector: SOURCE, status: "pending" },
				{ name: "failed.jpg", vector: SOURCE, status: "failed" },
				{ name: "wrong-dims.jpg", vector: [1, 0] },
				{ name: "no-vector.jpg" },
			] satisfies PhotoFixture[]) {
				ids[fixture.name] = addFixture(fixture);
			}
			// Exactly tied candidates (distance 0.3). Insert embedding rows in reverse
			// photo-id order so only an explicit id tie-break yields tieLow first.
			ids["tie-low.jpg"] = addPhoto("tie-low.jpg").id;
			ids["tie-high.jpg"] = addPhoto("tie-high.jpg").id;
			addVector(
				ids["tie-high.jpg"],
				[1, 0, 0.3, 0],
				EMBEDDING_MODEL_VERSION,
				"key-tie-high.jpg",
			);
			addVector(
				ids["tie-low.jpg"],
				[1, 0, 0, 0.3],
				EMBEDDING_MODEL_VERSION,
				"key-tie-low.jpg",
			);
			db.insert(photoExif)
				.values({ photoId: ids["near.jpg"], cameraMake: "Fujifilm" })
				.run();
		});

		test("ranks valid neighbours nearest-first, excludes the source, and breaks ties by id", async () => {
			const result = await findSimilarToPhoto(db, ids["source.jpg"], 100);
			expect(similarIds(result)).toEqual([
				ids["twin.jpg"],
				ids["near.jpg"],
				ids["mid.jpg"],
				ids["tie-low.jpg"],
				ids["tie-high.jpg"],
				ids["far.jpg"],
			]);
			expect(result).toMatchObject({
				total: 6,
				sourcePhotoId: ids["source.jpg"],
				indexed: true,
			});
			const near = result?.photos.find((photo) => photo.id === ids["near.jpg"]);
			expect(near?.exif?.cameraMake).toBe("Fujifilm");
			expect(
				result?.photos.find((photo) => photo.id === ids["twin.jpg"])?.exif,
			).toBeNull();
			for (const photo of result?.photos ?? []) {
				for (const key of PRIVATE_FIELDS) expect(photo).not.toHaveProperty(key);
			}
		});

		test("respects the limit after ordering", async () => {
			expect(
				similarIds(await findSimilarToPhoto(db, ids["source.jpg"], 2)),
			).toEqual([ids["twin.jpg"], ids["near.jpg"]]);
			const four = await findSimilarToPhoto(db, ids["source.jpg"], 4);
			expect(similarIds(four)).toEqual([
				ids["twin.jpg"],
				ids["near.jpg"],
				ids["mid.jpg"],
				ids["tie-low.jpg"],
			]);
			expect(four?.total).toBe(4);
		});

		test("reports stale or missing source vectors as not indexed", async () => {
			for (const name of [
				"old-model.jpg",
				"old-key.jpg",
				"pending.jpg",
				"failed.jpg",
				"no-vector.jpg",
			]) {
				expect(await findSimilarToPhoto(db, ids[name], 30)).toEqual({
					photos: [],
					total: 0,
					sourcePhotoId: ids[name],
					indexed: false,
				});
			}
		});

		test("a source whose only neighbours are stale is indexed with no results", async () => {
			const valid = [
				"source.jpg",
				"twin.jpg",
				"near.jpg",
				"mid.jpg",
				"far.jpg",
			];
			db.delete(photos)
				.where(
					inArray(
						photos.id,
						[...valid, "tie-high.jpg"].map((name) => ids[name]),
					),
				)
				.run();
			expect(await findSimilarToPhoto(db, ids["tie-low.jpg"], 30)).toEqual({
				photos: [],
				total: 0,
				sourcePhotoId: ids["tie-low.jpg"],
				indexed: true,
			});
		});

		test("returns null for an unknown photo id", async () => {
			expect(await findSimilarToPhoto(db, 999_999, 30)).toBeNull();
		});

		test("tRPC similarPhotos returns the service result, validates input, and maps unknown ids to NOT_FOUND", async () => {
			const result = await caller.similarPhotos({
				photoId: ids["source.jpg"],
				limit: 3,
			});
			expect(similarIds(result)).toEqual([
				ids["twin.jpg"],
				ids["near.jpg"],
				ids["mid.jpg"],
			]);
			expect(result.indexed).toBe(true);
			expect(
				(await caller.similarPhotos({ photoId: ids["source.jpg"] })).total,
			).toBe(6);

			const missing = await caller
				.similarPhotos({ photoId: 999_999 })
				.catch((error: unknown) => error);
			expect(missing).toBeInstanceOf(TRPCError);
			expect((missing as TRPCError).code).toBe("NOT_FOUND");

			for (const input of [
				{ photoId: ids["source.jpg"], limit: 0 },
				{ photoId: ids["source.jpg"], limit: 101 },
				{ photoId: 0 },
				{ photoId: 1.5 },
			]) {
				const invalid = await caller
					.similarPhotos(input)
					.catch((error: unknown) => error);
				expect((invalid as TRPCError).code).toBe("BAD_REQUEST");
			}
		});

		test("v1 GET /photos/:id/similar serializes public DTOs and is routed separately from photo detail", async () => {
			const response = await app.request(
				`/api/v1/photos/${ids["source.jpg"]}/similar?limit=3`,
			);
			expect(response.status).toBe(200);
			const body = (await responseJson(response)) as {
				photos: Array<Record<string, unknown>>;
				total: number;
				sourcePhotoId: number;
				indexed: boolean;
			};
			expect(Object.keys(body).sort()).toEqual([
				"indexed",
				"photos",
				"sourcePhotoId",
				"total",
			]);
			expect(body.photos.map((photo) => photo.id)).toEqual([
				ids["twin.jpg"],
				ids["near.jpg"],
				ids["mid.jpg"],
			]);
			expect(body).toMatchObject({
				total: 3,
				sourcePhotoId: ids["source.jpg"],
				indexed: true,
			});
			expect(body.photos[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
			for (const photo of body.photos) {
				for (const key of PRIVATE_FIELDS) expect(photo).not.toHaveProperty(key);
			}

			const defaultLimit = (await responseJson(
				await app.request(`/api/v1/photos/${ids["source.jpg"]}/similar`),
			)) as { total: number };
			expect(defaultLimit.total).toBe(6);

			const notIndexed = await app.request(
				`/api/v1/photos/${ids["pending.jpg"]}/similar`,
			);
			expect(notIndexed.status).toBe(200);
			expect(await responseJson(notIndexed)).toEqual({
				photos: [],
				total: 0,
				sourcePhotoId: ids["pending.jpg"],
				indexed: false,
			});

			const detail = await app.request(`/api/v1/photos/${ids["source.jpg"]}`);
			expect(detail.status).toBe(200);
			expect(await responseJson(detail)).toMatchObject({
				id: ids["source.jpg"],
				name: "source.jpg",
			});
		});

		test("v1 similar returns stable 404 and 400 envelopes", async () => {
			const missing = await app.request("/api/v1/photos/999999/similar");
			expect(missing.status).toBe(404);
			expect(await responseJson(missing)).toEqual({
				error: { code: "PHOTO_NOT_FOUND", message: "Photo not found" },
			});

			for (const path of [
				`/api/v1/photos/${ids["source.jpg"]}/similar?limit=0`,
				`/api/v1/photos/${ids["source.jpg"]}/similar?limit=101`,
				`/api/v1/photos/${ids["source.jpg"]}/similar?limit=2.5`,
				`/api/v1/photos/${ids["source.jpg"]}/similar?limit=many`,
				"/api/v1/photos/abc/similar",
				"/api/v1/photos/0/similar",
			]) {
				const response = await app.request(path);
				expect(response.status).toBe(400);
				expect(await responseJson(response)).toEqual({
					error: {
						code: "INVALID_REQUEST",
						message: "Request validation failed",
					},
				});
			}
		});

		test("minRating and flag filter candidates before LIMIT, never the source", async () => {
			const curate = (
				name: string,
				rating: number,
				flag: "pick" | "reject" | null,
			) =>
				db
					.update(photos)
					.set({ rating, flag })
					.where(eq(photos.id, ids[name]))
					.run();
			// The source itself is unrated/unflagged, so filters cannot hide it.
			curate("far.jpg", 5, "pick");
			curate("mid.jpg", 4, "reject");
			curate("tie-high.jpg", 3, null);
			curate("near.jpg", 1, "pick");
			// Stale candidate that matches every filter must still be excluded.
			curate("old-model.jpg", 5, "pick");
			const source = ids["source.jpg"];

			expect(
				similarIds(await findSimilarToPhoto(db, source, 100, { minRating: 3 })),
			).toEqual([ids["mid.jpg"], ids["tie-high.jpg"], ids["far.jpg"]]);
			expect(
				similarIds(await findSimilarToPhoto(db, source, 1, { minRating: 3 })),
			).toEqual([ids["mid.jpg"]]);
			expect(
				similarIds(await findSimilarToPhoto(db, source, 100, { flag: "pick" })),
			).toEqual([ids["near.jpg"], ids["far.jpg"]]);
			expect(
				similarIds(
					await findSimilarToPhoto(db, source, 100, { flag: "unflagged" }),
				),
			).toEqual([ids["twin.jpg"], ids["tie-low.jpg"], ids["tie-high.jpg"]]);
			expect(
				similarIds(
					await findSimilarToPhoto(db, source, 100, {
						minRating: 1,
						flag: "pick",
					}),
				),
			).toEqual([ids["near.jpg"], ids["far.jpg"]]);
			const filtered = await findSimilarToPhoto(db, source, 100, {
				minRating: 5,
				flag: "reject",
			});
			expect(filtered).toEqual({
				photos: [],
				total: 0,
				sourcePhotoId: source,
				indexed: true,
			});

			const viaTrpc = await caller.similarPhotos({
				photoId: source,
				limit: 100,
				flag: "pick",
			});
			expect(similarIds(viaTrpc)).toEqual([ids["near.jpg"], ids["far.jpg"]]);
			expect(viaTrpc.photos[0]).toMatchObject({ rating: 1, flag: "pick" });

			const response = await app.request(
				`/api/v1/photos/${source}/similar?minRating=3&flag=reject`,
			);
			expect(response.status).toBe(200);
			expect(await responseJson(response)).toMatchObject({
				photos: [{ id: ids["mid.jpg"], rating: 4, flag: "reject" }],
				total: 1,
				indexed: true,
			});

			for (const query of [
				"minRating=0",
				"minRating=6",
				"minRating=2.5",
				"flag=maybe",
			]) {
				const invalid = await app.request(
					`/api/v1/photos/${source}/similar?${query}`,
				);
				expect(invalid.status).toBe(400);
			}
			await expect(
				caller.similarPhotos({ photoId: source, minRating: 0 }),
			).rejects.toThrow(TRPCError);
		});

		test("collectionId restricts candidates to members before LIMIT, never the source", async () => {
			const now = new Date();
			const collection = db
				.insert(collections)
				.values({
					name: `Similar ${now.getTime()}`,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
				.get();
			// The source is not a member; stale old-model.jpg is a member at distance 0.
			for (const name of ["far.jpg", "mid.jpg", "old-model.jpg"]) {
				db.insert(collectionPhotos)
					.values({
						collectionId: collection.id,
						photoId: ids[name],
						addedAt: now,
					})
					.run();
			}
			const source = ids["source.jpg"];
			expect(
				similarIds(
					await findSimilarToPhoto(db, source, 100, {
						collectionId: collection.id,
					}),
				),
			).toEqual([ids["mid.jpg"], ids["far.jpg"]]);
			expect(
				similarIds(
					await findSimilarToPhoto(db, source, 1, {
						collectionId: collection.id,
					}),
				),
			).toEqual([ids["mid.jpg"]]);

			const viaTrpc = await caller.similarPhotos({
				photoId: source,
				collectionId: collection.id,
			});
			expect(similarIds(viaTrpc)).toEqual([ids["mid.jpg"], ids["far.jpg"]]);
			expect(viaTrpc.indexed).toBe(true);

			const response = await app.request(
				`/api/v1/photos/${source}/similar?collectionId=${collection.id}&limit=1`,
			);
			expect(response.status).toBe(200);
			expect(await responseJson(response)).toMatchObject({
				photos: [{ id: ids["mid.jpg"] }],
				total: 1,
				sourcePhotoId: source,
			});
			const unknown = await app.request(
				`/api/v1/photos/${source}/similar?collectionId=999999`,
			);
			expect(await responseJson(unknown)).toMatchObject({
				photos: [],
				total: 0,
				indexed: true,
			});
			for (const value of ["0", "-2", "1.5", "abc"]) {
				const invalid = await app.request(
					`/api/v1/photos/${source}/similar?collectionId=${value}`,
				);
				expect(invalid.status).toBe(400);
			}
		});
	});

	test("KNN over 8,000 random 512-dim vectors completes within 250 ms", async () => {
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photos).run();

		const COUNT = 8_000;
		const DIMENSIONS = 512;
		// Deterministic xorshift PRNG keeps the corpus reproducible across runs.
		let state = 0x9e3779b9;
		const random = () => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x1_0000_0000 - 0.5;
		};
		const insertPhoto = sqlite.prepare(
			`INSERT INTO photos (path, name, size, created_at, modified_at, embedding_status, thumbnail_key)
			 VALUES (?, ?, 1, 0, 0, 'completed', ?) RETURNING id`,
		);
		const insertVector = sqlite.prepare(
			`INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at)
			 VALUES (?, ?, ?, ?, 0)`,
		);
		const vectors: Float32Array[] = [];
		const photoIds: number[] = [];
		sqlite.transaction(() => {
			for (let index = 0; index < COUNT; index++) {
				const vector = new Float32Array(DIMENSIONS);
				for (let d = 0; d < DIMENSIONS; d++) vector[d] = random();
				const key = `perf-${index}`;
				const { id } = insertPhoto.get(
					`perf/${index}.jpg`,
					`${index}.jpg`,
					key,
				) as {
					id: number;
				};
				insertVector.run(
					id,
					Buffer.from(vector.buffer),
					EMBEDDING_MODEL_VERSION,
					key,
				);
				vectors.push(vector);
				photoIds.push(id);
			}
		})();

		const sourceIndex = 0;
		const started = performance.now();
		const result = await findSimilarToPhoto(db, photoIds[sourceIndex], 30);
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} findSimilarToPhoto over ${COUNT} x ${DIMENSIONS}-dim vectors (limit 30, incl. hydration): ${elapsed.toFixed(2)} ms`,
		);

		// Cross-check ranking against a brute-force JS reference.
		const source = vectors[sourceIndex];
		const expected = vectors
			.map((vector, index) => {
				let sum = 0;
				for (let d = 0; d < DIMENSIONS; d++) {
					const delta = vector[d] - source[d];
					sum += delta * delta;
				}
				return { id: photoIds[index], distance: Math.sqrt(sum) };
			})
			.filter((entry) => entry.id !== photoIds[sourceIndex])
			.sort((a, b) => a.distance - b.distance || a.id - b.id)
			.slice(0, 30)
			.map((entry) => entry.id);
		expect(similarIds(result)).toEqual(expected);
		expect(result?.indexed).toBe(true);
		expect(elapsed).toBeLessThan(250);
	}, 60_000);
}
