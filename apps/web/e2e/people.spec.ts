import type { Locator, Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	FIXTURE_VIDEOS,
	type FixturePhotoFilters,
	filterFixturePhotos,
	fixtureGridIds,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

/** A promise the test resolves to release a held mock response. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function leftPanel(page: Page) {
	return page.getByTestId("left-panel");
}

function peopleItem(page: Page) {
	return leftPanel(page).getByRole("button", { name: /^People/ });
}

function card(page: Page, personId: number) {
	return page.locator(`[data-testid="person-card"][data-person-id="${personId}"]`);
}

/** Card labels in rendered order: the name, or "Add a name" when unnamed. */
async function cardLabels(page: Page) {
	return page
		.getByTestId("person-card")
		.evaluateAll((cards) =>
			cards.map(
				(card) =>
					card.querySelector('[data-testid="person-name"]')?.textContent ??
					card.querySelector("button:not([aria-label])")?.textContent ??
					"",
			),
		);
}

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

async function expectGrid(page: Page, filters: FixturePhotoFilters) {
	const ids = fixtureGridIds(filterFixturePhotos(FIXTURE_PHOTOS, filters));
	await expect.poll(() => gridIds(page)).toEqual(ids);
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

async function openPeople(page: Page) {
	await openLibrary(page);
	await expect(peopleItem(page)).toContainText("5");
	await peopleItem(page).click();
	await expect(page.getByTestId("people-view")).toBeVisible();
}

async function cardAction(page: Page, personId: number, action: string) {
	const target = card(page, personId);
	await target.hover();
	await target.getByRole("button", { name: /^Person actions for / }).click();
	await page.getByRole("menuitem", { name: action }).click();
}

function faceRow(page: Page, faceId: number) {
	return page.locator(`[data-testid="face-row"][data-face-id="${faceId}"]`);
}

function faceBox(page: Page, faceId: number) {
	return page.locator(`[data-testid="face-box"][data-face-id="${faceId}"]`);
}

function svg(width: number, height: number) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#888"/></svg>`;
}

test("People lists people in API order with placeholders and a count badge", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openPeople(page);

	await expect.poll(() => cardLabels(page)).toEqual([
		"Bob",
		"Alice",
		"Carol",
		"Add a name",
		"Add a name",
	]);
	await expect(page.getByTestId("person-count")).toHaveText([
		"3 photos",
		"2 photos",
		"1 photo",
		"2 photos",
		"1 photo",
	]);
	// Covers are face crops; a null cover shows the initial, or "?" unnamed.
	await expect(card(page, 2).getByTestId("person-avatar")).toHaveAttribute(
		"src",
		/\/api\/faces\/101\/crop\?size=256$/,
	);
	await expect(
		card(page, 4).getByTestId("person-avatar-placeholder"),
	).toHaveText("C");
	await expect(
		card(page, 5).getByTestId("person-avatar-placeholder"),
	).toHaveText("?");
	await expect(card(page, 3).getByTestId("person-avatar")).toHaveAttribute(
		"src",
		/\/api\/faces\/107\/crop/,
	);
	await expect(peopleItem(page)).toHaveAttribute("aria-pressed", "true");
	// The library listing is not requested while People is shown.
	const photoCalls = calls.photos?.length ?? 0;
	await page.waitForTimeout(100);
	expect(calls.photos?.length ?? 0).toBe(photoCalls);
});

test("clicking a person scopes the library, search, and smart albums to personId", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openPeople(page);

	await card(page, 2).getByRole("button", { name: "Show photos of Bob" }).click();
	await expect(page.getByTestId("people-view")).toHaveCount(0);
	await expectGrid(page, { personId: 2 });
	expect(calls.photos?.at(-1)).toEqual({ personId: 2 });
	await expect(page.getByTestId("person-header")).toHaveText("Person: Bob");
	await expect(peopleItem(page)).toHaveAttribute("aria-pressed", "false");

	// Search keeps the scope and names it.
	await page.getByPlaceholder("Search photos...").fill("jpg");
	await expect(page.getByTestId("search-header")).toContainText(
		"· Person: Bob",
	);
	expect(calls.searchPhotos?.at(-1)).toMatchObject({
		query: "jpg",
		personId: 2,
	});
	await page.getByRole("button", { name: "Clear search" }).click();

	// Save as Smart Album carries personId.
	await leftPanel(page)
		.getByRole("button", { name: "Save as Smart Album…" })
		.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await dialog.getByLabel("Smart album name").fill("Bob");
	await dialog.getByRole("button", { name: "Save smart album" }).click();
	await expect(dialog).toHaveCount(0);
	expect(calls.createSmartAlbum).toEqual([
		{ name: "Bob", filters: { personId: 2 } },
	]);

	// The saved album now heads the grid; the filter chip still clears the person.
	await leftPanel(page).getByRole("button", { name: "Clear person" }).click();
	await expect(page.getByTestId("smart-album-header")).toHaveCount(0);
	await expectGrid(page, {});
	expect(calls.photos?.at(-1)).toEqual({});
});

test("an unnamed person's scope label reads Unnamed", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openPeople(page);
	await card(page, 3)
		.getByRole("button", { name: "Show photos of Unnamed" })
		.click();
	await expect(page.getByTestId("person-header")).toHaveText(
		"Person: Unnamed",
	);
	await expectGrid(page, { personId: 3 });
	expect(calls.photos?.at(-1)).toEqual({ personId: 3 });

	// Leaving the person clears the filter.
	await page.getByRole("button", { name: "Leave person" }).click();
	await expect(page.getByTestId("person-header")).toHaveCount(0);
	await expectGrid(page, {});
	expect(calls.photos?.at(-1)).toEqual({});
});

test("rename saves on Enter, cancels on Escape, and clears an empty name", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openPeople(page);

	await cardAction(page, 2, "Rename");
	await page.getByLabel("Name for Bob").fill("  Robert ");
	await page.getByLabel("Name for Bob").press("Enter");
	await expect(card(page, 2).getByTestId("person-name")).toHaveText("Robert");
	expect(calls.updatePerson).toEqual([{ id: 2, name: "Robert" }]);

	await cardAction(page, 2, "Rename");
	await page.getByLabel("Name for Robert").fill("Bobby");
	await page.getByLabel("Name for Robert").press("Escape");
	await expect(page.getByLabel("Name for Robert")).toHaveCount(0);
	await expect(card(page, 2).getByTestId("person-name")).toHaveText("Robert");
	expect(calls.updatePerson).toHaveLength(1);

	await cardAction(page, 2, "Rename");
	await page.getByLabel("Name for Robert").fill("   ");
	await page.getByLabel("Name for Robert").press("Enter");
	await expect(
		card(page, 2).getByRole("button", { name: "Add a name" }),
	).toBeVisible();
	expect(calls.updatePerson).toEqual([
		{ id: 2, name: "Robert" },
		{ id: 2, name: null },
	]);

	// "Add a name" opens the same field.
	await card(page, 5).getByRole("button", { name: "Add a name" }).click();
	await page.getByLabel("Name for Unnamed").fill("Eve");
	await page.getByLabel("Name for Unnamed").press("Enter");
	await expect(card(page, 5).getByTestId("person-name")).toHaveText("Eve");
	expect(calls.updatePerson?.at(-1)).toEqual({ id: 5, name: "Eve" });
});

test("a failed rename restores the name and shows the error", async ({
	page,
	mockBackend,
}) => {
	const release = gate();
	const calls = await mockBackend({
		updatePerson: async () => {
			await release.opened;
			throw new Error("Database is locked");
		},
	});
	await openPeople(page);

	await cardAction(page, 1, "Rename");
	await page.getByLabel("Name for Alice").fill("Alicia");
	await page.getByLabel("Name for Alice").press("Enter");
	await expect(card(page, 1).getByTestId("person-name")).toHaveText("Alicia");

	release.open();
	await expect(card(page, 1).getByTestId("person-name")).toHaveText("Alice");
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't rename Alice: Database is locked",
	);
	expect(calls.updatePerson).toEqual([{ id: 1, name: "Alicia" }]);
	await page.getByRole("button", { name: "Dismiss error" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("hide and unhide, with Show hidden listing hidden people", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openPeople(page);

	await cardAction(page, 4, "Hide");
	await expect(card(page, 4)).toHaveCount(0);
	expect(calls.updatePerson).toEqual([{ id: 4, hidden: true }]);
	await expect(peopleItem(page)).toContainText("4");

	const showHidden = page.getByRole("button", { name: "Show hidden" });
	await showHidden.click();
	await expect(showHidden).toHaveAttribute("aria-pressed", "true");
	await expect(card(page, 4)).toContainText("Hidden");
	await expect(card(page, 6)).toContainText("Hidden");
	expect(calls.people?.at(-1)).toEqual({ includeHidden: true });

	await cardAction(page, 6, "Unhide");
	await expect(card(page, 6)).not.toContainText("Hidden");
	expect(calls.updatePerson?.at(-1)).toEqual({ id: 6, hidden: false });

	await showHidden.click();
	await expect(showHidden).toHaveAttribute("aria-pressed", "false");
	await expect(card(page, 6)).toBeVisible();
	await expect(card(page, 4)).toHaveCount(0);
	await expect(peopleItem(page)).toContainText("5");
});

async function pickMerge(page: Page, sourceId: number, other: string) {
	await cardAction(page, sourceId, "Merge");
	await page.getByRole("checkbox", { name: `Select ${other}` }).check();
	await page.getByRole("button", { name: "Merge into..." }).click();
}

test("merge picks a target among the selection and confirms first", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openPeople(page);

	// One selected person cannot be merged.
	await cardAction(page, 1, "Merge");
	await expect(
		page.getByRole("checkbox", { name: "Select Alice" }),
	).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Merge into..." }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Cancel merge" }).click();
	await expect(page.getByRole("checkbox")).toHaveCount(0);

	await pickMerge(page, 1, "Bob");
	const picker = page.getByRole("listbox", { name: "Merge into" });
	await expect(picker.getByRole("option")).toHaveText(["Alice", "Bob"]);
	await picker.getByRole("option", { name: "Bob" }).click();
	const dialog = page.getByRole("dialog", {
		name: "Merge 2 people into “Bob”?",
	});
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	expect(calls.mergePeople).toBeUndefined();

	await page.getByRole("button", { name: "Merge into..." }).click();
	await picker.getByRole("option", { name: "Bob" }).click();
	await dialog.getByRole("button", { name: "Merge people" }).click();
	await expect(card(page, 1)).toHaveCount(0);
	expect(calls.mergePeople).toEqual([{ targetId: 2, sourceIds: [1] }]);
	await expect(card(page, 2).getByTestId("person-count")).toHaveText(
		"4 photos",
	);
	await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("a failed merge restores the people and shows the error", async ({
	page,
	mockBackend,
}) => {
	const release = gate();
	const calls = await mockBackend({
		mergePeople: async () => {
			await release.opened;
			throw new Error("Database is locked");
		},
	});
	await openPeople(page);

	await pickMerge(page, 5, "Carol");
	await page
		.getByRole("listbox", { name: "Merge into" })
		.getByRole("option", { name: "Carol" })
		.click();
	await page
		.getByRole("dialog", { name: "Merge 2 people into “Carol”?" })
		.getByRole("button", { name: "Merge people" })
		.click();
	await expect(card(page, 5)).toHaveCount(0);

	release.open();
	await expect(card(page, 5)).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't merge into Carol: Database is locked",
	);
	expect(calls.mergePeople).toEqual([{ targetId: 4, sourceIds: [5] }]);
});

function assignInput(page: Page, faceId: number) {
	return page.getByRole("combobox", { name: `Assign face ${faceId}` });
}

function assignOption(page: Page, faceId: number, name: string) {
	return page
		.getByRole("listbox", { name: `People for face ${faceId}` })
		.getByRole("option", { name, exact: true });
}

async function openPhotoPeople(page: Page, photoId: number) {
	await openLibrary(page);
	await page.locator(`[data-testid="photo-grid"] [data-photo-id="${photoId}"]`).click();
	const section = page.getByTestId("right-panel").getByTestId("photo-people");
	await expect(section).toBeVisible();
	return section;
}

test("metadata People rows assign a new person, an existing one, or none", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	const section = await openPhotoPeople(page, 3);
	await expect(section.getByTestId("face-name")).toHaveText([
		"Bob",
		"Unknown",
		"Unknown",
	]);
	await expect(faceRow(page, 103).locator("img")).toHaveAttribute(
		"src",
		/\/api\/faces\/103\/crop\?size=128$/,
	);

	await assignInput(page, 104).fill("Eve");
	await assignOption(page, 104, "New person: Eve").click();
	await expect(faceRow(page, 104).getByTestId("face-name")).toHaveText("Eve");

	await assignInput(page, 110).fill("ali");
	await expect(
		page
			.getByRole("listbox", { name: "People for face 110" })
			.getByRole("option"),
	).toHaveText(["New person: ali", "Alice", "Not this person"]);
	await assignOption(page, 110, "Alice").click();
	await expect(faceRow(page, 110).getByTestId("face-name")).toHaveText("Alice");

	await assignInput(page, 103).click();
	await assignOption(page, 103, "Not this person").click();
	await expect(faceRow(page, 103).getByTestId("face-name")).toHaveText(
		"Not assigned",
	);

	expect(calls.assignFace).toEqual([
		{ faceId: 104, name: "Eve" },
		{ faceId: 110, personId: 1 },
		{ faceId: 103, personId: null },
	]);
});

test("a failed face assignment rolls back and shows the error", async ({
	page,
	mockBackend,
}) => {
	const release = gate();
	const calls = await mockBackend({
		assignFace: async () => {
			await release.opened;
			throw new Error("Database is locked");
		},
	});
	await openPhotoPeople(page, 1);
	await assignInput(page, 101).fill("car");
	await assignOption(page, 101, "Carol").click();
	await expect(faceRow(page, 101).getByTestId("face-name")).toHaveText("Carol");

	release.open();
	await expect(faceRow(page, 101).getByTestId("face-name")).toHaveText("Bob");
	await expect(
		page.getByTestId("photo-people").getByRole("alert"),
	).toHaveText("Couldn't update this face: Database is locked");
	expect(calls.assignFace).toEqual([{ faceId: 101, personId: 4 }]);
});

test("videos have no People section", async ({ page, mockBackend }) => {
	await mockBackend({}, [...FIXTURE_PHOTOS, ...FIXTURE_VIDEOS]);
	await page.goto("/");
	await page.locator('[data-testid="photo-grid"] [data-photo-id="34"]').click();
	await expect(page.getByTestId("right-panel")).toContainText("clip.mp4");
	await expect(page.getByTestId("photo-people")).toHaveCount(0);
});

/** The rect the loupe's object-contain image is drawn in (never upscaled). */
async function expectedImageRect(image: Locator, natural: [number, number]) {
	const container = await image.locator("..").boundingBox();
	if (!container) throw new Error("No loupe image container");
	const [nw, nh] = natural;
	const scale = Math.min(container.width / nw, container.height / nh, 1);
	const width = nw * scale;
	const height = nh * scale;
	return {
		x: container.x + (container.width - width) / 2,
		y: container.y + (container.height - height) / 2,
		width,
		height,
	};
}

async function expectFaceRect(
	page: Page,
	faceId: number,
	image: { x: number; y: number; width: number; height: number },
	box: { x: number; y: number; width: number; height: number },
) {
	const actual = await faceBox(page, faceId).boundingBox();
	if (!actual) throw new Error(`No box for face ${faceId}`);
	const expected = {
		x: image.x + box.x * image.width,
		y: image.y + box.y * image.height,
		width: box.width * image.width,
		height: box.height * image.height,
	};
	for (const key of ["x", "y", "width", "height"] as const) {
		expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(1);
	}
}

test("loupe face boxes sit over the letterboxed image for landscape and portrait stills", async ({
	page,
	mockBackend,
}) => {
	await page.setViewportSize({ width: 1400, height: 900 });
	await mockBackend();
	// Large thumbnails: 4000x3000 landscape (1) and 2000x3000 portrait (5).
	const sizes: Record<string, [number, number]> = {
		"1": [4000, 3000],
		"5": [2000, 3000],
	};
	await page.route(/\/api\/photos\/(\d+)\/thumbnail\//, (route) => {
		const id = /\/api\/photos\/(\d+)\//.exec(route.request().url())?.[1] ?? "";
		const [width, height] = sizes[id] ?? [400, 300];
		return route.fulfill({
			status: 200,
			contentType: "image/svg+xml",
			body: svg(width, height),
		});
	});
	await openLibrary(page);

	await page.locator('[data-photo-id="1"]').dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	const toggle = page.getByRole("button", { name: "Face boxes" });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("face-box")).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("face-box")).toHaveCount(2);
	await expect(faceBox(page, 101)).toContainText("Bob");
	await expect(faceBox(page, 102)).toContainText("Alice");
	const landscape = page
		.getByTestId("loupe-view")
		.getByAltText("sunset.jpg", { exact: true });
	const landscapeRect = await expectedImageRect(landscape, sizes["1"]);
	// Letterboxed: the drawn image leaves bars on one axis of its container.
	const container = await landscape.locator("..").boundingBox();
	if (!container) throw new Error("No loupe image container");
	expect(
		Math.min(
			container.width - landscapeRect.width,
			container.height - landscapeRect.height,
		),
	).toBeLessThanOrEqual(1);
	expect(
		Math.max(
			container.width - landscapeRect.width,
			container.height - landscapeRect.height,
		),
	).toBeGreaterThan(2);
	await expectFaceRect(page, 101, landscapeRect, {
		x: 0.1,
		y: 0.2,
		width: 0.2,
		height: 0.3,
	});
	await expectFaceRect(page, 102, landscapeRect, {
		x: 0.6,
		y: 0.25,
		width: 0.15,
		height: 0.2,
	});

	// Clicking a box focuses its metadata row.
	await faceBox(page, 102).click();
	await expect(faceRow(page, 102)).toBeFocused();

	// Boxes follow a resize.
	await page.setViewportSize({ width: 1200, height: 760 });
	await expect
		.poll(async () => {
			const rect = await expectedImageRect(landscape, sizes["1"]);
			const box = await faceBox(page, 101).boundingBox();
			return Math.abs((box?.x ?? 0) - (rect.x + 0.1 * rect.width)) <= 1;
		})
		.toBe(true);

	// Portrait, still shown (the toggle persists across photos).
	await page.keyboard.press("Escape");
	await page.locator('[data-photo-id="5"]').dblclick();
	await expect(page.getByTestId("face-box")).toHaveCount(2);
	const portrait = page
		.getByTestId("loupe-view")
		.getByAltText("street.jpg", { exact: true });
	const portraitRect = await expectedImageRect(portrait, sizes["5"]);
	await expectFaceRect(page, 107, portraitRect, {
		x: 0.1,
		y: 0.1,
		width: 0.25,
		height: 0.15,
	});
	await expectFaceRect(page, 105, portraitRect, {
		x: 0.55,
		y: 0.4,
		width: 0.3,
		height: 0.2,
	});
	await expect(faceBox(page, 107)).toContainText("Unknown");
});

test("F toggles face boxes in the loupe, but not while typing in search", async ({
	page,
}) => {
	await openLibrary(page);
	// Not offered in the grid.
	await page.locator('[data-photo-id="1"]').click();
	await expect(page.getByRole("button", { name: "Face boxes" })).toHaveCount(0);
	await page.keyboard.press("f");

	await page.keyboard.press("e");
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	const toggle = page.getByRole("button", { name: "Face boxes" });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.press("f");
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("face-box")).toHaveCount(2);
	await page.keyboard.press("f");
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("face-box")).toHaveCount(0);

	const search = page.getByPlaceholder("Search photos...");
	await search.click();
	await page.keyboard.type("ff");
	await expect(search).toHaveValue("ff");
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("face-box")).toHaveCount(0);
});
