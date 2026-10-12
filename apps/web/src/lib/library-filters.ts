import type { EventSummary, FlagFilter, PhotoBounds } from "@/lib/types";

export type RawFilter = "all" | "raw" | "standard" | "video";

export interface LibraryFilters {
	filterRaw: RawFilter;
	camera: string | null;
	lens: string | null;
	iso: number | null;
	dateMonth: string | null;
	/** Minimum star rating (1-5); null matches any rating. */
	minRating: number | null;
	flag: FlagFilter | null;
	/** Tag slug; null matches any tag. */
	tag: string | null;
	/** ISO2 country code of the photo's place; null matches any. */
	country: string | null;
	/** City (GeoNames id) of the photo's place; set together with `country`. */
	place: number | null;
	/** Person (people id) whose faces appear in the photo; null matches any. */
	personId: number | null;
	/** "On this day" capture date (`YYYY-MM-DD`); never saved in smart albums. */
	capturedDate: string | null;
	/**
	 * Auto event (the whole summary, so its title survives folder changes);
	 * a view scope never saved in smart albums.
	 */
	event: EventSummary | null;
	/** "Map area" from the map view; never saved in smart albums. */
	bounds: PhotoBounds | null;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = {
	filterRaw: "all",
	camera: null,
	lens: null,
	iso: null,
	dateMonth: null,
	minRating: null,
	flag: null,
	tag: null,
	country: null,
	place: null,
	personId: null,
	capturedDate: null,
	event: null,
	bounds: null,
};

/** Tags, countries, cities, and events listed before "Show all" expands the full list. */
export const FILTER_PREVIEW_LIMIT = 12;

export const RAW_FILTER_OPTIONS: { value: RawFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "raw", label: "RAW" },
	{ value: "standard", label: "Standard" },
	{ value: "video", label: "Video" },
];

/** Compact label for a minimum-rating filter: ★5 or ★n+. */
export function minRatingLabel(minRating: number) {
	return minRating === 5 ? "★5" : `★${minRating}+`;
}

export const RATING_FILTER_OPTIONS: { value: number | null; label: string }[] =
	[
		{ value: null, label: "Any" },
		...[1, 2, 3, 4, 5].map((value) => ({
			value,
			label: minRatingLabel(value),
		})),
	];

export const FLAG_FILTER_LABELS: Record<FlagFilter, string> = {
	pick: "Picks",
	reject: "Rejected",
	unflagged: "Unflagged",
};

export const FLAG_FILTER_OPTIONS: {
	value: FlagFilter | null;
	label: string;
}[] = [
	{ value: null, label: "Any" },
	{ value: "pick", label: FLAG_FILTER_LABELS.pick },
	{ value: "reject", label: FLAG_FILTER_LABELS.reject },
	{ value: "unflagged", label: FLAG_FILTER_LABELS.unflagged },
];
