import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../db/schema";
import { photos, photoExif } from "../db/schema";

export function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });

	// Run migrations from the shared db package
	migrate(db, { migrationsFolder: "../../packages/db/drizzle" });

	return { db, sqlite };
}

export function seedTestData(db: ReturnType<typeof createTestDb>["db"]) {
	const photoData = [
		{
			path: "folder1/photo1.jpg",
			name: "photo1.jpg",
			size: 1000000,
			createdAt: new Date(),
			modifiedAt: new Date(),
			isRaw: false,
		},
		{
			path: "folder1/photo2.arw",
			name: "photo2.arw",
			size: 2000000,
			createdAt: new Date(),
			modifiedAt: new Date(),
			isRaw: true,
			rawFormat: "ARW",
			rawStatus: "converted",
		},
		{
			path: "folder2/photo3.jpg",
			name: "photo3.jpg",
			size: 1500000,
			createdAt: new Date(),
			modifiedAt: new Date(),
			isRaw: false,
		},
		{
			path: "folder1/photo4.heic",
			name: "photo4.heic",
			size: 500000,
			createdAt: new Date(),
			modifiedAt: new Date(),
			isRaw: false,
		},
		{
			path: "folder2/photo5.jpg",
			name: "photo5.jpg",
			size: 800000,
			createdAt: new Date(),
			modifiedAt: new Date(),
			isRaw: false,
		},
	];

	const insertedPhotos = [];
	for (const p of photoData) {
		const result = db.insert(photos).values(p).returning().get();
		insertedPhotos.push(result);
	}

	const exifData = [
		{
			photoId: insertedPhotos[0].id,
			cameraMake: "Sony",
			cameraModel: "A7III",
			lensModel: "FE 24-70mm f/2.8 GM",
			iso: 100,
			dateTaken: "2024-06-15T12:00:00",
		},
		{
			photoId: insertedPhotos[1].id,
			cameraMake: "Sony",
			cameraModel: "A7III",
			lensModel: "FE 85mm f/1.4 GM",
			iso: 400,
			dateTaken: "2024-06-20T14:00:00",
		},
		{
			photoId: insertedPhotos[2].id,
			cameraMake: "Canon",
			cameraModel: "EOS R5",
			lensModel: "RF 15-35mm f/2.8L",
			iso: 200,
			dateTaken: "2024-07-10T08:00:00",
		},
		{
			photoId: insertedPhotos[3].id,
			cameraMake: "Apple",
			cameraModel: "iPhone 17 Pro Max",
			lensModel: "iPhone 17 Pro Max back camera",
			iso: 50,
			dateTaken: "2024-08-01T18:00:00",
		},
		// photo5 has no EXIF (test null handling)
	];

	for (const e of exifData) {
		db.insert(photoExif).values(e).run();
	}

	return insertedPhotos;
}
