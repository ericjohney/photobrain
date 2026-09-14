import { Worker } from "node:worker_threads";

type NativeOperations = Pick<
	typeof import("@photobrain/image-processing"),
	"discoverPhotos" | "processPhotosBatch" | "batchGenerateClipEmbeddings"
>;
type Operation = keyof NativeOperations;

export type NativeRequest = {
	[K in Operation]: {
		id: number;
		operation: K;
		args: Parameters<NativeOperations[K]>;
	};
}[Operation];

export type NativeResponse =
	| { id: number; result: ReturnType<NativeOperations[Operation]> }
	| { id: number; error: string };

type Pending = {
	request: NativeRequest;
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
};

export const MAX_NATIVE_REQUESTS = 8;

// One persistent thread shares the native pool and CLIP cache across import batches.
// SQLite writes and Inngest checkpoints stay on the API thread.
export class NativeExecutor {
	private worker?: Worker;
	private active?: Pending;
	private queue: Pending[] = [];
	private nextId = 0;
	private closed = false;

	constructor(
		private readonly workerUrl = new URL("./native-worker.ts", import.meta.url),
	) {}

	run<K extends Operation>(
		operation: K,
		...args: Parameters<NativeOperations[K]>
	): Promise<ReturnType<NativeOperations[K]>> {
		if (this.closed)
			return Promise.reject(new Error("Native executor is closed"));
		if (this.queue.length + Number(!!this.active) >= MAX_NATIVE_REQUESTS) {
			return Promise.reject(
				new Error("Native executor is busy; retry this batch"),
			);
		}
		const request = { id: this.nextId++, operation, args } as NativeRequest;
		if (
			request.operation === "processPhotosBatch" &&
			request.args[0].length !== request.args[1].length
		) {
			return Promise.reject(
				new Error("Photo paths and relative paths must align"),
			);
		}
		return new Promise((resolve, reject) => {
			this.queue.push({
				request,
				resolve: (result) => resolve(result as ReturnType<NativeOperations[K]>),
				reject,
			});
			this.dispatch();
		});
	}

	private dispatch() {
		if (this.active || !this.queue.length) return;
		try {
			if (!this.worker) {
				const worker = new Worker(this.workerUrl);
				this.worker = worker;
				worker.on("message", (message: NativeResponse) => {
					if (this.worker !== worker) return;
					const pending = this.active;
					if (!pending || message.id !== pending.request.id) {
						this.fail(new Error("Unexpected native worker response"));
						return;
					}
					this.active = undefined;
					if ("error" in message) pending.reject(new Error(message.error));
					else pending.resolve(message.result);
					if (this.queue.length) this.dispatch();
					else worker.unref();
				});
				worker.on("error", (error) => {
					if (this.worker === worker) this.fail(error);
				});
				worker.on("exit", (code) => {
					if (this.worker === worker) {
						this.fail(new Error(`Native worker exited with code ${code}`));
					}
				});
			}
			this.active = this.queue.shift();
			this.worker.ref();
			this.worker.postMessage(this.active?.request);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private fail(error: Error) {
		const worker = this.worker;
		this.worker = undefined;
		const pending = this.active ? [this.active, ...this.queue] : this.queue;
		this.active = undefined;
		this.queue = [];
		for (const request of pending) request.reject(error);
		// Never silently repeat native writes. Inngest owns retries after a failure.
		void worker?.terminate().catch(() => {});
	}

	close() {
		this.closed = true;
		this.fail(new Error("Native executor is closed"));
	}
}

export const nativeExecutor = new NativeExecutor();
