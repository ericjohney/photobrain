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
import { photoEmbedding, photoExif, photos } from "../db/schema";
import {
	onThisDayResponseSchema,
	smartAlbumFiltersRequestSchema,
} from "../routes/v1-schemas";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[on-this-day-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";

// Mocks of the native addon, ../db and the Inngest client are process-wide;
// run the suite in an isolated child like the places and pairs suites.
if (process.env.PHOTOBRAIN_ON_THIS_DAY_TEST_CHILD !== "1") {
	test("on this day: groups, capturedDate filter, contract, migration and performance", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_ON_THIS_DAY_TEST_CHILD: "1" },
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
	const { onThisDay, ON_THIS_DAY_MAX_YEARS } = await import(
		"../services/on-this-day"
	);
	const { listPhotos } = await import("../services/photo-catalog");
	const { searchPhotosByText } = await import("../services/vector-search");
	const { canonicalizeSmartAlbumFilters } = await import(
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

	const INVALID_REQUEST = {
		error: { code: "INVALID_REQUEST", message: "Request validation failed" },
	};
	// Malformed, impossible, or pre-1900 calendar dates.
	const INVALID_DATES = [
		"",
		"2024-02-30",
		"2023-02-29",
		"1900-02-29",
		"2024-13-01",
		"2024-00-10",
		"2024-04-31",
		"2024-5-01",
		"2024/05/01",
		"2024:05:01",
		"24-05-01",
		"abcd-ef-gh",
		"1899-12-31",
		"2024-05-01T00:00:00",
	];

	type PhotoOptions = {
		dateTaken?: string | null;
		rating?: number;
		flag?: "pick" | "reject";
		gps?: readonly [string, string];
		vector?: readonly number[];
		thumbnailUpdatedAt?: Date;
	};

	afterAll(() => sqlite.close());
	beforeEach(() => {
		sqlite.run("DELETE FROM smart_albums");
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photos).run();
	});

	/** One photo; an EXIF row exists when `dateTaken` (even null) or `gps` is given. */
	function addPhoto(path: string, options: PhotoOptions = {}): number {
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
				thumbnailUpdatedAt: options.thumbnailUpdatedAt,
				embeddingStatus: "completed",
				rating: options.rating ?? 0,
				flag: options.flag,
			})
			.returning()
			.get();
		if (options.dateTaken !== undefined || options.gps) {
			db.insert(photoExif)
				.values({
					photoId: photo.id,
					dateTaken: options.dateTaken ?? null,
					gpsLatitude: options.gps?.[0],
					gpsLongitude: options.gps?.[1],
				})
				.run();
		}
		db.insert(photoEmbedding)
			.values({
				photoId: photo.id,
				embedding: Buffer.from(
					new Float32Array(options.vector ?? [0, 0, 0, 1]).buffer,
				),
				modelVersion: EMBEDDING_MODEL_VERSION,
				thumbnailKey,
				createdAt: new Date(0),
			})
			.run();
		return photo.id;
	}

	const sorted = (values: number[]) =>
		[...values].sort((left, right) => left - right);
	const photoIdsBody = z.object({
		photos: z.array(z.object({ id: z.number() }).passthrough()),
	});
	const pointIdsBody = z.object({
		points: z.array(z.object({ id: z.number() }).passthrough()),
	});
	const responseIds = async (response: Response) =>
		sorted(
			photoIdsBody.parse(await response.json()).photos.map((photo) => photo.id),
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
	/** The year groups without covers, for compact expectations. */
	const groups = (date: string) =>
		onThisDay(db, date).years.map(({ cover: _cover, ...group }) => group);

	describe("onThisDay", () => {
		test("orders earlier years most recent first with yearsAgo, over both stored formats", async () => {
			addPhoto("a/2025.jpg", { dateTaken: "2025:10:03 09:00:00" });
			addPhoto("a/2025b.jpg", { dateTaken: "2025:10:03 18:30:00" });
			addPhoto("a/2023.jpg", { dateTaken: "2023-10-03T12:00:00" });
			addPhoto("a/2020.jpg", { dateTaken: "2020-10-03 07:15:00" });
			addPhoto("a/2010.jpg", { dateTaken: "2010:10:03" });
			// Other days, the current year, and future years never appear.
			addPhoto("a/other-day.jpg", { dateTaken: "2024:10:04 00:00:00" });
			addPhoto("a/day-before.jpg", { dateTaken: "2024:10:02 23:59:59" });
			addPhoto("a/other-month.jpg", { dateTaken: "2024:11:03 10:00:00" });
			addPhoto("a/this-year.jpg", { dateTaken: "2026:10:03 08:00:00" });
			addPhoto("a/future.jpg", { dateTaken: "2027:10:03 08:00:00" });
			addPhoto("a/far-future.jpg", { dateTaken: "2099-10-03 08:00:00" });

			const expected = [
				{ year: 2025, yearsAgo: 1, capturedDate: "2025-10-03", count: 2 },
				{ year: 2023, yearsAgo: 3, capturedDate: "2023-10-03", count: 1 },
				{ year: 2020, yearsAgo: 6, capturedDate: "2020-10-03", count: 1 },
				{ year: 2010, yearsAgo: 16, capturedDate: "2010-10-03", count: 1 },
			];
			expect(groups("2026-10-03")).toEqual(expected);
			const viaTrpc = await caller.onThisDay({ date: "2026-10-03" });
			expect(viaTrpc.date).toBe("2026-10-03");
			expect(viaTrpc.years.map(({ cover: _cover, ...group }) => group)).toEqual(
				expected,
			);
			const response = await app.request("/api/v1/on-this-day?date=2026-10-03");
			expect(response.status).toBe(200);
			const body = onThisDayResponseSchema.parse(await response.json());
			expect(body.date).toBe("2026-10-03");
			expect(body.years.map(({ cover: _cover, ...group }) => group)).toEqual(
				expected,
			);
			// Every group's capturedDate opens a grid with exactly `count` rows.
			for (const group of expected) {
				expect(
					(await listPhotos(db, { capturedDate: group.capturedDate })).total,
				).toBe(group.count);
			}
			// The day before has only the one 2024 photo; a year with nothing is empty.
			expect(groups("2025-10-02")).toEqual([
				{ year: 2024, yearsAgo: 1, capturedDate: "2024-10-02", count: 1 },
			]);
			expect(groups("2026-01-01")).toEqual([]);
			expect(groups("2026-10-03").every((group) => group.year < 2026)).toBe(
				true,
			);
			// Asking from an earlier year excludes that year and later ones.
			expect(groups("2023-10-03").map((group) => group.year)).toEqual([
				2020, 2010,
			]);
		});

		test("rejects a missing or invalid date (tRPC BAD_REQUEST, v1 400)", async () => {
			for (const date of INVALID_DATES) {
				expect(await trpcErrorCode(caller.onThisDay({ date }))).toBe(
					"BAD_REQUEST",
				);
				const response = await app.request(
					`/api/v1/on-this-day?date=${encodeURIComponent(date)}`,
				);
				expect(response.status).toBe(400);
				expect(await response.json()).toEqual(INVALID_REQUEST);
				expect(() => onThisDay(db, date)).toThrow(RangeError);
			}
			const missing = await app.request("/api/v1/on-this-day");
			expect(missing.status).toBe(400);
			expect(await missing.json()).toEqual(INVALID_REQUEST);
			expect(
				await trpcErrorCode(
					caller.onThisDay({} as Parameters<typeof caller.onThisDay>[0]),
				),
			).toBe("BAD_REQUEST");
			// Real dates, including leap days and the 1900 boundary, are accepted.
			for (const date of ["2024-02-29", "2000-02-29", "1900-01-01"]) {
				expect(
					(await app.request(`/api/v1/on-this-day?date=${date}`)).status,
				).toBe(200);
				expect((await caller.onThisDay({ date })).years).toEqual([]);
			}
		});

		test("ignores photos without a valid capture date (no mtime fallback)", () => {
			addPhoto("b/null.jpg", { dateTaken: null });
			addPhoto("b/no-exif.jpg");
			addPhoto("b/empty.jpg", { dateTaken: "" });
			addPhoto("b/letters.jpg", { dateTaken: "abcd:10:03 10:00:00" });
			addPhoto("b/short-year.jpg", { dateTaken: "202:10:03 10:00:00" });
			addPhoto("b/zero.jpg", { dateTaken: "0000:10:03 00:00:00" });
			addPhoto("b/pre-1900.jpg", { dateTaken: "1899:10:03 10:00:00" });
			addPhoto("b/slashes.jpg", { dateTaken: "2020/10/03 10:00:00" });
			addPhoto("b/bad-separator.jpg", { dateTaken: "2020:10.03 10:00:00" });
			addPhoto("b/time-only.jpg", { dateTaken: "10:03" });
			addPhoto("b/valid.jpg", { dateTaken: "1900:10:03 10:00:00" });
			expect(groups("2026-10-03")).toEqual([
				{ year: 1900, yearsAgo: 126, capturedDate: "1900-10-03", count: 1 },
			]);
		});

		test("Feb 28 of a non-leap year includes Feb 29; other requests match exactly", async () => {
			// 2024: only Feb 29. 2020: both days. 2019: only Feb 28.
			const leapOnly = addPhoto("c/2024-0229.jpg", {
				dateTaken: "2024:02:29 10:00:00",
			});
			addPhoto("c/2020-0228.jpg", { dateTaken: "2020:02:28 10:00:00" });
			const both29 = addPhoto("c/2020-0229.jpg", {
				dateTaken: "2020-02-29 08:00:00",
			});
			addPhoto("c/2019-0228.jpg", { dateTaken: "2019:02:28 10:00:00" });
			// Impossible Feb 29s never appear.
			addPhoto("c/2023-0229.jpg", { dateTaken: "2023:02:29 10:00:00" });
			addPhoto("c/1900-0229.jpg", { dateTaken: "1900:02:29 10:00:00" });
			addPhoto("c/2024-0301.jpg", { dateTaken: "2024:03:01 10:00:00" });

			// Non-leap Feb 28: Feb 29 photos join; a year with both keeps Feb 28.
			const nonLeap = onThisDay(db, "2026-02-28").years;
			expect(nonLeap.map(({ cover: _cover, ...group }) => group)).toEqual([
				{ year: 2024, yearsAgo: 2, capturedDate: "2024-02-29", count: 1 },
				{ year: 2020, yearsAgo: 6, capturedDate: "2020-02-28", count: 2 },
				{ year: 2019, yearsAgo: 7, capturedDate: "2019-02-28", count: 1 },
			]);
			expect(nonLeap[0].cover.photoId).toBe(leapOnly);
			// Equal ratings: the later capture date (Feb 29) wins over the time.
			expect(nonLeap[1].cover.photoId).toBe(both29);
			// Each group's capturedDate opens the grid on that one day: a Feb 29-only
			// year opens its Feb 29; a year with both opens Feb 28 (Feb 28 rows only).
			expect(
				(await listPhotos(db, { capturedDate: "2024-02-29" })).photos.map(
					(photo) => photo.id,
				),
			).toEqual([leapOnly]);
			expect((await listPhotos(db, { capturedDate: "2020-02-28" })).total).toBe(
				1,
			);

			// Leap-year Feb 28 matches only Feb 28.
			expect(groups("2028-02-28")).toEqual([
				{ year: 2020, yearsAgo: 8, capturedDate: "2020-02-28", count: 1 },
				{ year: 2019, yearsAgo: 9, capturedDate: "2019-02-28", count: 1 },
			]);
			// Feb 29 matches only Feb 29.
			expect(groups("2028-02-29")).toEqual([
				{ year: 2024, yearsAgo: 4, capturedDate: "2024-02-29", count: 1 },
				{ year: 2020, yearsAgo: 8, capturedDate: "2020-02-29", count: 1 },
			]);
			// Non-leap Mar 1 does not pick up Feb 29.
			expect(groups("2026-03-01")).toEqual([
				{ year: 2024, yearsAgo: 2, capturedDate: "2024-03-01", count: 1 },
			]);
		});

		test("excludes rejects from count and cover", () => {
			addPhoto("d/kept.jpg", {
				dateTaken: "2024:10:03 10:00:00",
				rating: 1,
			});
			addPhoto("d/rejected-best.jpg", {
				dateTaken: "2024:10:03 11:00:00",
				rating: 5,
				flag: "reject",
			});
			const pick = addPhoto("d/pick.jpg", {
				dateTaken: "2024:10:03 09:00:00",
				rating: 2,
				flag: "pick",
			});
			// A year holding only rejects has no group.
			addPhoto("d/only-reject.jpg", {
				dateTaken: "2022:10:03 10:00:00",
				rating: 5,
				flag: "reject",
			});
			const result = onThisDay(db, "2026-10-03");
			expect(result.years.map(({ cover: _cover, ...group }) => group)).toEqual([
				{ year: 2024, yearsAgo: 2, capturedDate: "2024-10-03", count: 2 },
			]);
			// The rating-5 reject is not the cover; the best kept photo is.
			expect(result.years[0].cover.photoId).toBe(pick);
		});

		test("stacks RAW+JPEG pairs like the listing (a pair counts once)", async () => {
			const jpg = addPhoto("e/IMG_1.JPG", {
				dateTaken: "2024:10:03 10:00:00",
			});
			addPhoto("e/IMG_1.ARW", { dateTaken: "2024:10:03 10:00:00", rating: 5 });
			// The JPEG has no capture date, so it never hides its RAW on this day.
			const soloRaw = addPhoto("e/IMG_2.ARW", {
				dateTaken: "2024:10:03 12:00:00",
			});
			addPhoto("e/IMG_2.JPG", { dateTaken: null });
			// Different dates: not a pair, so both count on their own days.
			addPhoto("e/IMG_3.ARW", { dateTaken: "2024:10:03 13:00:00" });
			addPhoto("e/IMG_3.JPG", { dateTaken: "2024:10:04 13:00:00" });
			// A rejected JPEG hides its RAW in the grid and is itself excluded.
			addPhoto("e/IMG_4.JPG", {
				dateTaken: "2023:10:03 10:00:00",
				flag: "reject",
			});
			addPhoto("e/IMG_4.ARW", { dateTaken: "2023:10:03 10:00:00" });

			const result = onThisDay(db, "2026-10-03");
			expect(result.years.map(({ cover: _cover, ...group }) => group)).toEqual([
				{ year: 2024, yearsAgo: 2, capturedDate: "2024-10-03", count: 3 },
			]);
			const listed = await listPhotos(db, { capturedDate: "2024-10-03" });
			expect(listed.total).toBe(3);
			expect(listed.photos.map((photo) => photo.path).sort()).toEqual([
				"e/IMG_1.JPG",
				"e/IMG_2.ARW",
				"e/IMG_3.ARW",
			]);
			// The hidden RAW's rating does not reach the cover; the latest capture does.
			expect(result.years[0].cover.photoId).not.toBe(jpg);
			expect(result.years[0].cover.photoId).not.toBe(soloRaw);
			expect(
				listed.photos.find(
					(photo) => photo.id === result.years[0].cover.photoId,
				)?.path,
			).toBe("e/IMG_3.ARW");
			// The 2023 grid shows only the rejected JPEG; the card omits it.
			expect(
				(await listPhotos(db, { capturedDate: "2023-10-03" })).photos.map(
					(photo) => photo.path,
				),
			).toEqual(["e/IMG_4.JPG"]);
		});

		test("cover: highest rating, then latest capture time, then highest id", async () => {
			const updatedAt = new Date("2026-01-02T03:04:05.000Z");
			addPhoto("f/low.jpg", { dateTaken: "2024:10:03 23:00:00", rating: 3 });
			addPhoto("f/early.jpg", { dateTaken: "2024:10:03 07:00:00", rating: 5 });
			addPhoto("f/late-low-id.jpg", {
				dateTaken: "2024:10:03 09:00:00",
				rating: 5,
			});
			const winner = addPhoto("f/late-high-id.jpg", {
				dateTaken: "2024:10:03 09:00:00",
				rating: 5,
				thumbnailUpdatedAt: updatedAt,
			});
			const result = onThisDay(db, "2026-10-03");
			expect(result.years[0]).toEqual({
				year: 2024,
				yearsAgo: 2,
				capturedDate: "2024-10-03",
				count: 4,
				cover: { photoId: winner, thumbnailUpdatedAt: updatedAt },
			});
			const viaTrpc = await caller.onThisDay({ date: "2026-10-03" });
			expect(viaTrpc.years[0].cover).toEqual({
				photoId: winner,
				thumbnailUpdatedAt: updatedAt,
			});
			// v1 serializes the cache token like collection covers.
			const response = await app.request("/api/v1/on-this-day?date=2026-10-03");
			expect(
				onThisDayResponseSchema.parse(await response.json()).years[0].cover,
			).toEqual({
				photoId: winner,
				thumbnailUpdatedAt: updatedAt.toISOString(),
			});
			// A cover without a committed thumbnail has a null token.
			const late = addPhoto("f/later.jpg", {
				dateTaken: "2024:10:03 09:30:00",
				rating: 5,
			});
			expect(onThisDay(db, "2026-10-03").years[0].cover).toEqual({
				photoId: late,
				thumbnailUpdatedAt: null,
			});
			const nullToken = await app.request(
				"/api/v1/on-this-day?date=2026-10-03",
			);
			expect(
				onThisDayResponseSchema.parse(await nullToken.json()).years[0].cover,
			).toEqual({ photoId: late, thumbnailUpdatedAt: null });
		});

		test("caps at 20 year groups, most recent first", () => {
			expect(ON_THIS_DAY_MAX_YEARS).toBe(20);
			for (let year = 1990; year <= 2025; year++) {
				addPhoto(`g/${year}.jpg`, { dateTaken: `${year}:10:03 10:00:00` });
			}
			const years = groups("2026-10-03");
			expect(years).toHaveLength(20);
			expect(years.map((group) => group.year)).toEqual(
				Array.from({ length: 20 }, (_, index) => 2025 - index),
			);
			expect(years.at(-1)?.yearsAgo).toBe(20);
		});
	});

	describe("capturedDate filter", () => {
		let ids: Record<string, number>;
		const PARIS = ["48.8530", "2.3499"] as const;
		beforeEach(() => {
			ids = {
				colon: addPhoto("h/colon.jpg", {
					dateTaken: "2024:05:01 10:00:00",
					gps: PARIS,
					vector: [1, 0, 0, 0],
				}),
				dash: addPhoto("h/dash.jpg", {
					dateTaken: "2024-05-01T08:00:00",
					gps: PARIS,
					vector: [0.9, 0.1, 0, 0],
				}),
				nextDay: addPhoto("h/next-day.jpg", {
					dateTaken: "2024:05:02 00:00:00",
					gps: PARIS,
					vector: [0.95, 0.05, 0, 0],
				}),
				otherYear: addPhoto("h/other-year.jpg", {
					dateTaken: "2023:05:01 10:00:00",
					vector: [0.8, 0.2, 0, 0],
				}),
				undated: addPhoto("h/undated.jpg", {
					dateTaken: null,
					vector: [0.7, 0.3, 0, 0],
				}),
				// A pair on the day: only the JPEG lists.
				pairJpg: addPhoto("h/IMG_9.JPG", {
					dateTaken: "2024:05:01 12:00:00",
					vector: [0.6, 0.4, 0, 0],
				}),
				pairRaw: addPhoto("h/IMG_9.ARW", {
					dateTaken: "2024:05:01 12:00:00",
					vector: [0.6, 0.4, 0, 0],
				}),
			};
		});
		const onDay = () => sorted([ids.colon, ids.dash, ids.pairJpg]);

		test("photos and locations (tRPC and v1) match both stored formats", async () => {
			expect(
				sorted(
					(await caller.photos({ capturedDate: "2024-05-01" })).photos.map(
						(photo) => photo.id,
					),
				),
			).toEqual(onDay());
			expect(
				(
					await caller.photoLocations({ capturedDate: "2024-05-01" })
				).points.map((point) => point.id),
			).toEqual([ids.colon, ids.dash]);
			const v1 = await app.request("/api/v1/photos?capturedDate=2024-05-01");
			expect(v1.status).toBe(200);
			expect(await responseIds(v1)).toEqual(onDay());
			const locations = await app.request(
				"/api/v1/locations?capturedDate=2024-05-01",
			);
			expect(locations.status).toBe(200);
			expect(
				pointIdsBody
					.parse(await locations.json())
					.points.map((point) => point.id),
			).toEqual([ids.colon, ids.dash]);
			// Combines with other filters.
			expect(
				(
					await caller.photos({ capturedDate: "2024-05-01", filterRaw: "raw" })
				).photos.map((photo) => photo.id),
			).toEqual([ids.pairRaw]);
			expect(
				(await caller.photos({ capturedDate: "2024-05-03" })).photos,
			).toEqual([]);
		});

		test("search and similar (tRPC and v1) filter candidates by capture date", async () => {
			const search = await caller.searchPhotos({
				query: "x",
				limit: 10,
				capturedDate: "2024-05-01",
			});
			// Ranked by distance to [1, 0, 0, 0]; next-day is closer but excluded.
			expect(search.photos.map((photo) => photo.id)).toEqual([
				ids.colon,
				ids.dash,
				ids.pairJpg,
			]);
			const v1Search = await post("/search", {
				query: "x",
				limit: 10,
				capturedDate: "2024-05-01",
			});
			expect(v1Search.status).toBe(200);
			expect(await responseIds(v1Search)).toEqual(onDay());

			const similar = await caller.similarPhotos({
				photoId: ids.nextDay,
				capturedDate: "2024-05-01",
			});
			expect(similar.photos.map((photo) => photo.id)).toEqual([
				ids.colon,
				ids.dash,
				ids.pairJpg,
			]);
			const v1Similar = await app.request(
				`/api/v1/photos/${ids.otherYear}/similar?capturedDate=2024-05-01`,
			);
			expect(v1Similar.status).toBe(200);
			expect(await responseIds(v1Similar)).toEqual(onDay());
		});

		test("invalid values are rejected by every transport", async () => {
			for (const capturedDate of INVALID_DATES) {
				const query = `capturedDate=${encodeURIComponent(capturedDate)}`;
				for (const path of [
					`/api/v1/photos?${query}`,
					`/api/v1/locations?${query}`,
					`/api/v1/photos/${ids.colon}/similar?${query}`,
				]) {
					const response = await app.request(path);
					expect(response.status).toBe(400);
					expect(await response.json()).toEqual(INVALID_REQUEST);
				}
				const search = await post("/search", { query: "x", capturedDate });
				expect(search.status).toBe(400);
				expect(await search.json()).toEqual(INVALID_REQUEST);
				expect(await trpcErrorCode(caller.photos({ capturedDate }))).toBe(
					"BAD_REQUEST",
				);
				expect(
					await trpcErrorCode(caller.photoLocations({ capturedDate })),
				).toBe("BAD_REQUEST");
				expect(
					await trpcErrorCode(
						caller.searchPhotos({ query: "x", limit: 5, capturedDate }),
					),
				).toBe("BAD_REQUEST");
				expect(
					await trpcErrorCode(
						caller.similarPhotos({ photoId: ids.colon, capturedDate }),
					),
				).toBe("BAD_REQUEST");
			}
			expect(
				(await post("/search", { query: "x", capturedDate: 20240501 })).status,
			).toBe(400);
			// A real leap day is a valid filter.
			expect(
				(await app.request("/api/v1/photos?capturedDate=2024-02-29")).status,
			).toBe(200);
		});

		test("smart album criteria reject it (transports) and the service ignores it", async () => {
			const filters = { capturedDate: "2024-05-01" };
			expect(
				await trpcErrorCode(
					caller.createSmartAlbum({
						name: "Day",
						filters: filters as Parameters<
							typeof caller.createSmartAlbum
						>[0]["filters"],
					}),
				),
			).toBe("BAD_REQUEST");
			const created = await post("/smart-albums", { name: "Day", filters });
			expect(created.status).toBe(400);
			expect(await created.json()).toEqual(INVALID_REQUEST);
			expect(smartAlbumFiltersRequestSchema.safeParse(filters).success).toBe(
				false,
			);
			// Like `bounds`, the service canonicalizer drops the view scope.
			expect(
				canonicalizeSmartAlbumFilters({
					tag: "beach",
					...filters,
				} as Parameters<typeof canonicalizeSmartAlbumFilters>[0]),
			).toEqual({ tag: "beach" });
			const album = await caller.createSmartAlbum({
				name: "Valid",
				filters: { minRating: 1 },
			});
			expect(
				await trpcErrorCode(
					caller.updateSmartAlbum({
						id: album.id,
						filters: filters as Parameters<
							typeof caller.updateSmartAlbum
						>[0]["filters"],
					}),
				),
			).toBe("BAD_REQUEST");
			const patched = await app.request(`/api/v1/smart-albums/${album.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filters }),
			});
			expect(patched.status).toBe(400);
			expect((await caller.smartAlbums()).albums.map((a) => a.filters)).toEqual(
				[{ minRating: 1 }],
			);
		});
	});

	test("checked-in OpenAPI document describes on-this-day and capturedDate", async () => {
		const parameterSchema = z.object({
			name: z.string(),
			in: z.string(),
			required: z.boolean().optional(),
			schema: z.record(z.unknown()),
		});
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
				components: z.object({
					schemas: z.record(
						z
							.object({
								required: z.array(z.string()).optional(),
								properties: z.record(z.record(z.unknown())).optional(),
							})
							.passthrough(),
					),
				}),
			})
			.parse(
				await Bun.file(
					new URL("../routes/openapi-v1.json", import.meta.url),
				).json(),
			);
		const operation = document.paths["/api/v1/on-this-day"]?.get;
		expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
			"200",
			"400",
			"500",
		]);
		expect(operation?.parameters).toEqual([
			expect.objectContaining({
				name: "date",
				in: "query",
				required: true,
				schema: expect.objectContaining({ type: "string", format: "date" }),
			}),
		]);
		const { schemas } = document.components;
		expect(schemas.OnThisDayResponse.required?.sort()).toEqual(
			Object.keys(onThisDayResponseSchema.shape).sort(),
		);
		expect(schemas.OnThisDayYear.required?.sort()).toEqual(
			Object.keys(onThisDayResponseSchema.shape.years.element.shape).sort(),
		);
		expect(schemas.OnThisDayYear.properties?.cover).toEqual({
			$ref: "#/components/schemas/CollectionCover",
		});
		for (const path of [
			"/api/v1/photos",
			"/api/v1/locations",
			"/api/v1/photos/{id}/similar",
		]) {
			expect(
				document.paths[path].get?.parameters?.find(
					(parameter) => parameter.name === "capturedDate",
				),
			).toMatchObject({
				in: "query",
				required: false,
				schema: { type: "string", format: "date" },
			});
		}
		expect(schemas.SearchRequest.properties?.capturedDate).toMatchObject({
			type: "string",
			format: "date",
		});
		// A view scope, never smart-album criteria.
		for (const name of ["SmartAlbumFilters", "SmartAlbumFiltersInput"]) {
			expect(schemas[name].properties).not.toHaveProperty("capturedDate");
		}
	});

	describe("migration 0015", () => {
		test("applies on a database migrated to 0014 with rows and keeps data", async () => {
			const migrationSql = readFileSync(
				join(MIGRATIONS_FOLDER, "0015_on_this_day.sql"),
				"utf8",
			);
			expect(migrationSql).not.toMatch(
				/DROP TABLE|ALTER TABLE|__new_|INSERT INTO/i,
			);
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
				const migrationIndex = journal.entries.findIndex((entry) =>
					entry.tag.startsWith("0015_"),
				);
				expect(migrationIndex).toBeGreaterThan(0);
				expect(journal.entries[migrationIndex - 1].tag).toStartWith("0014_");
				writeFileSync(
					journalPath,
					JSON.stringify({
						...journal,
						entries: journal.entries.slice(0, migrationIndex),
					}),
				);

				const legacy = new Database(":memory:");
				const legacyDb = drizzle(legacy, { schema });
				migrate(legacyDb, { migrationsFolder: partial });
				const indexes = () =>
					legacy
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'photo_exif' ORDER BY name",
						)
						.all()
						.map((row) => row.name);
				expect(indexes()).not.toContain("idx_exif_month_day");
				legacy.run(
					`INSERT INTO photos (id, path, name, size, created_at, modified_at, rating)
					 VALUES (7, 'a/one.jpg', 'one.jpg', 1, 0, 0, 4), (9, 'a/two.jpg', 'two.jpg', 2, 0, 0, 0)`,
				);
				legacy.run(
					`INSERT INTO photo_exif (photo_id, date_taken, camera_make)
					 VALUES (7, '2024:10:03 10:00:00', 'Sony'), (9, NULL, 'Canon')`,
				);
				const snapshot = () => ({
					photos: legacy.query("SELECT * FROM photos ORDER BY id").all(),
					exif: legacy.query("SELECT * FROM photo_exif ORDER BY id").all(),
				});
				const before = snapshot();

				writeFileSync(journalPath, JSON.stringify(journal));
				migrate(legacyDb, { migrationsFolder: partial });

				expect(snapshot()).toEqual(before);
				expect(indexes()).toEqual(
					expect.arrayContaining([
						"idx_exif_captured_date",
						"idx_exif_month_day",
					]),
				);
				// Existing rows are indexed and served immediately.
				const migratedDb = legacyDb as unknown as typeof db;
				expect(
					onThisDay(migratedDb, "2026-10-03").years.map(
						({ cover: _cover, ...group }) => group,
					),
				).toEqual([
					{ year: 2024, yearsAgo: 2, capturedDate: "2024-10-03", count: 1 },
				]);
				expect(
					(
						await listPhotos(migratedDb, { capturedDate: "2024-10-03" })
					).photos.map((photo) => photo.id),
				).toEqual([7]);
				legacy.close();
			} finally {
				rmSync(partial, { recursive: true, force: true });
			}
		});
	});

	test("performance over 20,000 photos across 15 years in a file database", async () => {
		const COUNT = 20_000;
		const FIRST_YEAR = 2011;
		const YEARS = 15;
		const TODAY = "2026-06-15";
		const directory = mkdtempSync(join(tmpdir(), "photobrain-on-this-day-"));
		const file = new Database(join(directory, "perf.db"));
		try {
			const fileDb = drizzle(file, { schema }) as unknown as typeof db;
			migrate(fileDb, { migrationsFolder: MIGRATIONS_FOLDER });
			let seed = 7;
			const random = () => {
				seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
				return seed / 2_147_483_648;
			};
			const pad = (value: number) => String(value).padStart(2, "0");
			const insertPhoto = file.query<
				{ id: number },
				[string, string, number, number, string | null]
			>(
				`INSERT INTO photos (path, name, size, created_at, modified_at, is_raw, rating, flag)
				 VALUES (?, ?, 1, 0, 0, ?, ?, ?) RETURNING id`,
			);
			const insertedId = (row: { id: number } | null) => {
				if (!row) throw new Error("INSERT ... RETURNING produced no row");
				return row.id;
			};
			const insertExif = file.prepare(
				"INSERT INTO photo_exif (photo_id, date_taken, camera_make) VALUES (?, ?, 'Sony')",
			);
			// Expected per-year counts for TODAY's month-day, computed independently.
			const expected = new Map<number, number>();
			let inserted = 0;
			file.transaction(() => {
				for (let index = 0; inserted < COUNT; index++) {
					const year = FIRST_YEAR + (index % YEARS);
					// Every 7th photo is on June 15, so each year has a group.
					const day = new Date(
						Date.UTC(
							year,
							index % 7 === 0 ? 5 : 0,
							index % 7 === 0 ? 15 : 1 + Math.floor(random() * 365),
						),
					);
					const time = `${pad(Math.floor(random() * 24))}:${pad(Math.floor(random() * 60))}:00`;
					// Mixed stored formats.
					const separator = index % 5 === 0 ? "-" : ":";
					const dateTaken = `${day.getUTCFullYear()}${separator}${pad(day.getUTCMonth() + 1)}${separator}${pad(day.getUTCDate())} ${time}`;
					const rejected = random() < 0.03;
					const folder = `y${year}/m${pad(day.getUTCMonth() + 1)}`;
					const id = insertedId(
						insertPhoto.get(
							`${folder}/IMG_${index}.JPG`,
							`IMG_${index}.JPG`,
							0,
							Math.floor(random() * 6),
							rejected ? "reject" : null,
						),
					);
					insertExif.run(id, dateTaken);
					inserted++;
					// Every 10th photo has a RAW sibling with the same date.
					if (index % 10 === 0 && inserted < COUNT) {
						const rawId = insertedId(
							insertPhoto.get(
								`${folder}/IMG_${index}.ARW`,
								`IMG_${index}.ARW`,
								1,
								0,
								null,
							),
						);
						insertExif.run(rawId, dateTaken);
						inserted++;
					}
					if (
						!rejected &&
						day.getUTCMonth() === 5 &&
						day.getUTCDate() === 15 &&
						day.getUTCFullYear() < 2026
					) {
						expected.set(year, (expected.get(year) ?? 0) + 1);
					}
				}
			})();
			file.run("ANALYZE");

			const result = onThisDay(fileDb, TODAY);
			expect(result.years).toHaveLength(YEARS);
			expect(result.years.map((group) => [group.year, group.count])).toEqual(
				[...expected.entries()].sort((left, right) => right[0] - left[0]),
			);
			const sample = result.years[0];
			const sampleListing = await listPhotos(fileDb, {
				capturedDate: sample.capturedDate,
			});
			expect(
				sampleListing.photos.filter((photo) => photo.flag !== "reject").length,
			).toBe(sample.count);

			const median = (run: () => unknown) => {
				const samples: number[] = [];
				for (let index = 0; index < 5; index++) {
					const started = performance.now();
					run();
					samples.push(performance.now() - started);
				}
				return samples.sort((left, right) => left - right)[2];
			};
			const medianAsync = async (run: () => Promise<unknown>) => {
				const samples: number[] = [];
				for (let index = 0; index < 5; index++) {
					const started = performance.now();
					await run();
					samples.push(performance.now() - started);
				}
				return samples.sort((left, right) => left - right)[2];
			};
			const onThisDayMs = median(() => onThisDay(fileDb, TODAY));
			const feb28Ms = median(() => onThisDay(fileDb, "2026-02-28"));
			const listingMs = await medianAsync(() =>
				listPhotos(fileDb, { capturedDate: sample.capturedDate }),
			);
			expect(onThisDayMs).toBeLessThan(20);
			expect(feb28Ms).toBeLessThan(20);
			expect(listingMs).toBeLessThan(20);

			const statements: string[] = [];
			const original = file.prepare;
			file.prepare = ((...args: Parameters<typeof original>) => {
				statements.push(args[0]);
				return original.apply(file, args);
			}) as typeof original;
			try {
				onThisDay(fileDb, TODAY);
				onThisDay(fileDb, "2026-02-28");
				await listPhotos(fileDb, { capturedDate: sample.capturedDate });
			} finally {
				file.prepare = original;
			}
			const plan = (statement: string | undefined) => {
				if (!statement) throw new Error("statement not captured");
				const parameters = (statement.match(/\?/g) ?? []).map(() => null);
				return file
					.query<{ detail: string }, (null | string)[]>(
						`EXPLAIN QUERY PLAN ${statement}`,
					)
					.all(...parameters)
					.map((row) => row.detail)
					.join("\n");
			};
			const [onThisDayPlan, feb28Plan] = statements
				.filter((statement) => /FROM photo_exif candidate/.test(statement))
				.map(plan);
			const listingPlan = plan(
				statements.find(
					(statement) =>
						/from "photos"/i.test(statement) &&
						/substr\(photo_exif\.date_taken, 1, 10\)/.test(statement),
				),
			);
			for (const dayPlan of [onThisDayPlan, feb28Plan]) {
				expect(dayPlan).toMatch(
					/SEARCH candidate USING INDEX idx_exif_month_day \(<expr>=\?\)/,
				);
				expect(dayPlan).toMatch(/SEARCH photos USING INTEGER PRIMARY KEY/);
			}
			expect(listingPlan).toMatch(
				/SEARCH photo_exif USING INDEX idx_exif_captured_date \(<expr>=\?\)/,
			);
			expect(listingPlan).toMatch(/SEARCH photos USING INTEGER PRIMARY KEY/);
			for (const queryPlan of [onThisDayPlan, feb28Plan, listingPlan]) {
				expect(queryPlan).not.toMatch(/SCAN (photo_exif|candidate)\b/);
				expect(queryPlan).not.toMatch(/SCAN photos\b/);
			}

			const log = (line: string) => console.log(`${PERF_LOG_PREFIX} ${line}`);
			log(
				`onThisDay ${TODAY} over ${COUNT} photos / ${YEARS} years (${result.years.length} groups, ${result.years.reduce((total, group) => total + group.count, 0)} photos): ${onThisDayMs.toFixed(2)} ms median; non-leap Feb 28 (+Feb 29): ${feb28Ms.toFixed(2)} ms`,
			);
			log(
				`listPhotos capturedDate=${sample.capturedDate} (${sampleListing.total} rows, incl. EXIF hydration): ${listingMs.toFixed(2)} ms median`,
			);
			for (const [name, detail] of [
				["onThisDay", onThisDayPlan],
				["onThisDay Feb 28", feb28Plan],
				["listPhotos capturedDate", listingPlan],
			]) {
				log(`EXPLAIN ${name}: ${detail.replaceAll("\n", " | ")}`);
			}
		} finally {
			file.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
}
