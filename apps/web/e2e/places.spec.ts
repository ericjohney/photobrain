import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTO_PLACES,
	FIXTURE_PHOTOS,
	type FixturePhotoFilters,
	filterFixturePhotos,
	searchPhotosByQuery,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

const SEATTLE_ID = FIXTURE_PHOTO_PLACES[8].id;

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

function gridCell(page: Page, id: number) {
	return page.locator(`[data-testid="photo-grid"] [data-photo-id="${id}"]`);
}

function leftPanel(page: Page) {
	return page.getByTestId("left-panel");
}

function placeList(page: Page) {
	return leftPanel(page).getByTestId("place-filter-list");
}

function cityList(page: Page) {
	return placeList(page).getByTestId("city-filter-list");
}

/** Filter rows as [name, count]; rows are NavItems (icon, label, count). */
async function rows(selector: string, page: Page) {
	return leftPanel(page)
		.locator(selector)
		.evaluateAll((buttons) =>
			buttons.map((button) =>
				Array.from(button.children)
					.slice(1)
					.map((child) => child.textContent),
			),
		);
}

const countryRows = (page: Page) =>
	rows('[data-testid="place-filter-list"] > div > button[aria-pressed]', page);
const cityRows = (page: Page) =>
	rows('[data-testid="city-filter-list"] > button[aria-pressed]', page);

function countryFilter(page: Page, name: string) {
	return placeList(page).locator(":scope > div > button[aria-pressed]", {
		has: page.getByText(name, { exact: true }),
	});
}

function cityFilter(page: Page, name: string) {
	return cityList(page).locator("button[aria-pressed]", {
		has: page.getByText(name, { exact: true }),
	});
}

async function openFilters(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
	await leftPanel(page).getByText("Filter By").click();
}

async function expectGrid(page: Page, filters: FixturePhotoFilters) {
	const ids = filterFixturePhotos(FIXTURE_PHOTOS, filters).map((p) => p.id);
	await expect(
		page.getByText(`${ids.length} photos`, { exact: true }),
	).toBeVisible();
	await expect.poll(() => gridIds(page)).toEqual(ids);
}

test("Places lists countries with counts; a country filters and shows its cities", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openFilters(page);

	// Photo rows (the forest pair counts twice), count desc then name.
	await expect
		.poll(() => countryRows(page))
		.toEqual([
			["United States", "5"],
			["Fiji", "1"],
			["Samoa", "1"],
		]);
	await expect(cityList(page)).toHaveCount(0);

	await countryFilter(page, "United States").click();
	await expectGrid(page, { country: "US" });
	expect(calls.photos?.at(-1)).toEqual({ country: "US" });
	await expect(countryFilter(page, "United States")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect
		.poll(() => cityRows(page))
		.toEqual([
			["San Francisco", "2"],
			["Seattle", "2"],
			["Honolulu", "1"],
		]);

	// A city sends `place` alongside its country.
	await cityFilter(page, "Seattle").click();
	await expectGrid(page, { country: "US", place: SEATTLE_ID });
	expect(calls.photos?.at(-1)).toEqual({ country: "US", place: SEATTLE_ID });
	await expect(cityFilter(page, "Seattle")).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Search and the map are scoped the same way.
	await page.getByPlaceholder("Search photos...").fill("jpg");
	const matches = searchPhotosByQuery(
		"jpg",
		filterFixturePhotos(FIXTURE_PHOTOS, { country: "US", place: SEATTLE_ID }),
	);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${matches.length} ${matches.length === 1 ? "result" : "results"} for “jpg” · Seattle`,
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		country: "US",
		place: SEATTLE_ID,
	});
	await page.getByRole("button", { name: "Clear search" }).click();

	// Another country replaces the selection and drops the city.
	await countryFilter(page, "Fiji").click();
	await expectGrid(page, { country: "FJ" });
	expect(calls.photos?.at(-1)).toEqual({ country: "FJ" });
	await expect.poll(() => cityRows(page)).toEqual([["Nadi", "1"]]);

	// Clicking the selected country clears it (and any city).
	await countryFilter(page, "Fiji").click();
	await expectGrid(page, {});
	await expect(cityList(page)).toHaveCount(0);
	await expect(leftPanel(page).getByText("Filters active")).toHaveCount(0);
});

test("country and city chips remove their filters; Clear all clears both", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openFilters(page);
	const countryChip = leftPanel(page).getByTestId("country-chip");
	const placeChip = leftPanel(page).getByTestId("place-chip");

	await countryFilter(page, "United States").click();
	await cityFilter(page, "Seattle").click();
	await expectGrid(page, { country: "US", place: SEATTLE_ID });
	await expect(countryChip).toHaveText("United States");
	await expect(placeChip).toHaveText("Seattle");

	await placeChip.getByRole("button", { name: "Clear place" }).click();
	// Previously fetched scopes come from the query cache, so the grid (not
	// the request log) proves the filter from here on.
	await expectGrid(page, { country: "US" });
	await expect(placeChip).toHaveCount(0);
	await expect(countryChip).toHaveText("United States");

	// Removing the country also removes its city.
	await cityFilter(page, "San Francisco").click();
	await expect(placeChip).toHaveText("San Francisco");
	await countryChip.getByRole("button", { name: "Clear country" }).click();
	await expectGrid(page, {});
	await expect(countryChip).toHaveCount(0);
	await expect(placeChip).toHaveCount(0);

	await countryFilter(page, "Samoa").click();
	await cityFilter(page, "Apia").click();
	await expect(placeChip).toHaveText("Apia");
	await expect
		.poll(() => calls.photos?.at(-1))
		.toEqual({
			country: "WS",
			place: FIXTURE_PHOTO_PLACES[9].id,
		});
	await leftPanel(page).getByRole("button", { name: "Clear all" }).click();
	await expectGrid(page, {});
	await expect(leftPanel(page).getByText("Filters active")).toHaveCount(0);
	await expect(countryFilter(page, "Samoa")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
});

test("Save as Smart Album stores country and place, and applying restores them", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openFilters(page);
	await countryFilter(page, "United States").click();
	await cityFilter(page, "Seattle").click();
	await expectGrid(page, { country: "US", place: SEATTLE_ID });

	await leftPanel(page)
		.getByRole("button", { name: "Save as Smart Album…" })
		.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await expect(dialog).toContainText("Seattle");
	await dialog.getByLabel("Smart album name").fill("Seattle");
	await dialog.getByRole("button", { name: "Save smart album" }).click();
	await expect(dialog).toHaveCount(0);
	expect(calls.createSmartAlbum).toEqual([
		{
			name: "Seattle",
			filters: { country: "US", place: SEATTLE_ID },
		},
	]);

	await leftPanel(page).getByRole("button", { name: "Clear all" }).click();
	await expectGrid(page, {});
	await leftPanel(page)
		.getByTestId("smart-album-row")
		.filter({ has: page.getByText("Seattle", { exact: true }) })
		.getByRole("button")
		.first()
		.click();
	await expectGrid(page, { country: "US", place: SEATTLE_ID });
	await expect(page.getByTestId("smart-album-header")).toContainText("Seattle");
	await expect(leftPanel(page).getByTestId("place-chip")).toHaveText("Seattle");
	await expect(leftPanel(page).getByTestId("country-chip")).toHaveText(
		"United States",
	);
});

test("metadata Place row follows the label rule, applies the filter, and is hidden without a place", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend({
		// Kyoto's region equals its city, so the label omits it.
		photoPlace: (input, defaults) =>
			typeof input === "object" &&
			input !== null &&
			"photoId" in input &&
			input.photoId === 3
				? {
						place: {
							id: 1857910,
							city: "Kyoto",
							region: "Kyoto",
							country: "Japan",
							countryCode: "JP",
						},
					}
				: defaults.photoPlace(input, defaults),
	});
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
	const rightPanel = page.getByTestId("right-panel");
	const placeRow = rightPanel.getByTestId("photo-place");

	await gridCell(page, 3).click();
	await expect(placeRow).toHaveText("PlaceKyoto, Japan");

	// Invalid GPS: the Location section is shown, but there is no place.
	await gridCell(page, 10).click();
	await expect(rightPanel.getByText("Latitude")).toBeVisible();
	await expect.poll(() => calls.photoPlace).toContainEqual({ photoId: 10 });
	await expect(placeRow).toHaveCount(0);

	// From the loupe, the row filters the library by its city and returns to the grid.
	await gridCell(page, 8).dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	const seattle = placeRow.getByRole("button", {
		name: "Seattle, Washington, United States",
	});
	await expect(seattle).toBeVisible();
	await seattle.click();
	await expect(page.getByTestId("loupe-view")).toHaveCount(0);
	await expectGrid(page, { country: "US", place: SEATTLE_ID });
	expect(calls.photos?.at(-1)).toEqual({ country: "US", place: SEATTLE_ID });

	await leftPanel(page).getByText("Filter By").click();
	await expect(countryFilter(page, "United States")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(cityFilter(page, "Seattle")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});
