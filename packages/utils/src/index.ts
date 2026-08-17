/**
 * Format file size in bytes to human-readable format
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Parse a date value that may be an EXIF string ("YYYY:MM:DD HH:MM:SS"),
 * an ISO string, or a Date object (from Drizzle timestamps via superjson).
 * Returns a valid Date, falling back to the Unix epoch for unparseable values.
 * This keeps malformed metadata from sorting as the newest item.
 */
export function parseDate(value: Date | string | null | undefined): Date {
	if (!value) return new Date(0);
	if (value instanceof Date) return value;
	const parsed = new Date(
		value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"),
	);
	return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Format date to readable string
 */
export function formatDate(dateValue: Date | string): string {
	const date = parseDate(dateValue);
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Debounce function for search inputs
 */
export function debounce<Args extends unknown[]>(
	func: (...args: Args) => unknown,
	wait: number,
): (...args: Args) => void {
	let timeout: ReturnType<typeof setTimeout> | null = null;
	return (...args: Args) => {
		if (timeout) clearTimeout(timeout);
		timeout = setTimeout(() => func(...args), wait);
	};
}

// Re-export queue constants and types
export * from "./queues";

// Re-export task types and schemas
export * from "./tasks";
// Re-export thumbnail utilities
export * from "./thumbnails";
