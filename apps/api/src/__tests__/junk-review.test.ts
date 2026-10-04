import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageQuality } from "@photobrain/image-processing";
import { TRPCError } from "@trpc/server";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import {
	junkReviewResponseSchema,
	resolveJunkResponseSchema,
} from "../routes/v1-schemas";
import { saveScanBatch } from "../services/import-persistence";
import {
	BLUR_THRESHOLD,
	DARK_THRESHOLD,
	JUNK_REASONS,
	JUNK_TAG_MIN_SCORE,
	type JunkAction,
	type JunkReason,
	type JunkReviewInput,
	type JunkReviewResult,
	junkCounts,
	junkReview,
	MAX_JUNK_RESOLVE_IDS,
	resolveJunk,
} from "../services/junk-review";
import {
	QUALITY_BACKFILL_BATCH_SIZE,
	readQualityBackfillBatch,
} from "../services/photo-quality";
import { QUALITY_VERSION } from "../services/processing-versions";
import { createTestDb } from "./setup";

const PERF_LOG_PREFIX = "[junk-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";
const PRIVATE_FIELDS = [
	"sourceRoot",
	"sourceFingerprint",
	"mediaVersion",
	"thumbnailKey",
	"thumbnailRoot",
	"thumbnailFingerprint",
	"junkDismissed",
];
const INVALID_REQUEST = {
	error: { code: "INVALID_REQUEST", message: "Request validation failed" },
};

type QualityStep = {
	run<T>(id: string, work: () => T | Promise<T>): Promise<T>;
};
type QualityFunction = {
	options: { id: string; concurrency: { limit: number } };
	trigger: { event: string };
	handler(context: {
		event: { data: Record<string, never> };
		step: QualityStep;
	}): Promise<{ measured: number }>;
};

// Mocks of ../db, the native executor and the Inngest client are process-wide;
// run the suite in an isolated child like the tags and embedding suites.
if (process.env.PHOTOBRAIN_JUNK_TEST_CHILD !== "1") {
	test("junk review: classification, pagination, resolve, backfill and contract", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_JUNK_TEST_CHILD: "1" },
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
	const { db, sqlite } = createTestDb();
	const measureCalls: string[][] = [];
	let measure: (paths: string[]) => (ImageQuality | null)[] = (paths) =>
		paths.map(() => ({ sharpness: 500, brightness: 120 }));

	mock.module("../db", () => ({ db }));
	mock.module("../services/native-executor", () => ({
		nativeExecutor: {
			run: async (operation: string, paths: string[]) => {
				if (operation !== "analyzeImageQuality") {
					throw new Error(`Unexpected native operation ${operation}`);
				}
				measureCalls.push(paths);
				return measure(paths);
			},
		},
	}));
	mock.module("../services/vector-search", () => ({
		searchPhotosByText: async () => [],
		findSimilarPhotos: async () => [],
		findSimilarToPhoto: async () => null,
	}));
	mock.module("../inngest/client", () => ({
		inngest: {
			send: async () => undefined,
			createFunction: (
				options: unknown,
				trigger: unknown,
				handler: QualityFunction["handler"],
			) => ({ options, trigger, handler }),
		},
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
	const { analyzeQualityFunction } = await import(
		"../inngest/functions/quality"
	);
	const { config } = await import("../config");
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");
	const backfill = analyzeQualityFunction as unknown as QualityFunction;
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
		sqlite.run("DELETE FROM photo_quality");
		sqlite.run("DELETE FROM photo_tags");
		sqlite.run("DELETE FROM photo_exif");
		sqlite.run("DELETE FROM photos");
		measureCalls.length = 0;
		measure = (paths) => paths.map(() => ({ sharpness: 500, brightness: 120 }));
	});

	const insertPhoto = sqlite.prepare<
		{ id: number },
		[string, string | null, string, number, string | null, number]
	>(
		`INSERT INTO photos (path, name, size, created_at, modified_at, thumbnail_key, thumbnail_status, rating, flag, junk_dismissed)
		 VALUES (?1, ?1, 1, 0, 0, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
	);
	let photoCounter = 0;
	type PhotoOptions = {
		thumbnailKey?: string | null;
		thumbnailStatus?: string;
		rating?: number;
		flag?: "pick" | "reject" | null;
		dismissed?: boolean;
	};
	function addPhoto(options: PhotoOptions = {}) {
		const path = `review/${++photoCounter}.jpg`;
		const thumbnailKey =
			options.thumbnailKey === undefined
				? `key-${photoCounter}`
				: options.thumbnailKey;
		return insertPhoto.get(
			path,
			thumbnailKey,
			options.thumbnailStatus ?? "completed",
			options.rating ?? 0,
			options.flag ?? null,
			options.dismissed ? 1 : 0,
		)?.id as number;
	}
	function addTag(photoId: number, tag: string, score = 0.9) {
		sqlite.run(
			"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, ?, ?)",
			[photoId, tag, score],
		);
	}
	function addQuality(
		photoId: number,
		sharpness: number,
		brightness: number,
		overrides: { thumbnailKey?: string; version?: number } = {},
	) {
		const key =
			overrides.thumbnailKey ??
			(sqlite
				.query<{ key: string }, [number]>(
					"SELECT thumbnail_key AS key FROM photos WHERE id = ?",
				)
				.get(photoId)?.key as string);
		sqlite.run(
			`INSERT INTO photo_quality (photo_id, sharpness, brightness, thumbnail_key, quality_version)
			 VALUES (?, ?, ?, ?, ?)`,
			[
				photoId,
				sharpness,
				brightness,
				key,
				overrides.version ?? QUALITY_VERSION,
			],
		);
	}
	/** A junk candidate by a quality reason only. */
	function addBlurry(options: PhotoOptions = {}) {
		const id = addPhoto(options);
		addQuality(id, BLUR_THRESHOLD - 1, 120);
		return id;
	}
	async function reasonsById(input: JunkReviewInput = {}) {
		const { photos: page } = await junkReview(db, { limit: 500, ...input });
		return Object.fromEntries(
			page.map((photo) => [photo.id, photo.junkReasons]),
		);
	}
	async function allPages(reason?: JunkReason, limit = 7) {
		const ids: number[] = [];
		let cursor: number | undefined;
		for (let pages = 0; pages < 100; pages++) {
			const page = await junkReview(db, { reason, limit, cursor });
			expect(page.photos.length).toBeLessThanOrEqual(limit);
			ids.push(...page.photos.map((photo) => photo.id));
			if (page.nextCursor === null) return ids;
			expect(page.nextCursor).toBe(page.photos.at(-1)?.id ?? -1);
			cursor = page.nextCursor;
		}
		throw new Error("pagination did not terminate");
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
	const flagState = (id: number) =>
		sqlite
			.query<
				{ flag: string | null; rating: number; dismissed: number },
				[number]
			>(
				"SELECT flag, rating, junk_dismissed AS dismissed FROM photos WHERE id = ?",
			)
			.get(id);

	describe("classification", () => {
		test("reports every reason in contract order and ignores non-junk tags", async () => {
			const everything = addPhoto();
			// Insertion order differs from the reported order.
			addQuality(everything, 1, 1);
			addTag(everything, "receipt");
			addTag(everything, "screenshot");
			const screenshot = addPhoto();
			addTag(screenshot, "screenshot");
			addTag(screenshot, "beach");
			const ordinary = addPhoto();
			addTag(ordinary, "beach");
			addQuality(ordinary, 500, 120);
			const untouched = addPhoto();

			const reasons = await reasonsById();
			expect(reasons[everything]).toEqual([
				"screenshot",
				"document",
				"blurry",
				"dark",
			]);
			expect(reasons[screenshot]).toEqual(["screenshot"]);
			expect(reasons).not.toHaveProperty(String(ordinary));
			expect(reasons).not.toHaveProperty(String(untouched));
		});

		test("document covers document, receipt, whiteboard and text tags", async () => {
			const ids = Object.fromEntries(
				["document", "receipt", "whiteboard", "text"].map((tag) => {
					const id = addPhoto();
					addTag(id, tag);
					return [tag, id];
				}),
			);
			const reasons = await reasonsById();
			for (const id of Object.values(ids))
				expect(reasons[id]).toEqual(["document"]);
			expect(await reasonsById({ reason: "document" })).toEqual(reasons);
		});

		test("tag scores qualify from JUNK_TAG_MIN_SCORE inclusive", async () => {
			const atMinimum = addPhoto();
			addTag(atMinimum, "screenshot", JUNK_TAG_MIN_SCORE);
			const below = addPhoto();
			addTag(below, "screenshot", JUNK_TAG_MIN_SCORE - 0.0001);
			const documentBelow = addPhoto();
			addTag(documentBelow, "text", JUNK_TAG_MIN_SCORE - 0.0001);
			addTag(documentBelow, "receipt", 0.2);
			const reasons = await reasonsById();
			expect(reasons[atMinimum]).toEqual(["screenshot"]);
			expect(reasons).not.toHaveProperty(String(below));
			expect(reasons).not.toHaveProperty(String(documentBelow));
		});

		test("blur and dark thresholds are strict upper bounds", async () => {
			const blurAt = addPhoto();
			addQuality(blurAt, BLUR_THRESHOLD, 120);
			const blurBelow = addPhoto();
			addQuality(blurBelow, BLUR_THRESHOLD - 0.001, 120);
			const darkAt = addPhoto();
			addQuality(darkAt, 500, DARK_THRESHOLD);
			const darkBelow = addPhoto();
			addQuality(darkBelow, 500, DARK_THRESHOLD - 0.001);
			const reasons = await reasonsById();
			expect(reasons).not.toHaveProperty(String(blurAt));
			expect(reasons[blurBelow]).toEqual(["blurry"]);
			expect(reasons).not.toHaveProperty(String(darkAt));
			expect(reasons[darkBelow]).toEqual(["dark"]);
		});

		test("quality from another thumbnail generation or version does not count", async () => {
			const staleKey = addPhoto();
			addQuality(staleKey, 1, 1, { thumbnailKey: "old-generation" });
			const oldVersion = addPhoto();
			addQuality(oldVersion, 1, 1, { version: QUALITY_VERSION - 1 });
			const current = addPhoto();
			addQuality(current, 1, 120);
			const reasons = await reasonsById();
			expect(Object.keys(reasons).map(Number)).toEqual([current]);
		});

		test("excludes dismissed, rejected, picked and rated photos", async () => {
			const candidate = addBlurry();
			addBlurry({ dismissed: true });
			addBlurry({ flag: "reject" });
			addBlurry({ flag: "pick" });
			addBlurry({ rating: 1 });
			addBlurry({ rating: 5 });
			const tagged = addPhoto({ rating: 1 });
			addTag(tagged, "screenshot");
			expect(Object.keys(await reasonsById()).map(Number)).toEqual([candidate]);
			expect(junkCounts(db)).toEqual({
				all: 1,
				screenshot: 0,
				document: 0,
				blurry: 1,
				dark: 0,
			});
		});

		test("reason filter returns only matching candidates; counts ignore reason and cursor", async () => {
			const screenshots = [addPhoto(), addPhoto()];
			for (const id of screenshots) addTag(id, "screenshot");
			const dark = addPhoto();
			addQuality(dark, 500, 5);
			const both = addPhoto();
			addTag(both, "whiteboard");
			addQuality(both, 3, 5);
			const expected = {
				all: 4,
				screenshot: 2,
				document: 1,
				blurry: 1,
				dark: 2,
			};

			const unfiltered = await junkReview(db);
			expect(unfiltered.counts).toEqual(expected);
			expect(unfiltered.photos.map((photo) => photo.id)).toEqual([
				both,
				dark,
				screenshots[1],
				screenshots[0],
			]);
			for (const reason of JUNK_REASONS) {
				const filtered = await junkReview(db, { reason });
				expect(filtered.counts).toEqual(expected);
				expect(filtered.photos.length).toBe(expected[reason]);
				for (const photo of filtered.photos) {
					expect(photo.junkReasons).toContain(reason);
				}
			}
			const paged = await junkReview(db, { limit: 1, cursor: dark });
			expect(paged.photos.map((photo) => photo.id)).toEqual([screenshots[1]]);
			expect(paged.counts).toEqual(expected);
			// The filtered list still reports all of a photo's reasons.
			expect(
				(await junkReview(db, { reason: "dark" })).photos.find(
					(photo) => photo.id === both,
				)?.junkReasons,
			).toEqual(["document", "blurry", "dark"]);
		});

		test("an empty library reports zero counts and no cursor", async () => {
			expect(await junkReview(db)).toEqual({
				photos: [],
				nextCursor: null,
				counts: { all: 0, screenshot: 0, document: 0, blurry: 0, dark: 0 },
			});
		});

		test("returns public photos with EXIF and no private or review-state fields", async () => {
			const id = addBlurry();
			sqlite.run(
				"UPDATE photos SET source_root = '/private', thumbnail_root = '/private/thumbs' WHERE id = ?",
				[id],
			);
			sqlite.run(
				"INSERT INTO photo_exif (photo_id, camera_make) VALUES (?, 'Sony')",
				[id],
			);
			const [photo] = (await junkReview(db)).photos;
			expect(photo.exif?.cameraMake).toBe("Sony");
			expect(photo).toMatchObject({ id, rating: 0, flag: null });
			for (const key of PRIVATE_FIELDS) expect(photo).not.toHaveProperty(key);
			for (const key of [
				"junkScreenshot",
				"junkDocument",
				"junkBlurry",
				"junkDark",
			]) {
				expect(photo).not.toHaveProperty(key);
			}
		});

		test("rejects invalid limits, cursors and reasons in the service", async () => {
			for (const input of [
				{ limit: 0 },
				{ limit: 501 },
				{ limit: 1.5 },
				{ cursor: 0 },
				{ cursor: -3 },
				{ reason: "selfie" as JunkReason },
			]) {
				await expect(junkReview(db, input)).rejects.toThrow(RangeError);
			}
		});
	});

	describe("pagination", () => {
		test("keyset pages are id-descending with no duplicates or gaps", async () => {
			const ids: number[] = [];
			const screenshots = new Set<number>();
			for (let index = 0; index < 30; index++) {
				const id = addPhoto();
				// Interleave reasons and non-candidates so pages span gaps in ids.
				if (index % 3 === 0) {
					addTag(id, "screenshot");
					screenshots.add(id);
				}
				if (index % 2 === 0) addQuality(id, 1, 120);
				if (index % 3 === 0 || index % 2 === 0) ids.push(id);
				addPhoto({ flag: "pick" });
			}
			const expected = [...ids].sort((left, right) => right - left);
			for (const limit of [1, 7, 20, expected.length, 500]) {
				expect(await allPages(undefined, limit)).toEqual(expected);
			}
			expect(await allPages("screenshot", 4)).toEqual(
				expected.filter((id) => screenshots.has(id)),
			);
			// A page holding exactly the remaining rows ends the list.
			const exact = await junkReview(db, { limit: expected.length });
			expect(exact.photos).toHaveLength(expected.length);
			expect(exact.nextCursor).toBeNull();
			const short = await junkReview(db, { limit: expected.length - 1 });
			expect(short.nextCursor).toBe(expected.at(-2) ?? -1);
		});

		test("resolving photos between pages neither duplicates nor skips the rest", async () => {
			const ids = Array.from({ length: 12 }, () => addBlurry()).reverse();
			const first = await junkReview(db, { limit: 5 });
			expect(first.photos.map((photo) => photo.id)).toEqual(ids.slice(0, 5));
			resolveJunk(db, ids.slice(0, 3), "keep");
			resolveJunk(db, [ids[6]], "reject");
			const rest = await allPages(undefined, 5);
			expect(rest).toEqual([...ids.slice(3, 6), ...ids.slice(7)]);
			const second = await junkReview(db, {
				limit: 5,
				cursor: first.nextCursor ?? undefined,
			});
			expect(second.photos.map((photo) => photo.id)).toEqual([
				ids[5],
				ids[7],
				ids[8],
				ids[9],
				ids[10],
			]);
		});
	});

	describe("resolveJunk", () => {
		test("reject flags photos, keeps rating/dismissal, and removes them from review", async () => {
			const [first, second, other] = [addBlurry(), addBlurry(), addBlurry()];
			expect(
				resolveJunk(db, [second, first, 999_999, first], "reject"),
			).toEqual({
				updated: [first, second],
			});
			expect(flagState(first)).toEqual({
				flag: "reject",
				rating: 0,
				dismissed: 0,
			});
			expect(flagState(second)).toEqual({
				flag: "reject",
				rating: 0,
				dismissed: 0,
			});
			expect(flagState(other)).toEqual({ flag: null, rating: 0, dismissed: 0 });
			const review = await junkReview(db);
			expect(review.photos.map((photo) => photo.id)).toEqual([other]);
			expect(review.counts.all).toBe(1);
		});

		test("keep dismisses photos permanently without touching curation", async () => {
			const [kept, other] = [addBlurry(), addBlurry()];
			expect(resolveJunk(db, [kept], "keep")).toEqual({ updated: [kept] });
			expect(flagState(kept)).toEqual({ flag: null, rating: 0, dismissed: 1 });
			expect((await junkReview(db)).photos.map((photo) => photo.id)).toEqual([
				other,
			]);
			// A later unflag or new reason does not bring a kept photo back.
			addTag(kept, "screenshot");
			expect(junkCounts(db).all).toBe(1);
		});

		test("unknown ids are ignored and nothing is written", () => {
			const id = addBlurry();
			expect(resolveJunk(db, [999_998, 999_999], "keep")).toEqual({
				updated: [],
			});
			expect(resolveJunk(db, [999_999], "reject")).toEqual({ updated: [] });
			expect(flagState(id)).toEqual({ flag: null, rating: 0, dismissed: 0 });
		});

		test("rejects empty, oversized and unknown-action requests", () => {
			const id = addBlurry();
			expect(() => resolveJunk(db, [], "keep")).toThrow(RangeError);
			expect(() =>
				resolveJunk(
					db,
					Array.from(
						{ length: MAX_JUNK_RESOLVE_IDS + 1 },
						(_, index) => index + 1,
					),
					"keep",
				),
			).toThrow(RangeError);
			expect(() => resolveJunk(db, [id], "delete" as JunkAction)).toThrow(
				RangeError,
			);
			// Exactly the maximum is accepted (duplicates collapse first).
			expect(
				resolveJunk(
					db,
					[...Array.from({ length: MAX_JUNK_RESOLVE_IDS }, () => id), id],
					"keep",
				),
			).toEqual({ updated: [id] });
		});

		test("scans never reset a kept photo", () => {
			const result = {
				success: true,
				path: "review/rescanned.jpg",
				name: "rescanned.jpg",
				size: 10,
				createdAt: 0,
				modifiedAt: 0,
				isRaw: false,
				mediaType: "photo" as const,
				durationMs: null,
				videoCodec: null,
			};
			const [id] = saveScanBatch(db, [result]);
			resolveJunk(db, [id], "keep");
			expect(saveScanBatch(db, [{ ...result, size: 20 }])).toEqual([id]);
			expect(flagState(id)?.dismissed).toBe(1);
		});
	});

	describe("analyze-quality-v1 backfill", () => {
		function harness() {
			const checkpoints = new Map<string, unknown>();
			const steps: string[] = [];
			const step: QualityStep = {
				async run<T>(id: string, work: () => T | Promise<T>): Promise<T> {
					if (checkpoints.has(id)) return checkpoints.get(id) as T;
					const value = structuredClone(await work());
					checkpoints.set(id, value);
					steps.push(id);
					return value;
				},
			};
			return {
				steps,
				run: () => backfill.handler({ event: { data: {} }, step }),
			};
		}
		const qualityRows = () =>
			sqlite
				.query<
					{
						photoId: number;
						sharpness: number;
						brightness: number;
						thumbnailKey: string;
						version: number;
					},
					[]
				>(
					`SELECT photo_id AS photoId, sharpness, brightness, thumbnail_key AS thumbnailKey, quality_version AS version
					 FROM photo_quality ORDER BY photo_id`,
				)
				.all();

		test("is a single-concurrency function on photos/quality.requested", () => {
			expect(backfill.options).toEqual({
				id: "analyze-quality-v1",
				concurrency: { limit: 1 },
			});
			expect(backfill.trigger).toEqual({ event: "photos/quality.requested" });
		});

		test("measures only missing, stale-key and outdated-version rows from committed medium thumbnails", async () => {
			const missing = addPhoto({ thumbnailKey: "gen-a" });
			const staleKey = addPhoto({ thumbnailKey: "gen-b" });
			addQuality(staleKey, 1, 1, { thumbnailKey: "gen-old" });
			const outdated = addPhoto({ thumbnailKey: "gen-c" });
			addQuality(outdated, 1, 1, { version: QUALITY_VERSION - 1 });
			const current = addPhoto({ thumbnailKey: "gen-d" });
			addQuality(current, 7, 8);
			addPhoto({ thumbnailKey: "gen-e", thumbnailStatus: "pending" });
			addPhoto({ thumbnailKey: "gen-f", thumbnailStatus: "failed" });
			addPhoto({ thumbnailKey: null });
			sqlite.run(
				"UPDATE photos SET thumbnail_root = '/library/thumbs' WHERE id = ?",
				[staleKey],
			);

			expect(readQualityBackfillBatch(db, 0).map((row) => row.photoId)).toEqual(
				[missing, staleKey, outdated],
			);
			measure = (paths) =>
				paths.map((_, index) => ({
					sharpness: 10 + index,
					brightness: 20 + index,
				}));
			expect(await harness().run()).toEqual({ measured: 3 });
			expect(measureCalls).toEqual([
				[
					join(config.THUMBNAILS_DIRECTORY, "medium/gen-a.webp"),
					"/library/thumbs/medium/gen-b.webp",
					join(config.THUMBNAILS_DIRECTORY, "medium/gen-c.webp"),
				],
			]);
			expect(qualityRows()).toEqual([
				{
					photoId: missing,
					sharpness: 10,
					brightness: 20,
					thumbnailKey: "gen-a",
					version: QUALITY_VERSION,
				},
				{
					photoId: staleKey,
					sharpness: 11,
					brightness: 21,
					thumbnailKey: "gen-b",
					version: QUALITY_VERSION,
				},
				{
					photoId: outdated,
					sharpness: 12,
					brightness: 22,
					thumbnailKey: "gen-c",
					version: QUALITY_VERSION,
				},
				{
					photoId: current,
					sharpness: 7,
					brightness: 8,
					thumbnailKey: "gen-d",
					version: QUALITY_VERSION,
				},
			]);
		});

		test("is idempotent and leaves failed measurements for a later run", async () => {
			const ok = addPhoto();
			const unreadable = addPhoto();
			// The second path is unreadable on the first run only.
			measure = (paths) =>
				paths.map((_, index) =>
					index === 1 ? null : { sharpness: 1, brightness: 2 },
				);
			expect(await harness().run()).toEqual({ measured: 1 });
			expect(qualityRows().map((row) => row.photoId)).toEqual([ok]);
			measureCalls.length = 0;
			measure = (paths) => paths.map(() => ({ sharpness: 3, brightness: 4 }));
			expect(await harness().run()).toEqual({ measured: 1 });
			expect(measureCalls).toHaveLength(1);
			expect(measureCalls[0]).toHaveLength(1);
			measureCalls.length = 0;
			expect(await harness().run()).toEqual({ measured: 0 });
			expect(measureCalls).toEqual([]);
			expect(qualityRows().map((row) => [row.photoId, row.sharpness])).toEqual([
				[ok, 1],
				[unreadable, 3],
			]);
		});

		test("processes more than 200 rows in 200-row steps", async () => {
			const COUNT = QUALITY_BACKFILL_BATCH_SIZE * 2 + 50;
			sqlite.transaction(() => {
				for (let index = 0; index < COUNT; index++) addPhoto();
			})();
			const run = harness();
			expect(await run.run()).toEqual({ measured: COUNT });
			expect(run.steps).toEqual([
				"analyze-quality-batch-v1-0",
				"analyze-quality-batch-v1-1",
				"analyze-quality-batch-v1-2",
			]);
			expect(measureCalls.map((paths) => paths.length)).toEqual([200, 200, 50]);
			expect(qualityRows()).toHaveLength(COUNT);
			expect(readQualityBackfillBatch(db, 0)).toEqual([]);
		});

		test("an exact multiple of the step size finishes with one empty step", async () => {
			sqlite.transaction(() => {
				for (let index = 0; index < QUALITY_BACKFILL_BATCH_SIZE; index++)
					addPhoto();
			})();
			const run = harness();
			expect(await run.run()).toEqual({
				measured: QUALITY_BACKFILL_BATCH_SIZE,
			});
			expect(run.steps).toHaveLength(2);
			expect(measureCalls.map((paths) => paths.length)).toEqual([200]);
		});

		test("skips a photo whose thumbnail generation changed between measure and write", async () => {
			const changed = addPhoto({ thumbnailKey: "gen-1" });
			const stable = addPhoto({ thumbnailKey: "stable" });
			const demoted = addPhoto({ thumbnailKey: "gen-x" });
			measure = (paths) => {
				// A rescan commits a new generation while native work is running.
				sqlite.run("UPDATE photos SET thumbnail_key = 'gen-2' WHERE id = ?", [
					changed,
				]);
				sqlite.run(
					"UPDATE photos SET thumbnail_status = 'pending' WHERE id = ?",
					[demoted],
				);
				return paths.map(() => ({ sharpness: 1, brightness: 1 }));
			};
			expect(await harness().run()).toEqual({ measured: 1 });
			expect(qualityRows().map((row) => row.photoId)).toEqual([stable]);
			measure = (paths) => paths.map(() => ({ sharpness: 2, brightness: 2 }));
			measureCalls.length = 0;
			expect(await harness().run()).toEqual({ measured: 1 });
			expect(measureCalls).toEqual([
				[join(config.THUMBNAILS_DIRECTORY, "medium/gen-2.webp")],
			]);
			expect(
				qualityRows().map((row) => [row.photoId, row.thumbnailKey]),
			).toEqual([
				[changed, "gen-2"],
				[stable, "stable"],
			]);
		});

		test("a misaligned native result fails the step without writing", async () => {
			addPhoto();
			addPhoto();
			measure = () => [{ sharpness: 1, brightness: 1 }];
			await expect(harness().run()).rejects.toThrow(/1 results for 2 paths/);
			expect(qualityRows()).toEqual([]);
		});

		test("quality rows cascade with their photo", () => {
			const id = addBlurry();
			sqlite.run("PRAGMA foreign_keys = ON");
			sqlite.run("DELETE FROM photos WHERE id = ?", [id]);
			expect(qualityRows()).toEqual([]);
		});
	});

	describe("tRPC procedures", () => {
		test("junkReview and resolveJunk share the service contract", async () => {
			const dark = addPhoto();
			addQuality(dark, 500, 1);
			const shot = addPhoto();
			addTag(shot, "screenshot");
			const page = await caller.junkReview({ limit: 1 });
			expect(page).toEqual(await junkReview(db, { limit: 1 }));
			expect(page.photos.map((photo) => [photo.id, photo.junkReasons])).toEqual(
				[[shot, ["screenshot"]]],
			);
			expect(page.nextCursor).toBe(shot);
			expect((await caller.junkReview()).photos).toHaveLength(2);
			expect(
				(await caller.junkReview({ reason: "dark", cursor: shot })).photos.map(
					(photo) => photo.id,
				),
			).toEqual([dark]);
			expect(
				await caller.resolveJunk({ photoIds: [dark], action: "keep" }),
			).toEqual({
				updated: [dark],
			});
			expect(
				await caller.resolveJunk({ photoIds: [shot], action: "reject" }),
			).toEqual({
				updated: [shot],
			});
			expect((await caller.junkReview()).counts.all).toBe(0);
		});

		test("invalid input is BAD_REQUEST", async () => {
			for (const input of [
				{ limit: 0 },
				{ limit: 501 },
				{ limit: 2.5 },
				{ cursor: 0 },
				{ reason: "selfie" },
			]) {
				expect(
					await trpcErrorCode(
						caller.junkReview(input as Parameters<typeof caller.junkReview>[0]),
					),
				).toBe("BAD_REQUEST");
			}
			for (const input of [
				{ photoIds: [], action: "keep" },
				{ photoIds: [0], action: "keep" },
				{
					photoIds: Array.from(
						{ length: MAX_JUNK_RESOLVE_IDS + 1 },
						(_, i) => i + 1,
					),
					action: "reject",
				},
				{ photoIds: [1], action: "delete" },
			]) {
				expect(
					await trpcErrorCode(
						caller.resolveJunk(
							input as Parameters<typeof caller.resolveJunk>[0],
						),
					),
				).toBe("BAD_REQUEST");
			}
		});
	});

	describe("/api/v1/review/junk", () => {
		const resolve = (body: unknown) =>
			app.request("/api/v1/review/junk/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: typeof body === "string" ? body : JSON.stringify(body),
			});

		test("GET returns serialized photos with reasons, cursor and counts matching tRPC", async () => {
			const ids = [addBlurry(), addBlurry(), addBlurry()];
			sqlite.run("UPDATE photos SET thumbnail_updated_at = 1758371696");
			const response = await app.request(
				"/api/v1/review/junk?limit=2&reason=blurry",
			);
			expect(response.status).toBe(200);
			const body = junkReviewResponseSchema.parse(await responseJson(response));
			const trpc = await caller.junkReview({ limit: 2, reason: "blurry" });
			expect(body).toEqual(JSON.parse(JSON.stringify(trpc)));
			expect(body.photos.map((photo) => photo.id)).toEqual([ids[2], ids[1]]);
			expect(body.photos[0].createdAt).toBe("1970-01-01T00:00:00.000Z");
			expect(body.photos[0].thumbnailUpdatedAt).toBe(
				"2025-09-20T12:34:56.000Z",
			);
			expect(body.nextCursor).toBe(ids[1]);
			expect(body.counts).toEqual({
				all: 3,
				screenshot: 0,
				document: 0,
				blurry: 3,
				dark: 0,
			});
			for (const photo of body.photos) {
				for (const key of PRIVATE_FIELDS) expect(photo).not.toHaveProperty(key);
			}
			const last = junkReviewResponseSchema.parse(
				await responseJson(
					await app.request(`/api/v1/review/junk?cursor=${ids[1]}`),
				),
			);
			expect(last.photos.map((photo) => photo.id)).toEqual([ids[0]]);
			expect(last.nextCursor).toBeNull();
		});

		test("GET rejects invalid query parameters with 400 INVALID_REQUEST", async () => {
			for (const query of [
				"reason=selfie",
				"limit=0",
				"limit=501",
				"limit=1.5",
				"limit=abc",
				"cursor=0",
				"cursor=-1",
				"cursor=abc",
			]) {
				const response = await app.request(`/api/v1/review/junk?${query}`);
				expect(response.status).toBe(400);
				expect(await responseJson(response)).toEqual(INVALID_REQUEST);
			}
		});

		test("POST resolve writes and returns existing ids", async () => {
			const [reject, keep] = [addBlurry(), addBlurry()];
			const rejected = await resolve({
				photoIds: [reject, 999_999],
				action: "reject",
			});
			expect(rejected.status).toBe(200);
			expect(
				resolveJunkResponseSchema.parse(await responseJson(rejected)),
			).toEqual({
				updated: [reject],
			});
			const kept = await resolve({ photoIds: [keep], action: "keep" });
			expect(await responseJson(kept)).toEqual({ updated: [keep] });
			expect(flagState(reject)?.flag).toBe("reject");
			expect(flagState(keep)?.dismissed).toBe(1);
		});

		test("POST resolve rejects invalid bodies with 400 INVALID_REQUEST without writing", async () => {
			const id = addBlurry();
			for (const body of [
				"not json",
				"",
				{ photoIds: [], action: "keep" },
				{ photoIds: [0], action: "keep" },
				{ photoIds: ["1"], action: "keep" },
				{
					photoIds: Array.from(
						{ length: MAX_JUNK_RESOLVE_IDS + 1 },
						(_, i) => i + 1,
					),
					action: "keep",
				},
				{ photoIds: [id], action: "delete" },
				{ photoIds: [id] },
				{ photoIds: [id], action: "keep", extra: true },
			]) {
				const response = await resolve(body);
				expect(response.status).toBe(400);
				expect(await responseJson(response)).toEqual(INVALID_REQUEST);
			}
			expect(flagState(id)).toEqual({ flag: null, rating: 0, dismissed: 0 });
		});
	});

	test("junkReview over 8,000 photos with tags and quality pages and counts under 50 ms", async () => {
		const COUNT = 8_000;
		const TAGS = ["screenshot", "receipt", "beach", "dog", "text", "sunset"];
		sqlite.transaction(() => {
			for (let index = 0; index < COUNT; index++) {
				const id = addPhoto({
					rating: index % 11 === 0 ? 3 : 0,
					flag: index % 13 === 0 ? "pick" : index % 17 === 0 ? "reject" : null,
					dismissed: index % 19 === 0,
				});
				for (let slot = 0; slot < 3; slot++) {
					addTag(
						id,
						TAGS[(index + slot * 2) % TAGS.length],
						((index * 7 + slot) % 10) / 10,
					);
				}
				addQuality(id, (index * 37) % 2_000, (index * 53) % 255);
			}
		})();
		sqlite.run("ANALYZE");

		const statements: string[] = [];
		const original = sqlite.prepare;
		sqlite.prepare = ((...args: Parameters<typeof original>) => {
			statements.push(args[0]);
			return original.apply(sqlite, args);
		}) as typeof original;
		let first: JunkReviewResult;
		try {
			first = await junkReview(db);
		} finally {
			sqlite.prepare = original;
		}
		// One page statement (EXIF hydrated in the same query) and one counts statement.
		expect(statements).toHaveLength(2);
		const plans = statements.map((statement) =>
			sqlite
				.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${statement}`)
				.all()
				.map((row) => row.detail)
				.join("\n"),
		);
		for (const plan of plans) {
			expect(plan).toMatch(
				/SEARCH photos USING (COVERING )?INDEX idx_photos_junk_review/,
			);
			expect(plan).not.toMatch(/SCAN photos(\s|$)/m);
			expect(plan).toMatch(
				/photo_tags USING (COVERING )?INDEX sqlite_autoindex_photo_tags_1/,
			);
			expect(plan).toMatch(/photo_quality USING INTEGER PRIMARY KEY/);
		}
		// Page order comes from the index (rowid within the equality prefix).
		expect(plans[0]).not.toMatch(/TEMP B-TREE FOR ORDER BY/);

		const time = async <T>(work: () => T | Promise<T>) => {
			const started = performance.now();
			const value = await work();
			return { value, ms: performance.now() - started };
		};
		const page1 = await time(() => junkReview(db));
		const page2 = await time(() =>
			junkReview(db, { cursor: page1.value.nextCursor ?? undefined }),
		);
		const darkPage = await time(() => junkReview(db, { reason: "dark" }));
		const counts = await time(() => junkCounts(db));
		expect(first.photos).toHaveLength(200);
		expect(page1.value.photos).toEqual(first.photos);
		expect(page2.value.photos[0].id).toBeLessThan(first.photos.at(-1)?.id ?? 0);
		const expectedAll = sqlite
			.query<{ count: number }, [number, number, number]>(
				`SELECT count(*) AS count FROM photos p
				 WHERE p.junk_dismissed = 0 AND p.flag IS NULL AND p.rating = 0 AND (
					EXISTS (SELECT 1 FROM photo_tags t WHERE t.photo_id = p.id AND t.tag IN ('screenshot', 'document', 'receipt', 'whiteboard', 'text') AND t.score >= ?1)
					OR EXISTS (SELECT 1 FROM photo_quality q WHERE q.photo_id = p.id AND (q.sharpness < ?2 OR q.brightness < ?3)))`,
			)
			.get(JUNK_TAG_MIN_SCORE, BLUR_THRESHOLD, DARK_THRESHOLD)?.count;
		expect(counts.value.all).toBe(expectedAll ?? -1);
		expect(counts.value.all).toBeGreaterThan(1_000);
		for (const { ms } of [page1, page2, darkPage, counts])
			expect(ms).toBeLessThan(50);
		console.log(
			`${PERF_LOG_PREFIX} junkReview over ${COUNT} photos (${counts.value.all} candidates; ${JSON.stringify(counts.value)}): page1 ${page1.ms.toFixed(2)} ms, cursor page ${page2.ms.toFixed(2)} ms, reason=dark ${darkPage.ms.toFixed(2)} ms (each incl. counts + EXIF hydration), counts alone ${counts.ms.toFixed(2)} ms`,
		);
		console.log(
			`${PERF_LOG_PREFIX} page plan: ${plans[0].replaceAll("\n", " | ")}`,
		);
		console.log(
			`${PERF_LOG_PREFIX} counts plan: ${plans[1].replaceAll("\n", " | ")}`,
		);
	}, 60_000);

	describe("migration 0010", () => {
		test("applies on a database migrated to 0009 with rows and keeps data", () => {
			const sql = readFileSync(
				join(MIGRATIONS_FOLDER, "0010_junk_review.sql"),
				"utf8",
			);
			expect(sql).not.toMatch(/DROP TABLE|__new_|INSERT INTO/i);
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
				const junkIndex = journal.entries.findIndex((entry) =>
					entry.tag.startsWith("0010_"),
				);
				expect(junkIndex).toBeGreaterThan(0);
				expect(journal.entries[junkIndex - 1].tag).toStartWith("0009_");
				writeFileSync(
					journalPath,
					JSON.stringify({
						...journal,
						entries: journal.entries.slice(0, junkIndex),
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
				expect(tables()).not.toContain("photo_quality");
				legacy.run(
					`INSERT INTO photos (id, path, name, size, created_at, modified_at, thumbnail_key, thumbnail_status, rating, flag)
					 VALUES (7, 'a/one.jpg', 'one.jpg', 1, 0, 0, 'key-one', 'completed', 4, 'pick'),
					        (9, 'a/two.jpg', 'two.jpg', 2, 0, 0, 'key-two', 'completed', 0, NULL)`,
				);
				legacy.run(
					"INSERT INTO photo_exif (photo_id, camera_make) VALUES (7, 'Sony')",
				);
				legacy.run(
					"INSERT INTO photo_tags (photo_id, tag, score) VALUES (9, 'screenshot', 0.9)",
				);
				legacy.run(
					"INSERT INTO collections (id, name, created_at, updated_at) VALUES (1, 'Trip', 0, 0)",
				);
				legacy.run(
					"INSERT INTO collection_photos (collection_id, photo_id, added_at) VALUES (1, 7, 0)",
				);
				const snapshot = () => ({
					exif: legacy.query("SELECT * FROM photo_exif").all(),
					tags: legacy.query("SELECT * FROM photo_tags").all(),
					collections: legacy.query("SELECT * FROM collection_photos").all(),
				});
				const before = snapshot();
				const photosBefore = legacy
					.query<Record<string, unknown>, []>(
						"SELECT * FROM photos ORDER BY id",
					)
					.all();

				migrate(legacyDb, { migrationsFolder: MIGRATIONS_FOLDER });

				expect(snapshot()).toEqual(before);
				// Later migrations may add columns; every existing value is kept.
				expect(
					legacy.query("SELECT * FROM photos ORDER BY id").all(),
				).toMatchObject(
					photosBefore.map((row) => ({ ...row, junk_dismissed: 0 })),
				);
				expect(tables()).toContain("photo_quality");
				expect(
					legacy
						.query<{ name: string }, []>(
							"SELECT name FROM pragma_index_list('photos')",
						)
						.all()
						.map((row) => row.name),
				).toContain("idx_photos_junk_review");
				expect(
					legacy
						.query<{ table: string; on_delete: string }, []>(
							"SELECT \"table\", on_delete FROM pragma_foreign_key_list('photo_quality')",
						)
						.all(),
				).toEqual([{ table: "photos", on_delete: "CASCADE" }]);
				const migrated = legacyDb as unknown as Parameters<
					typeof junkCounts
				>[0];
				// Existing completed thumbnails become eligible for the quality backfill,
				// and existing tags classify immediately.
				expect(
					readQualityBackfillBatch(migrated, 0).map((row) => row.photoId),
				).toEqual([7, 9]);
				expect(junkCounts(migrated)).toEqual({
					all: 1,
					screenshot: 1,
					document: 0,
					blurry: 0,
					dark: 0,
				});
				expect(() =>
					legacy.run(
						"INSERT INTO photo_quality (photo_id, sharpness, brightness, thumbnail_key) VALUES (9, 1, 1, 'key-two')",
					),
				).toThrow(/NOT NULL constraint failed/);
				legacy.close();
			} finally {
				rmSync(partial, { recursive: true, force: true });
			}
		});
	});
}
