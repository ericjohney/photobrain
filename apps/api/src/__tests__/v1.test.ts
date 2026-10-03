import type { Mock } from "bun:test";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { parseConfig } from "../config";
import { photoExif, photos, scanJobs } from "../db/schema";
import { createV1Router } from "../routes/v1";
import { scanPhaseSchema, scanStatusSchema } from "../routes/v1-schemas";
import type { ApiDatabase } from "../services/photo-catalog";
import type { ScanRequestedEvent } from "../services/scan-jobs";
import { createTestDb, seedTestData } from "./setup";

const legacyDispatch = mock(async (_event: unknown) => undefined);
mock.module("../services/vector-search", () => ({
	searchPhotosByText: async () => [],
	findSimilarPhotos: async () => [],
}));
mock.module("../inngest/client", () => ({
	inngest: { send: legacyDispatch },
}));
mock.module("@inngest/realtime", () => ({
	getSubscriptionToken: async () => ({ token: "test-token" }),
}));
// The legacy router must load after Bun installs its process-wide dependency mocks.
const { appRouter } = await import("../trpc/router");

type Dispatch = Mock<(event: ScanRequestedEvent) => Promise<void>>;

function createHttpApp(
	database: ApiDatabase,
	dispatchScan: Dispatch,
	nativeScanMutationsEnabled = false,
) {
	const app = new Hono();
	app.route(
		"/api/v1",
		createV1Router({
			database,
			dispatchScan,
			nativeScanMutationsEnabled,
			photoDirectory: "../../test-photos",
			thumbnailsDirectory: "./test-thumbnails",
			searchPhotos: async () =>
				database.query.photos.findMany({ with: { exif: true } }),
		}),
	);
	return app;
}

async function responseJson(response: Response) {
	return JSON.parse(await response.text()) as unknown;
}

function isoJson(value: unknown) {
	return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("API v1 contract", () => {
	let database: ApiDatabase;
	let dispatchScan: Dispatch;
	let app: Hono;
	let firstPhotoId: number;

	beforeEach(() => {
		database = createTestDb().db;
		const seeded = seedTestData(database);
		firstPhotoId = seeded[0].id;
		database
			.update(photos)
			.set({
				sourceRoot: "/private/source",
				sourceFingerprint: "private-source-fingerprint",
				mediaVersion: "private-media-version",
				thumbnailKey: "private-thumbnail-key",
				thumbnailRoot: "/private/thumbnails",
				thumbnailFingerprint: "private-thumbnail-fingerprint",
				thumbnailUpdatedAt: new Date("2026-09-20T12:34:56.000Z"),
			})
			.where(eq(photos.id, firstPhotoId))
			.run();
		const nested = database
			.insert(photos)
			.values({
				path: "folder1/nested/deep.jpg",
				name: "deep.jpg",
				size: 42,
				createdAt: new Date("2024-09-01T00:00:00.000Z"),
				modifiedAt: new Date("2024-09-02T00:00:00.000Z"),
				isRaw: false,
			})
			.returning()
			.get();
		database
			.insert(photoExif)
			.values({ photoId: nested.id, cameraMake: "Deep", cameraModel: "Camera" })
			.run();
		dispatchScan = mock(async (_event: ScanRequestedEvent) => undefined);
		legacyDispatch.mockClear();
		app = createHttpApp(database, dispatchScan);
	});
	test("native scan mutation configuration defaults off and parses explicit values", () => {
		expect(parseConfig({}).V1_NATIVE_SCAN_MUTATIONS_ENABLED).toBe(false);
		expect(
			parseConfig({ V1_NATIVE_SCAN_MUTATIONS_ENABLED: "false" })
				.V1_NATIVE_SCAN_MUTATIONS_ENABLED,
		).toBe(false);
		expect(
			parseConfig({ V1_NATIVE_SCAN_MUTATIONS_ENABLED: "1" })
				.V1_NATIVE_SCAN_MUTATIONS_ENABLED,
		).toBe(true);
		expect(
			parseConfig({ V1_NATIVE_SCAN_MUTATIONS_ENABLED: "true" })
				.V1_NATIVE_SCAN_MUTATIONS_ENABLED,
		).toBe(true);
	});

	test("metadata routes are differential-compatible with tRPC and serialize public ISO DTOs", async () => {
		const caller = appRouter.createCaller({ db: database });
		const foldersResponse = await app.request("/api/v1/folders");
		expect(foldersResponse.status).toBe(200);
		expect(await responseJson(foldersResponse)).toEqual(
			isoJson(await caller.folders()),
		);

		const filtersResponse = await app.request(
			"/api/v1/filter-options?folder=folder1",
		);
		expect(filtersResponse.status).toBe(200);
		expect(await responseJson(filtersResponse)).toEqual(
			isoJson(await caller.filterOptions({ folder: "folder1" })),
		);

		const photosResponse = await app.request(
			"/api/v1/photos?folder=folder1&camera=Sony%20A7III",
		);
		expect(photosResponse.status).toBe(200);
		const body = (await responseJson(photosResponse)) as {
			photos: Array<Record<string, unknown>>;
			total: number;
			rawCount: number;
		};
		const expectedPhotos = isoJson(
			await caller.photos({ folder: "folder1", camera: "Sony A7III" }),
		) as typeof body;
		expect(body).toEqual(expectedPhotos);
		expect(body.photos.some((photo) => photo.name === "deep.jpg")).toBe(false);
		expect(body.photos[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		const monthResponse = await app.request("/api/v1/photos?dateMonth=2024-06");
		expect(monthResponse.status).toBe(200);
		expect(await responseJson(monthResponse)).toEqual(
			isoJson(await caller.photos({ dateMonth: "2024-06" })),
		);

		const detailResponse = await app.request(`/api/v1/photos/${firstPhotoId}`);
		expect(detailResponse.status).toBe(200);
		const detail = (await responseJson(detailResponse)) as Record<
			string,
			unknown
		>;
		const expectedDetail = isoJson(
			await caller.photo({ id: firstPhotoId }),
		) as typeof detail;
		expect(detail).toEqual(expectedDetail);
		for (const key of [
			"sourceRoot",
			"sourceFingerprint",
			"mediaVersion",
			"thumbnailKey",
			"thumbnailRoot",
			"thumbnailFingerprint",
		]) {
			expect(detail).not.toHaveProperty(key);
		}
		expect(detail.thumbnailUpdatedAt).toBe("2026-09-20T12:34:56.000Z");
	});

	test("normalizes Rust EXIF months for filter options and photo matching", async () => {
		const nestedPhoto = database
			.select({ id: photos.id })
			.from(photos)
			.where(eq(photos.path, "folder1/nested/deep.jpg"))
			.get();
		if (!nestedPhoto) throw new Error("Expected nested photo fixture");
		database
			.update(photoExif)
			.set({ dateTaken: "2024:10:04 12:34:56" })
			.where(eq(photoExif.photoId, nestedPhoto.id))
			.run();

		const caller = appRouter.createCaller({ db: database });
		const legacyOptions = await caller.filterOptions();
		expect(legacyOptions.dates).toContain("2024:10");
		expect(legacyOptions.dates).not.toContain("2024-10");
		const legacyPhotos = await caller.photos({ dateMonth: "2024:10" });
		expect(legacyPhotos.total).toBe(1);
		expect(legacyPhotos.photos[0].name).toBe("deep.jpg");

		const optionsResponse = await app.request("/api/v1/filter-options");
		expect(optionsResponse.status).toBe(200);
		const options = (await responseJson(optionsResponse)) as {
			dates: string[];
		};
		expect(options.dates).toContain("2024-10");
		expect(options.dates).not.toContain("2024:10");

		const photosResponse = await app.request(
			"/api/v1/photos?dateMonth=2024-10",
		);
		expect(photosResponse.status).toBe(200);
		const result = (await responseJson(photosResponse)) as {
			photos: Array<{ name: string }>;
			total: number;
		};
		expect(result.total).toBe(1);
		expect(result.photos[0].name).toBe("deep.jpg");
	});

	test("validates route inputs and preserves null unknown scan status", async () => {
		for (const path of ["/api/v1/photos/0", "/api/v1/photos/1.5"]) {
			const response = await app.request(path);
			expect(response.status).toBe(400);
			expect(await responseJson(response)).toEqual({
				error: {
					code: "INVALID_REQUEST",
					message: "Request validation failed",
				},
			});
		}

		const missingPhoto = await app.request("/api/v1/photos/999999");
		expect(missingPhoto.status).toBe(404);
		expect(await responseJson(missingPhoto)).toEqual({
			error: { code: "PHOTO_NOT_FOUND", message: "Photo not found" },
		});

		const invalidSearch = await app.request("/api/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "", limit: 101 }),
		});
		expect(invalidSearch.status).toBe(400);

		const invalidScanId = await app.request("/api/v1/scans/not-a-uuid");
		expect(invalidScanId.status).toBe(400);
		const missingScan = await app.request(
			"/api/v1/scans/00000000-0000-4000-8000-000000000000",
		);
		expect(missingScan.status).toBe(200);
		expect(await responseJson(missingScan)).toBeNull();
	});

	test("search validates its DTO and strips private photo identities", async () => {
		const response = await app.request("/api/v1/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "sunset", limit: 3 }),
		});
		expect(response.status).toBe(200);
		const body = (await responseJson(response)) as {
			photos: Array<Record<string, unknown>>;
			total: number;
			query: string;
		};
		expect(body.query).toBe("sunset");
		expect(body.total).toBe(6);
		expect(typeof body.photos[0].createdAt).toBe("string");
		for (const photo of body.photos) {
			expect(photo).not.toHaveProperty("sourceRoot");
			expect(photo).not.toHaveProperty("sourceFingerprint");
			expect(photo).not.toHaveProperty("mediaVersion");
			expect(photo).not.toHaveProperty("thumbnailKey");
			expect(photo).not.toHaveProperty("thumbnailRoot");
			expect(photo).not.toHaveProperty("thumbnailFingerprint");
		}
	});

	test("maps every persisted scan state to the finite v1 contract", async () => {
		const states = [
			["queued", "queued", "queued", "queued"],
			["discovering", "running", "discovering", "running"],
			["processing", "running", "processing", "running"],
			["scan-complete", "running", "scan-complete", "running"],
			["embedding", "running", "embedding", "running"],
			["completed", "completed", "completed", "completed"],
			["failed", "failed", "failed", "failed"],
		] as const;
		const createdAt = new Date("2026-09-21T00:00:00.000Z");

		for (const [phase, status, expectedPhase, expectedStatus] of states) {
			const id = crypto.randomUUID();
			database
				.insert(scanJobs)
				.values({ id, phase, status, createdAt, updatedAt: createdAt })
				.run();

			const response = await app.request(`/api/v1/scans/${id}`);
			expect(response.status).toBe(200);
			expect(await responseJson(response)).toMatchObject({
				id,
				phase: expectedPhase,
				status: expectedStatus,
			});
		}
	});

	test("rejects unknown persisted scan states at the v1 boundary", async () => {
		const createdAt = new Date("2026-09-21T00:00:00.000Z");
		for (const [phase, status] of [
			["unknown", "running"],
			["processing", "unknown"],
		]) {
			const id = crypto.randomUUID();
			database
				.insert(scanJobs)
				.values({ id, phase, status, createdAt, updatedAt: createdAt })
				.run();

			const response = await app.request(`/api/v1/scans/${id}`);
			expect(response.status).toBe(500);
			expect(await responseJson(response)).toEqual({
				error: {
					code: "INTERNAL_ERROR",
					message: "The request could not be completed",
				},
			});
		}
	});

	test("returns only active scans in updated, created, UUID descending order", async () => {
		const created = new Date("2026-09-20T10:00:00.000Z");
		const laterCreated = new Date("2026-09-20T10:30:00.000Z");
		const updated = new Date("2026-09-20T11:00:00.000Z");
		const latest = new Date("2026-09-20T12:00:00.000Z");
		const jobs = [
			{
				id: "00000000-0000-4000-8000-000000000001",
				phase: "queued",
				status: "queued",
				createdAt: created,
				updatedAt: updated,
			},
			{
				id: "00000000-0000-4000-8000-000000000002",
				phase: "processing",
				status: "running",
				createdAt: created,
				updatedAt: updated,
			},
			{
				id: "00000000-0000-4000-8000-000000000003",
				phase: "embedding",
				status: "running",
				createdAt: created,
				updatedAt: latest,
			},
			{
				id: "00000000-0000-4000-8000-000000000004",
				phase: "completed",
				status: "completed",
				createdAt: created,
				updatedAt: new Date("2026-09-20T13:00:00.000Z"),
			},
			{
				id: "00000000-0000-4000-8000-000000000005",
				phase: "failed",
				status: "failed",
				error: "fixture failure",
				createdAt: created,
				updatedAt: new Date("2026-09-20T14:00:00.000Z"),
			},
			{
				id: "00000000-0000-4000-8000-000000000006",
				phase: "processing",
				status: "running",
				createdAt: laterCreated,
				updatedAt: updated,
			},
		];
		database.insert(scanJobs).values(jobs).run();

		const response = await app.request("/api/v1/scans/active");
		expect(response.status).toBe(200);
		const body = (await responseJson(response)) as {
			jobs: Array<{ id: string; createdAt: string; updatedAt: string }>;
		};
		expect(Object.keys(body)).toEqual(["jobs"]);
		expect(body.jobs.map(({ id }) => id)).toEqual([
			"00000000-0000-4000-8000-000000000003",
			"00000000-0000-4000-8000-000000000006",
			"00000000-0000-4000-8000-000000000002",
			"00000000-0000-4000-8000-000000000001",
		]);
		expect(body.jobs[0].updatedAt).toBe(latest.toISOString());
	});

	test("disabled native scan mutation returns 503 before validation or side effects", async () => {
		const caller = appRouter.createCaller({ db: database });
		const before = database.select().from(scanJobs).all();
		const response = await app.request("/api/v1/scans", {
			method: "POST",
			body: "not even JSON",
		});
		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			error: {
				code: "NATIVE_SCAN_DISABLED",
				message: "Native scan mutations are disabled",
			},
		});
		expect(database.select().from(scanJobs).all()).toEqual(before);
		expect(dispatchScan).not.toHaveBeenCalled();

		const readsStillAvailable = await app.request("/api/v1/photos");
		expect(readsStillAvailable.status).toBe(200);
		const legacyResult = await caller.scan();
		expect(legacyResult.success).toBe(true);
		expect(legacyDispatch).toHaveBeenCalledTimes(1);
	});

	test("enabled scan returns a safe domain failure and retains diagnostics", async () => {
		const diagnostic = "Failed to scan /Users/owner/Photos/private.jpg";
		dispatchScan = mock(async (_event: ScanRequestedEvent) => {
			throw new Error(diagnostic);
		});
		app = createHttpApp(database, dispatchScan, true);
		const response = await app.request("/api/v1/scans", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ force: true }),
		});
		expect(response.status).toBe(200);
		const body = (await responseJson(response)) as {
			success: false;
			error: string;
			jobId: string;
		};
		expect(body).toMatchObject({
			success: false,
			error: "The scan could not be started",
		});
		expect(body.jobId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(dispatchScan).toHaveBeenCalledTimes(2);
		expect(dispatchScan.mock.calls[0][0]).toEqual(
			dispatchScan.mock.calls[1][0],
		);
		const durable = database
			.select()
			.from(scanJobs)
			.where(eq(scanJobs.id, body.jobId))
			.get();
		expect(durable).toMatchObject({
			phase: "failed",
			status: "failed",
			error: diagnostic,
		});

		const statusResponse = await app.request(`/api/v1/scans/${body.jobId}`);
		expect(statusResponse.status).toBe(200);
		expect(await responseJson(statusResponse)).toMatchObject({
			id: body.jobId,
			status: "failed",
			error: "The scan could not be completed",
		});
	});

	test("dispatch response loss does not regress a job that already started", async () => {
		dispatchScan = mock(async (event: ScanRequestedEvent) => {
			database
				.update(scanJobs)
				.set({ phase: "discovering", status: "running" })
				.where(eq(scanJobs.id, event.data.jobId))
				.run();
			throw new Error("Response was lost");
		});
		app = createHttpApp(database, dispatchScan, true);
		const response = await app.request("/api/v1/scans", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(200);
		const body = (await responseJson(response)) as {
			success: boolean;
			jobId: string;
		};
		expect(body.success).toBe(true);
		expect(
			database.select().from(scanJobs).where(eq(scanJobs.id, body.jobId)).get(),
		).toMatchObject({
			phase: "discovering",
			status: "running",
		});
	});

	test("checked-in OpenAPI document describes every v1 route without private fields", async () => {
		const document = (await Bun.file(
			new URL("../routes/openapi-v1.json", import.meta.url),
		).json()) as {
			paths: Record<string, { post?: { responses: Record<string, unknown> } }>;
			components: {
				schemas: {
					Photo: { properties: Record<string, unknown> };
					StartScanFailure: {
						properties: { error: { const: string } };
					};
					Scan: {
						properties: {
							phase: { enum: string[] };
							status: { enum: string[] };
						};
					};
				};
			};
		};
		expect(Object.keys(document.paths).sort()).toEqual([
			"/api/v1/filter-options",
			"/api/v1/folders",
			"/api/v1/photos",
			"/api/v1/photos/{id}",
			"/api/v1/scans",
			"/api/v1/scans/active",
			"/api/v1/scans/{jobId}",
			"/api/v1/search",
		]);
		expect(
			Object.keys(document.paths["/api/v1/scans"].post?.responses ?? {}).sort(),
		).toEqual(["200", "400", "500", "503"]);
		expect(
			document.components.schemas.StartScanFailure.properties.error.const,
		).toBe("The scan could not be started");
		expect(scanPhaseSchema.options).toEqual([
			"queued",
			"discovering",
			"processing",
			"scan-complete",
			"embedding",
			"completed",
			"failed",
		]);
		expect(scanStatusSchema.options).toEqual([
			"queued",
			"running",
			"completed",
			"failed",
		]);
		expect(document.components.schemas.Scan.properties.phase.enum).toEqual(
			scanPhaseSchema.options,
		);
		expect(document.components.schemas.Scan.properties.status.enum).toEqual(
			scanStatusSchema.options,
		);
		for (const key of [
			"sourceRoot",
			"sourceFingerprint",
			"mediaVersion",
			"thumbnailKey",
			"thumbnailRoot",
			"thumbnailFingerprint",
		]) {
			expect(document.components.schemas.Photo.properties).not.toHaveProperty(
				key,
			);
		}
	});
});
