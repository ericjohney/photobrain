/**
 * Fixture API for the native iOS UI tests (`apps/ios/PhotoBrainUITests`).
 *
 * Serves the real HTTP app (`src/app.ts`: `/api/v1`, `/api/photos`, exports,
 * faces) against a throwaway SQLite library seeded through the shared
 * migrations, so the UI tests exercise the true client/server contract. Only
 * the Rust N-API addon is replaced, by a deterministic module defined below:
 * CI macOS runners then need no Rust/libheif/ONNX build. Inngest sends are
 * accepted locally and never delivered.
 *
 *   bun scripts/ui-test-server.ts            # prints `READY <origin>` once listening
 *
 * `POST /__fixture/reset` restores the seeded library between tests.
 * Environment: `UI_TEST_PORT` (default 0 = any free port), `UI_TEST_DIR`
 * (default: a fresh temporary directory, removed on exit).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { plugin } from "bun";

// ---------------------------------------------------------------------------
// Deterministic stand-in for the native addon.
// ---------------------------------------------------------------------------

/** CLIP vector width of `ClipVitB32`. */
const DIMENSION = 512;

/**
 * Unit vector for a concept word: one hot dimension per word, so a text query
 * ranks photos seeded with that concept first. Unknown words map to a shared
 * "other" dimension that no seeded concept uses.
 */
const CONCEPTS = [
	"beach",
	"mountain",
	"dog",
	"city",
	"sunset",
	"screenshot",
	"document",
	"person",
	"food",
	"snow",
] as const;
type Concept = (typeof CONCEPTS)[number];
const OTHER_DIMENSION = DIMENSION - 1;

function conceptVector(concept: Concept | null, jitter = 0): Float32Array {
	const vector = new Float32Array(DIMENSION);
	const index = concept === null ? OTHER_DIMENSION : CONCEPTS.indexOf(concept);
	vector[index] = 1;
	// A small, deterministic second component keeps same-concept photos distinct
	// while still nearer to each other than to any other concept.
	if (jitter > 0) {
		vector[CONCEPTS.length + (jitter % 64)] = 0.05;
		const norm = Math.hypot(1, 0.05);
		vector[index] /= norm;
		vector[CONCEPTS.length + (jitter % 64)] /= norm;
	}
	return vector;
}

function textVector(text: string): number[] {
	const words = text.toLowerCase().split(/[^a-z]+/);
	const concept = CONCEPTS.find((candidate) =>
		words.some((word) => word === candidate || word === `${candidate}s`),
	);
	return Array.from(conceptVector(concept ?? null));
}

function hammingFromBase64(left: string, right: string): number | null {
	const a = Buffer.from(left, "base64");
	const b = Buffer.from(right, "base64");
	if (a.length === 0 || a.length !== b.length || a.length > 8) return null;
	let distance = 0;
	for (let index = 0; index < a.length; index++) {
		let bits = a[index] ^ b[index];
		while (bits) {
			distance += bits & 1;
			bits >>= 1;
		}
	}
	return distance;
}

/** Connected components within `maxDistance`, matching the Rust contract. */
function groupNearDuplicates(
	ids: number[],
	hashes: string[],
	maxDistance: number,
) {
	if (ids.length !== hashes.length) {
		throw new Error("Expected index-aligned ids and hashes");
	}
	const parent = ids.map((_, index) => index);
	const find = (index: number): number => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}
		return index;
	};
	for (let left = 0; left < ids.length; left++) {
		for (let right = left + 1; right < ids.length; right++) {
			const distance = hammingFromBase64(hashes[left], hashes[right]);
			if (distance !== null && distance <= maxDistance) {
				parent[find(left)] = find(right);
			}
		}
	}
	const components = new Map<number, number[]>();
	ids.forEach((_, index) => {
		const root = find(index);
		components.set(root, [...(components.get(root) ?? []), index]);
	});
	return [...components.values()]
		.filter((members) => members.length >= 2)
		.map((members) => {
			let max = 0;
			for (const left of members) {
				for (const right of members) {
					max = Math.max(
						max,
						hammingFromBase64(hashes[left], hashes[right]) ?? 0,
					);
				}
			}
			return {
				ids: members.map((index) => ids[index]).sort((x, y) => x - y),
				maxDistance: max,
			};
		})
		.sort((left, right) => left.ids[0] - right.ids[0]);
}

// Dotted, matching the addon's `getSupportedExtensions()` (and `/uploads/config`'s schema).
const SUPPORTED_EXTENSIONS = [
	".jpg",
	".jpeg",
	".png",
	".heic",
	".arw",
	".dng",
	".mp4",
	".mov",
];

const unavailable = (name: string) => () => {
	throw new Error(`${name} is not available in the UI-test fixture server`);
};

plugin({
	name: "photobrain-ui-test-addon",
	setup(build) {
		build.module("@photobrain/image-processing", () => ({
			loader: "object",
			exports: {
				clipTextEmbedding: textVector,
				groupNearDuplicates,
				isSupportedMedia: (path: string) =>
					SUPPORTED_EXTENSIONS.includes(
						`.${path.split(".").pop()?.toLowerCase()}`,
					),
				getSupportedExtensions: () => SUPPORTED_EXTENSIONS,
				clusterFaceEmbeddings: () => [],
				discoverPhotos: unavailable("discoverPhotos"),
				startPhotoProcessing: unavailable("startPhotoProcessing"),
				batchGenerateClipEmbeddings: unavailable("batchGenerateClipEmbeddings"),
				renderExportJpeg: unavailable("renderExportJpeg"),
				renderFaceCrop: unavailable("renderFaceCrop"),
				detectFaces: unavailable("detectFaces"),
				analyzeImageQuality: unavailable("analyzeImageQuality"),
			},
		}));
	},
});

// ---------------------------------------------------------------------------
// Isolated storage. Config is read at import time, so set it first.
// ---------------------------------------------------------------------------

const ownsDirectory = !process.env.UI_TEST_DIR;
const root =
	process.env.UI_TEST_DIR ?? mkdtempSync(join(tmpdir(), "photobrain-ui-"));
const photoDirectory = join(root, "photos");
const thumbnailsDirectory = join(root, "thumbnails");
Object.assign(process.env, {
	DATABASE_URL: join(root, "photobrain.db"),
	PHOTO_DIRECTORY: photoDirectory,
	THUMBNAILS_DIRECTORY: thumbnailsDirectory,
	NODE_ENV: "test",
	RUN_DB_INIT: "false",
	INNGEST_DEV: "1",
	V1_NATIVE_SCAN_MUTATIONS_ENABLED: "false",
	UPLOADS_ENABLED: "false",
});

const { sql } = await import("drizzle-orm");
const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
const { db } = await import("../src/db");
const { app } = await import("../src/app");
const { inngest } = await import("../src/inngest/client");
const { detectEvents } = await import("../src/services/events");
const { placePhotoBatch } = await import("../src/services/photo-places");
const { loadPlaceIndex } = await import("../src/services/place-lookup");
const { QUALITY_VERSION, EMBEDDING_MODEL_VERSION, MEDIA_VERSION } =
	await import("../src/services/processing-versions");
const { TAG_VOCABULARY_VERSION } = await import(
	"../src/services/tag-vocabulary"
);
const { getThumbnailPath, THUMBNAIL_CONFIG } = await import(
	"@photobrain/utils"
);

// Background work is out of scope: accept events without a runtime.
inngest.send = (async () => ({ ids: [] })) as unknown as typeof inngest.send;

migrate(db, {
	migrationsFolder: join(import.meta.dir, "../../../packages/db/drizzle"),
});

// ---------------------------------------------------------------------------
// Fixture media: one valid image/video per kind, shared by every row.
// ---------------------------------------------------------------------------

const WEBP = Buffer.from(
	"UklGRjgAAABXRUJQVlA4ICwAAACQAwCdASpAAEAAPm02mUkkIyKhIggAgA2JaQAAEDdTUAV4hbkAAP6igAAAAA==",
	"base64",
);

function writeThumbnails(key: string) {
	for (const size of Object.keys(THUMBNAIL_CONFIG.sizes)) {
		const path = join(
			thumbnailsDirectory,
			getThumbnailPath(key, size as keyof typeof THUMBNAIL_CONFIG.sizes),
		);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, WEBP);
	}
}

function writeOriginal(relativePath: string) {
	const path = join(photoDirectory, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, WEBP);
}

// ---------------------------------------------------------------------------
// Seed library. Every row is complete (thumbnails, vectors, pHash) so the
// features that read sidecars see current data.
// ---------------------------------------------------------------------------

type Seed = {
	path: string;
	date?: string;
	camera?: [string, string];
	lens?: string;
	focal?: number;
	iso?: number;
	aperture?: string;
	shutter?: string;
	gps?: [string, string];
	concept?: Concept;
	tags?: [string, number][];
	quality?: { sharpness: number; brightness: number };
	phash?: string;
	rating?: number;
	flag?: "pick" | "reject";
	video?: { durationMs: number };
};

const SONY: [string, string] = ["SONY", "ILCE-7M4"];
const IPHONE: [string, string] = ["Apple", "iPhone 15 Pro"];
const FUJI: [string, string] = ["FUJIFILM", "X-T5"];

/** Capture date `years` before today at `time`, in EXIF wall-clock text. */
function onThisDay(years: number, time: string): string {
	const now = new Date();
	const year = now.getFullYear() - years;
	const month = String(now.getMonth() + 1).padStart(2, "0");
	// Feb 29 would only match leap years; use Feb 28 then.
	const day = String(
		now.getMonth() === 1 && now.getDate() === 29 ? 28 : now.getDate(),
	).padStart(2, "0");
	return `${year}:${month}:${day} ${time}`;
}

const pHash = (bytes: number[]) =>
	Buffer.from(bytes).toString("base64").replace(/=+$/, "");

const SEEDS: Seed[] = [
	// Lisbon trip: six shots within an hour form one event with a place label.
	...[0, 1, 2, 3, 4, 5].map(
		(index): Seed => ({
			path: `2024/Lisbon/lisbon-${index + 1}.jpg`,
			date: `2024:05:18 10:${String(index * 8).padStart(2, "0")}:00`,
			camera: FUJI,
			lens: "XF23mmF1.4 R LM WR",
			focal: 23,
			iso: 160,
			aperture: "f/2.0",
			shutter: "1/500",
			gps: ["38.7223", "-9.1393"],
			concept: "city",
			tags: [
				["city", 0.62],
				["architecture", 0.21],
			],
			// Last bytes at least four bits apart: distinct, not near-duplicates.
			phash: pHash([
				0x10,
				0x20,
				0x30,
				0x40,
				[0x00, 0xff, 0x0f, 0xf0, 0x33, 0xcc][index],
			]),
		}),
	),
	// Beach day (Sony), including a RAW+JPEG pair.
	{
		path: "2023/Beach/beach-sunset.ARW",
		date: "2023:08:12 19:41:10",
		camera: SONY,
		lens: "FE 24-70mm F2.8 GM II",
		focal: 35,
		iso: 100,
		aperture: "f/8.0",
		shutter: "1/250",
		gps: ["36.9741", "-122.0308"],
		concept: "sunset",
	},
	{
		path: "2023/Beach/beach-sunset.jpg",
		date: "2023:08:12 19:41:10",
		camera: SONY,
		lens: "FE 24-70mm F2.8 GM II",
		focal: 35,
		iso: 100,
		aperture: "f/8.0",
		shutter: "1/250",
		gps: ["36.9741", "-122.0308"],
		concept: "sunset",
		tags: [
			["sunset", 0.71],
			["beach", 0.18],
		],
		phash: pHash([0xa1, 0xb2, 0xc3, 0xd4, 0xe5]),
	},
	{
		path: "2023/Beach/beach-waves.jpg",
		date: "2023:08:12 16:05:00",
		camera: SONY,
		lens: "FE 24-70mm F2.8 GM II",
		focal: 70,
		iso: 200,
		aperture: "f/4.0",
		shutter: "1/1000",
		gps: ["36.9741", "-122.0308"],
		concept: "beach",
		tags: [["beach", 0.81]],
		phash: pHash([0x0f, 0x0e, 0x0d, 0x0c, 0x0b]),
		rating: 5,
		flag: "pick",
	},
	// Near-duplicates: identical except one pHash bit.
	{
		path: "2022/Dogs/dog-park-1.jpg",
		date: "2022:03:05 11:00:00",
		camera: IPHONE,
		lens: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
		focal: 7,
		iso: 64,
		aperture: "f/1.8",
		shutter: "1/120",
		concept: "dog",
		tags: [["dog", 0.88]],
		phash: pHash([0x55, 0x55, 0x55, 0x55, 0x55]),
	},
	{
		path: "2022/Dogs/dog-park-2.jpg",
		date: "2022:03:05 11:20:00",
		camera: IPHONE,
		lens: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
		focal: 7,
		iso: 64,
		aperture: "f/1.8",
		shutter: "1/120",
		concept: "dog",
		tags: [["dog", 0.86]],
		phash: pHash([0x55, 0x55, 0x55, 0x55, 0x54]),
	},
	// Burst: three same-camera shots one second apart.
	...[0, 1, 2].map(
		(index): Seed => ({
			path: `2022/Mountains/burst-${index + 1}.jpg`,
			date: `2022:01:15 09:30:0${index}`,
			camera: SONY,
			lens: "FE 70-200mm F2.8 GM OSS II",
			focal: 200,
			iso: 400,
			aperture: "f/2.8",
			shutter: "1/2000",
			concept: "mountain",
			tags: [["mountain", 0.74]],
			phash: pHash([
				0x80 + index * 7,
				0x11 * (index + 1),
				0x33,
				0x99 - index,
				0x42 + index * 40,
			]),
		}),
	),
	// Review candidates.
	{
		path: "Screenshots/settings-screenshot.png",
		date: "2024:02:01 12:00:00",
		concept: "screenshot",
		tags: [["screenshot", 0.93]],
	},
	{
		path: "Scans/receipt.jpg",
		date: "2024:02:02 12:00:00",
		camera: IPHONE,
		concept: "document",
		tags: [["receipt", 0.67]],
	},
	{
		path: "2021/Misc/blurry-hallway.jpg",
		date: "2021:11:20 18:00:00",
		camera: IPHONE,
		quality: { sharpness: 12, brightness: 120 },
	},
	{
		path: "2021/Misc/dark-basement.jpg",
		date: "2021:11:21 23:00:00",
		camera: IPHONE,
		quality: { sharpness: 300, brightness: 9 },
	},
	// Prior years on today's month/day (On this day).
	{
		path: "Memories/on-this-day-5-years.jpg",
		date: onThisDay(5, "14:00:00"),
		camera: IPHONE,
		concept: "snow",
		tags: [["snow", 0.66]],
	},
	{
		path: "Memories/on-this-day-8-years.jpg",
		date: onThisDay(8, "10:00:00"),
		camera: FUJI,
		concept: "food",
	},
	// Video and Live Photo.
	{
		path: "Videos/skate-park.mp4",
		date: "2024:04:04 17:00:00",
		video: { durationMs: 12_000 },
	},
	{
		path: "2024/Live/IMG_2001.HEIC",
		date: "2024:06:01 08:00:00",
		camera: IPHONE,
		concept: "person",
		tags: [["portrait", 0.4]],
	},
	{
		path: "2024/Live/IMG_2001.MOV",
		date: "2024:06:01 08:00:00",
		video: { durationMs: 2_800 },
	},
];

const MIME: Record<string, string> = {
	jpg: "image/jpeg",
	png: "image/png",
	heic: "image/heic",
	arw: "image/x-sony-arw",
	mp4: "video/mp4",
	mov: "video/quicktime",
};

function seed() {
	const client = db.$client;
	client.run("PRAGMA foreign_keys = OFF");
	const tables = client
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
		)
		.all();
	client.transaction(() => {
		for (const { name } of tables) client.run(`DELETE FROM "${name}"`);
		client.run("DELETE FROM sqlite_sequence");
	})();
	client.run("PRAGMA foreign_keys = ON");
	rmSync(photoDirectory, { recursive: true, force: true });
	rmSync(thumbnailsDirectory, { recursive: true, force: true });

	const now = Math.floor(Date.now() / 1000);
	client.transaction(() => {
		SEEDS.forEach((photo, index) => {
			const extension = photo.path.split(".").pop()?.toLowerCase() ?? "";
			const isRaw = extension === "arw";
			const key = `.versions/fixture-${index + 1}/photo`;
			writeOriginal(photo.path);
			writeThumbnails(key);
			const { id } = client
				.query<{ id: number }, (string | number | null)[]>(
					`INSERT INTO photos (path, name, size, created_at, modified_at, width, height, mime_type,
						media_type, duration_ms, video_codec, is_raw, raw_format, raw_status,
						thumbnail_status, thumbnail_updated_at, embedding_status, phash_status,
						media_version, thumbnail_key, thumbnail_root, rating, flag)
					VALUES (?, ?, ?, ?, ?, 6000, 4000, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
					RETURNING id`,
				)
				.get(
					photo.path,
					photo.path.split("/").pop() ?? photo.path,
					WEBP.length,
					now,
					now,
					MIME[extension] ?? "application/octet-stream",
					photo.video ? "video" : "photo",
					photo.video?.durationMs ?? null,
					photo.video ? "h264" : null,
					isRaw ? 1 : 0,
					isRaw ? "ARW" : null,
					isRaw ? "converted" : null,
					now,
					photo.video ? "pending" : "completed",
					photo.phash ? "completed" : "pending",
					MEDIA_VERSION,
					key,
					thumbnailsDirectory,
					photo.rating ?? 0,
					photo.flag ?? null,
				) as { id: number };
			client.run(
				`INSERT INTO photo_exif (photo_id, camera_make, camera_model, lens_model, focal_length,
					iso, aperture, shutter_speed, date_taken, gps_latitude, gps_longitude)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					photo.camera?.[0] ?? null,
					photo.camera?.[1] ?? null,
					photo.lens ?? null,
					photo.focal ?? null,
					photo.iso ?? null,
					photo.aperture ?? null,
					photo.shutter ?? null,
					photo.date ?? null,
					photo.gps?.[0] ?? null,
					photo.gps?.[1] ?? null,
				],
			);
			if (!photo.video) {
				const vector = conceptVector(photo.concept ?? null, index + 1);
				client.run(
					`INSERT INTO photo_embedding (photo_id, embedding, model_version, thumbnail_key, tags_version, created_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
					[
						id,
						Buffer.from(vector.buffer),
						EMBEDDING_MODEL_VERSION,
						key,
						TAG_VOCABULARY_VERSION,
						now,
					],
				);
			}
			if (photo.phash) {
				client.run(
					"INSERT INTO photo_phash (photo_id, hash, created_at) VALUES (?, ?, ?)",
					[id, photo.phash, now],
				);
			}
			for (const [tag, score] of photo.tags ?? []) {
				client.run(
					"INSERT INTO photo_tags (photo_id, tag, score) VALUES (?, ?, ?)",
					[id, tag, score],
				);
			}
			const quality = photo.quality ?? { sharpness: 250, brightness: 128 };
			if (!photo.video) {
				client.run(
					`INSERT INTO photo_quality (photo_id, sharpness, brightness, thumbnail_key, quality_version)
					VALUES (?, ?, ?, ?, ?)`,
					[id, quality.sharpness, quality.brightness, key, QUALITY_VERSION],
				);
			}
		});
		const lisbon = client
			.query<{ id: number }, []>(
				"SELECT id FROM photos WHERE path LIKE '2024/Lisbon/%' ORDER BY id",
			)
			.all()
			.map((row) => row.id);
		client.run(
			"INSERT INTO collections (name, created_at, updated_at) VALUES ('Lisbon Favorites', ?, ?)",
			[now, now],
		);
		for (const photoId of lisbon.slice(0, 3)) {
			client.run(
				"INSERT INTO collection_photos (collection_id, photo_id, added_at) VALUES (1, ?, ?)",
				[photoId, now],
			);
		}
		client.run(
			`INSERT INTO smart_albums (name, filters, query, created_at, updated_at)
			VALUES ('Sony Shots', ?, NULL, ?, ?)`,
			[JSON.stringify({ camera: "SONY ILCE-7M4" }), now, now],
		);
	})();

	// Derived sidecars through the real services.
	placePhotoBatch(db, loadPlaceIndex(), 0, 1_000);
	detectEvents(db);
}

seed();

// ---------------------------------------------------------------------------
// Server.
// ---------------------------------------------------------------------------

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.UI_TEST_PORT ?? 0),
	idleTimeout: 30,
	fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/__fixture/reset" && request.method === "POST") {
			seed();
			return Response.json({ ok: true });
		}
		return app.fetch(request);
	},
});

const counts = db.all<{ photos: number; events: number; places: number }>(
	sql`SELECT (SELECT count(*) FROM photos) AS photos,
		(SELECT count(*) FROM events) AS events,
		(SELECT count(*) FROM photo_places) AS places`,
)[0];
console.log(
	`seeded ${counts.photos} photos, ${counts.events} events, ${counts.places} places in ${root}`,
);
console.log(`READY http://127.0.0.1:${server.port}`);

const shutdown = () => {
	server.stop(true);
	db.$client.close();
	if (ownsDirectory) rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
