import { AsyncResource } from "node:async_hooks";
import { Worker } from "node:worker_threads";
import type * as NativeAddon from "@photobrain/image-processing";
import type { PhotoProcessingResult } from "@photobrain/image-processing";

type NativeOperations = Pick<
	typeof NativeAddon,
	| "discoverPhotos"
	| "processPhotosBatch"
	| "batchGenerateClipEmbeddings"
	| "validateThumbnails"
>;
type Operation = keyof NativeOperations;

type OperationRequest = {
	[K in Operation]: {
		id: number;
		operation: K;
		args: Parameters<NativeOperations[K]>;
	};
}[Operation];

export interface PhotoStreamInput {
	id: number;
	filePath: string;
	relativePath: string;
	thumbnailKey?: string;
}

type WindowResult = { processed: number; done: boolean };
export type NativeRequest =
	| OperationRequest
	| {
			id: number;
			operation: "consumePhotos";
			jobId: string;
			inputs?: PhotoStreamInput[];
			thumbnailsDir: string;
			maxResults: number;
	  }
	| { id: number; operation: "cancelPhotos"; jobId: string }
	| { id: number; operation: "ack"; error?: string }
	| { operation: "close" };

export type NativeResponse =
	| {
			id: number;
			result: ReturnType<NativeOperations[Operation]> | WindowResult | null;
	  }
	| { id: number; error: string }
	| {
			id: number;
			photoId: number;
			photo: PhotoProcessingResult;
			thumbnailKey?: string;
	  }
	| { closed: true };

type Consumer = {
	jobId: string;
	thumbnailsDir: string;
	load: () => PhotoStreamInput[] | Promise<PhotoStreamInput[]>;
	onResult: (
		id: number,
		result: PhotoProcessingResult,
		thumbnailKey?: string,
	) => void | Promise<void>;
	maxResults: number;
};
type Pending = {
	id: number;
	request?:
		| OperationRequest
		| { id: number; operation: "cancelPhotos"; jobId: string };
	consumer?: Consumer;
	acknowledging?: boolean;
	consumerError?: Error;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
};

export const MAX_NATIVE_REQUESTS = 8;
const asError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

// A session outlives checkpoint windows, but only one window/native call is admitted
// to the worker at a time. SQLite persistence always runs on the API thread.
export class NativeExecutor {
	private worker?: Worker;
	private active?: Pending;
	private queue: Pending[] = [];
	private nextId = 0;
	private sessionJobId?: string;
	private sessionThumbnailsDir?: string;
	private closed = false;
	private draining?: Promise<void>;
	private finishDrain?: () => void;

	constructor(
		private readonly workerUrl = new URL("./native-worker.ts", import.meta.url),
	) {}

	run<K extends Operation>(
		operation: K,
		...args: Parameters<NativeOperations[K]>
	): Promise<ReturnType<NativeOperations[K]>> {
		const request = { id: this.nextId++, operation, args } as OperationRequest;
		if (
			request.operation === "processPhotosBatch" &&
			request.args[0].length !== request.args[1].length
		) {
			return Promise.reject(
				new Error("Photo paths and relative paths must align"),
			);
		}
		return this.enqueue({ id: request.id, request });
	}

	consumePhotos(
		jobId: string,
		thumbnailsDir: string,
		load: Consumer["load"],
		onResult: Consumer["onResult"],
		maxResults = 20,
	): Promise<WindowResult> {
		if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
			return Promise.reject(
				new Error("Photo result window must be a positive integer"),
			);
		}
		return this.enqueue({
			id: this.nextId++,
			consumer: {
				jobId,
				thumbnailsDir,
				load: AsyncResource.bind(load),
				// Worker events belong to the worker's async context, not this step.
				onResult: AsyncResource.bind(onResult),
				maxResults,
			},
		});
	}

	cancelPhotos(jobId: string): Promise<void> {
		const id = this.nextId++;
		return this.enqueue({
			id,
			request: { id, operation: "cancelPhotos", jobId },
		});
	}

	private enqueue<T>(pending: Omit<Pending, "resolve" | "reject">): Promise<T> {
		if (this.closed)
			return Promise.reject(new Error("Native executor is closed"));
		if (this.queue.length + Number(!!this.active) >= MAX_NATIVE_REQUESTS) {
			return Promise.reject(
				new Error("Native executor is busy; retry this batch"),
			);
		}
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.queue.push({
			...pending,
			resolve: (result) => resolve(result as T),
			reject,
		});
		this.dispatch();
		return promise;
	}

	private dispatch() {
		if (this.closed || this.draining || this.active || !this.queue.length)
			return;
		const pending = this.queue.shift();
		if (!pending) return;
		this.active = pending;
		void this.start(pending).catch((error) => {
			if (this.active === pending) this.fail(asError(error));
		});
	}

	private async start(pending: Pending) {
		if (!this.worker) {
			const worker = new Worker(this.workerUrl);
			this.worker = worker;
			worker.on("message", (message: NativeResponse) =>
				this.receive(worker, message),
			);
			worker.on("error", (error) => {
				if (this.worker === worker) this.fail(error, true);
			});
			worker.on("exit", (code) => {
				if (this.worker !== worker) return;
				this.worker = undefined;
				this.fail(new Error(`Native worker exited with code ${code}`), true);
			});
		}
		const worker = this.worker;
		worker.ref();
		if (pending.consumer) {
			const { jobId, thumbnailsDir, load, maxResults } = pending.consumer;
			const inputs =
				this.sessionJobId === jobId &&
				this.sessionThumbnailsDir === thumbnailsDir
					? undefined
					: await load();
			if (this.active !== pending || this.worker !== worker) return;
			this.sessionJobId = jobId;
			this.sessionThumbnailsDir = thumbnailsDir;
			worker.postMessage({
				id: pending.id,
				operation: "consumePhotos",
				jobId,
				inputs,
				maxResults,
				thumbnailsDir,
			} satisfies NativeRequest);
		} else {
			if (
				pending.request?.operation !== "cancelPhotos" ||
				pending.request.jobId === this.sessionJobId
			) {
				this.sessionJobId = undefined;
			}
			worker.postMessage(pending.request);
		}
	}

	private receive(worker: Worker, message: NativeResponse) {
		if (this.worker !== worker) return;
		if ("closed" in message) {
			if (!this.draining) {
				this.fail(new Error("Unexpected native worker shutdown"));
				return;
			}
			this.worker = undefined;
			void worker
				.terminate()
				.catch(() => {})
				.finally(() => this.finishDrain?.());
			return;
		}
		if (this.draining) return;
		const pending = this.active;
		if (!pending || message.id !== pending.id) {
			this.fail(new Error("Unexpected native worker response"));
			return;
		}
		if ("photo" in message) {
			if (!pending.consumer || pending.acknowledging) {
				this.fail(new Error("Unexpected native photo result"));
				return;
			}
			pending.acknowledging = true;
			void this.acknowledge(
				worker,
				pending,
				message.photoId,
				message.photo,
				message.thumbnailKey,
			);
			return;
		}
		if (pending.acknowledging) {
			this.fail(new Error("Native worker completed before photo persistence"));
			return;
		}
		this.active = undefined;
		if ("error" in message) {
			this.sessionJobId = undefined;
			pending.reject(pending.consumerError ?? new Error(message.error));
		} else {
			if (pending.consumer && (message.result as WindowResult).done)
				this.sessionJobId = undefined;
			pending.resolve(message.result);
		}
		if (this.queue.length) this.dispatch();
		else worker.unref();
	}

	private async acknowledge(
		worker: Worker,
		pending: Pending,
		id: number,
		result: PhotoProcessingResult,
		thumbnailKey?: string,
	) {
		try {
			await pending.consumer?.onResult(id, result, thumbnailKey);
		} catch (error) {
			pending.consumerError = asError(error);
		}
		pending.acknowledging = false;
		if (this.worker !== worker || this.active !== pending || this.draining)
			return;
		try {
			worker.postMessage({
				id: pending.id,
				operation: "ack",
				error: pending.consumerError?.message,
			} satisfies NativeRequest);
		} catch (error) {
			this.fail(asError(error));
		}
	}

	private rejectPending(error: Error) {
		this.sessionJobId = undefined;
		const pending = this.active ? [this.active, ...this.queue] : this.queue;
		this.active = undefined;
		this.queue = [];
		for (const request of pending) request.reject(error);
	}

	private fail(error: Error, dead = false) {
		this.rejectPending(error);
		if (dead && !this.worker) {
			this.finishDrain?.();
			return;
		}
		void this.drain(dead);
	}

	private drain(terminate = false): Promise<void> {
		if (this.draining && !terminate) return this.draining;
		const worker = this.worker;
		if (!worker) return this.draining ?? Promise.resolve();
		if (!this.draining) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.draining = promise;
			this.finishDrain = () => {
				this.finishDrain = undefined;
				this.draining = undefined;
				resolve();
				this.dispatch();
			};
		}
		const drained = this.draining;
		worker.ref();
		if (terminate) {
			this.worker = undefined;
			void worker
				.terminate()
				.catch(() => {})
				.finally(() => this.finishDrain?.());
			return drained;
		}
		try {
			worker.postMessage({ operation: "close" } satisfies NativeRequest);
		} catch {
			this.worker = undefined;
			void worker
				.terminate()
				.catch(() => {})
				.finally(() => this.finishDrain?.());
		}
		return drained;
	}

	close(): Promise<void> {
		this.closed = true;
		this.rejectPending(new Error("Native executor is closed"));
		return this.drain();
	}
}

export const nativeExecutor = new NativeExecutor();
