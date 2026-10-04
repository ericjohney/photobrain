import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import { photoExif, photos } from "../db/schema";
import { gearStatsResponseSchema } from "../routes/v1-schemas";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[gear-stats-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";

// Mocks of the native addon, ../db and the Inngest client are process-wide;
// run the suite in an isolated child like the on-this-day and events suites.
if (process.env.PHOTOBRAIN_GEAR_STATS_TEST_CHILD !== "1") {
	test("gear stats: buckets, labels, listing parity, contract and performance", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_GEAR_STATS_TEST_CHILD: "1" },
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

	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => [1, 0, 0, 0],
	}));
	mock.module("../db", () => ({ db }));
	mock.module("../inngest/client", () => ({
		inngest: { send: async () => undefined },
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
	const {
		APERTURE_BUCKETS,
		FOCAL_LENGTH_BUCKETS,
		gearStats,
		ISO_BUCKETS,
		SHUTTER_SPEED_BUCKETS,
	} = await import("../services/gear-stats");
	const { listFilterOptions, listPhotos } = await import(
		"../services/photo-catalog"
	);
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");

	const caller = appRouter.createCaller({ db });
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

	const INVALID_REQUEST = {
		error: { code: "INVALID_REQUEST", message: "Request validation failed" },
	};

	type Exif = {
		cameraMake?: string | null;
		cameraModel?: string | null;
		lensModel?: string | null;
		focalLength?: number | null;
		aperture?: string | null;
		shutterSpeed?: string | null;
		iso?: number | null;
		dateTaken?: string | null;
		gpsLatitude?: string | null;
		gpsLongitude?: string | null;
	};

	afterAll(() => sqlite.close());
	beforeEach(() => {
		sqlite.run("DELETE FROM event_photos");
		sqlite.run("DELETE FROM events");
		sqlite.run("DELETE FROM photo_tags");
		db.delete(photoExif).run();
		db.delete(photos).run();
	});

	/** One photo; an EXIF row exists only when `exif` is given. */
	function addPhoto(path: string, exif?: Exif, rating = 0): number {
		const photo = db
			.insert(photos)
			.values({
				path,
				name: path.split("/").at(-1) ?? path,
				size: 1,
				createdAt: new Date(0),
				modifiedAt: new Date(0),
				isRaw: /\.arw$/i.test(path),
				rating,
			})
			.returning()
			.get();
		if (exif)
			db.insert(photoExif)
				.values({ photoId: photo.id, ...exif })
				.run();
		return photo.id;
	}
	const counts = (buckets: { count: number }[]) =>
		buckets.map((bucket) => bucket.count);
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

	describe("bucket definitions", () => {
		test("are the fixed contract, in ascending order", () => {
			expect(FOCAL_LENGTH_BUCKETS).toEqual([
				{ label: "≤15 mm", min: null, max: 15 },
				{ label: "16–23 mm", min: 16, max: 23 },
				{ label: "24–34 mm", min: 24, max: 34 },
				{ label: "35–49 mm", min: 35, max: 49 },
				{ label: "50–84 mm", min: 50, max: 84 },
				{ label: "85–134 mm", min: 85, max: 134 },
				{ label: "135–299 mm", min: 135, max: 299 },
				{ label: "≥300 mm", min: 300, max: null },
			]);
			expect(APERTURE_BUCKETS).toEqual([
				{ label: "≤f/1.9", min: null, max: 1.9 },
				{ label: "f/2–2.7", min: 2, max: 2.7 },
				{ label: "f/2.8–3.9", min: 2.8, max: 3.9 },
				{ label: "f/4–5.5", min: 4, max: 5.5 },
				{ label: "f/5.6–7.9", min: 5.6, max: 7.9 },
				{ label: "f/8–10.9", min: 8, max: 10.9 },
				{ label: "≥f/11", min: 11, max: null },
			]);
			expect(SHUTTER_SPEED_BUCKETS).toEqual([
				{ label: "≤1/2000 s", min: null, max: 0.0005 },
				{ label: "1/1000–1/500 s", min: 0.0005, max: 0.002 },
				{ label: "1/250–1/125 s", min: 0.002, max: 0.008 },
				{ label: "1/60–1/30 s", min: 0.008, max: 0.0334 },
				{ label: "1/15–1/2 s", min: 0.0334, max: 0.5 },
				{ label: ">1/2 s", min: 0.5, max: null },
			]);
			expect(ISO_BUCKETS).toEqual([
				{ label: "≤200", min: null, max: 200 },
				{ label: "400", min: 201, max: 400 },
				{ label: "800", min: 401, max: 800 },
				{ label: "1600", min: 801, max: 1600 },
				{ label: "3200", min: 1601, max: 3200 },
				{ label: "6400", min: 3201, max: 6400 },
				{ label: ">6400", min: 6401, max: null },
			]);
		});

		test("an empty set has every bucket with zero counts", () => {
			const stats = gearStats(db);
			expect(stats).toEqual({
				total: 0,
				withExif: 0,
				cameras: [],
				lenses: [],
				focalLengths: FOCAL_LENGTH_BUCKETS.map((bucket) => ({
					...bucket,
					count: 0,
				})),
				apertures: APERTURE_BUCKETS.map((bucket) => ({ ...bucket, count: 0 })),
				shutterSpeeds: SHUTTER_SPEED_BUCKETS.map((bucket) => ({
					...bucket,
					count: 0,
				})),
				isos: ISO_BUCKETS.map((bucket) => ({ ...bucket, count: 0 })),
				cameraYears: [],
			});
		});
	});

	describe("histograms", () => {
		test("focal length edges fall on both sides; missing and non-positive are excluded", () => {
			const values = [1, 15, 16, 23, 24, 34, 35, 49, 50, 84, 85, 134, 135];
			for (const [index, focalLength] of [
				...values,
				299,
				300,
				1200,
			].entries()) {
				addPhoto(`f/${index}.jpg`, { focalLength });
			}
			addPhoto("f/zero.jpg", { focalLength: 0 });
			addPhoto("f/negative.jpg", { focalLength: -35 });
			addPhoto("f/null.jpg", { focalLength: null, iso: 100 });
			addPhoto("f/no-exif.jpg");
			const stats = gearStats(db);
			expect(counts(stats.focalLengths)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
			expect(stats.total).toBe(20);
			// Other dimensions are unaffected: only the one ISO.
			expect(counts(stats.isos)).toEqual([1, 0, 0, 0, 0, 0, 0]);
			expect(counts(stats.apertures)).toEqual([0, 0, 0, 0, 0, 0, 0]);
		});

		test("only one bucket filled keeps every other bucket at zero", () => {
			addPhoto("z/a.jpg", { focalLength: 40 });
			addPhoto("z/b.jpg", { focalLength: 40 });
			const stats = gearStats(db);
			expect(
				stats.focalLengths.map(({ label, count }) => [label, count]),
			).toEqual([
				["≤15 mm", 0],
				["16–23 mm", 0],
				["24–34 mm", 0],
				["35–49 mm", 2],
				["50–84 mm", 0],
				["85–134 mm", 0],
				["135–299 mm", 0],
				["≥300 mm", 0],
			]);
			expect(stats.shutterSpeeds).toHaveLength(SHUTTER_SPEED_BUCKETS.length);
			expect(counts(stats.shutterSpeeds).every((count) => count === 0)).toBe(
				true,
			);
		});

		test("aperture edges compare the f-number rounded to one decimal; unparseable text is excluded", () => {
			const valid = [
				"f/1.4",
				"f/1.9", // ≤f/1.9
				"f/2.0",
				"f/2.7",
				"f/2.74", // f/2–2.7
				"f/2.8",
				"f/3.9",
				"f/2.76", // f/2.8–3.9
				"f/4.0",
				"f/5.5", // f/4–5.5
				"f/5.6",
				"f/7.9", // f/5.6–7.9
				"f/8.0",
				"f/10.9",
				"f/10.94",
				"f/8", // f/8–10.9
				"f/11.0",
				"f/22.0",
				"f/10.96", // ≥f/11
			];
			const invalid = [
				"F/2.8",
				"2.8",
				"f/",
				"f/abc",
				"",
				"f/-2.8",
				"f/0.0",
				"f/2.8 ",
				"f/2,8",
				null,
			];
			for (const [index, aperture] of [...valid, ...invalid].entries()) {
				// Every row has a focal length, so exclusion is per dimension.
				addPhoto(`a/${index}.jpg`, { aperture, focalLength: 50 });
			}
			const stats = gearStats(db);
			expect(counts(stats.apertures)).toEqual([2, 3, 3, 2, 2, 4, 3]);
			expect(counts(stats.focalLengths)[4]).toBe(valid.length + invalid.length);
		});

		test("shutter edges: lower bound exclusive, upper inclusive; unparseable text is excluded", () => {
			const valid = [
				"1/4000",
				"1/2000", // ≤1/2000 s
				"1/1999",
				"1/1000",
				"1/500", // 1/1000–1/500 s
				"1/499",
				"1/250",
				"1/125", // 1/250–1/125 s
				"1/60",
				"1/30", // 1/60–1/30 s
				"1/29",
				"1/15",
				"1/2",
				"0.5s", // 1/15–1/2 s
				"1.0s",
				"30.0s", // >1/2 s
			];
			const invalid = [
				"abc",
				"1/0",
				"2/3",
				"1/",
				"s",
				"0.0s",
				"-1.0s",
				"1/250s",
				" 1/250",
				"",
				null,
			];
			for (const [index, shutterSpeed] of [...valid, ...invalid].entries()) {
				addPhoto(`s/${index}.jpg`, { shutterSpeed, iso: 100 });
			}
			const stats = gearStats(db);
			expect(counts(stats.shutterSpeeds)).toEqual([2, 3, 3, 2, 4, 2]);
			expect(counts(stats.isos)[0]).toBe(valid.length + invalid.length);
		});

		test("ISO edges fall on both sides; zero and missing are excluded", () => {
			const values = [50, 200, 201, 400, 401, 800, 801, 1600, 1601, 3200];
			for (const [index, iso] of [
				...values,
				3201,
				6400,
				6401,
				102400,
			].entries()) {
				addPhoto(`i/${index}.jpg`, { iso });
			}
			addPhoto("i/zero.jpg", { iso: 0 });
			addPhoto("i/null.jpg", { iso: null, lensModel: "Lens" });
			const stats = gearStats(db);
			expect(counts(stats.isos)).toEqual([2, 2, 2, 2, 2, 2, 2]);
		});
	});

	describe("cameras and lenses", () => {
		test("label is the model when it starts with the make, else make + model, matching the camera filter and filterOptions", async () => {
			addPhoto("c/1.jpg", { cameraMake: "Canon", cameraModel: "Canon EOS R5" });
			addPhoto("c/2.jpg", { cameraMake: "SONY", cameraModel: "ILCE-7M3" });
			addPhoto("c/3.jpg", {
				cameraMake: "NIKON CORPORATION",
				cameraModel: "NIKON Z 6",
			});
			// LIKE is ASCII case-insensitive.
			addPhoto("c/4.jpg", { cameraMake: "Apple", cameraModel: "apple iPhone" });
			addPhoto("c/5.jpg", { cameraMake: "Canon", cameraModel: "Canon EOS R5" });
			// A camera needs both make and model; such rows still count as EXIF.
			addPhoto("c/make-only.jpg", { cameraMake: "Leica" });
			addPhoto("c/model-only.jpg", { cameraModel: "Q2" });
			const stats = gearStats(db);
			expect(stats.cameras).toEqual([
				{ label: "Canon EOS R5", count: 2 },
				{ label: "NIKON CORPORATION NIKON Z 6", count: 1 },
				{ label: "SONY ILCE-7M3", count: 1 },
				{ label: "apple iPhone", count: 1 },
			]);
			expect(stats.withExif).toBe(7);
			for (const { label, count } of stats.cameras) {
				expect((await listPhotos(db, { camera: label })).total).toBe(count);
				expect(gearStats(db, { camera: label }).cameras).toEqual([
					{ label, count },
				]);
			}
			expect((await listFilterOptions(db)).cameras.sort()).toEqual(
				stats.cameras.map((camera) => camera.label).sort(),
			);
		});

		test("sorts count descending, then label in byte order; lists every entry", () => {
			const add = (label: string, times: number, lens: string) => {
				for (let index = 0; index < times; index++) {
					addPhoto(`t/${label}-${lens}-${index}.jpg`, {
						cameraMake: label,
						cameraModel: label,
						lensModel: lens,
					});
				}
			};
			add("Zeta", 2, "Lens B");
			add("Alpha", 2, "Lens A");
			add("alpha", 2, "lens a");
			add("Beta", 1, "Lens B");
			for (let index = 0; index < 30; index++) {
				addPhoto(`t/many-${index}.jpg`, {
					cameraMake: `Cam${String(index).padStart(2, "0")}`,
					cameraModel: "X",
					lensModel: `L${String(index).padStart(2, "0")}`,
				});
			}
			// Empty lens text is not a lens.
			addPhoto("t/empty-lens.jpg", { lensModel: "" });
			const stats = gearStats(db);
			expect(stats.cameras.slice(0, 5)).toEqual([
				{ label: "Alpha", count: 2 },
				{ label: "Zeta", count: 2 },
				{ label: "alpha", count: 2 },
				{ label: "Beta", count: 1 },
				{ label: "Cam00 X", count: 1 },
			]);
			expect(stats.cameras).toHaveLength(34);
			expect(stats.lenses.slice(0, 4)).toEqual([
				{ label: "Lens B", count: 3 },
				{ label: "Lens A", count: 2 },
				{ label: "lens a", count: 2 },
				{ label: "L00", count: 1 },
			]);
			expect(stats.lenses).toHaveLength(33);
			expect(stats.lenses.at(-1)).toEqual({ label: "L29", count: 1 });
		});
	});

	describe("photo set", () => {
		let ids: Record<string, number>;
		const SONY = { cameraMake: "SONY", cameraModel: "ILCE-7M3" };
		beforeEach(() => {
			const day = "2024:05:01 10:00:00";
			ids = {
				pair1Jpg: addPhoto(
					"a/IMG_1.JPG",
					{ ...SONY, dateTaken: day, focalLength: 35, iso: 100 },
					3,
				),
				pair1Raw: addPhoto(
					"a/IMG_1.ARW",
					{ ...SONY, dateTaken: day, focalLength: 35, iso: 100 },
					5,
				),
				pair2Jpg: addPhoto("a/IMG_2.JPG", {
					...SONY,
					dateTaken: "2024:05:02 09:00:00",
					lensModel: "FE 35mm F1.8",
				}),
				pair2Raw: addPhoto("a/IMG_2.ARW", {
					...SONY,
					dateTaken: "2024:05:02 09:00:00",
					lensModel: "FE 35mm F1.8",
				}),
				loneRaw: addPhoto("a/IMG_3.ARW", {
					...SONY,
					dateTaken: "2023:01:01 00:00:00",
				}),
				sub: addPhoto(
					"a/sub/x.jpg",
					{
						cameraMake: "Canon",
						cameraModel: "Canon EOS R5",
						dateTaken: day,
						iso: 3200,
					},
					4,
				),
				noExif: addPhoto("b/y.heic"),
				gpsOnly: addPhoto("b/gps.jpg", {
					dateTaken: day,
					gpsLatitude: "48.85",
					gpsLongitude: "2.35",
				}),
			};
			// The tag holds only the RAW of pair 1, so the RAW is shown.
			sqlite
				.query("INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, ?, ?)")
				.run(ids.pair1Raw, "dog", 0.9);
			sqlite.run(
				`INSERT INTO events (id, start_at, end_at, photo_count, cover_photo_id, events_version)
				 VALUES (${ids.pair2Jpg}, '2024-05-01T10:00:00', '2024-05-02T09:00:00', 2, ${ids.pair2Jpg}, 1)`,
			);
			for (const photoId of [ids.pair2Jpg, ids.sub]) {
				sqlite
					.query("INSERT INTO event_photos (event_id, photo_id) VALUES (?, ?)")
					.run(ids.pair2Jpg, photoId);
			}
		});

		test("a RAW+JPEG pair counts once", () => {
			const stats = gearStats(db);
			expect(stats.total).toBe(6);
			// gps/date-only and no-EXIF rows have no gear data.
			expect(stats.withExif).toBe(4);
			expect(stats.cameras).toEqual([
				{ label: "SONY ILCE-7M3", count: 3 },
				{ label: "Canon EOS R5", count: 1 },
			]);
			expect(stats.lenses).toEqual([{ label: "FE 35mm F1.8", count: 1 }]);
			expect(counts(stats.focalLengths)[3]).toBe(1);
			expect(counts(stats.isos)).toEqual([1, 0, 0, 0, 1, 0, 0]);
		});

		const FILTERS = (): Parameters<typeof listPhotos>[1][] => [
			{},
			{ folder: "a" },
			{ folder: "a/sub" },
			{ camera: "SONY ILCE-7M3" },
			{ lens: "FE 35mm F1.8" },
			{ iso: 3200 },
			{ minRating: 4 },
			{ tag: "dog" },
			{ event: ids.pair2Jpg },
			{ event: 999_999 },
			{ capturedDate: "2024-05-01" },
			{ dateMonth: "2024:05" },
			{ filterRaw: "raw" },
			{ filterRaw: "standard" },
			{ folder: "a", camera: "SONY ILCE-7M3", minRating: 4 },
		];

		test("total, withExif and cameras equal the listing for the same filters", async () => {
			const label = (exif: {
				cameraMake: string | null;
				cameraModel: string | null;
			}) =>
				exif.cameraMake === null || exif.cameraModel === null
					? null
					: exif.cameraModel
								.toLowerCase()
								.startsWith(exif.cameraMake.toLowerCase())
						? exif.cameraModel
						: `${exif.cameraMake} ${exif.cameraModel}`;
			for (const filters of FILTERS()) {
				const listing = await listPhotos(db, filters);
				const stats = gearStats(db, filters);
				expect({ filters, total: stats.total }).toEqual({
					filters,
					total: listing.total,
				});
				expect(stats.withExif).toBe(
					listing.photos.filter(
						({ exif }) =>
							exif !== null &&
							[
								exif.cameraMake,
								exif.cameraModel,
								exif.lensModel,
								exif.focalLength,
								exif.aperture,
								exif.shutterSpeed,
								exif.iso,
							].some((value) => value !== null),
					).length,
				);
				const cameraCounts = new Map<string, number>();
				for (const { exif } of listing.photos) {
					const camera = exif && label(exif);
					if (camera)
						cameraCounts.set(camera, (cameraCounts.get(camera) ?? 0) + 1);
				}
				expect(
					Object.fromEntries(
						stats.cameras.map(({ label, count }) => [label, count]),
					),
				).toEqual(Object.fromEntries(cameraCounts));
				expect(await caller.gearStats(filters)).toEqual(stats);
			}
			// Spot checks of the stacking semantics.
			expect(gearStats(db, { minRating: 4 }).total).toBe(2); // RAW 1 + sub
			expect(gearStats(db, { tag: "dog" }).cameras).toEqual([
				{ label: "SONY ILCE-7M3", count: 1 },
			]);
			expect(gearStats(db, { event: ids.pair2Jpg }).total).toBe(2);
			expect(gearStats(db, { event: 999_999 }).total).toBe(0);
			expect(gearStats(db, { filterRaw: "raw" }).total).toBe(3);
		});

		test("v1 returns the service DTO for the /photos query and its total", async () => {
			const queries = [
				"",
				"folder=a",
				"camera=SONY%20ILCE-7M3",
				"minRating=4",
				"tag=dog",
				`event=${ids.pair2Jpg}`,
				"capturedDate=2024-05-01",
				"dateMonth=2024-05",
				"filterRaw=raw",
				"iso=3200",
				"north=60&south=40&east=10&west=-10",
			];
			const photosTotal = z.object({ total: z.number() });
			for (const query of queries) {
				const response = await app.request(`/api/v1/gear-stats?${query}`);
				expect(response.status).toBe(200);
				const body = gearStatsResponseSchema.parse(await response.json());
				const listing = await app.request(`/api/v1/photos?${query}`);
				expect({ query, total: body.total }).toEqual({
					query,
					total: photosTotal.parse(await listing.json()).total,
				});
			}
			const response = await app.request("/api/v1/gear-stats?folder=a");
			expect(await response.json()).toEqual(gearStats(db, { folder: "a" }));
			// The v1 `YYYY-MM` month matches the stored `YYYY:MM` prefix.
			const month = gearStatsResponseSchema.parse(
				await (
					await app.request("/api/v1/gear-stats?dateMonth=2024-05")
				).json(),
			);
			expect(month.total).toBe(gearStats(db, { dateMonth: "2024:05" }).total);
			expect(month.total).toBe(4);
		});

		test("invalid filters are 400 INVALID_REQUEST (v1) and BAD_REQUEST (tRPC)", async () => {
			for (const query of [
				"minRating=0",
				"minRating=6",
				"flag=maybe",
				"filterRaw=jpeg",
				"iso=abc",
				"iso=1.5",
				"dateMonth=2024:05",
				"dateMonth=2024-13",
				"capturedDate=2024-02-30",
				"capturedDate=1899-12-31",
				"tag=Not%20A%20Slug",
				"country=fr",
				"place=0",
				"event=0",
				"event=abc",
				"collectionId=-1",
				"north=10",
				"north=10&south=20&east=0&west=0",
			]) {
				const response = await app.request(`/api/v1/gear-stats?${query}`);
				expect({ query, status: response.status }).toEqual({
					query,
					status: 400,
				});
				expect(await response.json()).toEqual(INVALID_REQUEST);
			}
			for (const input of [
				{ minRating: 0 },
				{ capturedDate: "2024-02-30" },
				{ event: 0 },
				{ tag: "Bad Tag" },
				{ filterRaw: "jpeg" as "all" },
			]) {
				expect(await trpcErrorCode(caller.gearStats(input))).toBe(
					"BAD_REQUEST",
				);
			}
		});
	});

	test("cameraYears: year ascending, count descending, camera ascending; invalid and pre-1900 years excluded", () => {
		const canon = { cameraMake: "Canon", cameraModel: "Canon EOS R5" };
		const sony = { cameraMake: "SONY", cameraModel: "ILCE-7M3" };
		const alpha = { cameraMake: "Alpha", cameraModel: "Alpha" };
		const add = (camera: Exif, dateTaken: string | null, times = 1) => {
			for (let index = 0; index < times; index++) {
				addPhoto(`y/${crypto.randomUUID()}.jpg`, { ...camera, dateTaken });
			}
		};
		add(canon, "2021:06:01 10:00:00", 2);
		add(canon, "2019:01:01 10:00:00");
		add(canon, "1900:01:01 00:00:00");
		add(sony, "2021:03:01 10:00:00");
		add(sony, "2021-03-02T10:00:00");
		add(sony, "2019:12:31 23:59:59", 3);
		add(alpha, "2021:07:01 10:00:00");
		for (const invalid of [
			"1899:12:31 10:00:00",
			"0000:05:01 10:00:00",
			"abcd:01:01 10:00:00",
			"202:01:01 10:00:00",
			"2021/05/01 10:00:00",
			"",
			null,
		]) {
			add(canon, invalid);
		}
		// Dated but without a camera label.
		addPhoto("y/no-camera.jpg", {
			lensModel: "Lens",
			dateTaken: "2021:01:01 00:00:00",
		});
		const stats = gearStats(db);
		expect(stats.cameraYears).toEqual([
			{ camera: "Canon EOS R5", year: 1900, count: 1 },
			{ camera: "SONY ILCE-7M3", year: 2019, count: 3 },
			{ camera: "Canon EOS R5", year: 2019, count: 1 },
			{ camera: "Canon EOS R5", year: 2021, count: 2 },
			{ camera: "SONY ILCE-7M3", year: 2021, count: 2 },
			{ camera: "Alpha", year: 2021, count: 1 },
		]);
		// Undated rows still count toward cameras.
		expect(stats.cameras[0]).toEqual({ label: "Canon EOS R5", count: 11 });
	});

	test("checked-in OpenAPI document describes gear-stats with the /photos query", async () => {
		const parameterSchema = z
			.object({ name: z.string(), schema: z.unknown() })
			.passthrough();
		const componentSchema = z
			.object({
				required: z.array(z.string()).optional(),
				properties: z.record(z.record(z.unknown())).optional(),
			})
			.passthrough();
		const document = z
			.object({
				paths: z.record(
					z.record(
						z.object({
							parameters: z.array(parameterSchema).optional(),
							responses: z.record(z.unknown()),
						}),
					),
				),
				components: z.object({ schemas: z.record(componentSchema) }),
			})
			.parse(
				await Bun.file(
					new URL("../routes/openapi-v1.json", import.meta.url),
				).json(),
			);
		const operation = document.paths["/api/v1/gear-stats"]?.get;
		expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
			"200",
			"400",
			"500",
		]);
		expect(operation?.parameters).toEqual(
			document.paths["/api/v1/photos"].get?.parameters,
		);
		const { schemas } = document.components;
		const shape = gearStatsResponseSchema.shape;
		expect(schemas.GearStatsResponse.required?.sort()).toEqual(
			Object.keys(shape).sort(),
		);
		expect(schemas.GearCount.required?.sort()).toEqual(
			Object.keys(shape.cameras.element.shape).sort(),
		);
		expect(schemas.GearBucket.required?.sort()).toEqual(
			Object.keys(shape.focalLengths.element.shape).sort(),
		);
		expect(schemas.GearCameraYear.required?.sort()).toEqual(
			Object.keys(shape.cameraYears.element.shape).sort(),
		);
		const properties = schemas.GearStatsResponse.properties ?? {};
		for (const [name, buckets] of [
			["focalLengths", FOCAL_LENGTH_BUCKETS],
			["apertures", APERTURE_BUCKETS],
			["shutterSpeeds", SHUTTER_SPEED_BUCKETS],
			["isos", ISO_BUCKETS],
		] as const) {
			expect(properties[name]).toMatchObject({
				minItems: buckets.length,
				maxItems: buckets.length,
			});
		}
	});

	test("performance over 20,000 photos with full EXIF in a file database", async () => {
		const COUNT = 20_000;
		const directory = mkdtempSync(join(tmpdir(), "photobrain-gear-stats-"));
		const file = new Database(join(directory, "perf.db"));
		try {
			const fileDb = drizzle(file, { schema }) as unknown as typeof db;
			migrate(fileDb, { migrationsFolder: MIGRATIONS_FOLDER });
			let seed = 11;
			const random = () => {
				seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
				return seed / 2_147_483_648;
			};
			const pick = <T>(values: readonly T[]) =>
				values[Math.floor(random() * values.length)];
			const CAMERAS = [
				["SONY", "ILCE-7M3"],
				["SONY", "ILCE-7RM5"],
				["Canon", "Canon EOS R5"],
				["FUJIFILM", "X-T5"],
				["NIKON CORPORATION", "NIKON Z 6"],
				["Apple", "iPhone 15 Pro"],
			] as const;
			const LENSES = Array.from({ length: 12 }, (_, index) => `Lens ${index}`);
			const APERTURES = [
				"f/1.4",
				"f/1.8",
				"f/2.8",
				"f/4.0",
				"f/5.6",
				"f/8.0",
				"f/11.0",
				"f/16.0",
			];
			const SHUTTERS = [
				"1/4000",
				"1/1000",
				"1/500",
				"1/250",
				"1/125",
				"1/60",
				"1/30",
				"1/8",
				"1.0s",
				"2.0s",
			];
			const ISOS = [100, 200, 400, 800, 1600, 3200, 6400, 12800];
			const insertPhoto = file.query<{ id: number }, [string, string, number]>(
				`INSERT INTO photos (path, name, size, created_at, modified_at, is_raw)
				 VALUES (?, ?, 1, 0, 0, ?) RETURNING id`,
			);
			const insertExif = file.prepare(
				`INSERT INTO photo_exif (photo_id, camera_make, camera_model, lens_model, focal_length,
					aperture, shutter_speed, iso, date_taken) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			const insertedId = (row: { id: number } | null) => {
				if (!row) throw new Error("INSERT ... RETURNING produced no row");
				return row.id;
			};
			let inserted = 0;
			let pairs = 0;
			file.transaction(() => {
				for (let index = 0; inserted < COUNT; index++) {
					const [make, model] = pick(CAMERAS);
					const exif = [
						make,
						model,
						pick(LENSES),
						8 + Math.floor(random() * 600),
						pick(APERTURES),
						pick(SHUTTERS),
						pick(ISOS),
						`${2011 + (index % 15)}:${String(1 + (index % 12)).padStart(2, "0")}:15 12:00:00`,
					] as const;
					const folder = `y${2011 + (index % 15)}/f${index % 40}`;
					insertExif.run(
						insertedId(
							insertPhoto.get(
								`${folder}/IMG_${index}.JPG`,
								`IMG_${index}.JPG`,
								0,
							),
						),
						...exif,
					);
					inserted++;
					// Every 10th photo has a RAW sibling with the same date.
					if (index % 10 === 0 && inserted < COUNT) {
						insertExif.run(
							insertedId(
								insertPhoto.get(
									`${folder}/IMG_${index}.ARW`,
									`IMG_${index}.ARW`,
									1,
								),
							),
							...exif,
						);
						inserted++;
						pairs++;
					}
				}
			})();
			file.run("ANALYZE");

			const stats = gearStats(fileDb);
			expect(stats.total).toBe(COUNT - pairs);
			expect(stats.withExif).toBe(stats.total);
			const sum = (values: { count: number }[]) =>
				values.reduce((total, value) => total + value.count, 0);
			for (const dimension of [
				stats.cameras,
				stats.lenses,
				stats.focalLengths,
				stats.apertures,
				stats.shutterSpeeds,
				stats.isos,
				stats.cameraYears,
			]) {
				expect(sum(dimension)).toBe(stats.total);
			}
			expect((await listPhotos(fileDb, { folder: "y2015/f4" })).total).toBe(
				gearStats(fileDb, { folder: "y2015/f4" }).total,
			);

			const median = (run: () => unknown) => {
				const samples: number[] = [];
				for (let index = 0; index < 5; index++) {
					const started = performance.now();
					run();
					samples.push(performance.now() - started);
				}
				return samples.sort((left, right) => left - right)[2];
			};
			const allMs = median(() => gearStats(fileDb));
			const folderMs = median(() => gearStats(fileDb, { folder: "y2015/f4" }));
			const cameraMs = median(() =>
				gearStats(fileDb, { camera: "Canon EOS R5" }),
			);
			expect(allMs).toBeLessThan(50);
			expect(folderMs).toBeLessThan(50);
			expect(cameraMs).toBeLessThan(50);

			const statements: string[] = [];
			const original = file.prepare;
			file.prepare = ((...args: Parameters<typeof original>) => {
				statements.push(args[0]);
				return original.apply(file, args);
			}) as typeof original;
			try {
				gearStats(fileDb);
			} finally {
				file.prepare = original;
			}
			// One statement, no per-photo queries.
			expect(statements).toHaveLength(1);
			const plan = file
				.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${statements[0]}`)
				.all()
				.map((row) => row.detail)
				.join("\n");
			// The set is materialized once; EXIF joins by the unique photo_id index
			// and pairs are looked up through the stem index, never a table scan.
			expect(plan).toMatch(/MATERIALIZE gear/);
			expect(plan).toMatch(
				/SEARCH gear_exif USING INDEX photo_exif_photo_id_unique \(photo_id=\?\)/,
			);
			expect(plan).toMatch(
				/SEARCH pair_member USING INDEX idx_photos_pair_stem \(<expr>=\?\)/,
			);
			expect(plan).not.toMatch(/SCAN (gear_exif|photo_exif|pair_member)\b/);
			expect(plan.match(/SCAN photos\b/g) ?? []).toHaveLength(1);

			const log = (line: string) => console.log(`${PERF_LOG_PREFIX} ${line}`);
			log(
				`gearStats over ${COUNT} photos (${pairs} RAW+JPEG pairs, total ${stats.total}): all ${allMs.toFixed(2)} ms median; folder ${folderMs.toFixed(2)} ms; camera ${cameraMs.toFixed(2)} ms; ${statements.length} statement`,
			);
			log(`EXPLAIN gearStats: ${plan.replaceAll("\n", " | ")}`);
		} finally {
			file.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
}
