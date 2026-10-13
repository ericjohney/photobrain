import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createTestDb } from "./setup";

if (process.env.PHOTOBRAIN_RAW_TEST_CHILD !== "1") {
	test("on-demand RAW development route", async () => {
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
			env: { ...process.env, PHOTOBRAIN_RAW_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (code) throw new Error(`${out}\n${err}`);
	});
} else {
	const { db, sqlite } = createTestDb();
	const root = mkdtempSync(join(tmpdir(), "raw-loupe-"));
	writeFileSync(join(root, "pair.ARW"), "raw");
	writeFileSync(join(root, "solo.RAF"), "raw");
	const calls: string[] = [];
	class RawDevelopError extends Error {
		constructor(
			message: string,
			public status: number,
		) {
			super(message);
		}
	}
	mock.module("../db", () => ({ db }));
	mock.module("../config", () => ({
		config: { PHOTO_DIRECTORY: "/wrong-root" },
	}));
	mock.module("../services/raw-develop", () => ({
		RawDevelopError,
		developRaw: async (path: string) => {
			calls.push(path);
			return Buffer.from([255, 216, 255, 217]);
		},
	}));
	const { default: router } = await import("../routes/photos");
	const app = new Hono().route("/api/photos", router);
	sqlite.run(
		"INSERT INTO photos (id,path,name,is_raw,source_root,size,created_at,modified_at) VALUES (1,'pair.jpg','pair.jpg',0,?,1,0,0), (2,'pair.ARW','pair.ARW',1,?,1,0,0), (3,'solo.RAF','solo.RAF',1,?,1,0,0), (4,'plain.jpg','plain.jpg',0,?,1,0,0), (5,'gone.RAF','gone.RAF',1,?,1,0,0)",
		[root, root, root, root, root],
	);
	test("develops a stacked JPEG's RAW partner and an unpaired RAW from committed roots", async () => {
		for (const id of [1, 3]) {
			const response = await app.request(`/api/photos/${id}/developed`);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toBe("image/jpeg");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				new Uint8Array([255, 216, 255, 217]),
			);
		}
		expect(calls).toEqual([join(root, "pair.ARW"), join(root, "solo.RAF")]);
	});
	test("rejects invalid IDs, non-RAW photos and missing originals without developing", async () => {
		const count = calls.length;
		for (const [id, status] of [
			["1junk", 400],
			["0", 400],
			["999", 404],
			["4", 422],
			["5", 404],
		] as const) {
			expect((await app.request(`/api/photos/${id}/developed`)).status).toBe(
				status,
			);
		}
		expect(calls.length).toBe(count);
		rmSync(root, { recursive: true });
		sqlite.close();
	});
}
