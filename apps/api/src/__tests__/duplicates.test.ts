import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import type { NearDuplicateGroup } from "@photobrain/image-processing";
import { TRPCError } from "@trpc/server";
import { Hono } from "hono";
import {
	BURST_MAX_GAP_SECONDS,
	DUPLICATE_MAX_DISTANCE,
} from "../services/duplicates";
import { QUALITY_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PRIVATE_FIELDS = [
	"sourceRoot",
	"sourceFingerprint",
	"mediaVersion",
	"thumbnailKey",
	"thumbnailRoot",
	"thumbnailFingerprint",
	"junkDismissed",
];

// Mocks of ../db, the native addon and the Inngest client are process-wide;
// run the suite in an isolated child like the junk-review suite.
if (process.env.PHOTOBRAIN_DUPLICATES_TEST_CHILD !== "1") {
	test("duplicates: grouping, bursts, keeper, resolve and contract", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_DUPLICATES_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`);
	}, 120_000);
} else {
	const { db, sqlite } = createTestDb();
	const grouperThresholds: number[] = [];

	/**
	 * Fixture grouper over test-chosen hexadecimal integer "hashes"; real base64
	 * decoding and the multi-index search are covered by `cargo test`. Same
	 * contract: transitive components of size >= 2, undecodable hashes skipped,
	 * ascending IDs, largest pairwise distance.
	 */
	function fixtureGrouper(
		ids: number[],
		hashes: string[],
		maxDistance: number,
	): NearDuplicateGroup[] {
		grouperThresholds.push(maxDistance);
		const entries = ids.flatMap((id, index) =>
			/^[0-9a-f]+$/.test(hashes[index])
				? [{ id, hash: BigInt(`0x${hashes[index]}`) }]
				: [],
		);
		const distance = (left: bigint, right: bigint) =>
			(left ^ right).toString(2).replaceAll("0", "").length;
		const parent = entries.map((_, index) => index);
		const find = (index: number): number => {
			if (parent[index] !== index) parent[index] = find(parent[index]);
			return parent[index];
		};
		for (let left = 0; left < entries.length; left++) {
			for (let right = left + 1; right < entries.length; right++) {
				if (distance(entries[left].hash, entries[right].hash) <= maxDistance) {
					parent[find(left)] = find(right);
				}
			}
		}
		const components = new Map<number, typeof entries>();
		entries.forEach((entry, index) => {
			const root = find(index);
			components.set(root, [...(components.get(root) ?? []), entry]);
		});
		return [...components.values()]
			.filter((members) => members.length >= 2)
			.map((members) => ({
				ids: members.map((member) => member.id).sort((a, b) => a - b),
				maxDistance: Math.max(
					...members.flatMap((left) =>
						members.map((right) => distance(left.hash, right.hash)),
					),
				),
			}));
	}

	mock.module("../db", () => ({ db }));
	mock.module("@photobrain/image-processing", () => ({
		groupNearDuplicates: fixtureGrouper,
		clipTextEmbedding: () => [1, 0],
	}));
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
	// Static imports would load the real addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
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

	afterAll(() => sqlite.close());
	beforeEach(() => {
		// The test connection does not enforce foreign keys; clear sidecars explicitly.
		for (const table of [
			"duplicate_dismissals",
			"photo_quality",
			"photo_phash",
			"photo_exif",
			"photos",
		]) {
			sqlite.run(`DELETE FROM ${table}`);
		}
		grouperThresholds.length = 0;
	});

	type PhotoOptions = {
		hash?: string | null;
		camera?: [string | null, string | null];
		dateTaken?: string;
		rating?: number;
		flag?: "pick" | "reject" | null;
		isRaw?: boolean;
		width?: number;
		height?: number;
		size?: number;
		sharpness?: number;
	};
	let photoCounter = 0;
	function addPhoto(options: PhotoOptions = {}): number {
		const key = `key-${++photoCounter}`;
		const { id } = sqlite
			.query<{ id: number }, (string | number | null)[]>(
				`INSERT INTO photos (path, name, size, created_at, modified_at, width, height, is_raw, rating, flag, thumbnail_key)
				 VALUES (?1, ?1, ?2, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
			)
			.get(
				`dups/${photoCounter}.jpg`,
				options.size ?? 1000,
				options.width ?? 100,
				options.height ?? 100,
				options.isRaw ? 1 : 0,
				options.rating ?? 0,
				options.flag ?? null,
				key,
			) as { id: number };
		const hash =
			options.hash === undefined
				? // Four bits of its own per photo: at least 4 bits from any fixture hash.
					(0xfn << BigInt(4 * photoCounter)).toString(16)
				: options.hash;
		if (hash !== null) {
			sqlite.run(
				"INSERT INTO photo_phash (photo_id, hash, created_at) VALUES (?, ?, 0)",
				[id, hash],
			);
		}
		if (options.camera || options.dateTaken) {
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
		if (options.sharpness !== undefined) {
			sqlite.run(
				"INSERT INTO photo_quality (photo_id, sharpness, brightness, thumbnail_key, quality_version) VALUES (?, ?, 100, ?, ?)",
				[id, options.sharpness, key, QUALITY_VERSION],
			);
		}
		return id;
	}

	/** Fixture hash `n`; distinct seeds are at least 16 bits apart. */
	const seed = (n: number) => (0xffn << BigInt(8 * n)).toString(16);
	/** Hash `distance` bits away from `base` (both hex). */
	const flip = (base: string, distance: number) =>
		(BigInt(`0x${base}`) ^ ((1n << BigInt(distance)) - 1n)).toString(16);

	const groupIds = async (kind?: "duplicate" | "burst") =>
		(await caller.duplicateGroups({ kind })).groups.map((group) =>
			group.photos.map((photo) => photo.id),
		);

	async function expectTrpcCode(
		promise: Promise<unknown>,
		code: TRPCError["code"],
	) {
		const error = await promise.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TRPCError);
		expect((error as TRPCError).code).toBe(code);
	}

	test("groups photos at the calibrated distance but not one bit beyond", async () => {
		const base = seed(1);
		const near = [
			addPhoto({ hash: base }),
			addPhoto({ hash: flip(base, DUPLICATE_MAX_DISTANCE) }),
		];
		const farBase = seed(2);
		addPhoto({ hash: farBase });
		addPhoto({ hash: flip(farBase, DUPLICATE_MAX_DISTANCE + 1) });
		addPhoto({ hash: "not-a-hash" });
		addPhoto({ hash: null });

		const { groups, counts } = await caller.duplicateGroups();
		expect(grouperThresholds).toEqual([DUPLICATE_MAX_DISTANCE]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({
			key: `duplicate:${near.join(",")}`,
			kind: "duplicate",
			maxDistance: DUPLICATE_MAX_DISTANCE,
		});
		expect(groups[0].photos.map((photo) => photo.id)).toEqual(near);
		expect(counts).toEqual({ duplicate: 1, burst: 0 });
	});

	test("bursts: 2 s gaps chain, 3 s or another camera splits, pairs are not bursts", async () => {
		expect(BURST_MAX_GAP_SECONDS).toBe(2);
		const sony = ["Sony", "A7III"] as [string, string];
		const at = (time: string) => `2024:06:15 ${time}`;
		const burst = [
			addPhoto({ camera: sony, dateTaken: at("12:00:00") }),
			addPhoto({ camera: sony, dateTaken: at("12:00:02") }),
			addPhoto({ camera: sony, dateTaken: at("12:00:04") }),
		];
		// Same model by another maker interleaves in time but never joins.
		addPhoto({ camera: ["Other", "A7III"], dateTaken: at("12:00:01") });
		addPhoto({ camera: ["Other", "A7III"], dateTaken: at("12:00:03") });
		// 3 s after the burst: separate run of two, too small.
		addPhoto({ camera: sony, dateTaken: at("12:00:07") });
		addPhoto({ camera: sony, dateTaken: at("12:00:08") });
		// Unparsable and placeholder dates are ignored rather than chained.
		addPhoto({ camera: sony, dateTaken: "garbage" });
		addPhoto({ camera: sony, dateTaken: "0000:00:00 00:00:00" });
		// A run crossing midnight, recorded in ISO form, is still a burst.
		const midnight = [
			addPhoto({ camera: sony, dateTaken: "2024-06-15T23:59:59" }),
			addPhoto({ camera: sony, dateTaken: "2024-06-16T00:00:00" }),
			addPhoto({ camera: sony, dateTaken: "2024-06-16T00:00:02" }),
		];

		const { groups, counts } = await caller.duplicateGroups({ kind: "burst" });
		expect(
			groups.map((group) => group.photos.map((photo) => photo.id)),
		).toEqual([midnight, burst]);
		expect(groups.every((group) => group.maxDistance === null)).toBe(true);
		expect(groups[1].key).toBe(`burst:${burst.join(",")}`);
		expect(counts).toEqual({ duplicate: 0, burst: 2 });
	});

	test("rejected photos are excluded from grouping", async () => {
		const sony = ["Sony", "A7III"] as [string, string];
		const hash = seed(3);
		const kept = addPhoto({
			hash,
			camera: sony,
			dateTaken: "2024:01:01 10:00:00",
		});
		addPhoto({ hash, camera: sony, dateTaken: "2024:01:01 10:00:01" });
		const rejected = addPhoto({
			hash,
			flag: "reject",
			camera: sony,
			dateTaken: "2024:01:01 10:00:02",
		});
		const groups = (await caller.duplicateGroups()).groups;
		expect(groups.map((group) => group.kind)).toEqual(["duplicate"]);
		expect(groups[0].photos.map((photo) => photo.id)).not.toContain(rejected);
		expect(groups[0].photos[0].id).toBe(kept);
	});

	test("suggested keeper follows rating, pick, RAW, pixels, sharpness, size, id", async () => {
		const cases: Array<[PhotoOptions, PhotoOptions]> = [
			[{ rating: 2, isRaw: true }, { rating: 3 }],
			[{ isRaw: true, width: 4000 }, { flag: "pick" }],
			[{ width: 4000, height: 3000 }, { isRaw: true }],
			[{ sharpness: 900 }, { width: 101 }],
			[{ size: 9000 }, { sharpness: 10 }],
			[{ sharpness: 10, size: 9000 }, { sharpness: 20 }],
			[{}, { size: 1001 }],
		];
		for (const [loser, winner] of cases) {
			sqlite.run("DELETE FROM photo_quality");
			sqlite.run("DELETE FROM photo_phash");
			sqlite.run("DELETE FROM photos");
			const loserId = addPhoto({ ...loser, hash: seed(4) });
			const winnerId = addPhoto({ ...winner, hash: seed(4) });
			const [group] = (await caller.duplicateGroups()).groups;
			expect(group.suggestedKeeperId).toBe(winnerId);
			expect(group.photos.map((photo) => photo.id)).toEqual([
				winnerId,
				loserId,
			]);
		}
		// Full tie: lowest ID keeps; the rest follow in ascending ID.
		sqlite.run("DELETE FROM photo_phash");
		sqlite.run("DELETE FROM photos");
		const tied = [1, 2, 3].map(() => addPhoto({ hash: seed(5) }));
		const [group] = (await caller.duplicateGroups()).groups;
		expect(group.suggestedKeeperId).toBe(tied[0]);
		expect(group.photos.map((photo) => photo.id)).toEqual(tied);
	});

	test("orders larger groups first, then newest, and paginates with an opaque cursor", async () => {
		const older = [addPhoto({ hash: seed(6) }), addPhoto({ hash: seed(6) })];
		const triple = [1, 2, 3].map(() => addPhoto({ hash: seed(7) }));
		const newer = [addPhoto({ hash: seed(8) }), addPhoto({ hash: seed(8) })];
		expect(await groupIds()).toEqual([triple, newer, older]);

		const seen: number[][] = [];
		let cursor: string | undefined;
		do {
			const page = await caller.duplicateGroups({ limit: 2, cursor });
			expect(page.counts).toEqual({ duplicate: 3, burst: 0 });
			seen.push(
				...page.groups.map((group) => group.photos.map((photo) => photo.id)),
			);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(seen).toEqual([triple, newer, older]);
		await expectTrpcCode(
			caller.duplicateGroups({ cursor: "-1" }),
			"BAD_REQUEST",
		);
	});

	test("dismissal hides exactly that key until membership changes", async () => {
		const pair = [addPhoto({ hash: seed(9) }), addPhoto({ hash: seed(9) })];
		const other = [addPhoto({ hash: seed(10) }), addPhoto({ hash: seed(10) })];
		const key = `duplicate:${pair.join(",")}`;
		expect(
			await caller.resolveDuplicateGroup({ key, action: "dismiss" }),
		).toEqual({
			dismissed: key,
		});
		const after = await caller.duplicateGroups();
		expect(after.groups.map((group) => group.key)).toEqual([
			`duplicate:${other.join(",")}`,
		]);
		expect(after.counts).toEqual({ duplicate: 1, burst: 0 });

		const joined = addPhoto({
			hash: flip(seed(9), DUPLICATE_MAX_DISTANCE),
		});
		expect(await groupIds()).toEqual([[...pair, joined], other]);
	});

	test("keep rejects every other member in one write, keeps files, and settles the kept set", async () => {
		const ids = [1, 2, 3, 4].map(() => addPhoto({ hash: seed(11) }));
		const key = `duplicate:${ids.join(",")}`;
		await expectTrpcCode(
			caller.resolveDuplicateGroup({ key, action: "keep" }),
			"BAD_REQUEST",
		);
		await expectTrpcCode(
			caller.resolveDuplicateGroup({
				key,
				action: "keep",
				keepIds: [ids[0], 999_999],
			}),
			"BAD_REQUEST",
		);

		expect(
			await caller.resolveDuplicateGroup({
				key,
				action: "keep",
				keepIds: [ids[2], ids[0]],
			}),
		).toEqual({ rejected: [ids[1], ids[3]] });
		const rows = sqlite
			.query<{ id: number; flag: string | null; path: string }, []>(
				"SELECT id, flag, path FROM photos ORDER BY id",
			)
			.all();
		expect(rows.map((row) => row.flag)).toEqual([
			null,
			"reject",
			null,
			"reject",
		]);
		expect(rows.map((row) => row.path)).toEqual(
			ids.map((_, index) => `dups/${photoCounter - 3 + index}.jpg`),
		);
		// The kept pair is a decision, not a new duplicate group to review...
		expect(await groupIds()).toEqual([]);
		// ...until another near-duplicate changes its membership.
		const joined = addPhoto({ hash: seed(11) });
		expect(await groupIds()).toEqual([[ids[0], ids[2], joined]]);
	});

	test("a stale or unknown key conflicts without writing", async () => {
		const ids = [addPhoto({ hash: seed(12) }), addPhoto({ hash: seed(12) })];
		const key = `duplicate:${ids.join(",")}`;
		addPhoto({ hash: seed(12) });
		await expectTrpcCode(
			caller.resolveDuplicateGroup({ key, action: "keep", keepIds: [ids[0]] }),
			"CONFLICT",
		);
		await expectTrpcCode(
			caller.resolveDuplicateGroup({ key, action: "dismiss" }),
			"CONFLICT",
		);
		await expectTrpcCode(
			caller.resolveDuplicateGroup({ key: "nonsense", action: "dismiss" }),
			"CONFLICT",
		);
		expect(
			sqlite.query("SELECT COUNT(*) AS n FROM duplicate_dismissals").get(),
		).toEqual({ n: 0 });
		expect(
			sqlite
				.query("SELECT COUNT(*) AS n FROM photos WHERE flag IS NOT NULL")
				.get(),
		).toEqual({ n: 0 });

		const response = await app.request("/api/v1/duplicates/resolve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, action: "dismiss" }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: {
				code: "DUPLICATE_GROUP_CHANGED",
				message: "The group changed since it was listed",
			},
		});
	});

	test("v1 serializes public photo DTOs and maps request errors", async () => {
		const ids = [
			addPhoto({
				hash: seed(13),
				camera: ["Sony", "A7III"],
				dateTaken: "2024:06:15 12:00:00",
			}),
			addPhoto({ hash: seed(13) }),
		];
		const response = await app.request(
			"/api/v1/duplicates?kind=duplicate&limit=1",
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			groups: Array<{ key: string; photos: Array<Record<string, unknown>> }>;
			nextCursor: string | null;
		};
		expect(body.nextCursor).toBeNull();
		expect(body.groups[0].key).toBe(`duplicate:${ids.join(",")}`);
		for (const photo of body.groups[0].photos) {
			for (const field of PRIVATE_FIELDS)
				expect(photo).not.toHaveProperty(field);
			expect(photo.createdAt).toBe(new Date(0).toISOString());
		}
		expect(body.groups[0].photos[0].exif).toMatchObject({ cameraMake: "Sony" });
		expect(body.groups[0].photos[1].exif).toBeNull();

		const resolve = (payload: unknown) =>
			app.request("/api/v1/duplicates/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		const invalid = {
			error: { code: "INVALID_REQUEST", message: "Request validation failed" },
		};
		for (const query of ["kind=other", "limit=0", "limit=201", "cursor=abc"]) {
			const bad = await app.request(`/api/v1/duplicates?${query}`);
			expect(bad.status).toBe(400);
			expect(await bad.json()).toEqual(invalid);
		}
		for (const payload of [
			{ key: body.groups[0].key, action: "keep" },
			{ key: body.groups[0].key, action: "keep", keepIds: [999_999] },
			{ key: body.groups[0].key, action: "merge" },
			{ key: body.groups[0].key, action: "dismiss", extra: true },
		]) {
			const bad = await resolve(payload);
			expect(bad.status).toBe(400);
			expect(await bad.json()).toEqual(invalid);
		}
		const kept = await resolve({
			key: body.groups[0].key,
			action: "keep",
			keepIds: [ids[0]],
		});
		expect(await kept.json()).toEqual({ rejected: [ids[1]] });
	});
}
