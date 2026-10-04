import type { Page } from "@playwright/test";
import {
	FIXTURE_JUNK_REASONS,
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	filterFixturePhotos,
	fixtureGridIds,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

/** Review candidates newest-first: reasons, not picked/rejected, unrated. */
const CANDIDATE_IDS = [12, 11, 10, 9, 7, 3];
const EMPTY_COUNTS = { all: 0, screenshot: 0, document: 0, blurry: 0, dark: 0 };

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

function reviewItem(page: Page) {
	return leftPanel(page).getByRole("button", { name: /^Review/ });
}

function reasonRadio(page: Page, label: string) {
	return page
		.getByRole("radiogroup", { name: "Review reason" })
		.getByRole("radio", { name: new RegExp(`^${label}`) });
}

/** Asserts the reason control's counts, keyed by label. */
async function expectReasonCounts(page: Page, counts: Record<string, number>) {
	for (const [label, count] of Object.entries(counts)) {
		await expect(
			reasonRadio(page, label).getByTestId("reason-count"),
		).toHaveText(String(count));
	}
}

function headerButton(page: Page, name: RegExp) {
	return page.getByTestId("review-header").getByRole("button", { name });
}

/** A promise the test resolves to release a held mock response. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

async function openReview(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`),
	).toBeVisible();
	await expect(reviewItem(page)).toContainText(String(CANDIDATE_IDS.length));
	await reviewItem(page).click();
	await expect.poll(() => gridIds(page)).toEqual(CANDIDATE_IDS);
}

test("Review shows candidates with reason badges and per-reason counts", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openReview(page);

	await expect(reviewItem(page)).toHaveAttribute("aria-pressed", "true");
	await expect(reasonRadio(page, "All")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expectReasonCounts(page, {
		All: 6,
		Screenshots: 1,
		Documents: 1,
		Blurry: 4,
		"Too dark": 2,
	});
	const labels = {
		screenshot: "Screenshots",
		document: "Documents",
		blurry: "Blurry",
		dark: "Too dark",
	} as const;
	for (const id of CANDIDATE_IDS) {
		const first = FIXTURE_JUNK_REASONS[id][0];
		await expect(gridCell(page, id).getByTestId("photo-badge")).toHaveText(
			labels[first],
		);
	}
	// Library filters are hidden while reviewing.
	await expect(leftPanel(page).getByText("Filter By")).toHaveCount(0);
	await expect(headerButton(page, /^Reject all/)).toHaveText("Reject all (6)");
	await expect(headerButton(page, /^Keep all/)).toHaveText("Keep all (6)");
	// The badge count is a one-photo request; the list loads one page.
	expect(calls.junkReview).toContainEqual({ limit: 1 });
	expect(calls.junkReview?.at(-1)).toEqual({ limit: 200 });

	// Selecting a candidate explains why it is here.
	await gridCell(page, 7).click();
	await expect(
		page.getByRole("list", { name: "Review reasons" }).getByRole("listitem"),
	).toHaveText(["Blurry", "Too dark"]);
});

test("the reason filter requests that reason and narrows the grid", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openReview(page);

	await reasonRadio(page, "Blurry").click();
	await expect(reasonRadio(page, "Blurry")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect.poll(() => gridIds(page)).toEqual([12, 10, 7, 3]);
	expect(calls.junkReview?.at(-1)).toEqual({ reason: "blurry", limit: 200 });
	// Counts stay library-wide regardless of the selected reason.
	await expectReasonCounts(page, { All: 6, Blurry: 4, "Too dark": 2 });
	await expect(headerButton(page, /^Reject all/)).toHaveText("Reject all (4)");

	await reasonRadio(page, "Too dark").click();
	await expect.poll(() => gridIds(page)).toEqual([9, 7]);
	expect(calls.junkReview?.at(-1)).toEqual({ reason: "dark", limit: 200 });
	// Badges keep showing each photo's first reason.
	await expect(gridCell(page, 7).getByTestId("photo-badge")).toHaveText(
		"Blurry",
	);

	await reasonRadio(page, "All").click();
	await expect.poll(() => gridIds(page)).toEqual(CANDIDATE_IDS);
});

test("Reject all rejects exactly the shown photos and empties the list", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openReview(page);
	await reasonRadio(page, "Blurry").click();
	await expect.poll(() => gridIds(page)).toEqual([12, 10, 7, 3]);

	await headerButton(page, /^Reject all/).click();
	await expect(page.getByText("Nothing to review")).toBeVisible();
	await expect
		.poll(() => calls.resolveJunk)
		.toEqual([{ photoIds: [12, 10, 7, 3], action: "reject" }]);
	// Every reason a rejected photo carried leaves the counts.
	await expectReasonCounts(page, {
		All: 2,
		Screenshots: 1,
		Documents: 0,
		Blurry: 0,
		"Too dark": 1,
	});
	await expect(reviewItem(page)).toContainText("2");
	await expect(headerButton(page, /^Reject all/)).toBeDisabled();

	await reasonRadio(page, "All").click();
	await expect.poll(() => gridIds(page)).toEqual([11, 9]);

	// Rejected photos show as rejected back in the library.
	await headerButton(page, /^Exit review/).click();
	await expect(gridCell(page, 12)).toHaveAttribute("data-rejected", "true");
	await expect(gridCell(page, 3)).toHaveAttribute("data-rejected", "true");
	await expect(gridCell(page, 11)).not.toHaveAttribute("data-rejected");
});

test("Keep all sends keep for the shown photos and they stay out of Review", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openReview(page);

	await headerButton(page, /^Keep all/).click();
	await expect(page.getByText("Nothing to review")).toBeVisible();
	await expect
		.poll(() => calls.resolveJunk)
		.toEqual([{ photoIds: CANDIDATE_IDS, action: "keep" }]);
	await expect(reviewItem(page)).toContainText("0");
	// The refetch after settling agrees: kept photos are dismissed for good.
	await expect.poll(() => calls.junkReview?.length ?? 0).toBeGreaterThan(2);
	await expect(page.getByText("Nothing to review")).toBeVisible();

	// Keeping does not flag anything in the library.
	await headerButton(page, /^Exit review/).click();
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`),
	).toBeVisible();
	await expect(gridCell(page, 12)).not.toHaveAttribute("data-rejected");
});

test("X rejects and K keeps the active photo, then advance to the next candidate", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openReview(page);
	const rightPanel = page.getByTestId("right-panel");

	await gridCell(page, 12).click();
	await expect(rightPanel.getByText("dog.jpg")).toBeVisible();
	await page.keyboard.press("x");
	await expect.poll(() => gridIds(page)).toEqual([11, 10, 9, 7, 3]);
	await expect(rightPanel.getByText("cat.jpg")).toBeVisible();
	await expectReasonCounts(page, { All: 5, Documents: 0, Blurry: 3 });

	await page.keyboard.press("k");
	await expect.poll(() => gridIds(page)).toEqual([10, 9, 7, 3]);
	await expect(rightPanel.getByText("flower.jpg")).toBeVisible();
	await expectReasonCounts(page, { All: 4, Screenshots: 0 });

	// The panel's Keep button resolves and advances the same way.
	await page
		.getByTestId("review-reasons")
		.getByRole("button", { name: "Keep" })
		.click();
	await expect.poll(() => gridIds(page)).toEqual([9, 7, 3]);
	await expect(rightPanel.getByText("city.jpg")).toBeVisible();

	// Removal is optimistic, so the last request may still be in flight.
	await expect
		.poll(() => calls.resolveJunk)
		.toEqual([
			{ photoIds: [12], action: "reject" },
			{ photoIds: [11], action: "keep" },
			{ photoIds: [10], action: "keep" },
		]);
	// X in Review resolves rather than plain-flagging through curation.
	expect(calls.setPhotoCuration).toBeUndefined();
});

test("a failed resolution restores the photo and counts and shows the error", async ({
	page,
	mockBackend,
}) => {
	const release = gate();
	const calls = await mockBackend({
		resolveJunk: async () => {
			await release.opened;
			throw new Error("Database is locked");
		},
	});
	await openReview(page);

	await gridCell(page, 10).click();
	await page.keyboard.press("x");
	await expect.poll(() => gridIds(page)).toEqual([12, 11, 9, 7, 3]);
	await expectReasonCounts(page, { All: 5, Blurry: 3 });

	release.open();
	await expect.poll(() => gridIds(page)).toEqual(CANDIDATE_IDS);
	await expectReasonCounts(page, { All: 6, Blurry: 4 });
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't reject photo: Database is locked",
	);
	expect(calls.resolveJunk).toEqual([{ photoIds: [10], action: "reject" }]);

	await page.getByRole("button", { name: "Dismiss error" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("rejecting more than 50 shown photos asks for confirmation first", async ({
	page,
	mockBackend,
}) => {
	// 51 candidates: copies of photo 3 with distinct ids (thumbnails are mocked).
	const base = FIXTURE_PHOTOS[2];
	const many = Array.from({ length: 51 }, (_, i) => ({
		...base,
		id: 1000 - i,
		junkReasons: ["blurry"],
	}));
	const manyIds = many.map((p) => p.id);
	const counts = { ...EMPTY_COUNTS, all: 51, blurry: 51 };
	let resolved = false;
	const calls = await mockBackend({
		junkReview: () =>
			resolved
				? { photos: [], nextCursor: null, counts: EMPTY_COUNTS }
				: { photos: many, nextCursor: null, counts },
		resolveJunk: () => {
			resolved = true;
			return { updated: manyIds };
		},
	});
	await page.goto("/");
	await reviewItem(page).click();
	await expect.poll(async () => (await gridIds(page)).length).toBe(51);

	await headerButton(page, /^Reject all/).click();
	const dialog = page.getByRole("dialog", { name: "Reject 51 photos?" });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	expect(calls.resolveJunk).toBeUndefined();
	expect((await gridIds(page)).length).toBe(51);

	await headerButton(page, /^Reject all/).click();
	await dialog.getByRole("button", { name: "Reject 51 photos" }).click();
	await expect(page.getByText("Nothing to review")).toBeVisible();
	await expect
		.poll(() => calls.resolveJunk)
		.toEqual([{ photoIds: manyIds, action: "reject" }]);
});

test("an empty review shows Nothing to review with bulk actions disabled", async ({
	page,
	mockBackend,
}) => {
	await mockBackend({
		junkReview: () => ({ photos: [], nextCursor: null, counts: EMPTY_COUNTS }),
	});
	await page.goto("/");
	await expect(reviewItem(page)).toContainText("0");
	await reviewItem(page).click();

	await expect(page.getByText("Nothing to review")).toBeVisible();
	await expect(page.getByTestId("photo-grid")).toHaveCount(0);
	await expect(headerButton(page, /^Reject all/)).toBeDisabled();
	await expect(headerButton(page, /^Keep all/)).toBeDisabled();
});

test("leaving Review restores the library with its folder and filters", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await page.goto("/");
	const panel = leftPanel(page);
	await panel.getByRole("button", { name: /^2024/ }).click();
	await panel.getByText("Filter By").click();
	await panel
		.getByRole("radiogroup", { name: "Flag" })
		.getByRole("radio", { name: "Picks", exact: true })
		.click();
	const picks = fixtureGridIds(
		filterFixturePhotos(FIXTURE_PHOTOS, {
			folder: "photos/2024",
			flag: "pick",
		}),
	);
	await expect.poll(() => gridIds(page)).toEqual(picks);
	const libraryRequest = calls.photos?.at(-1);
	expect(libraryRequest).toEqual({ folder: "photos/2024", flag: "pick" });

	await reviewItem(page).click();
	await expect.poll(() => gridIds(page)).toEqual(CANDIDATE_IDS);
	await expect(panel.getByText("Filters active")).toHaveCount(0);
	await expect(panel.getByText("Showing: photos/2024")).toHaveCount(0);

	await headerButton(page, /^Exit review/).click();
	await expect(page.getByTestId("review-header")).toHaveCount(0);
	await expect.poll(() => gridIds(page)).toEqual(picks);
	await expect(panel.getByText("Filters active")).toBeVisible();
	await expect(panel.getByText("Showing: photos/2024")).toBeVisible();
	expect(calls.photos?.at(-1)).toEqual(libraryRequest);

	// Choosing a folder also leaves Review.
	await reviewItem(page).click();
	await expect.poll(() => gridIds(page)).toEqual(CANDIDATE_IDS);
	await panel.getByRole("button", { name: /^2024/ }).click();
	await expect(reviewItem(page)).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => gridIds(page)).toEqual(picks);
});
