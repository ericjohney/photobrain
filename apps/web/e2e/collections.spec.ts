import type { Page } from "@playwright/test";
import type { HandlerOverrides } from "./fixtures/handlers";
import { FIXTURE_PHOTOS } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

const ALL_IDS = FIXTURE_PHOTOS.map((p) => p.id);

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

function collectionRow(page: Page, name: string) {
	return leftPanel(page)
		.getByTestId("collection-row")
		.filter({ has: page.getByText(name, { exact: true }) });
}

function collectionCount(page: Page, name: string) {
	return collectionRow(page, name).getByTestId("collection-count");
}

function photoCollectionChips(page: Page) {
	return page
		.getByTestId("right-panel")
		.getByRole("list", { name: "Photo collections" })
		.getByRole("listitem");
}

async function createViaPlus(page: Page, name: string) {
	await leftPanel(page).getByRole("button", { name: "New collection" }).click();
	const input = leftPanel(page).getByLabel("New collection name");
	await input.fill(name);
	await input.press("Enter");
}

async function openCollectionMenu(page: Page, name: string) {
	await collectionRow(page, name).hover();
	await leftPanel(page)
		.getByRole("button", { name: `Collection actions for ${name}` })
		.click();
}

async function openAddToCollection(page: Page) {
	await page
		.getByTestId("right-panel")
		.getByRole("button", { name: "Add to collection" })
		.click();
	return page.getByRole("dialog", { name: "Add to collection" });
}

/** Seeds the page's collection store through the default handlers on first read. */
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

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(page.getByText(`${FIXTURE_PHOTOS.length} photos`)).toBeVisible();
}

test("+ creates a collection on Enter and lists it with a zero count", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await expect(leftPanel(page).getByText("No collections yet")).toBeVisible();

	await createViaPlus(page, "  Travel  ");

	await expect(collectionCount(page, "Travel")).toHaveText("0");
	await expect(leftPanel(page).getByLabel("New collection name")).toHaveCount(
		0,
	);
	await expect(leftPanel(page).getByText("No collections yet")).toHaveCount(0);
	expect(calls.createCollection).toEqual([{ name: "Travel" }]);

	// Escape cancels a new name without creating anything.
	await leftPanel(page).getByRole("button", { name: "New collection" }).click();
	await leftPanel(page).getByLabel("New collection name").fill("Draft");
	await leftPanel(page).getByLabel("New collection name").press("Escape");
	await expect(leftPanel(page).getByLabel("New collection name")).toHaveCount(
		0,
	);
	await expect(leftPanel(page).getByTestId("collection-row")).toHaveCount(1);
	expect(calls.createCollection).toHaveLength(1);
});

test("a case-insensitive duplicate name shows an inline error and keeps the field open", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await createViaPlus(page, "Travel");
	await expect(collectionCount(page, "Travel")).toHaveText("0");

	await createViaPlus(page, "travel");

	const input = leftPanel(page).getByLabel("New collection name");
	await expect(leftPanel(page).getByRole("alert")).toHaveText(
		"A collection named “travel” already exists",
	);
	await expect(input).toBeVisible();
	await expect(input).toHaveAttribute("aria-invalid", "true");
	await expect(leftPanel(page).getByTestId("collection-row")).toHaveCount(1);
	expect(calls.createCollection).toEqual([
		{ name: "Travel" },
		{ name: "travel" },
	]);

	// Editing the name clears the error; a unique name then succeeds.
	await input.fill("Travel 2024");
	await expect(leftPanel(page).getByRole("alert")).toHaveCount(0);
	await input.press("Enter");
	await expect(collectionCount(page, "Travel 2024")).toHaveText("0");
});

test("selecting a collection scopes the grid, clears the folder and names the header", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel", photoIds: [3, 6] }]),
	);
	await openLibrary(page);
	await leftPanel(page).getByText("2024", { exact: true }).click();
	await expect(leftPanel(page).getByText("Showing: photos/2024")).toBeVisible();

	await collectionRow(page, "Travel").getByRole("button").first().click();

	await expect.poll(() => gridIds(page)).toEqual([3, 6]);
	await expect(page.getByTestId("collection-header")).toContainText("Travel");
	await expect(page.getByTestId("collection-header")).toContainText("2 photos");
	await expect(
		collectionRow(page, "Travel").getByRole("button").first(),
	).toHaveAttribute("aria-current", "true");
	await expect(leftPanel(page).getByText("Showing: photos/2024")).toHaveCount(
		0,
	);
	expect(calls.photos?.at(-1)).toEqual({ collectionId: 1 });

	// "All Photos" clears the collection scope.
	await leftPanel(page)
		.getByRole("button", { name: /All Photos/ })
		.click();
	await expect.poll(() => gridIds(page)).toEqual(ALL_IDS);
	await expect(page.getByTestId("collection-header")).toHaveCount(0);
});

test("selecting a folder clears the selected collection", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel", photoIds: [3, 6] }]),
	);
	await openLibrary(page);
	await collectionRow(page, "Travel").getByRole("button").first().click();
	await expect.poll(() => gridIds(page)).toEqual([3, 6]);

	await leftPanel(page).getByText("2024", { exact: true }).click();

	await expect.poll(() => gridIds(page)).toEqual(ALL_IDS);
	await expect(page.getByTestId("collection-header")).toHaveCount(0);
	await expect(
		collectionRow(page, "Travel").getByRole("button").first(),
	).not.toHaveAttribute("aria-current");
	expect(calls.photos?.at(-1)).toEqual({ folder: "photos/2024" });
});

test("the metadata popover adds the active photo, updating chips and the sidebar count", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel" }, { name: "Family" }]),
	);
	await openLibrary(page);
	await gridCell(page, 1).click();
	await expect(photoCollectionChips(page)).toHaveCount(0);

	const popover = await openAddToCollection(page);
	const travel = popover.getByRole("checkbox", { name: /Travel/ });
	await expect(travel).not.toBeChecked();
	await travel.click();

	await expect(travel).toBeChecked();
	await expect(photoCollectionChips(page)).toHaveText(["Travel"]);
	await expect(collectionCount(page, "Travel")).toHaveText("1");
	await expect(collectionCount(page, "Family")).toHaveText("0");
	expect(calls.addToCollection).toEqual([{ collectionId: 1, photoIds: [1] }]);

	// Chips follow the active photo.
	await page.keyboard.press("Escape");
	await expect(popover).toHaveCount(0);
	await gridCell(page, 2).click();
	await expect(photoCollectionChips(page)).toHaveCount(0);
	await gridCell(page, 1).click();
	await expect(photoCollectionChips(page)).toHaveText(["Travel"]);
});

test("unchecking a collection while viewing it removes the photo from the grid", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel", photoIds: [3, 6] }]),
	);
	await openLibrary(page);
	await collectionRow(page, "Travel").getByRole("button").first().click();
	await expect.poll(() => gridIds(page)).toEqual([3, 6]);
	await gridCell(page, 3).click();
	await expect(photoCollectionChips(page)).toHaveText(["Travel"]);

	const popover = await openAddToCollection(page);
	const travel = popover.getByRole("checkbox", { name: /Travel/ });
	await expect(travel).toBeChecked();
	await travel.click();
	await expect(travel).not.toBeChecked();

	await expect.poll(() => gridIds(page)).toEqual([6]);
	await expect(collectionCount(page, "Travel")).toHaveText("1");
	await expect(page.getByTestId("collection-header")).toContainText("1 photo");
	await expect(photoCollectionChips(page)).toHaveCount(0);
	expect(calls.removeFromCollection).toEqual([
		{ collectionId: 1, photoIds: [3] },
	]);
});

test("New collection… in the popover creates a collection containing the photo", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(seedCollections([{ name: "Travel" }]));
	await openLibrary(page);
	await gridCell(page, 2).click();

	const popover = await openAddToCollection(page);
	await popover.getByRole("button", { name: "New collection…" }).click();
	const input = popover.getByLabel("New collection name");
	await input.fill("Portraits");
	await input.press("Enter");

	await expect(photoCollectionChips(page)).toHaveText(["Portraits"]);
	await expect(collectionCount(page, "Portraits")).toHaveText("1");
	await expect(
		popover.getByRole("checkbox", { name: /Portraits/ }),
	).toBeChecked();
	await expect(
		popover.getByRole("checkbox", { name: /Travel/ }),
	).not.toBeChecked();
	expect(calls.createCollection).toEqual([
		{ name: "Portraits", photoIds: [2] },
	]);

	// Duplicate names are reported inline in the popover too.
	await popover.getByRole("button", { name: "New collection…" }).click();
	await popover.getByLabel("New collection name").fill("TRAVEL");
	await popover.getByLabel("New collection name").press("Enter");
	await expect(popover.getByRole("alert")).toHaveText(
		"A collection named “TRAVEL” already exists",
	);
});

test("B toggles the active photo in the last-used collection and is ignored while typing", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(seedCollections([{ name: "Travel" }]));
	await openLibrary(page);
	await gridCell(page, 4).click();
	await expect(photoCollectionChips(page)).toHaveCount(0);

	// No collection used yet: B does nothing.
	await page.keyboard.press("b");

	await createViaPlus(page, "Favorites");
	await expect(collectionCount(page, "Favorites")).toHaveText("0");
	expect(calls.addToCollection).toBeUndefined();

	await page.keyboard.press("b");
	await expect(collectionCount(page, "Favorites")).toHaveText("1");
	await expect(photoCollectionChips(page)).toHaveText(["Favorites"]);
	expect(calls.addToCollection).toEqual([{ collectionId: 2, photoIds: [4] }]);

	await page.keyboard.press("b");
	await expect(collectionCount(page, "Favorites")).toHaveText("0");
	await expect(photoCollectionChips(page)).toHaveCount(0);
	expect(calls.removeFromCollection).toEqual([
		{ collectionId: 2, photoIds: [4] },
	]);

	// Adding via the popover makes that collection the B target.
	const popover = await openAddToCollection(page);
	await popover.getByRole("checkbox", { name: /Travel/ }).click();
	await expect(popover.getByRole("checkbox", { name: /Travel/ })).toBeChecked();
	await expect(collectionCount(page, "Travel")).toHaveText("1");
	await page.keyboard.press("Escape");
	await gridCell(page, 5).click();
	await page.keyboard.press("b");
	await expect(collectionCount(page, "Travel")).toHaveText("2");
	expect(calls.addToCollection?.at(-1)).toEqual({
		collectionId: 1,
		photoIds: [5],
	});

	// Typing "b" in the search field is not a shortcut.
	const addsBefore = calls.addToCollection?.length;
	await page.getByPlaceholder("Search photos...").fill("");
	await page.getByPlaceholder("Search photos...").press("b");
	await expect(page.getByPlaceholder("Search photos...")).toHaveValue("b");
	await expect(page.getByTestId("search-header")).toBeVisible();
	await expect(collectionCount(page, "Travel")).toHaveText("2");
	expect(calls.addToCollection).toHaveLength(addsBefore ?? 0);
	expect(calls.removeFromCollection).toHaveLength(1);
});

test("rename edits the collection inline and updates the header", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel", photoIds: [3] }, { name: "Family" }]),
	);
	await openLibrary(page);
	await collectionRow(page, "Travel").getByRole("button").first().click();
	await expect(page.getByTestId("collection-header")).toContainText("Travel");

	await openCollectionMenu(page, "Travel");
	await page.getByRole("menuitem", { name: "Rename" }).click();
	const input = leftPanel(page).getByLabel("Rename Travel");
	await expect(input).toHaveValue("Travel");

	// Renaming onto another collection's name is rejected inline.
	await input.fill("family");
	await input.press("Enter");
	await expect(leftPanel(page).getByRole("alert")).toHaveText(
		"A collection named “family” already exists",
	);

	await input.fill("Trips");
	await input.press("Enter");

	await expect(collectionCount(page, "Trips")).toHaveText("1");
	await expect(collectionRow(page, "Travel")).toHaveCount(0);
	await expect(page.getByTestId("collection-header")).toContainText("Trips");
	expect(calls.renameCollection).toEqual([
		{ id: 1, name: "family" },
		{ id: 1, name: "Trips" },
	]);
});

test("deleting the selected collection after confirming returns to All Photos", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel", photoIds: [3, 6] }]),
	);
	await openLibrary(page);
	await collectionRow(page, "Travel").getByRole("button").first().click();
	await expect.poll(() => gridIds(page)).toEqual([3, 6]);

	// Cancel keeps the collection.
	await openCollectionMenu(page, "Travel");
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const dialog = page.getByRole("dialog", { name: "Delete “Travel”?" });
	await expect(dialog).toContainText("Its photos stay in your library");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(collectionRow(page, "Travel")).toHaveCount(1);
	expect(calls.deleteCollection).toBeUndefined();

	await openCollectionMenu(page, "Travel");
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await dialog.getByRole("button", { name: "Delete collection" }).click();

	await expect(dialog).toHaveCount(0);
	await expect(collectionRow(page, "Travel")).toHaveCount(0);
	await expect(page.getByTestId("collection-header")).toHaveCount(0);
	await expect.poll(() => gridIds(page)).toEqual(ALL_IDS);
	expect(calls.deleteCollection).toEqual([{ id: 1 }]);
});

test("search within a collection sends collectionId and names it in the header", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(
		seedCollections([{ name: "Travel", photoIds: [3, 4, 6] }]),
	);
	await openLibrary(page);
	await collectionRow(page, "Travel").getByRole("button").first().click();
	await expect.poll(() => gridIds(page)).toEqual([3, 4, 6]);

	await page.getByPlaceholder("Search photos...").fill("jpg");

	await expect(page.getByTestId("search-header")).toHaveText(
		"2 results for “jpg” in Travel",
	);
	expect(await gridIds(page)).toEqual([3, 6]);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		collectionId: 1,
	});

	// Clearing the search returns to the collection-scoped grid.
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect.poll(() => gridIds(page)).toEqual([3, 4, 6]);
	await expect(page.getByTestId("collection-header")).toContainText("Travel");
});

test("the /collections placeholder route no longer exists", async ({
	page,
}) => {
	await page.goto("/collections");
	await expect(page.locator("#root")).toBeAttached();
	await expect(page.getByText("Coming soon...")).toHaveCount(0);
	await expect(
		page.getByText("Organize your photos into collections"),
	).toHaveCount(0);
	await expect(page.getByTestId("left-panel")).toHaveCount(0);
});
