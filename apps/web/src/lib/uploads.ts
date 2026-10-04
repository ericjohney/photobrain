import { config } from "@/lib/config";

/** `GET /api/v1/uploads/config`. */
export interface UploadConfig {
	enabled: boolean;
	maxBytes: number;
	/** Lower-case, with the leading dot (".jpg"). */
	extensions: string[];
}

/** `POST /api/v1/uploads` success body. */
export interface UploadResult {
	status: "created" | "duplicate";
	path: string;
	size: number;
}

/** Every browser upload is attributed to this device name. */
export const WEB_DEVICE_NAME = "Web";

/** Concurrent `POST /api/v1/uploads` requests. */
export const UPLOAD_CONCURRENCY = 2;

const DEVICE_ID_KEY = "photobrain-upload-device-id";

/**
 * This browser's upload `deviceId`: a random UUID created once and kept in
 * localStorage, so idempotency and placement stay stable across reloads.
 */
export function uploadDeviceId(): string {
	try {
		const stored = localStorage.getItem(DEVICE_ID_KEY);
		if (stored) return stored;
		const id = crypto.randomUUID();
		localStorage.setItem(DEVICE_ID_KEY, id);
		return id;
	} catch {
		// Storage unavailable (private mode): stable for this page only.
		return (fallbackDeviceId ??= crypto.randomUUID());
	}
}
let fallbackDeviceId: string | undefined;

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/**
 * Local wall-clock ISO-8601 datetime with the local UTC offset, e.g.
 * `2024-07-04T12:30:15-06:00`, so the server files it under the local month.
 */
export function localIsoWithOffset(ms: number): string {
	const date = new Date(ms);
	const offset = -date.getTimezoneOffset();
	const abs = Math.abs(offset);
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Upload URL for one browser file (no `assetId`/`resource`). */
export function uploadUrl(file: File, deviceId: string): string {
	const params = new URLSearchParams({
		deviceId,
		deviceName: WEB_DEVICE_NAME,
		filename: file.name,
		capturedAt: localIsoWithOffset(file.lastModified),
	});
	return `${config.apiUrl}/api/v1/uploads?${params}`;
}

/** "1.5 MB" (binary units). */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Why a file is refused before uploading, or null when it may be sent. */
export function rejectionReason(
	file: File,
	uploadConfig: UploadConfig,
): string | null {
	const dot = file.name.lastIndexOf(".");
	const extension = dot > 0 ? file.name.slice(dot).toLowerCase() : "";
	if (!uploadConfig.extensions.includes(extension)) {
		return extension
			? `Unsupported file type (${extension})`
			: "Unsupported file type";
	}
	if (file.size > uploadConfig.maxBytes) {
		return `Larger than the ${formatBytes(uploadConfig.maxBytes)} upload limit`;
	}
	return null;
}

const ERROR_MESSAGES: Record<string, string> = {
	UPLOADS_DISABLED: "Uploads are disabled on the server",
	INVALID_REQUEST: "The server rejected the upload request",
	LENGTH_REQUIRED: "The upload size was missing",
	UPLOAD_TOO_LARGE: "Too large for the server",
	UNSUPPORTED_MEDIA: "Unsupported file type",
	INSUFFICIENT_STORAGE: "Not enough storage space on the server",
	UPLOAD_INCOMPLETE: "Upload was interrupted",
	INTERNAL_ERROR: "Server error",
};

/** Codes for statuses answered without the API's JSON (e.g. by a proxy). */
const STATUS_CODES: Record<number, string> = {
	411: "LENGTH_REQUIRED",
	413: "UPLOAD_TOO_LARGE",
	415: "UNSUPPORTED_MEDIA",
	503: "UPLOADS_DISABLED",
	507: "INSUFFICIENT_STORAGE",
};

/** Readable text for a failed upload response. */
export function uploadErrorMessage(status: number, body: unknown): string {
	const error =
		typeof body === "object" && body !== null && "error" in body
			? (body.error as { code?: unknown; message?: unknown } | null)
			: null;
	const code =
		typeof error?.code === "string" ? error.code : STATUS_CODES[status];
	if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
	if (typeof error?.message === "string" && error.message) {
		return error.message;
	}
	return status === 0 ? "Network error" : `Upload failed (HTTP ${status})`;
}
