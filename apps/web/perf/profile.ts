/**
 * Happy-path performance profile of the web app against a real API.
 *
 *   PERF_URL=http://localhost:4173 PERF_CPU=4 bun perf/profile.ts [label]
 *
 * Serve a production build first (`VITE_API_URL=<api> bunx vite build &&
 * bunx vite preview --port 4173`); a library of several thousand photos
 * (e.g. the production API) is what makes the numbers meaningful. CPU is
 * throttled 4x by default (`PERF_CPU`). The script rates a photo 3 and then
 * clears it to 0, so it leaves curation as it found it only when the first
 * clicked photo was unrated. Interaction latency comes from the Event
 * Timing API (input → next paint, like INP), so it includes React render,
 * layout, and paint. Results are printed and appended to perf/results.jsonl.
 */
import { appendFileSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const APP_URL = process.env.PERF_URL ?? "http://localhost:4173";
const label = process.argv[2] ?? "run";

type Stats = { n: number; p50: number; p95: number; max: number };
function stats(values: number[]): Stats {
	const s = [...values].sort((a, b) => a - b);
	const at = (q: number) =>
		s.length
			? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))])
			: 0;
	return { n: s.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

async function installObservers(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as Record<string, unknown[]>;
		w.__events = [];
		w.__longtasks = [];
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as PerformanceEventTiming[]) {
				if (e.interactionId)
					w.__events.push({ name: e.name, duration: e.duration });
			}
		}).observe({
			type: "event",
			buffered: true,
			durationThreshold: 16,
		} as PerformanceObserverInit);
		new PerformanceObserver((list) => {
			for (const e of list.getEntries()) w.__longtasks.push(e.duration);
		}).observe({ type: "longtask", buffered: true });
	});
}

/** Max interaction duration recorded while running `action`. */
async function interaction(
	page: Page,
	action: () => Promise<void>,
	settle = 400,
) {
	await page.evaluate(() => {
		(window as unknown as { __events: unknown[] }).__events = [];
	});
	await action();
	await page.waitForTimeout(settle);
	const events = await page.evaluate(
		() => (window as unknown as { __events: { duration: number }[] }).__events,
	);
	// Event timing only reports events >= 16 ms; a missing entry means fast.
	return events.length ? Math.max(...events.map((e) => e.duration)) : 16;
}

async function longTaskTotal(page: Page) {
	return page.evaluate(() => {
		const w = window as unknown as { __longtasks: number[] };
		const total = w.__longtasks.reduce((a, b) => a + b, 0);
		w.__longtasks = [];
		return Math.round(total);
	});
}

async function scrollFrames(page: Page, steps: number, delta: number) {
	await page.evaluate(() => {
		const w = window as unknown as { __frames: number[]; __rafRun: boolean };
		w.__frames = [];
		w.__rafRun = true;
		let last = performance.now();
		const tick = (now: number) => {
			w.__frames.push(now - last);
			last = now;
			if (w.__rafRun) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	for (let i = 0; i < steps; i++) {
		await page.mouse.wheel(0, delta);
		await page.waitForTimeout(16);
	}
	await page.waitForTimeout(300);
	const frames = await page.evaluate(() => {
		const w = window as unknown as { __frames: number[]; __rafRun: boolean };
		w.__rafRun = false;
		return w.__frames.slice(1);
	});
	return {
		...stats(frames),
		jank: frames.filter((f) => f > 50).length,
		longTaskMs: await longTaskTotal(page),
	};
}

const browser = await chromium.launch();
const context = await browser.newContext({
	viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
await installObservers(page);
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
// CPU slowdown factor (default 4x, roughly a mid-range laptop).
const cpu = Number(process.env.PERF_CPU ?? 4);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });

const result: Record<string, unknown> = {
	label,
	cpu,
	at: new Date().toISOString(),
};

// 1. Initial load: until the first grid thumbnail has decoded.
const t0 = Date.now();
await page.goto(APP_URL);
await page.locator("[data-photo-id] img").first().waitFor({ timeout: 60_000 });
await page.waitForFunction(() =>
	[...document.querySelectorAll<HTMLImageElement>("[data-photo-id] img")]
		.slice(0, 4)
		.every((img) => img.complete && img.naturalWidth > 0),
);
result.loadToFirstThumbsMs = Date.now() - t0;
await page.waitForTimeout(1500);
result.loadLongTaskMs = await longTaskTotal(page);
result.photoCount = await page
	.locator("text=/\\d+ photos/")
	.first()
	.textContent();
result.domNodes = await page.evaluate(
	() => document.querySelectorAll("*").length,
);
result.tilesInDom = await page.locator("[data-photo-id]").count();
const metrics = (await cdp.send("Performance.getMetrics")).metrics;
result.heapMB = Math.round(
	(metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1e6,
);

// 2. Click tiles in the grid (select).
const gridBox = await page.getByTestId("photo-grid").first().boundingBox();
if (!gridBox) throw new Error("no grid");
const clicks: number[] = [];
for (let i = 0; i < 8; i++) {
	const x = gridBox.x + 60 + (i % 4) * 150;
	const y = gridBox.y + 80 + Math.floor(i / 4) * 150;
	clicks.push(await interaction(page, () => page.mouse.click(x, y)));
}
result.gridClick = stats(clicks);

// 3. Arrow keys in the grid with an active photo.
const gridArrows: number[] = [];
for (let i = 0; i < 8; i++) {
	gridArrows.push(
		await interaction(page, () => page.keyboard.press("ArrowRight"), 200),
	);
}
result.gridArrow = stats(gridArrows);

// 4. Scroll the grid.
await page.mouse.move(gridBox.x + 300, gridBox.y + 300);
await longTaskTotal(page);
result.scroll = await scrollFrames(page, 80, 600);

// 5. Scrolled-down click (scroll position kept, select a tile).
result.clickAfterScroll = await interaction(page, () =>
	page.mouse.click(gridBox.x + 100, gridBox.y + 200),
);

// 6. Open the loupe (double-click), arrow through it, return to the grid.
result.openLoupe = await interaction(
	page,
	() => page.mouse.dblclick(gridBox.x + 100, gridBox.y + 200),
	800,
);
const loupeArrows: number[] = [];
for (let i = 0; i < 8; i++) {
	loupeArrows.push(
		await interaction(page, () => page.keyboard.press("ArrowRight"), 250),
	);
}
result.loupeArrow = stats(loupeArrows);
result.loupeDomNodes = await page.evaluate(
	() => document.querySelectorAll("*").length,
);
result.backToGrid = await interaction(
	page,
	() => page.keyboard.press("g"),
	800,
);

// 7. Rate the active photo (optimistic cache update across lists). Rate then
// clear, so the library is left as it was.
result.rate = await interaction(page, () => page.keyboard.press("3"), 600);
await interaction(page, () => page.keyboard.press("0"), 1500);

// 8. Toggle timeline grouping.
const grouping: number[] = [];
for (const name of ["All", "Years", "Months"]) {
	grouping.push(
		await interaction(
			page,
			() => page.getByRole("radio", { name, exact: true }).click(),
			800,
		),
	);
}
result.grouping = stats(grouping);

// 9. Type in the search box (per-keystroke cost; results come from the API).
await page.getByPlaceholder("Search photos...").click();
const typing: number[] = [];
for (const ch of "beach") {
	typing.push(await interaction(page, () => page.keyboard.type(ch), 150));
}
result.searchKeystroke = stats(typing);
await page.waitForTimeout(2000);
result.clearSearch = await interaction(
	page,
	() => page.getByRole("button", { name: "Clear search" }).click(),
	1500,
);

// 10. Thumbnail size slider.
result.thumbSlider = await interaction(
	page,
	async () => {
		await page.getByRole("slider").first().focus();
		await page.keyboard.press("ArrowRight");
	},
	800,
);

console.log(JSON.stringify(result, null, 2));
appendFileSync(
	new URL("./results.jsonl", import.meta.url),
	`${JSON.stringify(result)}\n`,
);
await browser.close();
