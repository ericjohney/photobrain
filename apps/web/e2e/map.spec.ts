import type { Page } from "@playwright/test";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
	FIXTURE_FOLDERS,
	FIXTURE_LIBRARY,
	FIXTURE_PHOTOS,
	type FixturePhotoFilters,
	filterFixturePhotos,
	fixtureLocation,
} from "./fixtures/photos";
import { expect, test } from "./fixtures/test";

declare global {
	interface Window {
		/** Set by `MapView` in development (the Playwright web server). */
		__PHOTOBRAIN_MAP__?: MapLibreMap;
	}
}

// Layer IDs from `MapView.tsx`.
const CLUSTER_LAYER = "photo-clusters";
const POINT_LAYER = "photo-points";

/** Geotagged photos of the unfiltered library (stacked like the grid). */
const GEOTAGGED_IDS = FIXTURE_LIBRARY.filter((p) => fixtureLocation(p)).map(
	(p) => p.id,
);

// The map needs WebGL. Fail loudly (never skip) when the browser lacks it.
test.beforeEach(async ({ page }) => {
	await page.goto("about:blank");
	const webgl = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
	});
	if (!webgl) {
		throw new Error(
			"Headless Chromium has no WebGL; the MapLibre map view cannot render.",
		);
	}
});

async function gridIds(page: Page) {
	return page
		.locator('[data-testid="photo-grid"] [data-photo-id]')
		.evaluateAll((els) =>
			els.map((el) => Number(el.getAttribute("data-photo-id"))),
		);
}

async function openLibrary(page: Page) {
	await page.goto("/");
	await expect(
		page.getByText(`${FIXTURE_LIBRARY.length} photos`, { exact: true }),
	).toBeVisible();
}

async function openMap(page: Page) {
	await page.getByRole("button", { name: "Map view" }).click();
	await expect(page.getByTestId("map-view")).toBeVisible();
	await waitForMapIdle(page);
}

/** Waits until the map's style, source, and current camera have rendered. */
async function waitForMapIdle(page: Page) {
	await page.waitForFunction(() => {
		const map = window.__PHOTOBRAIN_MAP__;
		return (
			map?.loaded() && map.isSourceLoaded("photo-locations") && !map.isMoving()
		);
	});
}

/**
 * Rendered photos: cluster sizes plus unclustered points, with the screen
 * position of each feature (CSS pixels relative to the map canvas).
 */
async function renderedFeatures(page: Page) {
	return page.evaluate(
		({ clusterLayer, pointLayer }) => {
			const map = window.__PHOTOBRAIN_MAP__;
			if (!map) return [];
			return map
				.queryRenderedFeatures({ layers: [clusterLayer, pointLayer] })
				.flatMap((feature) => {
					if (feature.geometry.type !== "Point") return [];
					const [lng, lat] = feature.geometry.coordinates;
					const { x, y } = map.project([lng, lat]);
					const count = feature.properties.point_count;
					return [
						{
							cluster: count !== undefined,
							count: count === undefined ? 1 : Number(count),
							id: Number(feature.properties.id),
							x,
							y,
						},
					];
				});
		},
		{ clusterLayer: CLUSTER_LAYER, pointLayer: POINT_LAYER },
	);
}

async function renderedTotal(page: Page) {
	// Features crossing tile edges are reported once per tile; dedupe by position.
	const unique = new Map<string, number>();
	for (const feature of await renderedFeatures(page)) {
		unique.set(
			`${Math.round(feature.x)},${Math.round(feature.y)}`,
			feature.count,
		);
	}
	return [...unique.values()].reduce((sum, count) => sum + count, 0);
}

/** Real mouse click at a canvas-relative position. */
async function clickMap(page: Page, x: number, y: number) {
	const box = await page.getByTestId("map-view").boundingBox();
	if (!box) throw new Error("map is not laid out");
	await page.mouse.click(box.x + x, box.y + y);
}

async function moveMap(
	page: Page,
	camera: { center: [number, number]; zoom: number },
) {
	await page.evaluate(
		(options) => window.__PHOTOBRAIN_MAP__?.jumpTo(options),
		camera,
	);
	await waitForMapIdle(page);
}

function areaButton(page: Page) {
	return page.getByRole("button", { name: /in this area$/ });
}

test("the map shows clustered points for the library filters", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openMap(page);

	await expect(page.getByTestId("map-summary")).toHaveText(
		`${GEOTAGGED_IDS.length} photos on map`,
	);
	expect(calls.photoLocations?.at(-1)).toEqual({});
	// Every geotagged photo is drawn once, inside a cluster or as a point.
	await expect.poll(() => renderedTotal(page)).toBe(GEOTAGGED_IDS.length);
	// The US West Coast photos share a cluster at the fitted world zoom; its
	// DOM label shows how many photos it holds.
	const labels = page.getByTestId("map-cluster-count");
	await expect(labels.first()).toBeVisible();
	const labelTotal = (await labels.allTextContents())
		.map(Number)
		.reduce((sum, n) => sum + n, 0);
	expect(labelTotal).toBeGreaterThanOrEqual(2);
	// Labels plus the unclustered points account for every geotagged photo.
	const singles = new Set(
		(await renderedFeatures(page)).filter((f) => !f.cluster).map((f) => f.id),
	);
	expect(labelTotal + singles.size).toBe(GEOTAGGED_IDS.length);

	// A filter re-queries the locations: only the forest RAW has a location.
	await page.getByTestId("left-panel").getByText("Filter By").click();
	await page
		.getByTestId("left-panel")
		.getByRole("radiogroup", { name: "Photo type" })
		.getByRole("radio", { name: "RAW" })
		.click();
	await expect(page.getByTestId("map-summary")).toHaveText("1 photo on map");
	expect(calls.photoLocations?.at(-1)).toEqual({ filterRaw: "raw" });

	// Ratings with no geotagged matches show the empty state.
	await page
		.getByTestId("left-panel")
		.getByRole("radiogroup", { name: "Photo type" })
		.getByRole("radio", { name: "Standard" })
		.click();
	await page
		.getByTestId("left-panel")
		.getByRole("radiogroup", { name: "Flag" })
		.getByRole("radio", { name: "Rejected" })
		.click();
	await expect(page.getByTestId("map-empty")).toHaveText(/No geotagged photos/);
});

test("M switches to the map and the view mode persists", async ({ page }) => {
	await openLibrary(page);
	await page.keyboard.press("m");
	await expect(page.getByTestId("map-view")).toBeVisible();
	await page.reload();
	await expect(page.getByTestId("map-view")).toBeVisible();
	await page.keyboard.press("g");
	await expect(page.getByTestId("photo-grid")).toBeVisible();
});

test("changing the folder updates the map points", async ({
	page,
	mockBackend,
}) => {
	const nested = {
		...FIXTURE_PHOTOS[5],
		id: 14,
		name: "trip.jpg",
		path: "photos/2024/trip/trip.jpg",
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
		photos: (input) => {
			const photos = filterFixturePhotos(
				library,
				(input ?? {}) as FixturePhotoFilters,
			);
			return { photos, total: photos.length, rawCount: 0 };
		},
		photoLocations: (input) => {
			const points = filterFixturePhotos(
				library,
				(input ?? {}) as FixturePhotoFilters,
			).flatMap((p) => {
				const location = fixtureLocation(p);
				return location ? [{ id: p.id, ...location }] : [];
			});
			return { points, total: points.length };
		},
	});
	await page.goto("/");
	await openMap(page);
	await expect(page.getByTestId("map-summary")).toHaveText(
		`${GEOTAGGED_IDS.length + 1} photos on map`,
	);

	await page
		.getByTestId("left-panel")
		.getByText("2024", { exact: true })
		.click();
	await expect(page.getByTestId("map-summary")).toHaveText(
		`${GEOTAGGED_IDS.length} photos on map`,
	);
	expect(calls.photoLocations?.at(-1)).toEqual({ folder: "photos/2024" });
	await waitForMapIdle(page);
	await expect.poll(() => renderedTotal(page)).toBe(GEOTAGGED_IDS.length);
});

test("Show photos in this area filters the grid with a clearable Map area chip", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openMap(page);

	// San Francisco: sunset.jpg (1) and landscape.jpg (3).
	await moveMap(page, { center: [-122.45, 37.8], zoom: 9 });
	await expect(areaButton(page)).toHaveText("Show 2 photos in this area");
	await areaButton(page).click();

	await expect(page.getByTestId("photo-grid")).toBeVisible();
	await expect.poll(() => gridIds(page)).toEqual([1, 3]);
	const chip = page.getByTestId("map-area-chip");
	await expect(chip).toHaveText("Map area");
	const bounds = (calls.photos?.at(-1) as FixturePhotoFilters).bounds;
	expect(bounds).toBeDefined();
	expect(bounds!.west).toBeLessThan(bounds!.east);
	// The map area alone is never saved as a smart album.
	await expect(
		page
			.getByTestId("left-panel")
			.getByRole("button", { name: /Save as Smart Album/ }),
	).toHaveCount(0);

	await chip.getByRole("button", { name: "Clear map area" }).click();
	await expect(chip).toHaveCount(0);
	await expect
		.poll(() => gridIds(page))
		.toEqual(FIXTURE_LIBRARY.map((p) => p.id));
	// The unfiltered grid may come from the query cache; no new request needed.
	expect(calls.photos).toContainEqual({});
});

test("a map area across the antimeridian is normalized", async ({
	page,
	mockBackend,
}) => {
	const calls = await mockBackend();
	await openLibrary(page);
	await openMap(page);

	// Fiji (178°E) and Samoa (171°W) on either side of 180°.
	await moveMap(page, { center: [180, -15], zoom: 4 });
	await expect(areaButton(page)).toHaveText("Show 2 photos in this area");
	await areaButton(page).click();

	await expect.poll(() => gridIds(page)).toEqual([7, 9]);
	const bounds = (calls.photos?.at(-1) as FixturePhotoFilters).bounds!;
	expect(bounds.west).toBeGreaterThan(bounds.east);
	for (const lng of [bounds.west, bounds.east]) {
		expect(Math.abs(lng)).toBeLessThanOrEqual(180);
	}
});

test("metadata Show on map centers the photo; clicking its point opens the loupe", async ({
	page,
}) => {
	await openLibrary(page);
	const rightPanel = page.getByTestId("right-panel");
	const showOnMap = rightPanel.getByRole("button", { name: "Show on map" });

	// No button without a valid location: no GPS, then the bogus 0,0.
	await page.locator('[data-photo-id="5"]').click();
	await expect(rightPanel.getByText("street.jpg")).toBeVisible();
	await expect(showOnMap).toHaveCount(0);
	await page.locator('[data-photo-id="12"]').click();
	await expect(rightPanel.getByText("dog.jpg")).toBeVisible();
	await expect(showOnMap).toHaveCount(0);

	await page.locator('[data-photo-id="3"]').click();
	await showOnMap.click();
	await expect(page.getByTestId("map-view")).toBeVisible();
	await waitForMapIdle(page);
	const camera = await page.evaluate(() => {
		const map = window.__PHOTOBRAIN_MAP__;
		return map && { ...map.getCenter(), zoom: map.getZoom() };
	});
	expect(camera?.lat).toBeCloseTo(37.7749, 3);
	expect(camera?.lng).toBeCloseTo(-122.4194, 3);
	expect(camera?.zoom).toBe(14);

	// Real click on the projected point.
	await expect
		.poll(async () =>
			(await renderedFeatures(page)).some((f) => !f.cluster && f.id === 3),
		)
		.toBe(true);
	const point = (await renderedFeatures(page)).find(
		(f) => !f.cluster && f.id === 3,
	)!;
	await clickMap(page, point.x, point.y);
	await expect(page.getByTestId("loupe-view")).toBeVisible();
	await expect(rightPanel.getByText("landscape.jpg")).toBeVisible();
});

test("clicking a cluster zooms in", async ({ page }) => {
	await openLibrary(page);
	await openMap(page);
	await expect
		.poll(async () => (await renderedFeatures(page)).some((f) => f.cluster))
		.toBe(true);
	const cluster = (await renderedFeatures(page)).find((f) => f.cluster)!;
	const before = await page.evaluate(() =>
		window.__PHOTOBRAIN_MAP__?.getZoom(),
	);
	await clickMap(page, cluster.x, cluster.y);
	await expect
		.poll(() => page.evaluate(() => window.__PHOTOBRAIN_MAP__?.getZoom()))
		.toBeGreaterThan(before!);
});
