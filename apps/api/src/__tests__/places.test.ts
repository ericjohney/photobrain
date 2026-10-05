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
import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";
import * as schema from "../db/schema";
import { photoEmbedding, photoExif, photoPlaces, photos } from "../db/schema";
import { photoPlaceResponseSchema } from "../routes/v1-schemas";
import {
	PLACE_BACKFILL_BATCH_SIZE,
	placePhotoBatch,
} from "../services/photo-places";
import {
	createPlaceIndex,
	haversineKm,
	loadPlaceIndex,
	PLACE_DATASET_VERSION,
	PLACE_MAX_DISTANCE_KM,
	type PlaceDatasetEntry,
	parsePlaceDataset,
} from "../services/place-lookup";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { canonicalizeSmartAlbumFilters } from "../services/smart-albums";
import { createTestDb, perfBudgetMs } from "./setup";

const PERF_LOG_PREFIX = "[places-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";

type PlaceStep = {
	run<T>(id: string, work: () => T | Promise<T>): Promise<T>;
	sendEvent(id: string, event: { name: string }): Promise<void>;
};
type PlaceFunction = {
	handler(context: {
		event: { data: Record<string, never> };
		step: PlaceStep;
	}): Promise<{ placed: number; removed: number }>;
};

// Mocks of the native addon, ../db and the Inngest client are process-wide;
// run the suite in an isolated child like the tags and search suites.
if (process.env.PHOTOBRAIN_PLACES_TEST_CHILD !== "1") {
	test("offline places: lookup, backfill, filters, options and contract", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_PLACES_TEST_CHILD: "1" },
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
	}, 180_000);
} else {
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);

	let queryVector = [1, 0, 0, 0];
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => queryVector,
	}));
	mock.module("../db", () => ({ db }));
	mock.module("../inngest/client", () => ({
		inngest: {
			send: async () => undefined,
			createFunction: (
				options: unknown,
				trigger: unknown,
				handler: PlaceFunction["handler"],
			) => ({ options, trigger, handler }),
		},
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
	const { placePhotosFunction } = await import("../inngest/functions/places");
	const { listPhotos, listPhotoLocations, listFilterOptions } = await import(
		"../services/photo-catalog"
	);
	const { getPhotoPlace } = await import("../services/photo-places");
	const { searchPhotosByText, findSimilarToPhoto } = await import(
		"../services/vector-search"
	);
	const { createSmartAlbum } = await import("../services/smart-albums");
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");

	const backfill = placePhotosFunction as unknown as PlaceFunction & {
		options: { id: string; concurrency: { limit: number } };
		trigger: { event: string };
	};
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

	// Real GeoNames points (committed dataset).
	const PARIS = ["48.8530", "2.3499"] as const;
	const PARIS_2 = ["48.8566", "2.3522"] as const;
	const LYON = ["45.7640", "4.8357"] as const;
	const KYOTO = ["35.0116", "135.7681"] as const;
	const OSAKA = ["34.6937", "135.5023"] as const;
	const MID_ATLANTIC = ["30", "-40"] as const;
	const PARIS_ID = 2988507;
	const LYON_ID = 2996944;
	const KYOTO_ID = 1857910;
	const OSAKA_ID = 1853909;
	const PARIS_PLACE = {
		id: PARIS_ID,
		city: "Paris",
		region: "Île-de-France",
		country: "France",
		countryCode: "FR",
	};
	const KYOTO_PLACE = {
		id: KYOTO_ID,
		city: "Kyoto",
		region: "Kyoto",
		country: "Japan",
		countryCode: "JP",
	};
	const INVALID_REQUEST = {
		error: { code: "INVALID_REQUEST", message: "Request validation failed" },
	};

	afterAll(() => sqlite.close());
	beforeEach(() => {
		db.delete(photoPlaces).run();
		sqlite.run("DELETE FROM smart_albums");
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photos).run();
		queryVector = [1, 0, 0, 0];
	});

	function addPhoto(
		path: string,
		gps?: readonly [string | null, string | null],
		vector: readonly number[] = [0, 0, 0, 1],
	): number {
		const thumbnailKey = `key-${path}`;
		const photo = db
			.insert(photos)
			.values({
				path,
				name: path.split("/").at(-1) ?? path,
				size: 1,
				createdAt: new Date(0),
				modifiedAt: new Date(0),
				isRaw: /\.arw$/i.test(path),
				thumbnailKey,
				embeddingStatus: "completed",
			})
			.returning()
			.get();
		if (gps) {
			db.insert(photoExif)
				.values({
					photoId: photo.id,
					gpsLatitude: gps[0],
					gpsLongitude: gps[1],
				})
				.run();
		}
		db.insert(photoEmbedding)
			.values({
				photoId: photo.id,
				embedding: Buffer.from(new Float32Array(vector).buffer),
				modelVersion: EMBEDDING_MODEL_VERSION,
				thumbnailKey,
				createdAt: new Date(0),
			})
			.run();
		return photo.id;
	}

	function setGps(
		photoId: number,
		gps: readonly [string | null, string | null],
	) {
		sqlite.run(
			"UPDATE photo_exif SET gps_latitude = ?, gps_longitude = ? WHERE photo_id = ?",
			[gps[0], gps[1], photoId],
		);
	}

	const placeRows = () =>
		sqlite
			.query<
				{
					photo_id: number;
					geoname_id: number;
					latitude_text: string;
					longitude_text: string;
					places_version: number;
				},
				[]
			>(
				"SELECT photo_id, geoname_id, latitude_text, longitude_text, places_version FROM photo_places ORDER BY photo_id",
			)
			.all();

	function backfillHarness() {
		const checkpoints = new Map<string, unknown>();
		const steps: string[] = [];
		const sent: { id: string; name: string }[] = [];
		const step: PlaceStep = {
			async run<T>(id: string, work: () => T | Promise<T>): Promise<T> {
				if (checkpoints.has(id)) return checkpoints.get(id) as T;
				const value = structuredClone(await work());
				checkpoints.set(id, value);
				steps.push(id);
				return value;
			},
			async sendEvent(id, event) {
				sent.push({ id, name: event.name });
			},
		};
		return {
			steps,
			sent,
			run: () => backfill.handler({ event: { data: {} }, step }),
		};
	}
	const runBackfill = () => backfillHarness().run();

	const sorted = (values: number[]) =>
		[...values].sort((left, right) => left - right);
	const listedIds = async (
		filters: Parameters<typeof listPhotos>[1] = {},
	): Promise<number[]> =>
		sorted((await listPhotos(db, filters)).photos.map((photo) => photo.id));
	const responseIds = async (response: Response) =>
		sorted(
			((await response.json()) as { photos: { id: number }[] }).photos.map(
				(photo) => photo.id,
			),
		);
	async function trpcErrorCode(promise: Promise<unknown>) {
		const error = await promise.then(
			() => null,
			(caught: unknown) => caught,
		);
		if (!(error instanceof TRPCError)) {
			throw new Error(`Expected a TRPCError, received ${String(error)}`);
		}
		return error.code;
	}
	const post = (path: string, body: unknown) =>
		app.request(`/api/v1${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	describe("lookup", () => {
		test("loads the committed dataset once and finds real cities", () => {
			const started = performance.now();
			const index = loadPlaceIndex();
			const loadMs = performance.now() - started;
			expect(loadPlaceIndex()).toBe(index);
			expect(index.size).toBeGreaterThan(60_000);
			console.log(
				`${PERF_LOG_PREFIX} dataset load (gunzip+parse+index of ${index.size} places): ${loadMs.toFixed(1)} ms`,
			);
			expect(loadMs).toBeLessThan(perfBudgetMs(400));

			expect(index.lookup(48.853, 2.3499)).toEqual(PARIS_PLACE);
			expect(index.lookup(35.0116, 135.7681)).toEqual(KYOTO_PLACE);
			// East of the antimeridian; the nearest cities lie west of it.
			expect(index.lookup(-16.85, -179.95)).toMatchObject({
				city: "Savusavu",
				countryCode: "FJ",
			});
			expect(index.lookup(-16.5, -179.98)).toMatchObject({
				city: "Labasa",
				countryCode: "FJ",
			});
			// High latitude.
			expect(index.lookup(78.2232, 15.6267)).toEqual({
				id: 2729907,
				city: "Longyearbyen",
				region: "Svalbard",
				country: "Svalbard and Jan Mayen",
				countryCode: "SJ",
			});
			expect(index.lookup(69.6496, 18.956)).toMatchObject({
				city: "Tromsø",
				countryCode: "NO",
			});
			expect(index.lookup(45.5152, -122.6784)).toEqual({
				id: 5746545,
				city: "Portland",
				region: "Oregon",
				country: "United States",
				countryCode: "US",
			});
			// Mid-ocean and the poles have no city within 100 km.
			expect(index.lookup(30, -40)).toBeNull();
			expect(index.lookup(0, -150)).toBeNull();
			expect(index.lookup(90, 0)).toBeNull();
			expect(index.lookup(-90, 0)).toBeNull();
		});

		const entry = (
			id: number,
			latitude: number,
			longitude: number,
		): PlaceDatasetEntry => ({
			id,
			city: `City ${id}`,
			region: null,
			countryCode: "XX",
			country: "Testland",
			latitude,
			longitude,
		});
		// Degrees of latitude spanning exactly 100 km on the haversine sphere.
		const exactDegrees = PLACE_MAX_DISTANCE_KM / ((6371.0088 * Math.PI) / 180);

		test("matches at exactly 100 km and not beyond (injected dataset)", () => {
			const index = createPlaceIndex([entry(1, 0, 0)]);
			expect(haversineKm(0, 0, exactDegrees, 0)).toBeCloseTo(100, 9);
			for (const [latitude, longitude] of [
				[exactDegrees, 0],
				[-exactDegrees, 0],
				[0, exactDegrees],
				[0, -exactDegrees],
			]) {
				expect(index.lookup(latitude, longitude)?.id).toBe(1);
			}
			const beyond = exactDegrees * (1 + 1e-9);
			expect(haversineKm(0, 0, beyond, 0)).toBeGreaterThan(100);
			expect(index.lookup(beyond, 0)).toBeNull();
			expect(index.lookup(0, -beyond)).toBeNull();
		});

		test("picks the nearest, wraps the antimeridian and widens near the poles", () => {
			const index = createPlaceIndex([
				entry(1, 10, 10),
				entry(2, 10, 10.5),
				entry(3, -16, 179.9),
				entry(4, 89.8, 0),
				entry(5, 60, 180),
			]);
			expect(index.lookup(10, 10.2)?.id).toBe(1);
			expect(index.lookup(10, 10.3)?.id).toBe(2);
			// 0.2° of longitude across the antimeridian is about 21 km.
			expect(index.lookup(-16, -179.9)?.id).toBe(3);
			expect(index.lookup(-16, 179.99)?.id).toBe(3);
			// 0.4° over the pole: on the opposite meridian, well within 100 km.
			expect(index.lookup(89.8, 180)?.id).toBe(4);
			expect(index.lookup(90, 0)?.id).toBe(4);
			// Longitude 180 and -180 are the same meridian; 1.2° at 60° N ≈ 67 km.
			expect(index.lookup(60, -178.8)?.id).toBe(5);
			expect(index.lookup(60, 178.8)?.id).toBe(5);
			expect(index.lookup(-60, 0)).toBeNull();
			expect(createPlaceIndex([]).lookup(0, 0)).toBeNull();
		});

		test("parses the generator format and rejects malformed lines", () => {
			expect(
				parsePlaceDataset(
					"@XX\tTestland\n7\tTown\t\tXX\t1.5\t-2.25\n8\tCity\tRegion\tXX\t0\t0\n",
				),
			).toEqual([
				{
					id: 7,
					city: "Town",
					region: null,
					countryCode: "XX",
					country: "Testland",
					latitude: 1.5,
					longitude: -2.25,
				},
				{
					id: 8,
					city: "City",
					region: "Region",
					countryCode: "XX",
					country: "Testland",
					latitude: 0,
					longitude: 0,
				},
			]);
			expect(() => parsePlaceDataset("7\tTown\t\tYY\t1\t2\n")).toThrow(
				/Malformed/,
			);
			expect(() =>
				parsePlaceDataset("@XX\tTestland\n7\tTown\tXX\t1\t2\n"),
			).toThrow(/Malformed/);
		});
	});

	describe("backfill", () => {
		test("is a single-concurrency function on photos/places.requested", () => {
			expect(backfill.options).toEqual({
				id: "place-photos-v1",
				concurrency: { limit: 1 },
			});
			expect(backfill.trigger).toEqual({ event: "photos/places.requested" });
		});

		test("places valid locations, skips invalid/absent/remote ones, and is idempotent", async () => {
			const paris = addPhoto("a/paris.jpg", PARIS);
			const kyoto = addPhoto("a/kyoto.jpg", KYOTO);
			const ocean = addPhoto("a/ocean.jpg", MID_ATLANTIC);
			const zero = addPhoto("a/zero.jpg", ["0", "0"]);
			const partial = addPhoto("a/partial.jpg", ["48.85", null]);
			const text = addPhoto("a/text.jpg", ["north", "east"]);
			addPhoto("a/none.jpg");

			const first = backfillHarness();
			expect(await first.run()).toEqual({ placed: 2, removed: 0 });
			expect(first.steps).toEqual(["place-photos-batch-v1-0"]);
			// Events read current places, so they are requested only once all
			// places are written.
			expect(first.sent).toEqual([
				{ id: "trigger-events-v1", name: "photos/events.requested" },
			]);
			const rows = placeRows();
			expect(rows).toEqual([
				{
					photo_id: paris,
					geoname_id: PARIS_ID,
					latitude_text: PARIS[0],
					longitude_text: PARIS[1],
					places_version: PLACE_DATASET_VERSION,
				},
				{
					photo_id: kyoto,
					geoname_id: KYOTO_ID,
					latitude_text: KYOTO[0],
					longitude_text: KYOTO[1],
					places_version: PLACE_DATASET_VERSION,
				},
			]);
			for (const id of [ocean, zero, partial, text]) {
				expect(getPhotoPlace(db, id)).toEqual({ place: null });
			}

			expect(await runBackfill()).toEqual({ placed: 0, removed: 0 });
			expect(placeRows()).toEqual(rows);
		});

		test("keyset batches by photo ID cover every photo exactly once", () => {
			const ids = [
				addPhoto("b/1.jpg", PARIS),
				addPhoto("b/2.jpg", MID_ATLANTIC),
				addPhoto("b/3.jpg", KYOTO),
				addPhoto("b/4.jpg"),
				addPhoto("b/5.jpg", LYON),
				addPhoto("b/6.jpg", OSAKA),
			];
			const index = loadPlaceIndex();
			const results = [];
			let cursor = 0;
			for (;;) {
				const result = placePhotoBatch(db, index, cursor, 2);
				results.push(result);
				cursor = result.cursor;
				if (result.read < 2) break;
			}
			// The photo without GPS needs no work, so it is never read.
			expect(results).toEqual([
				{ read: 2, placed: 1, removed: 0, cursor: ids[1] },
				{ read: 2, placed: 2, removed: 0, cursor: ids[4] },
				{ read: 1, placed: 1, removed: 0, cursor: ids[5] },
			]);
			expect(placeRows().map((row) => row.geoname_id)).toEqual([
				PARIS_ID,
				KYOTO_ID,
				LYON_ID,
				OSAKA_ID,
			]);
			expect(PLACE_BACKFILL_BATCH_SIZE).toBe(1_000);
		});

		test("changed GPS hides the stale place immediately and the backfill recomputes it", async () => {
			const moved = addPhoto("c/moved.jpg", PARIS);
			const retyped = addPhoto("c/retyped.jpg", PARIS);
			const toOcean = addPhoto("c/ocean.jpg", PARIS);
			await runBackfill();
			expect(getPhotoPlace(db, moved)).toEqual({ place: PARIS_PLACE });

			setGps(moved, KYOTO);
			// Same coordinate, different text: still stale by the exact-text rule.
			setGps(retyped, ["48.853", "2.3499"]);
			setGps(toOcean, MID_ATLANTIC);
			for (const id of [moved, retyped, toOcean]) {
				expect(getPhotoPlace(db, id)).toEqual({ place: null });
			}
			expect(await listedIds({ country: "FR" })).toEqual([]);
			expect(await listedIds({ place: PARIS_ID })).toEqual([]);
			const stale = await listFilterOptions(db);
			expect(stale.countries).toEqual([]);
			expect(stale.places).toEqual([]);
			expect(await caller.photoPlace({ photoId: moved })).toEqual({
				place: null,
			});

			expect(await runBackfill()).toEqual({ placed: 2, removed: 1 });
			expect(getPhotoPlace(db, moved)).toEqual({ place: KYOTO_PLACE });
			expect(getPhotoPlace(db, retyped)).toEqual({ place: PARIS_PLACE });
			expect(placeRows().map((row) => row.photo_id)).toEqual([moved, retyped]);
			expect(await listedIds({ country: "JP" })).toEqual([moved]);
			expect(await runBackfill()).toEqual({ placed: 0, removed: 0 });
		});

		test("removed GPS hides the place and the backfill deletes the row", async () => {
			const cleared = addPhoto("d/cleared.jpg", PARIS);
			const zeroed = addPhoto("d/zeroed.jpg", KYOTO);
			const noExif = addPhoto("d/no-exif.jpg", LYON);
			const kept = addPhoto("d/kept.jpg", OSAKA);
			await runBackfill();
			expect(placeRows()).toHaveLength(4);

			setGps(cleared, [null, null]);
			setGps(zeroed, ["0", "0"]);
			sqlite.run("DELETE FROM photo_exif WHERE photo_id = ?", [noExif]);
			for (const id of [cleared, zeroed, noExif]) {
				expect(getPhotoPlace(db, id)).toEqual({ place: null });
			}
			expect(await listedIds({ country: "FR" })).toEqual([]);

			expect(await runBackfill()).toEqual({ placed: 0, removed: 3 });
			expect(placeRows().map((row) => row.photo_id)).toEqual([kept]);
			expect(await runBackfill()).toEqual({ placed: 0, removed: 0 });
		});

		test("rows from another dataset version are hidden and recomputed", async () => {
			const paris = addPhoto("e/paris.jpg", PARIS);
			const kyoto = addPhoto("e/kyoto.jpg", KYOTO);
			await runBackfill();
			sqlite.run(
				"UPDATE photo_places SET places_version = ?, geoname_id = 1, city = 'Old', country_code = 'ZZ'",
				[PLACE_DATASET_VERSION - 1],
			);
			expect(getPhotoPlace(db, paris)).toEqual({ place: null });
			expect(await listedIds({ country: "ZZ" })).toEqual([]);
			expect((await listFilterOptions(db)).countries).toEqual([]);

			expect(await runBackfill()).toEqual({ placed: 2, removed: 0 });
			expect(placeRows().map((row) => row.places_version)).toEqual([
				PLACE_DATASET_VERSION,
				PLACE_DATASET_VERSION,
			]);
			expect(getPhotoPlace(db, paris)).toEqual({ place: PARIS_PLACE });
			expect(getPhotoPlace(db, kyoto)).toEqual({ place: KYOTO_PLACE });
		});

		test("deleting a photo cascades to its place", async () => {
			const paris = addPhoto("f/paris.jpg", PARIS);
			await runBackfill();
			sqlite.run("PRAGMA foreign_keys = ON");
			sqlite.run("DELETE FROM photos WHERE id = ?", [paris]);
			expect(placeRows()).toEqual([]);
		});
	});

	describe("filters, options and photo place", () => {
		let ids: Record<string, number>;
		beforeEach(async () => {
			ids = {
				parisA: addPhoto("trips/paris-a.jpg", PARIS, [1, 0, 0, 0]),
				parisB: addPhoto("trips/nested/paris-b.jpg", PARIS_2, [0.9, 0.1, 0, 0]),
				lyon: addPhoto("trips/lyon.jpg", LYON, [0.8, 0.2, 0, 0]),
				kyoto: addPhoto("home/kyoto.jpg", KYOTO, [0.7, 0.3, 0, 0]),
				osaka: addPhoto("home/osaka.jpg", OSAKA, [0, 1, 0, 0]),
				ocean: addPhoto("trips/ocean.jpg", MID_ATLANTIC, [0, 0, 1, 0]),
				// A RAW+JPEG pair, both placed in Paris.
				pairJpg: addPhoto("trips/IMG_1.JPG", PARIS, [0.6, 0.4, 0, 0]),
				pairRaw: addPhoto("trips/IMG_1.ARW", PARIS, [0.6, 0.4, 0, 0]),
				// A pair where only the RAW file has a location.
				soloRaw: addPhoto("trips/IMG_2.ARW", PARIS, [0.5, 0.5, 0, 0]),
				soloJpg: addPhoto("trips/IMG_2.JPG", undefined, [0.5, 0.5, 0, 0]),
			};
			sqlite.run(
				"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, 'beach', 0.9), (?, 'beach', 0.8), (?, 'temple', 0.9)",
				[ids.parisA, ids.lyon, ids.kyoto],
			);
			await runBackfill();
		});
		const expectIds = (...names: string[]) =>
			sorted(names.map((name) => ids[name]));

		test("country and place filter the listing with pair stacking intact", async () => {
			const france = expectIds(
				"parisA",
				"parisB",
				"lyon",
				"pairJpg",
				"soloRaw",
			);
			expect(await listedIds({ country: "FR" })).toEqual(france);
			expect(await listedIds({ place: PARIS_ID })).toEqual(
				expectIds("parisA", "parisB", "pairJpg", "soloRaw"),
			);
			expect(await listedIds({ country: "JP" })).toEqual(
				expectIds("kyoto", "osaka"),
			);
			expect(await listedIds({ country: "JP", place: KYOTO_ID })).toEqual(
				expectIds("kyoto"),
			);
			expect(await listedIds({ country: "FR", place: KYOTO_ID })).toEqual([]);
			expect(await listedIds({ country: "US" })).toEqual([]);
			expect(await listedIds({ place: 999_999_999 })).toEqual([]);
			// The pair-type filter exposes both RAW files.
			expect(await listedIds({ country: "FR", filterRaw: "raw" })).toEqual(
				expectIds("pairRaw", "soloRaw"),
			);
			expect(await listedIds({ country: "FR", filterRaw: "standard" })).toEqual(
				expectIds("parisA", "parisB", "lyon", "pairJpg"),
			);
			const listing = await listPhotos(db, { country: "FR" });
			expect(listing.rawCount).toBe(2);
		});

		test("country and place compose with folder, tag, bounds and rating", async () => {
			expect(
				await listedIds({ country: "FR", folder: "trips/nested" }),
			).toEqual(expectIds("parisB"));
			expect(await listedIds({ country: "JP", folder: "home" })).toEqual(
				expectIds("kyoto", "osaka"),
			);
			expect(await listedIds({ country: "FR", folder: "home" })).toEqual([]);
			expect(await listedIds({ country: "FR", tag: "beach" })).toEqual(
				expectIds("parisA", "lyon"),
			);
			expect(await listedIds({ place: KYOTO_ID, tag: "temple" })).toEqual(
				expectIds("kyoto"),
			);
			const aroundParis = { north: 49, south: 48.5, east: 2.6, west: 2.1 };
			expect(await listedIds({ country: "FR", bounds: aroundParis })).toEqual(
				expectIds("parisA", "parisB", "pairJpg", "soloRaw"),
			);
			expect(await listedIds({ country: "JP", bounds: aroundParis })).toEqual(
				[],
			);
			sqlite.run("UPDATE photos SET rating = 4 WHERE id IN (?, ?)", [
				ids.lyon,
				ids.kyoto,
			]);
			expect(await listedIds({ country: "FR", minRating: 3 })).toEqual(
				expectIds("lyon"),
			);
			expect(
				listPhotoLocations(db, { country: "JP" })
					.points.map((point) => point.id)
					.sort((left, right) => left - right),
			).toEqual(expectIds("kyoto", "osaka"));
		});

		test("tRPC and v1 photos/locations accept country and place and reject invalid values", async () => {
			const parisIds = expectIds("parisA", "parisB", "pairJpg", "soloRaw");
			expect(
				sorted(
					(await caller.photos({ country: "FR", place: PARIS_ID })).photos.map(
						(photo) => photo.id,
					),
				),
			).toEqual(parisIds);
			expect(
				sorted(
					(await caller.photoLocations({ country: "JP" })).points.map(
						(point) => point.id,
					),
				),
			).toEqual(expectIds("kyoto", "osaka"));
			const v1 = await app.request(
				`/api/v1/photos?country=FR&place=${PARIS_ID}&folder=trips`,
			);
			expect(v1.status).toBe(200);
			// `folder` matches direct children only, so the nested photo is excluded.
			expect(await responseIds(v1)).toEqual(
				expectIds("parisA", "pairJpg", "soloRaw"),
			);
			const locations = await app.request(
				`/api/v1/locations?place=${KYOTO_ID}`,
			);
			expect(locations.status).toBe(200);
			expect(
				((await locations.json()) as { points: { id: number }[] }).points.map(
					(point) => point.id,
				),
			).toEqual([ids.kyoto]);

			for (const query of [
				"country=fr",
				"country=FRA",
				"country=F",
				"country=",
				"place=0",
				"place=-3",
				"place=1.5",
				"place=abc",
			]) {
				expect((await app.request(`/api/v1/photos?${query}`)).status).toBe(400);
				expect((await app.request(`/api/v1/locations?${query}`)).status).toBe(
					400,
				);
				expect(
					(await app.request(`/api/v1/photos/${ids.parisA}/similar?${query}`))
						.status,
				).toBe(400);
			}
			for (const invalid of [
				{ country: "fr" },
				{ country: "FRA" },
				{ place: 0 },
				{ place: 1.5 },
			]) {
				expect(await trpcErrorCode(caller.photos(invalid))).toBe("BAD_REQUEST");
				expect(await trpcErrorCode(caller.photoLocations(invalid))).toBe(
					"BAD_REQUEST",
				);
				expect(
					await trpcErrorCode(
						caller.searchPhotos({ query: "x", limit: 5, ...invalid }),
					),
				).toBe("BAD_REQUEST");
				expect(
					await trpcErrorCode(
						caller.similarPhotos({ photoId: ids.parisA, ...invalid }),
					),
				).toBe("BAD_REQUEST");
				const response = await post("/search", { query: "x", ...invalid });
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual(INVALID_REQUEST);
			}
			expect((await post("/search", { query: "x", place: "5" })).status).toBe(
				400,
			);
		});

		test("semantic search honors country and place over real sqlite-vec vectors (tRPC and v1)", async () => {
			const unfiltered = await caller.searchPhotos({ query: "x", limit: 1 });
			expect(unfiltered.photos.map((photo) => photo.id)).toEqual([ids.parisA]);
			const japan = await caller.searchPhotos({
				query: "x",
				limit: 10,
				country: "JP",
			});
			// Ranked by distance to [1, 0, 0, 0].
			expect(japan.photos.map((photo) => photo.id)).toEqual([
				ids.kyoto,
				ids.osaka,
			]);
			const response = await post("/search", {
				query: "x",
				limit: 10,
				country: "FR",
				place: PARIS_ID,
				folder: "trips",
			});
			expect(response.status).toBe(200);
			expect(await responseIds(response)).toEqual(
				await listedIds({ country: "FR", place: PARIS_ID, folder: "trips" }),
			);
			const byCity = await caller.searchPhotos({
				query: "x",
				limit: 10,
				place: LYON_ID,
			});
			expect(byCity.photos.map((photo) => photo.id)).toEqual([ids.lyon]);
		});

		test("similar photos honor country and place (tRPC and v1)", async () => {
			const result = await findSimilarToPhoto(db, ids.ocean, 20, {
				country: "JP",
			});
			expect(result?.photos.map((photo) => photo.id)).toEqual([
				ids.kyoto,
				ids.osaka,
			]);
			const viaTrpc = await caller.similarPhotos({
				photoId: ids.ocean,
				place: KYOTO_ID,
			});
			expect(viaTrpc.photos.map((photo) => photo.id)).toEqual([ids.kyoto]);
			const response = await app.request(
				`/api/v1/photos/${ids.ocean}/similar?country=FR`,
			);
			expect(response.status).toBe(200);
			expect(await responseIds(response)).toEqual(
				await listedIds({ country: "FR" }),
			);
		});

		test("filterOptions lists current countries and places, folder-scoped like tags", async () => {
			const options = await listFilterOptions(db);
			expect(options.countries).toEqual([
				{ code: "FR", name: "France", count: 6 },
				{ code: "JP", name: "Japan", count: 2 },
			]);
			expect(options.places).toEqual([
				{
					id: PARIS_ID,
					name: "Paris",
					region: "Île-de-France",
					countryCode: "FR",
					count: 5,
				},
				{
					id: KYOTO_ID,
					name: "Kyoto",
					region: "Kyoto",
					countryCode: "JP",
					count: 1,
				},
				{
					id: LYON_ID,
					name: "Lyon",
					region: "Auvergne-Rhône-Alpes",
					countryCode: "FR",
					count: 1,
				},
				{
					id: OSAKA_ID,
					name: "Osaka",
					region: "Osaka",
					countryCode: "JP",
					count: 1,
				},
			]);
			const home = await caller.filterOptions({ folder: "home" });
			expect(home.countries).toEqual([{ code: "JP", name: "Japan", count: 2 }]);
			expect(home.places.map((place) => place.id)).toEqual([
				KYOTO_ID,
				OSAKA_ID,
			]);
			const nested = await listFilterOptions(db, { folder: "trips/nested" });
			expect(nested.countries).toEqual([
				{ code: "FR", name: "France", count: 1 },
			]);
			expect(nested.places.map((place) => place.count)).toEqual([1]);
			const response = await app.request("/api/v1/filter-options?folder=trips");
			expect(response.status).toBe(200);
			const v1 = (await response.json()) as {
				countries: unknown;
				places: { id: number; count: number }[];
			};
			expect(v1.countries).toEqual([{ code: "FR", name: "France", count: 6 }]);
			expect(v1.places.map(({ id, count }) => [id, count])).toEqual([
				[PARIS_ID, 5],
				[LYON_ID, 1],
			]);

			// A stale row stops counting until the backfill recomputes it.
			setGps(ids.kyoto, OSAKA);
			const stale = await listFilterOptions(db);
			expect(stale.countries.at(-1)).toEqual({
				code: "JP",
				name: "Japan",
				count: 1,
			});
			expect(stale.places.map((place) => place.id)).not.toContain(KYOTO_ID);
			await runBackfill();
			const fresh = await listFilterOptions(db);
			expect(fresh.places.find((place) => place.id === OSAKA_ID)?.count).toBe(
				2,
			);
		});

		test("photoPlace and GET /photos/:id/place return the current place or 404", async () => {
			expect(await caller.photoPlace({ photoId: ids.parisA })).toEqual({
				place: PARIS_PLACE,
			});
			expect(await caller.photoPlace({ photoId: ids.ocean })).toEqual({
				place: null,
			});
			expect(await caller.photoPlace({ photoId: ids.soloJpg })).toEqual({
				place: null,
			});
			expect(await trpcErrorCode(caller.photoPlace({ photoId: 999_999 }))).toBe(
				"NOT_FOUND",
			);

			const ok = await app.request(`/api/v1/photos/${ids.kyoto}/place`);
			expect(ok.status).toBe(200);
			const body = await ok.json();
			expect(photoPlaceResponseSchema.parse(body)).toEqual({
				place: KYOTO_PLACE,
			});
			expect(body).toEqual({ place: KYOTO_PLACE });
			const none = await app.request(`/api/v1/photos/${ids.ocean}/place`);
			expect(none.status).toBe(200);
			expect(await none.json()).toEqual({ place: null });
			const missing = await app.request("/api/v1/photos/999999/place");
			expect(missing.status).toBe(404);
			expect(await missing.json()).toEqual({
				error: { code: "PHOTO_NOT_FOUND", message: "Photo not found" },
			});
			expect((await app.request("/api/v1/photos/abc/place")).status).toBe(400);
		});

		test("smart albums save, count and round-trip country and place", async () => {
			const album = await caller.createSmartAlbum({
				name: "Paris",
				filters: { country: "FR", place: PARIS_ID },
			});
			expect(album.filters).toEqual({ country: "FR", place: PARIS_ID });
			expect(album.photoCount).toBe(
				(await listPhotos(db, { country: "FR", place: PARIS_ID })).total,
			);
			expect(album.photoCount).toBe(4);
			const listed = (await caller.smartAlbums()).albums;
			expect(listed.map((entry) => entry.filters)).toEqual([
				{ country: "FR", place: PARIS_ID },
			]);
			const updated = await caller.updateSmartAlbum({
				id: album.id,
				filters: { country: "JP", tag: "temple" },
			});
			expect(updated.filters).toEqual({ tag: "temple", country: "JP" });
			expect(updated.photoCount).toBe(1);
			// Empty country means "any" and is dropped like an empty tag.
			const any = createSmartAlbum(db, {
				name: "Beach",
				filters: { country: "", tag: "beach" },
			});
			expect(any.filters).toEqual({ tag: "beach" });

			const created = await post("/smart-albums", {
				name: "Kyoto",
				filters: { country: "JP", place: KYOTO_ID },
			});
			expect(created.status).toBe(201);
			expect(
				(await created.json()) as { filters: unknown; photoCount: number },
			).toMatchObject({
				filters: { country: "JP", place: KYOTO_ID },
				photoCount: 1,
			});
			const v1List = await app.request("/api/v1/smart-albums");
			const albums = (
				(await v1List.json()) as {
					albums: { name: string; filters: unknown }[];
				}
			).albums;
			expect(albums.find((entry) => entry.name === "Kyoto")?.filters).toEqual({
				country: "JP",
				place: KYOTO_ID,
			});
		});

		test("smart album criteria reject invalid country and place", async () => {
			for (const filters of [
				{ country: "fr" },
				{ country: "FRA" },
				{ place: 0 },
				{ place: -1 },
				{ place: 2.5 },
			]) {
				expect(
					await trpcErrorCode(
						caller.createSmartAlbum({ name: "Bad", filters }),
					),
				).toBe("BAD_REQUEST");
				const response = await post("/smart-albums", { name: "Bad", filters });
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual(INVALID_REQUEST);
				expect(() =>
					canonicalizeSmartAlbumFilters(
						filters as Parameters<typeof canonicalizeSmartAlbumFilters>[0],
					),
				).toThrow(RangeError);
			}
			expect(
				(await post("/smart-albums", { name: "Bad", filters: { place: "5" } }))
					.status,
			).toBe(400);
			expect((await caller.smartAlbums()).albums).toEqual([]);
		});
	});

	describe("migration 0014", () => {
		test("applies on a database migrated to 0013 with rows and keeps data", () => {
			const migrationSql = readFileSync(
				join(MIGRATIONS_FOLDER, "0014_photo_places.sql"),
				"utf8",
			);
			expect(migrationSql).not.toMatch(/DROP TABLE|__new_|INSERT INTO/i);
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
				const placesIndex = journal.entries.findIndex((entry) =>
					entry.tag.startsWith("0014_"),
				);
				expect(placesIndex).toBeGreaterThan(0);
				expect(journal.entries[placesIndex - 1].tag).toStartWith("0013_");
				writeFileSync(
					journalPath,
					JSON.stringify({
						...journal,
						entries: journal.entries.slice(0, placesIndex),
					}),
				);

				const legacy = new Database(":memory:");
				const legacyDb = drizzle(legacy, { schema });
				migrate(legacyDb, { migrationsFolder: partial });
				const tables = () =>
					legacy
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
						)
						.all()
						.map((row) => row.name);
				expect(tables()).not.toContain("photo_places");
				legacy.run(
					`INSERT INTO photos (id, path, name, size, created_at, modified_at, rating)
					 VALUES (7, 'a/one.jpg', 'one.jpg', 1, 0, 0, 4), (9, 'a/two.jpg', 'two.jpg', 2, 0, 0, 0)`,
				);
				legacy.run(
					`INSERT INTO photo_exif (photo_id, gps_latitude, gps_longitude)
					 VALUES (7, '48.8530', '2.3499')`,
				);
				legacy.run(
					"INSERT INTO photo_tags (photo_id, tag, score) VALUES (9, 'beach', 0.5)",
				);
				const snapshot = () => ({
					photos: legacy.query("SELECT * FROM photos ORDER BY id").all(),
					exif: legacy.query("SELECT * FROM photo_exif").all(),
					tags: legacy.query("SELECT * FROM photo_tags").all(),
				});
				const before = snapshot();

				writeFileSync(journalPath, JSON.stringify(journal));
				migrate(legacyDb, { migrationsFolder: partial });

				// Later migrations may add columns; every existing value is kept.
				expect(snapshot()).toMatchObject(before);
				expect(tables()).toContain("photo_places");
				expect(
					legacy
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'photo_places' ORDER BY name",
						)
						.all()
						.map((row) => row.name),
				).toEqual(
					expect.arrayContaining([
						"idx_photo_places_country_photo_id",
						"idx_photo_places_geoname_photo_id",
					]),
				);
				expect(
					legacy.query("SELECT count(*) AS count FROM photo_places").get(),
				).toEqual({ count: 0 });
				// The backfill fills the new table for existing geotagged photos.
				const migratedDb = legacyDb as unknown as typeof db;
				expect(placePhotoBatch(migratedDb, loadPlaceIndex(), 0)).toEqual({
					read: 1,
					placed: 1,
					removed: 0,
					cursor: 7,
				});
				expect(getPhotoPlace(migratedDb, 7)).toEqual({ place: PARIS_PLACE });
				legacy.run("PRAGMA foreign_keys = ON");
				legacy.run("DELETE FROM photos WHERE id = 7");
				expect(
					legacy.query("SELECT count(*) AS count FROM photo_places").get(),
				).toEqual({ count: 0 });
				legacy.close();
			} finally {
				rmSync(partial, { recursive: true, force: true });
			}
		});
	});

	test("performance over 8,000 geotagged photos in a file database", async () => {
		const COUNT = 8_000;
		const directory = mkdtempSync(join(tmpdir(), "photobrain-places-perf-"));
		const file = new Database(join(directory, "perf.db"));
		try {
			const fileDb = drizzle(file, { schema }) as unknown as typeof db;
			migrate(fileDb, { migrationsFolder: MIGRATIONS_FOLDER });
			// Deterministic coordinates in populated regions (Europe, Japan, US
			// east coast) plus some open ocean, across 20 folders.
			let seed = 42;
			const random = () => {
				seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
				return seed / 2_147_483_648;
			};
			const regions = [
				{ south: 43, north: 51, west: -1, east: 8 },
				{ south: 33, north: 36, west: 133, east: 140 },
				{ south: 38, north: 42, west: -78, east: -73 },
				{ south: 20, north: 30, west: -40, east: -30 },
			];
			const insertPhoto = file.prepare(
				`INSERT INTO photos (path, name, size, created_at, modified_at)
				 VALUES (?, ?, 1, 0, 0) RETURNING id`,
			);
			const insertExif = file.prepare(
				"INSERT INTO photo_exif (photo_id, gps_latitude, gps_longitude) VALUES (?, ?, ?)",
			);
			file.transaction(() => {
				for (let index = 0; index < COUNT; index++) {
					const region = regions[index % regions.length];
					const { id } = insertPhoto.get(
						`folder${index % 20}/${index}.jpg`,
						`${index}.jpg`,
					) as { id: number };
					insertExif.run(
						id,
						(region.south + random() * (region.north - region.south)).toFixed(
							6,
						),
						(region.west + random() * (region.east - region.west)).toFixed(6),
					);
				}
			})();

			const index = loadPlaceIndex();
			const backfillStarted = performance.now();
			let cursor = 0;
			let batches = 0;
			let placed = 0;
			for (;;) {
				const result = placePhotoBatch(
					fileDb,
					index,
					cursor,
					PLACE_BACKFILL_BATCH_SIZE,
				);
				batches++;
				placed += result.placed;
				cursor = result.cursor;
				if (result.read < PLACE_BACKFILL_BATCH_SIZE) break;
			}
			const backfillMs = performance.now() - backfillStarted;
			expect(placed).toBeGreaterThan(COUNT / 2);
			expect(backfillMs).toBeLessThan(perfBudgetMs(3_000));
			const noopStarted = performance.now();
			const noop = placePhotoBatch(fileDb, index, 0, COUNT);
			const noopMs = performance.now() - noopStarted;
			expect(noop.placed).toBe(0);
			expect(noop.removed).toBe(0);
			file.run("ANALYZE");

			const median = (run: () => unknown) => {
				const samples: number[] = [];
				for (let sample = 0; sample < 5; sample++) {
					const started = performance.now();
					run();
					samples.push(performance.now() - started);
				}
				return samples.sort((left, right) => left - right)[2];
			};
			const medianAsync = async (run: () => Promise<unknown>) => {
				const samples: number[] = [];
				for (let sample = 0; sample < 5; sample++) {
					const started = performance.now();
					await run();
					samples.push(performance.now() - started);
				}
				return samples.sort((left, right) => left - right)[2];
			};

			const lookups = 200_000;
			const points = new Float64Array(lookups * 2);
			for (let point = 0; point < lookups; point++) {
				const region = regions[point % 2];
				points[point * 2] =
					region.south + random() * (region.north - region.south);
				points[point * 2 + 1] =
					region.west + random() * (region.east - region.west);
			}
			const lookupMs = median(() => {
				for (let point = 0; point < lookups; point++) {
					index.lookup(points[point * 2], points[point * 2 + 1]);
				}
			});
			const lookupUs = (lookupMs * 1_000) / lookups;
			expect(lookupUs).toBeLessThan(perfBudgetMs(50));

			const options = await listFilterOptions(fileDb);
			const country = options.countries[0].code;
			const countryMs = await medianAsync(() =>
				listPhotos(fileDb, { country }),
			);
			const countryTotal = (await listPhotos(fileDb, { country })).total;
			expect(countryTotal).toBe(options.countries[0].count);
			const placeMs = await medianAsync(() =>
				listPhotos(fileDb, { place: options.places[0].id }),
			);
			const optionsMs = await medianAsync(() => listFilterOptions(fileDb));
			const folderOptionsMs = await medianAsync(() =>
				listFilterOptions(fileDb, { folder: "folder3" }),
			);
			const photoPlaceMs = median(() => getPhotoPlace(fileDb, COUNT / 2));
			expect(countryMs).toBeLessThan(perfBudgetMs(50));
			expect(placeMs).toBeLessThan(perfBudgetMs(50));
			expect(optionsMs).toBeLessThan(perfBudgetMs(50));
			expect(folderOptionsMs).toBeLessThan(perfBudgetMs(50));
			expect(photoPlaceMs).toBeLessThan(perfBudgetMs(5));

			const statements: string[] = [];
			const original = file.prepare;
			file.prepare = ((...args: Parameters<typeof original>) => {
				statements.push(args[0]);
				return original.apply(file, args);
			}) as typeof original;
			try {
				await listPhotos(fileDb, { country });
				await listPhotos(fileDb, { place: options.places[0].id });
				await listFilterOptions(fileDb);
				getPhotoPlace(fileDb, 1);
			} finally {
				file.prepare = original;
			}
			const plan = (statement: string | undefined) => {
				if (!statement) throw new Error("statement not captured");
				return file
					.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${statement}`)
					.all()
					.map((row) => row.detail)
					.join("\n");
			};
			const listings = statements.filter(
				(statement) =>
					/from "photos"/i.test(statement) && /photo_places/.test(statement),
			);
			const countryPlan = plan(
				listings.find((statement) => /country_code =/.test(statement)),
			);
			const placePlan = plan(
				listings.find((statement) => /geoname_id =/.test(statement)),
			);
			const [countriesPlan, placesPlan] = statements
				.filter((statement) => /FROM photo_places\s+INNER JOIN/.test(statement))
				.map(plan);
			const photoPlacePlan = plan(
				statements.find((statement) =>
					/LEFT JOIN photo_places ON/.test(statement),
				),
			);
			expect(countryPlan).toMatch(
				/SEARCH photo_places USING (COVERING )?INDEX idx_photo_places_country_photo_id \(country_code=\?\)/,
			);
			expect(placePlan).toMatch(
				/SEARCH photo_places USING (COVERING )?INDEX idx_photo_places_geoname_photo_id \(geoname_id=\?\)/,
			);
			for (const listingPlan of [countryPlan, placePlan, photoPlacePlan]) {
				expect(listingPlan).not.toMatch(/SCAN photo_places/);
				expect(listingPlan).toMatch(
					/SEARCH current_exif (EXISTS )?USING INDEX photo_exif_photo_id_unique \(photo_id=\?\)/,
				);
			}
			expect(photoPlacePlan).toMatch(
				/SEARCH photo_places USING INTEGER PRIMARY KEY \(rowid=\?\)/,
			);
			for (const optionsPlan of [countriesPlan, placesPlan]) {
				// One pass over photo_places, then primary-key/unique probes per row.
				expect(optionsPlan).toMatch(/SEARCH photos USING INTEGER PRIMARY KEY/);
				expect(optionsPlan).toMatch(
					/SEARCH current_exif (EXISTS )?USING INDEX photo_exif_photo_id_unique/,
				);
			}

			const log = (line: string) => console.log(`${PERF_LOG_PREFIX} ${line}`);
			log(
				`place-photos-v1 backfill of ${COUNT} photos (${batches} steps, ${placed} placed, read+lookup+write): ${backfillMs.toFixed(1)} ms; no-op rerun ${noopMs.toFixed(1)} ms`,
			);
			log(
				`lookup: ${lookupUs.toFixed(2)} µs per lookup (median of 5 x ${lookups} in dense regions)`,
			);
			log(
				`listPhotos country=${country} (${countryTotal} rows, incl. EXIF hydration): ${countryMs.toFixed(2)} ms median; place=${options.places[0].name}: ${placeMs.toFixed(2)} ms`,
			);
			log(
				`filterOptions (${options.countries.length} countries, ${options.places.length} places): ${optionsMs.toFixed(2)} ms median; folder-scoped ${folderOptionsMs.toFixed(2)} ms`,
			);
			log(`photoPlace: ${photoPlaceMs.toFixed(3)} ms median`);
			for (const [name, detail] of [
				["listPhotos country", countryPlan],
				["listPhotos place", placePlan],
				["filterOptions countries", countriesPlan],
				["filterOptions places", placesPlan],
				["photoPlace", photoPlacePlan],
			]) {
				log(`EXPLAIN ${name}: ${detail.replaceAll("\n", " | ")}`);
			}
		} finally {
			file.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
}
