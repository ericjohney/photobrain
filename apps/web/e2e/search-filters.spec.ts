import type { Page } from "@playwright/test";
import {
	FIXTURE_FOLDERS,
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

async function openCameraFilters(page: Page) {
	const leftPanel = page.getByTestId("left-panel");
	await leftPanel.getByText("Filter By").click();
	await leftPanel.getByText("Camera", { exact: true }).click();
}

test("folders and filters stay visible while a search is active", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.getByPlaceholder("Search photos...").fill("beach");
	await expect(page.getByTestId("search-header")).toHaveText(
		"1 result for “beach”",
	);

	const leftPanel = page.getByTestId("left-panel");
	await expect(leftPanel.getByText("2024", { exact: true })).toBeVisible();
	await openCameraFilters(page);
	for (const camera of ["Sony A7III", "Canon EOS R5", "Fujifilm X-T5"]) {
		await expect(leftPanel.getByRole("button", { name: camera })).toBeVisible();
	}
});

test("selecting a camera while searching re-queries with that camera and scopes the header", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.getByPlaceholder("Search photos...").fill("jpg");
	await expect(page.getByTestId("search-header")).toHaveText(
		"9 results for “jpg”",
	);

	await openCameraFilters(page);
	await page
		.getByTestId("left-panel")
		.getByRole("button", { name: "Canon EOS R5" })
		.click();

	await expect(page.getByTestId("search-header")).toHaveText(
		"1 result for “jpg” · Canon EOS R5",
	);
	expect(await gridIds(page)).toEqual([3]);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "jpg",
		limit: 50,
		camera: "Canon EOS R5",
	});
	// The library query stays disabled during search; only searchPhotos is scoped.
	expect(
		calls.photos?.filter(
			(input) => (input as FixturePhotoFilters).camera !== undefined,
		),
	).toEqual([]);
});

test("selecting a folder while searching limits results to its direct children", async ({
	page,
	mockBackend,
}) => {
	const nested = {
		...FIXTURE_PHOTOS[5],
		id: 14,
		name: "beach-trip.jpg",
		path: "photos/2024/trip/beach-trip.jpg",
	};
	const library = [...FIXTURE_PHOTOS, nested];
	const calls = await mockBackend({
		folders: () => ({
			folders: [
				{
					...FIXTURE_FOLDERS.folders[0],
					children: [
						{
							name: "trip",
							path: "photos/2024/trip",
							photoCount: 1,
							children: [],
						},
					],
				},
			],
			totalPhotos: library.length,
		}),
		searchPhotos: (input) => {
			const { query = "", ...filters } = input as FixturePhotoFilters & {
				query?: string;
			};
			const photos = searchPhotosByQuery(
				query,
				filterFixturePhotos(library, filters),
			);
			return { photos, total: photos.length, query };
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await page.getByPlaceholder("Search photos...").fill("beach");
	await expect(page.getByTestId("search-header")).toHaveText(
		"2 results for “beach”",
	);
	expect(await gridIds(page)).toEqual([6, 14]);

	await page
		.getByTestId("left-panel")
		.getByText("2024", { exact: true })
		.click();

	await expect(page.getByTestId("search-header")).toHaveText(
		"1 result for “beach” in photos/2024",
	);
	expect(await gridIds(page)).toEqual([6]);
	await expect(page.getByPlaceholder("Search photos...")).toHaveValue("beach");
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "beach",
		limit: 50,
		folder: "photos/2024",
	});
});

test("clearing the search restores the filtered library grid", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	const sonyIds = filterFixturePhotos(FIXTURE_PHOTOS, {
		camera: "Sony A7III",
	}).map((p) => p.id);
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	await openCameraFilters(page);
	await page
		.getByTestId("left-panel")
		.getByRole("button", { name: "Sony A7III" })
		.click();
	await expect(page.getByText(`${sonyIds.length} photos`)).toBeVisible();

	await page.getByPlaceholder("Search photos...").fill("beach");
	await expect(page.getByTestId("search-header")).toHaveText(
		"1 result for “beach” · Sony A7III",
	);

	await page.getByRole("button", { name: "Clear search" }).click();
	await expect(page.getByTestId("search-header")).toHaveCount(0);
	await expect(page.getByPlaceholder("Search photos...")).toHaveValue("");
	await expect(page.getByText(`${sonyIds.length} photos`)).toBeVisible();
	expect(await gridIds(page)).toEqual(sonyIds);
	await expect(
		page.getByTestId("left-panel").getByText("Filters active"),
	).toBeVisible();
	expect(calls.photos?.at(-1)).toEqual({ camera: "Sony A7III" });
});

test("filters chosen before searching carry into the search request", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	const leftPanel = page.getByTestId("left-panel");
	await openCameraFilters(page);
	await leftPanel.getByRole("button", { name: "Canon EOS R5" }).click();
	await leftPanel.getByText("ISO", { exact: true }).click();
	await leftPanel.getByRole("button", { name: "ISO 100" }).click();
	await leftPanel.getByText("Date", { exact: true }).click();
	await leftPanel.getByRole("button", { name: "June 2024" }).click();
	await expect(page.getByText("1 photos")).toBeVisible();

	await page.getByPlaceholder("Search photos...").fill("jpg");
	await expect(page.getByTestId("search-header")).toHaveText(
		"1 result for “jpg” · Canon EOS R5 · ISO 100 · June 2024",
	);
	expect(await gridIds(page)).toEqual([3]);
	expect(calls.searchPhotos).toEqual([
		{
			query: "jpg",
			limit: 50,
			camera: "Canon EOS R5",
			iso: 100,
			dateMonth: "2024-06",
		},
	]);
});
