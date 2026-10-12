/**
 * Library listing benchmark: the tRPC `photos` query and `/api/v1/photos`
 * over a seeded in-memory library, served through Hono with and without the
 * JSON compression middleware. No native addon, photos, or frontend needed.
 *
 *   bun scripts/benchmark-catalog.ts [photoCount=8000]
 */
import { mock } from "bun:test";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { createTestDb } from "../src/__tests__/setup";
import { photoExif, photos } from "../src/db/schema";
import { compressJson } from "../src/middleware/compress-json";

mock.module("../src/services/vector-search", () => ({
	searchPhotosByText: async () => [],
	findSimilarPhotos: async () => [],
	findSimilarToPhoto: async () => null,
}));
mock.module("../src/inngest/client", () => ({
	inngest: { send: async () => {} },
}));
const { appRouter } = await import("../src/trpc/router");
const { createV1Router } = await import("../src/routes/v1");

const count = Number(process.argv[2] ?? 8000);
const { db, sqlite } = createTestDb();
sqlite.exec("BEGIN");
for (let i = 0; i < count; i++) {
	const raw = i % 3 === 0;
	const day = new Date(Date.UTC(2020, 0, 1 + Math.floor(i / 5)));
	const [row] = db
		.insert(photos)
		.values({
			path: `${day.getUTCFullYear()}/${i % 60}/IMG_${i}.${raw ? "DNG" : "HEIC"}`,
			name: `IMG_${i}.${raw ? "DNG" : "HEIC"}`,
			size: 25_000_000,
			createdAt: day,
			modifiedAt: day,
			width: 4284,
			height: 5712,
			mimeType: raw ? "image/x-dng" : "image/heic",
			isRaw: raw,
			rawFormat: raw ? "DNG" : null,
			rawStatus: raw ? "converted" : null,
			thumbnailStatus: "completed",
			thumbnailUpdatedAt: day,
		})
		.returning({ id: photos.id })
		.all();
	db.insert(photoExif)
		.values({
			photoId: row.id,
			cameraMake: "Apple",
			cameraModel: "iPhone 17 Pro Max",
			lensMake: "Apple",
			lensModel: "iPhone 17 Pro Max back triple camera 6.765mm f/1.78",
			focalLength: 6,
			iso: 500,
			aperture: "f/1.8",
			shutterSpeed: "1/30",
			exposureBias: "0 EV",
			dateTaken: `${day.toISOString().slice(0, 10).replaceAll("-", ":")} 18:14:21`,
			gpsLatitude: "38.9793666666667",
			gpsLongitude: "-104.728233333333",
			gpsAltitude: "2207.791461",
		})
		.run();
}
sqlite.exec("COMMIT");

function createApp(compressed: boolean) {
	const app = new Hono();
	if (compressed) {
		app.use("/api/trpc/*", compressJson());
		app.use("/api/v1/*", compressJson());
	}
	app.route(
		"/api/v1",
		createV1Router({
			database: db,
			searchPhotos: async () => [],
			dispatchScan: async () => {},
			photoDirectory: "/nonexistent",
			thumbnailsDirectory: "/nonexistent",
			nativeScanMutationsEnabled: false,
		} as never),
	);
	app.all("/api/trpc/*", (c) =>
		fetchRequestHandler({
			endpoint: "/api/trpc",
			req: c.req.raw,
			router: appRouter,
			createContext: () => ({ db }) as never,
		}),
	);
	return app;
}

const ROUTES = {
	"trpc photos": `/api/trpc/photos?input=${encodeURIComponent('{"json":{}}')}`,
	"v1 photos": "/api/v1/photos",
};
const RUNS = 5;

console.log(
	`${count} photos, median of ${RUNS} runs (server time + body read)`,
);
for (const compressed of [false, true]) {
	const app = createApp(compressed);
	for (const [label, path] of Object.entries(ROUTES)) {
		const times: number[] = [];
		let bytes = 0;
		for (let i = 0; i < RUNS + 1; i++) {
			const start = performance.now();
			const res = await app.request(path, {
				headers: { "Accept-Encoding": "gzip, deflate, br" },
			});
			bytes = (await res.arrayBuffer()).byteLength;
			if (res.status !== 200) throw new Error(`${path}: ${res.status}`);
			if (i > 0) times.push(performance.now() - start);
		}
		times.sort((a, b) => a - b);
		console.log(
			`${compressed ? "gzip    " : "identity"}  ${label.padEnd(12)} ${(bytes / 1e6).toFixed(2).padStart(6)} MB  ${times[Math.floor(RUNS / 2)].toFixed(0).padStart(5)} ms`,
		);
	}
}
