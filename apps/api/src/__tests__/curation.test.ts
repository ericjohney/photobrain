import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import { photoExif, photos } from "../db/schema";
import {
	type ApiDatabase,
	listPhotos,
	type PhotoFilters,
} from "../services/photo-catalog";
import {
	MAX_CURATION_IDS,
	type PhotoCurationResult,
	type PhotoFlag,
	updatePhotoCuration,
} from "../services/photo-curation";
import { createTestDb, perfBudgetMs, seedTestData } from "./setup";

const PERF_LOG_PREFIX = "[curation-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";
const PRIVATE_FIELDS = [
	"sourceRoot",
	"sourceFingerprint",
	"mediaVersion",
	"thumbnailKey",
	"thumbnailRoot",
	"thumbnailFingerprint",
];
const INVALID_REQUEST = {
	error: { code: "INVALID_REQUEST", message: "Request validation failed" },
};

// Deliberately invalid enum values; casts let them reach runtime validation.
const INVALID_PATCH_FLAG = "unflagged" as PhotoFlag;
const INVALID_FILTER_FLAG = "maybe" as NonNullable<PhotoFilters["flag"]>;

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
let ids: number[];
let app: Hono;
// The context factory reads the current per-test database on every call.
const caller = appRouter.createCaller(() => ({ db }));

beforeEach(() => {
	({ db, sqlite } = createTestDb());
	ids = seedTestData(db).map((photo) => photo.id);
	db.update(photos)
		.set({
			sourceRoot: "/private/source",
			sourceFingerprint: "private-source-fingerprint",
			mediaVersion: "private-media-version",
			thumbnailKey: "private-thumbnail-key",
			thumbnailRoot: "/private/thumbnails",
			thumbnailFingerprint: "private-thumbnail-fingerprint",
		})
		.run();
	app = new Hono();
	app.route(
		"/api/v1",
		createV1Router({
			database: db,
			searchPhotos: async () => [],
			dispatchScan: async () => undefined,
			photoDirectory: "../../test-photos",
			thumbnailsDirectory: "./test-thumbnails",
			// Curation must not depend on the native scan mutation flag.
			nativeScanMutationsEnabled: false,
		}),
	);
});
afterEach(() => sqlite.close());

function curationState() {
	return db
		.select({ id: photos.id, rating: photos.rating, flag: photos.flag })
		.from(photos)
		.orderBy(asc(photos.id))
		.all();
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

async function responseJson(response: Response) {
	return JSON.parse(await response.text()) as unknown;
}

function patchPhoto(id: number | string, body: unknown) {
	return app.request(`/api/v1/photos/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

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

describe("updatePhotoCuration", () => {
	test("updates only listed ids in one UPDATE statement and returns only existing ids", async () => {
		let result: PhotoCurationResult | undefined;
		const statements = await captureStatements(() => {
			result = updatePhotoCuration(db, [ids[2], 999_999, ids[0], ids[0]], {
				rating: 4,
				flag: "pick",
			});
		});

		expect(result).toEqual({
			updated: [
				{ id: ids[0], rating: 4, flag: "pick" },
				{ id: ids[2], rating: 4, flag: "pick" },
			],
		});
		const dataStatements = statements.filter(
			(statement) =>
				!/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement),
		);
		expect(dataStatements).toHaveLength(1);
		// The ID set spans lines: listed IDs plus their pair partners.
		expect(dataStatements[0]).toMatch(
			/^update "photos" set [\s\S]* returning/i,
		);
		expect(curationState()).toEqual([
			{ id: ids[0], rating: 4, flag: "pick" },
			{ id: ids[1], rating: 0, flag: null },
			{ id: ids[2], rating: 4, flag: "pick" },
			{ id: ids[3], rating: 0, flag: null },
			{ id: ids[4], rating: 0, flag: null },
		]);
	});

	test("unknown ids alone update nothing and return an empty list", () => {
		const before = curationState();
		expect(updatePhotoCuration(db, [999_998, 999_999], { rating: 3 })).toEqual({
			updated: [],
		});
		expect(curationState()).toEqual(before);
	});

	test("partial patches leave the other field untouched and a null flag clears", () => {
		const [id] = ids;
		const read = () =>
			updatePhotoCuration(db, [id], { rating: 3, flag: "pick" }).updated[0];
		expect(read()).toEqual({ id, rating: 3, flag: "pick" });
		expect(
			updatePhotoCuration(db, [id], { flag: "reject" }).updated[0],
		).toEqual({ id, rating: 3, flag: "reject" });
		expect(updatePhotoCuration(db, [id], { rating: 5 }).updated[0]).toEqual({
			id,
			rating: 5,
			flag: "reject",
		});
		expect(updatePhotoCuration(db, [id], { flag: null }).updated[0]).toEqual({
			id,
			rating: 5,
			flag: null,
		});
		expect(updatePhotoCuration(db, [id], { rating: 0 }).updated[0]).toEqual({
			id,
			rating: 0,
			flag: null,
		});
	});

	test("rejects out-of-range ratings, invalid flags, empty patches, and bad id counts without writing", () => {
		updatePhotoCuration(db, [ids[0]], { rating: 2, flag: "pick" });
		const before = curationState();
		const tooMany = Array.from(
			{ length: MAX_CURATION_IDS + 1 },
			(_, index) => index + 1,
		);
		for (const [photoIds, patch] of [
			[[ids[0]], { rating: -1 }],
			[[ids[0]], { rating: 6 }],
			[[ids[0]], { rating: 1.5 }],
			[[ids[0]], { flag: INVALID_PATCH_FLAG }],
			[[ids[0]], {}],
			[[ids[0]], { rating: undefined, flag: undefined }],
			[[], { rating: 1 }],
			[tooMany, { rating: 1 }],
		] as const) {
			expect(() => updatePhotoCuration(db, photoIds, patch)).toThrow(
				RangeError,
			);
		}
		expect(curationState()).toEqual(before);

		// Duplicates collapse before the 500-id bound applies.
		const exactlyMax = [
			...Array.from({ length: MAX_CURATION_IDS }, (_, index) => index + 1),
			1,
		];
		expect(
			updatePhotoCuration(db, exactlyMax, { rating: 1 }).updated,
		).toHaveLength(ids.length);
	});

	test("the database CHECK constraints reject values that bypass the service", () => {
		expect(() =>
			sqlite.run("UPDATE photos SET rating = 6 WHERE id = ?", [ids[0]]),
		).toThrow(/CHECK constraint failed/);
		expect(() =>
			sqlite.run("UPDATE photos SET rating = -1 WHERE id = ?", [ids[0]]),
		).toThrow(/CHECK constraint failed/);
		expect(() =>
			sqlite.run("UPDATE photos SET flag = 'maybe' WHERE id = ?", [ids[0]]),
		).toThrow(/CHECK constraint failed/);
	});
});

describe("tRPC setPhotoCuration", () => {
	test("applies a patch to several photos and returns the service result", async () => {
		expect(
			await caller.setPhotoCuration({
				photoIds: [ids[1], ids[3], 999_999],
				rating: 5,
				flag: "reject",
			}),
		).toEqual({
			updated: [
				{ id: ids[1], rating: 5, flag: "reject" },
				{ id: ids[3], rating: 5, flag: "reject" },
			],
		});
		expect(
			await caller.setPhotoCuration({ photoIds: [ids[1]], flag: null }),
		).toEqual({ updated: [{ id: ids[1], rating: 5, flag: null }] });
		expect(
			await caller.setPhotoCuration({ photoIds: [ids[1]], rating: 0 }),
		).toEqual({ updated: [{ id: ids[1], rating: 0, flag: null }] });

		const photo = await caller.photo({ id: ids[3] });
		expect(photo).toMatchObject({ rating: 5, flag: "reject" });
	});

	test("accepts rating bounds and 500 ids; rejects -1, 6, 1.5, empty patches, bad flags, and 501 ids", async () => {
		const many = (count: number) =>
			Array.from({ length: count }, (_, index) => index + 1);
		for (const rating of [0, 5]) {
			const result = await caller.setPhotoCuration({
				photoIds: [ids[0]],
				rating,
			});
			expect(result.updated[0].rating).toBe(rating);
		}
		expect(
			(await caller.setPhotoCuration({ photoIds: many(500), rating: 2 }))
				.updated,
		).toHaveLength(ids.length);

		const before = curationState();
		for (const input of [
			{ photoIds: [ids[0]], rating: -1 },
			{ photoIds: [ids[0]], rating: 6 },
			{ photoIds: [ids[0]], rating: 1.5 },
			{ photoIds: [ids[0]] },
			{ photoIds: [ids[0]], flag: INVALID_PATCH_FLAG },
			{ photoIds: [], rating: 1 },
			{ photoIds: [0], rating: 1 },
			{ photoIds: many(501), rating: 1 },
		]) {
			expect(await trpcErrorCode(caller.setPhotoCuration(input))).toBe(
				"BAD_REQUEST",
			);
		}
		expect(curationState()).toEqual(before);
	});
});

describe("curation filters on photos", () => {
	beforeEach(() => {
		updatePhotoCuration(db, [ids[0]], { rating: 5, flag: "pick" });
		updatePhotoCuration(db, [ids[1]], { rating: 3, flag: "reject" });
		updatePhotoCuration(db, [ids[2]], { rating: 1 });
		updatePhotoCuration(db, [ids[3]], { flag: "pick" });
	});

	const names = (result: { photos: Array<{ id: number }> }) =>
		result.photos.map((photo) => ids.indexOf(photo.id) + 1).sort();

	test.each([
		["minRating 1", { minRating: 1 }, [1, 2, 3]],
		["minRating 3", { minRating: 3 }, [1, 2]],
		["minRating 5", { minRating: 5 }, [1]],
		["flag pick", { flag: "pick" }, [1, 4]],
		["flag reject", { flag: "reject" }, [2]],
		["flag unflagged", { flag: "unflagged" }, [3, 5]],
		["minRating + flag", { minRating: 3, flag: "pick" }, [1]],
		["folder + unflagged", { folder: "folder2", flag: "unflagged" }, [3, 5]],
		["camera + minRating", { camera: "Sony A7III", minRating: 4 }, [1]],
		["no curation filter", {}, [1, 2, 3, 4, 5]],
	] as const)("tRPC photos %s", async (_label, filters, expected) => {
		const result = await caller.photos(filters);
		expect(names(result)).toEqual([...expected]);
		expect(result.total).toBe(expected.length);
	});

	test("photo objects carry rating and flag", async () => {
		const result = await caller.photos({});
		const first = result.photos.find((photo) => photo.id === ids[0]);
		const fifth = result.photos.find((photo) => photo.id === ids[4]);
		expect(first).toMatchObject({ rating: 5, flag: "pick" });
		expect(fifth).toMatchObject({ rating: 0, flag: null });
	});

	test("tRPC rejects minRating outside 1-5 or fractional, and unknown flags", async () => {
		for (const input of [
			{ minRating: 0 },
			{ minRating: 6 },
			{ minRating: 1.5 },
			{ flag: INVALID_FILTER_FLAG },
		]) {
			expect(await trpcErrorCode(caller.photos(input))).toBe("BAD_REQUEST");
		}
	});

	test("v1 GET /photos applies the same filters and validates them", async () => {
		for (const [query, filters] of [
			["minRating=3", { minRating: 3 }],
			["flag=pick", { flag: "pick" }],
			["flag=unflagged", { flag: "unflagged" }],
			["minRating=1&flag=reject", { minRating: 1, flag: "reject" }],
		] as const) {
			const response = await app.request(`/api/v1/photos?${query}`);
			expect(response.status).toBe(200);
			const body = z
				.object({
					photos: z.array(z.object({ id: z.number() }).passthrough()),
					total: z.number(),
				})
				.parse(await responseJson(response));
			const expected = await caller.photos(filters);
			expect(body.photos.map((photo) => photo.id)).toEqual(
				expected.photos.map((photo) => photo.id),
			);
			expect(body.total).toBe(expected.total);
		}

		for (const query of [
			"minRating=0",
			"minRating=6",
			"minRating=1.5",
			"minRating=abc",
			"flag=bogus",
		]) {
			const response = await app.request(`/api/v1/photos?${query}`);
			expect(response.status).toBe(400);
			expect(await responseJson(response)).toEqual(INVALID_REQUEST);
		}
	});
});

describe("PATCH /api/v1/photos/:id", () => {
	test("returns the full public DTO with new values and matches GET detail", async () => {
		const response = await patchPhoto(ids[0], { rating: 4, flag: "pick" });
		expect(response.status).toBe(200);
		const body = z.record(z.unknown()).parse(await responseJson(response));
		expect(body).toMatchObject({
			id: ids[0],
			name: "photo1.jpg",
			rating: 4,
			flag: "pick",
			exif: { cameraMake: "Sony" },
		});
		expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		for (const key of PRIVATE_FIELDS) expect(body).not.toHaveProperty(key);
		const detail = await app.request(`/api/v1/photos/${ids[0]}`);
		expect(await responseJson(detail)).toEqual(body);

		const ratingOnly = await patchPhoto(ids[0], { rating: 0 });
		expect(await responseJson(ratingOnly)).toMatchObject({
			rating: 0,
			flag: "pick",
		});
		const cleared = await patchPhoto(ids[0], { flag: null });
		expect(cleared.status).toBe(200);
		expect(await responseJson(cleared)).toMatchObject({
			rating: 0,
			flag: null,
		});
		const max = await patchPhoto(ids[4], { rating: 5, flag: "reject" });
		expect(await responseJson(max)).toMatchObject({
			id: ids[4],
			rating: 5,
			flag: "reject",
			exif: null,
		});
		expect(curationState()[1]).toEqual({ id: ids[1], rating: 0, flag: null });
	});

	test("unknown photo returns 404 PHOTO_NOT_FOUND", async () => {
		const response = await patchPhoto(999_999, { rating: 3 });
		expect(response.status).toBe(404);
		expect(await responseJson(response)).toEqual({
			error: { code: "PHOTO_NOT_FOUND", message: "Photo not found" },
		});
	});

	test("invalid ids and bodies return 400 INVALID_REQUEST without writing", async () => {
		const before = curationState();
		for (const [id, body] of [
			[ids[0], { rating: 3, album: "x" }],
			[ids[0], {}],
			[ids[0], { rating: -1 }],
			[ids[0], { rating: 6 }],
			[ids[0], { rating: 1.5 }],
			[ids[0], { rating: "3" }],
			[ids[0], { flag: "maybe" }],
			[ids[0], { flag: "unflagged" }],
			[ids[0], "not json"],
			[ids[0], "[]"],
			[0, { rating: 3 }],
			["abc", { rating: 3 }],
		] as const) {
			const response = await patchPhoto(id, body);
			expect(response.status).toBe(400);
			expect(await responseJson(response)).toEqual(INVALID_REQUEST);
		}
		expect(curationState()).toEqual(before);
	});
});

describe("migration 0007", () => {
	test("adds rating 0 / flag null to existing rows without touching identity or sidecars", () => {
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
			const curationIndex = journal.entries.findIndex((entry) =>
				entry.tag.startsWith("0007_"),
			);
			expect(curationIndex).toBeGreaterThan(0);
			writeFileSync(
				journalPath,
				JSON.stringify({
					...journal,
					entries: journal.entries.slice(0, curationIndex),
				}),
			);

			const legacy = new Database(":memory:");
			const legacyDb = drizzle(legacy, { schema });
			migrate(legacyDb, { migrationsFolder: partial });
			expect(
				legacy
					.query<{ name: string }, []>(
						"SELECT name FROM pragma_table_info('photos')",
					)
					.all()
					.map((row) => row.name),
			).not.toContain("rating");
			legacy.run(
				`INSERT INTO photos (id, path, name, size, created_at, modified_at, thumbnail_key)
				 VALUES (7, 'a/one.jpg', 'one.jpg', 1, 0, 0, 'key-one'),
				        (9, 'a/two.jpg', 'two.jpg', 2, 0, 0, 'key-two')`,
			);
			legacy.run(
				"INSERT INTO photo_exif (photo_id, camera_make) VALUES (7, 'Sony')",
			);

			migrate(legacyDb, { migrationsFolder: MIGRATIONS_FOLDER });

			expect(
				legacy
					.query(
						"SELECT id, path, thumbnail_key, rating, flag FROM photos ORDER BY id",
					)
					.all(),
			).toEqual([
				{
					id: 7,
					path: "a/one.jpg",
					thumbnail_key: "key-one",
					rating: 0,
					flag: null,
				},
				{
					id: 9,
					path: "a/two.jpg",
					thumbnail_key: "key-two",
					rating: 0,
					flag: null,
				},
			]);
			expect(
				legacy.query("SELECT photo_id, camera_make FROM photo_exif").all(),
			).toEqual([{ photo_id: 7, camera_make: "Sony" }]);
			const indexes = legacy
				.query<{ name: string }, []>(
					"SELECT name FROM pragma_index_list('photos')",
				)
				.all()
				.map((row) => row.name);
			expect(indexes).toEqual(
				expect.arrayContaining(["idx_photos_rating", "idx_photos_flag"]),
			);
			expect(() =>
				legacy.run("UPDATE photos SET rating = 6 WHERE id = 7"),
			).toThrow(/CHECK constraint failed/);
			legacy.run("UPDATE photos SET rating = 5, flag = 'reject' WHERE id = 7");
			expect(
				legacy.query("SELECT rating, flag FROM photos WHERE id = 7").get(),
			).toEqual({ rating: 5, flag: "reject" });
			legacy.close();
		} finally {
			rmSync(partial, { recursive: true, force: true });
		}
	});
});

describe("curation performance over 8,000 photos", () => {
	const COUNT = 8_000;

	beforeEach(() => {
		db.delete(photoExif).run();
		db.delete(photos).run();
		const insert = sqlite.prepare(
			`INSERT INTO photos (path, name, size, created_at, modified_at, rating, flag)
			 VALUES (?, ?, 1, 0, 0, ?, ?)`,
		);
		sqlite.transaction(() => {
			for (let index = 0; index < COUNT; index++) {
				const rating = index % 50 === 0 ? 5 : index % 7 === 0 ? 2 : 0;
				const flag = index % 40 === 0 ? "pick" : null;
				insert.run(`perf/${index}.jpg`, `${index}.jpg`, rating, flag);
			}
		})();
	});

	test("setPhotoCuration with 500 ids completes within 50 ms", async () => {
		const all = curationState().map((row) => row.id);
		const target = all.filter((_, index) => index % 16 === 0).slice(0, 500);
		expect(target).toHaveLength(500);

		const started = performance.now();
		const result = await caller.setPhotoCuration({
			photoIds: target,
			rating: 3,
			flag: "reject",
		});
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} setPhotoCuration 500 ids over ${COUNT} photos: ${elapsed.toFixed(2)} ms`,
		);

		expect(result.updated.map((row) => row.id)).toEqual(target);
		const targeted = new Set(target);
		for (const row of curationState()) {
			if (targeted.has(row.id)) {
				expect(row).toMatchObject({ rating: 3, flag: "reject" });
			} else {
				expect(row.flag).not.toBe("reject");
			}
		}
		expect(elapsed).toBeLessThan(perfBudgetMs(50));
	});

	test("minRating and flag filters use their indexes", async () => {
		const planFor = async (filters: PhotoFilters) => {
			const statements = await captureStatements(() => listPhotos(db, filters));
			const listing = statements.find((statement) =>
				/from "photos"/i.test(statement),
			);
			if (!listing) throw new Error("listPhotos statement not captured");
			// Unbound parameters are NULL; the plan does not depend on their values.
			return sqlite
				.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${listing}`)
				.all()
				.map((row) => row.detail)
				.join("\n");
		};
		expect(await planFor({ minRating: 4 })).toMatch(
			/SEARCH photos USING (COVERING )?INDEX idx_photos_rating \(rating>\?\)/,
		);
		expect(await planFor({ flag: "pick" })).toMatch(
			/SEARCH photos USING (COVERING )?INDEX idx_photos_flag \(flag=\?\)/,
		);
		expect(await planFor({ flag: "unflagged" })).toMatch(
			/SEARCH photos USING (COVERING )?INDEX idx_photos_flag \(flag=\?\)/,
		);

		const started = performance.now();
		const result = await listPhotos(db, { minRating: 4 });
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} listPhotos minRating=4 over ${COUNT} photos (${result.total} rows, incl. EXIF hydration): ${elapsed.toFixed(2)} ms`,
		);
		expect(result.total).toBe(COUNT / 50);
		expect(result.photos.every((photo) => photo.rating === 5)).toBe(true);
	});
});
