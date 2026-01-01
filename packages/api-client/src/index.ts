import type {
	PhotoMetadata,
	PhotosResponse,
	ScanResponse,
	SearchParams,
} from "@photobrain/shared-types";

export class PhotoBrainClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	/**
	 * Fetch all photos from the database
	 */
	async getPhotos(): Promise<PhotosResponse> {
		const response = await fetch(`${this.baseUrl}/api/photos`);
		if (!response.ok) {
			throw new Error(`Failed to fetch photos: ${response.statusText}`);
		}
		return response.json();
	}

	/**
	 * Get a single photo by ID
	 */
	async getPhoto(id: number): Promise<PhotoMetadata> {
		const response = await fetch(`${this.baseUrl}/api/photos/${id}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch photo: ${response.statusText}`);
		}
		return response.json();
	}

	/**
	 * Get the URL for a photo file
	 */
	getPhotoUrl(id: number): string {
		return `${this.baseUrl}/api/photos/${id}/file`;
	}

	/**
	 * Search photos using semantic search
	 */
	async searchPhotos({ query, limit = 20 }: SearchParams): Promise<PhotosResponse> {
		const params = new URLSearchParams({
			q: query,
			limit: limit.toString(),
		});
		const response = await fetch(`${this.baseUrl}/api/photos/search?${params}`);
		if (!response.ok) {
			throw new Error(`Failed to search photos: ${response.statusText}`);
		}
		return response.json();
	}

	/**
	 * Trigger a directory scan
	 */
	async scan(): Promise<ScanResponse> {
		const response = await fetch(`${this.baseUrl}/api/scan`, {
			method: "POST",
		});
		if (!response.ok) {
			throw new Error(`Failed to trigger scan: ${response.statusText}`);
		}
		return response.json();
	}

	/**
	 * Check API health
	 */
	async health(): Promise<{ status: string }> {
		const response = await fetch(`${this.baseUrl}/api/health`);
		if (!response.ok) {
			throw new Error(`Health check failed: ${response.statusText}`);
		}
		return response.json();
	}
}

export * from "@photobrain/shared-types";
