import { FIXTURE_LIBRARY } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

test("background RAW publication refreshes grid and open viewer without navigation", async ({
	page,
	mockBackend,
}) => {
	let revision = 0;
	const publishedAt = new Date("2026-11-06T12:00:00Z");
	await mockBackend({
		previewRevision: () => ({ revision }),
		photos: () => ({
			photos: FIXTURE_LIBRARY.map((photo) =>
				photo.id === 2 && revision
					? { ...photo, thumbnailUpdatedAt: publishedAt }
					: photo,
			),
			total: FIXTURE_LIBRARY.length,
		}),
	});
	await page.goto("/");
	const cell = page.locator('[data-testid="photo-grid"] [data-photo-id="2"]');
	await expect(cell).toBeVisible();
	await cell.dblclick();
	const viewer = page.locator(
		'[data-testid="loupe-view"] img[alt]:not([alt=""])',
	);
	await expect(viewer).toBeVisible();
	const before = await viewer.getAttribute("src");
	revision = 1;
	await expect(viewer).not.toHaveAttribute("src", before ?? "", {
		timeout: 12000,
	});
	await expect(viewer).toHaveAttribute(
		"src",
		new RegExp(`v=${publishedAt.getTime()}`),
	);
	await page.keyboard.press("Escape");
	await expect(cell.locator("img").first()).toHaveAttribute(
		"src",
		new RegExp(`v=${publishedAt.getTime()}`),
	);
});
