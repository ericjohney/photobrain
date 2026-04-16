import { expect, test } from "./fixtures/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("left panel toggles hide/show", async ({ page }) => {
	const leftPanel = page.locator('[data-testid="left-panel"]');
	await expect(leftPanel).toBeVisible();
	await page.getByRole("button", { name: /hide left panel/i }).click();
	await expect(leftPanel).toBeHidden();
	await page.getByRole("button", { name: /show left panel/i }).click();
	await expect(leftPanel).toBeVisible();
});

test("right panel toggles hide/show", async ({ page }) => {
	const rightPanel = page.locator('[data-testid="right-panel"]');
	await expect(rightPanel).toBeVisible();
	await page.getByRole("button", { name: /hide right panel/i }).click();
	await expect(rightPanel).toBeHidden();
	await page.getByRole("button", { name: /show right panel/i }).click();
	await expect(rightPanel).toBeVisible();
});

test("Tab toggles all panels", async ({ page }) => {
	const leftPanel = page.locator('[data-testid="left-panel"]');
	const rightPanel = page.locator('[data-testid="right-panel"]');
	await expect(leftPanel).toBeVisible();
	await expect(rightPanel).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(leftPanel).toBeHidden();
	await expect(rightPanel).toBeHidden();
	await page.keyboard.press("Tab");
	await expect(leftPanel).toBeVisible();
	await expect(rightPanel).toBeVisible();
});

test("panel state persists across reload", async ({ page }) => {
	await page.getByRole("button", { name: /hide left panel/i }).click();
	await expect(page.locator('[data-testid="left-panel"]')).toBeHidden();
	await page.reload();
	await expect(page.getByText("12 photos")).toBeVisible();
	await expect(page.locator('[data-testid="left-panel"]')).toBeHidden();
});
