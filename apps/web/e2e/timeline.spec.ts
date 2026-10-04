import type { Page } from "@playwright/test";
import { countCapturedDays, groupPhotos } from "../src/lib/timeline";
import {
	FIXTURE_LIBRARY,
	fixtureGridIds,
	searchPhotosByQuery,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

// Month titles and the calendar's first weekday (Sunday) are locale data.
test.use({ locale: "en-US" });

/**
 * The library in capture-date order, oldest first: mountain (7, 2019, EXIF
 * colon format), cat (11, no EXIF: its March 2023 file date), flower (10,
 * June 14 2024), the ISO-dated June 15 2024 photos by ID, then street (5,
 * 08:00) and forest (8, 18:30) on June 15 2025.
 */
const CAPTURED_ORDER = [7, 11, 10, 1, 2, 3, 4, 6, 9, 12, 5, 8];
const ADDED_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

/** Section titles and counts, as `title: count`, in display order. */
async function sections(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] section')
		.evaluateAll((els) =>
			els.map(
				(el) =>
					`${el.getAttribute("aria-label")}: ${el.querySelector('[data-testid="timeline-section-count"]')?.textContent}`,
			),
		);
}

function radio(page: Page, group: "Group by" | "Sort by", name: string) {
	return page
		.getByRole("radiogroup", { name: group })
		.getByRole("radio", { name, exact: true });
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

function loupeImage(page: Page) {
	return page.locator('[data-testid="loupe-view"] img').first();
}

function photoSrc(id: number) {
	return new RegExp(`/api/photos/${id}/`);
}

function gridViewport(page: Page) {
	return page.locator(
		'[data-radix-scroll-area-viewport]:has([data-testid="photo-grid"])',
	);
}

/** Distance in px from the grid viewport's top to the element's top. */
async function offsetFromViewportTop(page: Page, selector: string) {
	return gridViewport(page).evaluate((viewport, sel) => {
		const target = viewport.querySelector(sel);
		if (!target) throw new Error(`${sel} not found`);
		return (
			target.getBoundingClientRect().top - viewport.getBoundingClientRect().top
		);
	}, selector);
}

function yearButton(page: Page, year: number) {
	return page
		.getByTestId("timeline-year-rail")
		.getByRole("button", { name: String(year), exact: true });
}

function calendar(page: Page) {
	return page.getByTestId("timeline-calendar");
}

function calendarDay(page: Page, day: string) {
	return calendar(page).locator(`[data-day="${day}"]`);
}

test("the library groups by month in capture order with sticky headers and counts", async ({
	page,
}) => {
	await openLibrary(page);
	await expect(radio(page, "Group by", "Months")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(radio(page, "Sort by", "Captured")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect
		.poll(() => sections(page))
		.toEqual(["June 2019: 1", "March 2023: 1", "June 2024: 8", "June 2025: 2"]);
	expect(await gridIds(page)).toEqual(CAPTURED_ORDER);
	// The fixture helper the other specs use agrees with this order.
	expect(fixtureGridIds(FIXTURE_LIBRARY)).toEqual(CAPTURED_ORDER);
	await expect(page.getByTestId("timeline-section-header").first()).toHaveCSS(
		"position",
		"sticky",
	);
	// Tiles keep their selection behavior inside sections.
	await page.locator('[data-photo-id="10"]').click();
	await expect(page.locator('[data-photo-id="10"]')).toHaveClass(/ring-2/);
});

test("grouping and sort switch the grid and persist across reload", async ({
	page,
}) => {
	await openLibrary(page);

	await radio(page, "Group by", "Years").click();
	await expect
		.poll(() => sections(page))
		.toEqual(["2019: 1", "2023: 1", "2024: 8", "2025: 2"]);
	expect(await gridIds(page)).toEqual(CAPTURED_ORDER);

	// Arrow keys move the choice like a native radio group.
	await radio(page, "Group by", "Years").focus();
	await page.keyboard.press("ArrowRight");
	await expect(radio(page, "Group by", "Months")).toBeFocused();
	await expect(radio(page, "Group by", "Months")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await page.keyboard.press("ArrowRight");
	await expect(radio(page, "Group by", "All")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(page.getByTestId("timeline-section-header")).toHaveCount(0);
	expect(await gridIds(page)).toEqual(CAPTURED_ORDER);

	await radio(page, "Group by", "Years").click();
	await page.reload();
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
	await expect(radio(page, "Group by", "Years")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect
		.poll(() => sections(page))
		.toEqual(["2019: 1", "2023: 1", "2024: 8", "2025: 2"]);

	// Added: photo ID order, one ungrouped grid whatever the grouping.
	await radio(page, "Sort by", "Added").click();
	await expect(page.getByTestId("timeline-section-header")).toHaveCount(0);
	await expect.poll(() => gridIds(page)).toEqual(ADDED_ORDER);
	await expect(page.getByTestId("timeline-year-rail")).toHaveCount(0);

	await page.reload();
	await expect(radio(page, "Sort by", "Added")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect.poll(() => gridIds(page)).toEqual(ADDED_ORDER);
	await expect(radio(page, "Group by", "Years")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	const stored = await page.evaluate(() =>
		JSON.parse(localStorage.getItem("photobrain-library-state") ?? "{}"),
	);
	expect(stored).toMatchObject({ grouping: "years", sort: "added" });
});

test("search results keep relevance order, ungrouped, without timeline controls", async ({
	page,
}) => {
	await openLibrary(page);
	await page.getByPlaceholder("Search photos...").fill("jpg");
	const matches = searchPhotosByQuery("jpg", FIXTURE_LIBRARY);
	await expect(page.getByTestId("search-header")).toContainText(
		`${matches.length} results`,
	);
	expect(await gridIds(page)).toEqual(matches.map((p) => p.id));
	await expect(page.getByTestId("timeline-section-header")).toHaveCount(0);
	await expect(page.getByRole("radiogroup", { name: "Group by" })).toHaveCount(
		0,
	);
	await expect(
		page.getByRole("button", { name: "Calendar", exact: true }),
	).toHaveCount(0);
});

test("loupe arrows and the filmstrip follow the displayed order", async ({
	page,
}) => {
	await openLibrary(page);
	await page.locator('[data-photo-id="7"]').dblclick();
	await expect(loupeImage(page)).toHaveAttribute("src", photoSrc(7));
	await expect
		.poll(() =>
			page
				.locator("[data-filmstrip-photo-id]")
				.evaluateAll((els) =>
					els.map((el) => Number(el.getAttribute("data-filmstrip-photo-id"))),
				),
		)
		.toEqual(CAPTURED_ORDER);

	await page.keyboard.press("ArrowRight");
	await expect(loupeImage(page)).toHaveAttribute("src", photoSrc(11));
	await page.keyboard.press("ArrowRight");
	await expect(loupeImage(page)).toHaveAttribute("src", photoSrc(10));
	await page.keyboard.press("ArrowRight");
	await expect(loupeImage(page)).toHaveAttribute("src", photoSrc(1));
	await page.keyboard.press("ArrowLeft");
	await expect(loupeImage(page)).toHaveAttribute("src", photoSrc(10));

	// Added order: 10 is followed by 11.
	await page.keyboard.press("g");
	await radio(page, "Sort by", "Added").click();
	await page.locator('[data-photo-id="10"]').dblclick();
	await page.keyboard.press("ArrowRight");
	await expect(loupeImage(page)).toHaveAttribute("src", photoSrc(11));
});

test("the year rail jumps to a year and highlights the year at the top", async ({
	page,
}) => {
	// Large tiles make the grid much taller than the viewport.
	await page.addInitScript(() =>
		localStorage.setItem(
			"photobrain-library-state",
			JSON.stringify({ thumbnailSize: 400 }),
		),
	);
	await openLibrary(page);
	const rail = page.getByTestId("timeline-year-rail");
	await expect(rail.getByRole("button")).toHaveText([
		"2019",
		"2023",
		"2024",
		"2025",
	]);
	await expect(yearButton(page, 2019)).toHaveAttribute("aria-current", "true");

	await yearButton(page, 2024).click();
	await expect
		.poll(() => offsetFromViewportTop(page, '[data-section-id="2024-06"]'))
		.toBeCloseTo(0, 0);
	await expect(yearButton(page, 2024)).toHaveAttribute("aria-current", "true");
	await expect(yearButton(page, 2019)).not.toHaveAttribute("aria-current");

	// Scrolling within the year keeps its header pinned and its highlight.
	await gridViewport(page).evaluate((viewport) => {
		viewport.scrollTop += 500;
	});
	await expect
		.poll(() =>
			offsetFromViewportTop(
				page,
				'[data-section-id="2024-06"] [data-testid="timeline-section-header"]',
			),
		)
		.toBeCloseTo(0, 0);
	await expect(yearButton(page, 2024)).toHaveAttribute("aria-current", "true");

	// Plain scrolling back to 2023 moves the highlight.
	await gridViewport(page).evaluate((viewport) => {
		const section = viewport.querySelector('[data-section-id="2023-03"]');
		if (!section) throw new Error("2023 section missing");
		viewport.scrollTop +=
			section.getBoundingClientRect().top -
			viewport.getBoundingClientRect().top +
			10;
	});
	await expect(yearButton(page, 2023)).toHaveAttribute("aria-current", "true");

	await yearButton(page, 2019).click();
	await expect
		.poll(() => gridViewport(page).evaluate((viewport) => viewport.scrollTop))
		.toBeLessThan(10);
	await expect(yearButton(page, 2019)).toHaveAttribute("aria-current", "true");

	// Ungrouped: no rail.
	await radio(page, "Group by", "All").click();
	await expect(rail).toHaveCount(0);
});

test("the calendar counts EXIF capture days, skips empty months, and applies capturedDate", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	const calendarButton = page.getByRole("button", {
		name: "Calendar",
		exact: true,
	});
	await calendarButton.click();
	await expect(calendar(page)).toBeVisible();

	// Opens at the newest month with photos.
	const month = calendar(page).getByTestId("calendar-month");
	await expect(month).toHaveText("June 2025");
	await expect(
		calendar(page).getByRole("button", { name: "Next month" }),
	).toBeDisabled();
	await expect(calendarDay(page, "2025-06-15")).toBeEnabled();
	await expect(
		calendarDay(page, "2025-06-15").getByTestId("calendar-day-count"),
	).toHaveText("2");
	await expect(calendarDay(page, "2025-06-14")).toBeDisabled();
	await expect(calendar(page).getByTestId("calendar-day-count")).toHaveCount(1);

	// Previous skips the empty months back to June 2024 ...
	await calendar(page).getByRole("button", { name: "Previous month" }).click();
	await expect(month).toHaveText("June 2024");
	await expect(
		calendarDay(page, "2024-06-15").getByTestId("calendar-day-count"),
	).toHaveText("7");
	await expect(
		calendarDay(page, "2024-06-14").getByTestId("calendar-day-count"),
	).toHaveText("1");
	await expect(calendarDay(page, "2024-06-13")).toBeDisabled();
	// Sunday-first weeks: June 1, 2024 was a Saturday.
	const cells = calendar(page).locator(".grid-cols-7").nth(1).locator("> *");
	await expect(cells.nth(6)).toHaveAttribute("data-day", "2024-06-01");

	// ... and past March 2023, whose only photo has no EXIF capture date.
	await calendar(page).getByRole("button", { name: "Previous month" }).click();
	await expect(month).toHaveText("June 2019");
	await expect(
		calendar(page).getByRole("button", { name: "Previous month" }),
	).toBeDisabled();
	await calendar(page).getByRole("button", { name: "Next month" }).click();
	await expect(month).toHaveText("June 2024");

	await calendarDay(page, "2024-06-14").click();
	await expect(calendar(page)).toHaveCount(0);
	const chip = page.getByTestId("left-panel").getByTestId("captured-date-chip");
	await expect(chip).toContainText("Jun 14, 2024");
	await expect(page.getByText("1 photos", { exact: true })).toBeVisible();
	await expect.poll(() => gridIds(page)).toEqual([10]);
	expect(calls.photos?.at(-1)).toEqual({ capturedDate: "2024-06-14" });

	// Reopened, it shows the filter's month counted from the filtered list.
	await calendarButton.click();
	await expect(month).toHaveText("June 2024");
	await expect(calendarDay(page, "2024-06-14")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(calendarDay(page, "2024-06-15")).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(calendar(page)).toHaveCount(0);
});

test("groupPhotos orders mixed EXIF formats and fallbacks, with undated photos last", () => {
	const noon = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
	const invalid = new Date(Number.NaN);
	const photo = (
		id: number,
		dateTaken: string | null | undefined,
		fileDate: Date = invalid,
	) => ({
		id,
		createdAt: fileDate,
		modifiedAt: fileDate,
		exif: dateTaken === undefined ? null : { dateTaken },
	});
	const photos = [
		photo(1, null), // no usable date at all
		photo(2, "2023:10:03 23:59:59"), // colon EXIF
		photo(3, "2023-10-03T08:00:00.000Z"), // ISO-like: wall clock, never shifted
		photo(4, undefined, noon("2022-01-20")), // no EXIF: file date
		photo(5, "1899:12:31 10:00:00", noon("2023-11-05")), // invalid EXIF year
		photo(6, "2023:10:03 08:00:00"), // same instant as 3: ID tiebreak
		photo(7, "0000:00:00 00:00:00"), // EXIF placeholder, no file date
	];
	const months = groupPhotos(photos, "months", "captured");
	expect(months.photos.map((p) => p.id)).toEqual([4, 3, 6, 2, 5, 1, 7]);
	expect(
		months.sections?.map((s) => [s.title, s.photos.map((p) => p.id)]),
	).toEqual([
		["January 2022", [4]],
		["October 2023", [3, 6, 2]],
		["November 2023", [5]],
		["Unknown date", [1, 7]],
	]);
	expect(
		groupPhotos(photos, "years", "captured").sections?.map((s) => s.title),
	).toEqual(["2022", "2023", "Unknown date"]);
	expect(groupPhotos(photos, "all", "captured").sections).toBeNull();
	const added = groupPhotos([...photos].reverse(), "months", "added");
	expect(added.photos.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
	expect(added.sections).toBeNull();
	// The calendar counts only valid EXIF capture days.
	expect(Object.fromEntries(countCapturedDays(photos))).toEqual({
		"2023-10-03": 3,
	});
});

test("groupPhotos and countCapturedDays handle 10,000 photos within budget", () => {
	// Deterministic LCG: mixed EXIF formats, missing EXIF, 25 years.
	let seed = 42;
	const random = () => {
		seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
		return seed / 4_294_967_296;
	};
	const pad = (n: number) => String(n).padStart(2, "0");
	const photos = Array.from({ length: 10_000 }, (_, i) => {
		const year = 2000 + Math.floor(random() * 25);
		const month = 1 + Math.floor(random() * 12);
		const day = 1 + Math.floor(random() * 28);
		const hour = Math.floor(random() * 24);
		const kind = random();
		const dateTaken =
			kind < 0.45
				? `${year}:${pad(month)}:${pad(day)} ${pad(hour)}:15:30`
				: kind < 0.9
					? `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:15:30.000Z`
					: null;
		const fileDate = new Date(Date.UTC(year, month - 1, day, hour));
		return {
			// Shuffled IDs, like an API list that is not in capture order.
			id: (i * 7919) % 10_007,
			createdAt: fileDate,
			modifiedAt: fileDate,
			exif: kind < 0.95 ? { dateTaken } : null,
		};
	});
	const time = (grouping: "months" | "years") => {
		const start = performance.now();
		const timeline = groupPhotos(photos, grouping, "captured");
		const counts = countCapturedDays(photos);
		return { ms: performance.now() - start, timeline, counts };
	};
	// Warm up the JIT, then take the median of 11 runs.
	for (let i = 0; i < 3; i++) time("months");
	const runs = Array.from({ length: 11 }, () => time("months"));
	const times = runs.map((run) => run.ms).sort((a, b) => a - b);
	const years = time("years");
	const summary = `groupPhotos(months)+countCapturedDays over 10,000 photos: median ${times[5].toFixed(2)} ms, max ${times[10].toFixed(2)} ms; years ${years.ms.toFixed(2)} ms`;
	test.info().annotations.push({ type: "perf", description: summary });
	console.log(`[timeline perf] ${summary}`);

	const { timeline, counts } = runs[0];
	expect(timeline.photos).toHaveLength(10_000);
	expect(
		(timeline.sections ?? []).reduce((sum, s) => sum + s.photos.length, 0),
	).toBe(10_000);
	expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(
		photos.filter((p) => p.exif?.dateTaken).length,
	);
	expect(times[5]).toBeLessThan(30);
});
