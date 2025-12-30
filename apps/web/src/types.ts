export interface PhotoMetadata {
	id: number;
	path: string;
	name: string;
	size: number;
	createdAt: string;
	modifiedAt: string;
	width?: number;
	height?: number;
	mimeType?: string;
}

export interface PhotosResponse {
	photos: PhotoMetadata[];
	total: number;
}
