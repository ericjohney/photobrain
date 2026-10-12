/**
 * CPU profile and trace summary of one scenario (4x CPU throttle): JS self
 * time by function plus Layout/Paint/HitTest totals. Same setup as
 * `profile.ts`.
 *   bun perf/cpu-profile.ts scroll|click|grouping
 */
import { chromium } from "@playwright/test";

const scenario = process.argv[2] ?? "scroll";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await p.goto(process.env.PERF_URL ?? "http://localhost:4173");
await p.locator("[data-photo-id]").first().waitFor({ timeout: 60_000 });
await p.waitForTimeout(3000);
const box = (await p.getByTestId("photo-grid").first().boundingBox())!;
await p.mouse.move(box.x + 300, box.y + 300);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp
	.send("Tracing.start", {
		categories: "devtools.timeline,disabled-by-default-devtools.timeline",
		transferMode: "ReturnAsStream",
	})
	.catch(() => {});
await cdp.send("Profiler.start");
if (scenario === "scroll")
	for (let i = 0; i < 40; i++) {
		await p.mouse.wheel(0, 600);
		await p.waitForTimeout(16);
	}
if (scenario === "click")
	for (let i = 0; i < 6; i++) {
		await p.mouse.click(box.x + 60 + i * 150, box.y + 80);
		await p.waitForTimeout(300);
	}
if (scenario === "grouping")
	for (const n of ["All", "Months"]) {
		await p.getByRole("radio", { name: n, exact: true }).click();
		await p.waitForTimeout(1500);
	}
await p.waitForTimeout(500);
const { profile } = await cdp.send("Profiler.stop");
// Trace: summarize top-level event categories (Layout, Paint, etc.).
const done = new Promise<string>((resolve) =>
	cdp.once("Tracing.tracingComplete", async (e: { stream: string }) => {
		let data = "";
		for (;;) {
			const r = await cdp.send("IO.read", { handle: e.stream });
			data += r.data;
			if (r.eof) break;
		}
		resolve(data);
	}),
);
await cdp.send("Tracing.end");
const trace = JSON.parse(await done);
const events = (trace.traceEvents ?? trace) as {
	name: string;
	dur?: number;
	ph: string;
}[];
const byName = new Map<string, number>();
for (const e of events)
	if (e.ph === "X" && e.dur)
		byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur / 1000);
const top = [...byName]
	.filter(([n]) =>
		[
			"Layout",
			"UpdateLayoutTree",
			"Paint",
			"PrePaint",
			"Layerize",
			"RunTask",
			"FunctionCall",
			"EventDispatch",
			"HitTest",
			"Decode Image",
			"ImageDecodeTask",
			"ParseHTML",
			"Commit",
			"ScrollLayer",
		].includes(n),
	)
	.sort((a, b) => b[1] - a[1]);
console.log(
	"trace ms:",
	top.map(([n, v]) => `${n}=${Math.round(v)}`).join(" "),
);
const self = new Map<string, number>();
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
const samples = profile.samples;
for (let i = 0; i < samples.length; i++) {
	const n = nodes.get(samples[i])!;
	const f = n.callFrame;
	const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
	self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
}
console.log(
	[...self]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 25)
		.map(([k, v]) => `${Math.round(v)}ms ${k}`)
		.join("\n"),
);
await b.close();
