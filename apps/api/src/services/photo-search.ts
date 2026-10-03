import type { PhotoCatalogRepresentation, PhotoFilters } from "./photo-catalog";

export type PhotoSearchProvider<Result = unknown> = (
	query: string,
	limit: number,
	filters: PhotoFilters,
	representation: PhotoCatalogRepresentation,
) => Promise<Result[]>;

export async function searchPhotoCatalog<Result>(
	provider: PhotoSearchProvider<Result>,
	{ query, limit, ...filters }: { query: string; limit: number } & PhotoFilters,
	representation: PhotoCatalogRepresentation = {},
) {
	const photos = await provider(query, limit, filters, representation);
	return {
		photos,
		total: photos.length,
		query,
	};
}
