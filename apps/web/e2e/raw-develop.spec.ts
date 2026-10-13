import { TINY_JPEG_BYTES } from "./fixtures/images";
import { expect, test } from "./fixtures/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("RAW development loads, displays, and toggles back without caching", async ({
	page,
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	await page.route("**/api/photos/2/developed", async (route) => {
		calls++;
		await pending;
		await route.fulfill({ contentType: "image/jpeg", body: TINY_JPEG_BYTES });
	});
	await page.locator('[data-photo-id="2"]').dblclick();
	const loupe = page.getByTestId("loupe-view");
	await loupe.getByRole("button", { name: "Develop RAW", exact: true }).click();
	await expect(loupe.getByRole("status")).toHaveText("Developing RAW…");
	release();
	await expect(loupe.locator('img[src^="blob:"]')).toBeVisible();
	await expect(loupe.getByRole("status")).toHaveCount(0);
	await loupe.getByRole("button", { name: "Show original preview" }).click();
	await expect(loupe.locator('img[src^="blob:"]')).toHaveCount(0);
	await loupe.getByRole("button", { name: "Develop RAW", exact: true }).click();
	await expect(loupe.locator('img[src^="blob:"]')).toBeVisible();
	expect(calls).toBe(2);
});

test("stacked JPEG offers development and errors retain the preview", async ({
	page,
}) => {
	await page.route("**/api/photos/8/developed", (route) =>
		route.fulfill({ status: 422, json: { error: "Camera unsupported" } }),
	);
	await page.locator('[data-photo-id="8"]').dblclick();
	const loupe = page.getByTestId("loupe-view");
	await loupe.getByRole("button", { name: "Develop RAW", exact: true }).click();
	await expect(loupe.getByRole("alert")).toHaveText("Camera unsupported");
	await expect(loupe.getByRole("status")).toHaveCount(0);
	await expect(loupe.locator('img[src*="/8/thumbnail/large"]')).toBeVisible();
	await loupe.getByRole("button", { name: "Show original preview" }).click();
	await expect(loupe.getByRole("alert")).toHaveCount(0);
});

test("leaving during development discards the result and resets the toggle", async ({
	page,
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/photos/2/developed", async (route) => {
		await pending;
		await route
			.fulfill({ contentType: "image/jpeg", body: TINY_JPEG_BYTES })
			.catch(() => {});
	});
	await page.locator('[data-photo-id="2"]').dblclick();
	const loupe = page.getByTestId("loupe-view");
	await loupe.getByRole("button", { name: "Develop RAW", exact: true }).click();
	await expect(loupe.getByRole("status")).toBeVisible();
	await page.keyboard.press("ArrowRight");
	await expect(loupe.getByRole("status")).toHaveCount(0);
	release();
	await page.keyboard.press("ArrowLeft");
	await expect(
		loupe.getByRole("button", { name: "Develop RAW", exact: true }),
	).toHaveAttribute("aria-pressed", "false");
	await expect(loupe.locator('img[src^="blob:"]')).toHaveCount(0);
});

test("standard unpaired photos have no RAW development control", async ({
	page,
}) => {
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(
		page.getByRole("button", { name: "Develop RAW", exact: true }),
	).toHaveCount(0);
});
