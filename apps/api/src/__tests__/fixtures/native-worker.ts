import { mock } from "bun:test";
import { parentPort } from "node:worker_threads";
import type { PhotoProcessingResult } from "@photobrain/image-processing";

let sequence = 0;
let streamsStarted = 0;
let streamsClosed = 0;
let streamsActive = 0;
let pulls = 0;

function photoResult(path: string, name = path): PhotoProcessingResult {
	return {
		path,
		name,
		size: 1,
		createdAt: 0,
		modifiedAt: 0,
		isRaw: path.endsWith(".arw"),
		success: true,
	};
}

// Replace only the addon. Requests, dispatch, responses, and exception handling use
// the production worker entrypoint, in a separate module registry from API tests.
mock.module("@photobrain/image-processing", () => ({
	discoverPhotos(directory: string) {
		if (streamsActive)
			throw new Error("Native operation overlapped active stream writers");
		if (directory === "exit") process.exit(0);
		if (directory === "crash") process.exit(1);
		if (directory === "throw") throw new Error("native operation failed");
		if (directory === "wrong-id")
			parentPort?.postMessage({ id: -1, result: [] });
		const started = Date.now();
		if (directory === "busy") {
			while (Date.now() - started < 150) {
				// Deliberately block this thread, just like a synchronous native call.
			}
		}
		return {
			filePaths:
				directory === "stream-state"
					? [
							JSON.stringify({
								streamsStarted,
								streamsClosed,
								streamsActive,
								pulls,
							}),
						]
					: [directory],
			relativePaths: [String(started), String(Date.now())],
			totalCount: ++sequence,
		};
	},
	processPhotosBatch(
		_paths: string[],
		relativePaths: string[],
		_thumbnailsDir: string,
	) {
		if (streamsActive)
			throw new Error("Native operation overlapped active stream writers");
		return relativePaths.map((path) => photoResult(path));
	},
	batchGenerateClipEmbeddings(paths: string[]) {
		if (streamsActive)
			throw new Error("Native operation overlapped active stream writers");
		return paths.map((path, index) =>
			path === "missing" ? null : [index + 0.25, -0.5],
		);
	},
	startPhotoProcessing(
		filePaths: string[],
		relativePaths: string[],
		thumbnailsDir: string,
	) {
		if (streamsActive)
			throw new Error("New stream overlapped previous native writers");
		if (filePaths.length !== relativePaths.length)
			throw new Error("paths must align");
		const generation = ++streamsStarted;
		streamsActive++;
		// Four buffered completions refill independently of output windows; slow
		// inputs finish last, not at an input-batch boundary. Real worker timers
		// model native production: parent fake timers cannot drive this event loop.
		const order = filePaths
			.map((_, index) => index)
			.sort(
				(a, b) =>
					Number(filePaths[a] === "slow") - Number(filePaths[b] === "slow"),
			);
		const buffer: { index: number; result: PhotoProcessingResult }[] = [];
		let cursor = 0;
		let closed = false;
		let closing: Promise<void> | undefined;
		let wake: (() => void) | undefined;
		let localPulls = 0;
		const produced = Date.now();
		function produce() {
			while (!closed && buffer.length < 4 && cursor < order.length) {
				const index = order[cursor];
				if (filePaths[index] === "slow" && Date.now() - produced < 250) break;
				cursor++;
				buffer.push({
					index,
					result: photoResult(
						relativePaths[index],
						`${generation}:${thumbnailsDir}`,
					),
				});
			}
			if (buffer.length) {
				wake?.();
				wake = undefined;
			}
		}
		const producer = setInterval(produce, 1);
		return {
			async next() {
				pulls++;
				localPulls++;
				if (filePaths.includes("stream-crash")) process.exit(1);
				if (filePaths.includes("next-error"))
					throw new Error("native stream failed");
				if (filePaths.includes("early-end")) return null;
				if (filePaths.includes("duplicate") && localPulls > 1)
					return { index: 0, result: photoResult(relativePaths[0]) };
				if (filePaths.includes("invalid-index"))
					return { index: filePaths.length, result: photoResult("invalid") };
				while (!closed && !buffer.length && cursor < order.length) {
					const ready = Promise.withResolvers<void>();
					wake = ready.resolve;
					await ready.promise;
				}
				const result = closed ? null : (buffer.shift() ?? null);
				// Refill before returning so every paused, non-final window has a
				// deterministically full buffer, without parent-thread timing guesses.
				produce();
				return result;
			},
			close() {
				if (closing) return closing;
				closed = true;
				clearInterval(producer);
				wake?.();
				wake = undefined;
				const drained = Promise.withResolvers<void>();
				closing = drained.promise;
				setTimeout(() => {
					buffer.length = 0;
					streamsActive--;
					streamsClosed++;
					drained.resolve();
				}, 15);
				return closing;
			},
		};
	},
}));

// Install the addon mock before evaluating the production worker module.
await import("../../services/native-worker");
