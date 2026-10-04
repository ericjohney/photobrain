import type { PhotoPlace } from "./types";

/**
 * Place display rule shared with the other clients: city, then the region
 * when present and different from the city, then the country
 * ("Kyoto, Japan"; "Portland, Oregon, United States").
 */
export function formatPlaceLabel(
	place: Pick<PhotoPlace, "city" | "region" | "country">,
) {
	return [
		place.city,
		place.region !== null && place.region !== place.city ? place.region : null,
		place.country,
	]
		.filter((part): part is string => part !== null)
		.join(", ");
}
