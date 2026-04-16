import { expect, test } from "./fixtures/test";

test("grid renders all fixture photos", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	// Count direct children of the grid container (one per photo);
	// some fixture photos are failed RAWs that render a placeholder div instead of <img>.
	const grid = page.locator('[data-testid="photo-grid"]');
	await expect(grid.locator("> *")).toHaveCount(12);
});

test("empty state shows when no photos", async ({ page, mockBackend }) => {
	await mockBackend({
		photos: () => ({ photos: [], total: 0, rawCount: 0 }),
	});
	await page.goto("/");
	await expect(page.getByText("0 photos")).toBeVisible();
	await expect(page.getByTestId("photo-grid-empty")).toBeVisible();
});
