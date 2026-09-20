import type { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import { photoEmbedding, photoExif, photoPhash, photos } from "../db/schema";
import {
	type EmbeddingTarget,
	type ProcessedMediaState,
	saveEmbeddingBatch,
	saveScanBatch,
} from "../services/import-persistence";
import { createTestDb } from "./setup";

const exif = {
	cameraMake: "Sony",
	cameraModel: "A7III",
	lensMake: "Sigma",
	lensModel: "24-70mm",
	focalLength: 35,
	iso: 100,
	aperture: "f/2.8",
	shutterSpeed: "1/250",
	exposureBias: "-0.3",
	dateTaken: "2024:01:01 12:34:56",
};

function result(
	path: string,
	overrides: Partial<PhotoProcessingResult> = {},
): PhotoProcessingResult {
	return {
		success: true,
		path,
		name: path.slice(path.lastIndexOf("/") + 1),
		size: 123456,
		createdAt: Date.UTC(2024, 0, 1),
		modifiedAt: Date.UTC(2024, 1, 2),
		width: 4032,
		height: 3024,
		mimeType: "image/jpeg",
		isRaw: false,
		exif: { ...exif },
		phash: "YWJjZA==",
		...overrides,
	};
}

let db: typeof applicationDb;
let sqlite: Database;

beforeEach(() => {
	({ db, sqlite } = createTestDb());
});
afterEach(() => sqlite.close());

function snapshot() {
	return {
		photos: db.select().from(photos).orderBy(photos.id).all(),
		exif: db.select().from(photoExif).orderBy(photoExif.id).all(),
		phash: db.select().from(photoPhash).orderBy(photoPhash.id).all(),
		embeddings: db
			.select()
			.from(photoEmbedding)
			.orderBy(photoEmbedding.id)
			.all(),
	};
}

function targets(ids: readonly number[]): EmbeddingTarget[] {
	return ids.map((id) => {
		const photo = db
			.select({ id: photos.id, thumbnailKey: photos.thumbnailKey })
			.from(photos)
			.where(eq(photos.id, id))
			.get();
		if (!photo) throw new Error(`Missing fixture photo ${id}`);
		return photo;
	});
}

function mediaStates(
	inputs: readonly PhotoProcessingResult[],
	generation: string,
): Map<string, ProcessedMediaState> {
	return new Map(
		inputs.map((input) => [
			input.path,
			{
				sourceRoot: "/photos",
				sourceFingerprint: `${generation}:${input.size}`,
				mediaVersion: generation,
				thumbnailKey: `.versions/${generation}/${input.path}`,
				thumbnailRoot: `/thumbnails/${generation}`,
				thumbnailFingerprint: `${generation}:thumbnails`,
			},
		]),
	);
}

describe("saveScanBatch", () => {
	test("ignores failed native results for new and existing paths", () => {
		const existing = result("existing.jpg");
		saveScanBatch(db, [existing]);
		const before = snapshot();
		const failures = [existing, result("failed.jpg")].map((input) => ({
			...input,
			success: false,
			error: "decode failed",
			size: 999,
			phash: "ignored",
		}));
		expect(saveScanBatch(db, failures)).toEqual([]);
		expect(snapshot()).toEqual(before);
		const ids = saveScanBatch(db, [
			failures[0],
			result("good.jpg"),
			failures[1],
		]);
		expect(ids).toHaveLength(1);
		expect(
			db.select().from(photos).where(eq(photos.path, "good.jpg")).get()?.id,
		).toBe(ids[0]);
		expect(snapshot().photos).toHaveLength(2);
	});

	test.each([
		19, 20, 21,
	])("saves and retries all %i results in input order", (size) => {
		const inputs = Array.from({ length: size }, (_, i) =>
			result(`batch/${size - i}.jpg`),
		);
		const ids = saveScanBatch(db, inputs);
		expect(ids).toHaveLength(size);
		expect(new Set(ids).size).toBe(size);
		expect(saveScanBatch(db, inputs)).toEqual(ids);
		const saved = snapshot();
		expect(saved.photos.map((photo) => photo.path)).toEqual(
			inputs.map((input) => input.path),
		);
		expect(saved.exif.map((row) => row.photoId)).toEqual(ids);
		expect(saved.phash.map((row) => row.photoId)).toEqual(ids);
	});

	test("reruns preserve identity and creation time, update sidecars, and retain old vectors", () => {
		const input = result("rerun.arw", {
			isRaw: true,
			rawFormat: "ARW",
			rawStatus: "converted",
		});
		const ids = saveScanBatch(db, [input]);
		saveEmbeddingBatch(db, targets(ids), [[0.1, -0.2]]);
		db.update(photos)
			.set({ thumbnailUpdatedAt: new Date(0) })
			.run();
		const before = snapshot();
		const updated = result(input.path, {
			name: "new name",
			size: 654321,
			createdAt: Date.UTC(2025, 0, 1),
			modifiedAt: Date.UTC(2025, 1, 1),
			width: 800,
			height: 600,
			mimeType: "image/heic",
			exif: { cameraModel: "Updated", iso: 0, gpsLatitude: 0 },
			phash: "bmV3",
		});
		expect(saveScanBatch(db, [updated])).toEqual(ids);
		const saved = snapshot();
		expect(saved.photos).toHaveLength(1);
		expect(saved.photos[0]).toMatchObject({
			id: ids[0],
			createdAt: new Date(input.createdAt),
			modifiedAt: new Date(updated.modifiedAt),
			name: "new name",
			size: 654321,
			width: 800,
			height: 600,
			mimeType: "image/heic",
			isRaw: false,
			rawFormat: null,
			rawStatus: null,
			rawError: null,
			embeddingStatus: "pending",
		});
		expect(saved.photos[0].thumbnailUpdatedAt?.getTime()).toBeGreaterThan(0);
		expect(saved.exif).toHaveLength(1);
		expect(saved.exif[0]).toMatchObject({
			id: before.exif[0].id,
			photoId: ids[0],
			cameraMake: null,
			cameraModel: "Updated",
			iso: 0,
			gpsLatitude: "0",
			gpsLongitude: null,
		});
		expect(saved.phash).toHaveLength(1);
		expect(saved.phash[0]).toMatchObject({
			id: before.phash[0].id,
			photoId: ids[0],
			hash: "bmV3",
		});
		expect(saved.embeddings).toEqual(before.embeddings);

		expect(
			saveScanBatch(db, [{ ...updated, exif: undefined, phash: undefined }]),
		).toEqual(ids);
		const omitted = snapshot();
		expect(omitted.exif).toEqual(saved.exif);
		expect(omitted.phash).toEqual(saved.phash);
		expect(omitted.embeddings).toEqual(saved.embeddings);
		expect(omitted.photos[0]).toMatchObject({
			embeddingStatus: "pending",
			phashStatus: "failed",
		});
	});

	test("generation-aware saves preserve IDs while direct saves invalidate freshness", () => {
		const input = result("generations.jpg");
		const first = mediaStates([input], "first");
		const firstState = first.get(input.path);
		if (!firstState) throw new Error("Expected first generation");
		const ids = saveScanBatch(db, [input], first);
		saveEmbeddingBatch(db, targets(ids), [[0.25]]);
		const second = mediaStates([input], "second");
		expect(saveScanBatch(db, [input], second)).toEqual(ids);
		expect(snapshot().photos[0]).toMatchObject({
			...second.get(input.path),
			embeddingStatus: "pending",
		});
		expect(snapshot().embeddings[0].thumbnailKey).toBe(firstState.thumbnailKey);

		for (const state of [undefined, new Map<string, ProcessedMediaState>()]) {
			saveScanBatch(db, [input], second);
			expect(saveScanBatch(db, [input], state)).toEqual(ids);
			expect(snapshot().photos[0]).toMatchObject({
				sourceRoot: null,
				sourceFingerprint: null,
				mediaVersion: null,
				thumbnailKey: null,
				thumbnailRoot: null,
				thumbnailFingerprint: null,
				embeddingStatus: "pending",
			});
		}
	});

	test("same-second generations advance cache tokens even when the clock goes backwards", () => {
		const epoch = Date.UTC(2026, 0, 1);
		setSystemTime(new Date(epoch + 123));
		try {
			const input = result("cache-token.jpg");
			const [id] = saveScanBatch(db, [input], mediaStates([input], "first"));
			const cacheToken = () =>
				db
					.select({ timestamp: photos.thumbnailUpdatedAt })
					.from(photos)
					.where(eq(photos.id, id))
					.get()
					?.timestamp?.getTime();
			expect(cacheToken()).toBe(epoch);
			saveScanBatch(db, [input], mediaStates([input], "second"));
			expect(cacheToken()).toBe(epoch + 1_000);
			saveScanBatch(db, [input], mediaStates([input], "third"));
			expect(cacheToken()).toBe(epoch + 2_000);

			setSystemTime(new Date(epoch - 10_000));
			saveScanBatch(db, [input], mediaStates([input], "fourth"));
			expect(cacheToken()).toBe(epoch + 3_000);
			setSystemTime(new Date(epoch + 10_456));
			saveScanBatch(db, [input], mediaStates([input], "fifth"));
			expect(cacheToken()).toBe(epoch + 10_000);

			db.update(photos)
				.set({ thumbnailUpdatedAt: null })
				.where(eq(photos.id, id))
				.run();
			saveScanBatch(db, [input], mediaStates([input], "legacy-upgrade"));
			expect(cacheToken()).toBe(epoch + 10_000);
		} finally {
			setSystemTime();
		}
	});

	for (const table of ["photo_exif", "photo_phash"]) {
		test.each([
			false,
			true,
		])(`${table} late failure rolls back inserts and updates (existing target: %s)`, (existingTarget) => {
			const inputs = Array.from({ length: 21 }, (_, i) =>
				result(`rollback/${i}.jpg`),
			);
			const originalIds = saveScanBatch(
				db,
				existingTarget ? [inputs[0], inputs[20]] : [inputs[0]],
				mediaStates(inputs, "original"),
			);
			saveEmbeddingBatch(
				db,
				targets(originalIds),
				originalIds.map(() => [0.25]),
			);
			const before = snapshot();
			const changed = inputs.map((input) => ({
				...input,
				size: 999,
				exif: { iso: 800 },
				phash: "changed",
			}));
			const changedStates = mediaStates(changed, "replacement");
			// Resolve the late row inside the trigger, including when it is newly inserted.
			sqlite.exec(`CREATE TRIGGER fail_scan BEFORE INSERT ON ${table}
				WHEN NEW.photo_id = (SELECT id FROM photos WHERE path = 'rollback/20.jpg')
				BEGIN SELECT RAISE(ABORT, 'late sidecar failure'); END`);
			expect(() => saveScanBatch(db, changed, changedStates)).toThrow(
				"late sidecar failure",
			);
			expect(snapshot()).toEqual(before);

			sqlite.exec("DROP TRIGGER fail_scan");
			const ids = saveScanBatch(db, changed, changedStates);
			const saved = snapshot();
			expect(ids).toHaveLength(changed.length);
			for (const [index, input] of changed.entries()) {
				expect(
					saved.photos.find((photo) => photo.path === input.path)?.id,
				).toBe(ids[index]);
				expect(
					saved.photos.find((photo) => photo.path === input.path),
				).toMatchObject(changedStates.get(input.path) ?? {});
			}
			expect(ids[0]).toBe(originalIds[0]);
			if (existingTarget) expect(ids[20]).toBe(originalIds[1]);
			expect(saved.photos).toHaveLength(21);
			expect(saved.exif).toHaveLength(21);
			expect(saved.phash).toHaveLength(21);
			expect(
				saved.photos.every(
					(photo) => photo.size === 999 && photo.embeddingStatus === "pending",
				),
			).toBe(true);
			expect(saved.exif.every((row) => row.iso === 800)).toBe(true);
			expect(saved.phash.every((row) => row.hash === "changed")).toBe(true);
			expect(saved.embeddings).toEqual(before.embeddings);
			expect(saveScanBatch(db, changed, changedStates)).toEqual(ids);
		});
	}
});

describe("saveEmbeddingBatch", () => {
	test.each([
		{ previous: "old", current: "new" },
		{ previous: null, current: "new" },
		{ previous: "old", current: null },
	])("rejects stale successes and failures across $previous -> $current", ({
		previous,
		current,
	}) => {
		const input = result("stale.jpg");
		const ids = saveScanBatch(
			db,
			[input],
			previous === null ? undefined : mediaStates([input], previous),
		);
		const staleTargets = targets(ids);
		saveEmbeddingBatch(db, staleTargets, [[0.1]]);
		saveScanBatch(
			db,
			[input],
			current === null ? undefined : mediaStates([input], current),
		);
		const pending = snapshot();
		expect(saveEmbeddingBatch(db, staleTargets, [[0.9]])).toEqual({
			processed: 1,
			successful: 0,
		});
		expect(snapshot()).toEqual(pending);

		expect(saveEmbeddingBatch(db, targets(ids), [[0.5]])).toEqual({
			processed: 1,
			successful: 1,
		});
		const completed = snapshot();
		for (const vector of [[0.9], null, undefined]) {
			expect(saveEmbeddingBatch(db, staleTargets, [vector])).toEqual({
				processed: 1,
				successful: 0,
			});
			expect(snapshot()).toEqual(completed);
		}
	});

	test("skipped generations and deleted photos preserve batch alignment", () => {
		const inputs = [
			result("stale.jpg"),
			result("deleted.jpg"),
			result("current.jpg"),
		];
		const ids = saveScanBatch(db, inputs, mediaStates(inputs, "old"));
		const captured = targets(ids);
		saveScanBatch(db, [inputs[0]], mediaStates([inputs[0]], "new"));
		db.delete(photoExif).where(eq(photoExif.photoId, ids[1])).run();
		db.delete(photoPhash).where(eq(photoPhash.photoId, ids[1])).run();
		db.delete(photos).where(eq(photos.id, ids[1])).run();
		expect(saveEmbeddingBatch(db, captured, [[0.1], [0.2], [0.3]])).toEqual({
			processed: 3,
			successful: 1,
		});
		const saved = snapshot();
		expect(saved.photos.map((photo) => photo.embeddingStatus)).toEqual([
			"pending",
			"completed",
		]);
		expect(saved.embeddings).toMatchObject([
			{
				photoId: ids[2],
				thumbnailKey: captured[2].thumbnailKey,
				embedding: Buffer.from(new Float32Array([0.3]).buffer),
			},
		]);
	});

	test.each([
		15, 16, 17,
	])("stores Float32 blobs and upserts retries for %i photos", (size) => {
		const ids = saveScanBatch(
			db,
			Array.from({ length: size }, (_, i) => result(`embedding/${i}.jpg`)),
		).reverse();
		const vectors = ids.map((id) => [id / 10, -0.123456789, 0, 1.23456789]);
		expect(saveEmbeddingBatch(db, targets(ids), vectors)).toEqual({
			processed: size,
			successful: size,
		});
		const before = snapshot();
		const updated = vectors.map((vector) => vector.map((value) => value + 0.1));
		for (const values of [updated, updated]) {
			expect(saveEmbeddingBatch(db, targets(ids), values)).toEqual({
				processed: size,
				successful: size,
			});
			const saved = snapshot();
			expect(saved.embeddings).toHaveLength(size);
			expect(
				saved.photos.every((photo) => photo.embeddingStatus === "completed"),
			).toBe(true);
			for (const [index, id] of ids.entries()) {
				const row = saved.embeddings.find((entry) => entry.photoId === id);
				expect(row).toEqual({
					id: before.embeddings[index].id,
					photoId: id,
					embedding: Buffer.from(new Float32Array(values[index]).buffer),
					modelVersion: "clip-vit-b32",
					thumbnailKey: null,
					createdAt: expect.any(Date),
				});
			}
		}
	});

	test.each([
		false,
		true,
	])("null, undefined, and missing results fail without deleting vectors (prior vectors: %s)", (priorVectors) => {
		const ids = saveScanBatch(
			db,
			Array.from({ length: 4 }, (_, i) => result(`missing/${i}.jpg`)),
		);
		if (priorVectors)
			saveEmbeddingBatch(
				db,
				targets(ids),
				ids.map(() => [0.5, -0.5]),
			);
		const before = snapshot();
		expect(
			saveEmbeddingBatch(db, targets(ids), [[0.25], null, undefined]),
		).toEqual({
			processed: 4,
			successful: 1,
		});
		const saved = snapshot();
		expect(saved.photos.map((photo) => photo.embeddingStatus)).toEqual([
			"completed",
			"failed",
			"failed",
			"failed",
		]);
		expect(saved.embeddings.filter((row) => row.photoId !== ids[0])).toEqual(
			before.embeddings.filter((row) => row.photoId !== ids[0]),
		);
		expect(saved.embeddings).toHaveLength(priorVectors ? 4 : 1);
	});

	test("late embedding failure rolls back the whole batch's blobs and statuses, then retries", () => {
		const ids = saveScanBatch(
			db,
			Array.from({ length: 17 }, (_, i) => result(`rollback/${i}.jpg`)),
		);
		db.update(photos)
			.set({ thumbnailKey: ".versions/current/photo.jpg" })
			.run();
		saveEmbeddingBatch(db, targets([ids[0], ids[2], ids[16]]), [
			[0.1],
			[0.2],
			[0.3],
		]);
		const before = snapshot();
		const vectors = ids.map((_, index) => (index === 2 ? null : [0.9, -0.8]));
		sqlite.exec(`CREATE TRIGGER fail_embedding BEFORE INSERT ON photo_embedding
			WHEN NEW.photo_id = (SELECT id FROM photos WHERE path = 'rollback/16.jpg')
			BEGIN SELECT RAISE(ABORT, 'late embedding failure'); END`);
		expect(() => saveEmbeddingBatch(db, targets(ids), vectors)).toThrow(
			"late embedding failure",
		);
		expect(snapshot()).toEqual(before);

		sqlite.exec("DROP TRIGGER fail_embedding");
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(saveEmbeddingBatch(db, targets(ids), vectors)).toEqual({
				processed: 17,
				successful: 16,
			});
			const saved = snapshot();
			expect(saved.embeddings).toHaveLength(17);
			for (const [index, id] of ids.entries()) {
				expect(
					saved.photos.find((photo) => photo.id === id)?.embeddingStatus,
				).toBe(index === 2 ? "failed" : "completed");
				expect(
					saved.embeddings.find((row) => row.photoId === id)?.embedding,
				).toEqual(
					Buffer.from(
						new Float32Array(index === 2 ? [0.2] : [0.9, -0.8]).buffer,
					),
				);
			}
		}
	});
});
