import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	filterFixturePhotos,
	fixtureOnThisDay,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

// 23:30 on June 15 in Denver is already June 16 in UTC: requests must carry
// the browser's local calendar date.
test.use({ timezoneId: "America/Denver" });
const PINNED_NOW = new Date("2026-06-16T05:30:00Z");
const LOCAL_TODAY = "2026-06-15";
// No fixture photo was captured on an October 3.
const EMPTY_DAY_NOW = new Date("2026-10-03T18:00:00Z");

const EXPECTED = fixtureOnThisDay(FIXTURE_PHOTOS, LOCAL_TODAY).years;

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

function strip(page: Page) {
	return page.getByTestId("on-this-day");
}

function card(page: Page, capturedDate: string) {
	return strip(page).locator(`[data-captured-date="${capturedDate}"]`);
}

async function openLibrary(page: Page, now = PINNED_NOW) {
	await page.clock.setFixedTime(now);
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

async function expectCapturedDateGrid(page: Page, capturedDate: string) {
	const ids = filterFixturePhotos(FIXTURE_PHOTOS, { capturedDate }).map(
		(p) => p.id,
	);
	await expect(
		page.getByText(`${ids.length} photos`, { exact: true }).first(),
	).toBeVisible();
	await expect.poll(() => gridIds(page)).toEqual(ids);
}

test("fixture years cover the scenarios the strip must render", () => {
	// 1 year ago (stacked pair + another photo, rated cover with a cache
	// token), 2 years ago (the default fixture date), and 7 years ago.
	expect(EXPECTED.map((y) => [y.yearsAgo, y.capturedDate, y.count])).toEqual([
		[1, "2025-06-15", 2],
		[2, "2024-06-15", 6],
		[7, "2019-06-15", 1],
	]);
	expect(EXPECTED[0].cover.photoId).toBe(8);
});

test("cards render newest first with years ago, date, count, and cover", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);

	await expect(strip(page)).toBeVisible();
	await expect(strip(page).getByRole("heading")).toHaveText("On this day");
	const cards = strip(page).getByTestId("on-this-day-card");
	await expect(cards).toHaveCount(EXPECTED.length);
	await expect(cards.getByTestId("on-this-day-years-ago")).toHaveText([
		"1 year ago",
		"2 years ago",
		"7 years ago",
	]);
	await expect(cards.getByTestId("on-this-day-date")).toHaveText([
		"Jun 15, 2025",
		"Jun 15, 2024",
		"Jun 15, 2019",
	]);
	await expect(cards.getByTestId("on-this-day-count")).toHaveText([
		"2 photos",
		"6 photos",
		"1 photo",
	]);

	// Covers use the thumbnail helper, with the cache token when present.
	const coverToken = new Date("2025-06-16T08:00:00.000Z").getTime();
	await expect(card(page, "2025-06-15").locator("img")).toHaveAttribute(
		"src",
		new RegExp(`/api/photos/8/thumbnail/small\\?v=${coverToken}$`),
	);
	await expect(card(page, "2019-06-15").locator("img")).toHaveAttribute(
		"src",
		/\/api\/photos\/7\/thumbnail\/small$/,
	);

	// The request date is the local date, not the UTC one.
	expect(calls.onThisDay).toEqual([{ date: LOCAL_TODAY }]);
});

test("the strip is hidden when no earlier year has photos on this day", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page, EMPTY_DAY_NOW);
	await expect.poll(() => calls.onThisDay).toEqual([{ date: "2026-10-03" }]);
	await expect(strip(page)).toHaveCount(0);
	await expect
		.poll(() => gridIds(page))
		.toEqual(FIXTURE_LIBRARY.map((p) => p.id));
});

test("a new local day is requested when the window regains focus", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await expect(strip(page).getByTestId("on-this-day-card")).toHaveCount(3);

	await page.clock.setFixedTime(EMPTY_DAY_NOW);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect
		.poll(() => calls.onThisDay)
		.toEqual([{ date: LOCAL_TODAY }, { date: "2026-10-03" }]);
	await expect(strip(page)).toHaveCount(0);
});

test("the strip is hidden while a filter, search, or scope is active", async ({
	page,
}) => {
	await openLibrary(page);
	await expect(strip(page)).toBeVisible();

	// Library filter.
	await leftPanel(page).getByText("Filter By").click();
	const typeControl = leftPanel(page).getByRole("radiogroup", {
		name: "Photo type",
	});
	await typeControl.getByRole("radio", { name: "RAW" }).click();
	await expect(strip(page)).toHaveCount(0);
	await leftPanel(page).getByRole("button", { name: "Clear all" }).click();
	await expect(strip(page)).toBeVisible();

	// Search.
	const search = page.getByPlaceholder("Search photos...");
	await search.fill("beach");
	await expect(page.getByTestId("search-header")).toBeVisible();
	await expect(strip(page)).toHaveCount(0);
	await search.fill("");
	await expect(strip(page)).toBeVisible();

	// Folder scope.
	await leftPanel(page).getByText("2024", { exact: true }).click();
	await expect(leftPanel(page).getByText("Showing: photos/2024")).toBeVisible();
	await expect(strip(page)).toHaveCount(0);
	await leftPanel(page).getByText("All Photos").click();
	await expect(strip(page)).toBeVisible();

	// Find similar.
	await page.locator('[data-photo-id="1"]').click();
	await page.keyboard.press("s");
	await expect(page.getByTestId("similar-chip")).toBeVisible();
	await expect(strip(page)).toHaveCount(0);
	await page.getByRole("button", { name: "Exit similar photos" }).click();
	await expect(strip(page)).toBeVisible();
});

test("a card filters to its capture date; the chip and Clear all restore the strip", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);

	await card(page, "2025-06-15").click();
	await expectCapturedDateGrid(page, "2025-06-15");
	expect(calls.photos?.at(-1)).toEqual({ capturedDate: "2025-06-15" });
	const chip = leftPanel(page).getByTestId("captured-date-chip");
	await expect(chip).toHaveText("Jun 15, 2025");
	await expect(leftPanel(page).getByText("Filters active")).toBeVisible();
	await expect(strip(page)).toHaveCount(0);

	// Removing the chip returns to the whole library and its strip.
	await chip.getByRole("button", { name: "Clear capture date" }).click();
	await expect(chip).toHaveCount(0);
	await expect(strip(page)).toBeVisible();
	await expect
		.poll(() => gridIds(page))
		.toEqual(FIXTURE_LIBRARY.map((p) => p.id));

	// Clear all clears it too.
	await card(page, "2019-06-15").click();
	await expectCapturedDateGrid(page, "2019-06-15");
	await leftPanel(page).getByRole("button", { name: "Clear all" }).click();
	await expect(leftPanel(page).getByTestId("captured-date-chip")).toHaveCount(
		0,
	);
	await expect(strip(page)).toBeVisible();
	await expect
		.poll(() => gridIds(page))
		.toEqual(FIXTURE_LIBRARY.map((p) => p.id));
});

test("capturedDate scopes search and the map", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await card(page, "2024-06-15").click();
	await expectCapturedDateGrid(page, "2024-06-15");

	await page.getByPlaceholder("Search photos...").fill("jpg");
	await expect(page.getByTestId("search-header")).toContainText(
		"· Jun 15, 2024",
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		capturedDate: "2024-06-15",
	});
	await page.getByRole("button", { name: "Clear search" }).click();

	await page.keyboard.press("m");
	await expect
		.poll(() => calls.photoLocations?.at(-1))
		.toEqual({ capturedDate: "2024-06-15" });
});

test("Save as Smart Album never saves the capture date", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await card(page, "2025-06-15").click();
	await expectCapturedDateGrid(page, "2025-06-15");
	const save = leftPanel(page).getByRole("button", {
		name: "Save as Smart Album…",
	});
	// A capture date alone is not savable.
	await expect(save).toHaveCount(0);

	await leftPanel(page).getByText("Filter By").click();
	await leftPanel(page)
		.getByRole("radiogroup", { name: "Photo type" })
		.getByRole("radio", { name: "Standard" })
		.click();
	await save.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await expect(dialog).toContainText("Standard only");
	await expect(dialog).not.toContainText("Jun 15, 2025");
	await dialog.getByLabel("Smart album name").fill("Standard");
	await dialog.getByRole("button", { name: "Save smart album" }).click();

	await expect(dialog).toHaveCount(0);
	expect(calls.createSmartAlbum).toEqual([
		{ name: "Standard", filters: { filterRaw: "standard" } },
	]);
	// The view still narrows the album by date, so the album is not selected.
	await expect(page.getByTestId("smart-album-header")).toHaveCount(0);
	await expect(leftPanel(page).getByTestId("captured-date-chip")).toBeVisible();
});
