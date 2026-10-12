import type { Page } from "@playwright/test";
import { FIXTURE_PHOTOS, type FixturePhoto } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

/**
 * A 3,000-photo library: copies of fixture photo 3 (a converted JPEG with no
 * pair) with distinct ids and paths, one per day from 2020-01-01, so the
 * timeline has many month sections. Added order (ascending id) is used where
 * a simple order is needed.
 */
const COUNT = 3000;
const LARGE_LIBRARY: FixturePhoto[] = Array.from({ length: COUNT }, (_, i) => {
	const base = FIXTURE_PHOTOS[2];
	const day = new Date(Date.UTC(2020, 0, 1 + i));
	const ymd = day.toISOString().slice(0, 10).replaceAll("-", ":");
	return {
		...base,
		id: i + 1,
		name: `IMG_${i + 1}.jpg`,
		path: `big/IMG_${i + 1}.jpg`,
		pairedPhotoId: null,
		pairedFormat: null,
		exif: base.exif ? { ...base.exif, dateTaken: `${ymd} 12:00:00` } : null,
	};
});

function gridViewport(page: Page) {
	return page.locator(
		'[data-radix-scroll-area-viewport]:has([data-testid="photo-grid"])',
	);
}

async function openLargeLibrary(
	page: Page,
	mockBackend: (o: object, p: FixturePhoto[]) => Promise<unknown>,
) {
	await page.setViewportSize({ width: 1400, height: 900 });
	await mockBackend({}, LARGE_LIBRARY);
	await page.goto("/");
	await expect(page.getByText(`${COUNT} photos`)).toBeVisible();
	await expect(page.locator('[data-photo-id="1"]')).toBeVisible();
}

test("a large grid renders only the tiles near the viewport, with every section", async ({
	page,
	mockBackend,
}) => {
	await openLargeLibrary(page, mockBackend);
	const tiles = page.locator("[data-testid='photo-grid'] [data-photo-id]");
	const rendered = await tiles.count();
	expect(rendered).toBeGreaterThan(0);
	expect(rendered).toBeLessThan(400);
	// Every month section keeps its header, so the year rail and sticky
	// headers work over the whole library (2020-01 … 2028-03).
	await expect(page.locator("[data-section-id]")).toHaveCount(99);

	// Scrolling to the bottom renders the last photos instead of the first.
	await gridViewport(page).evaluate((viewport) => {
		viewport.scrollTop = viewport.scrollHeight;
	});
	await expect(page.locator(`[data-photo-id="${COUNT}"]`)).toBeVisible();
	await expect(page.locator('[data-photo-id="1"]')).toHaveCount(0);
	expect(await tiles.count()).toBeLessThan(400);
});

test("the year rail jumps to an unrendered year and its tiles appear", async ({
	page,
	mockBackend,
}) => {
	await openLargeLibrary(page, mockBackend);
	await page
		.getByTestId("timeline-year-rail")
		.getByRole("button", { name: "2025", exact: true })
		.click();
	// 2025-01-01 is day 1827 of the library.
	await expect(page.locator('[data-photo-id="1828"]')).toBeVisible();
	await expect(
		page
			.getByTestId("timeline-year-rail")
			.getByRole("button", { name: "2025" }),
	).toHaveAttribute("aria-current", "true");
});

test("loupe arrows past the rendered range scroll the grid to the active photo", async ({
	page,
	mockBackend,
}) => {
	await openLargeLibrary(page, mockBackend);
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();

	// The filmstrip is virtualized too.
	const filmstrip = page.locator("[data-filmstrip-photo-id]");
	expect(await filmstrip.count()).toBeLessThan(200);
	await expect(page.locator('[data-filmstrip-photo-id="1"]')).toBeVisible();

	// Clicking a filmstrip tile far from the start, then returning to the
	// grid, shows that photo's tile there.
	for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
	await expect(page.locator('[data-filmstrip-photo-id="41"]')).toHaveClass(
		/ring-2/,
	);
	await page.locator('[data-filmstrip-photo-id="45"]').click();
	await page.keyboard.press("g");
	await expect(page.locator('[data-photo-id="45"]')).toBeInViewport();
	await expect(page.locator('[data-photo-id="45"]')).toHaveClass(/ring-2/);

	// Arrow keys in the grid keep the active tile in view.
	for (let i = 0; i < 200; i++) await page.keyboard.press("ArrowRight");
	await expect(page.locator('[data-photo-id="245"]')).toBeInViewport();
});
