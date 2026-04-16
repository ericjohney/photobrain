import { expect, test } from "./fixtures/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("selecting a photo shows EXIF in right panel", async ({ page }) => {
	await page.locator('[data-photo-id="1"]').click();
	const rightPanel = page.locator('[data-testid="right-panel"]');
	await expect(rightPanel.getByText("Sony").first()).toBeVisible();
	await expect(rightPanel.getByText("A7III")).toBeVisible();
});

test("photo without EXIF shows no-metadata state", async ({ page }) => {
	await page.locator('[data-photo-id="11"]').click();
	const rightPanel = page.locator('[data-testid="right-panel"]');
	await expect(rightPanel.getByText("cat.jpg")).toBeVisible();
	await expect(rightPanel.getByText("No metadata available")).toBeVisible();
	await expect(rightPanel.getByText("Sony")).toHaveCount(0);
});
