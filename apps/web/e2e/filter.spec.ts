import { test, expect } from "./fixtures/test";
import { FIXTURE_PHOTOS } from "./fixtures/photos";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("Filter By section shows camera options", async ({ page }) => {
	// Expand Filter By section
	await page.getByText("Filter By").click();
	// Expand Camera sub-section
	await page.getByText("Camera").click();
	// Camera options from filterOptions handler should appear
	await expect(page.getByText("Sony A7III")).toBeVisible();
	await expect(page.getByText("Canon EOS R5")).toBeVisible();
	await expect(page.getByText("Fujifilm X-T5")).toBeVisible();
});

test("selecting a camera filter updates photo count", async ({
	page,
	mockBackend,
}) => {
	const sonyPhotos = FIXTURE_PHOTOS.filter(
		(p) => p.exif?.cameraModel === "A7III",
	);
	await mockBackend({
		photos: (input: any) => {
			if (input?.camera === "Sony A7III") {
				return {
					photos: sonyPhotos,
					total: sonyPhotos.length,
					rawCount: 0,
				};
			}
			return {
				photos: FIXTURE_PHOTOS,
				total: FIXTURE_PHOTOS.length,
				rawCount: 0,
			};
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();

	// Open filter and select Sony
	await page.getByText("Filter By").click();
	await page.getByText("Camera").click();
	await page.getByText("Sony A7III").click();

	// Should filter to Sony photos only
	await expect(page.getByText(`${sonyPhotos.length} photos`)).toBeVisible();
});

test("clearing a filter restores full photo list", async ({
	page,
	mockBackend,
}) => {
	const sonyPhotos = FIXTURE_PHOTOS.filter(
		(p) => p.exif?.cameraModel === "A7III",
	);
	await mockBackend({
		photos: (input: any) => {
			if (input?.camera === "Sony A7III") {
				return {
					photos: sonyPhotos,
					total: sonyPhotos.length,
					rawCount: 0,
				};
			}
			return {
				photos: FIXTURE_PHOTOS,
				total: FIXTURE_PHOTOS.length,
				rawCount: 0,
			};
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();

	// Select filter
	await page.getByText("Filter By").click();
	await page.getByText("Camera").click();
	await page.getByText("Sony A7III").click();
	await expect(page.getByText(`${sonyPhotos.length} photos`)).toBeVisible();

	// Click again to deselect
	await page.getByText("Sony A7III").click();
	await expect(page.getByText("12 photos")).toBeVisible();
});
