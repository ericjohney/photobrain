import type { Page, Route } from "@playwright/test";
import { TINY_JPEG_BYTES } from "./fixtures/images";
import { expect, test } from "./fixtures/test";

const RENDITION = '[data-testid="loupe-rendition"]';
const TOGGLE = 'role=button[name="Show developed RAW"]';
const MAIN_IMAGE = '[data-testid="loupe-view"] img[alt]:not([alt=""])';

async function openLoupe(page: Page, id: number) {
	await page.goto("/");
	await page.locator(`[data-photo-id="${id}"]`).dblclick();
	await expect(page.locator('[data-testid="loupe-view"]')).toBeVisible();
}

test("RAW loupe switches from embedded preview to developed render", async ({
	page,
}) => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const requests: string[] = [];
	await page.route(/\/api\/photos\/\d+\/developed/, async (route: Route) => {
		requests.push(new URL(route.request().url()).pathname);
		await held;
		await route.fulfill({
			status: 200,
			contentType: "image/jpeg",
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Expose-Headers":
					"X-Developed-Width, X-Developed-Height",
				"X-Developed-Width": "9504",
				"X-Developed-Height": "6336",
			},
			body: TINY_JPEG_BYTES,
		});
	});

	await openLoupe(page, 2);
	await expect(page.locator(RENDITION)).toHaveText(
		"Embedded preview · 1600 px",
	);
	await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "false");

	await page.locator(TOGGLE).click();
	await expect(page.locator(RENDITION)).toHaveText("Developing…");
	// The embedded preview stays on screen while developing.
	await expect(page.locator(MAIN_IMAGE)).toHaveAttribute(
		"src",
		/\/api\/photos\/2\/thumbnail\/large/,
	);

	release();
	await expect(page.locator(RENDITION)).toHaveText("Developed · 9504 × 6336");
	await expect(page.locator(RENDITION)).toHaveAttribute(
		"data-rendition",
		"developed",
	);
	await expect(page.locator(MAIN_IMAGE)).toHaveAttribute("src", /^blob:/);
	expect(requests).toEqual(["/api/photos/2/developed"]);

	// R switches back and forth; the preference persists across reloads.
	await page.keyboard.press("r");
	await expect(page.locator(RENDITION)).toHaveText(
		"Embedded preview · 1600 px",
	);
	await page.keyboard.press("r");
	await expect(page.locator(RENDITION)).toHaveText("Developed · 9504 × 6336");
	await page.reload();
	await page.keyboard.press("g");
	await page.locator('[data-photo-id="2"]').dblclick();
	await expect(page.locator(TOGGLE)).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator(RENDITION)).toHaveText("Developed · 9504 × 6336");
});

test("without size headers, the label uses the decoded image size", async ({
	page,
}) => {
	await page.route(/\/api\/photos\/\d+\/developed/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/jpeg",
			body: TINY_JPEG_BYTES,
		}),
	);
	await openLoupe(page, 2);
	await page.locator(TOGGLE).click();
	await expect(page.locator(RENDITION)).toHaveText(/^Developed · \d+ × \d+$/);
});

test("unsupported camera shows a reason and keeps the preview", async ({
	page,
}) => {
	await page.route(/\/api\/photos\/\d+\/developed/, (route) =>
		route.fulfill({
			status: 422,
			contentType: "application/json",
			body: JSON.stringify({
				error: { code: "DEVELOP_UNSUPPORTED", message: "not supported" },
			}),
		}),
	);
	await openLoupe(page, 2);
	await page.locator(TOGGLE).click();
	await expect(page.locator(RENDITION)).toContainText(
		"Not available for this camera",
	);
	await expect(page.locator(RENDITION)).toHaveAttribute(
		"data-rendition",
		"embedded",
	);
});

test("non-RAW photos have no developed toggle", async ({ page }) => {
	await openLoupe(page, 1);
	await expect(page.locator(RENDITION)).toHaveCount(0);
	await expect(page.locator(TOGGLE)).toHaveCount(0);
});
