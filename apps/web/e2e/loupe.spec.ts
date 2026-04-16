import { expect, test } from "./fixtures/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("double-click opens loupe view", async ({ page }) => {
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.locator('[data-testid="loupe-view"]')).toBeVisible();
});

test("E key opens loupe when photo selected", async ({ page }) => {
	await page.locator('[data-photo-id="1"]').click();
	await page.keyboard.press("e");
	await expect(page.locator('[data-testid="loupe-view"]')).toBeVisible();
});

test("G key returns to grid from loupe", async ({ page }) => {
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.locator('[data-testid="loupe-view"]')).toBeVisible();
	await page.keyboard.press("g");
	await expect(page.locator('[data-testid="photo-grid"]')).toBeVisible();
});

test("Escape from loupe returns to grid", async ({ page }) => {
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.locator('[data-testid="loupe-view"]')).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-testid="photo-grid"]')).toBeVisible();
});

test("arrow right advances photo in loupe", async ({ page }) => {
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.locator('[data-testid="loupe-view"]')).toBeVisible();
	await page.keyboard.press("ArrowRight");
	await expect(
		page.locator('[data-testid="loupe-view"] img').first(),
	).toHaveAttribute("src", /\/api\/photos\/2\//);
});
