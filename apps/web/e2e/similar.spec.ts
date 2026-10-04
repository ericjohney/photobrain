import type { Page } from "@playwright/test";
import {
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	fixtureGridIds,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

const SIMILAR_IDS = [7, 3, 12];

function photoIdOf(input: unknown): number {
	if (input && typeof input === "object" && "photoId" in input) {
		if (typeof input.photoId === "number") return input.photoId;
	}
	throw new Error("similarPhotos input missing photoId");
}

function similarResult(photoId: number, ids = SIMILAR_IDS) {
	const photos = ids.map((id) => FIXTURE_PHOTOS.find((p) => p.id === id));
	return {
		photos,
		total: photos.length,
		sourcePhotoId: photoId,
		indexed: true,
	};
}

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

test("Find similar button shows results in returned order with source chip", async ({
	page,
	mockBackend,
}) => {
	const requests: unknown[] = [];
	await mockBackend({
		similarPhotos: (input) => {
			requests.push(input);
			return similarResult(photoIdOf(input));
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="1"]').click();
	await page.getByRole("button", { name: "Find similar" }).click();

	await expect(page.getByTestId("similar-chip")).toContainText(
		"Similar to sunset.jpg",
	);
	await expect(page.getByText("3 photos")).toBeVisible();
	expect(await gridIds(page)).toEqual(SIMILAR_IDS);
	expect(requests).toEqual([{ photoId: 1, limit: 60 }]);
});

test("S shortcut from loupe enters similar mode for the active photo", async ({
	page,
	mockBackend,
}) => {
	const requested: number[] = [];
	await mockBackend({
		similarPhotos: (input) => {
			const photoId = photoIdOf(input);
			requested.push(photoId);
			return similarResult(photoId);
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="5"]').dblclick();
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	await page.keyboard.press("s");

	await expect(page.getByTestId("photo-grid")).toBeVisible();
	await expect(page.getByTestId("similar-chip")).toContainText(
		"Similar to street.jpg",
	);
	expect(await gridIds(page)).toEqual(SIMILAR_IDS);
	expect(requested).toEqual([5]);
});

test("S is ignored while typing in the search input", async ({
	page,
	mockBackend,
}) => {
	let calls = 0;
	await mockBackend({
		similarPhotos: (input) => {
			calls++;
			return similarResult(photoIdOf(input));
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="1"]').click();
	const searchInput = page.getByPlaceholder("Search photos...");
	await searchInput.focus();
	await page.keyboard.press("s");

	await expect(searchInput).toHaveValue("s");
	await expect(page.getByTestId("similar-chip")).toHaveCount(0);
	expect(calls).toBe(0);
});

test("chip ✕ exits similar mode and restores the library grid", async ({
	page,
	mockBackend,
}) => {
	await mockBackend({
		similarPhotos: (input) => similarResult(photoIdOf(input)),
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="1"]').click();
	await page.keyboard.press("s");
	await expect(page.getByText("3 photos")).toBeVisible();

	await page.getByRole("button", { name: "Exit similar photos" }).click();
	await expect(page.getByTestId("similar-chip")).toHaveCount(0);
	await expect(page.getByText("12 photos")).toBeVisible();
	expect(await gridIds(page)).toEqual(fixtureGridIds(FIXTURE_LIBRARY));
});

test("Escape in grid exits similar mode", async ({ page, mockBackend }) => {
	await mockBackend({
		similarPhotos: (input) => similarResult(photoIdOf(input)),
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="1"]').click();
	await page.keyboard.press("s");
	await expect(page.getByText("3 photos")).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("similar-chip")).toHaveCount(0);
	await expect(page.getByText("12 photos")).toBeVisible();
});

test("typing a search exits similar mode", async ({ page, mockBackend }) => {
	await mockBackend({
		similarPhotos: (input) => similarResult(photoIdOf(input)),
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="1"]').click();
	await page.keyboard.press("s");
	await expect(page.getByTestId("similar-chip")).toBeVisible();

	await page.getByPlaceholder("Search photos...").fill("beach");
	await expect(page.getByTestId("similar-chip")).toHaveCount(0);
	await expect(page.getByText("1 photos")).toBeVisible();
	expect(await gridIds(page)).toEqual([6]);
});

test("indexed:false shows the not-indexed message", async ({
	page,
	mockBackend,
}) => {
	await mockBackend({
		similarPhotos: (input) => ({
			photos: [],
			total: 0,
			sourcePhotoId: photoIdOf(input),
			indexed: false,
		}),
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.locator('[data-photo-id="2"]').click();
	await page.keyboard.press("s");

	await expect(page.getByTestId("similar-chip")).toContainText(
		"Similar to portrait.arw",
	);
	await expect(
		page.getByText(
			"This photo hasn't been indexed yet. Run a scan to enable similar-photo search.",
		),
	).toBeVisible();
	await expect(page.getByTestId("photo-grid")).toHaveCount(0);
});
