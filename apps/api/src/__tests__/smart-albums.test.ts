import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { photoExif, photos, photoTags, smartAlbums } from "../db/schema";
import {
	createSmartAlbumRequestSchema,
	smartAlbumFiltersRequestSchema,
	smartAlbumSchema,
	smartAlbumsResponseSchema,
	updateSmartAlbumRequestSchema,
} from "../routes/v1-schemas";
import { createCollection } from "../services/collections";
import { type ApiDatabase, listPhotos } from "../services/photo-catalog";
import {
	createSmartAlbum,
	deleteSmartAlbum,
	listSmartAlbums,
	SmartAlbumError,
	updateSmartAlbum,
} from "../services/smart-albums";
import { createTestDb, seedTestData } from "./setup";

const MIGRATIONS_FOLDER = "../../packages/db/drizzle";
const INVALID_REQUEST = {
	error: { code: "INVALID_REQUEST", message: "Request validation failed" },
};
const SMART_ALBUM_NOT_FOUND = {
	error: { code: "SMART_ALBUM_NOT_FOUND", message: "Smart album not found" },
};
const SMART_ALBUM_NAME_TAKEN = {
	error: {
		code: "SMART_ALBUM_NAME_TAKEN",
		message: "A smart album with that name already exists",
	},
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
let ids: number[];
let app: Hono;
// The context factory reads the current per-test database on every call.
const caller = appRouter.createCaller(() => ({ db }));

beforeEach(() => {
	({ db, sqlite } = createTestDb());
	ids = seedTestData(db).map((photo) => photo.id);
	// Real Rust EXIF dates use `YYYY:MM:DD`; keep one dashed row to prove both match.
	for (const [index, dateTaken] of [
		[0, "2024:06:15 12:00:00"],
		[1, "2024-06-20T14:00:00"],
		[2, "2024:07:10 08:00:00"],
	] as const) {
		db.update(photoExif)
			.set({ dateTaken })
			.where(eq(photoExif.photoId, ids[index]))
			.run();
	}
	app = new Hono();
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
});
afterEach(() => sqlite.close());

function domainError(run: () => unknown) {
	try {
		run();
	} catch (error) {
		if (error instanceof SmartAlbumError) return error.code;
		throw error;
	}
	throw new Error("Expected a SmartAlbumError");
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

async function send(method: string, path: string, body?: unknown) {
	const response = await app.request(`/api/v1${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text.length === 0 ? null : (JSON.parse(text) as unknown),
	};
}

function storedRows() {
	return db.select().from(smartAlbums).all();
}

/** Ratings, tags, and a cover cache token for combined-filter scenarios. */
function curate() {
	const ratings = [4, 5, 5, 2, 5];
	for (const [index, rating] of ratings.entries()) {
		db.update(photos).set({ rating }).where(eq(photos.id, ids[index])).run();
	}
	db.insert(photoTags)
		.values([
			{ photoId: ids[0], tag: "beach", score: 0.9 },
			{ photoId: ids[1], tag: "beach", score: 0.8 },
			{ photoId: ids[2], tag: "beach", score: 0.7 },
			{ photoId: ids[3], tag: "beach", score: 0.6 },
			{ photoId: ids[1], tag: "sunset", score: 0.5 },
		])
		.run();
	db.update(photos)
		.set({ thumbnailUpdatedAt: new Date("2025-05-05T05:05:05.000Z") })
		.where(inArray(photos.id, [ids[0], ids[1]]))
		.run();
}

describe("validation and canonical storage", () => {
	test("an album without any filter or query is rejected and nothing is stored", () => {
		for (const filters of [
			{},
			{ filterRaw: "all" as const },
			{ folder: "", camera: "", lens: "", dateMonth: "", tag: "" },
		]) {
			expect(
				domainError(() => createSmartAlbum(db, { name: "X", filters })),
			).toBe("EMPTY");
			expect(
				domainError(() =>
					createSmartAlbum(db, { name: "X", filters, query: null }),
				),
			).toBe("EMPTY");
		}
		expect(() =>
			createSmartAlbum(db, { name: "X", filters: {}, query: "   " }),
		).toThrow(RangeError);
		expect(storedRows()).toEqual([]);
	});

	test("filters are canonicalized: empties dropped, 'all' absent, dateMonth stored as YYYY-MM", () => {
		const album = createSmartAlbum(db, {
			name: "  June  ",
			filters: {
				filterRaw: "all",
				folder: "",
				camera: "Sony A7III",
				dateMonth: "2024:06",
				tag: "",
			},
			query: "  beach sunset  ",
		});
		expect(album).toMatchObject({
			name: "June",
			filters: { camera: "Sony A7III", dateMonth: "2024:06" },
			query: "beach sunset",
		});
		expect(Object.keys(album.filters).sort()).toEqual(["camera", "dateMonth"]);
		expect(JSON.parse(storedRows()[0].filters)).toEqual({
			camera: "Sony A7III",
			dateMonth: "2024-06",
		});
	});

	test("names are unique case-insensitively among smart albums only", () => {
		createCollection(db, "Favorites");
		const album = createSmartAlbum(db, {
			name: "Favorites",
			filters: { minRating: 4 },
		});
		for (const name of ["favorites", " FAVORITES "]) {
			expect(
				domainError(() =>
					createSmartAlbum(db, { name, filters: { minRating: 5 } }),
				),
			).toBe("NAME_TAKEN");
		}
		const other = createSmartAlbum(db, {
			name: "Other",
			filters: { flag: "pick" },
		});
		expect(
			domainError(() => updateSmartAlbum(db, other.id, { name: "FAVORITES" })),
		).toBe("NAME_TAKEN");
		expect(updateSmartAlbum(db, album.id, { name: "FAVORITES" }).name).toBe(
			"FAVORITES",
		);
		expect(listSmartAlbums(db).map((a) => a.name)).toEqual([
			"FAVORITES",
			"Other",
		]);
	});

	test("unknown keys in stored filters are ignored on read and never applied", () => {
		sqlite.run(
			`INSERT INTO smart_albums (name, filters, query, created_at, updated_at)
			 VALUES ('Legacy', '{"camera":"Sony A7III","collectionId":999,"futureKey":true}', NULL, 0, 0)`,
		);
		const [legacy] = listSmartAlbums(db);
		expect(legacy.filters).toEqual({ camera: "Sony A7III" });
		// collectionId 999 does not exist; were it applied the count would be 0.
		expect(legacy.photoCount).toBe(2);
		// Rewriting the album persists only canonical keys.
		updateSmartAlbum(db, legacy.id, { name: "Legacy 2" });
		expect(JSON.parse(storedRows()[0].filters)).toEqual({
			camera: "Sony A7III",
		});
	});
});

describe("live counts and covers", () => {
	test("dateMonth in either form counts the same photos and serializes per transport", async () => {
		const colon = await caller.createSmartAlbum({
			name: "Colon",
			filters: { dateMonth: "2024:06" },
		});
		const dash = await caller.createSmartAlbum({
			name: "Dash",
			filters: { dateMonth: "2024-06" },
		});
		for (const album of [colon, dash]) {
			expect(album).toMatchObject({
				filters: { dateMonth: "2024:06" },
				photoCount: 2,
				cover: { photoId: ids[1] },
			});
		}
		const listed = await send("GET", "/smart-albums");
		expect(listed.status).toBe(200);
		const { albums } = smartAlbumsResponseSchema.parse(listed.body);
		expect(albums.map((a) => [a.filters.dateMonth, a.photoCount])).toEqual([
			["2024-06", 2],
			["2024-06", 2],
		]);
		const created = await send("POST", "/smart-albums", {
			name: "V1 colon",
			filters: { dateMonth: "2024:07" },
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			filters: { dateMonth: "2024-07" },
			photoCount: 1,
			cover: { photoId: ids[2] },
		});
		expect((await caller.smartAlbums()).albums.map((a) => a.filters)).toEqual([
			{ dateMonth: "2024:06" },
			{ dateMonth: "2024:06" },
			{ dateMonth: "2024:07" },
		]);
	});

	test("combined filters including tag and minRating match listPhotos exactly", async () => {
		curate();
		const cases = [
			{
				filters: { camera: "Sony A7III", minRating: 4, tag: "beach" },
				count: 2,
				cover: ids[1],
			},
			{
				filters: {
					camera: "Sony A7III",
					minRating: 4,
					tag: "beach",
					filterRaw: "standard" as const,
				},
				count: 1,
				cover: ids[0],
			},
			{
				filters: { tag: "beach", minRating: 5, dateMonth: "2024:07" },
				count: 1,
				cover: ids[2],
			},
			{ filters: { minRating: 5, folder: "folder2" }, count: 2, cover: ids[4] },
			{ filters: { tag: "sunset", minRating: 5 }, count: 1, cover: ids[1] },
			{
				filters: { tag: "beach", minRating: 3, iso: 50 },
				count: 0,
				cover: null,
			},
		];
		for (const [index, { filters, count, cover }] of cases.entries()) {
			const album = createSmartAlbum(db, { name: `Case ${index}`, filters });
			expect(album.photoCount).toBe(count);
			expect(album.cover?.photoId ?? null).toBe(cover);
			// Opening the album on tRPC lists photos with its emitted filters.
			const listed = await listPhotos(db, album.filters);
			expect(listed.total).toBe(count);
		}
		const [first] = listSmartAlbums(db);
		expect(first.cover).toEqual({
			photoId: ids[1],
			thumbnailUpdatedAt: new Date("2025-05-05T05:05:05.000Z"),
		});
		const v1 = await send("GET", "/smart-albums");
		expect(smartAlbumsResponseSchema.parse(v1.body).albums[0].cover).toEqual({
			photoId: ids[1],
			thumbnailUpdatedAt: "2025-05-05T05:05:05.000Z",
		});
	});

	test("query albums report null count and cover; counts follow live library changes", async () => {
		const query = createSmartAlbum(db, {
			name: "Dogs",
			filters: { minRating: 1 },
			query: "dog",
		});
		expect(query).toMatchObject({ photoCount: null, cover: null });
		const live = createSmartAlbum(db, {
			name: "Five stars",
			filters: { minRating: 5 },
		});
		expect(live).toMatchObject({ photoCount: 0, cover: null });
		curate();
		expect(listSmartAlbums(db).map((a) => [a.name, a.photoCount])).toEqual([
			["Dogs", null],
			["Five stars", 3],
		]);
		const v1 = await send("GET", "/smart-albums");
		expect(smartAlbumsResponseSchema.parse(v1.body).albums[0]).toMatchObject({
			photoCount: null,
			cover: null,
		});
	});
});

describe("update and delete", () => {
	test("query: null on a filter-less album is rejected and leaves it unchanged", async () => {
		const album = createSmartAlbum(db, {
			name: "Only query",
			filters: {},
			query: "mountains",
		});
		const before = storedRows();
		expect(
			domainError(() => updateSmartAlbum(db, album.id, { query: null })),
		).toBe("EMPTY");
		expect(
			domainError(() =>
				updateSmartAlbum(db, album.id, {
					filters: { folder: "" },
					query: null,
				}),
			),
		).toBe("EMPTY");
		expect(
			await trpcErrorCode(
				caller.updateSmartAlbum({ id: album.id, query: null }),
			),
		).toBe("BAD_REQUEST");
		expect(
			await send("PATCH", `/smart-albums/${album.id}`, { query: null }),
		).toEqual({ status: 400, body: INVALID_REQUEST });
		expect(storedRows()).toEqual(before);

		// Adding a filter while clearing the query turns it into a counted album.
		const updated = updateSmartAlbum(db, album.id, {
			filters: { folder: "folder1" },
			query: null,
		});
		expect(updated).toMatchObject({
			filters: { folder: "folder1" },
			query: null,
			photoCount: 3,
			cover: { photoId: ids[3] },
		});
		// Replacing filters keeps the omitted name and query.
		const replaced = updateSmartAlbum(db, album.id, {
			filters: { filterRaw: "raw" },
		});
		expect(replaced).toMatchObject({
			name: "Only query",
			filters: { filterRaw: "raw" },
			photoCount: 1,
		});
	});

	test("delete removes only the album; unknown ids are NOT_FOUND on every transport", async () => {
		const album = createSmartAlbum(db, {
			name: "Gone",
			filters: { lens: "x" },
		});
		const photosBefore = db.select().from(photos).all();
		expect(await caller.deleteSmartAlbum({ id: album.id })).toEqual({
			id: album.id,
		});
		expect(db.select().from(photos).all()).toEqual(photosBefore);
		expect(domainError(() => deleteSmartAlbum(db, album.id))).toBe("NOT_FOUND");
		expect(await trpcErrorCode(caller.deleteSmartAlbum({ id: album.id }))).toBe(
			"NOT_FOUND",
		);
		expect(
			await trpcErrorCode(caller.updateSmartAlbum({ id: album.id, name: "Y" })),
		).toBe("NOT_FOUND");
		expect(await send("DELETE", `/smart-albums/${album.id}`)).toEqual({
			status: 404,
			body: SMART_ALBUM_NOT_FOUND,
		});
		expect(
			await send("PATCH", `/smart-albums/${album.id}`, { name: "Y" }),
		).toEqual({ status: 404, body: SMART_ALBUM_NOT_FOUND });

		const kept = createSmartAlbum(db, { name: "Kept", filters: { iso: 100 } });
		expect(await send("DELETE", `/smart-albums/${kept.id}`)).toEqual({
			status: 204,
			body: null,
		});
		expect(storedRows()).toEqual([]);
	});
});

describe("transport contracts", () => {
	test("tRPC maps name conflicts to CONFLICT and invalid input to BAD_REQUEST", async () => {
		const created = await caller.createSmartAlbum({
			name: "Picks",
			filters: { flag: "pick" },
		});
		expect(await caller.smartAlbums()).toEqual({ albums: [created] });
		expect(
			await trpcErrorCode(
				caller.createSmartAlbum({ name: "PICKS", filters: { flag: "reject" } }),
			),
		).toBe("CONFLICT");
		const other = await caller.createSmartAlbum({
			name: "Rejects",
			filters: { flag: "reject" },
		});
		expect(
			await trpcErrorCode(
				caller.updateSmartAlbum({ id: other.id, name: "picks" }),
			),
		).toBe("CONFLICT");
		for (const input of [
			{ name: "Empty", filters: {} },
			{ name: " ", filters: { flag: "pick" as const } },
			{ name: "n".repeat(101), filters: { flag: "pick" as const } },
			{ name: "Q", filters: {}, query: "q".repeat(201) },
			{ name: "Bad month", filters: { dateMonth: "2024/06" } },
			{ name: "Bad tag", filters: { tag: "Not A Slug" } },
			{ name: "Rating", filters: { minRating: 6 } },
		]) {
			expect(await trpcErrorCode(caller.createSmartAlbum(input))).toBe(
				"BAD_REQUEST",
			);
		}
		expect(
			await trpcErrorCode(
				caller.createSmartAlbum({
					name: "Scoped",
					// collectionId is not a smart album filter.
					filters: { collectionId: 1 } as never,
				}),
			),
		).toBe("BAD_REQUEST");
		expect((await caller.smartAlbums()).albums).toHaveLength(2);
	});

	test("v1 emits ISO DTOs and stable error envelopes", async () => {
		const created = await send("POST", "/smart-albums", {
			name: " Sony ",
			filters: { camera: "Sony A7III", filterRaw: "all" },
		});
		expect(created.status).toBe(201);
		// `.strict()` rejects any extra key, so the key list below is exhaustive.
		const body = smartAlbumSchema.strict().parse(created.body);
		expect(Object.keys(body).sort()).toEqual([
			"cover",
			"createdAt",
			"filters",
			"id",
			"name",
			"photoCount",
			"query",
			"updatedAt",
		]);
		expect(body).toMatchObject({
			name: "Sony",
			filters: { camera: "Sony A7III" },
			query: null,
			photoCount: 2,
			cover: { photoId: ids[1], thumbnailUpdatedAt: null },
		});
		expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

		expect(
			await send("POST", "/smart-albums", {
				name: "sony",
				filters: { minRating: 1 },
			}),
		).toEqual({ status: 409, body: SMART_ALBUM_NAME_TAKEN });
		const second = await send("POST", "/smart-albums", {
			name: "Second",
			filters: {},
			query: "cat",
		});
		expect(second.body).toMatchObject({ photoCount: null, cover: null });
		const secondId = smartAlbumSchema.parse(second.body).id;
		expect(
			await send("PATCH", `/smart-albums/${secondId}`, { name: "SONY" }),
		).toEqual({ status: 409, body: SMART_ALBUM_NAME_TAKEN });

		for (const invalid of [
			{ name: "Empty", filters: {} },
			{ name: "Empty", filters: { filterRaw: "all", folder: "" }, query: null },
			{ name: "Extra", filters: { flag: "pick" }, extra: 1 },
			{ name: "Scoped", filters: { collectionId: 1 } },
			{ name: "Iso", filters: { iso: "100" } },
			{ name: "Month", filters: { dateMonth: "2024-13" } },
			{ filters: { flag: "pick" } },
		]) {
			expect(await send("POST", "/smart-albums", invalid)).toEqual({
				status: 400,
				body: INVALID_REQUEST,
			});
		}
		expect(await send("PATCH", "/smart-albums/abc", { name: "X" })).toEqual({
			status: 400,
			body: INVALID_REQUEST,
		});
		expect(await send("DELETE", "/smart-albums/0")).toEqual({
			status: 400,
			body: INVALID_REQUEST,
		});

		const patched = await send("PATCH", `/smart-albums/${secondId}`, {
			filters: { dateMonth: "2024:06" },
			query: null,
		});
		expect(patched).toMatchObject({
			status: 200,
			body: {
				name: "Second",
				filters: { dateMonth: "2024-06" },
				query: null,
				photoCount: 2,
			},
		});
	});

	test("checked-in OpenAPI document matches the smart album schemas", async () => {
		const openApiSchema = z.object({
			required: z.array(z.string()).optional(),
			properties: z.record(z.unknown()).default({}),
		});
		const document = z
			.object({
				paths: z.record(
					z.record(z.object({ responses: z.record(z.unknown()) })),
				),
				components: z.object({ schemas: z.record(openApiSchema) }),
			})
			.parse(
				await Bun.file(
					new URL("../routes/openapi-v1.json", import.meta.url),
				).json(),
			);
		const statuses = (path: string, method: string) =>
			Object.keys(document.paths[path]?.[method]?.responses ?? {}).sort();
		expect(statuses("/api/v1/smart-albums", "get")).toEqual(["200", "500"]);
		expect(statuses("/api/v1/smart-albums", "post")).toEqual([
			"201",
			"400",
			"409",
			"500",
		]);
		expect(statuses("/api/v1/smart-albums/{id}", "patch")).toEqual([
			"200",
			"400",
			"404",
			"409",
			"500",
		]);
		expect(statuses("/api/v1/smart-albums/{id}", "delete")).toEqual([
			"204",
			"400",
			"404",
			"500",
		]);
		const { schemas } = document.components;
		expect(schemas.SmartAlbum.required?.sort()).toEqual(
			Object.keys(smartAlbumSchema.shape).sort(),
		);
		expect(Object.keys(schemas.SmartAlbumFilters.properties).sort()).toEqual(
			Object.keys(smartAlbumSchema.shape.filters.shape).sort(),
		);
		expect(
			Object.keys(schemas.SmartAlbumFiltersInput.properties).sort(),
		).toEqual(Object.keys(smartAlbumFiltersRequestSchema.shape).sort());
		expect(
			Object.keys(schemas.CreateSmartAlbumRequest.properties).sort(),
		).toEqual(Object.keys(createSmartAlbumRequestSchema.shape).sort());
		expect(
			Object.keys(schemas.UpdateSmartAlbumRequest.properties).sort(),
		).toEqual(Object.keys(updateSmartAlbumRequestSchema.shape).sort());
	});
});

describe("migration 0011", () => {
	test("only creates the table and its NOCASE unique index", () => {
		const migration = readFileSync(
			join(MIGRATIONS_FOLDER, "0011_smart_albums.sql"),
			"utf8",
		);
		expect(migration).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO/i);
		expect(migration).toMatch(/CREATE TABLE `smart_albums`/);
		expect(migration).toMatch(
			/CREATE UNIQUE INDEX `smart_albums_name_nocase_unique` ON `smart_albums` \("name" COLLATE NOCASE\)/,
		);
	});
});
