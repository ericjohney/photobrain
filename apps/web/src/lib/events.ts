import type { EventSummary } from "./types";

/** A calendar day of an event's wall-clock capture timestamp. */
interface WallClockDay {
	year: number;
	month: number;
	day: number;
}

/**
 * Calendar parts of an event's wall-clock `YYYY-MM-DDTHH:MM:SS` timestamp.
 * The API stores capture wall clock without a zone, so it is never parsed as
 * an instant (no UTC or local-zone shift).
 */
function wallClockDay(timestamp: string): WallClockDay {
	const [year, month, day] = timestamp.slice(0, 10).split("-").map(Number);
	return { year, month, day };
}

function formatDay(day: WallClockDay, options: Intl.DateTimeFormatOptions) {
	const date = new Date(day.year, day.month - 1, day.day);
	// Two-digit years would otherwise map to 19xx.
	date.setFullYear(day.year);
	return date.toLocaleDateString("en-US", options);
}

/**
 * The event's capture date range, shared with the other clients: "Oct 3,
 * 2023" (same day), "Oct 3 – 5, 2023" (same month), "Sep 30 – Oct 2, 2023"
 * (same year), else "Dec 30, 2023 – Jan 2, 2024".
 */
export function eventDateRange(event: Pick<EventSummary, "startAt" | "endAt">) {
	const start = wallClockDay(event.startAt);
	const end = wallClockDay(event.endAt);
	const full = { month: "short", day: "numeric", year: "numeric" } as const;
	const monthDay = { month: "short", day: "numeric" } as const;
	if (start.year !== end.year) {
		return `${formatDay(start, full)} – ${formatDay(end, full)}`;
	}
	if (start.month !== end.month) {
		return `${formatDay(start, monthDay)} – ${formatDay(end, full)}`;
	}
	if (start.day !== end.day) {
		return `${formatDay(start, monthDay)} – ${end.day}, ${end.year}`;
	}
	return formatDay(start, full);
}

/**
 * The event's place label ("Kyoto, Japan"; just "Japan" for a country-only
 * place or a city named like its country), else its date range.
 */
export function eventTitle(
	event: Pick<EventSummary, "startAt" | "endAt" | "place">,
) {
	const { place } = event;
	if (!place) return eventDateRange(event);
	return place.city === null || place.city === place.country
		? place.country
		: `${place.city}, ${place.country}`;
}

/**
 * "Oct 3 – 5, 2023 · 24 photos" under a place title; only the photo count
 * when the title is already the date range.
 */
export function eventSubtitle(
	event: Pick<EventSummary, "startAt" | "endAt" | "place" | "photoCount">,
) {
	const count =
		event.photoCount === 1
			? "1 photo"
			: `${event.photoCount.toLocaleString("en-US")} photos`;
	return event.place ? `${eventDateRange(event)} · ${count}` : count;
}
