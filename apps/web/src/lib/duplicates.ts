import type { DuplicateKind } from "./types";

/** Groups loaded per page; "Load more" requests the next page by cursor. */
export const DUPLICATE_PAGE_SIZE = 50;

export const DUPLICATE_KIND_LABELS: Record<DuplicateKind, string> = {
	duplicate: "Duplicates",
	burst: "Bursts",
};

/**
 * Capture time without timezone conversion: EXIF `YYYY:MM:DD HH:MM:SS` (or an
 * ISO-like value) becomes `YYYY-MM-DD HH:MM:SS`; anything else is shown as is.
 */
export function formatCaptureTime(dateTaken: string) {
	const match = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(
		dateTaken,
	);
	return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}` : dateTaken;
}
