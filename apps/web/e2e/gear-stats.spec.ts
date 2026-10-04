import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	type FixtureGearStats,
	filterFixturePhotos,
	fixtureGearStats,
	fixtureGridIds,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

function gearToggle(page: Page) {
	return page.getByRole("button", { name: "Gear stats", exact: true });
}

function section(page: Page, testId: string) {
	return page.getByTestId("gear-stats").getByTestId(testId);
}

/** Rendered histogram buckets as "label: N photos", in display order. */
async function bucketLabels(page: Page, testId: string) {
	return section(page, testId)
		.getByTestId("gear-bucket")
		.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
}

/** Rendered camera/lens rows as "label: N photos", in display order. */
async function rowLabels(page: Page, testId: string) {
	return section(page, testId)
		.getByTestId("gear-count-row")
		.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

async function openGear(page: Page) {
	await gearToggle(page).click();
	await expect(gearToggle(page)).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("photo-grid")).toHaveCount(0);
}

/** Stats with only the given fields differing from an otherwise empty set. */
function stats(overrides: Partial<FixtureGearStats>): FixtureGearStats {
	return { ...fixtureGearStats([]), total: 1, withExif: 1, ...overrides };
}

test("Gear shows the grid's photo set: header, lists, and every bucket in order", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openGear(page);

	// 12 stacked photos; cat.jpg has no EXIF.
	await expect(page.getByTestId("gear-stats-summary")).toHaveText(
		"12 photos · 11 with camera data",
	);
	expect(calls.gearStats).toEqual([{}]);
	expect(calls.gearStats?.[0]).toEqual(calls.photos?.at(-1));

	await expect
		.poll(() => rowLabels(page, "gear-cameras"))
		.toEqual(["Sony A7III: 10 photos", "Canon EOS R5: 1 photo"]);
	await expect
		.poll(() => rowLabels(page, "gear-lenses"))
		.toEqual(["FE 24-70mm f/2.8 GM: 11 photos"]);

	// Zero buckets render as empty bars, in the API's fixed order.
	expect(await bucketLabels(page, "gear-focal-lengths")).toEqual([
		"≤15 mm: 0 photos",
		"16–23 mm: 0 photos",
		"24–34 mm: 0 photos",
		"35–49 mm: 11 photos",
		"50–84 mm: 0 photos",
		"85–134 mm: 0 photos",
		"135–299 mm: 0 photos",
		"≥300 mm: 0 photos",
	]);
	expect(await bucketLabels(page, "gear-apertures")).toEqual([
		"≤f/1.9: 0 photos",
		"f/2–2.7: 0 photos",
		"f/2.8–3.9: 0 photos",
		"f/4–5.5: 0 photos",
		"f/5.6–7.9: 0 photos",
		"f/8–10.9: 11 photos",
		"≥f/11: 0 photos",
	]);
	expect(await bucketLabels(page, "gear-shutter-speeds")).toEqual([
		"≤1/2000 s: 0 photos",
		"1/1000–1/500 s: 0 photos",
		"1/250–1/125 s: 11 photos",
		"1/60–1/30 s: 0 photos",
		"1/15–1/2 s: 0 photos",
		">1/2 s: 0 photos",
	]);
	expect(await bucketLabels(page, "gear-isos")).toEqual([
		"≤200: 11 photos",
		"400: 0 photos",
		"800: 0 photos",
		"1600: 0 photos",
		"3200: 0 photos",
		"6400: 0 photos",
		">6400: 0 photos",
	]);
	const emptyBar = section(page, "gear-isos")
		.getByRole("img", { name: "400: 0 photos", exact: true })
		.locator("span > span");
	await expect(emptyBar).toHaveAttribute("style", /height: 0%/);
	const fullBar = section(page, "gear-isos")
		.getByRole("img", { name: "≤200: 11 photos", exact: true })
		.locator("span > span");
	await expect(fullBar).toHaveAttribute("style", /height: 100%/);

	// Toggling again returns to the unchanged grid.
	await gearToggle(page).click();
	await expect(gearToggle(page)).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(() => gridIds(page))
		.toEqual(fixtureGridIds(FIXTURE_LIBRARY));
});

test("cameras and lenses list the top 10, then Show all", async ({
	page,
	mockBackend,
}) => {
	// Count desc, label asc, as the API sorts them.
	const cameras = Array.from({ length: 14 }, (_, index) => ({
		label: `Camera ${String(index + 1).padStart(2, "0")}`,
		count: 20 - index,
	}));
	await mockBackend({
		gearStats: () =>
			stats({ total: 300, withExif: 299, cameras, lenses: cameras }),
	});
	await openLibrary(page);
	await openGear(page);

	await expect(page.getByTestId("gear-stats-summary")).toHaveText(
		"300 photos · 299 with camera data",
	);
	const top10 = cameras
		.slice(0, 10)
		.map(({ label, count }) => `${label}: ${count} photos`);
	await expect.poll(() => rowLabels(page, "gear-cameras")).toEqual(top10);
	const cameraList = section(page, "gear-cameras");
	await cameraList.getByRole("button", { name: "Show all (14)" }).click();
	await expect
		.poll(() => rowLabels(page, "gear-cameras"))
		.toEqual(cameras.map(({ label, count }) => `${label}: ${count} photos`));
	await cameraList.getByRole("button", { name: "Show fewer" }).click();
	await expect.poll(() => rowLabels(page, "gear-cameras")).toEqual(top10);
	// Each list expands on its own.
	expect(await rowLabels(page, "gear-lenses")).toEqual(top10);
});

test("clicking a camera applies the camera filter and returns to the grid", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openGear(page);

	await section(page, "gear-cameras")
		.getByRole("button", { name: "Canon EOS R5: 1 photo" })
		.click();

	const canon = filterFixturePhotos(FIXTURE_PHOTOS, { camera: "Canon EOS R5" });
	await expect(page.getByTestId("gear-stats")).toHaveCount(0);
	await expect.poll(() => gridIds(page)).toEqual(fixtureGridIds(canon));
	expect(calls.photos?.at(-1)).toEqual({ camera: "Canon EOS R5" });
	await expect(gearToggle(page)).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.getByTestId("left-panel").getByText("Filters active"),
	).toBeVisible();

	// Reopening Gear sends the new filter.
	await openGear(page);
	await expect(page.getByTestId("gear-stats-summary")).toHaveText(
		"1 photo · 1 with camera data",
	);
	expect(calls.gearStats?.at(-1)).toEqual({ camera: "Canon EOS R5" });
});

test("clicking a lens applies the lens filter and returns to the grid", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openGear(page);

	await section(page, "gear-lenses")
		.getByRole("button", { name: "FE 24-70mm f/2.8 GM: 11 photos" })
		.click();

	// cat.jpg (no EXIF) drops out.
	const lens = filterFixturePhotos(FIXTURE_PHOTOS, {
		lens: "FE 24-70mm f/2.8 GM",
	});
	await expect(page.getByTestId("gear-stats")).toHaveCount(0);
	await expect.poll(() => gridIds(page)).toEqual(fixtureGridIds(lens));
	expect(calls.photos?.at(-1)).toEqual({ lens: "FE 24-70mm f/2.8 GM" });
	await expect(gearToggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("gearStats receives the grid's folder and filters and follows changes", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await page
		.getByTestId("left-panel")
		.getByText("2024", { exact: true })
		.click();
	await expect
		.poll(() => calls.photos?.at(-1))
		.toEqual({
			folder: "photos/2024",
		});
	await openGear(page);
	await expect
		.poll(() => calls.gearStats?.at(-1))
		.toEqual({ folder: "photos/2024" });

	// Changing a filter while Gear is shown re-requests it with the grid input.
	const leftPanel = page.getByTestId("left-panel");
	await leftPanel.getByText("Filter By").click();
	await leftPanel
		.getByRole("radiogroup", { name: "Minimum rating" })
		.getByRole("radio", { name: "★3+", exact: true })
		.click();
	const threePlus = filterFixturePhotos(FIXTURE_PHOTOS, {
		folder: "photos/2024",
		minRating: 3,
	});
	const expected = fixtureGearStats(threePlus);
	await expect(page.getByTestId("gear-stats-summary")).toHaveText(
		`${expected.total} photos · ${expected.withExif} with camera data`,
	);
	expect(calls.gearStats?.at(-1)).toEqual({
		folder: "photos/2024",
		minRating: 3,
	});
	expect(calls.gearStats?.at(-1)).toEqual(calls.photos?.at(-1));
});

test("shots per year segments the top 5 cameras and groups the rest as Other", async ({
	page,
	mockBackend,
}) => {
	// Totals: A 9, B 8, C 7, D 6, E 5, F 4, G 2; F and G become Other.
	const cameraYears = [
		{ camera: "A", year: 2019, count: 5 },
		{ camera: "F", year: 2019, count: 4 },
		{ camera: "B", year: 2019, count: 3 },
		{ camera: "A", year: 2023, count: 4 },
		{ camera: "C", year: 2023, count: 7 },
		{ camera: "B", year: 2023, count: 5 },
		{ camera: "D", year: 2024, count: 6 },
		{ camera: "E", year: 2024, count: 5 },
		{ camera: "G", year: 2024, count: 2 },
	];
	await mockBackend({
		gearStats: () => stats({ total: 41, withExif: 41, cameraYears }),
	});
	await openLibrary(page);
	await openGear(page);

	const chart = section(page, "gear-shots-per-year");
	await expect(chart.getByTestId("shots-per-year-legend")).toHaveText(
		"ABCDEOther",
	);
	const rows = await chart
		.getByTestId("shots-per-year-row")
		.evaluateAll((els) =>
			els.map((el) => [
				Number(el.getAttribute("data-year")),
				el.querySelector('[data-testid="shots-per-year-total"]')?.textContent,
				[...el.querySelectorAll('[data-testid="shots-per-year-segment"]')].map(
					(s) => s.getAttribute("aria-label"),
				),
			]),
		);
	expect(rows).toEqual([
		[2019, "12 photos", ["A: 5 photos", "B: 3 photos", "Other: 4 photos"]],
		[2023, "16 photos", ["A: 4 photos", "B: 5 photos", "C: 7 photos"]],
		[2024, "13 photos", ["D: 6 photos", "E: 5 photos", "Other: 2 photos"]],
	]);
});

test("empty filters show the empty state; undated cameras show a note", async ({
	page,
	mockBackend,
}) => {
	let response = stats({ total: 0, withExif: 0 });
	await mockBackend({ gearStats: () => response });
	await openLibrary(page);
	await openGear(page);
	await expect(page.getByTestId("gear-stats-empty")).toHaveText(
		"No photos match these filters",
	);

	response = stats({
		total: 3,
		withExif: 1,
		cameras: [{ label: "Sony A7III", count: 1 }],
	});
	await page
		.getByTestId("left-panel")
		.getByText("2024", { exact: true })
		.click();
	await expect(page.getByTestId("gear-stats-summary")).toHaveText(
		"3 photos · 1 with camera data",
	);
	await expect(section(page, "gear-shots-per-year")).toContainText(
		"No dated camera data",
	);
});

test("the Gear toggle is library-grid only and search or Review leave Gear", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openGear(page);

	// Searching replaces Gear with results and hides the toggle.
	const search = page.getByPlaceholder("Search photos...");
	await search.fill("beach");
	await expect(page.getByTestId("search-header")).toBeVisible();
	await expect(gearToggle(page)).toHaveCount(0);
	await expect(page.getByTestId("gear-stats")).toHaveCount(0);

	// Clearing the search returns to the grid, not Gear.
	await search.fill("");
	await expect
		.poll(() => gridIds(page))
		.toEqual(fixtureGridIds(FIXTURE_LIBRARY));
	await expect(gearToggle(page)).toHaveAttribute("aria-pressed", "false");

	// Review hides the toggle too.
	await openGear(page);
	// The cached stats are shown again and refetched once on remount.
	await expect.poll(() => calls.gearStats?.length).toBe(2);
	await page
		.getByTestId("left-panel")
		.getByRole("button", { name: /^Review/ })
		.click();
	await expect(page.getByTestId("review-header")).toBeVisible();
	await expect(gearToggle(page)).toHaveCount(0);
	await expect(page.getByTestId("gear-stats")).toHaveCount(0);
	expect(calls.gearStats).toHaveLength(2);
});
