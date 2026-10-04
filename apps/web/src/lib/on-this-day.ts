/** `YYYY-MM-DD` of `date` in the browser's local time zone (never UTC). */
export function localDateString(date: Date) {
	const year = String(date.getFullYear()).padStart(4, "0");
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Milliseconds from `date` until the next local midnight. */
export function msUntilNextLocalDay(date: Date) {
	const next = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() + 1,
	);
	return next.getTime() - date.getTime();
}

/**
 * Formats a `YYYY-MM-DD` capture date as e.g. "Oct 3, 2023". The date is a
 * wall-clock calendar date, so it is built in local time (no UTC shift).
 */
export function formatCapturedDate(capturedDate: string) {
	const [year, month, day] = capturedDate.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	// Two-digit years would otherwise map to 19xx.
	date.setFullYear(year);
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
