import type { PhotoMetadata } from "./types";

type BadgePhoto = Pick<
	PhotoMetadata,
	"name" | "isRaw" | "rawFormat" | "pairedFormat"
>;

/**
 * RAW badge text, or null for an unpaired standard photo. A RAW+standard pair
 * (stacked into one photo by the API) shows both formats, RAW first
 * (`ARW+JPG`); an unpaired RAW shows its format (`ARW`, or `RAW` if unknown).
 * `compact` is the filmstrip's short form: `R` or `R+J`.
 */
export function rawBadge(
	photo: BadgePhoto,
): { label: string; compact: string } | null {
	if (photo.pairedFormat !== null) {
		const rawPart = photo.isRaw
			? (photo.rawFormat ?? "RAW")
			: photo.pairedFormat;
		// A standard file's own format is its extension, upper-cased without the dot.
		const standardPart = photo.isRaw
			? photo.pairedFormat
			: photo.name.slice(photo.name.lastIndexOf(".") + 1).toUpperCase();
		return {
			label: `${rawPart}+${standardPart}`,
			compact: `R+${standardPart.charAt(0)}`,
		};
	}
	if (!photo.isRaw) return null;
	return { label: photo.rawFormat || "RAW", compact: "R" };
}
