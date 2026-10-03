import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	type FixturePhotoFilters,
	filterFixturePhotos,
	searchPhotosByQuery,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

// RAW shows every RAW file, including forest.arw (13) whose JPEG partner is
// filtered out; All stacks that pair into forest.jpg (8).
const RAW_IDS = [2, 4, 13];
const STANDARD_IDS = FIXTURE_PHOTOS.filter((p) => !p.isRaw).map((p) => p.id);
const ALL_IDS = FIXTURE_LIBRARY.map((p) => p.id);

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

async function openTypeFilter(page: Page) {
	await page.getByTestId("left-panel").getByText("Filter By").click();
}

function typeRadio(page: Page, name: "All" | "RAW" | "Standard") {
	return page
		.getByTestId("left-panel")
		.getByRole("radio", { name, exact: true });
}

test("RAW, Standard and All switch the library request and grid", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await page.goto("/");
	await expect(page.getByText(`${ALL_IDS.length} photos`)).toBeVisible();
	await openTypeFilter(page);
	await expect(typeRadio(page, "All")).toHaveAttribute("aria-checked", "true");

	await typeRadio(page, "RAW").click();
	await expect(page.getByText(`${RAW_IDS.length} photos`)).toBeVisible();
	expect(await gridIds(page)).toEqual(RAW_IDS);
	expect(calls.photos?.at(-1)).toEqual({ filterRaw: "raw" });
	await expect(typeRadio(page, "RAW")).toHaveAttribute("aria-checked", "true");

	await typeRadio(page, "Standard").click();
	await expect(page.getByText(`${STANDARD_IDS.length} photos`)).toBeVisible();
	const standard = await gridIds(page);
	expect(standard).toEqual(STANDARD_IDS);
	expect(standard).not.toContain(2);
	expect(standard).not.toContain(4);
	expect(calls.photos?.at(-1)).toEqual({ filterRaw: "standard" });

	await typeRadio(page, "All").click();
	await expect(page.getByText(`${ALL_IDS.length} photos`)).toBeVisible();
	expect(await gridIds(page)).toEqual(ALL_IDS);
	// "all" is the API default and is never sent, so the unfiltered request
	// (served again from cache here) carries no filterRaw at all.
	const inputs = (calls.photos ?? []) as (FixturePhotoFilters | undefined)[];
	expect(inputs.some((input) => input?.filterRaw === undefined)).toBe(true);
	expect(inputs.some((input) => input?.filterRaw === "all")).toBe(false);
});

test("Clear all resets the type filter to All", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await page.goto("/");
	await openTypeFilter(page);
	await typeRadio(page, "RAW").click();
	await expect(page.getByText(`${RAW_IDS.length} photos`)).toBeVisible();
	await expect(page.getByText("Filters active")).toBeVisible();

	await page.getByRole("button", { name: "Clear all" }).click();
	await expect(page.getByText(`${ALL_IDS.length} photos`)).toBeVisible();
	await expect(typeRadio(page, "All")).toHaveAttribute("aria-checked", "true");
	await expect(page.getByText("Filters active")).toHaveCount(0);
	expect(
		(calls.photos ?? []).some(
			(input) => (input as FixturePhotoFilters | undefined)?.filterRaw === "all",
		),
	).toBe(false);
});

test("the type filter scopes search requests and the search header", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await page.goto("/");
	await openTypeFilter(page);
	await typeRadio(page, "RAW").click();
	await expect(page.getByText(`${RAW_IDS.length} photos`)).toBeVisible();

	const query = "photos";
	const rawMatches = searchPhotosByQuery(
		query,
		filterFixturePhotos(FIXTURE_PHOTOS, { filterRaw: "raw" }),
	).map((p) => p.id);
	expect(rawMatches).toEqual(RAW_IDS);
	await page.getByPlaceholder("Search photos...").fill(query);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${RAW_IDS.length} results for “${query}” · RAW only`,
	);
	expect(await gridIds(page)).toEqual(RAW_IDS);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query,
		limit: 50,
		filterRaw: "raw",
	});

	await typeRadio(page, "Standard").click();
	const standardMatches = searchPhotosByQuery(
		query,
		filterFixturePhotos(FIXTURE_PHOTOS, { filterRaw: "standard" }),
	);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${standardMatches.length} results for “${query}” · Standard only`,
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query,
		limit: 50,
		filterRaw: "standard",
	});

	await typeRadio(page, "All").click();
	const allMatches = searchPhotosByQuery(query, FIXTURE_LIBRARY);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${allMatches.length} results for “${query}”`,
	);
	expect(await gridIds(page)).toEqual(allMatches.map((p) => p.id));
	const lastSearch = calls.searchPhotos?.at(-1) as FixturePhotoFilters;
	expect(lastSearch.filterRaw).toBeUndefined();
});

test("loupe shows the RAW format badge only for RAW photos", async ({
	page,
}) => {
	await page.goto("/");
	await page.locator('[data-photo-id="2"]').dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	await expect(page.getByTestId("loupe-raw-badge")).toHaveText("ARW");

	await page.keyboard.press("Escape");
	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	await expect(page.getByTestId("loupe-raw-badge")).toHaveCount(0);
});
