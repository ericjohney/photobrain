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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import { collectionPhotos, collections, photoExif, photos } from "../db/schema";
import {
	addPhotosToCollection,
	type Collection,
	CollectionError,
	collectionsForPhoto,
	createCollection,
	deleteCollection,
	listCollections,
	MAX_COLLECTION_PHOTO_IDS,
	removePhotosFromCollection,
	renameCollection,
} from "../services/collections";
import { type ApiDatabase, listPhotos } from "../services/photo-catalog";
import { createTestDb, seedTestData } from "./setup";

const PERF_LOG_PREFIX = "[collections-perf]";
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
const COLLECTION_NOT_FOUND = {
	error: { code: "COLLECTION_NOT_FOUND", message: "Collection not found" },
};
const NAME_TAKEN = {
	error: {
		code: "COLLECTION_NAME_TAKEN",
		message: "A collection with that name already exists",
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
	app = new Hono();
	app.route(
		"/api/v1",
		createV1Router({
			database: db,
			searchPhotos: async () => [],
			dispatchScan: async () => undefined,
			photoDirectory: "../../test-photos",
			thumbnailsDirectory: "./test-thumbnails",
			// Collections must not depend on the native scan mutation flag.
			nativeScanMutationsEnabled: false,
		}),
	);
});
afterEach(() => sqlite.close());

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

function domainError(run: () => unknown) {
	try {
		run();
	} catch (error) {
		if (error instanceof CollectionError) return error.code;
		throw error;
	}
	throw new Error("Expected a CollectionError");
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

async function responseJson(response: Response) {
	return JSON.parse(await response.text()) as unknown;
}

function send(method: string, path: string, body?: unknown) {
	return app.request(`/api/v1${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body:
			body === undefined
				? undefined
				: typeof body === "string"
					? body
					: JSON.stringify(body),
	});
}

function membershipRows() {
	return db
		.select({
			collectionId: collectionPhotos.collectionId,
			photoId: collectionPhotos.photoId,
		})
		.from(collectionPhotos)
		.all();
}

describe("createCollection / renameCollection", () => {
	test("create trims the name and returns an empty collection DTO", () => {
		const created = createCollection(db, "  Summer 2024  ");
		expect(created).toMatchObject({
			name: "Summer 2024",
			photoCount: 0,
			cover: null,
		});
		expect(created.id).toBeGreaterThan(0);
		expect(created.createdAt).toBeInstanceOf(Date);
		expect(created.updatedAt.getTime()).toBe(created.createdAt.getTime());
		expect(listCollections(db)).toEqual([created]);
	});

	test("create with photoIds adds existing photos, ignoring duplicates and unknown ids", () => {
		const created = createCollection(db, "Picks", [
			ids[0],
			ids[2],
			ids[0],
			999_999,
		]);
		expect(created.photoCount).toBe(2);
		// The last listed existing photo is the most recently added.
		expect(created.cover?.photoId).toBe(ids[2]);
	});

	test("enforces 1-100 characters after trimming", () => {
		expect(createCollection(db, "x".repeat(100)).name).toHaveLength(100);
		expect(createCollection(db, ` ${"y".repeat(100)} `).name).toHaveLength(100);
		for (const name of ["", "   ", "z".repeat(101)]) {
			expect(() => createCollection(db, name)).toThrow(RangeError);
		}
		expect(listCollections(db)).toHaveLength(2);
	});

	test("names are unique case-insensitively", () => {
		createCollection(db, "Travel");
		for (const name of ["Travel", "travel", " TRAVEL "]) {
			expect(domainError(() => createCollection(db, name))).toBe("NAME_TAKEN");
		}
		expect(listCollections(db).map((c) => c.name)).toEqual(["Travel"]);
		// A failed create with photos leaves no partial membership behind.
		expect(domainError(() => createCollection(db, "travel", [ids[0]]))).toBe(
			"NAME_TAKEN",
		);
		expect(membershipRows()).toEqual([]);
	});

	test("rename to its own name with different case is allowed; to another's name is not", () => {
		const travel = createCollection(db, "Travel");
		const family = createCollection(db, "Family");
		const renamed = renameCollection(db, travel.id, "  TRAVEL ");
		expect(renamed).toMatchObject({ id: travel.id, name: "TRAVEL" });
		expect(domainError(() => renameCollection(db, travel.id, "family"))).toBe(
			"NAME_TAKEN",
		);
		expect(domainError(() => renameCollection(db, family.id, "travel"))).toBe(
			"NAME_TAKEN",
		);
		expect(listCollections(db).map((c) => c.name)).toEqual([
			"Family",
			"TRAVEL",
		]);
		expect(domainError(() => renameCollection(db, 999_999, "Other"))).toBe(
			"NOT_FOUND",
		);
		expect(() => renameCollection(db, travel.id, " ")).toThrow(RangeError);
	});
});

describe("membership", () => {
	test("addPhotos ignores duplicates and unknown ids and reports counts", () => {
		const { id } = createCollection(db, "Album");
		expect(
			addPhotosToCollection(db, id, [ids[0], ids[1], ids[1], 999_999]),
		).toEqual({ added: 2, photoCount: 2 });
		expect(addPhotosToCollection(db, id, [ids[1], ids[2]])).toEqual({
			added: 1,
			photoCount: 3,
		});
		expect(addPhotosToCollection(db, id, [ids[0], 999_998])).toEqual({
			added: 0,
			photoCount: 3,
		});
		expect(
			membershipRows()
				.map((row) => row.photoId)
				.sort((a, b) => a - b),
		).toEqual([ids[0], ids[1], ids[2]]);
	});

	test("removePhotos reports counts and ignores non-members", () => {
		const { id } = createCollection(db, "Album", [ids[0], ids[1], ids[2]]);
		expect(removePhotosFromCollection(db, id, [ids[1], ids[3], 999])).toEqual({
			removed: 1,
			photoCount: 2,
		});
		expect(removePhotosFromCollection(db, id, [ids[1]])).toEqual({
			removed: 0,
			photoCount: 2,
		});
		expect(removePhotosFromCollection(db, id, [ids[0], ids[2]])).toEqual({
			removed: 2,
			photoCount: 0,
		});
	});

	test("membership changes bump updatedAt only when something changed", () => {
		const { id } = createCollection(db, "Album");
		db.update(collections)
			.set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
			.where(eq(collections.id, id))
			.run();
		addPhotosToCollection(db, id, [999_999]);
		expect(listCollections(db)[0].updatedAt.toISOString()).toBe(
			"2020-01-01T00:00:00.000Z",
		);
		addPhotosToCollection(db, id, [ids[0]]);
		const afterAdd = listCollections(db)[0].updatedAt;
		expect(afterAdd.getFullYear()).toBeGreaterThan(2020);

		db.update(collections)
			.set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
			.where(eq(collections.id, id))
			.run();
		removePhotosFromCollection(db, id, [ids[4]]);
		expect(listCollections(db)[0].updatedAt.toISOString()).toBe(
			"2020-01-01T00:00:00.000Z",
		);
		removePhotosFromCollection(db, id, [ids[0]]);
		expect(listCollections(db)[0].updatedAt.getFullYear()).toBeGreaterThan(
			2020,
		);
	});

	test("unknown collections and id bounds are rejected without writes", () => {
		expect(domainError(() => addPhotosToCollection(db, 999, [ids[0]]))).toBe(
			"NOT_FOUND",
		);
		expect(
			domainError(() => removePhotosFromCollection(db, 999, [ids[0]])),
		).toBe("NOT_FOUND");
		expect(domainError(() => deleteCollection(db, 999))).toBe("NOT_FOUND");
		const { id } = createCollection(db, "Album");
		const tooMany = Array.from(
			{ length: MAX_COLLECTION_PHOTO_IDS + 1 },
			(_, index) => index + 1,
		);
		expect(() => addPhotosToCollection(db, id, [])).toThrow(RangeError);
		expect(() => addPhotosToCollection(db, id, tooMany)).toThrow(RangeError);
		expect(() => removePhotosFromCollection(db, id, [])).toThrow(RangeError);
		expect(() => createCollection(db, "Big", tooMany)).toThrow(RangeError);
		expect(membershipRows()).toEqual([]);
	});

	test("cover is the most recently added photo, falls back on removal, and is null when empty", () => {
		db.update(photos)
			.set({ thumbnailUpdatedAt: new Date("2025-05-05T05:05:05.000Z") })
			.where(eq(photos.id, ids[1]))
			.run();
		const { id } = createCollection(db, "Album");
		// Distinct seconds for the first two; same-second additions break ties by insertion order.
		db.insert(collectionPhotos)
			.values([
				{
					collectionId: id,
					photoId: ids[0],
					addedAt: new Date("2025-01-01T00:00:00.000Z"),
				},
				{
					collectionId: id,
					photoId: ids[1],
					addedAt: new Date("2025-01-02T00:00:00.000Z"),
				},
			])
			.run();
		const cover = () => listCollections(db)[0].cover;
		expect(cover()).toEqual({
			photoId: ids[1],
			thumbnailUpdatedAt: new Date("2025-05-05T05:05:05.000Z"),
		});

		addPhotosToCollection(db, id, [ids[2]]);
		expect(cover()).toEqual({ photoId: ids[2], thumbnailUpdatedAt: null });
		addPhotosToCollection(db, id, [ids[3]]);
		expect(cover()?.photoId).toBe(ids[3]);

		removePhotosFromCollection(db, id, [ids[3]]);
		expect(cover()?.photoId).toBe(ids[2]);
		removePhotosFromCollection(db, id, [ids[2]]);
		expect(cover()?.photoId).toBe(ids[1]);
		removePhotosFromCollection(db, id, [ids[1]]);
		expect(cover()?.photoId).toBe(ids[0]);
		removePhotosFromCollection(db, id, [ids[0]]);
		expect(listCollections(db)[0]).toMatchObject({
			photoCount: 0,
			cover: null,
		});
	});

	test("collectionsForPhoto lists containing collections and null for unknown photos", () => {
		const a = createCollection(db, "A", [ids[0], ids[1]]);
		const b = createCollection(db, "B", [ids[0]]);
		createCollection(db, "C", [ids[2]]);
		expect(collectionsForPhoto(db, ids[0])).toEqual({
			collectionIds: [a.id, b.id],
		});
		expect(collectionsForPhoto(db, ids[1])).toEqual({ collectionIds: [a.id] });
		expect(collectionsForPhoto(db, ids[4])).toEqual({ collectionIds: [] });
		expect(collectionsForPhoto(db, 999_999)).toBeNull();
	});
});

describe("listCollections", () => {
	test("uses a single SQL statement and sorts case-insensitively", async () => {
		for (const [index, name] of [
			"beta",
			"Alpha",
			"gamma",
			"Delta",
			"alpha2",
		].entries()) {
			createCollection(db, name, [ids[index]]);
		}
		let result: Collection[] = [];
		const statements = await captureStatements(() => {
			result = listCollections(db);
		});
		expect(statements).toHaveLength(1);
		expect(result.map((collection) => collection.name)).toEqual([
			"Alpha",
			"alpha2",
			"beta",
			"Delta",
			"gamma",
		]);
		expect(result.map((collection) => collection.photoCount)).toEqual([
			1, 1, 1, 1, 1,
		]);
		expect(listCollections(db)).toEqual(result);
	});
});

describe("deletion", () => {
	test("deleting a collection removes memberships but never photos or EXIF", () => {
		const exifBefore = db.select().from(photoExif).all();
		const photosBefore = db.select().from(photos).all();
		const keep = createCollection(db, "Keep", [ids[0]]);
		const gone = createCollection(db, "Gone", [ids[0], ids[1], ids[2]]);
		deleteCollection(db, gone.id);
		expect(listCollections(db).map((c) => c.id)).toEqual([keep.id]);
		expect(membershipRows()).toEqual([
			{ collectionId: keep.id, photoId: ids[0] },
		]);
		expect(db.select().from(photos).all()).toEqual(photosBefore);
		expect(db.select().from(photoExif).all()).toEqual(exifBefore);
		expect(domainError(() => deleteCollection(db, gone.id))).toBe("NOT_FOUND");
		// The name is free again.
		expect(createCollection(db, "gone").name).toBe("gone");
	});

	test("deleting a collection cascades membership through the foreign key", () => {
		sqlite.run("PRAGMA foreign_keys = ON");
		const gone = createCollection(db, "Gone", [ids[0], ids[1]]);
		sqlite.run(`DELETE FROM collections WHERE id = ${gone.id}`);
		expect(membershipRows()).toEqual([]);
		expect(db.select().from(photos).all()).toHaveLength(ids.length);
	});

	test("deleting a photo row cascades it out of collections", () => {
		sqlite.run("PRAGMA foreign_keys = ON");
		const album = createCollection(db, "Album", [ids[0], ids[1]]);
		db.delete(photos).where(eq(photos.id, ids[1])).run();
		expect(membershipRows()).toEqual([
			{ collectionId: album.id, photoId: ids[0] },
		]);
		expect(listCollections(db)[0]).toMatchObject({
			photoCount: 1,
			cover: { photoId: ids[0] },
		});
	});

	test("memberships orphaned without foreign-key enforcement never count or cover", () => {
		const album = createCollection(db, "Album", [ids[0], ids[1]]);
		expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({
			foreign_keys: 0,
		});
		db.delete(photoExif).where(eq(photoExif.photoId, ids[1])).run();
		db.delete(photos).where(eq(photos.id, ids[1])).run();
		expect(listCollections(db)[0]).toMatchObject({
			photoCount: 1,
			cover: { photoId: ids[0] },
		});
		expect(addPhotosToCollection(db, album.id, [ids[2]]).photoCount).toBe(2);
	});
});

describe("collectionId filter on listPhotos", () => {
	test("returns only members across tRPC and v1, combined with other filters", async () => {
		const album = createCollection(db, "Album", [ids[0], ids[1], ids[2]]);
		const empty = createCollection(db, "Empty");
		const result = await listPhotos(db, { collectionId: album.id });
		expect(result.photos.map((photo) => photo.id).sort()).toEqual(
			[ids[0], ids[1], ids[2]].sort(),
		);
		expect(result).toMatchObject({ total: 3, rawCount: 1 });

		const viaTrpc = await caller.photos({
			collectionId: album.id,
			filterRaw: "standard",
		});
		expect(viaTrpc.photos.map((photo) => photo.id).sort()).toEqual(
			[ids[0], ids[2]].sort(),
		);
		expect((await caller.photos({ collectionId: empty.id })).total).toBe(0);
		expect(await trpcErrorCode(caller.photos({ collectionId: 0 }))).toBe(
			"BAD_REQUEST",
		);

		const response = await app.request(
			`/api/v1/photos?collectionId=${album.id}&folder=folder1`,
		);
		expect(response.status).toBe(200);
		const body = (await responseJson(response)) as {
			photos: Array<Record<string, unknown>>;
			total: number;
		};
		expect(body.photos.map((photo) => photo.id).sort()).toEqual(
			[ids[0], ids[1]].sort(),
		);
		for (const photo of body.photos) {
			for (const key of PRIVATE_FIELDS) expect(photo).not.toHaveProperty(key);
		}
		for (const value of ["0", "-1", "1.5", "abc"]) {
			const invalid = await app.request(`/api/v1/photos?collectionId=${value}`);
			expect(invalid.status).toBe(400);
			expect(await responseJson(invalid)).toEqual(INVALID_REQUEST);
		}
	});
});

describe("tRPC collection procedures", () => {
	test("CRUD and membership round-trip with CONFLICT / NOT_FOUND / BAD_REQUEST mapping", async () => {
		const created = await caller.createCollection({
			name: " Trip ",
			photoIds: [ids[0]],
		});
		expect(created).toMatchObject({
			name: "Trip",
			photoCount: 1,
			cover: { photoId: ids[0], thumbnailUpdatedAt: null },
		});
		expect(await caller.collections()).toEqual({ collections: [created] });
		expect(await trpcErrorCode(caller.createCollection({ name: "trip" }))).toBe(
			"CONFLICT",
		);
		expect(await trpcErrorCode(caller.createCollection({ name: "  " }))).toBe(
			"BAD_REQUEST",
		);
		expect(
			await trpcErrorCode(caller.createCollection({ name: "n".repeat(101) })),
		).toBe("BAD_REQUEST");

		const other = await caller.createCollection({ name: "Other" });
		expect(
			await trpcErrorCode(
				caller.renameCollection({ id: other.id, name: "TRIP" }),
			),
		).toBe("CONFLICT");
		expect(
			(await caller.renameCollection({ id: created.id, name: "TRIP" })).name,
		).toBe("TRIP");
		expect(
			await trpcErrorCode(caller.renameCollection({ id: 999, name: "X" })),
		).toBe("NOT_FOUND");

		expect(
			await caller.addToCollection({
				collectionId: created.id,
				photoIds: [ids[0], ids[1], 999_999],
			}),
		).toEqual({ added: 1, photoCount: 2 });
		expect(
			await caller.removeFromCollection({
				collectionId: created.id,
				photoIds: [ids[0]],
			}),
		).toEqual({ removed: 1, photoCount: 1 });
		expect(
			await trpcErrorCode(
				caller.addToCollection({ collectionId: 999, photoIds: [ids[0]] }),
			),
		).toBe("NOT_FOUND");
		expect(
			await trpcErrorCode(
				caller.addToCollection({ collectionId: created.id, photoIds: [] }),
			),
		).toBe("BAD_REQUEST");
		expect(
			await trpcErrorCode(
				caller.removeFromCollection({
					collectionId: created.id,
					photoIds: Array.from({ length: 501 }, (_, index) => index + 1),
				}),
			),
		).toBe("BAD_REQUEST");

		expect(await caller.collectionsForPhoto({ photoId: ids[1] })).toEqual({
			collectionIds: [created.id],
		});
		expect(
			await trpcErrorCode(caller.collectionsForPhoto({ photoId: 999_999 })),
		).toBe("NOT_FOUND");

		expect(await caller.deleteCollection({ id: created.id })).toEqual({
			id: created.id,
		});
		expect(
			await trpcErrorCode(caller.deleteCollection({ id: created.id })),
		).toBe("NOT_FOUND");
		expect((await caller.collections()).collections.map((c) => c.id)).toEqual([
			other.id,
		]);
	});
});

describe("/api/v1 collections", () => {
	type CollectionBody = {
		id: number;
		name: string;
		photoCount: number;
		cover: { photoId: number; thumbnailUpdatedAt: string | null } | null;
		createdAt: string;
		updatedAt: string;
	};

	async function createViaV1(body: unknown) {
		const response = await send("POST", "/collections", body);
		return {
			status: response.status,
			body: (await responseJson(response)) as CollectionBody,
		};
	}

	test("GET /collections lists ISO-serialized DTOs sorted by name", async () => {
		const empty = await app.request("/api/v1/collections");
		expect(empty.status).toBe(200);
		expect(await responseJson(empty)).toEqual({ collections: [] });

		db.update(photos)
			.set({ thumbnailUpdatedAt: new Date("2025-05-05T05:05:05.000Z") })
			.where(eq(photos.id, ids[0]))
			.run();
		createCollection(db, "zebra");
		createCollection(db, "Apple", [ids[0]]);
		const response = await app.request("/api/v1/collections");
		expect(response.status).toBe(200);
		const body = (await responseJson(response)) as {
			collections: CollectionBody[];
		};
		expect(body.collections.map((c) => c.name)).toEqual(["Apple", "zebra"]);
		expect(body.collections[0]).toMatchObject({
			photoCount: 1,
			cover: {
				photoId: ids[0],
				thumbnailUpdatedAt: "2025-05-05T05:05:05.000Z",
			},
		});
		expect(Object.keys(body.collections[0]).sort()).toEqual([
			"cover",
			"createdAt",
			"id",
			"name",
			"photoCount",
			"updatedAt",
		]);
		expect(body.collections[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
		expect(body.collections[1].cover).toBeNull();
	});

	test("POST /collections returns 201, 409 for a taken name, and 400 for invalid bodies", async () => {
		const created = await createViaV1({
			name: "  Road trip ",
			photoIds: [ids[1], 999_999],
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			name: "Road trip",
			photoCount: 1,
			cover: { photoId: ids[1], thumbnailUpdatedAt: null },
		});

		const taken = await send("POST", "/collections", { name: "ROAD TRIP" });
		expect(taken.status).toBe(409);
		expect(await responseJson(taken)).toEqual(NAME_TAKEN);

		for (const body of [
			{},
			{ name: "" },
			{ name: "   " },
			{ name: "x".repeat(101) },
			{ name: 7 },
			{ name: "Ok", extra: true },
			{ name: "Ok", photoIds: [] },
			{ name: "Ok", photoIds: [0] },
			{ name: "Ok", photoIds: ["1"] },
			{
				name: "Ok",
				photoIds: Array.from({ length: 501 }, (_, index) => index + 1),
			},
			"{not json",
			"",
		]) {
			const response = await send("POST", "/collections", body);
			expect(response.status).toBe(400);
			expect(await responseJson(response)).toEqual(INVALID_REQUEST);
		}
		expect(listCollections(db)).toHaveLength(1);
	});

	test("PATCH /collections/:id renames with 200/400/404/409", async () => {
		const { body: trip } = await createViaV1({ name: "Trip" });
		const { body: other } = await createViaV1({ name: "Other" });

		const sameCase = await send("PATCH", `/collections/${trip.id}`, {
			name: "TRIP",
		});
		expect(sameCase.status).toBe(200);
		expect(await responseJson(sameCase)).toMatchObject({
			id: trip.id,
			name: "TRIP",
		});

		const conflict = await send("PATCH", `/collections/${other.id}`, {
			name: " trip ",
		});
		expect(conflict.status).toBe(409);
		expect(await responseJson(conflict)).toEqual(NAME_TAKEN);

		const missing = await send("PATCH", "/collections/999999", {
			name: "New",
		});
		expect(missing.status).toBe(404);
		expect(await responseJson(missing)).toEqual(COLLECTION_NOT_FOUND);

		for (const [path, body] of [
			[`/collections/${trip.id}`, { name: "" }],
			[`/collections/${trip.id}`, { name: "New", photoIds: [1] }],
			[`/collections/${trip.id}`, {}],
			[`/collections/${trip.id}`, "{"],
			["/collections/0", { name: "New" }],
			["/collections/abc", { name: "New" }],
		] as const) {
			const response = await send("PATCH", path, body);
			expect(response.status).toBe(400);
			expect(await responseJson(response)).toEqual(INVALID_REQUEST);
		}
	});

	test("DELETE /collections/:id returns 204 then 404 and keeps photos", async () => {
		const { body } = await createViaV1({ name: "Gone", photoIds: [ids[0]] });
		const deleted = await send("DELETE", `/collections/${body.id}`);
		expect(deleted.status).toBe(204);
		expect(await deleted.text()).toBe("");
		expect(membershipRows()).toEqual([]);
		expect(db.select().from(photos).all()).toHaveLength(ids.length);

		const again = await send("DELETE", `/collections/${body.id}`);
		expect(again.status).toBe(404);
		expect(await responseJson(again)).toEqual(COLLECTION_NOT_FOUND);
		const invalid = await send("DELETE", "/collections/-1");
		expect(invalid.status).toBe(400);
		expect(await responseJson(invalid)).toEqual(INVALID_REQUEST);
	});

	test("POST /collections/:id/photos and /photos/remove report counts with 200/400/404", async () => {
		const { body } = await createViaV1({ name: "Album" });
		const added = await send("POST", `/collections/${body.id}/photos`, {
			photoIds: [ids[0], ids[1], ids[1], 999_999],
		});
		expect(added.status).toBe(200);
		expect(await responseJson(added)).toEqual({ added: 2, photoCount: 2 });

		const removed = await send(
			"POST",
			`/collections/${body.id}/photos/remove`,
			{ photoIds: [ids[1], ids[3]] },
		);
		expect(removed.status).toBe(200);
		expect(await responseJson(removed)).toEqual({ removed: 1, photoCount: 1 });

		for (const path of [
			"/collections/999999/photos",
			"/collections/999999/photos/remove",
		]) {
			const missing = await send("POST", path, { photoIds: [ids[0]] });
			expect(missing.status).toBe(404);
			expect(await responseJson(missing)).toEqual(COLLECTION_NOT_FOUND);
		}
		for (const suffix of ["photos", "photos/remove"]) {
			for (const [path, payload] of [
				[`/collections/${body.id}/${suffix}`, { photoIds: [] }],
				[`/collections/${body.id}/${suffix}`, { photoIds: [1.5] }],
				[`/collections/${body.id}/${suffix}`, { photoIds: [1], name: "x" }],
				[`/collections/${body.id}/${suffix}`, {}],
				[`/collections/${body.id}/${suffix}`, "nope"],
				[`/collections/0/${suffix}`, { photoIds: [1] }],
			] as const) {
				const response = await send("POST", path, payload);
				expect(response.status).toBe(400);
				expect(await responseJson(response)).toEqual(INVALID_REQUEST);
			}
		}
		expect(listCollections(db)[0].photoCount).toBe(1);
	});

	test("GET /photos/:id/collections returns membership, 404 for unknown photos, 400 for bad ids", async () => {
		const a = createCollection(db, "A", [ids[2]]);
		const b = createCollection(db, "B", [ids[2]]);
		const response = await app.request(`/api/v1/photos/${ids[2]}/collections`);
		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			collectionIds: [a.id, b.id],
		});
		const none = await app.request(`/api/v1/photos/${ids[0]}/collections`);
		expect(await responseJson(none)).toEqual({ collectionIds: [] });

		const missing = await app.request("/api/v1/photos/999999/collections");
		expect(missing.status).toBe(404);
		expect(await responseJson(missing)).toEqual({
			error: { code: "PHOTO_NOT_FOUND", message: "Photo not found" },
		});
		const invalid = await app.request("/api/v1/photos/abc/collections");
		expect(invalid.status).toBe(400);
		expect(await responseJson(invalid)).toEqual(INVALID_REQUEST);

		// Photo detail stays routed separately.
		const detail = await app.request(`/api/v1/photos/${ids[2]}`);
		expect(await responseJson(detail)).toMatchObject({ id: ids[2] });
	});

	test("OpenAPI documents every collection route's status codes and schemas", async () => {
		type Operation = {
			parameters?: Array<{ name: string; schema: Record<string, unknown> }>;
			responses: Record<string, unknown>;
		};
		const document = (await Bun.file(
			new URL("../routes/openapi-v1.json", import.meta.url),
		).json()) as {
			paths: Record<string, Record<string, Operation>>;
			components: {
				schemas: Record<
					string,
					{
						required?: string[];
						additionalProperties?: boolean;
						properties: Record<string, Record<string, unknown>>;
					}
				>;
				responses: Record<string, unknown>;
			};
		};
		const statuses = (path: string, method: string) =>
			Object.keys(document.paths[path][method].responses).sort();
		expect(statuses("/api/v1/collections", "get")).toEqual(["200", "500"]);
		expect(statuses("/api/v1/collections", "post")).toEqual([
			"201",
			"400",
			"409",
			"500",
		]);
		expect(statuses("/api/v1/collections/{id}", "patch")).toEqual([
			"200",
			"400",
			"404",
			"409",
			"500",
		]);
		expect(statuses("/api/v1/collections/{id}", "delete")).toEqual([
			"204",
			"400",
			"404",
			"500",
		]);
		for (const path of [
			"/api/v1/collections/{id}/photos",
			"/api/v1/collections/{id}/photos/remove",
		]) {
			expect(statuses(path, "post")).toEqual(["200", "400", "404", "500"]);
		}
		expect(statuses("/api/v1/photos/{id}/collections", "get")).toEqual([
			"200",
			"400",
			"404",
			"500",
		]);
		expect(document.components.responses).toHaveProperty("CollectionNotFound");
		expect(document.components.responses).toHaveProperty("CollectionNameTaken");

		const schemas = document.components.schemas;
		expect(schemas.Collection.required?.sort()).toEqual([
			"cover",
			"createdAt",
			"id",
			"name",
			"photoCount",
			"updatedAt",
		]);
		for (const name of [
			"Collection",
			"CollectionCover",
			"CreateCollectionRequest",
			"RenameCollectionRequest",
			"CollectionPhotosRequest",
			"AddCollectionPhotosResponse",
			"RemoveCollectionPhotosResponse",
			"PhotoCollectionsResponse",
			"CollectionsResponse",
		]) {
			expect(schemas[name].additionalProperties).toBe(false);
		}
		expect(schemas.CreateCollectionRequest.properties.name).toMatchObject({
			minLength: 1,
			maxLength: 100,
		});
		expect(schemas.CollectionPhotosRequest.properties.photoIds).toMatchObject({
			minItems: 1,
			maxItems: MAX_COLLECTION_PHOTO_IDS,
		});

		const queryParameter = (path: string) =>
			document.paths[path].get.parameters?.find(
				(parameter) => parameter.name === "collectionId",
			)?.schema;
		for (const filter of [
			queryParameter("/api/v1/photos"),
			queryParameter("/api/v1/photos/{id}/similar"),
			schemas.SearchRequest.properties.collectionId,
		]) {
			expect(filter).toMatchObject({ type: "integer", minimum: 1 });
		}
	});
});

describe("migration 0008", () => {
	test("applies on a database migrated to 0007 with rows and leaves photos/EXIF/embeddings intact", () => {
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
			const collectionsIndex = journal.entries.findIndex((entry) =>
				entry.tag.startsWith("0008_"),
			);
			expect(collectionsIndex).toBeGreaterThan(0);
			expect(journal.entries[collectionsIndex - 1].tag).toStartWith("0007_");
			writeFileSync(
				journalPath,
				JSON.stringify({
					...journal,
					entries: journal.entries.slice(0, collectionsIndex),
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
			expect(tables()).not.toContain("collections");
			legacy.run(
				`INSERT INTO photos (id, path, name, size, created_at, modified_at, thumbnail_key, rating, flag)
				 VALUES (7, 'a/one.jpg', 'one.jpg', 1, 0, 0, 'key-one', 4, 'pick'),
				        (9, 'a/two.jpg', 'two.jpg', 2, 0, 0, 'key-two', 0, NULL)`,
			);
			legacy.run(
				"INSERT INTO photo_exif (photo_id, camera_make) VALUES (7, 'Sony')",
			);
			legacy.run(
				`INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at)
				 VALUES (9, X'0000803F', 'clip-vit-b32', 'key-two', 0)`,
			);
			legacy.run(
				"INSERT INTO photo_phash (photo_id, hash, created_at) VALUES (7, 'hash', 0)",
			);
			const snapshot = () => ({
				photos: legacy.query("SELECT * FROM photos ORDER BY id").all(),
				exif: legacy.query("SELECT * FROM photo_exif").all(),
				embeddings: legacy.query("SELECT * FROM photo_embedding").all(),
				phash: legacy.query("SELECT * FROM photo_phash").all(),
			});
			const before = snapshot();

			// Stop at 0008 so later migrations' additive columns stay out of scope.
			writeFileSync(
				journalPath,
				JSON.stringify({
					...journal,
					entries: journal.entries.slice(0, collectionsIndex + 1),
				}),
			);
			migrate(legacyDb, { migrationsFolder: partial });

			expect(snapshot()).toEqual(before);
			expect(tables()).toEqual(
				expect.arrayContaining(["collections", "collection_photos"]),
			);
			expect(
				legacy
					.query<{ name: string }, []>(
						"SELECT name FROM pragma_index_list('collection_photos')",
					)
					.all()
					.map((row) => row.name),
			).toContain("idx_collection_photos_photo_id");
			expect(
				legacy
					.query<{ table: string; on_delete: string }, []>(
						'SELECT "table", on_delete FROM pragma_foreign_key_list(\'collection_photos\') ORDER BY "table"',
					)
					.all(),
			).toEqual([
				{ table: "collections", on_delete: "CASCADE" },
				{ table: "photos", on_delete: "CASCADE" },
			]);

			legacy.run(
				"INSERT INTO collections (id, name, created_at, updated_at) VALUES (1, 'Trip', 0, 0)",
			);
			expect(() =>
				legacy.run(
					"INSERT INTO collections (name, created_at, updated_at) VALUES ('TRIP', 0, 0)",
				),
			).toThrow(/UNIQUE constraint failed/);
			legacy.run(
				"INSERT INTO collection_photos (collection_id, photo_id, added_at) VALUES (1, 7, 0), (1, 9, 0)",
			);
			expect(() =>
				legacy.run(
					"INSERT INTO collection_photos (collection_id, photo_id, added_at) VALUES (1, 7, 1)",
				),
			).toThrow(/UNIQUE constraint failed/);
			legacy.run("PRAGMA foreign_keys = ON");
			legacy.run("DELETE FROM collections WHERE id = 1");
			expect(legacy.query("SELECT * FROM collection_photos").all()).toEqual([]);
			expect(snapshot()).toEqual(before);
			legacy.close();
		} finally {
			rmSync(partial, { recursive: true, force: true });
		}
	});
});

describe("collections performance over 8,000 photos", () => {
	const PHOTO_COUNT = 8_000;
	const COLLECTION_COUNT = 200;
	const PER_COLLECTION = 200;

	beforeEach(() => {
		db.delete(photoExif).run();
		db.delete(photos).run();
		const insertPhoto = sqlite.prepare(
			`INSERT INTO photos (path, name, size, created_at, modified_at)
			 VALUES (?, ?, 1, 0, 0)`,
		);
		sqlite.transaction(() => {
			for (let index = 0; index < PHOTO_COUNT; index++) {
				insertPhoto.run(`perf/${index}.jpg`, `${index}.jpg`);
			}
		})();
	});

	function allPhotoIds() {
		return db
			.select({ id: photos.id })
			.from(photos)
			.all()
			.map((row) => row.id);
	}

	test("listCollections with 200 collections and 40,000 memberships completes within 50 ms", async () => {
		const photoIds = allPhotoIds();
		const insertCollection = sqlite.prepare(
			"INSERT INTO collections (name, created_at, updated_at) VALUES (?, 0, 0) RETURNING id",
		);
		const insertMember = sqlite.prepare(
			"INSERT INTO collection_photos (collection_id, photo_id, added_at) VALUES (?, ?, ?)",
		);
		sqlite.transaction(() => {
			for (let c = 0; c < COLLECTION_COUNT; c++) {
				const { id } = insertCollection.get(`Collection ${c}`) as {
					id: number;
				};
				for (let m = 0; m < PER_COLLECTION; m++) {
					// Spread memberships across the library; members overlap between collections.
					const photoId = photoIds[(c * 37 + m * 40) % PHOTO_COUNT];
					insertMember.run(id, photoId, m);
				}
			}
		})();
		expect(
			sqlite.query("SELECT count(*) AS n FROM collection_photos").get(),
		).toEqual({ n: COLLECTION_COUNT * PER_COLLECTION });

		listCollections(db); // warm the statement cache
		let result: Collection[] = [];
		const statements = await captureStatements(() => {
			result = listCollections(db);
		});
		expect(statements).toHaveLength(1);
		const started = performance.now();
		result = listCollections(db);
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} listCollections ${COLLECTION_COUNT} collections / ${COLLECTION_COUNT * PER_COLLECTION} memberships over ${PHOTO_COUNT} photos: ${elapsed.toFixed(2)} ms`,
		);
		expect(result).toHaveLength(COLLECTION_COUNT);
		expect(result.every((c) => c.photoCount === PER_COLLECTION)).toBe(true);
		// The member with the largest added_at is each collection's cover.
		expect(result.find((c) => c.name === "Collection 0")?.cover?.photoId).toBe(
			photoIds[(PER_COLLECTION - 1) * 40],
		);
		expect(elapsed).toBeLessThan(50);
	});

	test("addPhotos with 500 ids completes within 50 ms", () => {
		const photoIds = allPhotoIds();
		const { id } = createCollection(db, "Big", photoIds.slice(0, 100));
		const target = photoIds
			.filter((_, index) => index % 16 === 0)
			.slice(0, 500);
		expect(target).toHaveLength(500);

		const started = performance.now();
		const result = addPhotosToCollection(db, id, target);
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} addPhotos 500 ids over ${PHOTO_COUNT} photos: ${elapsed.toFixed(2)} ms`,
		);
		// Seven of the targets (indexes 0, 16, ..., 96) were already members.
		expect(result).toEqual({ added: 493, photoCount: 593 });
		expect(elapsed).toBeLessThan(50);
	});

	test("collectionId-filtered listPhotos resolves through the membership primary key", async () => {
		const photoIds = allPhotoIds();
		const { id } = createCollection(db, "Scoped");
		for (let start = 0; start < 2_000; start += 500) {
			addPhotosToCollection(
				db,
				id,
				photoIds
					.filter((_, index) => index % 4 === 0)
					.slice(start, start + 500),
			);
		}
		const statements = await captureStatements(() =>
			listPhotos(db, { collectionId: id }),
		);
		const listing = statements.find((statement) =>
			/from "photos"/i.test(statement),
		);
		if (!listing) throw new Error("listPhotos statement not captured");
		// Unbound parameters are NULL; the plan does not depend on their values.
		const plan = sqlite
			.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${listing}`)
			.all()
			.map((row) => row.detail)
			.join("\n");
		expect(plan).toMatch(
			/SEARCH collection_photos USING (COVERING )?INDEX sqlite_autoindex_collection_photos_1 \(collection_id=\?\)/,
		);
		expect(plan).toMatch(
			/SEARCH photos USING INTEGER PRIMARY KEY \(rowid=\?\)/,
		);
		// `SCAN photos_exif` is Drizzle's one-row EXIF co-routine, not a photos scan.
		expect(plan).not.toMatch(/SCAN photos(\s|$)/m);

		const started = performance.now();
		const result = await listPhotos(db, { collectionId: id });
		const elapsed = performance.now() - started;
		console.log(
			`${PERF_LOG_PREFIX} listPhotos collectionId over ${PHOTO_COUNT} photos (${result.total} rows, incl. EXIF hydration): ${elapsed.toFixed(2)} ms\n${plan}`,
		);
		expect(result.total).toBe(2_000);
	});
});
