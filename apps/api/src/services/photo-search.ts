export type PhotoSearchProvider<Result = unknown> = (
	query: string,
	limit: number,
) => Promise<Result[]>;

export async function searchPhotoCatalog<Result>(
	provider: PhotoSearchProvider<Result>,
	input: { query: string; limit: number },
) {
	const photos = await provider(input.query, input.limit);
	return {
		photos,
		total: photos.length,
		query: input.query,
	};
}
