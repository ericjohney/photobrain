import type { Page } from "@playwright/test";
import { TINY_JPEG_BYTES } from "./fixtures/images";
import {
	FIXTURE_PHOTOS,
	FIXTURE_VIDEOS,
	filterFixturePhotos,
	fixtureGridIds,
} from "./fixtures/photos";
import { expect, type MockBackend, test } from "./fixtures/test";

declare global {
	interface Window {
		/** `[method, src]` per recorded play/pause (see recordMediaCalls). */
		__mediaCalls?: [string, string | null][];
	}
}

// The listed video library: every fixture but the hidden Live Photo clip (37).
const VIDEO_LIBRARY = filterFixturePhotos(FIXTURE_VIDEOS);
const HOUR_TOKEN = Date.parse("2026-01-05T00:00:00.000Z");

/**
 * Replaces `HTMLMediaElement` play/pause with recorders before any page script
 * runs: `window.__mediaCalls` logs `[method, src]`, and `paused` reflects the
 * recorded calls, so no real decoding is needed.
 */
async function recordMediaCalls(page: Page) {
	await page.addInitScript(() => {
		const calls: [string, string | null][] = [];
		const state = new WeakMap<HTMLMediaElement, boolean>();
		window.__mediaCalls = calls;
		Object.defineProperty(HTMLMediaElement.prototype, "paused", {
			configurable: true,
			get(this: HTMLMediaElement) {
				return state.get(this) ?? true;
			},
		});
		HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
			calls.push(["play", this.getAttribute("src")]);
			state.set(this, false);
			return Promise.resolve();
		};
		HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
			calls.push(["pause", this.getAttribute("src")]);
			state.set(this, true);
		};
	});
}

async function mediaCalls(page: Page) {
	return page.evaluate(() => window.__mediaCalls ?? []);
}

async function openVideoLibrary(page: Page, mockBackend: MockBackend) {
	const calls = await mockBackend({}, FIXTURE_VIDEOS);
	await page.goto("/");
	await expect(page.getByText(`${VIDEO_LIBRARY.length} photos`)).toBeVisible();
	return calls;
}

/** The runtime API origin, read from a rendered thumbnail URL. */
async function apiOrigin(page: Page): Promise<string> {
	const src = await page
		.locator('[data-testid="photo-grid"] img')
		.first()
		.getAttribute("src");
	if (!src) throw new Error("grid thumbnail has no src");
	return new URL(src).origin;
}

function tile(page: Page, id: number) {
	return page.locator(`[data-testid="photo-grid"] [data-photo-id="${id}"]`);
}

test("grid duration badges format boundaries and label the video", async ({
	page,
	mockBackend,
}) => {
	await openVideoLibrary(page, mockBackend);
	// The motion clip is never listed; its still carries the LIVE badge.
	expect(
		await page
			.locator('[data-testid="photo-grid"] [data-photo-id]')
			.evaluateAll((els) =>
				els.map((el) => Number(el.getAttribute("data-photo-id"))),
			),
	).toEqual(fixtureGridIds(VIDEO_LIBRARY));
	await expect(tile(page, 37)).toHaveCount(0);

	const expected: [id: number, text: string, label: string][] = [
		[30, "0:00", "Video"],
		[31, "0:59", "Video, 59 seconds"],
		[32, "1:00", "Video, 1 minute"],
		[33, "1:00:00", "Video, 1 hour"],
		[34, "1:05", "Video, 1 minute 5 seconds"],
		[35, "0:00", "Video"],
	];
	for (const [id, text, label] of expected) {
		const badge = tile(page, id).getByTestId("duration-badge");
		await expect(badge).toHaveText(text);
		await expect(badge).toHaveAttribute("aria-label", label);
	}

	const live = tile(page, 36);
	await expect(live.getByRole("img", { name: "Live Photo" })).toHaveText(
		"LIVE",
	);
	await expect(live.getByTestId("duration-badge")).toHaveCount(0);
	await expect(tile(page, 33).getByTestId("live-badge")).toHaveCount(0);
});

test("a video opens in the loupe as a paused player and leaves with the photo", async ({
	page,
	mockBackend,
}) => {
	await recordMediaCalls(page);
	await openVideoLibrary(page, mockBackend);
	const api = await apiOrigin(page);

	await tile(page, 33).dblclick();
	const video = page.getByTestId("loupe-video");
	await expect(video).toHaveAttribute(
		"src",
		`${api}/api/photos/33/file?v=${HOUR_TOKEN}`,
	);
	await expect(video).toHaveAttribute(
		"poster",
		`${api}/api/photos/33/thumbnail/large?v=${HOUR_TOKEN}`,
	);
	await expect(video).toHaveAttribute("controls", "");
	await expect(video).toHaveAttribute("preload", "metadata");
	expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
	expect(await video.evaluate((el: HTMLVideoElement) => el.autoplay)).toBe(
		false,
	);
	expect(await mediaCalls(page)).toEqual([]);
	await expect(
		page
			.locator("[data-filmstrip-photo-id='33']")
			.getByTestId("filmstrip-duration-badge"),
	).toHaveText("1:00:00");

	// Next video: a fresh element for 34, the previous one paused.
	await page.keyboard.press("ArrowRight");
	await expect(video).toHaveAttribute("src", `${api}/api/photos/34/file`);
	await expect(page.getByTestId("loupe-video")).toHaveCount(1);
	expect(await mediaCalls(page)).toEqual([
		["pause", `${api}/api/photos/33/file?v=${HOUR_TOKEN}`],
	]);

	// Two more: unknown.mp4 (35), then the Live still (36) — no player.
	await page.keyboard.press("ArrowRight");
	await expect(video).toHaveAttribute("src", `${api}/api/photos/35/file`);
	await page.keyboard.press("ArrowRight");
	await expect(
		page.getByTestId("loupe-view").locator("img[alt='live.heic']"),
	).toHaveCount(1);
	await expect(page.getByTestId("loupe-video")).toHaveCount(0);

	// Escape from a video unmounts it too.
	await page.keyboard.press("ArrowLeft");
	await expect(video).toHaveAttribute("src", `${api}/api/photos/35/file`);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("photo-grid")).toBeVisible();
	await expect(page.getByTestId("loupe-video")).toHaveCount(0);
	expect((await mediaCalls(page)).at(-1)).toEqual([
		"pause",
		`${api}/api/photos/35/file`,
	]);
});

test("Space plays and pauses the loupe video, never elsewhere", async ({
	page,
	mockBackend,
}) => {
	await recordMediaCalls(page);
	await openVideoLibrary(page, mockBackend);
	const api = await apiOrigin(page);
	const src = `${api}/api/photos/34/file`;

	// Grid with an active video: Space does nothing.
	await tile(page, 34).click();
	await page.keyboard.press("Space");
	expect(await mediaCalls(page)).toEqual([]);

	await page.keyboard.press("e");
	const video = page.getByTestId("loupe-video");
	await expect(video).toHaveAttribute("src", src);
	await page.keyboard.press("Space");
	expect(await mediaCalls(page)).toEqual([["play", src]]);
	expect(await video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false);
	await page.keyboard.press("Space");
	expect(await mediaCalls(page)).toEqual([
		["play", src],
		["pause", src],
	]);

	// Shift+Space still toggles the filmstrip and never the video.
	const filmstrip = page.locator("[data-filmstrip-photo-id='34']");
	await expect(filmstrip).toBeVisible();
	await page.keyboard.press("Shift+Space");
	await expect(filmstrip).toHaveCount(0);
	expect(await mediaCalls(page)).toHaveLength(2);
	await page.keyboard.press("Shift+Space");
	await expect(filmstrip).toBeVisible();

	// Typing a space in search types it and never plays the video (the search
	// grid replaces the loupe, which only releases the player).
	const search = page.getByPlaceholder("Search photos...");
	await search.click();
	await page.keyboard.press("Space");
	await expect(search).toHaveValue(" ");
	expect(
		(await mediaCalls(page)).filter(([method]) => method === "play"),
	).toHaveLength(1);

	// A still in the loupe: Space plays nothing. (Leaving the video's loupe
	// pauses it on unmount, so only `play` calls are counted.)
	await search.fill("");
	await search.blur();
	await page.keyboard.press("g");
	await expect(page.getByTestId("photo-grid")).toBeVisible();
	await tile(page, 36).dblclick();
	await expect(
		page.getByTestId("loupe-view").locator("img[alt='live.heic']"),
	).toHaveCount(1);
	await page.keyboard.press("Space");
	expect(
		(await mediaCalls(page)).filter(([method]) => method === "play"),
	).toHaveLength(1);
});

test("LIVE plays the motion clip once, then returns to the still", async ({
	page,
	mockBackend,
}) => {
	await recordMediaCalls(page);
	await openVideoLibrary(page, mockBackend);
	const api = await apiOrigin(page);
	const clip = `${api}/api/photos/37/file`;
	// Keep the clip request pending so no load error ends playback early.
	const pending = Promise.withResolvers<void>();
	await page.route(/\/api\/photos\/37\/file/, () => pending.promise);

	await tile(page, 36).dblclick();
	const loupe = page.getByTestId("loupe-view");
	await expect(loupe.locator("img[alt='live.heic']")).toBeVisible();
	await expect(page.getByTestId("live-video")).toHaveCount(0);
	expect(await mediaCalls(page)).toEqual([]);

	const button = loupe.getByRole("button", { name: "Play Live Photo" });
	await expect(button).toHaveAttribute("aria-pressed", "false");
	await button.click();
	const live = page.getByTestId("live-video");
	await expect(live).toHaveAttribute("src", clip);
	await expect(button).toHaveAttribute("aria-pressed", "true");
	expect(await live.evaluate((el: HTMLVideoElement) => el.muted)).toBe(true);
	expect(await live.evaluate((el: HTMLVideoElement) => el.loop)).toBe(false);
	expect(await mediaCalls(page)).toEqual([["play", clip]]);
	// The still stays underneath.
	await expect(loupe.locator("img[alt='live.heic']")).toHaveCount(1);

	await live.dispatchEvent("ended");
	await expect(page.getByTestId("live-video")).toHaveCount(0);
	await expect(button).toHaveAttribute("aria-pressed", "false");
	await expect(loupe.locator("img[alt='live.heic']")).toBeVisible();

	// Replay, then navigate away mid-clip: the clip is paused and removed.
	await button.click();
	await expect(live).toHaveAttribute("src", clip);
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByTestId("live-video")).toHaveCount(0);
	expect((await mediaCalls(page)).slice(-2)).toEqual([
		["play", clip],
		["pause", clip],
	]);
});

test("Type Video sends filterRaw video and lists videos only", async ({
	page,
	mockBackend,
}) => {
	const library = [...FIXTURE_PHOTOS, ...FIXTURE_VIDEOS];
	const calls = await mockBackend({}, library);
	await page.goto("/");
	const all = filterFixturePhotos(library);
	await expect(page.getByText(`${all.length} photos`)).toBeVisible();

	await page.getByTestId("left-panel").getByText("Filter By").click();
	const radio = (name: string) =>
		page.getByTestId("left-panel").getByRole("radio", { name, exact: true });
	await radio("Video").click();
	const videos = filterFixturePhotos(library, { filterRaw: "video" });
	await expect(page.getByText(`${videos.length} photos`)).toBeVisible();
	expect(calls.photos?.at(-1)).toEqual({ filterRaw: "video" });
	await expect(radio("Video")).toHaveAttribute("aria-checked", "true");
	expect(
		await page
			.locator('[data-testid="photo-grid"] [data-photo-id]')
			.evaluateAll((els) =>
				els.map((el) => Number(el.getAttribute("data-photo-id"))),
			),
	).toEqual([30, 31, 32, 33, 34, 35]);

	// Search keeps the scope and names it.
	await page.getByPlaceholder("Search photos...").fill("mp4");
	await expect(page.getByTestId("search-header")).toHaveText(
		"5 results for “mp4” · Videos only",
	);
	expect(calls.searchPhotos?.at(-1)).toEqual({
		query: "mp4",
		limit: 50,
		filterRaw: "video",
	});
});

test("a video's Export menu offers only the original; Shift+D downloads it", async ({
	page,
	mockBackend,
}) => {
	await openVideoLibrary(page, mockBackend);
	const api = await apiOrigin(page);
	const requested: string[] = [];
	await page.route(/\/api\/photos\/\d+\/export/, (route) => {
		requested.push(route.request().url());
		return route.fulfill({
			status: 200,
			contentType: "video/quicktime",
			headers: { "Content-Disposition": 'attachment; filename="hour.mov"' },
			body: TINY_JPEG_BYTES,
		});
	});

	await tile(page, 33).click();
	const panel = page.getByTestId("right-panel");
	await panel.getByRole("button", { name: "Export" }).click();
	const items = panel
		.getByRole("menu", { name: "Export" })
		.getByRole("menuitem");
	await expect(items).toHaveText(["Original (hour.mov)"]);
	await expect(items.first()).toHaveAttribute(
		"href",
		`${api}/api/photos/33/export?size=original`,
	);
	await expect(items.first()).toHaveAttribute("download", "hour.mov");
	await page.keyboard.press("Escape");

	const downloadPromise = page.waitForEvent("download");
	await page.keyboard.press("Shift+D");
	const download = await downloadPromise;
	expect(download.url()).toBe(`${api}/api/photos/33/export?size=original`);
	expect(download.suggestedFilename()).toBe("hour.mov");
	expect(requested).toEqual([`${api}/api/photos/33/export?size=original`]);

	// A still in the same library keeps every size.
	await tile(page, 36).click();
	await panel.getByRole("button", { name: "Export" }).click();
	await expect(
		panel.getByRole("menu", { name: "Export" }).getByRole("menuitem"),
	).toHaveText(["Original (live.heic)", "JPEG, 2048 px", "JPEG, 1024 px"]);
});

test("the metadata panel shows a video's duration, codec, and dimensions", async ({
	page,
	mockBackend,
}) => {
	await openVideoLibrary(page, mockBackend);
	const panel = page.getByTestId("right-panel");
	const row = (label: string) =>
		panel.locator(".metadata-row", {
			has: page.locator(".metadata-label", {
				hasText: new RegExp(`^${label}$`),
			}),
		});

	await tile(page, 33).click();
	await expect(row("Duration").locator(".metadata-value")).toHaveText(
		"1:00:00",
	);
	await expect(row("Codec").locator(".metadata-value")).toHaveText("HEVC");
	await expect(row("Dimensions").locator(".metadata-value")).toHaveText(
		"1920 x 1080",
	);

	// Unknown duration and codec: 0:00 and no codec row.
	await tile(page, 35).click();
	await expect(row("Duration").locator(".metadata-value")).toHaveText("0:00");
	await expect(row("Codec")).toHaveCount(0);

	// Stills have neither row.
	await tile(page, 36).click();
	await expect(row("Duration")).toHaveCount(0);
	await expect(row("Codec")).toHaveCount(0);
});
