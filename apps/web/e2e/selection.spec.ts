import { expect, test } from "./fixtures/test";

function gridItem(page: import("@playwright/test").Page, id: number) {
	return page.locator(`[data-photo-id="${id}"]`);
}

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("single click selects a photo", async ({ page }) => {
	await gridItem(page, 1).click();
	await expect(page.getByText("1 of 12 selected")).toBeVisible();
});

test("shift+click selects a range", async ({ page }) => {
	await gridItem(page, 2).click();
	await gridItem(page, 5).click({ modifiers: ["Shift"] });
	await expect(page.getByText("4 of 12 selected")).toBeVisible();
});

test("ctrl+click toggles selection", async ({ page }) => {
	await gridItem(page, 1).click();
	await gridItem(page, 3).click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByText("2 of 12 selected")).toBeVisible();
	await gridItem(page, 1).click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByText("1 of 12 selected")).toBeVisible();
});

test("Cmd+A selects all", async ({ page }) => {
	await page.locator('[data-testid="photo-grid"]').click();
	await page.keyboard.press("ControlOrMeta+a");
	await expect(page.getByText("12 of 12 selected")).toBeVisible();
});

test("Escape clears selection", async ({ page }) => {
	await gridItem(page, 1).click();
	await expect(page.getByText("1 of 12 selected")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByText("12 photos")).toBeVisible();
});
