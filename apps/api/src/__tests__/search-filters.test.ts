import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import { photoEmbedding, photoExif, photos } from "../db/schema";
import type { PhotoFilters } from "../services/photo-catalog";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[search-filters-perf]";

// Other suites mock ../services/vector-search process-wide; run the real module in
// an isolated child so these assertions exercise actual sqlite-vec SQL.
if (process.env.PHOTOBRAIN_SEARCH_FILTERS_TEST_CHILD !== "1") {
	test("filtered semantic search over real sqlite-vec vectors", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_SEARCH_FILTERS_TEST_CHILD: "1" },
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

	// The text query embeds to this vector; the perf test swaps in a 512-dim query.
	let queryVector: number[] | Float32Array = [1, 0, 0, 0];
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => queryVector,
	}));
	mock.module("../inngest/client", () => ({
		inngest: { send: async () => undefined },
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon and Inngest client before
	// these process-wide mocks are installed; this is an intentional loading boundary.
	const { searchPhotosByText } = await import("../services/vector-search");
	const { listPhotos } = await import("../services/photo-catalog");
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");

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
	const caller = appRouter.createCaller({ db });

	type Exif = {
		cameraMake?: string;
		cameraModel?: string;
		lensModel?: string;
		iso?: number;
		dateTaken?: string;
	};
	type Fixture = {
		path: string;
		/** L2 distance from the [1, 0, 0, 0] query vector. */
		distance?: number;
		isRaw?: boolean;
		exif?: Exif;
	};

	const SONY: Exif = { cameraMake: "Sony", cameraModel: "ILCE-7M4" };
	const CANON: Exif = { cameraMake: "Canon", cameraModel: "Canon EOS R5" };
	// Rust EXIF stores `YYYY:MM:DD HH:MM:SS`.
	const FIXTURES: Record<string, Fixture> = {
		// Nearest overall, but nested one level below 2024/Trip.
		nested: {
			path: "2024/Trip/day1/nested.jpg",
			distance: 0,
			exif: {
				...SONY,
				lensModel: "FE 24-70",
				iso: 100,
				dateTaken: "2024:06:02 09:00:00",
			},
		},
		// Same-length sibling folders that only match if `_` / `%` act as wildcards.
		wildUnderscore: { path: "myXtrip/x.jpg", distance: 0.01 },
		wildPercent: { path: "100x/q.jpg", distance: 0.02 },
		other: {
			path: "2024/Other/other.jpg",
			distance: 0.05,
			exif: {
				...SONY,
				lensModel: "FE 24-70",
				iso: 100,
				dateTaken: "2024:06:03 09:00:00",
			},
		},
		a: {
			path: "2024/Trip/a.jpg",
			distance: 0.1,
			exif: {
				...SONY,
				lensModel: "FE 24-70",
				iso: 100,
				dateTaken: "2024:06:15 12:00:00",
			},
		},
		underscore: { path: "my_trip/u.jpg", distance: 0.12 },
		percent: { path: "100%/p.jpg", distance: 0.14 },
		b: {
			path: "2024/Trip/b.arw",
			distance: 0.2,
			isRaw: true,
			exif: {
				...SONY,
				lensModel: "FE 85",
				iso: 400,
				dateTaken: "2024:06:20 14:00:00",
			},
		},
		c: {
			path: "2024/Trip/c.jpg",
			distance: 0.3,
			exif: {
				...CANON,
				lensModel: "RF 15-35",
				iso: 100,
				dateTaken: "2024:07:01 08:00:00",
			},
		},
		noExif: { path: "2024/Trip/e.jpg", distance: 0.4 },
		// Matches every filter on a.jpg but has no vector, so search must skip it.
		unindexed: {
			path: "2024/Trip/unindexed.jpg",
			exif: {
				...SONY,
				lensModel: "FE 24-70",
				iso: 100,
				dateTaken: "2024:06:16 12:00:00",
			},
		},
	};
	const ALL_INDEXED = [
		"nested",
		"wildUnderscore",
		"wildPercent",
		"other",
		"a",
		"underscore",
		"percent",
		"b",
		"c",
		"noExif",
	];

	let ids: Record<string, number>;
	const names = (result: { photos: Array<{ id: number }> }) =>
		result.photos.map(
			(photo) =>
				Object.entries(ids).find(([, id]) => id === photo.id)?.[0] ?? photo.id,
		);

	function search(filters: PhotoFilters = {}, limit = 100) {
		return caller.searchPhotos({ query: "beach", limit, ...filters });
	}

	async function v1Search(body: Record<string, unknown>) {
		const response = await app.request("/api/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "beach", limit: 100, ...body }),
		});
		return {
			status: response.status,
			body: JSON.parse(await response.text()) as {
				photos: Array<Record<string, unknown> & { id: number }>;
				total: number;
				query: string;
			},
		};
	}

	afterAll(() => sqlite.close());

	beforeEach(() => {
		queryVector = [1, 0, 0, 0];
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photos).run();
		ids = {};
		for (const [name, fixture] of Object.entries(FIXTURES)) {
			const key = `key-${name}`;
			const photo = db
				.insert(photos)
				.values({
					path: fixture.path,
					name: fixture.path.split("/").at(-1) ?? fixture.path,
					size: 1,
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					modifiedAt: new Date("2026-01-02T00:00:00.000Z"),
					isRaw: fixture.isRaw ?? false,
					embeddingStatus: "completed",
					sourceRoot: "/private/source",
					sourceFingerprint: `fp-${name}`,
					mediaVersion: "private-media",
					thumbnailKey: key,
					thumbnailRoot: "/private/thumbnails",
					thumbnailFingerprint: `thumb-${name}`,
				})
				.returning()
				.get();
			ids[name] = photo.id;
			if (fixture.exif) {
				db.insert(photoExif)
					.values({ photoId: photo.id, ...fixture.exif })
					.run();
			}
			if (fixture.distance !== undefined) {
				db.insert(photoEmbedding)
					.values({
						photoId: photo.id,
						embedding: Buffer.from(
							new Float32Array([1, fixture.distance, 0, 0]).buffer,
						),
						modelVersion: EMBEDDING_MODEL_VERSION,
						thumbnailKey: key,
						createdAt: new Date(0),
					})
					.run();
			}
		}
	});

	describe("searchPhotos filters", () => {
		test("no-filter search ranks every indexed photo nearest-first, unchanged by explicit defaults", async () => {
			const unfiltered = await search();
			expect(names(unfiltered)).toEqual(ALL_INDEXED);
			expect(unfiltered.total).toBe(ALL_INDEXED.length);
			expect(unfiltered.query).toBe("beach");
			expect(names(await search({ filterRaw: "all" }))).toEqual(ALL_INDEXED);
			expect(
				(await searchPhotosByText(db, "beach", 3)).map((photo) => photo.id),
			).toEqual(["nested", "wildUnderscore", "wildPercent"].map((n) => ids[n]));
		});

		test.each([
			["filterRaw raw", { filterRaw: "raw" }, ["b"]],
			[
				"filterRaw standard",
				{ filterRaw: "standard" },
				ALL_INDEXED.filter((name) => name !== "b"),
			],
			[
				"camera (make prefixed)",
				{ camera: "Sony ILCE-7M4" },
				["nested", "other", "a", "b"],
			],
			["camera (model already prefixed)", { camera: "Canon EOS R5" }, ["c"]],
			["lens", { lens: "FE 24-70" }, ["nested", "other", "a"]],
			["iso", { iso: 100 }, ["nested", "other", "a", "c"]],
			[
				"dateMonth in stored Rust YYYY:MM form",
				{ dateMonth: "2024:06" },
				["nested", "other", "a", "b"],
			],
			[
				"folder (direct children only)",
				{ folder: "2024/Trip" },
				["a", "b", "c", "noExif"],
			],
		] as Array<
			[string, PhotoFilters, string[]]
		>)("%s narrows KNN results in distance order", async (_label, filters, expected) => {
			const result = await search(filters);
			expect(names(result)).toEqual(expected);
			expect(result.total).toBe(expected.length);
		});

		test("folder restriction applies before LIMIT so nearer nested photos take no slot", async () => {
			expect(names(await search({ folder: "2024/Trip" }, 1))).toEqual(["a"]);
			expect(names(await search({ folder: "2024/Trip" }, 2))).toEqual([
				"a",
				"b",
			]);
			expect(names(await search({ folder: "2024/Trip/day1" }, 1))).toEqual([
				"nested",
			]);
			expect(names(await search({ folder: "2024" }))).toEqual([]);
		});

		test("other filters also apply before LIMIT", async () => {
			expect(names(await search({ filterRaw: "raw" }, 1))).toEqual(["b"]);
			expect(names(await search({ camera: "Canon EOS R5" }, 1))).toEqual(["c"]);
		});

		test("combined filters AND together", async () => {
			expect(
				names(
					await search({
						folder: "2024/Trip",
						camera: "Sony ILCE-7M4",
						iso: 100,
					}),
				),
			).toEqual(["a"]);
			expect(
				names(await search({ folder: "2024/Trip", camera: "Sony ILCE-7M4" })),
			).toEqual(["a", "b"]);
			expect(
				names(
					await search(
						{
							camera: "Sony ILCE-7M4",
							filterRaw: "standard",
							dateMonth: "2024:06",
							lens: "FE 24-70",
						},
						2,
					),
				),
			).toEqual(["nested", "other"]);
			expect(
				names(
					await search({
						folder: "2024/Trip",
						camera: "Canon EOS R5",
						filterRaw: "raw",
					}),
				),
			).toEqual([]);
		});

		test("`_` and `%` in folder names match literally", async () => {
			expect(names(await search({ folder: "my_trip" }))).toEqual([
				"underscore",
			]);
			expect(names(await search({ folder: "100%" }))).toEqual(["percent"]);
			expect(names(await search({ folder: "myXtrip" }))).toEqual([
				"wildUnderscore",
			]);
		});

		test("search and listPhotos select the same photos for every filter", async () => {
			const cases: PhotoFilters[] = [
				{},
				{ filterRaw: "raw" },
				{ filterRaw: "standard" },
				{ folder: "2024/Trip" },
				{ folder: "my_trip" },
				{ folder: "100%" },
				{ camera: "Sony ILCE-7M4" },
				{ lens: "FE 24-70" },
				{ iso: 100 },
				{ dateMonth: "2024:06" },
				{ folder: "2024/Trip", camera: "Sony ILCE-7M4", iso: 100 },
			];
			const unindexed = ids.unindexed;
			for (const filters of cases) {
				const listed = (await listPhotos(db, filters)).photos
					.map((photo) => photo.id)
					.filter((id) => id !== unindexed)
					.sort((left, right) => left - right);
				const searched = (await search(filters)).photos
					.map((photo) => photo.id)
					.sort((left, right) => left - right);
				expect(searched).toEqual(listed);
			}
		});

		test("tRPC rejects invalid filterRaw and non-integer iso", async () => {
			await expect(
				caller.searchPhotos({
					query: "beach",
					filterRaw: "bogus" as "raw",
				}),
			).rejects.toThrow();
			await expect(
				caller.searchPhotos({ query: "beach", iso: 1.5 }),
			).rejects.toThrow();
			await expect(
				caller.searchPhotos({
					query: "beach",
					iso: "100" as unknown as number,
				}),
			).rejects.toThrow();
		});
	});

	describe("POST /api/v1/search filters", () => {
		test("matches tRPC ranking, accepts YYYY-MM months against YYYY:MM data, and strips private fields", async () => {
			const filtered = await v1Search({
				folder: "2024/Trip",
				camera: "Sony ILCE-7M4",
				dateMonth: "2024-06",
			});
			expect(filtered.status).toBe(200);
			expect(names(filtered.body)).toEqual(["a", "b"]);
			expect(filtered.body.total).toBe(2);
			expect(filtered.body.query).toBe("beach");
			for (const photo of filtered.body.photos) {
				for (const key of [
					"sourceRoot",
					"sourceFingerprint",
					"mediaVersion",
					"thumbnailKey",
					"thumbnailRoot",
					"thumbnailFingerprint",
				]) {
					expect(photo).not.toHaveProperty(key);
				}
			}

			const month = await v1Search({ dateMonth: "2024-06" });
			expect(names(month.body)).toEqual(
				names(await search({ dateMonth: "2024:06" })),
			);
			expect(names((await v1Search({ dateMonth: "2024-07" })).body)).toEqual([
				"c",
			]);

			for (const filters of [
				{ filterRaw: "raw" },
				{ filterRaw: "standard" },
				{ lens: "FE 24-70" },
				{ iso: 100 },
				{ folder: "my_trip" },
			] satisfies PhotoFilters[]) {
				expect(names((await v1Search(filters)).body)).toEqual(
					names(await search(filters)),
				);
			}
		});

		test("no-filter v1 search is unchanged and LIMIT applies after filtering", async () => {
			expect(names((await v1Search({})).body)).toEqual(ALL_INDEXED);
			expect(
				names((await v1Search({ folder: "2024/Trip", limit: 1 })).body),
			).toEqual(["a"]);
		});

		test.each([
			["unknown filterRaw", { filterRaw: "bogus" }],
			["non-integer iso", { iso: 1.5 }],
			["string iso", { iso: "100" }],
			["Rust-form dateMonth", { dateMonth: "2024:06" }],
			["invalid month", { dateMonth: "2024-13" }],
			["non-string folder", { folder: 7 }],
			["unknown field", { album: "x" }],
		])("rejects %s with 400 INVALID_REQUEST", async (_label, body) => {
			const response = await v1Search(body);
			expect(response.status).toBe(400);
			expect(response.body).toEqual({
				error: {
					code: "INVALID_REQUEST",
					message: "Request validation failed",
				},
			} as unknown as typeof response.body);
		});
	});

	test("folder+camera filtered search over 8,000 random 512-dim vectors completes within 250 ms", async () => {
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photos).run();

		const COUNT = 8_000;
		const DIMENSIONS = 512;
		const LIMIT = 30;
		const FOLDER = "perf/f3";
		const CAMERA = "Sony ILCE-7M4";
		// Deterministic xorshift PRNG keeps the corpus reproducible across runs.
		let state = 0x2545f491;
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
		const insertExif = sqlite.prepare(
			"INSERT INTO photo_exif (photo_id, camera_make, camera_model) VALUES (?, ?, ?)",
		);
		const insertVector = sqlite.prepare(
			`INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at)
			 VALUES (?, ?, ?, ?, 0)`,
		);
		const corpus: Array<{
			id: number;
			vector: Float32Array;
			path: string;
			camera: string;
		}> = [];
		sqlite.transaction(() => {
			for (let index = 0; index < COUNT; index++) {
				const vector = new Float32Array(DIMENSIONS);
				for (let d = 0; d < DIMENSIONS; d++) vector[d] = random();
				// Every fifth photo sits in a nested subfolder that must be excluded.
				const folder = `perf/f${index % 8}${index % 5 === 0 ? "/nested" : ""}`;
				const path = `${folder}/${index}.jpg`;
				const key = `perf-${index}`;
				const { id } = insertPhoto.get(path, `${index}.jpg`, key) as {
					id: number;
				};
				const [make, model] =
					index % 3 === 0 ? ["Canon", "Canon EOS R5"] : ["Sony", "ILCE-7M4"];
				insertExif.run(id, make, model);
				insertVector.run(
					id,
					Buffer.from(vector.buffer),
					EMBEDDING_MODEL_VERSION,
					key,
				);
				corpus.push({
					id,
					vector,
					path,
					camera: make === "Sony" ? CAMERA : model,
				});
			}
		})();

		const query = new Float32Array(DIMENSIONS);
		for (let d = 0; d < DIMENSIONS; d++) query[d] = random();
		queryVector = query;

		const started = performance.now();
		const result = await searchPhotosByText(db, "beach", LIMIT, {
			folder: FOLDER,
			camera: CAMERA,
		});
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} searchPhotosByText folder+camera over ${COUNT} x ${DIMENSIONS}-dim vectors (limit ${LIMIT}, incl. hydration): ${elapsed.toFixed(2)} ms`,
		);

		// Cross-check against a brute-force JS filter + ranking.
		const expected = corpus
			.filter(
				(entry) =>
					entry.path.startsWith(`${FOLDER}/`) &&
					!entry.path.slice(FOLDER.length + 1).includes("/") &&
					entry.camera === CAMERA,
			)
			.map((entry) => {
				let sum = 0;
				for (let d = 0; d < DIMENSIONS; d++) {
					const delta = entry.vector[d] - query[d];
					sum += delta * delta;
				}
				return { id: entry.id, distance: Math.sqrt(sum) };
			})
			.sort((left, right) => left.distance - right.distance)
			.slice(0, LIMIT)
			.map((entry) => entry.id);
		expect(expected).toHaveLength(LIMIT);
		expect(result.map((photo) => photo.id)).toEqual(expected);
		expect(elapsed).toBeLessThan(250);
	}, 60_000);
}
