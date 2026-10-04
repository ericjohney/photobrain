import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";
import * as schema from "../db/schema";
import { photoEmbedding, photoExif, photos } from "../db/schema";
import {
	eventsResponseSchema,
	smartAlbumFiltersRequestSchema,
} from "../routes/v1-schemas";
import { PLACE_DATASET_VERSION } from "../services/place-lookup";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[events-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";

type EventStep = {
	run<T>(id: string, work: () => T | Promise<T>): Promise<T>;
};
type EventFunction = {
	options: { id: string; concurrency: { limit: number } };
	trigger: { event: string };
	handler(context: {
		event: { data: Record<string, never> };
		step: EventStep;
	}): Promise<{ candidates: number; events: number; photos: number }>;
};

// Mocks of the native addon, ../db and the Inngest client are process-wide;
// run the suite in an isolated child like the places and on-this-day suites.
if (process.env.PHOTOBRAIN_EVENTS_TEST_CHILD !== "1") {
	test("auto events: detection, listing, event filter, contract and performance", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_EVENTS_TEST_CHILD: "1" },
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
		inngest: {
			send: async () => undefined,
			createFunction: (
				options: unknown,
				trigger: unknown,
				handler: EventFunction["handler"],
			) => ({ options, trigger, handler }),
		},
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
	const { detectEventsFunction } = await import("../inngest/functions/events");
	const { detectEvents, listEvents, EVENTS_VERSION } = await import(
		"../services/events"
	);
	const { listPhotos, listPhotoLocations } = await import(
		"../services/photo-catalog"
	);
	const { searchPhotosByText, findSimilarToPhoto } = await import(
		"../services/vector-search"
	);
	const { canonicalizeSmartAlbumFilters } = await import(
		"../services/smart-albums"
	);
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");

	const detectFunction = detectEventsFunction as unknown as EventFunction;
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

	type Place = {
		geonameId: number;
		city: string;
		region: string | null;
		country: string;
		countryCode: string;
		gps: readonly [string, string];
	};
	const KYOTO: Place = {
		geonameId: 1857910,
		city: "Kyoto",
		region: "Kyoto",
		country: "Japan",
		countryCode: "JP",
		gps: ["35.0116", "135.7681"],
	};
	const OSAKA: Place = {
		geonameId: 1853909,
		city: "Osaka",
		region: "Osaka",
		country: "Japan",
		countryCode: "JP",
		gps: ["34.6937", "135.5023"],
	};
	const TOKYO: Place = {
		geonameId: 1850147,
		city: "Tokyo",
		region: "Tokyo",
		country: "Japan",
		countryCode: "JP",
		gps: ["35.6895", "139.6917"],
	};
	const PARIS: Place = {
		geonameId: 2988507,
		city: "Paris",
		region: "Île-de-France",
		country: "France",
		countryCode: "FR",
		gps: ["48.8530", "2.3499"],
	};
	const LYON: Place = {
		geonameId: 2996944,
		city: "Lyon",
		region: "Auvergne-Rhône-Alpes",
		country: "France",
		countryCode: "FR",
		gps: ["45.7640", "4.8357"],
	};
	const placeOf = ({ geonameId: _id, gps: _gps, ...place }: Place) => place;

	/** 2024-05-01 08:00:00 wall clock plus `minutes`. */
	const BASE_MS = Date.UTC(2024, 4, 1, 8, 0, 0);
	const wallClock = (minutes: number) =>
		new Date(BASE_MS + minutes * 60_000).toISOString().slice(0, 19);
	const exifAt = (minutes: number) => {
		const iso = wallClock(minutes);
		return `${iso.slice(0, 10).replaceAll("-", ":")} ${iso.slice(11)}`;
	};

	type PhotoOptions = {
		/** EXIF `date_taken` text; `null` writes a NULL date, omitted no EXIF. */
		dateTaken?: string | null;
		rating?: number;
		flag?: "pick" | "reject";
		place?: Place;
		/** Location without a place row. */
		gps?: readonly [string, string];
		/** `null` stores no vector. */
		vector?: readonly number[] | null;
		thumbnailUpdatedAt?: Date;
	};

	afterAll(() => sqlite.close());
	beforeEach(() => {
		sqlite.run("DELETE FROM event_photos");
		sqlite.run("DELETE FROM events");
		sqlite.run("DELETE FROM photo_places");
		sqlite.run("DELETE FROM smart_albums");
		db.delete(photoEmbedding).run();
		db.delete(photoExif).run();
		db.delete(photos).run();
	});

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
		const gps = options.place?.gps ?? options.gps;
		if (options.dateTaken !== undefined || gps) {
			db.insert(photoExif)
				.values({
					photoId: photo.id,
					dateTaken: options.dateTaken ?? null,
					gpsLatitude: gps?.[0],
					gpsLongitude: gps?.[1],
				})
				.run();
		}
		if (options.place) {
			const place = options.place;
			sqlite
				.query(
					`INSERT INTO photo_places (photo_id, geoname_id, city, region, country_code, country,
						latitude_text, longitude_text, places_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					photo.id,
					place.geonameId,
					place.city,
					place.region,
					place.countryCode,
					place.country,
					place.gps[0],
					place.gps[1],
					PLACE_DATASET_VERSION,
				);
		}
		if (options.vector !== null) {
			db.insert(photoEmbedding)
				.values({
					photoId: photo.id,
					embedding: Buffer.from(
						new Float32Array(options.vector ?? [1, 0, 0, 0]).buffer,
					),
					modelVersion: EMBEDDING_MODEL_VERSION,
					thumbnailKey,
					createdAt: new Date(0),
				})
				.run();
		}
		return photo.id;
	}

	/** `count` photos `step` minutes apart from `startMinute`, oldest first. */
	function series(
		prefix: string,
		startMinute: number,
		count: number,
		options: Omit<PhotoOptions, "dateTaken"> & { step?: number } = {},
	): number[] {
		const { step = 10, ...photoOptions } = options;
		return Array.from({ length: count }, (_, index) =>
			addPhoto(`${prefix}/IMG_${startMinute + index * step}.JPG`, {
				...photoOptions,
				dateTaken: exifAt(startMinute + index * step),
			}),
		);
	}

	const sorted = (values: number[]) =>
		[...values].sort((left, right) => left - right);
	/** Detected events as sorted member ID lists, oldest event first. */
	const memberships = () => {
		const rows = sqlite
			.query<{ event_id: number; photo_id: number }, []>(
				"SELECT event_id, photo_id FROM event_photos ORDER BY event_id, photo_id",
			)
			.all();
		const groups = new Map<number, number[]>();
		for (const row of rows) {
			groups.set(row.event_id, [
				...(groups.get(row.event_id) ?? []),
				row.photo_id,
			]);
		}
		return [...groups.values()];
	};
	const photoIdsBody = z.object({
		photos: z.array(z.object({ id: z.number() }).passthrough()),
	});
	const pointIdsBody = z.object({
		points: z.array(z.object({ id: z.number() }).passthrough()),
	});
	const responseIds = async (response: Response) => {
		expect(response.status).toBe(200);
		return sorted(
			photoIdsBody.parse(await response.json()).photos.map((photo) => photo.id),
		);
	};
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
	/** A unit 4-vector at cosine `similarity` to `[1, 0, 0, 0]`. */
	const vectorAt = (similarity: number) => [
		similarity,
		Math.sqrt(1 - similarity * similarity),
		0,
		0,
	];

	describe("boundaries", () => {
		test("a gap of exactly 6 h splits; 5 h 59 min without a scene change does not", () => {
			const first = series("a", 0, 6);
			const second = series("a", 50 + 360, 6);
			const joined = series("a", 410 + 50 + 359, 6);
			expect(detectEvents(db)).toEqual({
				candidates: 18,
				events: 2,
				photos: 18,
			});
			expect(memberships()).toEqual([first, [...second, ...joined]]);
		});

		test("with different places, a 59-minute gap joins and a 60-minute gap splits", () => {
			const kyoto = series("a", 0, 6, { place: KYOTO });
			const osaka = series("a", 50 + 59, 6, { place: OSAKA });
			const paris = series("a", 109 + 50 + 60, 6, { place: PARIS });
			detectEvents(db);
			expect(memberships()).toEqual([[...kyoto, ...osaka], paris]);
		});

		test("after a gap of at least 1 h, similarity just below 0.6 splits and just above joins", () => {
			const first = series("a", 0, 6);
			const below = series("a", 50 + 60, 6, { vector: vectorAt(0.59) });
			// Relative to `below`'s last vector, the next scene is at 0.61.
			const angle = Math.acos(0.59) + Math.acos(0.61);
			const above = series("a", 160 + 120, 6, {
				vector: [Math.cos(angle), Math.sin(angle), 0, 0],
			});
			detectEvents(db);
			expect(memberships()).toEqual([first, [...below, ...above]]);
		});

		test("under 1 h, neither different places nor dissimilar vectors split", () => {
			const ids = [
				...series("a", 0, 3, { place: KYOTO, vector: [1, 0, 0, 0] }),
				// 59 minutes after the previous photo (minute 20).
				...series("a", 79, 3, { place: PARIS, vector: [0, 1, 0, 0] }),
			];
			detectEvents(db);
			expect(memberships()).toEqual([ids]);
		});

		test("a place change needs both photos placed and a vector change needs both vectors", () => {
			const ids = [
				...series("a", 0, 3, { place: KYOTO, vector: null }),
				// Unplaced, no vector: nothing to compare after a 2 h gap.
				...series("a", 140, 3, { vector: null }),
				...series("a", 280, 3, { place: PARIS, vector: [0, 1, 0, 0] }),
			];
			detectEvents(db);
			expect(memberships()).toEqual([ids]);
		});

		test("runs of 5 are dropped and runs of 6 kept", () => {
			series("a", 0, 5);
			const six = series("a", 7 * 60, 6);
			series("a", 14 * 60, 5);
			expect(detectEvents(db)).toEqual({
				candidates: 16,
				events: 1,
				photos: 6,
			});
			expect(memberships()).toEqual([six]);
		});

		test("rejects are not members and do not count toward the minimum", () => {
			const kept = series("a", 0, 5);
			const rejected = addPhoto("a/rejected.JPG", {
				dateTaken: exifAt(55),
				flag: "reject",
			});
			expect(detectEvents(db).events).toBe(0);
			const picked = addPhoto("a/picked.JPG", {
				dateTaken: exifAt(56),
				flag: "pick",
			});
			detectEvents(db);
			expect(memberships()).toEqual([[...kept, picked]]);
			expect(memberships().flat()).not.toContain(rejected);
		});

		test("a RAW+JPEG pair is one member; the RAW stands in for a rejected JPEG", async () => {
			const singles = series("a", 0, 5);
			const jpeg = addPhoto("a/DSC_1.JPG", { dateTaken: exifAt(60) });
			const raw = addPhoto("a/DSC_1.ARW", { dateTaken: exifAt(60) });
			// Five singles plus one pair: six members, the JPEG representing it.
			expect(detectEvents(db)).toMatchObject({ events: 1, photos: 6 });
			expect(memberships()).toEqual([[...singles, jpeg]]);
			const [event] = listEvents(db).events;
			expect(event.photoCount).toBe(6);
			const listed = await listPhotos(db, { event: event.id });
			expect(sorted(listed.photos.map((photo) => photo.id))).toEqual([
				...singles,
				jpeg,
			]);
			expect(listed.photos.find((photo) => photo.id === jpeg)).toMatchObject({
				pairedPhotoId: raw,
			});

			db.update(photos)
				.set({ flag: "reject" })
				.where(eq(photos.id, jpeg))
				.run();
			detectEvents(db);
			expect(memberships()).toEqual([[...singles, raw]]);
			expect(
				sorted(
					(await listPhotos(db, { event: singles[0] })).photos.map(
						(photo) => photo.id,
					),
				),
			).toEqual([...singles, raw]);
		});

		test("photos without a valid EXIF capture datetime are excluded", () => {
			const dated = series("a", 0, 5);
			addPhoto("a/no-exif.JPG");
			addPhoto("a/null.JPG", { dateTaken: null });
			addPhoto("a/date-only.JPG", { dateTaken: "2024:05:01" });
			addPhoto("a/zero.JPG", { dateTaken: "0000:00:00 00:00:00" });
			addPhoto("a/old.JPG", { dateTaken: "1899:12:31 23:59:59" });
			addPhoto("a/impossible.JPG", { dateTaken: "2024:02:30 10:00:00" });
			addPhoto("a/bad-time.JPG", { dateTaken: "2024:05:01 25:00:00" });
			addPhoto("a/text.JPG", { dateTaken: "yesterday" });
			expect(detectEvents(db)).toEqual({ candidates: 5, events: 0, photos: 0 });
			// An ISO-like text with a zone suffix is read as wall clock.
			const iso = addPhoto("a/iso.JPG", {
				dateTaken: `${wallClock(55)}+09:00`,
			});
			expect(detectEvents(db)).toEqual({ candidates: 6, events: 1, photos: 6 });
			expect(memberships()).toEqual([[...dated, iso]]);
			expect(listEvents(db).events[0]).toMatchObject({
				startAt: wallClock(0),
				endAt: wallClock(55),
			});
		});
	});

	describe("identity and replacement", () => {
		test("the ID is the smallest member, stable on recompute, and old events are replaced", () => {
			// Insert out of capture order so the smallest ID is not the first photo.
			const late = series("a", 30, 3);
			const early = series("a", 0, 3);
			const other = series("b", 10 * 60, 6);
			detectEvents(db);
			const first = listEvents(db).events.map((event) => event.id);
			expect(first).toEqual([other[0], late[0]]);
			expect(Math.min(...late, ...early)).toBe(late[0]);

			detectEvents(db);
			expect(listEvents(db).events.map((event) => event.id)).toEqual(first);
			expect(memberships()).toEqual([sorted([...late, ...early]), other]);

			// Moving `other` into the first event's day leaves one event.
			for (const [index, id] of other.entries()) {
				db.update(photoExif)
					.set({ dateTaken: exifAt(60 + index) })
					.where(eq(photoExif.photoId, id))
					.run();
			}
			detectEvents(db);
			const after = sqlite
				.query<{ id: number; events_version: number }, []>(
					"SELECT id, events_version FROM events",
				)
				.all();
			expect(after).toEqual([{ id: late[0], events_version: EVENTS_VERSION }]);
			expect(memberships()).toEqual([sorted([...late, ...early, ...other])]);
			expect(
				sqlite
					.query<{ count: number }, [number]>(
						"SELECT count(*) AS count FROM event_photos WHERE event_id = ?",
					)
					.get(other[0])?.count,
			).toBe(0);
		});

		test("recomputing with no candidates clears every event", () => {
			series("a", 0, 6);
			expect(detectEvents(db).events).toBe(1);
			db.update(photos).set({ flag: "reject" }).run();
			expect(detectEvents(db)).toEqual({ candidates: 0, events: 0, photos: 0 });
			expect(listEvents(db).events).toEqual([]);
			expect(memberships()).toEqual([]);
		});

		test("the Inngest function recomputes in one step on photos/events.requested", async () => {
			expect(detectFunction.options).toEqual({
				id: "detect-events-v1",
				concurrency: { limit: 1 },
			});
			expect(detectFunction.trigger).toEqual({
				event: "photos/events.requested",
			});
			series("a", 0, 6);
			const steps: string[] = [];
			const result = await detectFunction.handler({
				event: { data: {} },
				step: {
					run: async (id, work) => {
						steps.push(id);
						return work();
					},
				},
			});
			expect(steps).toEqual(["detect-events-v1"]);
			expect(result).toEqual({ candidates: 6, events: 1, photos: 6 });
		});
	});

	describe("place and cover", () => {
		const placeFor = (places: (Place | undefined)[]) => {
			for (const [index, place] of places.entries()) {
				addPhoto(`p/IMG_${index}.JPG`, { dateTaken: exifAt(index), place });
			}
			detectEvents(db);
			return listEvents(db).events[0]?.place;
		};

		test("the city covering at least half of located members", () => {
			expect(
				placeFor([KYOTO, KYOTO, OSAKA, undefined, KYOTO, PARIS, undefined]),
			).toEqual(placeOf(KYOTO));
		});

		test("exactly half is enough (first seen wins a tie)", () => {
			expect(
				placeFor([OSAKA, KYOTO, KYOTO, OSAKA, undefined, undefined]),
			).toEqual(placeOf(OSAKA));
		});

		test("falls back to the majority country with null city and region", () => {
			expect(
				placeFor([KYOTO, OSAKA, TOKYO, PARIS, undefined, undefined]),
			).toEqual({
				city: null,
				region: null,
				country: "Japan",
				countryCode: "JP",
			});
		});

		test("a country covering half wins when no city does", () => {
			// Cities 2/2/2 of 7; France 4 of 7.
			expect(placeFor([KYOTO, OSAKA, PARIS, LYON, PARIS, KYOTO, LYON])).toEqual(
				{
					city: null,
					region: null,
					country: "France",
					countryCode: "FR",
				},
			);
		});

		test("null without a majority country", () => {
			const milan = {
				...LYON,
				geonameId: 3173435,
				city: "Milan",
				country: "Italy",
				countryCode: "IT",
			};
			// Japan, France, and Italy each cover 2 of 6.
			expect(placeFor([KYOTO, OSAKA, PARIS, LYON, milan, milan])).toBeNull();
		});

		test("null without any located member", () => {
			expect(placeFor(Array.from({ length: 6 }, () => undefined))).toBeNull();
		});

		test("cover: highest rating, then newest capture, then highest ID", () => {
			const thumbnailUpdatedAt = new Date("2024-06-01T10:00:00Z");
			const ids = [
				addPhoto("c/0.JPG", { dateTaken: exifAt(0), rating: 5 }),
				addPhoto("c/1.JPG", { dateTaken: exifAt(10), rating: 3 }),
				addPhoto("c/2.JPG", { dateTaken: exifAt(20), rating: 5 }),
				addPhoto("c/3.JPG", { dateTaken: exifAt(30), rating: 4 }),
				addPhoto("c/4.JPG", { dateTaken: exifAt(40), rating: 1 }),
				addPhoto("c/5.JPG", { dateTaken: exifAt(50), rating: 0 }),
			];
			// A higher-rated reject never becomes the cover.
			addPhoto("c/6.JPG", { dateTaken: exifAt(60), rating: 5, flag: "reject" });
			detectEvents(db);
			expect(listEvents(db).events[0].cover.photoId).toBe(ids[2]);

			// Same rating and capture time: the higher ID wins.
			const tied = addPhoto("c/7.JPG", {
				dateTaken: exifAt(20),
				rating: 5,
				thumbnailUpdatedAt,
			});
			detectEvents(db);
			expect(listEvents(db).events[0].cover).toEqual({
				photoId: tied,
				thumbnailUpdatedAt,
			});
		});
	});

	describe("listing", () => {
		test("newest first with wall-clock times; folder scoping keeps the full count", async () => {
			const older = [
				...series("trip/day1", 0, 4, { place: KYOTO }),
				...series("trip_x", 40, 2, { place: KYOTO }),
			];
			const newer = series("home", 24 * 60, 6);
			detectEvents(db);
			const all = listEvents(db).events;
			expect(all.map((event) => event.id)).toEqual([newer[0], older[0]]);
			expect(all[1]).toEqual({
				id: older[0],
				startAt: wallClock(0),
				endAt: wallClock(50),
				photoCount: 6,
				cover: { photoId: older[5], thumbnailUpdatedAt: null },
				place: placeOf(KYOTO),
			});
			// Any depth below `trip`; `_` is literal (no `trip_x` match from `trip`).
			expect(listEvents(db, { folder: "trip" }).events).toEqual([all[1]]);
			expect(listEvents(db, { folder: "trip/day1" }).events).toEqual([all[1]]);
			expect(listEvents(db, { folder: "trip_x" }).events).toEqual([all[1]]);
			expect(listEvents(db, { folder: "tri" }).events).toEqual([]);
			expect(listEvents(db, { folder: "home" }).events).toEqual([all[0]]);
			expect(listEvents(db, { folder: "elsewhere" }).events).toEqual([]);
			expect(await caller.events()).toEqual({ events: all });
			expect(await caller.events({ folder: "trip" })).toEqual({
				events: [all[1]],
			});
			expect(listEvents(db, { folder: "" }).events).toEqual(all);
		});

		test("equal start times order by ID descending", () => {
			const a = series("a", 0, 6);
			const b = series("b", 7 * 60, 6);
			// Force a start-time tie between two distinct events.
			detectEvents(db);
			sqlite.run(`UPDATE events SET start_at = '${wallClock(0)}'`);
			expect(listEvents(db).events.map((event) => event.id)).toEqual([
				b[0],
				a[0],
			]);
		});
	});

	describe("event filter", () => {
		let trip: number[];
		let home: number[];
		let tripId: number;
		beforeEach(() => {
			trip = series("trip", 0, 6, { place: KYOTO, vector: [1, 0, 0, 0] });
			home = series("home", 24 * 60, 6, {
				place: PARIS,
				vector: [0.9, 0.1, 0, 0],
			});
			detectEvents(db);
			tripId = trip[0];
		});

		test("photos, locations, search, and similar return only members (tRPC)", async () => {
			const ids = (result: { photos: { id: number }[] }) =>
				sorted(result.photos.map((photo) => photo.id));
			expect(ids(await caller.photos({ event: tripId }))).toEqual(trip);
			expect(ids(await caller.photos({ event: home[0] }))).toEqual(home);
			expect(
				sorted(
					(await caller.photoLocations({ event: tripId })).points.map(
						(point) => point.id,
					),
				),
			).toEqual(trip);
			expect(
				ids(
					await caller.searchPhotos({
						query: "temple",
						limit: 100,
						event: tripId,
					}),
				),
			).toEqual(trip);
			const similar = await caller.similarPhotos({
				photoId: home[0],
				limit: 100,
				event: tripId,
			});
			expect(ids(similar)).toEqual(trip);
			// Combines with other filters.
			expect(
				ids(await caller.photos({ event: tripId, folder: "home" })),
			).toEqual([]);
		});

		test("photos, locations, search, and similar return only members (/api/v1)", async () => {
			expect(
				await responseIds(await app.request(`/api/v1/photos?event=${tripId}`)),
			).toEqual(trip);
			const locations = await app.request(`/api/v1/locations?event=${tripId}`);
			expect(locations.status).toBe(200);
			expect(
				sorted(
					pointIdsBody
						.parse(await locations.json())
						.points.map((point) => point.id),
				),
			).toEqual(trip);
			expect(
				await responseIds(
					await post("/search", { query: "temple", limit: 100, event: tripId }),
				),
			).toEqual(trip);
			expect(
				await responseIds(
					await app.request(
						`/api/v1/photos/${home[0]}/similar?limit=100&event=${tripId}`,
					),
				),
			).toEqual(trip);
		});

		test("an unknown event ID is an empty result everywhere", async () => {
			const unknown = 9_999_999;
			expect((await listPhotos(db, { event: unknown })).total).toBe(0);
			expect((await listPhotoLocations(db, { event: unknown })).total).toBe(0);
			expect(
				(await searchPhotosByText(db, "x", 100, { event: unknown })).length,
			).toBe(0);
			expect(
				(await findSimilarToPhoto(db, home[0], 100, { event: unknown }))?.total,
			).toBe(0);
			// A member that is not an event ID matches nothing either.
			expect((await caller.photos({ event: trip[1] })).total).toBe(0);
			expect(
				await responseIds(await app.request(`/api/v1/photos?event=${unknown}`)),
			).toEqual([]);
			expect(
				await responseIds(
					await post("/search", { query: "x", event: unknown }),
				),
			).toEqual([]);
		});

		test("invalid values are rejected by every transport", async () => {
			for (const event of [0, -1, 1.5]) {
				expect(await trpcErrorCode(caller.photos({ event }))).toBe(
					"BAD_REQUEST",
				);
				expect(await trpcErrorCode(caller.photoLocations({ event }))).toBe(
					"BAD_REQUEST",
				);
				expect(
					await trpcErrorCode(caller.searchPhotos({ query: "x", event })),
				).toBe("BAD_REQUEST");
				expect(
					await trpcErrorCode(
						caller.similarPhotos({ photoId: trip[0], event }),
					),
				).toBe("BAD_REQUEST");
			}
			for (const event of ["0", "-1", "1.5", "abc", ""]) {
				for (const path of [
					`/api/v1/photos?event=${event}`,
					`/api/v1/locations?event=${event}`,
					`/api/v1/photos/${trip[0]}/similar?event=${event}`,
				]) {
					const response = await app.request(path);
					expect(response.status).toBe(400);
					expect(await response.json()).toEqual(INVALID_REQUEST);
				}
			}
			for (const event of [0, "1", 1.5]) {
				expect((await post("/search", { query: "x", event })).status).toBe(400);
			}
		});

		test("smart album criteria reject it (transports) and the service ignores it", async () => {
			const filters = { event: tripId };
			expect(
				await trpcErrorCode(
					caller.createSmartAlbum({
						name: "Trip",
						filters: filters as Parameters<
							typeof caller.createSmartAlbum
						>[0]["filters"],
					}),
				),
			).toBe("BAD_REQUEST");
			const created = await post("/smart-albums", { name: "Trip", filters });
			expect(created.status).toBe(400);
			expect(await created.json()).toEqual(INVALID_REQUEST);
			expect(smartAlbumFiltersRequestSchema.safeParse(filters).success).toBe(
				false,
			);
			expect(
				canonicalizeSmartAlbumFilters({
					minRating: 2,
					...filters,
				} as Parameters<typeof canonicalizeSmartAlbumFilters>[0]),
			).toEqual({ minRating: 2 });
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
		});
	});

	describe("/api/v1/events", () => {
		test("serializes the DTO with ISO cover timestamps and folder scoping", async () => {
			const thumbnailUpdatedAt = new Date("2024-06-01T10:00:00Z");
			const trip = [
				...series("trip", 0, 5, { place: KYOTO }),
				addPhoto("trip/best.JPG", {
					dateTaken: exifAt(55),
					rating: 4,
					place: KYOTO,
					thumbnailUpdatedAt,
				}),
			];
			const home = series("home", 24 * 60, 6);
			detectEvents(db);

			const response = await app.request("/api/v1/events");
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain(
				"application/json",
			);
			const body = await response.json();
			expect(body).toEqual({
				events: [
					{
						id: home[0],
						startAt: wallClock(24 * 60),
						endAt: wallClock(24 * 60 + 50),
						photoCount: 6,
						cover: { photoId: home[5], thumbnailUpdatedAt: null },
						place: null,
					},
					{
						id: trip[0],
						startAt: wallClock(0),
						endAt: wallClock(55),
						photoCount: 6,
						cover: {
							photoId: trip[5],
							thumbnailUpdatedAt: "2024-06-01T10:00:00.000Z",
						},
						place: {
							city: "Kyoto",
							region: "Kyoto",
							country: "Japan",
							countryCode: "JP",
						},
					},
				],
			});
			expect(eventsResponseSchema.safeParse(body).success).toBe(true);
			const scoped = await app.request("/api/v1/events?folder=trip");
			expect(
				(await scoped.json()).events.map((e: { id: number }) => e.id),
			).toEqual([trip[0]]);
			const empty = await app.request("/api/v1/events?folder=nowhere");
			expect(await empty.json()).toEqual({ events: [] });
		});
	});

	test("performance: detection over 10,000 vectors, listing 1,000 events over 20,000 photos", async () => {
		const DIMENSION = 512;
		const PER_EVENT = 20;
		const directory = mkdtempSync(join(tmpdir(), "photobrain-events-"));
		const file = new Database(join(directory, "perf.db"));
		try {
			const fileDb = drizzle(file, { schema }) as unknown as typeof db;
			migrate(fileDb, { migrationsFolder: MIGRATIONS_FOLDER });
			let seed = 11;
			const random = () => {
				seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
				return seed / 2_147_483_648;
			};
			const insertPhoto = file.query<{ id: number }, [string, string, number]>(
				`INSERT INTO photos (path, name, size, created_at, modified_at, is_raw, rating, thumbnail_key, embedding_status)
				 VALUES (?, ?, 1, 0, 0, 0, ?, ?1, 'completed') RETURNING id`,
			);
			const insertExif = file.query(
				"INSERT INTO photo_exif (photo_id, date_taken) VALUES (?, ?)",
			);
			const insertVector = file.query(
				"INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at) VALUES (?, ?, ?, ?, 0)",
			);
			let photoIndex = 0;
			/** `events` events of PER_EVENT photos, 61 min apart (every pair compared). */
			const seedEvents = (events: number, firstEvent: number) => {
				file.transaction(() => {
					for (let event = firstEvent; event < firstEvent + events; event++) {
						const base = new Float32Array(DIMENSION);
						for (let index = 0; index < DIMENSION; index++) {
							base[index] = random() - 0.5;
						}
						for (let member = 0; member < PER_EVENT; member++) {
							const path = `y/e${event}/IMG_${photoIndex++}.JPG`;
							const row = insertPhoto.get(
								path,
								path.slice(path.lastIndexOf("/") + 1),
								Math.floor(random() * 6),
							);
							if (!row) throw new Error("no row");
							// 30 h per event: 19 * 61 min plus a gap of over 6 h.
							const minutes = event * 30 * 60 + member * 61;
							insertExif.run(row.id, exifAt(minutes));
							const vector = new Float32Array(DIMENSION);
							for (let index = 0; index < DIMENSION; index++) {
								vector[index] = base[index] + (random() - 0.5) * 0.1;
							}
							insertVector.run(
								row.id,
								new Uint8Array(vector.buffer),
								EMBEDDING_MODEL_VERSION,
								path,
							);
						}
					}
				})();
			};
			seedEvents(500, 0);
			file.run("ANALYZE");
			let started = performance.now();
			const tenThousand = detectEvents(fileDb);
			const detect10kMs = performance.now() - started;
			expect(tenThousand).toEqual({
				candidates: 10_000,
				events: 500,
				photos: 10_000,
			});
			expect(detect10kMs).toBeLessThan(3_000);

			seedEvents(500, 500);
			file.run("ANALYZE");
			started = performance.now();
			const twentyThousand = detectEvents(fileDb);
			const detect20kMs = performance.now() - started;
			expect(twentyThousand.events).toBe(1_000);

			const median = (run: () => unknown) => {
				const samples: number[] = [];
				for (let index = 0; index < 5; index++) {
					const begun = performance.now();
					run();
					samples.push(performance.now() - begun);
				}
				return samples.sort((left, right) => left - right)[2];
			};
			const medianAsync = async (run: () => Promise<unknown>) => {
				const samples: number[] = [];
				for (let index = 0; index < 5; index++) {
					const begun = performance.now();
					await run();
					samples.push(performance.now() - begun);
				}
				return samples.sort((left, right) => left - right)[2];
			};
			const sampleId = listEvents(fileDb).events[500].id;
			expect(listEvents(fileDb).events).toHaveLength(1_000);
			const listMs = median(() => listEvents(fileDb));
			const folderMs = median(() => listEvents(fileDb, { folder: "y/e700" }));
			const filterMs = await medianAsync(() =>
				listPhotos(fileDb, { event: sampleId }),
			);
			expect((await listPhotos(fileDb, { event: sampleId })).total).toBe(
				PER_EVENT,
			);
			expect(listMs).toBeLessThan(20);
			expect(folderMs).toBeLessThan(20);
			expect(filterMs).toBeLessThan(20);

			const statements: string[] = [];
			const original = file.prepare;
			file.prepare = ((...args: Parameters<typeof original>) => {
				statements.push(args[0]);
				return original.apply(file, args);
			}) as typeof original;
			try {
				listEvents(fileDb);
				listEvents(fileDb, { folder: "y/e700" });
				await listPhotos(fileDb, { event: sampleId });
			} finally {
				file.prepare = original;
			}
			const plan = (statement: string | undefined) => {
				if (!statement) throw new Error("statement not captured");
				const parameters = (statement.match(/\?/g) ?? []).map(() => null);
				return file
					.query<{ detail: string }, null[]>(`EXPLAIN QUERY PLAN ${statement}`)
					.all(...parameters)
					.map((row) => row.detail)
					.join("\n");
			};
			const [listPlan, folderPlan] = statements
				.filter((statement) => /FROM events/.test(statement))
				.map(plan);
			const filterPlan = plan(
				statements.find(
					(statement) =>
						/from "photos"/i.test(statement) && /event_photos/.test(statement),
				),
			);
			for (const eventsPlan of [listPlan, folderPlan]) {
				expect(eventsPlan).toMatch(
					/SCAN events USING INDEX idx_events_start_at_id/,
				);
				expect(eventsPlan).toMatch(/SEARCH cover USING INTEGER PRIMARY KEY/);
				expect(eventsPlan).not.toMatch(/TEMP B-TREE/);
			}
			expect(folderPlan).toMatch(
				/SEARCH member USING (COVERING )?INDEX sqlite_autoindex_event_photos_1 \(event_id=\?\)/,
			);
			expect(filterPlan).toMatch(
				/SEARCH event_photos USING (COVERING )?INDEX sqlite_autoindex_event_photos_1 \(event_id=\?\)/,
			);
			expect(filterPlan).not.toMatch(/SCAN (event_photos|photos)\b/);

			const log = (line: string) => console.log(`${PERF_LOG_PREFIX} ${line}`);
			log(
				`detectEvents 10,000 photos (512-d vectors, every pair compared): ${detect10kMs.toFixed(1)} ms; 20,000 photos: ${detect20kMs.toFixed(1)} ms`,
			);
			log(
				`listEvents 1,000 events: ${listMs.toFixed(2)} ms median; folder-scoped: ${folderMs.toFixed(2)} ms; listPhotos event filter (${PER_EVENT} rows, incl. EXIF hydration): ${filterMs.toFixed(2)} ms median`,
			);
			for (const [name, detail] of [
				["listEvents", listPlan],
				["listEvents folder", folderPlan],
				["listPhotos event", filterPlan],
			]) {
				log(`EXPLAIN ${name}: ${detail.replaceAll("\n", " | ")}`);
			}
		} finally {
			file.close();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
}
