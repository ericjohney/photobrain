import type { JunkReason } from "./types";

/** Review reasons in the API's classification order (first = grid badge). */
export const JUNK_REASONS = [
	"screenshot",
	"document",
	"blurry",
	"dark",
] as const satisfies readonly JunkReason[];

export const JUNK_REASON_LABELS: Record<JunkReason, string> = {
	screenshot: "Screenshots",
	document: "Documents",
	blurry: "Blurry",
	dark: "Too dark",
};

/** Candidates loaded per review list; resolving photos refills it from the server. */
export const REVIEW_PAGE_SIZE = 200;

/** Bulk rejects above this size ask for confirmation first. */
export const REJECT_ALL_CONFIRM_THRESHOLD = 50;
