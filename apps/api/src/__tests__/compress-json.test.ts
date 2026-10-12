import { describe, expect, test } from "bun:test";
import { gunzipSync, inflateSync } from "node:zlib";
import { Hono } from "hono";
import { compressJson } from "../middleware/compress-json";

const BIG = {
	photos: Array.from({ length: 500 }, (_, id) => ({
		id,
		name: `IMG_${id}.jpg`,
	})),
};

function createApp() {
	const app = new Hono();
	app.use("*", compressJson());
	app.get("/json", (c) => c.json(BIG));
	app.get("/small", (c) => c.json({ ok: true }));
	app.get("/image", (c) =>
		c.body(new Uint8Array(4096), 200, { "Content-Type": "image/webp" }),
	);
	app.get("/sse", (c) =>
		c.body("data: x\n\n".repeat(500), 200, {
			"Content-Type": "text/event-stream",
		}),
	);
	return app;
}

async function bytes(res: Response) {
	return Buffer.from(await res.arrayBuffer());
}

describe("compressJson", () => {
	test("gzips large JSON when accepted, and the body round-trips", async () => {
		const res = await createApp().request("/json", {
			headers: { "Accept-Encoding": "gzip, deflate, br" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Encoding")).toBe("gzip");
		expect(res.headers.get("Content-Length")).toBeNull();
		expect(res.headers.get("Vary")).toContain("Accept-Encoding");
		const body = await bytes(res);
		const plain = JSON.stringify(BIG);
		expect(body.length).toBeLessThan(plain.length / 4);
		expect(JSON.parse(gunzipSync(body).toString())).toEqual(BIG);
	});

	test("falls back to deflate", async () => {
		const res = await createApp().request("/json", {
			headers: { "Accept-Encoding": "deflate" },
		});
		expect(res.headers.get("Content-Encoding")).toBe("deflate");
		expect(JSON.parse(inflateSync(await bytes(res)).toString())).toEqual(BIG);
	});

	test("sends identity without a supported Accept-Encoding", async () => {
		for (const accept of [undefined, "br", "identity"]) {
			const res = await createApp().request("/json", {
				headers: accept ? { "Accept-Encoding": accept } : {},
			});
			expect(res.headers.get("Content-Encoding")).toBeNull();
			expect(res.headers.get("Vary")).toContain("Accept-Encoding");
			expect(await res.json()).toEqual(BIG);
		}
	});

	test("leaves small JSON, media, and event streams untouched", async () => {
		const app = createApp();
		const headers = { "Accept-Encoding": "gzip" };
		const small = await app.request("/small", { headers });
		expect(small.headers.get("Content-Encoding")).toBeNull();
		expect(await small.json()).toEqual({ ok: true });

		const image = await app.request("/image", { headers });
		expect(image.headers.get("Content-Encoding")).toBeNull();
		expect((await bytes(image)).length).toBe(4096);

		const sse = await app.request("/sse", { headers });
		expect(sse.headers.get("Content-Encoding")).toBeNull();
	});

	test("never compresses HEAD responses", async () => {
		const res = await createApp().request("/json", {
			method: "HEAD",
			headers: { "Accept-Encoding": "gzip" },
		});
		expect(res.headers.get("Content-Encoding")).toBeNull();
	});
});
