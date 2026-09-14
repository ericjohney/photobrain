import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	MAX_NATIVE_REQUESTS,
	NativeExecutor,
} from "../services/native-executor";

let executor: NativeExecutor;
beforeEach(() => {
	executor = new NativeExecutor(
		new URL("./fixtures/native-worker.ts", import.meta.url),
	);
});
afterEach(() => executor.close());

describe("off-thread native execution", () => {
	test("reuses a worker, preserves FIFO order and native result shapes", async () => {
		const first = executor.run("discoverPhotos", "/photos");
		const second = executor.run("discoverPhotos", "/next");
		expect((await first).totalCount).toBe(1);
		expect((await second).totalCount).toBe(2);
		const results = await executor.run(
			"processPhotosBatch",
			["a", "b", "c"],
			["a.jpg", "b.arw", "c.heic"],
			"/thumbnails",
		);
		expect(results.map((result) => result.path)).toEqual([
			"a.jpg",
			"b.arw",
			"c.heic",
		]);
		expect(results[1].isRaw).toBe(true);
		expect(
			await executor.run("batchGenerateClipEmbeddings", ["a", "missing", "b"]),
		).toEqual([[0.25, -0.5], null, [2.25, -0.5]]);
	});

	test("API timers run during a blocking operation, not just during worker startup", async () => {
		await executor.run("discoverPhotos", "warmup");
		const ticks: number[] = [];
		const timer = setInterval(() => ticks.push(Date.now()), 5);
		try {
			const result = await executor.run("discoverPhotos", "busy");
			const [started, finished] = result.relativePaths.map(Number);
			expect(ticks.some((time) => time > started && time < finished)).toBe(
				true,
			);
		} finally {
			clearInterval(timer);
		}
	});

	test("rejects overload rather than building an unbounded queue", async () => {
		const work = Array.from({ length: MAX_NATIVE_REQUESTS }, (_, index) =>
			executor.run("discoverPhotos", index === 0 ? "busy" : String(index)),
		);
		await expect(executor.run("discoverPhotos", "overflow")).rejects.toThrow(
			"busy",
		);
		const results = await Promise.all(work);
		expect(results.map((result) => result.totalCount)).toEqual(
			Array.from({ length: MAX_NATIVE_REQUESTS }, (_, i) => i + 1),
		);
		expect((await executor.run("discoverPhotos", "later")).totalCount).toBe(
			MAX_NATIVE_REQUESTS + 1,
		);
	});

	test("a native exception rejects only that operation", async () => {
		const failed = executor.run("discoverPhotos", "throw");
		const next = executor.run("discoverPhotos", "next");
		await expect(failed).rejects.toThrow("native operation failed");
		expect((await next).totalCount).toBe(1);
	});

	test.each([
		"exit",
		"crash",
		"wrong-id",
	])("%s rejects outstanding work and a later call starts a fresh worker", async (failure) => {
		const results = await Promise.allSettled([
			executor.run("discoverPhotos", failure),
			executor.run("discoverPhotos", "queued"),
		]);
		expect(results.map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		expect((await executor.run("discoverPhotos", "recovery")).totalCount).toBe(
			1,
		);
	});

	test("worker startup errors reject rather than leaving a batch pending", async () => {
		const missing = new NativeExecutor(
			new URL("./fixtures/missing-worker.ts", import.meta.url),
		);
		try {
			await expect(missing.run("discoverPhotos", "photos")).rejects.toThrow();
		} finally {
			missing.close();
		}
	});

	test("rejects mismatched paths before invoking native code", async () => {
		await expect(
			executor.run("processPhotosBatch", ["a"], [], "/thumbnails"),
		).rejects.toThrow("must align");
		expect((await executor.run("discoverPhotos", "first")).totalCount).toBe(1);
	});

	test("closing rejects running and queued requests and prevents restart", async () => {
		const results = Promise.allSettled([
			executor.run("discoverPhotos", "busy"),
			executor.run("discoverPhotos", "queued"),
		]);
		executor.close();
		expect((await results).map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		await expect(executor.run("discoverPhotos", "closed")).rejects.toThrow(
			"closed",
		);
	});

	test.each([
		"idle",
		"close",
	])("%s workers do not keep a subprocess alive", async (mode) => {
		const child = Bun.spawn(
			[
				process.execPath,
				new URL("./fixtures/native-executor-lifecycle.ts", import.meta.url)
					.pathname,
				mode,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const timeout = setTimeout(() => child.kill(), 3000);
		try {
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ code, stdout, stderr }).toEqual({
				code: 0,
				stdout: "finished\n",
				stderr: "",
			});
		} finally {
			clearTimeout(timeout);
			child.kill();
		}
	});
});
