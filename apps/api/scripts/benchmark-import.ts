import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as schema from "@photobrain/db/schema";
import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { db } from "../src/db";
import {
	type EmbeddingTarget,
	saveEmbeddingBatch,
	saveScanBatch,
} from "../src/services/import-persistence";

const { photos, photoExif, photoPhash, photoEmbedding } = schema;
const count = 200;
const repeats = 3;
const migrationsFolder = resolve(
	import.meta.dir,
	"../../../packages/db/drizzle",
);

// Frozen legacy write semantics: sequential awaits, no enclosing transaction.
async function legacyScan(
	database: typeof db,
	results: readonly PhotoProcessingResult[],
) {
	const ids: number[] = [];
	for (const result of results) {
		if (!result.success) continue;
		const existing = await database
			.select({ id: photos.id })
			.from(photos)
			.where(eq(photos.path, result.path))
			.get();
		const values = {
			name: result.name,
			size: result.size,
			modifiedAt: new Date(result.modifiedAt),
			width: result.width ?? null,
			height: result.height ?? null,
			mimeType: result.mimeType ?? null,
			isRaw: result.isRaw,
			rawFormat: result.rawFormat ?? null,
			rawStatus: result.rawStatus ?? null,
			rawError: result.rawError ?? null,
			thumbnailStatus: "completed",
			thumbnailUpdatedAt: new Date(),
			embeddingStatus: "pending",
			phashStatus: result.phash ? "completed" : "failed",
		};
		let photoId: number;
		if (existing) {
			await database
				.update(photos)
				.set(values)
				.where(eq(photos.id, existing.id));
			photoId = existing.id;
		} else {
			const inserted = await database
				.insert(photos)
				.values({
					...values,
					path: result.path,
					createdAt: new Date(result.createdAt),
				})
				.returning({ id: photos.id });
			photoId = inserted[0].id;
		}
		if (result.exif) {
			const exif = result.exif;
			const gps = (value: number | undefined) =>
				value !== undefined ? String(value) : null;
			await database.delete(photoExif).where(eq(photoExif.photoId, photoId));
			await database.insert(photoExif).values({
				photoId,
				cameraMake: exif.cameraMake ?? null,
				cameraModel: exif.cameraModel ?? null,
				lensMake: exif.lensMake ?? null,
				lensModel: exif.lensModel ?? null,
				focalLength: exif.focalLength ?? null,
				iso: exif.iso ?? null,
				aperture: exif.aperture ?? null,
				shutterSpeed: exif.shutterSpeed ?? null,
				exposureBias: exif.exposureBias ?? null,
				dateTaken: exif.dateTaken ?? null,
				gpsLatitude: gps(exif.gpsLatitude),
				gpsLongitude: gps(exif.gpsLongitude),
				gpsAltitude: gps(exif.gpsAltitude),
			});
		}
		if (result.phash) {
			await database.delete(photoPhash).where(eq(photoPhash.photoId, photoId));
			await database.insert(photoPhash).values({
				photoId,
				hash: result.phash,
				algorithm: "double_gradient_8x8",
				createdAt: new Date(),
			});
		}
		ids.push(photoId);
	}
	return ids;
}

async function legacyEmbedding(
	database: typeof db,
	targets: readonly EmbeddingTarget[],
	embeddings: readonly (number[] | null | undefined)[],
) {
	let successful = 0;
	for (const [index, { id: photoId }] of targets.entries()) {
		const embedding = embeddings[index];
		if (embedding) {
			await database
				.delete(photoEmbedding)
				.where(eq(photoEmbedding.photoId, photoId));
			await database.insert(photoEmbedding).values({
				photoId,
				embedding: Buffer.from(new Float32Array(embedding).buffer),
				modelVersion: "clip-vit-b32",
				createdAt: new Date(),
			});
			await database
				.update(photos)
				.set({ embeddingStatus: "completed" })
				.where(eq(photos.id, photoId));
			successful++;
		} else {
			await database
				.update(photos)
				.set({ embeddingStatus: "failed" })
				.where(eq(photos.id, photoId));
		}
	}
	return { processed: targets.length, successful };
}

const results: PhotoProcessingResult[] = Array.from(
	{ length: count },
	(_, i) => {
		const isRaw = i % 3 === 0;
		const name = `photo-${String(i).padStart(5, "0")}.${isRaw ? "cr2" : i % 3 === 1 ? "jpg" : "heic"}`;
		return {
			success: true,
			path: `2024/trip-${i % 5}/${name}`,
			name,
			size: 4_000_000 + i * 101,
			createdAt: 1_704_067_200_000 + i * 1000,
			modifiedAt: 1_704_153_600_000 + i * 1000,
			width: 6000,
			height: 4000,
			mimeType: isRaw
				? "image/x-canon-cr2"
				: i % 3 === 1
					? "image/jpeg"
					: "image/heic",
			isRaw,
			rawFormat: isRaw ? "CR2" : undefined,
			rawStatus: isRaw ? "converted" : undefined,
			exif: {
				cameraMake: "Canon",
				cameraModel: `EOS ${i % 4}`,
				lensMake: "Canon",
				lensModel: "EF 24-70mm",
				focalLength: 24 + (i % 47),
				iso: 100 * (1 + (i % 8)),
				aperture: "f/2.8",
				shutterSpeed: "1/250",
				exposureBias: "0",
				dateTaken: "2024:01:01 12:00:00",
				orientation: 1,
				gpsLatitude: 37 + i / 1000,
				gpsLongitude: -122 - i / 1000,
				gpsAltitude: i,
			},
			phash: Buffer.from(
				Array.from({ length: 16 }, (_, j) => (i * 17 + j * 31) % 256),
			).toString("base64"),
		};
	},
);
const rescans = results.map((result, i) => ({
	...result,
	createdAt: result.createdAt + 86_400_000,
	modifiedAt: result.modifiedAt + 86_400_000,
	size: result.size + 100,
	width: 5900,
	exif: { ...result.exif, iso: 1600 + i },
	phash: Buffer.alloc(16, i % 256).toString("base64"),
}));
const embeddings = results.map((_, i) =>
	Array.from(
		{ length: 512 },
		(_, j) => (((i * 31 + j * 17) % 257) - 128) / 2048,
	),
);

type PersistenceSnapshot = Record<string, unknown>[][];

function snapshot(sqlite: Database, embedded: boolean): PersistenceSnapshot {
	return ["photos", "photo_exif", "photo_phash", "photo_embedding"].map(
		(table) => {
			const isPhoto = table === "photos";
			const rows = sqlite
				.query<Record<string, unknown>, []>(
					isPhoto
						? "SELECT * FROM photos ORDER BY path"
						: `SELECT t.*, p.path FROM ${table} t LEFT JOIN photos p ON p.id = t.photo_id ORDER BY p.path`,
				)
				.all();
			assert.equal(
				rows.length,
				table === "photo_embedding" && !embedded ? 0 : count,
				`${table} count`,
			);
			return rows.map((row) =>
				Object.fromEntries(
					Object.entries(row)
						.filter(
							([key]) =>
								![
									"id",
									"photo_id",
									"thumbnail_updated_at",
									...(!isPhoto ? ["created_at"] : []),
								].includes(key),
						)
						.map(([key, value]) => [
							key,
							value instanceof Uint8Array
								? Buffer.from(value).toString("hex")
								: value,
						]),
				),
			);
		},
	);
}

console.log(
	"Persistence-only benchmark: no native image processing, EXIF extraction, thumbnails, or CLIP is run.",
);
console.log(
	`${count} deterministic photos, ${repeats} repeats; scan batches=20, embedding batches=16.`,
);
console.log(
	"SQLite defaults DELETE/FULL; temporary filesystem performance affects results (tmpdir may be tmpfs).",
);
const directory = mkdtempSync(join(tmpdir(), "photobrain-import-bench-"));
console.log(`Isolated databases: ${directory}`);
const variants = [
	{ name: "legacy", scan: legacyScan, embed: legacyEmbedding },
	{ name: "optimized", scan: saveScanBatch, embed: saveEmbeddingBatch },
];
const phases = ["fresh inserts", "rescans", "embedding writes"];
const timings = new Map<string, number[]>();
const expected = new Map<string, PersistenceSnapshot>();
try {
	for (let repeat = 0; repeat < repeats; repeat++) {
		// Alternate execution order to reduce systematic cache/order bias.
		for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
			const sqlite = new Database(
				join(directory, `${variant.name}-${repeat}.sqlite`),
			);
			try {
				const database = drizzle(sqlite, { schema });
				migrate(database, { migrationsFolder });
				const pragmas = Object.fromEntries(
					[
						"journal_mode",
						"synchronous",
						"foreign_keys",
						"page_size",
						"cache_size",
					].map((name) => [name, sqlite.query(`PRAGMA ${name}`).get()]),
				);
				console.log(`${variant.name} repeat ${repeat + 1} pragmas:`, pragmas);
				assert.deepEqual(pragmas.journal_mode, { journal_mode: "delete" });
				assert.deepEqual(pragmas.synchronous, { synchronous: 2 });
				let ids: number[] = [];
				for (const [phaseIndex, phase] of phases.entries()) {
					const started = performance.now();
					const saved: number[] = [];
					const outcomes: { processed: number; successful: number }[] = [];
					if (phaseIndex < 2) {
						const input = phaseIndex === 0 ? results : rescans;
						for (let i = 0; i < count; i += 20)
							saved.push(
								...(await variant.scan(database, input.slice(i, i + 20))),
							);
					} else {
						for (let i = 0; i < count; i += 16)
							outcomes.push(
								await variant.embed(
									database,
									ids
										.slice(i, i + 16)
										.map((id) => ({ id, thumbnailKey: null })),
									embeddings.slice(i, i + 16),
								),
							);
					}
					const elapsed = performance.now() - started;
					const key = `${variant.name}:${phase}`;
					timings.set(key, [...(timings.get(key) ?? []), elapsed]);
					if (phaseIndex < 2) {
						assert.deepEqual(
							saved,
							results.map(
								(result) =>
									database
										.select({ id: photos.id })
										.from(photos)
										.where(eq(photos.path, result.path))
										.get()?.id,
							),
						);
						if (phaseIndex === 1)
							assert.deepEqual(saved, ids, "rescan preserves photo IDs");
						ids = saved;
					} else {
						assert.equal(
							outcomes.reduce((sum, value) => sum + value.processed, 0),
							count,
						);
						assert.equal(
							outcomes.reduce((sum, value) => sum + value.successful, 0),
							count,
						);
					}
					const actual = snapshot(sqlite, phaseIndex > 0);
					if (!expected.has(phase)) expected.set(phase, actual);
					assert.deepEqual(
						actual,
						expected.get(phase),
						`${variant.name}: ${phase} data equivalence`,
					);
					// Untimed seed: exercise rescan status reset and replacement of existing embedding blobs.
					if (phaseIndex === 0) {
						for (let i = 0; i < count; i += 16)
							await legacyEmbedding(
								database,
								ids.slice(i, i + 16).map((id) => ({ id, thumbnailKey: null })),
								embeddings
									.slice(i, i + 16)
									.map((vector) => vector.map((value) => -value)),
							);
					}
				}
			} finally {
				sqlite.close();
			}
		}
	}
	const median = (key: string) =>
		[...(timings.get(key) ?? [])].sort((a, b) => a - b)[
			Math.floor(repeats / 2)
		];
	console.table(
		phases.map((phase) => ({
			phase,
			"legacy median ms": median(`legacy:${phase}`).toFixed(2),
			"optimized median ms": median(`optimized:${phase}`).toFixed(2),
			"persistence-only speedup": `${(median(`legacy:${phase}`) / median(`optimized:${phase}`)).toFixed(2)}x`,
		})),
	);
	console.log(
		"All phase snapshots match: counts and stable photo/EXIF/pHash/embedding data. Not an end-to-end speedup.",
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
