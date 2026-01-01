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

export interface ScanResponse {
	success: boolean;
	scanned: number;
	inserted: number;
	skipped: number;
	duration: number;
}

export interface SearchParams {
	query: string;
	limit?: number;
}
