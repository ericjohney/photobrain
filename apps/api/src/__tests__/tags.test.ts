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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";
import * as schema from "../db/schema";
import { photoEmbedding, photos, photoTags } from "../db/schema";
import { saveEmbeddingBatch } from "../services/import-persistence";
import {
	createTagLabelMatrix,
	MAX_TAGS_PER_PHOTO,
	readTagBackfillBatch,
	saveTagBatch,
	scoreTags,
	TAG_BACKFILL_BATCH_SIZE,
	TAG_MIN_PROBABILITY,
	type TagLabelMatrix,
	tagPhotoBatch,
} from "../services/photo-tagging";
import { EMBEDDING_MODEL_VERSION } from "../services/processing-versions";
import {
	TAG_VOCABULARY,
	TAG_VOCABULARY_VERSION,
} from "../services/tag-vocabulary";
import { createTestDb, perfBudgetMs } from "./setup";

const PERF_LOG_PREFIX = "[tags-perf]";
const MIGRATIONS_FOLDER = "../../packages/db/drizzle";

type TagStep = {
	run<T>(id: string, work: () => T | Promise<T>): Promise<T>;
};
type TagFunction = {
	handler(context: {
		event: { data: Record<string, never> };
		step: TagStep;
	}): Promise<{ tagged: number }>;
};

// Mocks of the native addon, ../db and the Inngest client are process-wide;
// run the suite in an isolated child like the embedding and search suites.
if (process.env.PHOTOBRAIN_TAGS_TEST_CHILD !== "1") {
	test("automatic tags: scoring, persistence, backfill, filters and contract", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_TAGS_TEST_CHILD: "1" },
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
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);

	// One-hot label vectors: label i is the unit vector e_i in D dimensions, so
	// an image vector's cosine to each label is just its normalized component.
	const D = TAG_VOCABULARY.length;
	const tagIndex = new Map(
		TAG_VOCABULARY.map(({ tag }, index) => [tag, index]),
	);
	const unit = (index: number) => {
		const vector = new Array<number>(D).fill(0);
		vector[index] = 1;
		return vector;
	};
	/** An image vector pointing equally at `tags`, plus optional small noise. */
	const near = (tags: readonly string[], noise = 0) => {
		const vector = new Array<number>(D).fill(noise);
		for (const tag of tags) {
			const index = tagIndex.get(tag);
			if (index === undefined) throw new Error(`unknown tag ${tag}`);
			vector[index] = 1;
		}
		const norm = Math.hypot(...vector);
		return vector.map((value) => value / norm);
	};
	const promptVectors = new Map(
		TAG_VOCABULARY.map(({ prompt }, index) => [prompt, unit(index)]),
	);
	let textEmbeddingCalls = 0;
	let failTextEmbedding = false;
	let queryVector = near(["beach"]);
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: (text: string) => {
			textEmbeddingCalls++;
			if (failTextEmbedding) throw new Error("text model unavailable");
			return promptVectors.get(text) ?? queryVector;
		},
	}));
	mock.module("../db", () => ({ db }));
	mock.module("../inngest/client", () => ({
		inngest: {
			send: async () => undefined,
			createFunction: (
				options: unknown,
				trigger: unknown,
				handler: TagFunction["handler"],
			) => ({ options, trigger, handler }),
		},
	}));
	mock.module("@inngest/realtime", () => ({
		getSubscriptionToken: async () => ({ token: "test-token" }),
	}));
	// Static imports would load the real native addon, production database and
	// Inngest client before these mocks are installed (intentional boundary).
	const { loadTagLabelMatrix } = await import("../services/tag-labels");
	const { tagPhotosFunction } = await import("../inngest/functions/tags");
	const { listPhotos, listFilterOptions } = await import(
		"../services/photo-catalog"
	);
	const { searchPhotosByText, findSimilarToPhoto } = await import(
		"../services/vector-search"
	);
	const { appRouter } = await import("../trpc/router");
	const { createV1Router } = await import("../routes/v1");

	const backfill = tagPhotosFunction as unknown as TagFunction & {
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

	const labels: TagLabelMatrix = createTagLabelMatrix(
		TAG_VOCABULARY.map(({ tag }, index) => ({ tag, vector: unit(index) })),
	);

	afterAll(() => sqlite.close());
	beforeEach(() => {
		db.delete(photoTags).run();
		db.delete(photoEmbedding).run();
		db.delete(photos).run();
		queryVector = near(["beach"]);
		failTextEmbedding = false;
	});

	function addPhoto(
		path: string,
		thumbnailKey: string | null = `key-${path}`,
		embeddingStatus = "pending",
	) {
		return db
			.insert(photos)
			.values({
				path,
				name: path.split("/").at(-1) ?? path,
				size: 1,
				createdAt: new Date(0),
				modifiedAt: new Date(0),
				thumbnailKey,
				embeddingStatus,
			})
			.returning()
			.get();
	}

	/** Inserts a committed vector directly (no tags), as a pre-0009 library would have. */
	function addIndexedPhoto(
		path: string,
		vector: readonly number[],
		overrides: {
			modelVersion?: string;
			vectorKey?: string | null;
			status?: string;
			tagsVersion?: number | null;
		} = {},
	) {
		const photo = addPhoto(
			path,
			`key-${path}`,
			overrides.status ?? "completed",
		);
		db.insert(photoEmbedding)
			.values({
				photoId: photo.id,
				embedding: Buffer.from(new Float32Array(vector).buffer),
				modelVersion: overrides.modelVersion ?? EMBEDDING_MODEL_VERSION,
				thumbnailKey:
					overrides.vectorKey === undefined
						? `key-${path}`
						: overrides.vectorKey,
				tagsVersion: overrides.tagsVersion ?? null,
				createdAt: new Date(0),
			})
			.run();
		return photo;
	}

	const tagsOf = (photoId: number) =>
		db
			.select({ tag: photoTags.tag, score: photoTags.score })
			.from(photoTags)
			.where(eq(photoTags.photoId, photoId))
			.all()
			.sort((left, right) => right.score - left.score);
	const tagsVersionOf = (photoId: number) =>
		db
			.select({ tagsVersion: photoEmbedding.tagsVersion })
			.from(photoEmbedding)
			.where(eq(photoEmbedding.photoId, photoId))
			.get()?.tagsVersion;

	function backfillHarness() {
		const checkpoints = new Map<string, unknown>();
		const steps: string[] = [];
		let beforeStep: ((id: string) => void) | undefined;
		const step: TagStep = {
			async run<T>(id: string, work: () => T | Promise<T>): Promise<T> {
				if (checkpoints.has(id)) return checkpoints.get(id) as T;
				beforeStep?.(id);
				const value = structuredClone(await work());
				checkpoints.set(id, value);
				steps.push(id);
				return value;
			},
		};
		return {
			steps,
			checkpoints,
			onStep: (hook: (id: string) => void) => {
				beforeStep = hook;
			},
			run: () => backfill.handler({ event: { data: {} }, step }),
		};
	}

	describe("vocabulary", () => {
		test("has unique lowercase hyphenated slugs including the contract minimum", () => {
			const slugs = TAG_VOCABULARY.map(({ tag }) => tag);
			expect(new Set(slugs).size).toBe(slugs.length);
			for (const slug of slugs)
				expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
			expect(slugs).toEqual(
				expect.arrayContaining([
					"beach",
					"mountain",
					"snow",
					"forest",
					"desert",
					"lake",
					"ocean",
					"waterfall",
					"sunset",
					"night-sky",
					"city",
					"street",
					"architecture",
					"interior",
					"garden",
					"flowers",
					"tree",
					"dog",
					"cat",
					"bird",
					"horse",
					"wildlife",
					"person",
					"group",
					"portrait",
					"selfie",
					"child",
					"baby",
					"wedding",
					"party",
					"concert",
					"sports",
					"food",
					"drink",
					"dessert",
					"car",
					"bicycle",
					"boat",
					"airplane",
					"train",
					"document",
					"screenshot",
					"receipt",
					"whiteboard",
					"text",
					"art",
					"statue",
					"museum",
					"church",
					"bridge",
					"road-trip",
					"camping",
					"hiking",
					"swimming",
					"skiing",
					"christmas",
					"birthday",
					"fireworks",
					"sky",
					"clouds",
					"rain",
					"landscape",
					"macro",
					"pet",
				]),
			);
		});

		test("label vectors are embedded lazily once per process and failures are retried", () => {
			textEmbeddingCalls = 0;
			failTextEmbedding = true;
			expect(() => loadTagLabelMatrix()).toThrow("text model unavailable");
			failTextEmbedding = false;
			textEmbeddingCalls = 0;
			const first = loadTagLabelMatrix();
			expect(textEmbeddingCalls).toBe(TAG_VOCABULARY.length);
			expect(loadTagLabelMatrix()).toBe(first);
			expect(textEmbeddingCalls).toBe(TAG_VOCABULARY.length);
			expect(first.tags).toEqual(TAG_VOCABULARY.map(({ tag }) => tag));
			expect(first.dimension).toBe(D);
		});
	});

	describe("scoreTags", () => {
		test("picks the label nearest a single-subject vector with its softmax probability", () => {
			expect(scoreTags(near(["dog"], 0.01), labels)).toEqual([
				{ tag: "dog", score: 1 },
			]);
		});

		test("splits probability between two nearby labels, highest first", () => {
			const vector = near(["beach", "sunset"]);
			const beach = tagIndex.get("beach") ?? -1;
			vector[beach] *= 1.01; // nudge beach ahead of sunset
			const tags = scoreTags(vector, labels);
			expect(tags.map(({ tag }) => tag)).toEqual(["beach", "sunset"]);
			expect(tags[0].score).toBeGreaterThan(tags[1].score);
			expect(tags[0].score + tags[1].score).toBeCloseTo(1, 3);
		});

		test("normalizes unnormalized image and label vectors (cosine, not dot product)", () => {
			const scaled = near(["cat"]).map((value) => value * 7);
			expect(scoreTags(scaled, labels)).toEqual([{ tag: "cat", score: 1 }]);
			const longLabels = createTagLabelMatrix([
				{ tag: "a", vector: [10, 0] },
				{ tag: "b", vector: [0, 0.1] },
			]);
			expect(scoreTags([1, 0], longLabels)).toEqual([{ tag: "a", score: 1 }]);
		});

		test("returns at most three labels with deterministic tag order on ties", () => {
			// Four equal labels: p = 0.25 each, all above threshold, keep 3 by slug.
			const tags = scoreTags(
				near(["train", "boat", "car", "airplane"]),
				labels,
			);
			expect(tags).toHaveLength(MAX_TAGS_PER_PHOTO);
			expect(tags).toEqual([
				{ tag: "airplane", score: 0.25 },
				{ tag: "boat", score: 0.25 },
				{ tag: "car", score: 0.25 },
			]);
			// Input order of the labels does not change the result.
			const reversed = createTagLabelMatrix(
				[...TAG_VOCABULARY]
					.reverse()
					.map(({ tag }) => ({ tag, vector: unit(tagIndex.get(tag) ?? 0) })),
			);
			expect(
				scoreTags(near(["train", "boat", "car", "airplane"]), reversed),
			).toEqual(tags);
		});

		test("applies TAG_MIN_PROBABILITY inclusively and drops diffuse vectors", () => {
			// Six equal labels: p = 1/6 >= 0.15; seven: 1/7 < 0.15.
			const six = ["beach", "ocean", "lake", "river", "sky", "clouds"];
			expect(1 / 6).toBeGreaterThanOrEqual(TAG_MIN_PROBABILITY);
			expect(1 / 7).toBeLessThan(TAG_MIN_PROBABILITY);
			expect(scoreTags(near(six), labels)).toHaveLength(3);
			expect(scoreTags(near([...six, "snow"]), labels)).toEqual([]);
			// A vector equidistant from every label tags nothing.
			expect(scoreTags(new Array(D).fill(1), labels)).toEqual([]);
			// Exactly at the threshold is kept.
			const atThreshold = createTagLabelMatrix([
				{ tag: "kept", vector: [1, 0] },
				{ tag: "other", vector: [0, 1] },
			]);
			const logit = Math.log(TAG_MIN_PROBABILITY / (1 - TAG_MIN_PROBABILITY));
			// p(kept) = sigmoid(100 * (x - y)); a unit vector with x - y = logit / 100.
			const delta = logit / 100;
			const root = Math.sqrt(2 - delta * delta);
			const x = (delta + root) / 2;
			const y = (root - delta) / 2;
			const scored = scoreTags([x, y], atThreshold);
			expect(scored[0].tag).toBe("other");
			expect(scored.find(({ tag }) => tag === "kept")?.score).toBeCloseTo(
				TAG_MIN_PROBABILITY,
				3,
			);
		});

		test("rounds scores to four decimals and rejects mismatched or zero vectors", () => {
			const [top] = scoreTags(near(["beach", "ocean"]), labels);
			expect(Math.round(top.score * 10_000) / 10_000).toBe(top.score);
			expect(scoreTags([1, 0, 0], labels)).toEqual([]);
			expect(scoreTags(new Array(D).fill(0), labels)).toEqual([]);
			expect(() =>
				createTagLabelMatrix([
					{ tag: "a", vector: [1, 0] },
					{ tag: "b", vector: [1] },
				]),
			).toThrow("share one dimension");
			expect(() =>
				createTagLabelMatrix([{ tag: "a", vector: [0, 0] }]),
			).toThrow("zero length");
		});

		test(`scores 8,000 x ${TAG_VOCABULARY.length} x 512 in under 2 s`, () => {
			let state = 0x9e3779b9;
			const random = () => {
				state ^= state << 13;
				state ^= state >>> 17;
				state ^= state << 5;
				return (state >>> 0) / 0x1_0000_0000 - 0.5;
			};
			const randomVector = () =>
				Float32Array.from({ length: 512 }, () => random());
			const matrix = createTagLabelMatrix(
				TAG_VOCABULARY.map(({ tag }) => ({ tag, vector: randomVector() })),
			);
			const images = Array.from({ length: 8_000 }, randomVector);
			const started = performance.now();
			let tagged = 0;
			for (const image of images) tagged += scoreTags(image, matrix).length;
			const elapsed = performance.now() - started;
			console.log(
				`${PERF_LOG_PREFIX} scoreTags 8,000 x ${TAG_VOCABULARY.length} labels x 512 dims: ${elapsed.toFixed(1)} ms (${tagged} tags)`,
			);
			expect(elapsed).toBeLessThan(perfBudgetMs(2_000));
		});
	});

	describe("saveEmbeddingBatch tagging", () => {
		test("writes tags and tags_version with the vector in the same save", () => {
			const photo = addPhoto("beach.jpg");
			expect(
				saveEmbeddingBatch(db, [photo], [near(["beach"], 0.01)], labels),
			).toEqual({ processed: 1, successful: 1 });
			expect(tagsOf(photo.id)).toEqual([{ tag: "beach", score: 1 }]);
			expect(tagsVersionOf(photo.id)).toBe(TAG_VOCABULARY_VERSION);
		});

		test("a failing tag write rolls back the vector and status (one transaction)", () => {
			const photo = addPhoto("atomic.jpg");
			// Duplicate slugs make the photo_tags primary key reject the insert.
			const duplicate = createTagLabelMatrix([
				{ tag: "beach", vector: [1, 0] },
				{ tag: "beach", vector: [1, 0] },
			]);
			expect(() =>
				saveEmbeddingBatch(db, [photo], [[1, 0]], duplicate),
			).toThrow(/UNIQUE constraint failed/);
			expect(db.select().from(photoEmbedding).all()).toEqual([]);
			expect(tagsOf(photo.id)).toEqual([]);
			expect(
				db.select().from(photos).where(eq(photos.id, photo.id)).get()
					?.embeddingStatus,
			).toBe("pending");
		});

		test("stale and failed results leave existing tags and tags_version untouched", () => {
			const photo = addPhoto("kept.jpg", "key-new");
			saveEmbeddingBatch(
				db,
				[{ id: photo.id, thumbnailKey: "key-new" }],
				[near(["dog"])],
				labels,
			);
			const before = tagsOf(photo.id);
			// Stale generation: result for an older thumbnail key.
			expect(
				saveEmbeddingBatch(
					db,
					[{ id: photo.id, thumbnailKey: "key-old" }],
					[near(["cat"])],
					labels,
				),
			).toEqual({ processed: 1, successful: 0 });
			expect(tagsOf(photo.id)).toEqual(before);
			// Failed inference for the current generation.
			expect(
				saveEmbeddingBatch(
					db,
					[{ id: photo.id, thumbnailKey: "key-new" }],
					[null],
					labels,
				),
			).toEqual({ processed: 1, successful: 0 });
			expect(tagsOf(photo.id)).toEqual(before);
			expect(tagsVersionOf(photo.id)).toBe(TAG_VOCABULARY_VERSION);
			expect(before).toEqual([{ tag: "dog", score: 1 }]);
		});

		test("re-embedding replaces old tags; without labels it clears them for backfill", () => {
			const photo = addPhoto("replace.jpg");
			saveEmbeddingBatch(db, [photo], [near(["dog", "cat"])], labels);
			expect(
				tagsOf(photo.id)
					.map(({ tag }) => tag)
					.sort(),
			).toEqual(["cat", "dog"]);
			saveEmbeddingBatch(db, [photo], [near(["food"])], labels);
			expect(tagsOf(photo.id)).toEqual([{ tag: "food", score: 1 }]);
			saveEmbeddingBatch(db, [photo], [near(["car"])], null);
			expect(tagsOf(photo.id)).toEqual([]);
			expect(tagsVersionOf(photo.id)).toBeNull();
			expect(readTagBackfillBatch(db, 0).map((row) => row.photoId)).toEqual([
				photo.id,
			]);
		});
	});

	describe("tag-photos-v1 backfill", () => {
		test("is a single-concurrency function on photos/tags.requested", () => {
			expect(backfill.options).toEqual({
				id: "tag-photos-v1",
				concurrency: { limit: 1 },
			});
			expect(backfill.trigger).toEqual({ event: "photos/tags.requested" });
		});

		test("tags only eligible rows and is idempotent", async () => {
			const eligible = addIndexedPhoto("eligible.jpg", near(["beach"]));
			const outdated = addIndexedPhoto("outdated.jpg", near(["dog"]), {
				tagsVersion: TAG_VOCABULARY_VERSION - 1,
			});
			const wrongModel = addIndexedPhoto("model.jpg", near(["cat"]), {
				modelVersion: "old-model",
			});
			const mismatched = addIndexedPhoto("key.jpg", near(["cat"]), {
				vectorKey: "key-older",
			});
			const failed = addIndexedPhoto("failed.jpg", near(["cat"]), {
				status: "failed",
			});
			const current = addIndexedPhoto("current.jpg", near(["cat"]), {
				tagsVersion: TAG_VOCABULARY_VERSION,
			});
			db.insert(photoTags)
				.values({ photoId: current.id, tag: "snow", score: 0.5 })
				.run();
			const run = backfillHarness();
			expect(await run.run()).toEqual({ tagged: 2 });
			expect(tagsOf(eligible.id)).toEqual([{ tag: "beach", score: 1 }]);
			expect(tagsOf(outdated.id)).toEqual([{ tag: "dog", score: 1 }]);
			for (const skipped of [wrongModel, mismatched, failed]) {
				expect(tagsOf(skipped.id)).toEqual([]);
				expect(tagsVersionOf(skipped.id)).toBeNull();
			}
			// Already-current rows keep their tags.
			expect(tagsOf(current.id)).toEqual([{ tag: "snow", score: 0.5 }]);

			const snapshot = db.select().from(photoTags).all();
			const again = backfillHarness();
			expect(await again.run()).toEqual({ tagged: 0 });
			expect(again.steps).toEqual(["tag-photos-batch-v1-0"]);
			expect(db.select().from(photoTags).all()).toEqual(snapshot);
		});

		test("processes more than 1,000 rows across bounded steps and replays from checkpoints", async () => {
			const COUNT = 2_345;
			sqlite.transaction(() => {
				for (let index = 0; index < COUNT; index++) {
					addIndexedPhoto(
						`bulk/${index}.jpg`,
						near([TAG_VOCABULARY[index % D].tag]),
					);
				}
			})();
			const run = backfillHarness();
			expect(await run.run()).toEqual({ tagged: COUNT });
			expect(run.steps).toEqual([
				"tag-photos-batch-v1-0",
				"tag-photos-batch-v1-1",
				"tag-photos-batch-v1-2",
			]);
			for (const value of run.checkpoints.values()) {
				expect((value as { read: number }).read).toBeLessThanOrEqual(
					TAG_BACKFILL_BATCH_SIZE,
				);
			}
			expect(
				sqlite
					.query<{ count: number }, []>(
						`SELECT count(*) AS count FROM photo_embedding WHERE tags_version = ${TAG_VOCABULARY_VERSION}`,
					)
					.get()?.count,
			).toBe(COUNT);
			expect(
				sqlite
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM photo_tags",
					)
					.get()?.count,
			).toBe(COUNT);
			// Replaying the same run reuses every checkpoint without new work.
			const steps = run.steps.length;
			expect(await run.run()).toEqual({ tagged: COUNT });
			expect(run.steps).toHaveLength(steps);
		});

		test("a generation change between read and write is skipped", async () => {
			const stale = addIndexedPhoto("stale.jpg", near(["beach"]));
			const steady = addIndexedPhoto("steady.jpg", near(["dog"]));
			const rows = readTagBackfillBatch(db, 0);
			expect(rows.map((row) => row.photoId)).toEqual([stale.id, steady.id]);
			// A rescan commits a new thumbnail generation before the backfill writes.
			db.update(photos)
				.set({ thumbnailKey: "key-rescanned", embeddingStatus: "pending" })
				.where(eq(photos.id, stale.id))
				.run();
			expect(
				saveTagBatch(
					db,
					rows.map(({ photoId, thumbnailKey }) => ({
						photoId,
						thumbnailKey,
						tags: [{ tag: "beach", score: 1 }],
					})),
				),
			).toBe(1);
			expect(tagsOf(stale.id)).toEqual([]);
			expect(tagsVersionOf(stale.id)).toBeNull();
			expect(tagsOf(steady.id)).toEqual([{ tag: "beach", score: 1 }]);

			// A newer embedding save between read and write also wins.
			const raced = addIndexedPhoto("raced.jpg", near(["beach"]));
			const pending = readTagBackfillBatch(db, steady.id);
			saveEmbeddingBatch(db, [raced], [near(["food"])], labels);
			expect(
				saveTagBatch(db, [
					{ ...pending[0], tags: [{ tag: "beach", score: 1 }] },
				]),
			).toBe(0);
			expect(tagsOf(raced.id)).toEqual([{ tag: "food", score: 1 }]);
		});

		test("tagPhotoBatch advances its keyset cursor even when rows are skipped", () => {
			const first = addIndexedPhoto("a.jpg", near(["beach"]));
			const second = addIndexedPhoto("b.jpg", near(["dog"]));
			expect(tagPhotoBatch(db, labels, 0, 1)).toEqual({
				read: 1,
				tagged: 1,
				cursor: first.id,
			});
			expect(tagPhotoBatch(db, labels, first.id, 1)).toEqual({
				read: 1,
				tagged: 1,
				cursor: second.id,
			});
			expect(tagPhotoBatch(db, labels, second.id, 1)).toEqual({
				read: 0,
				tagged: 0,
				cursor: second.id,
			});
		});
	});

	describe("tag filters and options", () => {
		let ids: Record<string, number>;
		beforeEach(() => {
			ids = {};
			for (const [name, path, tags] of [
				["beachA", "trips/beach-a.jpg", ["beach", "ocean"]],
				["beachB", "trips/beach-b.jpg", ["beach"]],
				["nestedBeach", "trips/nested/beach-c.jpg", ["beach", "sunset"]],
				["dog", "home/dog.jpg", ["dog"]],
				["plain", "home/plain.jpg", ["food"]],
			] as const) {
				const photo = addIndexedPhoto(path, near(tags), {
					tagsVersion: TAG_VOCABULARY_VERSION,
				});
				ids[name] = photo.id;
				db.insert(photoTags)
					.values(
						tags.map((tag, index) => ({
							photoId: photo.id,
							tag,
							score: index === 0 ? 0.8 : 0.2,
						})),
					)
					.run();
			}
		});
		const sortedIds = (result: { photos: Array<{ id: number }> }) =>
			result.photos
				.map((photo) => photo.id)
				.sort((left, right) => left - right);

		test("listPhotos, tRPC photos and v1 photos filter by tag and compose with folder", async () => {
			const expected = [ids.beachA, ids.beachB, ids.nestedBeach].sort(
				(left, right) => left - right,
			);
			expect(sortedIds(await listPhotos(db, { tag: "beach" }))).toEqual(
				expected,
			);
			expect(sortedIds(await caller.photos({ tag: "beach" }))).toEqual(
				expected,
			);
			expect(
				sortedIds(await listPhotos(db, { tag: "beach", folder: "trips" })),
			).toEqual([ids.beachA, ids.beachB]);
			expect((await listPhotos(db, { tag: "unknown-tag" })).total).toBe(0);
			const response = await app.request(
				"/api/v1/photos?tag=beach&folder=trips",
			);
			expect(response.status).toBe(200);
			expect(
				sortedIds((await response.json()) as { photos: { id: number }[] }),
			).toEqual([ids.beachA, ids.beachB]);
			for (const invalid of ["Beach", "night_sky", "-beach", "a".repeat(65)]) {
				expect(
					(await app.request(`/api/v1/photos?tag=${invalid}`)).status,
				).toBe(400);
				await expect(caller.photos({ tag: invalid })).rejects.toThrow();
			}
		});

		test("semantic search honors tag over real sqlite-vec vectors (tRPC and v1)", async () => {
			queryVector = near(["dog"]);
			const unfiltered = await caller.searchPhotos({ query: "dog", limit: 2 });
			expect(unfiltered.photos[0].id).toBe(ids.dog);
			const filtered = await caller.searchPhotos({
				query: "dog",
				limit: 2,
				tag: "beach",
			});
			expect(filtered.photos).toHaveLength(2);
			expect(
				filtered.photos.every((photo) =>
					[ids.beachA, ids.beachB, ids.nestedBeach].includes(photo.id),
				),
			).toBe(true);
			const response = await app.request("/api/v1/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: "dog", limit: 10, tag: "sunset" }),
			});
			expect(response.status).toBe(200);
			expect(
				((await response.json()) as { photos: { id: number }[] }).photos.map(
					(photo) => photo.id,
				),
			).toEqual([ids.nestedBeach]);
		});

		test("similar photos honor tag (tRPC and v1)", async () => {
			const result = await findSimilarToPhoto(db, ids.beachA, 10, {
				tag: "beach",
			});
			expect(result?.photos.map((photo) => photo.id).sort()).toEqual(
				[ids.beachB, ids.nestedBeach].sort(),
			);
			const viaTrpc = await caller.similarPhotos({
				photoId: ids.dog,
				tag: "food",
			});
			expect(viaTrpc.photos.map((photo) => photo.id)).toEqual([ids.plain]);
			const response = await app.request(
				`/api/v1/photos/${ids.beachA}/similar?tag=dog`,
			);
			expect(response.status).toBe(200);
			expect(
				((await response.json()) as { photos: { id: number }[] }).photos.map(
					(photo) => photo.id,
				),
			).toEqual([ids.dog]);
		});

		test("filterOptions tag counts follow folder scope and sort by count then tag", async () => {
			expect((await listFilterOptions(db)).tags).toEqual([
				{ tag: "beach", count: 3 },
				{ tag: "dog", count: 1 },
				{ tag: "food", count: 1 },
				{ tag: "ocean", count: 1 },
				{ tag: "sunset", count: 1 },
			]);
			expect((await caller.filterOptions({ folder: "trips" })).tags).toEqual([
				{ tag: "beach", count: 3 },
				{ tag: "ocean", count: 1 },
				{ tag: "sunset", count: 1 },
			]);
			const response = await app.request("/api/v1/filter-options?folder=home");
			expect(response.status).toBe(200);
			expect(((await response.json()) as { tags: unknown }).tags).toEqual([
				{ tag: "dog", count: 1 },
				{ tag: "food", count: 1 },
			]);
			db.delete(photoTags).run();
			expect((await listFilterOptions(db)).tags).toEqual([]);
		});

		test("photoTags and GET /photos/:id/tags return score-ordered tags or 404", async () => {
			expect(await caller.photoTags({ photoId: ids.beachA })).toEqual({
				tags: [
					{ tag: "beach", score: 0.8 },
					{ tag: "ocean", score: 0.2 },
				],
			});
			const untagged = addPhoto("untagged.jpg");
			expect(await caller.photoTags({ photoId: untagged.id })).toEqual({
				tags: [],
			});
			await expect(
				caller.photoTags({ photoId: 999_999 }),
			).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			const ok = await app.request(`/api/v1/photos/${ids.nestedBeach}/tags`);
			expect(ok.status).toBe(200);
			expect(await ok.json()).toEqual({
				tags: [
					{ tag: "beach", score: 0.8 },
					{ tag: "sunset", score: 0.2 },
				],
			});
			const missing = await app.request("/api/v1/photos/999999/tags");
			expect(missing.status).toBe(404);
			expect(await missing.json()).toEqual({
				error: { code: "PHOTO_NOT_FOUND", message: "Photo not found" },
			});
			expect((await app.request("/api/v1/photos/abc/tags")).status).toBe(400);
		});

		test("deleting a photo cascades to its tags", () => {
			sqlite.run("PRAGMA foreign_keys = ON");
			db.delete(photos).where(eq(photos.id, ids.dog)).run();
			expect(tagsOf(ids.dog)).toEqual([]);
		});
	});

	test("tag-filtered listPhotos over 8,000 photos resolves through the (tag, photo_id) index", async () => {
		const COUNT = 8_000;
		const insertPhoto = sqlite.prepare(
			`INSERT INTO photos (path, name, size, created_at, modified_at, embedding_status)
			 VALUES (?, ?, 1, 0, 0, 'completed') RETURNING id`,
		);
		const insertTag = sqlite.prepare(
			"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, ?, ?)",
		);
		sqlite.transaction(() => {
			for (let index = 0; index < COUNT; index++) {
				const { id } = insertPhoto.get(`perf/${index}.jpg`, `${index}.jpg`) as {
					id: number;
				};
				for (let slot = 0; slot < 3; slot++) {
					insertTag.run(id, TAG_VOCABULARY[(index + slot * 7) % D].tag, 0.3);
				}
			}
		})();
		sqlite.run("ANALYZE");
		const statements: string[] = [];
		const original = sqlite.prepare;
		sqlite.prepare = ((...args: Parameters<typeof original>) => {
			statements.push(args[0]);
			return original.apply(sqlite, args);
		}) as typeof original;
		try {
			await listPhotos(db, { tag: "beach" });
		} finally {
			sqlite.prepare = original;
		}
		const listing = statements.find((statement) =>
			/from "photos"/i.test(statement),
		);
		if (!listing) throw new Error("listPhotos statement not captured");
		const plan = sqlite
			.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${listing}`)
			.all()
			.map((row) => row.detail)
			.join("\n");
		expect(plan).toMatch(
			/SEARCH photo_tags USING (COVERING )?INDEX idx_photo_tags_tag_photo_id \(tag=\?\)/,
		);
		expect(plan).not.toMatch(/SCAN photos(\s|$)/m);

		const started = performance.now();
		const result = await listPhotos(db, { tag: "beach" });
		const elapsed = performance.now() - started;
		const expected = sqlite
			.query<{ count: number }, []>(
				"SELECT count(*) AS count FROM photo_tags WHERE tag = 'beach'",
			)
			.get()?.count;
		expect(result.total).toBe(expected ?? -1);
		console.log(
			`${PERF_LOG_PREFIX} listPhotos tag over ${COUNT} photos (${result.total} rows, incl. EXIF hydration): ${elapsed.toFixed(2)} ms\n${plan}`,
		);

		// Full backfill throughput over the same order of magnitude of real BLOBs.
		db.delete(photoTags).run();
		db.delete(photos).run();
		const insertVector = sqlite.prepare(
			`INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at)
			 VALUES (?, ?, ?, NULL, 0)`,
		);
		sqlite.transaction(() => {
			for (let index = 0; index < COUNT; index++) {
				const { id } = insertPhoto.get(`perf/${index}.jpg`, `${index}.jpg`) as {
					id: number;
				};
				insertVector.run(
					id,
					Buffer.from(
						new Float32Array(near([TAG_VOCABULARY[index % D].tag])).buffer,
					),
					EMBEDDING_MODEL_VERSION,
				);
			}
		})();
		const backfillStarted = performance.now();
		const run = backfillHarness();
		expect(await run.run()).toEqual({ tagged: COUNT });
		console.log(
			`${PERF_LOG_PREFIX} tag-photos-v1 backfill of ${COUNT} vectors (${run.steps.length} steps, read+score+write): ${(performance.now() - backfillStarted).toFixed(1)} ms`,
		);
	}, 60_000);

	describe("migration 0009", () => {
		test("applies on a database migrated to 0008 with rows and keeps data", () => {
			const sql = readFileSync(
				join(MIGRATIONS_FOLDER, "0009_photo_tags.sql"),
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
				const tagsIndex = journal.entries.findIndex((entry) =>
					entry.tag.startsWith("0009_"),
				);
				expect(tagsIndex).toBeGreaterThan(0);
				expect(journal.entries[tagsIndex - 1].tag).toStartWith("0008_");
				writeFileSync(
					journalPath,
					JSON.stringify({
						...journal,
						entries: journal.entries.slice(0, tagsIndex),
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
				expect(tables()).not.toContain("photo_tags");
				legacy.run(
					`INSERT INTO photos (id, path, name, size, created_at, modified_at, thumbnail_key, rating, flag)
					 VALUES (7, 'a/one.jpg', 'one.jpg', 1, 0, 0, 'key-one', 4, 'pick'),
					        (9, 'a/two.jpg', 'two.jpg', 2, 0, 0, 'key-two', 0, NULL)`,
				);
				legacy.run(
					"INSERT INTO photo_exif (photo_id, camera_make) VALUES (7, 'Sony')",
				);
				legacy.run(
					`INSERT INTO photo_embedding (id, photo_id, embedding, model_version, thumbnail_key, created_at)
					 VALUES (3, 9, X'0000803F', 'clip-vit-b32', 'key-two', 0)`,
				);
				legacy.run(
					"INSERT INTO collections (id, name, created_at, updated_at) VALUES (1, 'Trip', 0, 0)",
				);
				legacy.run(
					"INSERT INTO collection_photos (collection_id, photo_id, added_at) VALUES (1, 7, 0)",
				);
				const snapshot = () => ({
					photos: legacy.query("SELECT * FROM photos ORDER BY id").all(),
					exif: legacy.query("SELECT * FROM photo_exif").all(),
					collections: legacy.query("SELECT * FROM collection_photos").all(),
				});
				const before = snapshot();
				const embeddingsBefore = legacy
					.query<Record<string, unknown>, []>("SELECT * FROM photo_embedding")
					.all();

				// Stop at 0009 so later migrations' additive columns stay out of this check.
				writeFileSync(
					journalPath,
					JSON.stringify({
						...journal,
						entries: journal.entries.slice(0, tagsIndex + 1),
					}),
				);
				migrate(legacyDb, { migrationsFolder: partial });

				expect(snapshot()).toEqual(before);
				expect(legacy.query("SELECT * FROM photo_embedding").all()).toEqual(
					embeddingsBefore.map((row) => ({ ...row, tags_version: null })),
				);
				expect(tables()).toContain("photo_tags");
				expect(
					legacy
						.query<{ name: string }, []>(
							"SELECT name FROM pragma_index_list('photo_tags') ORDER BY name",
						)
						.all()
						.map((row) => row.name),
				).toContain("idx_photo_tags_tag_photo_id");
				expect(
					legacy
						.query<{ table: string; on_delete: string }, []>(
							"SELECT \"table\", on_delete FROM pragma_foreign_key_list('photo_tags')",
						)
						.all(),
				).toEqual([{ table: "photos", on_delete: "CASCADE" }]);
				// Existing vectors become eligible for the backfill.
				expect(
					readTagBackfillBatch(
						legacyDb as unknown as Parameters<typeof readTagBackfillBatch>[0],
						0,
					),
				).toEqual([]);
				legacy.run(
					"UPDATE photos SET embedding_status = 'completed' WHERE id = 9",
				);
				expect(
					readTagBackfillBatch(
						legacyDb as unknown as Parameters<typeof readTagBackfillBatch>[0],
						0,
					).map((row) => row.photoId),
				).toEqual([9]);
				legacy.run(
					"INSERT INTO photo_tags (photo_id, tag, score) VALUES (9, 'beach', 0.9)",
				);
				expect(() =>
					legacy.run(
						"INSERT INTO photo_tags (photo_id, tag, score) VALUES (9, 'beach', 0.5)",
					),
				).toThrow(/UNIQUE constraint failed/);
				legacy.close();
			} finally {
				rmSync(partial, { recursive: true, force: true });
			}
		});
	});
}
