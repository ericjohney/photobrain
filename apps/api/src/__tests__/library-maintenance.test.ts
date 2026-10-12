import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAllThumbnailSizes, getThumbnailPath } from "@photobrain/utils";
import { eq, sql } from "drizzle-orm";
import {
	collectionPhotos,
	collections,
	eventPhotos,
	events,
	photoEmbedding,
	photoExif,
	photoFaceScan,
	photoFaces,
	photoPhash,
	photoPlaces,
	photoQuality,
	photos,
	photoTags,
	scanItems,
	scanJobs,
	scanManifests,
} from "../db/schema";
import {
	deletePhotos,
	removeMissingPhotos,
} from "../services/library-reconciliation";
import {
	QUEUED_SCAN_EXPIRY_MS,
	recoverQueuedScans,
	type ScanRequestedEvent,
	startScan,
} from "../services/scan-jobs";
import {
	collectThumbnailGarbage,
	THUMBNAIL_GC_GRACE_MS,
} from "../services/thumbnail-gc";
import { createTestDb } from "./setup";

const { db, sqlite } = createTestDb();
let root: string;
let sourceRoot: string;
let thumbnailsRoot: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "photobrain-maintenance-"));
	sourceRoot = join(root, "photos");
	thumbnailsRoot = join(root, "thumbnails");
	mkdirSync(sourceRoot);
	mkdirSync(thumbnailsRoot);
	for (const table of [
		eventPhotos,
		events,
		collectionPhotos,
		collections,
		photoTags,
		photoQuality,
		photoPlaces,
		photoFaces,
		photoFaceScan,
		photoEmbedding,
		photoPhash,
		photoExif,
		scanItems,
		scanManifests,
		scanJobs,
		photos,
	])
		db.delete(table).run();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => sqlite.close());

function insertPhoto(
	path: string,
	options: { onDisk?: boolean; sourceRoot?: string | null; key?: string } = {},
) {
	if (options.onDisk ?? true) {
		const file = join(sourceRoot, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, path);
	}
	return db
		.insert(photos)
		.values({
			path,
			name: path,
			size: 1,
			createdAt: new Date(),
			modifiedAt: new Date(),
			sourceRoot:
				options.sourceRoot === undefined ? sourceRoot : options.sourceRoot,
			thumbnailKey: options.key ?? null,
		})
		.returning()
		.get();
}

/** A scan manifest that discovered exactly `paths`. */
function manifest(jobId: string, paths: string[], root = sourceRoot) {
	const now = new Date();
	db.insert(scanJobs)
		.values({ id: jobId, status: "running", createdAt: now, updatedAt: now })
		.run();
	db.insert(scanManifests)
		.values({ jobId, total: paths.length, sourceRoot: root })
		.run();
	paths.forEach((path, ordinal) => {
		db.insert(scanItems)
			.values({
				jobId,
				ordinal,
				filePath: join(root, path),
				relativePath: path,
				action: "skip",
				status: "success",
			})
			.run();
	});
}

function count(table: typeof photos | typeof collections) {
	return db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;
}

describe("deletePhotos", () => {
	test("clears every sidecar even with foreign keys disabled", () => {
		expect(sqlite.query("PRAGMA foreign_keys").get()).toEqual({
			foreign_keys: 0,
		});
		const gone = insertPhoto("gone.jpg");
		const kept = insertPhoto("kept.jpg");
		const now = new Date();
		for (const photo of [gone, kept]) {
			db.insert(photoExif).values({ photoId: photo.id }).run();
			db.insert(photoPhash)
				.values({ photoId: photo.id, hash: "x", createdAt: now })
				.run();
			db.insert(photoEmbedding)
				.values({
					photoId: photo.id,
					embedding: Buffer.alloc(8),
					createdAt: now,
				})
				.run();
			db.insert(photoTags)
				.values({ photoId: photo.id, tag: "beach", score: 0.5 })
				.run();
			db.insert(photoQuality)
				.values({
					photoId: photo.id,
					sharpness: 1,
					brightness: 1,
					thumbnailKey: "k",
					qualityVersion: 1,
				})
				.run();
			db.insert(photoPlaces)
				.values({
					photoId: photo.id,
					geonameId: 1,
					city: "c",
					countryCode: "US",
					country: "United States",
					latitudeText: "1",
					longitudeText: "1",
					placesVersion: 1,
				})
				.run();
			db.insert(photoFaces)
				.values({
					photoId: photo.id,
					thumbnailKey: "k",
					modelVersion: "m",
					x: 0,
					y: 0,
					width: 1,
					height: 1,
					score: 1,
					embedding: Buffer.alloc(8),
					createdAt: now,
				})
				.run();
			db.insert(photoFaceScan)
				.values({
					photoId: photo.id,
					thumbnailKey: "k",
					modelVersion: "m",
					faceCount: 1,
					status: "completed",
					scannedAt: now,
				})
				.run();
		}
		const album = db
			.insert(collections)
			.values({ name: "Album", createdAt: now, updatedAt: now })
			.returning()
			.get();
		db.insert(collectionPhotos)
			.values([
				{ collectionId: album.id, photoId: gone.id, addedAt: now },
				{ collectionId: album.id, photoId: kept.id, addedAt: now },
			])
			.run();
		db.insert(events)
			.values({
				id: gone.id,
				startAt: "2024-01-01T00:00:00",
				endAt: "2024-01-01T01:00:00",
				photoCount: 2,
				coverPhotoId: gone.id,
				eventsVersion: 1,
			})
			.run();
		db.insert(eventPhotos)
			.values([
				{ eventId: gone.id, photoId: gone.id },
				{ eventId: gone.id, photoId: kept.id },
			])
			.run();

		expect(deletePhotos(db, [gone.id])).toBe(1);
		expect(
			db
				.select()
				.from(photos)
				.all()
				.map((photo) => photo.id),
		).toEqual([kept.id]);
		for (const table of [
			photoExif,
			photoPhash,
			photoEmbedding,
			photoTags,
			photoQuality,
			photoPlaces,
			photoFaces,
			photoFaceScan,
			collectionPhotos,
			eventPhotos,
		]) {
			expect(
				db
					.select({ photoId: table.photoId })
					.from(table)
					.all()
					.map((row) => row.photoId),
			).toEqual([kept.id]);
		}
		// The collection itself survives; events are rebuilt by the next detection.
		expect(count(collections)).toBe(1);
	});

	test("chunks large deletes", () => {
		const ids = Array.from(
			{ length: 1203 },
			(_, index) => insertPhoto(`${index}.jpg`, { onDisk: false }).id,
		);
		expect(deletePhotos(db, ids)).toBe(1203);
		expect(count(photos)).toBe(0);
		expect(deletePhotos(db, [])).toBe(0);
	});
});

describe("removeMissingPhotos", () => {
	test("removes only undiscovered photos whose file is gone", async () => {
		insertPhoto("a.jpg");
		insertPhoto("hidden.jpg");
		insertPhoto("gone.jpg", { onDisk: false });
		insertPhoto("legacy-gone.jpg", { onDisk: false, sourceRoot: null });
		manifest("job", ["a.jpg"]);
		expect(await removeMissingPhotos(db, "job")).toEqual({
			removed: 2,
			retained: 1,
		});
		expect(
			db
				.select({ path: photos.path })
				.from(photos)
				.all()
				.map((photo) => photo.path)
				.sort(),
		).toEqual(["a.jpg", "hidden.jpg"]);
		// Idempotent on replay.
		expect(await removeMissingPhotos(db, "job")).toEqual({
			removed: 0,
			retained: 1,
		});
	});

	test("never touches photos committed under another source root", async () => {
		insertPhoto("a.jpg");
		insertPhoto("elsewhere.jpg", {
			onDisk: false,
			sourceRoot: "/mnt/other-library",
		});
		manifest("job", ["a.jpg"]);
		expect(await removeMissingPhotos(db, "job")).toEqual({
			removed: 0,
			retained: 0,
		});
		expect(count(photos)).toBe(2);
	});

	test("an empty discovery removes nothing", async () => {
		insertPhoto("a.jpg", { onDisk: false });
		manifest("job", []);
		expect(await removeMissingPhotos(db, "job")).toEqual({
			removed: 0,
			retained: 1,
			skipped: "empty-discovery",
		});
		expect(count(photos)).toBe(1);
	});

	test("a missing manifest removes nothing", async () => {
		insertPhoto("a.jpg", { onDisk: false });
		expect(await removeMissingPhotos(db, "unknown")).toMatchObject({
			removed: 0,
			skipped: "no-manifest",
		});
		expect(count(photos)).toBe(1);
	});

	test("mass removal needs the explicit override", async () => {
		insertPhoto("kept.jpg");
		for (let index = 0; index < 25; index++)
			insertPhoto(`${index}.jpg`, { onDisk: false });
		manifest("job", ["kept.jpg"]);
		expect(await removeMissingPhotos(db, "job")).toEqual({
			removed: 0,
			retained: 25,
			skipped: "mass-removal",
		});
		expect(count(photos)).toBe(26);
		expect(
			await removeMissingPhotos(db, "job", { allowMassRemoval: true }),
		).toEqual({ removed: 25, retained: 0 });
		expect(count(photos)).toBe(1);
	});

	test("a small library may lose most photos (below the minimum)", async () => {
		insertPhoto("kept.jpg");
		for (let index = 0; index < 5; index++)
			insertPhoto(`${index}.jpg`, { onDisk: false });
		manifest("job", ["kept.jpg"]);
		expect(await removeMissingPhotos(db, "job")).toEqual({
			removed: 5,
			retained: 0,
		});
	});

	test("an unreadable directory is not treated as deleted", async () => {
		if (process.getuid?.() === 0) return; // root ignores permissions
		insertPhoto("a.jpg");
		insertPhoto("locked/b.jpg");
		manifest("job", ["a.jpg"]);
		const locked = join(sourceRoot, "locked");
		const { chmodSync } = await import("node:fs");
		chmodSync(locked, 0o000);
		try {
			expect(await removeMissingPhotos(db, "job")).toEqual({
				removed: 0,
				retained: 1,
			});
		} finally {
			chmodSync(locked, 0o755);
		}
		expect(count(photos)).toBe(2);
	});
});

describe("collectThumbnailGarbage", () => {
	const old = Date.now() - THUMBNAIL_GC_GRACE_MS - 60_000;

	function generation(uuid: string, mtime = old) {
		const key = `.versions/${uuid}/photo.image`;
		for (const size of getAllThumbnailSizes()) {
			const file = join(thumbnailsRoot, getThumbnailPath(key, size));
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "webp-bytes");
			utimesSync(dirname(file), mtime / 1000, mtime / 1000);
		}
		return key;
	}
	const exists = (key: string) =>
		getAllThumbnailSizes().every((size) =>
			existsSync(join(thumbnailsRoot, getThumbnailPath(key, size))),
		);
	const anyExists = (key: string) =>
		getAllThumbnailSizes().some((size) =>
			existsSync(join(thumbnailsRoot, getThumbnailPath(key, size))),
		);

	test("deletes only old, unreferenced managed generations", async () => {
		const committed = generation("committed");
		const superseded = generation("superseded");
		const faceOnly = generation("face-only");
		const fresh = generation("fresh", Date.now());
		// A legacy mirrored thumbnail outside `.versions` is never collected.
		const legacy = join(thumbnailsRoot, "large", "2024", "legacy.webp");
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "legacy");
		const photo = db
			.insert(photos)
			.values({
				path: "a.jpg",
				name: "a.jpg",
				size: 1,
				createdAt: new Date(),
				modifiedAt: new Date(),
				thumbnailKey: committed,
				thumbnailRoot: thumbnailsRoot,
			})
			.returning()
			.get();
		db.insert(photoFaces)
			.values({
				photoId: photo.id,
				thumbnailKey: faceOnly,
				modelVersion: "m",
				x: 0,
				y: 0,
				width: 1,
				height: 1,
				score: 1,
				embedding: Buffer.alloc(8),
				createdAt: new Date(),
			})
			.run();

		const result = await collectThumbnailGarbage(db, thumbnailsRoot);
		expect(result).toEqual({
			deleted: getAllThumbnailSizes().length,
			bytes: getAllThumbnailSizes().length * "webp-bytes".length,
			recent: getAllThumbnailSizes().length,
		});
		expect(exists(committed)).toBe(true);
		expect(exists(faceOnly)).toBe(true);
		expect(exists(fresh)).toBe(true);
		expect(anyExists(superseded)).toBe(false);
		expect(existsSync(legacy)).toBe(true);
	});

	test("skips while any scan holds a manifest", async () => {
		const orphan = generation("orphan");
		manifest("running", []);
		expect(await collectThumbnailGarbage(db, thumbnailsRoot)).toEqual({
			deleted: 0,
			bytes: 0,
			recent: 0,
			skipped: "scan-in-progress",
		});
		expect(exists(orphan)).toBe(true);
	});

	test("tolerates a missing thumbnails directory", async () => {
		rmSync(thumbnailsRoot, { recursive: true });
		expect(await collectThumbnailGarbage(db, thumbnailsRoot)).toEqual({
			deleted: 0,
			bytes: 0,
			recent: 0,
		});
	});
});

describe("recoverQueuedScans", () => {
	const options = () => ({
		photoDirectory: sourceRoot,
		thumbnailsDirectory: thumbnailsRoot,
	});

	function queued(id: string, createdAt: Date, force = false) {
		db.insert(scanJobs)
			.values({ id, status: "queued", force, createdAt, updatedAt: createdAt })
			.run();
	}

	test("startScan records the requested mode", async () => {
		const sent: ScanRequestedEvent[] = [];
		const result = await startScan(
			db,
			async (event) => {
				sent.push(event);
			},
			{ ...options(), force: true },
		);
		if (!result.success) throw new Error(result.error);
		expect(
			db.select().from(scanJobs).where(eq(scanJobs.id, result.jobId)).get(),
		).toMatchObject({ force: true, status: "queued" });
		expect(sent[0]).toMatchObject({ id: result.jobId, data: { force: true } });
	});

	test("re-sends stale queued jobs with their mode and expires undeliverable ones", async () => {
		const now = new Date();
		queued("stale-force", new Date(now.getTime() - 10 * 60_000), true);
		queued("stale", new Date(now.getTime() - 20 * 60_000));
		queued("recent", new Date(now.getTime() - 60_000));
		queued("ancient", new Date(now.getTime() - QUEUED_SCAN_EXPIRY_MS - 1));
		db.insert(scanJobs)
			.values({
				id: "running",
				status: "running",
				createdAt: new Date(0),
				updatedAt: new Date(0),
			})
			.run();
		const sent: ScanRequestedEvent[] = [];
		const recovered = await recoverQueuedScans(
			db,
			async (event) => {
				sent.push(event);
			},
			{ ...options(), queuedBefore: new Date(now.getTime() - 5 * 60_000), now },
		);
		expect(recovered).toEqual({
			resent: ["stale", "stale-force"],
			expired: ["ancient"],
		});
		expect(sent).toEqual([
			{
				id: "stale",
				name: "photos/scan.requested",
				data: {
					directory: sourceRoot,
					thumbnailsDir: thumbnailsRoot,
					jobId: "stale",
					force: false,
				},
			},
			{
				id: "stale-force",
				name: "photos/scan.requested",
				data: {
					directory: sourceRoot,
					thumbnailsDir: thumbnailsRoot,
					jobId: "stale-force",
					force: true,
				},
			},
		]);
		expect(
			db.select().from(scanJobs).where(eq(scanJobs.id, "ancient")).get(),
		).toMatchObject({
			status: "failed",
			phase: "failed",
			error: "Scan was never started",
		});
		expect(
			db.select().from(scanJobs).where(eq(scanJobs.id, "stale")).get()?.status,
		).toBe("queued");
	});

	test("a failed re-send leaves the job queued for the next run", async () => {
		const now = new Date();
		queued("stale", new Date(now.getTime() - 10 * 60_000));
		const recovered = await recoverQueuedScans(
			db,
			async () => {
				throw new Error("Inngest unavailable");
			},
			{ ...options(), queuedBefore: new Date(now.getTime() - 5 * 60_000), now },
		);
		expect(recovered).toEqual({ resent: [], expired: [] });
		expect(
			db.select().from(scanJobs).where(eq(scanJobs.id, "stale")).get()?.status,
		).toBe("queued");
	});
});
