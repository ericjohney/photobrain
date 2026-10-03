import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	filterFixturePhotos,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

// forest.jpg (8) and forest.arw (13) are a RAW+JPEG pair; portrait.arw (2) is
// an unpaired RAW.
const JPEG_ID = 8;
const RAW_ID = 13;

function gridCell(page: Page, id: number) {
	return page.locator(`[data-testid="photo-grid"] [data-photo-id="${id}"]`);
}

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

function typeRadio(page: Page, name: "All" | "RAW") {
	return page
		.getByTestId("left-panel")
		.getByRole("radio", { name, exact: true });
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

test("a RAW+JPEG pair is one grid cell with a combined badge", async ({
	page,
}) => {
	await openLibrary(page);
	const ids = await gridIds(page);
	expect(ids).toContain(JPEG_ID);
	expect(ids).not.toContain(RAW_ID);
	expect(ids).toHaveLength(FIXTURE_PHOTOS.length - 1);

	await expect(gridCell(page, JPEG_ID).getByTestId("raw-badge")).toHaveText(
		"ARW+JPG",
	);
	// An unpaired RAW keeps its own format; an unpaired JPEG has no badge.
	await expect(gridCell(page, 2).getByTestId("raw-badge")).toHaveText("ARW");
	await expect(gridCell(page, 1).getByTestId("raw-badge")).toHaveCount(0);
});

test("loupe, filmstrip and the metadata Pair row show the partner", async ({
	page,
}) => {
	await openLibrary(page);
	await gridCell(page, JPEG_ID).dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	await expect(page.getByTestId("loupe-raw-badge")).toHaveText("ARW+JPG");
	const filmstripBadge = page
		.locator(`[data-filmstrip-photo-id="${JPEG_ID}"]`)
		.getByTestId("filmstrip-raw-badge");
	await expect(filmstripBadge).toHaveText("R+J");
	await expect(filmstripBadge).toHaveAttribute("title", "ARW+JPG");

	const pair = page.getByTestId("right-panel").getByTestId("photo-pair");
	await expect(pair).toContainText("Pair");
	await expect(pair).toContainText("forest.arw");
	await expect(pair).toContainText("ARW");

	// An unpaired RAW has no Pair row.
	await page.keyboard.press("Escape");
	await gridCell(page, 2).click();
	await expect(
		page.getByTestId("right-panel").getByText("portrait.arw"),
	).toBeVisible();
	await expect(
		page.getByTestId("right-panel").getByTestId("photo-pair"),
	).toHaveCount(0);
});

test("the RAW filter shows the paired RAW with its combined badge and Pair row", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await page.getByTestId("left-panel").getByText("Filter By").click();
	await typeRadio(page, "RAW").click();

	const rawIds = filterFixturePhotos(FIXTURE_PHOTOS, { filterRaw: "raw" }).map(
		(p) => p.id,
	);
	expect(rawIds).toContain(RAW_ID);
	await expect.poll(() => gridIds(page)).toEqual(rawIds);
	expect(calls.photos?.at(-1)).toEqual({ filterRaw: "raw" });
	await expect(gridCell(page, RAW_ID).getByTestId("raw-badge")).toHaveText(
		"ARW+JPG",
	);

	await gridCell(page, RAW_ID).click();
	const pair = page.getByTestId("right-panel").getByTestId("photo-pair");
	await expect(pair).toContainText("forest.jpg");
	await expect(pair).toContainText("JPG");
	expect(calls.photo).toContainEqual({ id: JPEG_ID });
});

test("rating the stacked photo updates both files of the pair", async ({
	page,
	mockBackend,
}) => {
	const results: unknown[] = [];
	await mockBackend({
		setPhotoCuration: async (input, defaults) => {
			const result = await defaults.setPhotoCuration(input, defaults);
			results.push(result);
			return result;
		},
	});
	await openLibrary(page);
	await gridCell(page, JPEG_ID).click();
	await page.keyboard.press("2");

	await expect
		.poll(() => results)
		.toEqual([
			{
				updated: [
					{ id: JPEG_ID, rating: 2, flag: "pick" },
					{ id: RAW_ID, rating: 2, flag: "pick" },
				],
			},
		]);
	await expect(
		gridCell(page, JPEG_ID).getByRole("img", { name: "2 stars" }),
	).toBeVisible();

	// The RAW partner carries the rating too.
	await page.getByTestId("left-panel").getByText("Filter By").click();
	await typeRadio(page, "RAW").click();
	await expect(
		gridCell(page, RAW_ID).getByRole("img", { name: "2 stars" }),
	).toBeVisible();
});
