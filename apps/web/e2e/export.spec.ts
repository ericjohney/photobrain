import type { Page } from "@playwright/test";
import type { HandlerOverrides } from "./fixtures/handlers";
import { TINY_JPEG_BYTES } from "./fixtures/images";
import { FIXTURE_LIBRARY } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

/** The runtime API origin, read from a rendered thumbnail URL. */
async function apiOrigin(page: Page): Promise<string> {
	const src = await page
		.locator('[data-testid="photo-grid"] img')
		.first()
		.getAttribute("src");
	if (!src) throw new Error("grid thumbnail has no src");
	return new URL(src).origin;
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`),
	).toBeVisible();
}

function rightPanel(page: Page) {
	return page.getByTestId("right-panel");
}

async function openExportMenu(page: Page) {
	await rightPanel(page).getByRole("button", { name: "Export" }).click();
	return rightPanel(page).getByRole("menu", { name: "Export" });
}

/** Mocks the export route with an attachment response and logs requested URLs. */
async function mockPhotoExport(page: Page): Promise<string[]> {
	const requested: string[] = [];
	await page.route(/\/api\/photos\/\d+\/export/, (route) => {
		requested.push(route.request().url());
		return route.fulfill({
			status: 200,
			contentType: "image/jpeg",
			headers: {
				"Content-Disposition": 'attachment; filename="sunset_2048.jpg"',
			},
			body: TINY_JPEG_BYTES,
		});
	});
	return requested;
}

test("photo Export menu links each size with its download filename", async ({
	page,
}) => {
	await openLibrary(page);
	const api = await apiOrigin(page);
	await page.locator('[data-photo-id="1"]').click();

	const menu = await openExportMenu(page);
	const items = menu.getByRole("menuitem");
	await expect(items).toHaveText([
		"Original (sunset.jpg)",
		"JPEG, 2048 px",
		"JPEG, 1024 px",
	]);
	const expected = [
		["original", "sunset.jpg"],
		["2048", "sunset_2048.jpg"],
		["1024", "sunset_1024.jpg"],
	];
	for (const [index, [size, fileName]] of expected.entries()) {
		await expect(items.nth(index)).toHaveAttribute(
			"href",
			`${api}/api/photos/1/export?size=${size}`,
		);
		await expect(items.nth(index)).toHaveAttribute("download", fileName);
	}

	// Escape dismisses the menu.
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
});

test("a RAW photo's original keeps its RAW name; JPEG renditions swap the extension", async ({
	page,
}) => {
	await openLibrary(page);
	const api = await apiOrigin(page);
	await page.locator('[data-photo-id="2"]').click();

	const items = (await openExportMenu(page)).getByRole("menuitem");
	await expect(items.first()).toHaveText("Original (portrait.arw)");
	await expect(items.first()).toHaveAttribute(
		"href",
		`${api}/api/photos/2/export?size=original`,
	);
	await expect(items.first()).toHaveAttribute("download", "portrait.arw");
	await expect(items.nth(1)).toHaveAttribute("download", "portrait_2048.jpg");
	await expect(items.nth(2)).toHaveAttribute(
		"href",
		`${api}/api/photos/2/export?size=1024`,
	);
	await expect(items.nth(2)).toHaveAttribute("download", "portrait_1024.jpg");
});

test("the Export menu is available in loupe view", async ({ page }) => {
	await openLibrary(page);
	const api = await apiOrigin(page);
	await page.locator('[data-photo-id="3"]').dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();

	const items = (await openExportMenu(page)).getByRole("menuitem");
	await expect(items.first()).toHaveText("Original (landscape.jpg)");
	await expect(items.nth(1)).toHaveAttribute(
		"href",
		`${api}/api/photos/3/export?size=2048`,
	);
});

test("clicking a menu item downloads the attachment", async ({ page }) => {
	const requested = await mockPhotoExport(page);
	await openLibrary(page);
	const api = await apiOrigin(page);
	await page.locator('[data-photo-id="1"]').click();

	const menu = await openExportMenu(page);
	const downloadPromise = page.waitForEvent("download");
	await menu.getByRole("menuitem", { name: "JPEG, 1024 px" }).click();
	const download = await downloadPromise;

	expect(download.url()).toBe(`${api}/api/photos/1/export?size=1024`);
	expect(requested).toEqual([`${api}/api/photos/1/export?size=1024`]);
	await expect(menu).toHaveCount(0);
});

test("Shift+D downloads the active photo as JPEG 2048", async ({ page }) => {
	const requested = await mockPhotoExport(page);
	await openLibrary(page);
	const api = await apiOrigin(page);
	await page.locator('[data-photo-id="1"]').click();

	const downloadPromise = page.waitForEvent("download");
	await page.keyboard.press("Shift+D");
	const download = await downloadPromise;

	expect(download.url()).toBe(`${api}/api/photos/1/export?size=2048`);
	expect(download.suggestedFilename()).toBe("sunset_2048.jpg");
	expect(requested).toEqual([`${api}/api/photos/1/export?size=2048`]);
});

test("Shift+D does nothing without an active photo or while typing in search", async ({
	page,
}) => {
	const requested = await mockPhotoExport(page);
	let downloads = 0;
	page.on("download", () => {
		downloads++;
	});
	await openLibrary(page);

	// No active photo yet.
	await page.keyboard.press("Shift+D");

	await page.locator('[data-photo-id="1"]').click();
	const search = page.getByPlaceholder("Search photos...");
	await search.click();
	await page.keyboard.press("Shift+D");
	await expect(search).toHaveValue("D");

	// Leaving the input re-enables the shortcut; that download is the only one.
	await search.fill("");
	await search.blur();
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`),
	).toBeVisible();
	await page.locator('[data-photo-id="1"]').click();
	const downloadPromise = page.waitForEvent("download");
	await page.keyboard.press("Shift+D");
	await downloadPromise;
	expect(downloads).toBe(1);
	expect(requested).toHaveLength(1);
});

/** Seeds collections through the default handlers on first read. */
function seedCollections(
	seed: { name: string; photoIds?: number[] }[],
): HandlerOverrides {
	let seeded = false;
	return {
		collections: async (input, defaults) => {
			if (!seeded) {
				seeded = true;
				for (const collection of seed) {
					await defaults.createCollection(collection, defaults);
				}
			}
			return defaults.collections(input, defaults);
		},
	};
}

test("collection menu offers Download as ZIP per size", async ({
	page,
	mockBackend,
}) => {
	await mockBackend(seedCollections([{ name: "Trip 2024", photoIds: [1, 2] }]));
	await openLibrary(page);
	const api = await apiOrigin(page);

	const leftPanel = page.getByTestId("left-panel");
	const row = leftPanel
		.getByTestId("collection-row")
		.filter({ has: page.getByText("Trip 2024", { exact: true }) });
	const id = await row.getAttribute("data-collection-id");
	await row.hover();
	await leftPanel
		.getByRole("button", { name: "Collection actions for Trip 2024" })
		.click();
	const zipToggle = leftPanel.getByRole("menuitem", {
		name: "Download as ZIP",
	});
	await expect(zipToggle).toHaveAttribute("aria-expanded", "false");
	await zipToggle.click();
	await expect(zipToggle).toHaveAttribute("aria-expanded", "true");

	const sizes = leftPanel
		.getByRole("menu", { name: "Download Trip 2024 as ZIP" })
		.getByRole("menuitem");
	await expect(sizes).toHaveText(["Originals", "JPEG 2048", "JPEG 1024"]);
	for (const [index, size] of ["original", "2048", "1024"].entries()) {
		await expect(sizes.nth(index)).toHaveAttribute(
			"href",
			`${api}/api/collections/${id}/export?size=${size}`,
		);
		await expect(sizes.nth(index)).toHaveAttribute("download", "Trip 2024.zip");
	}

	// Choosing a size downloads the ZIP and closes the menu.
	await page.route(/\/api\/collections\/\d+\/export/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/zip",
			headers: {
				"Content-Disposition": 'attachment; filename="Trip 2024.zip"',
			},
			body: Buffer.from("PK\u0005\u0006".padEnd(22, "\0"), "latin1"),
		}),
	);
	const downloadPromise = page.waitForEvent("download");
	await sizes.nth(1).click();
	const download = await downloadPromise;
	expect(download.url()).toBe(`${api}/api/collections/${id}/export?size=2048`);
	await expect(
		leftPanel.getByRole("menu", { name: "Trip 2024 actions" }),
	).toHaveCount(0);
});
