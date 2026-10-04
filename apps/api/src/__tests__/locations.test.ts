import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { TRPCError } from "@trpc/server";
import { Hono } from "hono";
import {
	photoFiltersSchema,
	photoLocationsResponseSchema,
	photosResponseSchema,
	searchRequestSchema,
	smartAlbumFiltersRequestSchema,
} from "../routes/v1-schemas";
import {
	type ApiDatabase,
	listPhotoLocations,
	listPhotos,
	type PhotoBounds,
	type PhotoFilters,
	type PhotoLocationsResult,
} from "../services/photo-catalog";
import { createSmartAlbum } from "../services/smart-albums";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[locations-perf]";
const INVALID_REQUEST = {
	error: { code: "INVALID_REQUEST", message: "Request validation failed" },
};

mock.module("../services/vector-search", () => ({
	searchPhotosByText: async () => [],
	findSimilarPhotos: async () => [],
	findSimilarToPhoto: async () => null,
}));
mock.module("../inngest/client", () => ({
	inngest: { send: async () => undefined },
}));
mock.module("@inngest/realtime", () => ({
	getSubscriptionToken: async () => ({ token: "test-token" }),
}));
// Static imports would load the real native addon and Inngest client before these
// process-wide mocks are installed; this is an intentional loading boundary.
const { appRouter } = await import("../trpc/router");
const { createV1Router } = await import("../routes/v1");

let db: ApiDatabase;
let sqlite: Database;
let app: Hono;
let searchedFilters: PhotoFilters[];
// The context factory reads the current per-test database on every call.
const caller = appRouter.createCaller(() => ({ db }));

beforeEach(() => {
	({ db, sqlite } = createTestDb());
	searchedFilters = [];
	app = new Hono();
	app.route(
		"/api/v1",
		createV1Router({
			database: db,
			searchPhotos: async (_query, _limit, filters) => {
				searchedFilters.push(filters);
				return [];
			},
			dispatchScan: async () => undefined,
			photoDirectory: "../../test-photos",
			thumbnailsDirectory: "./test-thumbnails",
			nativeScanMutationsEnabled: false,
		}),
	);
});
afterEach(() => sqlite.close());

type PhotoOptions = {
	/** `undefined` stores no EXIF row at all. */
	gps?: [string | null, string | null];
	camera?: string;
	rating?: number;
};

function addPhoto(path: string, options: PhotoOptions = {}): number {
	const isRaw = /\.(arw|nef|cr2)$/i.test(path);
	const { id } = sqlite
		.query<{ id: number }, (string | number)[]>(
			`INSERT INTO photos (path, name, size, created_at, modified_at, is_raw, rating)
			 VALUES (?1, ?2, 1, 0, 0, ?3, ?4) RETURNING id`,
		)
		.get(
			path,
			path.slice(path.lastIndexOf("/") + 1),
			isRaw ? 1 : 0,
			options.rating ?? 0,
		) as { id: number };
	if (options.gps || options.camera) {
		sqlite.run(
			"INSERT INTO photo_exif (photo_id, camera_make, camera_model, gps_latitude, gps_longitude) VALUES (?, ?, ?, ?, ?)",
			[
				id,
				options.camera ? "Sony" : null,
				options.camera ?? null,
				options.gps?.[0] ?? null,
				options.gps?.[1] ?? null,
			],
		);
	}
	return id;
}

const ids = (filters: PhotoFilters = {}) =>
	listPhotoLocations(db, filters).points.map((point) => point.id);

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

async function get(path: string) {
	const response = await app.request(`/api/v1${path}`);
	return { status: response.status, body: (await response.json()) as unknown };
}

async function post(path: string, body: unknown) {
	const response = await app.request(`/api/v1${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as unknown };
}

describe("location validity", () => {
	test("accepts exact limits and rejects out-of-range, non-numeric, empty, null, partial, and 0,0", () => {
		const valid = {
			northPole: addPhoto("a/north.jpg", { gps: ["90", "180"] }),
			southPole: addPhoto("a/south.jpg", { gps: ["-90", "-180"] }),
			zeroLatitude: addPhoto("a/zero-lat.jpg", { gps: ["0", "10"] }),
			zeroLongitude: addPhoto("a/zero-lon.jpg", { gps: ["10", "0"] }),
			ordinary: addPhoto("a/ordinary.jpg", { gps: ["45.125", "-73.5"] }),
			exponent: addPhoto("a/exponent.jpg", { gps: ["1e-7", "2.5E1"] }),
		};
		for (const [path, gps] of [
			["b/lat-over.jpg", ["90.0001", "10"]],
			["b/lat-under.jpg", ["-90.0001", "10"]],
			["b/lon-over.jpg", ["10", "180.0001"]],
			["b/lon-under.jpg", ["10", "-180.0001"]],
			["b/text.jpg", ["abc", "10"]],
			["b/suffix.jpg", ["12abc", "10"]],
			["b/infinity.jpg", ["Infinity", "10"]],
			["b/nan.jpg", ["NaN", "10"]],
			["b/overflow.jpg", ["1e999", "10"]],
			["b/empty.jpg", ["", "10"]],
			["b/empty-lon.jpg", ["10", ""]],
			["b/null-lat.jpg", [null, "10"]],
			["b/null-lon.jpg", ["10", null]],
			["b/null-both.jpg", [null, null]],
			["b/origin.jpg", ["0", "0"]],
			["b/origin-decimal.jpg", ["0.0", "-0"]],
		] as const) {
			addPhoto(path, { gps: [...gps] });
		}
		addPhoto("b/no-exif.jpg");
		addPhoto("b/camera-only.jpg", { camera: "A7" });

		const result = listPhotoLocations(db);
		expect(result.total).toBe(6);
		expect(result.points).toEqual([
			{ id: valid.northPole, latitude: 90, longitude: 180 },
			{ id: valid.southPole, latitude: -90, longitude: -180 },
			{ id: valid.zeroLatitude, latitude: 0, longitude: 10 },
			{ id: valid.zeroLongitude, latitude: 10, longitude: 0 },
			{ id: valid.ordinary, latitude: 45.125, longitude: -73.5 },
			{ id: valid.exponent, latitude: 1e-7, longitude: 25 },
		]);
		for (const point of result.points) {
			expect(typeof point.latitude).toBe("number");
			expect(typeof point.longitude).toBe("number");
		}
		// The whole-world box selects exactly the valid locations through `bounds`.
		const world = { north: 90, south: -90, east: 180, west: -180 };
		expect(
			listPhotos(db, { bounds: world }).then(({ photos }) =>
				photos.map((photo) => photo.id).sort((a, b) => a - b),
			),
		).resolves.toEqual(Object.values(valid));
	});

	test("points are ordered by ascending ID", () => {
		const inserted = [
			addPhoto("z/3.jpg", { gps: ["3", "3"] }),
			addPhoto("a/1.jpg", { gps: ["1", "1"] }),
			addPhoto("m/2.jpg", { gps: ["-50", "120"] }),
		];
		sqlite.run("UPDATE photo_exif SET id = 100 - id");
		expect(ids()).toEqual([...inserted].sort((a, b) => a - b));
	});
});

describe("bounds filter", () => {
	test("edges are inclusive on all four sides", async () => {
		const box: PhotoBounds = { north: 10, south: -10, east: 20, west: -20 };
		const inside = [
			addPhoto("e/n.jpg", { gps: ["10", "0"] }),
			addPhoto("e/s.jpg", { gps: ["-10", "0"] }),
			addPhoto("e/e.jpg", { gps: ["0", "20"] }),
			addPhoto("e/w.jpg", { gps: ["5", "-20"] }),
			addPhoto("e/corner.jpg", { gps: ["10", "20"] }),
		];
		for (const gps of [
			["10.000001", "0"],
			["-10.000001", "0"],
			["0", "20.000001"],
			["5", "-20.000001"],
		] as const) {
			addPhoto(`e/out-${gps.join("_")}.jpg`, { gps: [...gps] });
		}
		expect(ids({ bounds: box })).toEqual(inside);
		const listed = await listPhotos(db, { bounds: box });
		expect(
			listed.photos.map((photo) => photo.id).sort((a, b) => a - b),
		).toEqual(inside);
	});

	test("west greater than east wraps the antimeridian", () => {
		const east = addPhoto("w/fiji.jpg", { gps: ["-17", "178"] });
		const edgeWest = addPhoto("w/edge-west.jpg", { gps: ["0", "170"] });
		const dateLine = addPhoto("w/date-line.jpg", { gps: ["0", "180"] });
		const antiDateLine = addPhoto("w/anti.jpg", { gps: ["0", "-180"] });
		const samoa = addPhoto("w/samoa.jpg", { gps: ["-13", "-172"] });
		const edgeEast = addPhoto("w/edge-east.jpg", { gps: ["0", "-170"] });
		const tokyo = addPhoto("w/tokyo.jpg", { gps: ["35", "139"] });
		const hawaii = addPhoto("w/hawaii.jpg", { gps: ["21", "-157"] });
		const greenwich = addPhoto("w/greenwich.jpg", { gps: ["51", "0.0001"] });
		expect(
			ids({ bounds: { north: 90, south: -90, west: 170, east: -170 } }),
		).toEqual([east, edgeWest, dateLine, antiDateLine, samoa, edgeEast]);
		// The same edges without wrap select the complement band, edges included.
		expect(
			ids({ bounds: { north: 90, south: -90, west: -170, east: 170 } }),
		).toEqual([edgeWest, edgeEast, tokyo, hawaii, greenwich]);
	});

	test("composes with another filter", async () => {
		const sonyIn = addPhoto("c/1.jpg", { gps: ["1", "1"], camera: "A7" });
		addPhoto("c/2.jpg", { gps: ["1", "1"], camera: "Z6" });
		addPhoto("c/3.jpg", { gps: ["50", "50"], camera: "A7" });
		const filters: PhotoFilters = {
			camera: "Sony A7",
			bounds: { north: 5, south: -5, east: 5, west: -5 },
		};
		expect(ids(filters)).toEqual([sonyIn]);
		expect(
			(await listPhotos(db, filters)).photos.map((photo) => photo.id),
		).toEqual([sonyIn]);
	});

	test("a RAW+JPEG pair yields one point and stacks like the listing", async () => {
		const raw = addPhoto("p/DSC_0001.ARW", { gps: ["48.85", "2.35"] });
		const jpg = addPhoto("p/DSC_0001.JPG", { gps: ["48.85", "2.35"] });
		// Only the RAW is geotagged: the RAW's point is shown.
		const rawOnly = addPhoto("p/DSC_0002.ARW", { gps: ["40", "-3"] });
		addPhoto("p/DSC_0002.JPG");
		// Only the JPEG matches the minRating filter: the JPEG is shown.
		addPhoto("p/DSC_0003.NEF", { gps: ["30", "30"] });
		const ratedJpg = addPhoto("p/DSC_0003.JPG", {
			gps: ["30", "30"],
			rating: 4,
		});

		expect(listPhotoLocations(db).points).toEqual([
			{ id: jpg, latitude: 48.85, longitude: 2.35 },
			{ id: rawOnly, latitude: 40, longitude: -3 },
			{ id: ratedJpg, latitude: 30, longitude: 30 },
		]);
		expect(ids({ minRating: 4 })).toEqual([ratedJpg]);
		const europe = { north: 60, south: 35, east: 10, west: -10 };
		expect(ids({ bounds: europe })).toEqual([jpg, rawOnly]);
		expect(ids({ bounds: europe, filterRaw: "raw" })).toEqual([raw, rawOnly]);
		const listed = await listPhotos(db, { bounds: europe });
		expect(
			listed.photos.map((photo) => photo.id).sort((a, b) => a - b),
		).toEqual([jpg, rawOnly]);
	});
});

describe("transports", () => {
	function seedParity() {
		addPhoto("t/a.jpg", { gps: ["10", "10"], camera: "A7" });
		addPhoto("t/b.jpg", { gps: ["-33.86", "151.2"], camera: "A7" });
		addPhoto("t/c.jpg", { gps: ["0", "0"], camera: "A7" });
		addPhoto("t/d.jpg", { gps: ["64.1", "-21.9"] });
		addPhoto("t/e.jpg");
	}

	test("tRPC photoLocations and v1 /locations match the service", async () => {
		seedParity();
		for (const [query, filters] of [
			["", {}],
			["?camera=Sony%20A7", { camera: "Sony A7" }],
			[
				"?north=20&south=-40&east=160&west=0",
				{ bounds: { north: 20, south: -40, east: 160, west: 0 } },
			],
		] as const) {
			const expected = listPhotoLocations(db, filters);
			expect(await caller.photoLocations(filters)).toEqual(expected);
			const response = await get(`/locations${query}`);
			expect(response.status).toBe(200);
			expect(photoLocationsResponseSchema.parse(response.body)).toEqual(
				expected,
			);
			expect(response.body).toEqual(expected);
		}
		expect(await caller.photoLocations()).toEqual(listPhotoLocations(db));
	});

	test("bounds on tRPC photos and v1 /photos match", async () => {
		seedParity();
		const bounds = { north: 20, south: -40, east: 160, west: 0 };
		const trpc = await caller.photos({ bounds });
		const v1 = await get("/photos?north=20&south=-40&east=160&west=0");
		expect(v1.status).toBe(200);
		const v1Ids = photosResponseSchema
			.parse(v1.body)
			.photos.map((photo) => photo.id);
		expect(trpc.photos.map((photo) => photo.id)).toEqual(v1Ids);
		expect(v1Ids).toEqual(ids({ bounds }));
	});

	test("search accepts bounds on both transports and forwards them", async () => {
		const bounds = { north: 1, south: -1, east: 1, west: -1 };
		expect(await caller.searchPhotos({ query: "beach", bounds })).toMatchObject(
			{ photos: [], total: 0 },
		);
		const response = await post("/search", { query: "beach", bounds });
		expect(response.status).toBe(200);
		expect(searchedFilters).toEqual([expect.objectContaining({ bounds })]);
		expect(
			await caller
				.similarPhotos({ photoId: 1, bounds })
				.catch((error: TRPCError) => error.code),
		).toBe("NOT_FOUND");
	});

	test("invalid bounds are BAD_REQUEST on every tRPC input", async () => {
		for (const bounds of [
			{ north: -1, south: 1, east: 0, west: 0 },
			{ north: 90.0001, south: 0, east: 0, west: 0 },
			{ north: 0, south: -90.0001, east: 0, west: 0 },
			{ north: 1, south: 0, east: 180.0001, west: 0 },
			{ north: 1, south: 0, east: 0, west: -180.0001 },
			{ north: Number.NaN, south: 0, east: 0, west: 0 },
			{ north: Number.POSITIVE_INFINITY, south: 0, east: 0, west: 0 },
		]) {
			expect(await trpcErrorCode(caller.photoLocations({ bounds }))).toBe(
				"BAD_REQUEST",
			);
			expect(await trpcErrorCode(caller.photos({ bounds }))).toBe(
				"BAD_REQUEST",
			);
			expect(
				await trpcErrorCode(caller.searchPhotos({ query: "x", bounds })),
			).toBe("BAD_REQUEST");
			expect(
				await trpcErrorCode(caller.similarPhotos({ photoId: 1, bounds })),
			).toBe("BAD_REQUEST");
		}
		// Partial bounds objects are rejected too.
		expect(
			await trpcErrorCode(
				caller.photoLocations({
					bounds: { north: 1, south: 0, east: 1 } as PhotoBounds,
				}),
			),
		).toBe("BAD_REQUEST");
	});

	test("v1 rejects partial, inverted, out-of-range, and non-numeric bounds with 400", async () => {
		for (const query of [
			"north=1",
			"north=1&south=0&east=1",
			"north=1&south=0&east=1&west=",
			"north=-1&south=1&east=1&west=0",
			"north=90.0001&south=0&east=1&west=0",
			"north=1&south=-90.0001&east=1&west=0",
			"north=1&south=0&east=180.0001&west=0",
			"north=1&south=0&east=1&west=-180.0001",
			"north=abc&south=0&east=1&west=0",
			"north=1&south=0&east=Infinity&west=0",
			"north=1&south=0&east=NaN&west=0",
		]) {
			for (const path of ["/locations", "/photos"]) {
				const response = await get(`${path}?${query}`);
				expect({ query, path, ...response }).toEqual({
					query,
					path,
					status: 400,
					body: INVALID_REQUEST,
				});
			}
		}
		// Exact limits are accepted.
		expect(
			(await get("/locations?north=90&south=-90&east=180&west=-180")).status,
		).toBe(200);
		for (const bounds of [
			{ north: -1, south: 1, east: 0, west: 0 },
			{ north: 1, south: 0, east: 181, west: 0 },
			{ north: 1, south: 0, east: 1 },
			{ north: "1", south: 0, east: 1, west: 0 },
			{ north: 1, south: 0, east: 1, west: 0, up: 1 },
		]) {
			const response = await post("/search", { query: "x", bounds });
			expect(response).toEqual({ status: 400, body: INVALID_REQUEST });
		}
		expect(searchedFilters).toEqual([]);
	});

	test("schemas fold query bounds and keep the search body strict", () => {
		expect(
			photoFiltersSchema.parse({
				north: "1.5",
				south: "-1",
				east: "2",
				west: "-2",
				camera: "x",
			}),
		).toEqual({
			filterRaw: "all",
			camera: "x",
			bounds: { north: 1.5, south: -1, east: 2, west: -2 },
		});
		expect(photoFiltersSchema.parse({})).toEqual({ filterRaw: "all" });
		expect(
			searchRequestSchema.safeParse({
				query: "x",
				north: 1,
				south: 0,
				east: 1,
				west: 0,
			}).success,
		).toBe(false);
	});
});

describe("smart albums", () => {
	test("reject bounds exactly like collectionId", async () => {
		addPhoto("s/a.jpg", { gps: ["1", "1"], camera: "A7" });
		const bounds = { north: 1, south: 0, east: 1, west: 0 };
		for (const extra of [{ collectionId: 1 }, { bounds }]) {
			expect(
				smartAlbumFiltersRequestSchema.safeParse({ camera: "x", ...extra })
					.success,
			).toBe(false);
			expect(
				await trpcErrorCode(
					caller.createSmartAlbum({
						name: "Area",
						filters: { camera: "x", ...extra } as never,
					}),
				),
			).toBe("BAD_REQUEST");
			expect(
				await post("/smart-albums", {
					name: "Area",
					filters: { camera: "x", ...extra },
				}),
			).toEqual({ status: 400, body: INVALID_REQUEST });
		}
		// The service canonicalizes known keys only, so bounds never reach storage.
		const album = createSmartAlbum(db, {
			name: "Direct",
			filters: { camera: "Sony A7", bounds } as never,
		});
		expect(album.filters).toEqual({ camera: "Sony A7" });
		expect(sqlite.query("SELECT filters FROM smart_albums").get()).toEqual({
			filters: JSON.stringify({ camera: "Sony A7" }),
		});
	});
});

describe("performance", () => {
	test("8,000 geotagged photos list within 50 ms in one statement", async () => {
		const COUNT = 8_000;
		const insertPhoto = sqlite.prepare(
			"INSERT INTO photos (id, path, name, size, created_at, modified_at, is_raw) VALUES (?, ?, ?, 1, 0, 0, ?)",
		);
		const insertExif = sqlite.prepare(
			"INSERT INTO photo_exif (photo_id, camera_make, camera_model, gps_latitude, gps_longitude) VALUES (?, 'Sony', 'A7', ?, ?)",
		);
		sqlite.transaction(() => {
			for (let id = 1; id <= COUNT; id++) {
				// Rows 1-2, 21-22, ... are RAW+JPEG pairs sharing a stem and folder.
				const group = Math.floor((id - 1) / 20);
				const paired = (id - 1) % 20 < 2;
				const stem = paired ? `pair_${group}` : `photo_${id}`;
				const extension = paired && (id - 1) % 20 === 0 ? "ARW" : "JPG";
				insertPhoto.run(
					id,
					`perf/${group % 40}/${stem}.${extension}`,
					`${stem}.${extension}`,
					extension === "ARW" ? 1 : 0,
				);
				insertExif.run(
					id,
					String(((id * 37) % 17_000) / 100 - 85),
					String(((id * 53) % 35_000) / 100 - 175),
				);
			}
		})();
		sqlite.run("ANALYZE");

		const statements: string[] = [];
		const original = sqlite.prepare;
		// Database.prepare is generic over its row type; the wrapper forwards it unchanged.
		sqlite.prepare = ((...args: Parameters<typeof original>) => {
			statements.push(args[0]);
			return original.apply(sqlite, args);
		}) as typeof original;
		let result: PhotoLocationsResult;
		try {
			result = listPhotoLocations(db);
		} finally {
			sqlite.prepare = original;
		}
		expect(statements).toHaveLength(1);
		const pairs = COUNT / 20;
		expect(result.total).toBe(COUNT - pairs);
		expect(result.points.map((point) => point.id)).toEqual(
			[...result.points.map((point) => point.id)].sort((a, b) => a - b),
		);

		function median(run: () => unknown, runs = 5) {
			run();
			const samples: number[] = [];
			for (let index = 0; index < runs; index++) {
				const started = performance.now();
				run();
				samples.push(performance.now() - started);
			}
			return samples.sort((left, right) => left - right)[Math.floor(runs / 2)];
		}
		const all = median(() => listPhotoLocations(db));
		const bounded = median(() =>
			listPhotoLocations(db, {
				bounds: { north: 45, south: -45, east: -170, west: 170 },
			}),
		);
		const filtered = median(() =>
			listPhotoLocations(db, {
				folder: "perf/3",
				bounds: { north: 60, south: -60, east: 120, west: -120 },
			}),
		);
		console.log(
			`${PERF_LOG_PREFIX} listPhotoLocations over ${COUNT} geotagged photos / ${pairs} pairs (${result.total} points): all ${all.toFixed(2)} ms median; antimeridian box ${bounded.toFixed(2)} ms; folder+box ${filtered.toFixed(2)} ms`,
		);
		expect(all).toBeLessThan(50);
		expect(bounded).toBeLessThan(50);
		expect(filtered).toBeLessThan(50);
	});
});
