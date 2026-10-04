import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	type FixtureEventDto,
	filterFixturePhotos,
	fixtureEvents,
	fixtureGridIds,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

// UTC+14: a wall-clock timestamp read as UTC (or converted to local time)
// would land on another calendar day, so the expected text proves none is.
test.use({ timezoneId: "Pacific/Kiritimati" });

const EVENTS = fixtureEvents(FIXTURE_PHOTOS).events;

/** The default handlers list no events (the library is below the minimum). */
const FIXTURE_EVENT_HANDLERS = {
	events: (input: unknown) =>
		fixtureEvents(
			FIXTURE_PHOTOS,
			(input as { folder?: string } | undefined)?.folder,
		),
};

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

function eventList(page: Page) {
	return leftPanel(page).getByTestId("event-list");
}

function eventRow(page: Page, id: number) {
	return eventList(page).locator(`[data-event-id="${id}"]`);
}

/** Rendered event rows as [id, title, subtitle], in display order. */
async function eventRows(page: Page) {
	return eventList(page)
		.getByTestId("event-row")
		.evaluateAll((rows) =>
			rows.map((row) => [
				Number(row.getAttribute("data-event-id")),
				row.querySelector('[data-testid="event-title"]')?.textContent,
				row.querySelector('[data-testid="event-subtitle"]')?.textContent,
			]),
		);
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

async function expectEventGrid(page: Page, event: number) {
	const ids = fixtureGridIds(filterFixturePhotos(FIXTURE_PHOTOS, { event }));
	await expect(page.getByTestId("photo-grid")).toBeVisible();
	await expect.poll(() => gridIds(page)).toEqual(ids);
}

/** `count` place-less same-day events, newest (highest id) first. */
function manyEvents(count: number): FixtureEventDto[] {
	return Array.from({ length: count }, (_, index) => {
		const id = count - index;
		const day = String(id).padStart(2, "0");
		return {
			id,
			startAt: `2024-03-${day}T10:00:00`,
			endAt: `2024-03-${day}T18:00:00`,
			// Never "12 photos", the library toolbar count openLibrary waits for.
			photoCount: 100 + id,
			cover: { photoId: 1, thumbnailUpdatedAt: null },
			place: null,
		};
	});
}

test("events render newest first with title and subtitle variants", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(FIXTURE_EVENT_HANDLERS);
	await openLibrary(page);

	await expect
		.poll(() => eventRows(page))
		.toEqual([
			// No place, same day: the date range is the title.
			[2, "Jun 15, 2025", "2 photos"],
			// City place.
			[1, "San Francisco, United States", "Jun 15, 2024 · 2 photos"],
			// Country-only place, same month.
			[6, "United States", "Jun 14 – 16, 2024 · 2 photos"],
			// No place, across months; 23:59:59 stays on its wall-clock day.
			[10, "May 30 – Jun 14, 2024", "2 photos"],
			// No place, across years; one photo.
			[9, "Dec 30, 2023 – Jan 2, 2024", "1 photo"],
			// A city named like its country shows once; same year across months.
			[7, "Singapore", "Sep 30 – Oct 2, 2019 · 1 photo"],
		]);
	expect(calls.events).toEqual([{}]);

	// Covers use the tiny thumbnail with the cover's cache token.
	const coverOf = (id: number) => eventRow(page, id).locator("img");
	await expect(coverOf(6)).toHaveAttribute(
		"src",
		new RegExp(
			`/api/photos/8/thumbnail/tiny\\?v=${Date.parse("2025-06-16T08:00:00.000Z")}$`,
		),
	);
	await expect(coverOf(1)).toHaveAttribute(
		"src",
		/\/api\/photos\/1\/thumbnail\/tiny$/,
	);

	// The section collapses like the others.
	const header = leftPanel(page).getByRole("button", {
		name: "Events",
		exact: true,
	});
	await header.click();
	await expect(eventList(page)).toHaveCount(0);
	await header.click();
	await expect(eventList(page)).toBeVisible();
});

test("the first 12 events show until Show all; a selection stays listed", async ({
	page,
	mockBackend,
}) => {
	const events = manyEvents(15);
	await mockBackend({ events: () => ({ events }) });
	await openLibrary(page);

	const rows = eventList(page).getByTestId("event-row");
	await expect(rows).toHaveCount(12);
	await expect
		.poll(async () => (await eventRows(page)).map(([id]) => id))
		.toEqual(events.slice(0, 12).map((e) => e.id));
	await expect(eventRow(page, 15).getByTestId("event-subtitle")).toHaveText(
		"115 photos",
	);

	await eventList(page).getByRole("button", { name: "Show all (15)" }).click();
	await expect(rows).toHaveCount(15);

	// Selecting a collapsed-away event keeps it listed after "Show fewer".
	await eventRow(page, 1).click();
	await expect(eventRow(page, 1)).toHaveAttribute("aria-pressed", "true");
	await eventList(page).getByRole("button", { name: "Show fewer" }).click();
	await expect
		.poll(async () => (await eventRows(page)).map(([id]) => id))
		.toEqual([...events.slice(0, 12).map((e) => e.id), 1]);
	await expect(rows).toHaveCount(13);
});

test("an event filters the grid with a chip; clicking again or clearing returns to the library", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(FIXTURE_EVENT_HANDLERS);
	await openLibrary(page);

	// Country-only event 6 holds beach and the forest pair (stacked).
	await eventRow(page, 6).click();
	await expectEventGrid(page, 6);
	expect(calls.photos?.at(-1)).toEqual({ event: 6 });
	await expect(eventRow(page, 6)).toHaveAttribute("aria-pressed", "true");
	const chip = leftPanel(page).getByTestId("event-chip");
	await expect(chip).toHaveText("United States");
	await expect(leftPanel(page).getByText("Filters active")).toBeVisible();

	// Clicking the selected event clears it.
	await eventRow(page, 6).click();
	await expect(chip).toHaveCount(0);
	await expect(eventRow(page, 6)).toHaveAttribute("aria-pressed", "false");
	await expect
		.poll(() => gridIds(page))
		.toEqual(fixtureGridIds(FIXTURE_LIBRARY));

	// The chip shows the date-range title of a place-less event and clears it.
	await eventRow(page, 9).click();
	await expectEventGrid(page, 9);
	expect(calls.photos?.at(-1)).toEqual({ event: 9 });
	await expect(chip).toHaveText("Dec 30, 2023 – Jan 2, 2024");
	await chip.getByRole("button", { name: "Clear event" }).click();
	await expect(chip).toHaveCount(0);
	await expect
		.poll(() => gridIds(page))
		.toEqual(fixtureGridIds(FIXTURE_LIBRARY));

	// Clear all clears it too.
	await eventRow(page, 1).click();
	await expectEventGrid(page, 1);
	await expect(chip).toHaveText("San Francisco, United States");
	await leftPanel(page).getByRole("button", { name: "Clear all" }).click();
	await expect(chip).toHaveCount(0);
	await expect
		.poll(() => gridIds(page))
		.toEqual(fixtureGridIds(FIXTURE_LIBRARY));
});

test("the event filter scopes search, the map, and Find similar", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(FIXTURE_EVENT_HANDLERS);
	await openLibrary(page);
	await eventRow(page, 1).click();
	await expectEventGrid(page, 1);

	await page.getByPlaceholder("Search photos...").fill("jpg");
	await expect(page.getByTestId("search-header")).toContainText(
		"· San Francisco, United States",
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		event: 1,
	});
	await page.getByRole("button", { name: "Clear search" }).click();

	await page.locator('[data-photo-id="1"]').click();
	await page.keyboard.press("s");
	await expect(page.getByTestId("similar-chip")).toBeVisible();
	await expect
		.poll(() => calls.similarPhotos?.at(-1))
		.toEqual({ photoId: 1, limit: 60, event: 1 });
	await expect.poll(() => gridIds(page)).toEqual([3]);
	await page.getByRole("button", { name: "Exit similar photos" }).click();

	await page.keyboard.press("m");
	await expect.poll(() => calls.photoLocations?.at(-1)).toEqual({ event: 1 });
});

test("Save as Smart Album never saves the event", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend(FIXTURE_EVENT_HANDLERS);
	await openLibrary(page);
	await eventRow(page, 6).click();
	await expectEventGrid(page, 6);
	const save = leftPanel(page).getByRole("button", {
		name: "Save as Smart Album…",
	});
	// An event alone is not savable.
	await expect(save).toHaveCount(0);

	await leftPanel(page).getByText("Filter By").click();
	await leftPanel(page)
		.getByRole("radiogroup", { name: "Photo type" })
		.getByRole("radio", { name: "Standard" })
		.click();
	await save.click();
	const dialog = page.getByRole("dialog", { name: "Save as Smart Album" });
	await expect(dialog).toContainText("Standard only");
	await expect(dialog).not.toContainText("United States");
	await dialog.getByLabel("Smart album name").fill("Standard");
	await dialog.getByRole("button", { name: "Save smart album" }).click();

	await expect(dialog).toHaveCount(0);
	expect(calls.createSmartAlbum).toEqual([
		{ name: "Standard", filters: { filterRaw: "standard" } },
	]);
	// The event still narrows the album, so the album is not selected.
	await expect(page.getByTestId("smart-album-header")).toHaveCount(0);
	await expect(leftPanel(page).getByTestId("event-chip")).toBeVisible();
});

test("events are requested for the selected folder", async ({
	page,
	mockBackend,
}) => {
	// Only San Francisco (1) has members in the folder in this scenario.
	const calls = await mockBackend({
		events: (input) =>
			(input as { folder?: string } | undefined)?.folder === undefined
				? { events: EVENTS }
				: { events: EVENTS.filter((e) => e.id === 1) },
	});
	await openLibrary(page);
	await expect(eventList(page).getByTestId("event-row")).toHaveCount(
		EVENTS.length,
	);

	await leftPanel(page).getByText("2024", { exact: true }).click();
	await expect(leftPanel(page).getByText("Showing: photos/2024")).toBeVisible();
	await expect
		.poll(() => calls.events?.at(-1))
		.toEqual({
			folder: "photos/2024",
		});
	await expect
		.poll(async () => (await eventRows(page)).map(([id]) => id))
		.toEqual([1]);

	// Back to All Photos lists every event again.
	await leftPanel(page).getByText("All Photos").click();
	await expect(eventList(page).getByTestId("event-row")).toHaveCount(
		EVENTS.length,
	);
});

test("no events shows an empty state", async ({ page, mockBackend }) => {
	await mockBackend({ events: () => ({ events: [] }) });
	await openLibrary(page);
	await expect(leftPanel(page).getByText("No events yet")).toBeVisible();
	await expect(eventList(page)).toHaveCount(0);
});
