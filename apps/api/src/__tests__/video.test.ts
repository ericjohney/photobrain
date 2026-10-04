import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { NearDuplicateGroup } from "@photobrain/image-processing";
import { Hono } from "hono";
import * as sqliteVec from "sqlite-vec";
import { parseByteRange } from "../services/byte-range";
import {
	EMBEDDING_MODEL_VERSION,
	QUALITY_VERSION,
} from "../services/processing-versions";
import { createTestDb } from "./setup";

describe("parseByteRange", () => {
	test.each([
		["bytes=0-99", 1000, { kind: "partial", start: 0, end: 99 }],
		["bytes=10-10", 1000, { kind: "partial", start: 10, end: 10 }],
		["bytes=900-", 1000, { kind: "partial", start: 900, end: 999 }],
		["bytes=-100", 1000, { kind: "partial", start: 900, end: 999 }],
		// A suffix longer than the body selects all of it.
		["bytes=-5000", 1000, { kind: "partial", start: 0, end: 999 }],
		// The end clamps to size - 1.
		["bytes=500-99999", 1000, { kind: "partial", start: 500, end: 999 }],
		["bytes=999-999", 1000, { kind: "partial", start: 999, end: 999 }],
		["Bytes = 1 - 2", 1000, { kind: "partial", start: 1, end: 2 }],
		["bytes=-0", 1000, { kind: "unsatisfiable" }],
		["bytes=1000-", 1000, { kind: "unsatisfiable" }],
		["bytes=1000-1001", 1000, { kind: "unsatisfiable" }],
		["bytes=0-", 0, { kind: "unsatisfiable" }],
		["bytes=-1", 0, { kind: "unsatisfiable" }],
		// Multiple ranges, other units, inverted bounds and garbage: full body.
		["bytes=0-1,5-6", 1000, { kind: "full" }],
		["items=0-1", 1000, { kind: "full" }],
		["bytes=5-1", 1000, { kind: "full" }],
		["bytes=-", 1000, { kind: "full" }],
		["bytes=a-b", 1000, { kind: "full" }],
		["garbage", 1000, { kind: "full" }],
		["", 1000, { kind: "full" }],
		[undefined, 1000, { kind: "full" }],
	] as const)("%p of %d bytes", (header, size, expected) => {
		expect(parseByteRange(header, size)).toEqual(expected);
	});
});

const CHILD_ENV = "PHOTOBRAIN_VIDEO_TEST_CHILD";

// Mocks of ../db, ../config, the native addon and the Inngest client are
// process-wide; run the real modules in an isolated child like the pairs suite.
if (process.env[CHILD_ENV] !== "1") {
	test("video: Live Photo stacking, filters, exclusions, smart albums and Range file route", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, [CHILD_ENV]: "1" },
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
	const sqliteLibrary = "/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib";
	if (existsSync(sqliteLibrary)) Database.setCustomSQLite(sqliteLibrary);
	const { db, sqlite } = createTestDb();
	sqliteVec.load(sqlite);
	const photoRoot = mkdtempSync(join(tmpdir(), "photobrain-video-"));
	const thumbnailRoot = join(photoRoot, ".thumbnails");

	function equalHashGrouper(
		ids: number[],
		hashes: string[],
	): NearDuplicateGroup[] {
		const byHash = new Map<string, number[]>();
		ids.forEach((id, index) => {
			byHash.set(hashes[index], [...(byHash.get(hashes[index]) ?? []), id]);
		});
		return [...byHash.values()]
			.filter((members) => members.length >= 2)
			.map((members) => ({
				ids: members.sort((a, b) => a - b),
				maxDistance: 0,
			}));
	}

	mock.module("../db", () => ({ db }));
	mock.module("../config", () => ({
		config: {
			PHOTO_DIRECTORY: photoRoot,
			THUMBNAILS_DIRECTORY: thumbnailRoot,
		},
	}));
	mock.module("@photobrain/image-processing", () => ({
		clipTextEmbedding: () => [1, 0, 0, 0],
		groupNearDuplicates: equalHashGrouper,
	}));
	mock.module("../inngest/client", () => ({
		inngest: { send: async () => undefined },
	}));
	mock.module("../services/native-executor", () => ({
		nativeExecutor: { run: async () => undefined },
	}));
	// Static imports would load the real addon, database and config before
	// these mocks are installed (intentional boundary).
	const { getPhoto, listFolders, listPhotos, listPhotoLocations } =
		await import("../services/photo-catalog");
	const { searchPhotosByText, findSimilarToPhoto } = await import(
		"../services/vector-search"
	);
	const { gearStats } = await import("../services/gear-stats");
	const { junkReview } = await import("../services/junk-review");
	const { readQualityBackfillBatch } = await import(
		"../services/photo-quality"
	);
	const { duplicateGroups } = await import("../services/duplicates");
	const { createSmartAlbum, listSmartAlbums, canonicalizeSmartAlbumFilters } =
		await import("../services/smart-albums");
	const { appRouter } = await import("../trpc/router");
	const { default: photosRouter } = await import("../routes/photos");
	const caller = appRouter.createCaller({ db });
	const app = new Hono().route("/api/photos", photosRouter);

	afterAll(() => {
		sqlite.close();
		rmSync(photoRoot, { recursive: true, force: true });
	});
	beforeEach(() => {
		for (const table of [
			"smart_albums",
			"photo_embedding",
			"photo_quality",
			"photo_phash",
			"photo_exif",
			"photos",
		]) {
			sqlite.run(`DELETE FROM ${table}`);
		}
	});

	type MediaOptions = {
		durationMs?: number | null;
		dateTaken?: string;
		camera?: [string, string];
		gps?: [number, number];
		hash?: string;
		sharpness?: number;
	};
	let counter = 0;
	const VIDEO = /\.(mov|mp4|m4v)$/i;
	const RAW = /\.(arw|cr2|nef|dng)$/i;
	/** Inserts a completed row; `.mov/.mp4/.m4v` paths are videos (default 30 s). */
	function add(path: string, options: MediaOptions = {}): number {
		const key = `key-${++counter}`;
		const video = VIDEO.test(path);
		const raw = RAW.test(path);
		const { id } = sqlite
			.query<{ id: number }, (string | number | null)[]>(
				`INSERT INTO photos (path, name, size, created_at, modified_at, mime_type, media_type, duration_ms, video_codec, is_raw, raw_format, rating, embedding_status, thumbnail_status, thumbnail_key)
				 VALUES (?1, ?2, 1, 0, 0, ?3, ?4, ?5, ?6, ?7, ?8, 0, 'completed', 'completed', ?9) RETURNING id`,
			)
			.get(
				path,
				path.slice(path.lastIndexOf("/") + 1),
				video ? "video/quicktime" : raw ? "image/x-sony-arw" : "image/jpeg",
				video ? "video" : "photo",
				video
					? options.durationMs === undefined
						? 30_000
						: options.durationMs
					: null,
				video ? "hevc" : null,
				raw ? 1 : 0,
				raw ? "ARW" : null,
				key,
			) as { id: number };
		sqlite.run(
			"INSERT INTO photo_exif (photo_id, camera_make, camera_model, date_taken, gps_latitude, gps_longitude) VALUES (?, ?, ?, ?, ?, ?)",
			[
				id,
				options.camera?.[0] ?? "Apple",
				options.camera?.[1] ?? "iPhone 15",
				options.dateTaken ?? "2024:05:01 10:00:00",
				options.gps ? String(options.gps[0]) : null,
				options.gps ? String(options.gps[1]) : null,
			],
		);
		sqlite.run(
			"INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, created_at) VALUES (?, ?, ?, ?, 0)",
			[
				id,
				Buffer.from(new Float32Array([1, 0, 0, 0]).buffer),
				EMBEDDING_MODEL_VERSION,
				key,
			],
		);
		if (options.hash !== undefined) {
			sqlite.run(
				"INSERT INTO photo_phash (photo_id, hash, created_at) VALUES (?, ?, 0)",
				[id, options.hash],
			);
		}
		if (options.sharpness !== undefined) {
			sqlite.run(
				"INSERT INTO photo_quality (photo_id, sharpness, brightness, thumbnail_key, quality_version) VALUES (?, ?, 128, ?, ?)",
				[id, options.sharpness, key, QUALITY_VERSION],
			);
		}
		return id;
	}

	const ids = (rows: readonly { id: number }[]) =>
		rows.map((row) => row.id).sort((a, b) => a - b);
	const listed = async (filterRaw?: "all" | "raw" | "standard" | "video") =>
		ids((await listPhotos(db, filterRaw ? { filterRaw } : {})).photos);
	const motionOf = async (id: number) =>
		(await getPhoto(db, id))?.motionVideoId;

	describe("Live Photo stacking", () => {
		test("HEIC + MOV within 4 s stacks the clip and exposes motionVideoId", async () => {
			const still = add("trip/IMG_1.HEIC");
			const clip = add("trip/img_1.mov", { durationMs: 4_000 });
			expect(await listed()).toEqual([still]);
			expect(await motionOf(still)).toBe(clip);
			expect(await motionOf(clip)).toBeNull();
			// The clip is still fetchable by ID.
			expect(await getPhoto(db, clip)).toMatchObject({
				id: clip,
				mediaType: "video",
				durationMs: 4_000,
				videoCodec: "hevc",
			});
		});

		test("a 4001 ms clip is an ordinary video", async () => {
			const still = add("trip/IMG_2.HEIC");
			const clip = add("trip/IMG_2.MOV", { durationMs: 4_001 });
			expect(await listed()).toEqual([still, clip]);
			expect(await motionOf(still)).toBeNull();
			expect(await listed("video")).toEqual([clip]);
		});

		test("a short video without duration, in another folder, or beside two plain stills does not stack", async () => {
			const unknown = add("a/IMG_3.MOV", { durationMs: null });
			const unknownStill = add("a/IMG_3.JPG");
			const otherFolderStill = add("b/IMG_4.JPG");
			const otherFolderClip = add("c/IMG_4.MOV", { durationMs: 2_000 });
			const heic = add("d/IMG_5.HEIC");
			const jpg = add("d/IMG_5.JPG");
			const ambiguous = add("d/IMG_5.MOV", { durationMs: 2_000 });
			expect(await listed()).toEqual(
				[
					unknown,
					unknownStill,
					otherFolderStill,
					otherFolderClip,
					heic,
					jpg,
					ambiguous,
				].sort((a, b) => a - b),
			);
			for (const still of [unknownStill, otherFolderStill, heic, jpg]) {
				expect(await motionOf(still)).toBeNull();
			}
		});

		test("two short videos with one still make the moment ambiguous", async () => {
			const still = add("e/IMG_6.HEIC");
			const mov = add("e/IMG_6.MOV", { durationMs: 2_000 });
			const mp4 = add("e/IMG_6.MP4", { durationMs: 2_000 });
			expect(await listed()).toEqual([still, mov, mp4]);
			expect(await motionOf(still)).toBeNull();
		});

		test("RAW + JPEG + MOV: the RAW stacks under the JPEG, which owns the clip", async () => {
			const jpg = add("f/DSC_7.JPG");
			const raw = add("f/DSC_7.ARW");
			const clip = add("f/DSC_7.MOV", { durationMs: 1_500 });
			expect(await listed()).toEqual([jpg]);
			expect(await getPhoto(db, jpg)).toMatchObject({
				pairedPhotoId: raw,
				pairedFormat: "ARW",
				motionVideoId: clip,
			});
			expect(await getPhoto(db, raw)).toMatchObject({
				pairedPhotoId: jpg,
				motionVideoId: null,
			});
			expect(await listed("raw")).toEqual([raw]);
			expect(await listed("standard")).toEqual([jpg]);
			expect(await listed("video")).toEqual([]);
		});

		test("a lone RAW owns its clip", async () => {
			const raw = add("g/DSC_8.ARW");
			const clip = add("g/DSC_8.MOV", { durationMs: 3_000 });
			expect(await listed()).toEqual([raw]);
			expect(await motionOf(raw)).toBe(clip);
		});
	});

	describe("filterRaw", () => {
		test("raw, standard, video and all partition stills and videos, excluding motion clips", async () => {
			const raw = add("h/A.ARW");
			const jpg = add("h/B.JPG");
			const live = add("h/C.HEIC");
			add("h/C.MOV", { durationMs: 2_000 });
			const video = add("h/D.MP4", { durationMs: 60_000 });
			const shortVideo = add("h/E.M4V", { durationMs: 1_000 });
			expect(await listed("raw")).toEqual([raw]);
			expect(await listed("standard")).toEqual([jpg, live]);
			expect(await listed("video")).toEqual([video, shortVideo]);
			expect(await listed("all")).toEqual([raw, jpg, live, video, shortVideo]);
			expect(await listed()).toEqual(await listed("all"));
			const viaTrpc = await caller.photos({ filterRaw: "video" });
			expect(ids(viaTrpc.photos)).toEqual([video, shortVideo]);
		});

		test("tRPC rejects an unknown type filter", async () => {
			await expect(
				caller.photos({ filterRaw: "movie" as unknown as "video" }),
			).rejects.toThrow();
		});
	});

	describe("consumers inherit motion-clip stacking", () => {
		test("folder counts, gear stats, search, similar and map exclude motion clips", async () => {
			const still = add("trip/IMG_1.HEIC", { gps: [48.85, 2.35] });
			const clip = add("trip/IMG_1.MOV", {
				durationMs: 2_000,
				gps: [48.85, 2.35],
			});
			const video = add("trip/VID_2.MP4", { gps: [48.86, 2.36] });
			const folders = await listFolders(db);
			expect(folders.totalPhotos).toBe(2);
			expect(folders.folders).toEqual([
				{ name: "trip", path: "trip", photoCount: 2, children: [] },
			]);
			expect(gearStats(db).total).toBe(2);
			expect(gearStats(db, { filterRaw: "video" }).total).toBe(1);
			expect(ids(await searchPhotosByText(db, "beach", 10))).toEqual([
				still,
				video,
			]);
			expect(
				ids(await searchPhotosByText(db, "beach", 10, { filterRaw: "video" })),
			).toEqual([video]);
			const similar = await findSimilarToPhoto(db, still, 10);
			expect(similar && ids(similar.photos)).toEqual([video]);
			expect(listPhotoLocations(db).points.map((point) => point.id)).toEqual([
				still,
				video,
			]);
			expect(clip).toBeGreaterThan(0);
		});
	});

	describe("analysis exclusions", () => {
		test("videos are never junk candidates, quality backfill input, or duplicate/burst members", async () => {
			const blurryStill = add("j/A.JPG", { sharpness: 1, hash: "same" });
			add("j/B.MP4", { sharpness: 1, hash: "same" });
			add("j/C.MOV", { durationMs: 2_000, sharpness: 1, hash: "same" });
			const pendingStill = add("j/D.JPG");
			add("j/E.MP4");
			const junk = await junkReview(db);
			expect(ids(junk.photos)).toEqual([blurryStill]);
			expect(junk.counts.blurry).toBe(1);
			expect(readQualityBackfillBatch(db, 0).map((row) => row.photoId)).toEqual(
				[pendingStill],
			);
			const groups = await duplicateGroups(db, {}, equalHashGrouper);
			expect(groups.groups).toEqual([]);
		});

		test("burst detection ignores videos with consecutive capture times", async () => {
			const stills = [0, 1, 2].map((second) =>
				add(`k/S${second}.JPG`, {
					dateTaken: `2024:05:01 10:00:0${second}`,
					hash: `still-${second}`,
				}),
			);
			for (const second of [3, 4, 5]) {
				add(`k/V${second}.MP4`, {
					dateTaken: `2024:05:01 10:00:0${second}`,
					hash: `video-${second}`,
				});
			}
			const { groups } = await duplicateGroups(
				db,
				{ kind: "burst" },
				equalHashGrouper,
			);
			expect(
				groups.map((group) => group.photos.map((photo) => photo.id)),
			).toEqual([stills]);
		});
	});

	describe("smart albums", () => {
		test("accept and evaluate filterRaw video; reject unknown values", async () => {
			add("m/A.JPG");
			const video = add("m/B.MP4");
			add("m/C.HEIC");
			add("m/C.MOV", { durationMs: 2_000 });
			expect(canonicalizeSmartAlbumFilters({ filterRaw: "video" })).toEqual({
				filterRaw: "video",
			});
			const album = createSmartAlbum(db, {
				name: "Videos",
				filters: { filterRaw: "video" },
			});
			expect(album.filters).toEqual({ filterRaw: "video" });
			const [listedAlbum] = listSmartAlbums(db);
			expect(listedAlbum.photoCount).toBe(1);
			expect(listedAlbum.cover?.photoId).toBe(video);
			expect(() =>
				canonicalizeSmartAlbumFilters({
					filterRaw: "movie" as unknown as "video",
				}),
			).toThrow();
			expect(() =>
				createSmartAlbum(db, {
					name: "Bad",
					filters: { filterRaw: "live" as unknown as "video" },
				}),
			).toThrow();
			expect(listSmartAlbums(db)).toHaveLength(1);
		});
	});

	describe("GET /api/photos/:id/file", () => {
		const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);
		function sourceFile(path: string) {
			const file = join(photoRoot, path);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, bytes);
		}
		const get = (
			id: number,
			headers: Record<string, string> = {},
			method = "GET",
		) => app.request(`/api/photos/${id}/file`, { method, headers });

		test("200 full body advertises Accept-Ranges with the video MIME type", async () => {
			sourceFile("v/clip.mov");
			const id = add("v/clip.mov");
			const response = await get(id);
			expect(response.status).toBe(200);
			expect(response.headers.get("accept-ranges")).toBe("bytes");
			expect(response.headers.get("content-type")).toBe("video/quicktime");
			expect(response.headers.get("content-length")).toBe("1000");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		});

		test.each([
			["bytes=100-199", 100, 199],
			["bytes=990-", 990, 999],
			["bytes=-10", 990, 999],
			["bytes=995-5000", 995, 999],
		])("206 for %s returns the exact slice", async (range, start, end) => {
			sourceFile("v/seek.mov");
			const id = add("v/seek.mov");
			const response = await get(id, { Range: range });
			expect(response.status).toBe(206);
			expect(response.headers.get("content-range")).toBe(
				`bytes ${start}-${end}/1000`,
			);
			expect(response.headers.get("content-length")).toBe(
				String(end - start + 1),
			);
			expect(response.headers.get("accept-ranges")).toBe("bytes");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				bytes.slice(start, end + 1),
			);
		});

		test("416 for a start beyond the size; multi-range and garbage get the full body", async () => {
			sourceFile("v/edge.mp4");
			const id = add("v/edge.mp4");
			const beyond = await get(id, { Range: "bytes=1000-" });
			expect(beyond.status).toBe(416);
			expect(beyond.headers.get("content-range")).toBe("bytes */1000");
			expect((await beyond.arrayBuffer()).byteLength).toBe(0);
			for (const range of ["bytes=0-1,4-5", "nonsense"]) {
				const response = await get(id, { Range: range });
				expect(response.status).toBe(200);
				expect((await response.arrayBuffer()).byteLength).toBe(1000);
			}
		});

		test("HEAD reports headers without a body, including for ranges", async () => {
			sourceFile("v/head.mov");
			const id = add("v/head.mov");
			const full = await get(id, {}, "HEAD");
			expect(full.status).toBe(200);
			expect(full.headers.get("content-length")).toBe("1000");
			expect(full.headers.get("accept-ranges")).toBe("bytes");
			expect((await full.arrayBuffer()).byteLength).toBe(0);
			const partial = await get(id, { Range: "bytes=0-9" }, "HEAD");
			expect(partial.status).toBe(206);
			expect(partial.headers.get("content-range")).toBe("bytes 0-9/1000");
			expect((await partial.arrayBuffer()).byteLength).toBe(0);
		});

		test("a motion clip is served by ID; a RAW still serves its large WebP with Range", async () => {
			sourceFile("w/IMG_1.MOV");
			add("w/IMG_1.HEIC");
			const clip = add("w/IMG_1.MOV", { durationMs: 2_000 });
			expect((await get(clip, { Range: "bytes=0-3" })).status).toBe(206);

			const raw = add("w/DSC_2.ARW");
			sqlite.run(
				"UPDATE photos SET raw_status = 'converted', thumbnail_root = ? WHERE id = ?",
				[thumbnailRoot, raw],
			);
			const key = sqlite
				.query<{ key: string }, [number]>(
					"SELECT thumbnail_key AS key FROM photos WHERE id = ?",
				)
				.get(raw)?.key as string;
			const { getThumbnailPath } = await import("@photobrain/utils");
			const webp = join(thumbnailRoot, getThumbnailPath(key, "large"));
			mkdirSync(dirname(webp), { recursive: true });
			writeFileSync(webp, bytes.slice(0, 50));
			const response = await get(raw, { Range: "bytes=10-19" });
			expect(response.status).toBe(206);
			expect(response.headers.get("content-type")).toBe("image/webp");
			expect(response.headers.get("content-range")).toBe("bytes 10-19/50");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				bytes.slice(10, 20),
			);
		});
	});
}
