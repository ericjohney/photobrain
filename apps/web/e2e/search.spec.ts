import { FIXTURE_PHOTOS } from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

test("typing a query triggers searchPhotos call and renders filtered results", async ({
	page,
	mockBackend,
}) => {
	const queries: string[] = [];
	await mockBackend({
		searchPhotos: (input) => {
			const q = (input as { query?: string } | null)?.query ?? "";
			queries.push(q);
			const photos = FIXTURE_PHOTOS.filter((p) => p.name.includes(q));
			return { photos, total: photos.length, query: q };
		},
	});
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	const searchInput = page.getByPlaceholder("Search photos...");
	await searchInput.fill("sunset");
	await expect(page.getByText("1 photos")).toBeVisible();
	expect(queries).toContain("sunset");
});

test("clearing search returns to full photo list", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByText("12 photos")).toBeVisible();
	const searchInput = page.getByPlaceholder("Search photos...");
	await searchInput.fill("sunset");
	await expect(page.getByText("1 photos")).toBeVisible();
	await searchInput.fill("");
	await expect(page.getByText("12 photos")).toBeVisible();
});
