import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NearDuplicateGroup } from "@photobrain/image-processing";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";
import * as schema from "../db/schema";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[pairs-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";

// Mocks of ../db, the native addon and the Inngest client are process-wide,
// and other suites mock ../services/vector-search; run the real modules in an
// isolated child like the similar and duplicates suites.
if (process.env.PHOTOBRAIN_PAIRS_TEST_CHILD !== "1") {
	test("RAW+JPEG pairs: rule, DTO, stacking, curation, review, migration and performance", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_PAIRS_TEST_CHILD: "1" },
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
	}, 120_000);
} else {
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);

	/** Fixture grouper: photos with identical hash strings form one group. */
	function equalHashGrouper(
		ids: number[],
		hashes: string[],
	): NearDuplicateGroup[] {
		const byHash = new Map<string, number[]>();
		ids.forEach((id, index) => {
			byHash.set(hashes[index], [...(byHash.get(hashes[index]) ?? []), id]);
		});
		return [...byHash.values()]
			.filter((members) => members.length >= 2)
			.map((members) => ({
				ids: [...members].sort((left, right) => left - right),
				maxDistance: 0,
			}));
	}

	mock.module("../db", () => ({ db }));
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => [1, 0, 0, 0],
		groupNearDuplicates: equalHashGrouper,
	}));
	mock.module("../inngest/client", () => ({
		inngest: { send: async () => undefined },
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
	const { searchPhotosByText, findSimilarToPhoto } = await import(
		"../services/vector-search"
	);
	const { getPhoto, listPhotos } = await import("../services/photo-catalog");
	const { updatePhotoCuration } = await import("../services/photo-curation");
	const { createCollection } = await import("../services/collections");
	const { createSmartAlbum, listSmartAlbums } = await import(
		"../services/smart-albums"
	);
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");
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

	afterAll(() => sqlite.close());
	beforeEach(() => {
		// The test connection does not enforce foreign keys; clear sidecars explicitly.
		for (const table of [
			"duplicate_dismissals",
			"smart_albums",
			"collection_photos",
			"collections",
			"photo_embedding",
			"photo_tags",
			"photo_quality",
			"photo_phash",
			"photo_exif",
			"photos",
		]) {
			sqlite.run(`DELETE FROM ${table}`);
		}
	});

	const RAW_EXTENSION = /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2)$/i;
	type PhotoOptions = {
		/** Defaults to the upper-cased extension for RAW paths; `null` stores none. */
		rawFormat?: string | null;
		dateTaken?: string;
		camera?: [string, string];
		rating?: number;
		flag?: "pick" | "reject";
		hash?: string;
		vector?: number[];
		tags?: string[];
	};
	let photoCounter = 0;
	function addPhoto(path: string, options: PhotoOptions = {}): number {
		const key = `key-${++photoCounter}`;
		const isRaw = RAW_EXTENSION.test(path);
		const extension = path.slice(path.lastIndexOf(".") + 1).toUpperCase();
		const { id } = sqlite
			.query<{ id: number }, (string | number | null)[]>(
				`INSERT INTO photos (path, name, size, created_at, modified_at, is_raw, raw_format, rating, flag, embedding_status, thumbnail_key)
				 VALUES (?1, ?2, 1, 0, 0, ?3, ?4, ?5, ?6, 'completed', ?7) RETURNING id`,
			)
			.get(
				path,
				path.slice(path.lastIndexOf("/") + 1),
				isRaw ? 1 : 0,
				options.rawFormat === undefined
					? isRaw
						? extension
						: null
					: options.rawFormat,
				options.rating ?? 0,
				options.flag ?? null,
				key,
			) as { id: number };
		if (options.dateTaken || options.camera) {
			sqlite.run(
				"INSERT INTO photo_exif (photo_id, camera_make, camera_model, date_taken) VALUES (?, ?, ?, ?)",
				[
					id,
					options.camera?.[0] ?? null,
					options.camera?.[1] ?? null,
					options.dateTaken ?? null,
				],
			);
		}
		if (options.hash !== undefined) {
			sqlite.run(
				"INSERT INTO photo_phash (photo_id, hash, created_at) VALUES (?, ?, 0)",
				[id, options.hash],
			);
		}
		if (options.vector) {
			sqlite.run(
				"INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at) VALUES (?, ?, ?, ?, 0)",
				[
					id,
					Buffer.from(new Float32Array(options.vector).buffer),
					EMBEDDING_MODEL_VERSION,
					key,
				],
			);
		}
		for (const tag of options.tags ?? []) {
			sqlite.run(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, ?, 0.9)",
				[id, tag],
			);
		}
		return id;
	}

	type PairFields = {
		pairedPhotoId: number | null;
		pairedFormat: string | null;
	};
	async function pairOf(id: number): Promise<PairFields> {
		const photo = await getPhoto(db, id);
		if (!photo) throw new Error(`Photo ${id} not found`);
		return {
			pairedPhotoId: photo.pairedPhotoId,
			pairedFormat: photo.pairedFormat,
		};
	}
	const unpaired: PairFields = { pairedPhotoId: null, pairedFormat: null };
	const ids = (result: { photos: Array<{ id: number }> } | null) =>
		result?.photos.map((photo) => photo.id);
	const flagOf = (id: number) =>
		sqlite.query("SELECT flag, rating FROM photos WHERE id = ?").get(id) as {
			flag: string | null;
			rating: number;
		};

	async function responseJson(response: Response) {
		return JSON.parse(await response.text()) as unknown;
	}
	function isoJson(value: unknown) {
		return JSON.parse(JSON.stringify(value)) as unknown;
	}

	/** Records every SQL text drizzle prepares on this connection while `run` executes. */
	async function captureStatements(run: () => unknown) {
		const statements: string[] = [];
		const original = sqlite.prepare;
		// Database.prepare is generic over its row type; the wrapper forwards it unchanged.
		const recording = ((...args: Parameters<typeof original>) => {
			statements.push(args[0]);
			return original.apply(sqlite, args);
		}) as typeof original;
		sqlite.prepare = recording;
		try {
			await run();
		} finally {
			sqlite.prepare = original;
		}
		return statements;
	}
	function planOf(statement: string) {
		// Unbound parameters are NULL; the plan does not depend on their values.
		// Finalize explicitly: an EXPLAIN of UPDATE ... RETURNING otherwise stays
		// in progress and blocks the next transaction's COMMIT.
		const explain = sqlite.prepare<{ detail: string }, []>(
			`EXPLAIN QUERY PLAN ${statement}`,
		);
		try {
			return explain
				.all()
				.map((row) => row.detail)
				.join("\n");
		} finally {
			explain.finalize();
		}
	}
	/** Every pair lookup is an index search on the stem, never a scan. */
	function expectStemIndexPlan(plan: string) {
		expect(plan).toMatch(
			/SEARCH pair_member USING COVERING INDEX idx_photos_pair_stem \(<expr>=\? AND media_type=\?\)/,
		);
		expect(plan).not.toMatch(/SCAN pair_member(\s|$)/m);
		expect(plan).not.toMatch(/SCAN pair_member_exif(\s|$)/m);
	}

	describe("pair rule", () => {
		test("case-insensitive stem in the same folder pairs one RAW with one standard file", async () => {
			const jpg = addPhoto("2024/trip/DSC_0001.jpg");
			const raw = addPhoto("2024/trip/dsc_0001.ARW");
			expect(await pairOf(jpg)).toEqual({
				pairedPhotoId: raw,
				pairedFormat: "ARW",
			});
			expect(await pairOf(raw)).toEqual({
				pairedPhotoId: jpg,
				pairedFormat: "JPG",
			});

			// The stem drops only the final extension.
			const dotted = addPhoto("2024/trip/a.b.heic");
			const dottedRaw = addPhoto("2024/trip/a.b.cr3");
			const plain = addPhoto("2024/trip/a.jpg");
			expect(await pairOf(dotted)).toEqual({
				pairedPhotoId: dottedRaw,
				pairedFormat: "CR3",
			});
			expect(await pairOf(dottedRaw)).toEqual({
				pairedPhotoId: dotted,
				pairedFormat: "HEIC",
			});
			expect(await pairOf(plain)).toEqual(unpaired);
		});

		test("a RAW partner without rawFormat reports its upper-cased extension", async () => {
			const jpg = addPhoto("x/IMG_1.jpg");
			addPhoto("x/IMG_1.nef", { rawFormat: null });
			expect((await pairOf(jpg)).pairedFormat).toBe("NEF");
		});

		test("different folders, three-member groups, two RAWs and two standard files pair nothing", async () => {
			const lonelyJpg = addPhoto("a/DSC_2.jpg");
			const lonelyRaw = addPhoto("b/DSC_2.arw");
			const triple = [
				addPhoto("c/DSC_3.jpg"),
				addPhoto("c/DSC_3.heic"),
				addPhoto("c/DSC_3.cr2"),
			];
			const raws = [addPhoto("d/DSC_4.arw"), addPhoto("d/DSC_4.nef")];
			const standards = [addPhoto("e/DSC_5.jpg"), addPhoto("e/DSC_5.heic")];
			for (const id of [
				lonelyJpg,
				lonelyRaw,
				...triple,
				...raws,
				...standards,
			]) {
				expect(await pairOf(id)).toEqual(unpaired);
			}
			// A nested folder sharing the base name is a different stem.
			const nested = addPhoto("a/DSC_2/DSC_2.arw");
			expect(await pairOf(nested)).toEqual(unpaired);
		});

		test("both capture dates present and different pair nothing; one missing or equal still pairs", async () => {
			const differ = [
				addPhoto("f/DSC_6.jpg", { dateTaken: "2024:06:01 10:00:00" }),
				addPhoto("f/DSC_6.arw", { dateTaken: "2023:01:01 09:00:00" }),
			];
			for (const id of differ) expect(await pairOf(id)).toEqual(unpaired);

			const oneMissing = addPhoto("f/DSC_7.jpg", {
				dateTaken: "2024:06:01 10:00:00",
			});
			const oneMissingRaw = addPhoto("f/DSC_7.arw", {
				camera: ["Sony", "A7III"],
			});
			expect((await pairOf(oneMissing)).pairedPhotoId).toBe(oneMissingRaw);
			expect((await pairOf(oneMissingRaw)).pairedPhotoId).toBe(oneMissing);

			const equal = addPhoto("f/DSC_8.jpg", {
				dateTaken: "2024:06:01 10:00:00",
			});
			const equalRaw = addPhoto("f/DSC_8.arw", {
				dateTaken: "2024:06:01 10:00:00",
			});
			expect((await pairOf(equal)).pairedPhotoId).toBe(equalRaw);
		});
	});

	describe("DTO fields", () => {
		test("every tRPC and /api/v1 photo surface carries both nullable pair fields", async () => {
			const jpg = addPhoto("dto/P1.jpg", {
				vector: [1, 0, 0, 0],
				hash: "aa",
				tags: ["screenshot"],
			});
			const raw = addPhoto("dto/P1.arw", { vector: [1, 0, 0, 0], hash: "aa" });
			const other = addPhoto("dto/other.jpg", {
				vector: [1, 0.1, 0, 0],
				hash: "aa",
			});
			const expectFields = (
				photos: ReadonlyArray<Record<string, unknown>>,
				expected: Record<number, PairFields>,
			) => {
				expect(photos.length).toBeGreaterThan(0);
				for (const photo of photos) {
					expect(photo).toHaveProperty("pairedPhotoId");
					expect(photo).toHaveProperty("pairedFormat");
					const want = expected[photo.id as number];
					if (want) expect(photo).toMatchObject(want);
				}
			};
			const expected = {
				[jpg]: { pairedPhotoId: raw, pairedFormat: "ARW" },
				[raw]: { pairedPhotoId: jpg, pairedFormat: "JPG" },
				[other]: unpaired,
			};

			expectFields((await caller.photos()).photos, expected);
			expectFields([await caller.photo({ id: raw })], expected);
			expectFields(
				(await caller.searchPhotos({ query: "anything" })).photos,
				expected,
			);
			expectFields(
				(await caller.similarPhotos({ photoId: other })).photos,
				expected,
			);
			expectFields((await caller.junkReview()).photos, expected);
			expectFields(
				(await caller.duplicateGroups()).groups.flatMap(
					(group) => group.photos,
				),
				expected,
			);
			const collection = createCollection(db, "Pairs", [jpg, raw]);
			expectFields(
				(await caller.photos({ collectionId: collection.id })).photos,
				expected,
			);

			// /api/v1 serializes the same values for the same service results.
			for (const [path, trpc] of [
				["/api/v1/photos", await caller.photos()],
				[`/api/v1/photos/${raw}`, await caller.photo({ id: raw })],
				[
					`/api/v1/photos/${other}/similar`,
					await caller.similarPhotos({ photoId: other }),
				],
				["/api/v1/review/junk", await caller.junkReview()],
				["/api/v1/duplicates", await caller.duplicateGroups()],
			] as const) {
				const response = await app.request(path);
				expect(response.status).toBe(200);
				expect(await responseJson(response)).toEqual(isoJson(trpc));
			}
			const search = await app.request("/api/v1/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: "anything" }),
			});
			expect(search.status).toBe(200);
			expect(await responseJson(search)).toEqual(
				isoJson(await caller.searchPhotos({ query: "anything" })),
			);
			const detail = (await responseJson(
				await app.request(`/api/v1/photos/${jpg}`),
			)) as PairFields;
			expect(detail).toMatchObject({ pairedPhotoId: raw, pairedFormat: "ARW" });
			const single = (await responseJson(
				await app.request(`/api/v1/photos/${other}`),
			)) as PairFields;
			expect(single).toMatchObject(unpaired);
		});
	});

	describe("stacking", () => {
		let pairJpg: number;
		let pairRaw: number;
		let loneRaw: number;
		let loneJpg: number;

		beforeEach(() => {
			pairJpg = addPhoto("lib/DSC_1.jpg", { vector: [1, 0, 0, 0] });
			pairRaw = addPhoto("lib/DSC_1.arw", { vector: [1, 0, 0, 0] });
			loneRaw = addPhoto("lib/DSC_2.arw", { vector: [1, 0.2, 0, 0] });
			loneJpg = addPhoto("lib/DSC_3.jpg", { vector: [1, 0.3, 0, 0] });
		});

		test("filterRaw all shows one row per pair (the standard file); raw shows RAW files; standard shows standard files", async () => {
			const all = await caller.photos();
			expect(ids(all)?.sort()).toEqual([pairJpg, loneRaw, loneJpg].sort());
			// RAW rows plus standard rows with a RAW partner.
			expect(all).toMatchObject({ total: 3, rawCount: 2 });

			const raw = await caller.photos({ filterRaw: "raw" });
			expect(ids(raw)?.sort()).toEqual([pairRaw, loneRaw].sort());
			expect(raw).toMatchObject({ total: 2, rawCount: 2 });

			const standard = await caller.photos({ filterRaw: "standard" });
			expect(ids(standard)?.sort()).toEqual([pairJpg, loneJpg].sort());
			expect(standard).toMatchObject({ total: 2, rawCount: 1 });

			// /api/v1 parity, including rawCount.
			for (const filterRaw of ["all", "raw", "standard"] as const) {
				const response = await app.request(
					`/api/v1/photos?filterRaw=${filterRaw}`,
				);
				expect(await responseJson(response)).toEqual(
					isoJson(await caller.photos({ filterRaw })),
				);
			}
		});

		test("a RAW whose partner fails the filter is shown", async () => {
			// Collection holding only the RAW.
			const onlyRaw = createCollection(db, "Only RAW", [pairRaw]);
			expect(ids(await caller.photos({ collectionId: onlyRaw.id }))).toEqual([
				pairRaw,
			]);
			// Collection holding both shows the standard file only.
			const both = createCollection(db, "Both", [pairJpg, pairRaw]);
			expect(ids(await caller.photos({ collectionId: both.id }))).toEqual([
				pairJpg,
			]);

			// Tag only on the RAW.
			sqlite.run(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, 'beach', 0.9)",
				[pairRaw],
			);
			expect(ids(await caller.photos({ tag: "beach" }))).toEqual([pairRaw]);

			// Rating and flag written outside curation onto the RAW only.
			sqlite.run("UPDATE photos SET rating = 5, flag = 'pick' WHERE id = ?", [
				pairRaw,
			]);
			expect(ids(await caller.photos({ minRating: 4 }))).toEqual([pairRaw]);
			expect(ids(await caller.photos({ flag: "pick" }))).toEqual([pairRaw]);
			expect(ids(await caller.photos({ flag: "unflagged" }))?.sort()).toEqual(
				[pairJpg, loneRaw, loneJpg].sort(),
			);

			// EXIF only on the RAW (the other side's date is missing, so still a pair).
			sqlite.run(
				"INSERT INTO photo_exif (photo_id, camera_make, camera_model) VALUES (?, 'Sony', 'A7III')",
				[pairRaw],
			);
			expect((await pairOf(pairJpg)).pairedPhotoId).toBe(pairRaw);
			expect(ids(await caller.photos({ camera: "Sony A7III" }))).toEqual([
				pairRaw,
			]);

			// Filtered unpaired RAWs are unaffected.
			expect(
				ids(await caller.photos({ folder: "lib", filterRaw: "raw" }))?.sort(),
			).toEqual([pairRaw, loneRaw].sort());
		});

		test("smart-album counts and covers agree with the listing", () => {
			sqlite.run(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, 'beach', 0.9)",
				[pairRaw],
			);
			createSmartAlbum(db, { name: "Library", filters: { folder: "lib" } });
			createSmartAlbum(db, { name: "Raw", filters: { filterRaw: "raw" } });
			createSmartAlbum(db, { name: "Beach", filters: { tag: "beach" } });
			const albums = Object.fromEntries(
				listSmartAlbums(db).map((album) => [album.name, album]),
			);
			// The pair RAW (higher ID than its JPG) is stacked away, so it is not the cover.
			expect(albums.Library).toMatchObject({
				photoCount: 3,
				cover: { photoId: loneJpg },
			});
			expect(albums.Raw).toMatchObject({
				photoCount: 2,
				cover: { photoId: loneRaw },
			});
			expect(albums.Beach).toMatchObject({
				photoCount: 1,
				cover: { photoId: pairRaw },
			});
			sqlite.run("DELETE FROM photos WHERE id = ?", [loneJpg]);
			sqlite.run("DELETE FROM photos WHERE id = ?", [loneRaw]);
			expect(
				listSmartAlbums(db).find((album) => album.name === "Library"),
			).toMatchObject({ photoCount: 1, cover: { photoId: pairJpg } });
		});

		test("text search stacks pairs inside the KNN statement", async () => {
			const all = await caller.searchPhotos({ query: "q" });
			expect(ids(all)).toEqual([pairJpg, loneRaw, loneJpg]);
			const raw = await caller.searchPhotos({ query: "q", filterRaw: "raw" });
			expect(ids(raw)).toEqual([pairRaw, loneRaw]);
			// Stacking applies before LIMIT, so the hidden RAW takes no slot.
			expect(ids(await caller.searchPhotos({ query: "q", limit: 2 }))).toEqual([
				pairJpg,
				loneRaw,
			]);
		});

		test("similar photos never return the source's partner and stack other pairs", async () => {
			const source = addPhoto("lib/source.jpg", { vector: [1, 0, 0, 0] });
			expect(ids(await findSimilarToPhoto(db, source, 10))).toEqual([
				pairJpg,
				loneRaw,
				loneJpg,
			]);
			// From either side of a pair, its partner (distance 0) is excluded.
			expect(ids(await findSimilarToPhoto(db, pairJpg, 10))).toEqual([
				source,
				loneRaw,
				loneJpg,
			]);
			expect(ids(await findSimilarToPhoto(db, pairRaw, 10))).toEqual([
				source,
				loneRaw,
				loneJpg,
			]);
			// A RAW whose partner fails the filter is a valid neighbour.
			sqlite.run(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, 'beach', 0.9)",
				[pairRaw],
			);
			expect(
				ids(await caller.similarPhotos({ photoId: source, tag: "beach" })),
			).toEqual([pairRaw]);
			expect(
				ids(await caller.similarPhotos({ photoId: pairJpg, tag: "beach" })),
			).toEqual([]);
		});
	});

	describe("curation", () => {
		test("setPhotoCuration and PATCH /api/v1/photos/:id apply to both files", async () => {
			const jpg = addPhoto("cur/DSC_1.jpg");
			const raw = addPhoto("cur/DSC_1.arw");
			const lone = addPhoto("cur/DSC_2.jpg");

			const result = await caller.setPhotoCuration({
				photoIds: [raw],
				rating: 4,
			});
			expect(result.updated).toEqual([
				{ id: jpg, rating: 4, flag: null },
				{ id: raw, rating: 4, flag: null },
			]);
			// Listing a pair member and its partner updates each once.
			expect(
				updatePhotoCuration(db, [jpg, raw, lone], { flag: "pick" }).updated.map(
					(row) => row.id,
				),
			).toEqual([jpg, raw, lone]);

			const response = await app.request(`/api/v1/photos/${jpg}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ flag: "reject", rating: 1 }),
			});
			expect(response.status).toBe(200);
			expect(await responseJson(response)).toMatchObject({
				id: jpg,
				flag: "reject",
				rating: 1,
				pairedPhotoId: raw,
			});
			expect(flagOf(raw)).toEqual({ flag: "reject", rating: 1 });
			expect(flagOf(lone)).toEqual({ flag: "pick", rating: 0 });
		});
	});

	describe("duplicates", () => {
		test("a pair is one photo: never grouped alone, represented by its standard file", async () => {
			addPhoto("dup/DSC_1.jpg", { hash: "aa" });
			addPhoto("dup/DSC_1.arw", { hash: "aa" });
			expect((await caller.duplicateGroups()).groups).toEqual([]);

			// A RAW whose partner has no hash, or is rejected, is still a candidate.
			const lonelyRaw = addPhoto("dup/DSC_2.arw", { hash: "bb" });
			addPhoto("dup/DSC_2.jpg");
			const other = addPhoto("dup/other.jpg", { hash: "bb" });
			expect(
				(await caller.duplicateGroups()).groups.map((group) =>
					group.photos.map((photo) => photo.id).sort(),
				),
			).toEqual([[lonelyRaw, other].sort()]);
		});

		test("keep rejects the partners of rejected members", async () => {
			const jpg = addPhoto("dup/DSC_3.jpg", { hash: "cc" });
			const raw = addPhoto("dup/DSC_3.arw", { hash: "cc" });
			const copy = addPhoto("dup/copy.jpg", { hash: "cc" });
			const [group] = (await caller.duplicateGroups()).groups;
			expect(group.photos.map((photo) => photo.id).sort()).toEqual(
				[jpg, copy].sort(),
			);
			const resolved = await caller.resolveDuplicateGroup({
				key: group.key,
				action: "keep",
				keepIds: [copy],
			});
			expect(resolved).toEqual({ rejected: [jpg, raw] });
			expect(flagOf(raw).flag).toBe("reject");
			expect(flagOf(copy).flag).toBeNull();

			// Keeping the pair rejects the copy only, via /api/v1.
			sqlite.run("UPDATE photos SET flag = NULL");
			sqlite.run("DELETE FROM duplicate_dismissals");
			const response = await app.request("/api/v1/duplicates/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: group.key,
					action: "keep",
					keepIds: [jpg],
				}),
			});
			expect(await responseJson(response)).toEqual({ rejected: [copy] });
			expect(flagOf(raw).flag).toBeNull();
		});
	});

	describe("junk review", () => {
		test("a companion RAW is not a candidate; reject flags both files", async () => {
			const jpg = addPhoto("junk/IMG_1.jpg", { tags: ["screenshot"] });
			const raw = addPhoto("junk/IMG_1.arw", { tags: ["screenshot"] });
			const lonelyRaw = addPhoto("junk/IMG_2.arw", { tags: ["screenshot"] });
			const review = await caller.junkReview();
			expect(ids(review)).toEqual([lonelyRaw, jpg]);
			expect(review.counts).toMatchObject({ all: 2, screenshot: 2 });

			// The RAW alone carrying the reason is still represented by nothing.
			sqlite.run("DELETE FROM photo_tags WHERE photo_id = ?", [jpg]);
			expect(ids(await caller.junkReview())).toEqual([lonelyRaw]);
			sqlite.run(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, 'screenshot', 0.9)",
				[jpg],
			);

			expect(
				await caller.resolveJunk({ photoIds: [jpg], action: "reject" }),
			).toEqual({
				updated: [jpg, raw],
			});
			expect(flagOf(raw).flag).toBe("reject");
			const response = await app.request("/api/v1/review/junk/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ photoIds: [lonelyRaw], action: "reject" }),
			});
			expect(await responseJson(response)).toEqual({ updated: [lonelyRaw] });
			expect((await caller.junkReview()).photos).toEqual([]);
		});
	});

	describe("migration 0013", () => {
		test("adds the stem index to a populated 0012 database without touching rows", async () => {
			const partial = mkdtempSync(join(tmpdir(), "photobrain-migrations-"));
			try {
				cpSync(MIGRATIONS_FOLDER, partial, { recursive: true });
				const journalPath = join(partial, "meta", "_journal.json");
				const journal = z
					.object({
						entries: z.array(z.object({ tag: z.string() }).passthrough()),
					})
					.passthrough()
					.parse(JSON.parse(readFileSync(journalPath, "utf8")));
				const pairIndex = journal.entries.findIndex((entry) =>
					entry.tag.startsWith("0013_"),
				);
				expect(pairIndex).toBeGreaterThan(0);
				expect(journal.entries[pairIndex - 1].tag).toStartWith("0012_");
				writeFileSync(
					journalPath,
					JSON.stringify({
						...journal,
						entries: journal.entries.slice(0, pairIndex),
					}),
				);

				const legacy = new Database(":memory:");
				const legacyDb = drizzle(legacy, { schema });
				migrate(legacyDb, { migrationsFolder: partial });
				const indexes = () =>
					legacy
						.query<{ name: string }, []>(
							"SELECT name FROM pragma_index_list('photos')",
						)
						.all()
						.map((row) => row.name);
				expect(indexes()).not.toContain("idx_photos_pair_stem");
				legacy.run(
					`INSERT INTO photos (id, path, name, size, created_at, modified_at, is_raw, raw_format, rating, flag, thumbnail_key)
					 VALUES (7, 'trip/DSC_1.JPG', 'DSC_1.JPG', 1, 0, 0, 0, NULL, 3, 'pick', 'key-7'),
					        (8, 'trip/dsc_1.arw', 'dsc_1.arw', 2, 0, 0, 1, 'ARW', 0, NULL, 'key-8'),
					        (9, 'trip/other.jpg', 'other.jpg', 3, 0, 0, 0, NULL, 0, NULL, 'key-9')`,
				);
				legacy.run(
					"INSERT INTO photo_exif (photo_id, date_taken) VALUES (7, '2024:06:01 10:00:00'), (8, '2024:06:01 10:00:00')",
				);
				const snapshot = () => ({
					photos: legacy.query("SELECT * FROM photos ORDER BY id").all(),
					exif: legacy.query("SELECT * FROM photo_exif ORDER BY id").all(),
				});
				const before = snapshot();

				migrate(legacyDb, { migrationsFolder: MIGRATIONS_FOLDER });
				// Later migrations may add columns; every existing value is kept.
				expect(snapshot()).toMatchObject(before);
				expect(indexes()).toContain("idx_photos_pair_stem");
				expect(
					legacy
						.query<{ sql: string }, []>(
							"SELECT sql FROM sqlite_master WHERE name = 'idx_photos_pair_stem'",
						)
						.get()?.sql,
				).toContain(`lower(substr("path"`);

				const migrated = legacyDb as unknown as Parameters<typeof getPhoto>[0];
				expect(await getPhoto(migrated, 7)).toMatchObject({
					pairedPhotoId: 8,
					pairedFormat: "ARW",
				});
				expect(await getPhoto(migrated, 9)).toMatchObject(unpaired);
				const listed = await listPhotos(migrated);
				expect(listed.photos.map((photo) => photo.id)).toEqual([7, 9]);
				expect(listed.rawCount).toBe(1);
				legacy.close();
			} finally {
				rmSync(partial, { recursive: true, force: true });
			}
		});
	});

	describe("performance over 8,000 photos with 2,000 pairs", () => {
		const PAIRS = 2_000;
		const SINGLES = 4_000;
		const COUNT = PAIRS * 2 + SINGLES;

		beforeEach(() => {
			const insertPhoto = sqlite.prepare(
				`INSERT INTO photos (path, name, size, created_at, modified_at, is_raw, raw_format, rating, flag)
				 VALUES (?, ?, 1, 0, 0, ?, ?, ?, ?)`,
			);
			const insertExif = sqlite.prepare(
				`INSERT INTO photo_exif (photo_id, camera_make, camera_model, iso, date_taken)
				 VALUES (?, ?, ?, ?, ?)`,
			);
			const insertTag = sqlite.prepare(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, ?, 0.9)",
			);
			const add = (
				path: string,
				isRaw: boolean,
				index: number,
				date: string,
			) => {
				const id = Number(
					insertPhoto.run(
						path,
						path.slice(path.lastIndexOf("/") + 1),
						isRaw ? 1 : 0,
						isRaw ? "ARW" : null,
						index % 50 === 0 ? 5 : 0,
						index % 40 === 0 ? "pick" : null,
					).lastInsertRowid,
				);
				insertExif.run(
					id,
					"Sony",
					index % 2 === 0 ? "A7III" : "A7IV",
					100 * (1 + (index % 4)),
					date,
				);
				if (index % 10 === 0) insertTag.run(id, "beach");
			};
			sqlite.transaction(() => {
				for (let index = 0; index < PAIRS; index++) {
					const folder = `perf/${index % 20}`;
					const date = `2024:${String(1 + (index % 12)).padStart(2, "0")}:01 10:00:${String(index % 60).padStart(2, "0")}`;
					add(`${folder}/DSC_${index}.JPG`, false, index, date);
					add(`${folder}/DSC_${index}.ARW`, true, index, date);
				}
				for (let index = 0; index < SINGLES; index++) {
					const folder = `perf/${index % 20}`;
					const date = `2023:${String(1 + (index % 12)).padStart(2, "0")}:02 11:00:00`;
					add(`${folder}/IMG_${index}.jpg`, index % 4 === 0, index, date);
				}
			})();
		});

		async function median(run: () => unknown, runs = 5) {
			await run();
			const samples: number[] = [];
			for (let index = 0; index < runs; index++) {
				const started = performance.now();
				await run();
				samples.push(performance.now() - started);
			}
			return samples.sort((left, right) => left - right)[Math.floor(runs / 2)];
		}

		test("listPhotos all-filter stacks within 50 ms through the stem index", async () => {
			const statements = await captureStatements(() => listPhotos(db));
			const listing = statements.find((statement) =>
				/from "photos"/i.test(statement),
			);
			if (!listing) throw new Error("listPhotos statement not captured");
			const plan = planOf(listing);
			expectStemIndexPlan(plan);

			const result = await listPhotos(db);
			expect(result.total).toBe(PAIRS + SINGLES);
			expect(result.rawCount).toBe(PAIRS + SINGLES / 4);
			expect(
				result.photos.filter((photo) => photo.pairedPhotoId !== null),
			).toHaveLength(PAIRS);

			const elapsed = await median(() => listPhotos(db));
			const filtered = await median(() =>
				listPhotos(db, { folder: "perf/3", camera: "Sony A7III" }),
			);
			console.log(
				`${PERF_LOG_PREFIX} listPhotos all over ${COUNT} photos / ${PAIRS} pairs (${result.total} rows, incl. EXIF + pair hydration): ${elapsed.toFixed(2)} ms median; folder+camera: ${filtered.toFixed(2)} ms median`,
			);
			expect(elapsed).toBeLessThan(50);
		});

		test("filtered listing, curation, junk and duplicate pair lookups use the stem index", async () => {
			for (const run of [
				() => listPhotos(db, { tag: "beach", filterRaw: "raw" }),
				() => updatePhotoCuration(db, [1, 2], { rating: 1 }),
				() => caller.junkReview(),
				() => caller.duplicateGroups(),
			]) {
				const statements = await captureStatements(run);
				const lookups = statements.filter((statement) =>
					statement.includes("pair_member"),
				);
				expect(lookups.length).toBeGreaterThan(0);
				for (const statement of lookups) expectStemIndexPlan(planOf(statement));
			}
		});

		test("smart-album live counts stay within the listing budget", async () => {
			const filterSets = [
				{},
				{ filterRaw: "raw" as const },
				{ filterRaw: "standard" as const },
				{ minRating: 5 },
				{ flag: "pick" as const },
				{ tag: "beach" },
				{ camera: "Sony A7III" },
				{ iso: 200 },
				{ dateMonth: "2024-06" },
				{ folder: "perf/7" },
			];
			for (let index = 0; index < 20; index++) {
				const filters = filterSets[index % filterSets.length];
				createSmartAlbum(db, {
					name: `Album ${index}`,
					filters:
						Object.keys(filters).length > 0 ? filters : { folder: "perf/1" },
				});
			}
			const albums = listSmartAlbums(db);
			expect(albums).toHaveLength(20);
			const raw = albums.find((album) => album.name === "Album 1");
			expect(raw?.photoCount).toBe(PAIRS + SINGLES / 4);
			const listed = await listPhotos(db, { folder: "perf/7" });
			expect(albums.find((album) => album.name === "Album 9")?.photoCount).toBe(
				listed.total,
			);

			const elapsed = await median(() => listSmartAlbums(db));
			console.log(
				`${PERF_LOG_PREFIX} listSmartAlbums 20 filter-only albums over ${COUNT} photos / ${PAIRS} pairs: ${elapsed.toFixed(2)} ms median`,
			);
			expect(elapsed).toBeLessThan(50);
		});

		test("500-ID curation with partners completes within 50 ms", async () => {
			const pairJpgs = sqlite
				.query<{ id: number }, []>(
					"SELECT id FROM photos WHERE path LIKE '%.JPG' ORDER BY id LIMIT 500",
				)
				.all()
				.map((row) => row.id);
			expect(pairJpgs).toHaveLength(500);

			const started = performance.now();
			const result = await caller.setPhotoCuration({
				photoIds: pairJpgs,
				rating: 3,
				flag: "reject",
			});
			const elapsed = performance.now() - started;
			console.log(
				`${PERF_LOG_PREFIX} setPhotoCuration 500 ids (+500 partners) over ${COUNT} photos: ${elapsed.toFixed(2)} ms`,
			);
			expect(result.updated).toHaveLength(1_000);
			expect(
				sqlite
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM photos WHERE flag = 'reject' AND rating = 3",
					)
					.get()?.count,
			).toBe(1_000);
			expect(elapsed).toBeLessThan(50);
		});
	});
}
