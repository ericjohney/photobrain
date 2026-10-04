import { formatPlaceLabel } from "@/lib/places";
import { trpc } from "@/lib/trpc";
import type { PhotoPlace } from "@/lib/types";

/**
 * Location-section row naming the active photo's offline-geocoded place
 * (`photoPlace`); clicking it filters the library by that city. Renders
 * nothing while loading or when the photo has no place.
 */
export function PhotoPlaceRow({
	photoId,
	onSelect,
}: {
	photoId: number;
	onSelect?: (place: PhotoPlace) => void;
}) {
	const place = trpc.photoPlace.useQuery({ photoId }).data?.place;
	if (!place) return null;
	const label = formatPlaceLabel(place);

	return (
		<div data-testid="photo-place" className="metadata-row">
			<span className="metadata-label">Place</span>
			{onSelect ? (
				<button
					type="button"
					title={`Show photos in ${place.city}`}
					onClick={() => onSelect(place)}
					className="metadata-value text-right text-primary hover:underline"
				>
					{label}
				</button>
			) : (
				<span className="metadata-value">{label}</span>
			)}
		</div>
	);
}
