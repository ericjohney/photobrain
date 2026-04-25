import { describe, test, expect, beforeAll, mock } from "bun:test";
import { createTestDb, seedTestData } from "./setup";

// Mock the vector-search service to avoid loading native image-processing module and singleton db
mock.module("@/services/vector-search", () => ({
	searchPhotosByText: async () => [],
	findSimilarPhotos: async () => [],
}));

// Mock the inngest client to avoid external service dependency
mock.module("@/inngest", () => ({
	inngest: {
		send: async () => {},
	},
}));

// Mock @inngest/realtime to avoid dependency issues
mock.module("@inngest/realtime", () => ({
	getSubscriptionToken: async () => ({ token: "test-token" }),
}));

// Import router after mocks are set up
const { appRouter } = await import("../trpc/router");

describe("EXIF Filtering Integration Tests", () => {
	let db: ReturnType<typeof createTestDb>["db"];
	let caller: ReturnType<typeof appRouter.createCaller>;

	beforeAll(() => {
		const testDb = createTestDb();
		db = testDb.db;
		seedTestData(db);

		// Create a tRPC caller with the test DB as context
		caller = appRouter.createCaller({ db });
	});

	describe("filterOptions", () => {
		test("returns distinct cameras", async () => {
			const result = await caller.filterOptions({});
			expect(result.cameras).toContain("Sony A7III");
			expect(result.cameras).toContain("Canon EOS R5");
			expect(result.cameras).toContain("Apple iPhone 17 Pro Max");
			expect(result.cameras.length).toBe(3);
		});

		test("returns distinct lenses", async () => {
			const result = await caller.filterOptions({});
			expect(result.lenses.length).toBe(4);
			expect(result.lenses).toContain("FE 24-70mm f/2.8 GM");
			expect(result.lenses).toContain("FE 85mm f/1.4 GM");
			expect(result.lenses).toContain("RF 15-35mm f/2.8L");
			expect(result.lenses).toContain("iPhone 17 Pro Max back camera");
		});

		test("returns distinct ISOs sorted", async () => {
			const result = await caller.filterOptions({});
			expect(result.isos).toEqual([50, 100, 200, 400]);
		});

		test("returns distinct date months", async () => {
			const result = await caller.filterOptions({});
			expect(result.dates).toContain("2024-06");
			expect(result.dates).toContain("2024-07");
			expect(result.dates).toContain("2024-08");
		});

		test("scopes to folder when provided", async () => {
			const result = await caller.filterOptions({ folder: "folder1" });
			// folder1 has Sony A7III (x2) and Apple iPhone — no Canon
			expect(result.cameras).toContain("Sony A7III");
			expect(result.cameras).not.toContain("Canon EOS R5");
		});
	});

	describe("photos with EXIF filters", () => {
		test("filters by camera", async () => {
			const result = await caller.photos({ camera: "Sony A7III" });
			expect(result.total).toBe(2);
			for (const p of result.photos) {
				expect(p.exif?.cameraMake).toBe("Sony");
			}
		});

		test("filters by lens", async () => {
			const result = await caller.photos({ lens: "FE 85mm f/1.4 GM" });
			expect(result.total).toBe(1);
			expect(result.photos[0].name).toBe("photo2.arw");
		});

		test("filters by ISO", async () => {
			const result = await caller.photos({ iso: 200 });
			expect(result.total).toBe(1);
			expect(result.photos[0].name).toBe("photo3.jpg");
		});

		test("filters by date month", async () => {
			const result = await caller.photos({ dateMonth: "2024-06" });
			expect(result.total).toBe(2);
		});

		test("combines camera filter with folder", async () => {
			const result = await caller.photos({
				camera: "Sony A7III",
				folder: "folder1",
			});
			expect(result.total).toBe(2); // both Sony photos are in folder1
		});

		test("returns empty for non-matching filter", async () => {
			const result = await caller.photos({ camera: "Nikon Z9" });
			expect(result.total).toBe(0);
		});

		test("returns all photos when no filter", async () => {
			const result = await caller.photos({});
			expect(result.total).toBe(5);
		});

		test("photo without EXIF excluded when EXIF filter active", async () => {
			const result = await caller.photos({ camera: "Sony A7III" });
			expect(
				result.photos.find((p) => p.name === "photo5.jpg"),
			).toBeUndefined();
		});

		test("filters by raw status", async () => {
			const result = await caller.photos({ filterRaw: "raw" });
			expect(result.total).toBe(1);
			expect(result.photos[0].name).toBe("photo2.arw");
		});

		test("filters by standard (non-raw) status", async () => {
			const result = await caller.photos({ filterRaw: "standard" });
			expect(result.total).toBe(4);
		});

		test("combines multiple EXIF filters", async () => {
			const result = await caller.photos({
				camera: "Sony A7III",
				iso: 400,
			});
			expect(result.total).toBe(1);
			expect(result.photos[0].name).toBe("photo2.arw");
		});
	});
});
