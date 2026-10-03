import type { Page } from "@playwright/test";
import type { HandlerOverrides } from "./fixtures/handlers";
import {
	FIXTURE_PHOTOS,
	filterFixturePhotos,
	searchPhotosByQuery,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

const ALL_IDS = FIXTURE_PHOTOS.map((p) => p.id);

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

function leftPanel(page: Page) {
	return page.getByTestId("left-panel");
}

function albumRow(page: Page, name: string) {
	return leftPanel(page)
		.getByTestId("smart-album-row")
		.filter({ has: page.getByText(name, { exact: true }) });
}

function albumButton(page: Page, name: string) {
	return albumRow(page, name).getByRole("button").first();
}

async function openAlbumMenu(page: Page, name: string) {
	await albumRow(page, name).hover();
	await leftPanel(page)
		.getByRole("button", { name: `Smart album actions for ${name}` })
		.click();
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(page.getByText(`${FIXTURE_PHOTOS.length} photos`)).toBeVisible();
}

async function pickRaw(page: Page) {
	await leftPanel(page).getByText("Filter By").click();
	await leftPanel(page)
		.getByRole("radiogroup", { name: "Photo type" })
		.getByRole("radio", { name: "RAW" })
		.click();
}

/** Seeds the page's smart album store through the default handlers on first read. */
function seedAlbums(
	seed: { name: string; filters: object; query?: string }[],
): HandlerOverrides {
	let seeded = false;
	return {
		smartAlbums: async (input, defaults) => {
			if (!seeded) {
				seeded = true;
				for (const album of seed) {
					await defaults.createSmartAlbum(album, defaults);
				}
			}
			return defaults.smartAlbums(input, defaults);
		},
	};
}

test("Save as Smart Album stores the current filters and search query", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await expect(leftPanel(page).getByText("No smart albums yet")).toBeVisible();
	// Nothing to save without a filter or query.
	const save = leftPanel(page).getByRole("button", {
		name: "Save as Smart Album…",
	});
	await expect(save).toHaveCount(0);

	await leftPanel(page).getByText("2024", { exact: true }).click();
	await pickRaw(page);
	await page.getByPlaceholder("Search photos...").fill("macro");
	await expect(page.getByTestId("search-header")).toContainText("“macro”");

	await save.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await expect(dialog).toContainText("“macro” · photos/2024 · RAW only");
	await dialog.getByLabel("Smart album name").fill("  Macro RAWs  ");
	await dialog.getByRole("button", { name: "Save smart album" }).click();

	await expect(dialog).toHaveCount(0);
	expect(calls.createSmartAlbum).toEqual([
		{
			name: "Macro RAWs",
			filters: { filterRaw: "raw", folder: "photos/2024" },
			query: "macro",
		},
	]);
	// A query album has no stable count; it is selected since it matches the view.
	await expect(
		albumRow(page, "Macro RAWs").getByLabel("Search album"),
	).toBeVisible();
	await expect(albumButton(page, "Macro RAWs")).toHaveAttribute(
		"aria-current",
		"true",
	);
	await expect(page.getByTestId("smart-album-header")).toContainText(
		"Macro RAWs",
	);
});

test("a filter-only album is listed with its live count and saves without a query", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await pickRaw(page);
	await expect
		.poll(() => gridIds(page))
		.toEqual(
			filterFixturePhotos(FIXTURE_PHOTOS, { filterRaw: "raw" }).map(
				(p) => p.id,
			),
		);

	await leftPanel(page)
		.getByRole("button", { name: "Save as Smart Album…" })
		.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await dialog.getByLabel("Smart album name").fill("RAW");
	await dialog.getByLabel("Smart album name").press("Enter");

	await expect(
		albumRow(page, "RAW").getByTestId("smart-album-count"),
	).toHaveText(
		String(filterFixturePhotos(FIXTURE_PHOTOS, { filterRaw: "raw" }).length),
	);
	expect(calls.createSmartAlbum).toEqual([
		{ name: "RAW", filters: { filterRaw: "raw" } },
	]);
});

test("a duplicate name in the save dialog shows the conflict inline", async ({
	page,
	mockBackend,
}) => {
	await mockBackend(seedAlbums([{ name: "Picks", filters: { flag: "pick" } }]));
	await openLibrary(page);
	await expect(albumRow(page, "Picks")).toHaveCount(1);
	await pickRaw(page);
	await leftPanel(page)
		.getByRole("button", { name: "Save as Smart Album…" })
		.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await dialog.getByLabel("Smart album name").fill("picks");
	await dialog.getByRole("button", { name: "Save smart album" }).click();

	await expect(dialog.getByRole("alert")).toHaveText(
		"A smart album named “picks” already exists",
	);
	await expect(dialog.getByLabel("Smart album name")).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await expect(leftPanel(page).getByTestId("smart-album-row")).toHaveCount(1);
});

test("clicking an album replaces filters, folder, and search and leaves collection/similar/review", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedAlbums([
			{ name: "Top rated", filters: { minRating: 4, folder: "photos/2024" } },
			{ name: "Beach search", filters: { minRating: 3 }, query: "beach" },
		]),
	);
	await openLibrary(page);
	// Start from an unrelated filter and Review mode.
	await leftPanel(page).getByText("Filter By").click();
	await leftPanel(page)
		.getByRole("radiogroup", { name: "Flag" })
		.getByRole("radio", { name: "Rejected" })
		.click();
	await leftPanel(page)
		.getByRole("button", { name: /Review/ })
		.click();

	await albumButton(page, "Top rated").click();

	const expected = filterFixturePhotos(FIXTURE_PHOTOS, {
		minRating: 4,
		folder: "photos/2024",
	}).map((p) => p.id);
	await expect.poll(() => gridIds(page)).toEqual(expected);
	expect(calls.photos?.at(-1)).toEqual({
		folder: "photos/2024",
		minRating: 4,
	});
	await expect(albumButton(page, "Top rated")).toHaveAttribute(
		"aria-current",
		"true",
	);
	await expect(page.getByTestId("smart-album-header")).toContainText(
		`Top rated${expected.length} photos`,
	);
	await expect(page.getByTestId("review-header")).toHaveCount(0);
	// Filter By remounts collapsed after Review hid it.
	await leftPanel(page).getByText("Filter By").click();
	await expect(
		leftPanel(page)
			.getByRole("radiogroup", { name: "Flag" })
			.getByRole("radio", { name: "Any" }),
	).toHaveAttribute("aria-checked", "true");

	// A query album runs a search with its filters, replacing the folder.
	await albumButton(page, "Beach search").click();
	await expect(page.getByPlaceholder("Search photos...")).toHaveValue("beach");
	await expect
		.poll(() => calls.searchPhotos?.at(-1))
		.toEqual({ query: "beach", limit: 100, minRating: 3 });
	await expect
		.poll(() => gridIds(page))
		.toEqual(
			searchPhotosByQuery(
				"beach",
				filterFixturePhotos(FIXTURE_PHOTOS, { minRating: 3 }),
			).map((p) => p.id),
		);
	await expect(page.getByTestId("smart-album-header")).toContainText(
		"Beach search",
	);
	await expect(page.getByTestId("search-header")).toContainText("“beach”");
	await expect(albumButton(page, "Top rated")).not.toHaveAttribute(
		"aria-current",
		"true",
	);

	// ✕ leaves the album for the unfiltered library.
	await page.getByRole("button", { name: "Close smart album" }).click();
	await expect.poll(() => gridIds(page)).toEqual(ALL_IDS);
	await expect(page.getByPlaceholder("Search photos...")).toHaveValue("");
});

test("changing a filter after applying an album deselects it", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedAlbums([{ name: "Picks", filters: { flag: "pick" } }]),
	);
	await openLibrary(page);
	await albumButton(page, "Picks").click();
	await expect(page.getByTestId("smart-album-header")).toContainText("Picks");

	await pickRaw(page);

	await expect(page.getByTestId("smart-album-header")).toHaveCount(0);
	await expect(albumButton(page, "Picks")).not.toHaveAttribute(
		"aria-current",
		"true",
	);
	// The album was a starting point: its filter stays combined with the edit.
	await expect
		.poll(() => calls.photos?.at(-1))
		.toEqual({ flag: "pick", filterRaw: "raw" });

	// Restoring the album's exact filters does not silently reselect it.
	await leftPanel(page)
		.getByRole("radiogroup", { name: "Photo type" })
		.getByRole("radio", { name: "All" })
		.click();
	await expect.poll(() => calls.photos?.at(-1)).toEqual({ flag: "pick" });
	await expect(page.getByTestId("smart-album-header")).toHaveCount(0);
});

test("rename rejects a case-insensitive duplicate inline, then renames", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedAlbums([
			{ name: "Picks", filters: { flag: "pick" } },
			{ name: "RAW", filters: { filterRaw: "raw" } },
		]),
	);
	await openLibrary(page);
	await albumButton(page, "Picks").click();
	await expect(page.getByTestId("smart-album-header")).toContainText("Picks");

	await openAlbumMenu(page, "Picks");
	await page.getByRole("menuitem", { name: "Rename" }).click();
	const input = leftPanel(page).getByLabel("Rename Picks");
	await expect(input).toHaveValue("Picks");
	await input.fill("raw");
	await input.press("Enter");
	await expect(leftPanel(page).getByRole("alert")).toHaveText(
		"A smart album named “raw” already exists",
	);
	await expect(input).toHaveAttribute("aria-invalid", "true");

	await input.fill("Best");
	await input.press("Enter");
	await expect(albumRow(page, "Best")).toHaveCount(1);
	await expect(albumRow(page, "Picks")).toHaveCount(0);
	await expect(page.getByTestId("smart-album-header")).toContainText("Best");
	expect(calls.updateSmartAlbum).toEqual([
		{ id: 1, name: "raw" },
		{ id: 1, name: "Best" },
	]);
});

test("delete removes the album after confirming and keeps the applied filters", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedAlbums([{ name: "Picks", filters: { flag: "pick" } }]),
	);
	await openLibrary(page);
	await albumButton(page, "Picks").click();
	await expect(page.getByTestId("smart-album-header")).toContainText("Picks");

	// Cancel keeps the album.
	await openAlbumMenu(page, "Picks");
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const dialog = page.getByRole("dialog", { name: "Delete “Picks”?" });
	await expect(dialog).toContainText("No photos are changed");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	expect(calls.deleteSmartAlbum).toBeUndefined();

	await openAlbumMenu(page, "Picks");
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await dialog.getByRole("button", { name: "Delete smart album" }).click();

	await expect(dialog).toHaveCount(0);
	await expect(albumRow(page, "Picks")).toHaveCount(0);
	await expect(leftPanel(page).getByText("No smart albums yet")).toBeVisible();
	await expect(page.getByTestId("smart-album-header")).toHaveCount(0);
	expect(calls.deleteSmartAlbum).toEqual([{ id: 1 }]);
	expect(calls.photos?.at(-1)).toEqual({ flag: "pick" });
});
