import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PhotoStreamInput } from "../services/native-executor";
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

function inputs(count: number): PhotoStreamInput[] {
	return Array.from({ length: count }, (_, index) => ({
		id: 100 + index,
		filePath: `file-${index}`,
		relativePath: `photo-${index}.jpg`,
	}));
}

describe("continuous photo consumption", () => {
	test("reuses one native session across completion windows without waiting for an earlier slow input", async () => {
		const pending = inputs(41);
		pending[0].filePath = "slow";
		let loads = 0;
		const load = () => {
			loads++;
			return pending;
		};
		const ids: number[] = [];
		const generations: string[] = [];
		const commit = (id: number, result: { path: string; name: string }) => {
			expect(result.path).toBe(pending[id - 100].relativePath);
			ids.push(id);
			generations.push(result.name);
		};
		expect(
			await executor.consumePhotos("job", "/thumbs", load, commit),
		).toEqual({ processed: 20, done: false });
		expect(ids).toEqual(pending.slice(1, 21).map((item) => item.id));
		expect(
			await executor.consumePhotos("job", "/thumbs", load, commit),
		).toEqual({ processed: 20, done: false });
		expect(ids).toEqual(pending.slice(1).map((item) => item.id));
		expect(
			await executor.consumePhotos("job", "/thumbs", load, commit),
		).toEqual({ processed: 1, done: true });
		expect(ids.at(-1)).toBe(pending[0].id);
		expect(loads).toBe(1);
		expect(new Set(generations)).toEqual(new Set(["1:/thumbs"]));
	});

	test("preserves each checkpoint's async context across worker completion callbacks", async () => {
		await executor.run("discoverPhotos", "warmup");
		const context = new AsyncLocalStorage<string>();
		const contexts: (string | undefined)[] = [];
		for (const checkpoint of ["first-step", "second-step"]) {
			await context.run(checkpoint, () =>
				executor.consumePhotos(
					"job",
					"/thumbs",
					() => {
						expect(context.getStore()).toBe("first-step");
						return inputs(2);
					},
					() => {
						contexts.push(context.getStore());
					},
					1,
				),
			);
		}
		expect(contexts).toEqual(["first-step", "second-step"]);
	});

	test("allows only one result awaiting persistence and does not finish its window before commit", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ids: number[] = [];
		let completed = false;
		const window = executor
			.consumePhotos(
				"job",
				"/thumbs",
				() => inputs(3),
				async (id) => {
					ids.push(id);
					if (ids.length === 1) {
						entered.resolve();
						await release.promise;
					}
				},
			)
			.then((result) => {
				completed = true;
				return result;
			});
		await entered.promise;
		try {
			// This integration check needs the real worker to run while its API
			// callback is blocked; parent fake timers do not drive worker messages.
			await Bun.sleep(30);
			expect(ids).toEqual([100]);
			expect(completed).toBe(false);
		} finally {
			release.resolve();
		}
		expect(await window).toEqual({ processed: 3, done: true });
		const state = JSON.parse(
			(await executor.run("discoverPhotos", "stream-state")).filePaths[0],
		);
		expect(state).toEqual({
			streamsStarted: 1,
			streamsClosed: 1,
			streamsActive: 0,
			pulls: 3,
		});
	});

	test("consumer failure drains writers and reloads only durable pending receipts", async () => {
		const pending = inputs(4);
		const committed = new Set<number>();
		let loads = 0;
		const load = () => {
			loads++;
			return pending.filter((item) => !committed.has(item.id));
		};
		await expect(
			executor.consumePhotos("job", "/thumbs", load, (id) => {
				if (id === 101) throw new Error("database rolled back");
				committed.add(id);
			}),
		).rejects.toThrow("database rolled back");
		const retryIds: number[] = [];
		const generations: string[] = [];
		expect(
			await executor.consumePhotos("job", "/thumbs", load, (id, result) => {
				retryIds.push(id);
				generations.push(result.name);
				committed.add(id);
			}),
		).toEqual({ processed: 3, done: true });
		expect(retryIds).toEqual([101, 102, 103]);
		expect(generations).toEqual(["2:/thumbs", "2:/thumbs", "2:/thumbs"]);
		expect(loads).toBe(2);
	});

	test.each([
		"job",
		"destination",
	])("switching %s drains old writers before starting another session", async (change) => {
		await executor.consumePhotos(
			"first",
			"/thumbs",
			() => inputs(30),
			() => {},
			1,
		);
		const names: string[] = [];
		await executor.consumePhotos(
			change === "job" ? "second" : "first",
			change === "destination" ? "/other" : "/thumbs",
			() => inputs(2),
			(_id, result) => {
				names.push(result.name);
			},
		);
		expect(names).toEqual(
			change === "job" ? ["2:/thumbs", "2:/thumbs"] : ["2:/other", "2:/other"],
		);
		const state = JSON.parse(
			(await executor.run("discoverPhotos", "stream-state")).filePaths[0],
		);
		expect(state.streamsClosed).toBe(2);
		expect(state.streamsActive).toBe(0);
	});

	test("ordinary native work drains an idle full stream and its next window reloads", async () => {
		let loads = 0;
		const load = () => {
			loads++;
			return inputs(30);
		};
		await executor.consumePhotos("job", "/thumbs", load, () => {}, 1);
		const state = JSON.parse(
			(await executor.run("discoverPhotos", "stream-state")).filePaths[0],
		);
		expect(state).toEqual({
			streamsStarted: 1,
			streamsClosed: 1,
			streamsActive: 0,
			pulls: 1,
		});
		const names: string[] = [];
		await executor.consumePhotos(
			"job",
			"/thumbs",
			load,
			(_id, result) => {
				names.push(result.name);
			},
			1,
		);
		expect(names).toEqual(["2:/thumbs"]);
		expect(loads).toBe(2);
	});

	test("cancel drains a matching session but preserves an unrelated session", async () => {
		let loads = 0;
		const load = () => {
			loads++;
			return inputs(30);
		};
		const names: string[] = [];
		const commit = (_id: number, result: { name: string }) => {
			names.push(result.name);
		};
		await executor.consumePhotos("job", "/thumbs", load, commit, 1);
		await executor.cancelPhotos("unrelated");
		await executor.consumePhotos("job", "/thumbs", load, commit, 1);
		expect(loads).toBe(1);
		await executor.cancelPhotos("job");
		await executor.consumePhotos("job", "/thumbs", load, commit, 1);
		expect(loads).toBe(2);
		expect(names).toEqual(["1:/thumbs", "1:/thumbs", "2:/thumbs"]);
	});

	test.each([
		"next-error",
		"early-end",
		"duplicate",
		"invalid-index",
	])("%s rejects instead of acknowledging missing or repeated receipts", async (failure) => {
		const pending = inputs(3);
		pending[0].filePath = failure;
		const ids: number[] = [];
		await expect(
			executor.consumePhotos(
				"job",
				"/thumbs",
				() => pending,
				(id) => {
					ids.push(id);
				},
			),
		).rejects.toThrow();
		expect(ids).toEqual(failure === "duplicate" ? [100] : []);
		const state = JSON.parse(
			(await executor.run("discoverPhotos", "stream-state")).filePaths[0],
		);
		expect(state.streamsActive).toBe(0);
		expect(state.streamsClosed).toBe(1);
		expect(
			await executor.consumePhotos(
				"job",
				"/thumbs",
				() => inputs(1),
				() => {},
			),
		).toEqual({ processed: 1, done: true });
	});

	test("worker death rejects active and queued windows and recreates session state", async () => {
		const pending = inputs(2);
		pending[0].filePath = "stream-crash";
		const attempts = await Promise.allSettled([
			executor.consumePhotos(
				"job",
				"/thumbs",
				() => pending,
				() => {},
			),
			executor.consumePhotos(
				"job",
				"/thumbs",
				() => pending,
				() => {},
			),
		]);
		expect(attempts.map((result) => result.status)).toEqual([
			"rejected",
			"rejected",
		]);
		const ids: number[] = [];
		expect(
			await executor.consumePhotos(
				"job",
				"/thumbs",
				() => inputs(2),
				(id) => {
					ids.push(id);
				},
			),
		).toEqual({ processed: 2, done: true });
		expect(ids).toEqual([100, 101]);
	});

	test("close drains an idle full stream and is awaitable and idempotent", async () => {
		await executor.consumePhotos(
			"job",
			"/thumbs",
			() => inputs(30),
			() => {},
			1,
		);
		await Promise.all([executor.close(), executor.close()]);
		await expect(
			executor.consumePhotos(
				"job",
				"/thumbs",
				() => inputs(1),
				() => {},
			),
		).rejects.toThrow("closed");
	});

	test("close during persistence releases worker ACK waits without late callbacks or queued work", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ids: number[] = [];
		const outcomes = Promise.allSettled([
			executor.consumePhotos(
				"job",
				"/thumbs",
				() => inputs(30),
				async (id) => {
					ids.push(id);
					entered.resolve();
					await release.promise;
				},
			),
			executor.run("discoverPhotos", "queued"),
		]);
		await entered.promise;
		try {
			await executor.close();
			expect((await outcomes).map((result) => result.status)).toEqual([
				"rejected",
				"rejected",
			]);
		} finally {
			release.resolve();
		}
		expect(ids).toEqual([100]);
	});

	test("rejects invalid output windows without loading inputs", async () => {
		let loaded = false;
		await expect(
			executor.consumePhotos(
				"job",
				"/thumbs",
				() => {
					loaded = true;
					return [];
				},
				() => {},
				0,
			),
		).rejects.toThrow("positive integer");
		expect(loaded).toBe(false);
	});

	test("an empty durable pending load completes without pulling a result", async () => {
		expect(
			await executor.consumePhotos(
				"empty",
				"/thumbs",
				() => [],
				() => {
					throw new Error("unexpected receipt");
				},
			),
		).toEqual({ processed: 0, done: true });
		const state = JSON.parse(
			(await executor.run("discoverPhotos", "stream-state")).filePaths[0],
		);
		expect(state).toEqual({
			streamsStarted: 1,
			streamsClosed: 1,
			streamsActive: 0,
			pulls: 0,
		});
	});
});
