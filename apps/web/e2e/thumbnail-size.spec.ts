import { expect, test } from "./fixtures/test";

test("thumbnail size slider changes grid tile size", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();

	const firstTile = page.locator('[data-photo-id="1"]');
	const initial = await firstTile.boundingBox();
	expect(initial).not.toBeNull();

	const slider = page.locator('[role="slider"]').first();
	await slider.focus();

	// Press ArrowRight many times to max out thumbnail size (min=100, max=400, step=25)
	for (let i = 0; i < 15; i++) {
		await page.keyboard.press("ArrowRight");
	}

	// Wait for grid to settle with larger tiles
	await expect
		.poll(async () => (await firstTile.boundingBox())?.width ?? 0)
		.toBeGreaterThan(initial?.width ?? 0);
});
