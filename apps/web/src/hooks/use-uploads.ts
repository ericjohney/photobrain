import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "@/lib/config";
import {
	rejectionReason,
	UPLOAD_CONCURRENCY,
	type UploadConfig,
	type UploadResult,
	uploadDeviceId,
	uploadErrorMessage,
	uploadUrl,
} from "@/lib/uploads";

export type UploadStatus =
	| "queued"
	| "uploading"
	| "created"
	| "duplicate"
	| "failed"
	| "rejected"
	| "cancelled";

export interface UploadItem {
	id: number;
	file: File;
	status: UploadStatus;
	/** 0-100 while uploading. */
	progress: number;
	/** Rejection or failure reason. */
	message: string | null;
}

/** Interval of the `/api/v1/scans/active` poll while an import is expected. */
const IMPORT_POLL_MS = 2000;

/** What the dashboard's upload button, drop zone, and queue popover use. */
export interface UploadsApi {
	/** Null until `GET /api/v1/uploads/config` answers (or when it fails). */
	config: UploadConfig | null;
	enabled: boolean;
	items: UploadItem[];
	/** Queues files (rejected ones are listed with their reason). */
	addFiles: (files: Iterable<File>) => void;
	/** Aborts an in-flight upload or drops a queued one. */
	cancel: (id: number) => void;
	/** Removes every item that is no longer queued or uploading. */
	clearFinished: () => void;
	queueOpen: boolean;
	setQueueOpen: (open: boolean) => void;
	/** A file was created and its import scan has not been picked up yet. */
	importPending: boolean;
}

/**
 * Browser uploads: the server's upload config, a concurrency-limited
 * `XMLHttpRequest` queue, and the follow-up import. The API starts a
 * debounced incremental scan after any `created` upload; until it appears in
 * `/api/v1/scans/active`, `importPending` is true. The first such job other
 * than `currentJobId` is handed to `onImportJob`, which tracks it with the
 * existing scan progress (and its library refreshes).
 */
export function useUploads({
	currentJobId,
	onImportJob,
}: {
	currentJobId: string | null;
	onImportJob: (jobId: string) => void;
}): UploadsApi {
	const configQuery = useQuery({
		queryKey: ["uploads", "config"],
		queryFn: async (): Promise<UploadConfig> => {
			const response = await fetch(`${config.apiUrl}/api/v1/uploads/config`);
			if (!response.ok) {
				throw new Error(`Upload config failed (HTTP ${response.status})`);
			}
			return response.json();
		},
		staleTime: 60_000,
	});
	const uploadConfig = configQuery.data ?? null;
	const enabled = uploadConfig?.enabled === true;

	const [items, setItems] = useState<UploadItem[]>([]);
	const [queueOpen, setQueueOpen] = useState(false);
	const nextId = useRef(1);
	const requests = useRef(new Map<number, XMLHttpRequest>());
	// Job running when the last upload was created; its scan may predate the
	// file, so the import waits for a different job.
	const [importAfter, setImportAfter] = useState<{
		skipJobId: string | null;
	} | null>(null);
	const currentJobIdRef = useRef(currentJobId);
	currentJobIdRef.current = currentJobId;

	const update = useCallback((id: number, patch: Partial<UploadItem>) => {
		setItems((current) =>
			current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
		);
	}, []);

	const addFiles = useCallback(
		(files: Iterable<File>) => {
			if (!uploadConfig?.enabled) return;
			const added = Array.from(files, (file): UploadItem => {
				const reason = rejectionReason(file, uploadConfig);
				return {
					id: nextId.current++,
					file,
					status: reason ? "rejected" : "queued",
					progress: 0,
					message: reason,
				};
			});
			if (added.length === 0) return;
			setItems((current) => [...current, ...added]);
			setQueueOpen(true);
		},
		[uploadConfig],
	);

	const start = useCallback(
		(item: UploadItem) => {
			const xhr = new XMLHttpRequest();
			requests.current.set(item.id, xhr);
			const finish = (patch: Partial<UploadItem>) => {
				requests.current.delete(item.id);
				update(item.id, patch);
			};
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable && event.total > 0) {
					update(item.id, {
						progress: Math.min(
							100,
							Math.floor((event.loaded / event.total) * 100),
						),
					});
				}
			};
			xhr.onload = () => {
				let body: unknown = null;
				try {
					body = JSON.parse(xhr.responseText);
				} catch {
					// Non-JSON error body (e.g. from a proxy).
				}
				const result = body as Partial<UploadResult> | null;
				if (
					(xhr.status === 201 || xhr.status === 200) &&
					(result?.status === "created" || result?.status === "duplicate")
				) {
					if (result.status === "created") {
						setImportAfter({ skipJobId: currentJobIdRef.current });
					}
					finish({ status: result.status, progress: 100 });
				} else {
					finish({
						status: "failed",
						message: uploadErrorMessage(xhr.status, body),
					});
				}
			};
			xhr.onerror = () =>
				finish({ status: "failed", message: uploadErrorMessage(0, null) });
			xhr.onabort = () => finish({ status: "cancelled" });
			xhr.open("POST", uploadUrl(item.file, uploadDeviceId()));
			xhr.setRequestHeader("Content-Type", "application/octet-stream");
			xhr.send(item.file);
		},
		[update],
	);

	// Fill free slots in order; the request map (not state) guards against
	// starting an item twice.
	useEffect(() => {
		let running = items.filter((item) => item.status === "uploading").length;
		const starting: UploadItem[] = [];
		for (const item of items) {
			if (running >= UPLOAD_CONCURRENCY) break;
			if (item.status !== "queued" || requests.current.has(item.id)) continue;
			starting.push(item);
			running++;
		}
		if (starting.length === 0) return;
		const ids = new Set(starting.map((item) => item.id));
		setItems((current) =>
			current.map((item) =>
				ids.has(item.id) ? { ...item, status: "uploading" } : item,
			),
		);
		for (const item of starting) start(item);
	}, [items, start]);

	// Abort in-flight uploads when the dashboard unmounts.
	useEffect(() => {
		const active = requests.current;
		return () => {
			for (const xhr of active.values()) xhr.abort();
		};
	}, []);

	const cancel = useCallback(
		(id: number) => {
			const xhr = requests.current.get(id);
			if (xhr) xhr.abort();
			else update(id, { status: "cancelled" });
		},
		[update],
	);

	const clearFinished = useCallback(() => {
		setItems((current) =>
			current.filter(
				(item) => item.status === "queued" || item.status === "uploading",
			),
		);
	}, []);

	const importJobQuery = useQuery({
		queryKey: ["uploads", "import-job", importAfter],
		queryFn: async () => {
			const response = await fetch(`${config.apiUrl}/api/v1/scans/active`);
			if (!response.ok) {
				throw new Error(`Active scans failed (HTTP ${response.status})`);
			}
			const body = (await response.json()) as { jobs: { id: string }[] };
			return (
				body.jobs.find((job) => job.id !== importAfter?.skipJobId)?.id ?? null
			);
		},
		enabled: importAfter !== null,
		refetchInterval: IMPORT_POLL_MS,
		gcTime: 0,
	});
	const importJobId = importAfter ? (importJobQuery.data ?? null) : null;
	const onImportJobRef = useRef(onImportJob);
	onImportJobRef.current = onImportJob;
	useEffect(() => {
		if (!importJobId) return;
		setImportAfter(null);
		onImportJobRef.current(importJobId);
	}, [importJobId]);

	return {
		config: uploadConfig,
		enabled,
		items,
		addFiles,
		cancel,
		clearFinished,
		queueOpen,
		setQueueOpen,
		importPending: importAfter !== null,
	};
}
