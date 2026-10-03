import type { Page } from "@playwright/test";
import {
	FIXTURE_PHOTOS,
	type FixturePhotoFilters,
	filterFixturePhotos,
	searchPhotosByQuery,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

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

function tagList(page: Page) {
	return page.getByTestId("left-panel").getByTestId("tag-filter-list");
}

/** Tag filter rows as [display name, count] in rendered order. */
async function tagRows(page: Page) {
	return tagList(page)
		.locator("button[aria-pressed]")
		.evaluateAll((buttons) =>
			buttons.map((button) =>
				// Children: icon, label, count.
				Array.from(button.children)
					.slice(1)
					.map((child) => child.textContent),
			),
		);
}

function tagFilter(page: Page, name: string) {
	return tagList(page).locator("button[aria-pressed]", {
		has: page.getByText(name, { exact: true }),
	});
}

function photoTagChips(page: Page) {
	return page
		.getByTestId("right-panel")
		.getByRole("list", { name: "Photo tags" })
		.getByRole("button");
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_PHOTOS.length} photos`, { exact: true }),
	).toBeVisible();
}

async function expectGrid(page: Page, filters: FixturePhotoFilters) {
	const ids = filterFixturePhotos(FIXTURE_PHOTOS, filters).map((p) => p.id);
	await expect(
		page.getByText(`${ids.length} photos`, { exact: true }),
	).toBeVisible();
	await expect.poll(() => gridIds(page)).toEqual(ids);
}

const TOP_TAGS = [
	["Sky", "3"],
	["Beach", "2"],
	["City", "2"],
	["Flowers", "2"],
	["Mountain", "2"],
	["Night sky", "2"],
	["Architecture", "1"],
	["Dog", "1"],
	["Forest", "1"],
	["Garden", "1"],
	["Landscape", "1"],
	["Macro", "1"],
];

const REMAINING_TAGS = [
	["Ocean", "1"],
	["Person", "1"],
	["Pet", "1"],
	["Portrait", "1"],
	["Snow", "1"],
	["Street", "1"],
	["Sunset", "1"],
	["Tree", "1"],
];

test("Tags lists the top 12 tags by count, in Title Case, and Show all reveals the rest", async ({
	page,
}) => {
	await openLibrary(page);
	await page.getByTestId("left-panel").getByText("Filter By").click();

	await expect.poll(() => tagRows(page)).toEqual(TOP_TAGS);
	const toggle = tagList(page).getByRole("button", { name: "Show all (20)" });
	await toggle.click();
	await expect
		.poll(() => tagRows(page))
		.toEqual([...TOP_TAGS, ...REMAINING_TAGS]);

	await tagList(page).getByRole("button", { name: "Show fewer" }).click();
	await expect.poll(() => tagRows(page)).toEqual(TOP_TAGS);
	await expect(toggle).toBeVisible();
});

test("selecting a tag scopes the library and search, toggles off, and clears with Clear all", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	const leftPanel = page.getByTestId("left-panel");
	await leftPanel.getByText("Filter By").click();
	await expect(leftPanel.getByText("Filters active")).toHaveCount(0);

	await tagFilter(page, "Beach").click();
	await expectGrid(page, { tag: "beach" });
	expect(calls.photos?.at(-1)).toEqual({ tag: "beach" });
	await expect(tagFilter(page, "Beach")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(leftPanel.getByText("Filters active")).toBeVisible();

	// Clicking the selected tag again clears it.
	await tagFilter(page, "Beach").click();
	await expectGrid(page, {});
	await expect(tagFilter(page, "Beach")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(leftPanel.getByText("Filters active")).toHaveCount(0);

	await tagFilter(page, "Beach").click();
	await expectGrid(page, { tag: "beach" });
	await page.getByPlaceholder("Search photos...").fill("jpg");
	const beachMatches = searchPhotosByQuery(
		"jpg",
		filterFixturePhotos(FIXTURE_PHOTOS, { tag: "beach" }),
	);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${beachMatches.length} results for “jpg” · #beach`,
	);
	expect(await gridIds(page)).toEqual(beachMatches.map((p) => p.id));
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		tag: "beach",
	});

	// Single-select: picking another tag replaces the first.
	await tagFilter(page, "Night sky").click();
	const nightMatches = searchPhotosByQuery(
		"jpg",
		filterFixturePhotos(FIXTURE_PHOTOS, { tag: "night-sky" }),
	);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${nightMatches.length} ${nightMatches.length === 1 ? "result" : "results"} for “jpg” · #night-sky`,
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		tag: "night-sky",
	});
	await expect(tagFilter(page, "Beach")).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	await leftPanel.getByRole("button", { name: "Clear all" }).click();
	await expect(leftPanel.getByText("Filters active")).toHaveCount(0);
	await expect(tagFilter(page, "Night sky")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${searchPhotosByQuery("jpg").length} results for “jpg”`,
	);
	expect(
		(calls.searchPhotos?.at(-1) as FixturePhotoFilters).tag,
	).toBeUndefined();

	await page.getByRole("button", { name: "Clear search" }).click();
	await expectGrid(page, {});
});

test("metadata panel shows the active photo's tags by score and a chip applies the filter", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	const rightPanel = page.getByTestId("right-panel");

	await gridCell(page, 11).click();
	await expect(rightPanel.getByText("No tags yet")).toBeVisible();
	await expect(photoTagChips(page)).toHaveCount(0);

	await gridCell(page, 7).click();
	await expect(photoTagChips(page)).toHaveText([
		"Night sky",
		"Mountain",
		"Snow",
	]);
	await expect(rightPanel.getByText("No tags yet")).toHaveCount(0);
	expect(calls.photoTags).toContainEqual({ photoId: 7 });

	// From the loupe, a chip filters the library and returns to the grid.
	await gridCell(page, 7).dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	await photoTagChips(page).filter({ hasText: "Night sky" }).click();
	await expect(page.getByTestId("loupe-view")).toHaveCount(0);
	await expectGrid(page, { tag: "night-sky" });
	expect(calls.photos?.at(-1)).toEqual({ tag: "night-sky" });

	const leftPanel = page.getByTestId("left-panel");
	await leftPanel.getByText("Filter By").click();
	await expect(tagFilter(page, "Night sky")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(leftPanel.getByText("Filters active")).toBeVisible();

	// A chip outside the collapsed top 12 still shows as the selected tag.
	await page.getByRole("button", { name: "Clear all" }).click();
	await expectGrid(page, {});
	await gridCell(page, 1).click();
	await expect(photoTagChips(page)).toHaveText(["Sunset", "Sky", "Beach"]);
	await photoTagChips(page).filter({ hasText: "Sunset" }).click();
	await expectGrid(page, { tag: "sunset" });
	await expect(tagFilter(page, "Sunset")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect
		.poll(() => tagRows(page))
		.toEqual([...TOP_TAGS, ["Sunset", "1"]]);
});
