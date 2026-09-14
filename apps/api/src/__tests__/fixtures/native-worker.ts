import { mock } from "bun:test";
import { parentPort } from "node:worker_threads";

let sequence = 0;
// Replace only the addon. Requests, dispatch, responses, and exception handling use
// the production worker entrypoint, in a separate module registry from API tests.
mock.module("@photobrain/image-processing", () => ({
	discoverPhotos(directory: string) {
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
			filePaths: [directory],
			relativePaths: [String(started), String(Date.now())],
			totalCount: ++sequence,
		};
	},
	processPhotosBatch(
		_paths: string[],
		relativePaths: string[],
		_thumbnailsDir: string,
	) {
		return relativePaths.map((path) => ({
			path,
			name: path,
			size: 1,
			createdAt: 0,
			modifiedAt: 0,
			isRaw: path.endsWith(".arw"),
			success: true,
		}));
	},
	batchGenerateClipEmbeddings(paths: string[]) {
		return paths.map((path, index) =>
			path === "missing" ? null : [index + 0.25, -0.5],
		);
	},
}));

await import("../../services/native-worker");
