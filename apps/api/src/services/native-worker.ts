import { parentPort } from "node:worker_threads";
import type { PhotoProcessingStream } from "@photobrain/image-processing";
import {
	batchGenerateClipEmbeddings,
	discoverPhotos,
	processPhotosBatch,
	startPhotoProcessing,
	validateThumbnails,
} from "@photobrain/image-processing";
import type {
	NativeRequest,
	NativeResponse,
	PhotoStreamInput,
} from "./native-executor";

if (!parentPort) throw new Error("Native worker requires a parent port");
const port = parentPort;

type Session = {
	jobId: string;
	thumbnailsDir: string;
	inputs: (PhotoStreamInput | undefined)[];
	stream: PhotoProcessingStream;
	remaining: number;
	closing?: Promise<void>;
};
let session: Session | undefined;
let active: Promise<void> | undefined;
let shuttingDown = false;
let acknowledgement:
	| { id: number; resolve: () => void; reject: (error: Error) => void }
	| undefined;

async function closeSession() {
	const current = session;
	if (!current) return;
	current.closing ??= current.stream.close();
	await current.closing;
	if (session === current) session = undefined;
}

async function execute(
	request: Exclude<NativeRequest, { operation: "ack" | "close" }>,
) {
	let response: NativeResponse;
	try {
		if (request.operation === "consumePhotos") {
			if (
				!session ||
				session.jobId !== request.jobId ||
				session.thumbnailsDir !== request.thumbnailsDir
			) {
				await closeSession();
				if (shuttingDown) return;
				if (!request.inputs)
					throw new Error("Photo session requires pending inputs");
				const inputs = request.inputs;
				session = {
					jobId: request.jobId,
					thumbnailsDir: request.thumbnailsDir,
					inputs,
					remaining: inputs.length,
					stream: startPhotoProcessing(
						inputs.map((input) => input.filePath),
						inputs.map((input) => input.relativePath),
						request.thumbnailsDir,
						inputs.map((input) => input.thumbnailKey ?? input.relativePath),
					),
				};
			}
			const current = session;
			let processed = 0;
			while (
				processed < request.maxResults &&
				current.remaining > 0 &&
				!shuttingDown
			) {
				const photo = await current.stream.next();
				if (shuttingDown) return;
				if (!photo)
					throw new Error("Photo stream ended before all inputs completed");
				const input = current.inputs[photo.index];
				if (!Number.isSafeInteger(photo.index) || !input)
					throw new Error("Photo stream returned an invalid input index");
				const ack = Promise.withResolvers<void>();
				acknowledgement = {
					id: request.id,
					resolve: ack.resolve,
					reject: ack.reject,
				};
				port.postMessage({
					id: request.id,
					photoId: input.id,
					photo: photo.result,
					thumbnailKey: input.thumbnailKey,
				} satisfies NativeResponse);
				await ack.promise;
				current.inputs[photo.index] = undefined;
				processed++;
				current.remaining--;
			}
			const done = current.remaining === 0;
			if (done) await closeSession();
			response = { id: request.id, result: { processed, done } };
		} else if (request.operation === "cancelPhotos") {
			if (session?.jobId === request.jobId) await closeSession();
			response = { id: request.id, result: null };
		} else {
			// An idle stream can fill its native result queue. Drain it before running
			// any synchronous native operation that may need the same native pool.
			await closeSession();
			if (shuttingDown) return;
			switch (request.operation) {
				case "discoverPhotos":
					response = {
						id: request.id,
						result: discoverPhotos(...request.args),
					};
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
				case "validateThumbnails":
					response = {
						id: request.id,
						result: validateThumbnails(...request.args),
					};
					break;
			}
		}
	} catch (error) {
		await closeSession();
		response = {
			id: request.id,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (!shuttingDown) port.postMessage(response);
}

async function shutdown() {
	shuttingDown = true;
	acknowledgement?.reject(new Error("Native executor is closed"));
	acknowledgement = undefined;
	// close() must also unblock next() and a producer blocked on its full queue.
	await closeSession();
	await active;
	port.postMessage({ closed: true } satisfies NativeResponse);
}

port.on("message", (request: NativeRequest) => {
	if (request.operation === "close") {
		if (!shuttingDown)
			void shutdown().catch((error) => {
				queueMicrotask(() => {
					throw error;
				});
			});
		return;
	}
	if (shuttingDown) return;
	if (request.operation === "ack") {
		const ack = acknowledgement;
		if (!ack || ack.id !== request.id)
			throw new Error("Unexpected photo persistence acknowledgement");
		acknowledgement = undefined;
		if (request.error !== undefined) ack.reject(new Error(request.error));
		else ack.resolve();
		return;
	}
	if (active) throw new Error("Native worker received overlapping operations");
	active = execute(request).finally(() => {
		active = undefined;
	});
	// Unexpected infrastructure/close failures must reach the worker error handler,
	// not leave a request pending or an unobserved rejection behind.
	void active.catch((error) => {
		queueMicrotask(() => {
			throw error;
		});
	});
});
