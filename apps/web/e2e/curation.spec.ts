import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
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

function gridBadge(page: Page, id: number) {
	return gridCell(page, id).getByTestId("curation-badge");
}

function star(page: Page, stars: number) {
	return page
		.getByTestId("right-panel")
		.getByRole("radio", {
			name: `Rate ${stars} ${stars === 1 ? "star" : "stars"}`,
		});
}

function flagButton(page: Page, name: "Pick" | "Reject") {
	return page.getByTestId("right-panel").getByRole("button", { name });
}

/** Asserts the metadata panel shows exactly `rating` checked (none for 0). */
async function expectPanelRating(page: Page, rating: number) {
	for (const stars of [1, 2, 3, 4, 5]) {
		await expect(star(page, stars)).toHaveAttribute(
			"aria-checked",
			String(stars === rating),
		);
	}
}

/** A promise the test resolves to release a held mock response. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(page.getByText(`${FIXTURE_LIBRARY.length} photos`)).toBeVisible();
}

test("0-5, P, X and U curate the active photo and update panel and grid immediately", async ({
	page,
	mockBackend,
}) => {
	let release = gate();
	const calls = await mockBackend({
		setPhotoCuration: async (input, defaults) => {
			// Hold each response until the optimistic UI has been asserted.
			await release.opened;
			return defaults.setPhotoCuration(input, defaults);
		},
	});
	await openLibrary(page);
	await gridCell(page, 3).click();
	await expectPanelRating(page, 0);
	await expect(gridBadge(page, 3)).toHaveCount(0);

	const steps: {
		key: string;
		input: object;
		check: () => Promise<void>;
	}[] = [
		{
			key: "4",
			input: { photoIds: [3], rating: 4 },
			check: async () => {
				await expectPanelRating(page, 4);
				await expect(gridBadge(page, 3)).toHaveText("4");
			},
		},
		{
			key: "p",
			input: { photoIds: [3], flag: "pick" },
			check: async () => {
				await expect(flagButton(page, "Pick")).toHaveAttribute(
					"aria-pressed",
					"true",
				);
				await expect(gridBadge(page, 3).getByLabel("Pick")).toBeVisible();
				await expect(gridBadge(page, 3)).toHaveText("4");
			},
		},
		{
			key: "x",
			input: { photoIds: [3], flag: "reject" },
			check: async () => {
				await expect(flagButton(page, "Reject")).toHaveAttribute(
					"aria-pressed",
					"true",
				);
				await expect(flagButton(page, "Pick")).toHaveAttribute(
					"aria-pressed",
					"false",
				);
				await expect(gridBadge(page, 3).getByLabel("Rejected")).toHaveCount(1);
				await expect(gridCell(page, 3)).toHaveAttribute(
					"data-rejected",
					"true",
				);
			},
		},
		{
			key: "u",
			input: { photoIds: [3], flag: null },
			check: async () => {
				await expect(flagButton(page, "Reject")).toHaveAttribute(
					"aria-pressed",
					"false",
				);
				await expect(gridCell(page, 3)).not.toHaveAttribute("data-rejected");
				await expect(gridBadge(page, 3)).toHaveText("4");
			},
		},
		{
			key: "0",
			input: { photoIds: [3], rating: 0 },
			check: async () => {
				await expectPanelRating(page, 0);
				await expect(gridBadge(page, 3)).toHaveCount(0);
			},
		},
		{
			key: "5",
			input: { photoIds: [3], rating: 5 },
			check: async () => {
				await expectPanelRating(page, 5);
				await expect(gridBadge(page, 3)).toHaveText("5");
			},
		},
	];

	for (const [index, step] of steps.entries()) {
		await page.keyboard.press(step.key);
		// The server has not answered yet: the UI must already reflect the change.
		await step.check();
		await expect
			.poll(() => calls.setPhotoCuration?.length ?? 0)
			.toBe(index + 1);
		expect(calls.setPhotoCuration?.at(-1)).toEqual(step.input);
		release.open();
		release = gate();
	}
	release.open();

	// Keys only curate the active photo; others are untouched.
	await expect(gridBadge(page, 2)).toHaveCount(0);
	// Settled state survives the post-mutation refetch.
	await expectPanelRating(page, 5);
	await expect(gridBadge(page, 3)).toHaveText("5");
});

test("curation keys are ignored without an active photo or while typing in search", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await page.keyboard.press("3");
	await page.keyboard.press("p");

	await gridCell(page, 3).click();
	const search = page.getByPlaceholder("Search photos...");
	await search.click();
	await page.keyboard.type("x5pu0");
	await expect(search).toHaveValue("x5pu0");
	await expectPanelRating(page, 0);

	// Prove the shortcut path works once focus leaves the input.
	await search.fill("");
	await search.blur();
	await page.keyboard.press("2");
	await expectPanelRating(page, 2);
	await expect.poll(() => calls.setPhotoCuration?.length ?? 0).toBe(1);
	expect(calls.setPhotoCuration).toEqual([{ photoIds: [3], rating: 2 }]);
});

test("clicking the current star clears the rating; flag buttons toggle", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	// beach.jpg is rated 3 in the fixtures.
	await gridCell(page, 6).click();
	await expectPanelRating(page, 3);
	await expect(gridBadge(page, 6)).toHaveText("3");

	await star(page, 3).click();
	await expectPanelRating(page, 0);
	await expect(gridBadge(page, 6)).toHaveCount(0);

	await star(page, 2).click();
	await expectPanelRating(page, 2);
	await expect(gridBadge(page, 6)).toHaveText("2");

	await flagButton(page, "Pick").click();
	await expect(flagButton(page, "Pick")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await flagButton(page, "Pick").click();
	await expect(flagButton(page, "Pick")).toHaveAttribute(
		"aria-pressed",
		"false",
	);

	await expect.poll(() => calls.setPhotoCuration?.length ?? 0).toBe(4);
	expect(calls.setPhotoCuration).toEqual([
		{ photoIds: [6], rating: 0 },
		{ photoIds: [6], rating: 2 },
		{ photoIds: [6], flag: "pick" },
		{ photoIds: [6], flag: null },
	]);
});

test("rejecting dims the grid cell and the filmstrip thumbnail", async ({
	page,
}) => {
	await openLibrary(page);
	await expect(gridCell(page, 5)).toHaveCSS("opacity", "1");
	await gridCell(page, 5).click();
	await flagButton(page, "Reject").click();
	await expect(gridCell(page, 5)).toHaveAttribute("data-rejected", "true");
	await expect(gridCell(page, 5)).toHaveCSS("opacity", "0.4");
	// macro.cr2 is rejected in the fixtures and stays dimmed.
	await expect(gridCell(page, 4)).toHaveCSS("opacity", "0.4");
	await expect(gridCell(page, 3)).toHaveCSS("opacity", "1");

	await page.keyboard.press("e");
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	const filmstrip = (id: number) =>
		page.locator(`[data-filmstrip-photo-id="${id}"]`);
	await expect(filmstrip(5)).toHaveAttribute("data-rejected", "true");
	await expect(filmstrip(4)).toHaveCSS("opacity", "0.3");
	await expect(filmstrip(3)).not.toHaveAttribute("data-rejected");
});

test("a failed curation rolls the panel and grid back", async ({
	page,
	mockBackend,
}) => {
	let release = gate();
	const calls = await mockBackend({
		setPhotoCuration: async () => {
			await release.opened;
			throw new Error("Database is locked");
		},
	});
	await openLibrary(page);
	// sunset.jpg starts rated 5 and picked.
	await gridCell(page, 1).click();
	await expectPanelRating(page, 5);
	await expect(gridBadge(page, 1)).toHaveText("5");

	await page.keyboard.press("2");
	await expectPanelRating(page, 2);
	await expect(gridBadge(page, 1)).toHaveText("2");
	release.open();
	await expectPanelRating(page, 5);
	await expect(gridBadge(page, 1)).toHaveText("5");

	release = gate();
	await page.keyboard.press("x");
	await expect(gridCell(page, 1)).toHaveAttribute("data-rejected", "true");
	await expect(flagButton(page, "Reject")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	release.open();
	await expect(gridCell(page, 1)).not.toHaveAttribute("data-rejected");
	await expect(flagButton(page, "Pick")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(gridBadge(page, 1).getByLabel("Pick")).toBeVisible();
	await expectPanelRating(page, 5);

	expect(calls.setPhotoCuration).toEqual([
		{ photoIds: [1], rating: 2 },
		{ photoIds: [1], flag: "reject" },
	]);
});

test("Rating and Flag filters scope the library and search and clear with Clear all", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	const leftPanel = page.getByTestId("left-panel");
	await leftPanel.getByText("Filter By").click();
	const ratingRadio = (name: string) =>
		leftPanel
			.getByRole("radiogroup", { name: "Minimum rating" })
			.getByRole("radio", { name, exact: true });
	const flagRadio = (name: string) =>
		leftPanel
			.getByRole("radiogroup", { name: "Flag" })
			.getByRole("radio", { name, exact: true });
	await expect(ratingRadio("Any")).toHaveAttribute("aria-checked", "true");
	await expect(flagRadio("Any")).toHaveAttribute("aria-checked", "true");

	const threePlus = filterFixturePhotos(FIXTURE_PHOTOS, { minRating: 3 });
	await ratingRadio("★3+").click();
	await expect(page.getByText(`${threePlus.length} photos`)).toBeVisible();
	expect(await gridIds(page)).toEqual(threePlus.map((p) => p.id));
	expect(calls.photos?.at(-1)).toEqual({ minRating: 3 });
	await expect(leftPanel.getByText("Filters active")).toBeVisible();

	const picks = filterFixturePhotos(FIXTURE_PHOTOS, {
		minRating: 3,
		flag: "pick",
	});
	await flagRadio("Picks").click();
	await expect(page.getByText(`${picks.length} photos`)).toBeVisible();
	expect(await gridIds(page)).toEqual(picks.map((p) => p.id));
	expect(calls.photos?.at(-1)).toEqual({ minRating: 3, flag: "pick" });

	await page.getByPlaceholder("Search photos...").fill("jpg");
	const searchMatches = searchPhotosByQuery("jpg", picks);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${searchMatches.length} results for “jpg” · ★3+ · Picks`,
	);
	expect(await gridIds(page)).toEqual(searchMatches.map((p) => p.id));
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		minRating: 3,
		flag: "pick",
	});

	await ratingRadio("★5").click();
	await flagRadio("Unflagged").click();
	await expect(page.getByTestId("search-header")).toHaveText(
		"0 results for “jpg” · ★5 · Unflagged",
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		minRating: 5,
		flag: "unflagged",
	});

	await flagRadio("Rejected").click();
	await ratingRadio("Any").click();
	const rejected = searchPhotosByQuery(
		"jpg",
		filterFixturePhotos(FIXTURE_PHOTOS, { flag: "reject" }),
	);
	await expect(page.getByTestId("search-header")).toHaveText(
		`${rejected.length} results for “jpg” · Rejected`,
	);

	await leftPanel.getByRole("button", { name: "Clear all" }).click();
	await expect(leftPanel.getByText("Filters active")).toHaveCount(0);
	await expect(ratingRadio("Any")).toHaveAttribute("aria-checked", "true");
	await expect(flagRadio("Any")).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("search-header")).toHaveText(
		`${searchPhotosByQuery("jpg").length} results for “jpg”`,
	);
	const lastSearch = calls.searchPhotos?.at(-1) as FixturePhotoFilters;
	expect(lastSearch.minRating).toBeUndefined();
	expect(lastSearch.flag).toBeUndefined();

	// The unfiltered library may render from cache, so assert what is shown.
	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(page.getByText(`${FIXTURE_LIBRARY.length} photos`)).toBeVisible();
	await expect
		.poll(() => gridIds(page))
		.toEqual(FIXTURE_LIBRARY.map((p) => p.id));
});
