import { parentPort } from "node:worker_threads";
import {
	batchGenerateClipEmbeddings,
	discoverPhotos,
	processPhotosBatch,
} from "@photobrain/image-processing";
import type { NativeRequest, NativeResponse } from "./native-executor";

if (!parentPort) throw new Error("Native worker requires a parent port");

parentPort.on("message", (request: NativeRequest) => {
	let response: NativeResponse;
	try {
		switch (request.operation) {
			case "discoverPhotos":
				response = { id: request.id, result: discoverPhotos(...request.args) };
				break;
			case "processPhotosBatch":
				response = {
					id: request.id,
					result: processPhotosBatch(...request.args),
				};
				break;
			case "batchGenerateClipEmbeddings":
				response = {
					id: request.id,
					result: batchGenerateClipEmbeddings(...request.args),
				};
				break;
		}
	} catch (error) {
		response = {
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	parentPort?.postMessage(response);
});
