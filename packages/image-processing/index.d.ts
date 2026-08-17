export interface ExifData {
	cameraMake?: string;
	cameraModel?: string;
	lensMake?: string;
	lensModel?: string;
	focalLength?: number;
	iso?: number;
	aperture?: string;
	shutterSpeed?: string;
	exposureBias?: string;
	dateTaken?: string;
	gpsLatitude?: number;
	gpsLongitude?: number;
	gpsAltitude?: number;
	orientation?: number;
}

export interface PhotoProcessingResult {
	success: boolean;
	error?: string;
	path: string;
	name: string;
	size: number;
	createdAt: number;
	modifiedAt: number;
	width?: number;
	height?: number;
	mimeType?: string;
	isRaw: boolean;
	rawFormat?: string;
	rawStatus?: string;
	rawError?: string;
	exif?: ExifData;
	phash?: string;
}

export interface PhotoDiscoveryResult {
	filePaths: string[];
	relativePaths: string[];
	totalCount: number;
}

export function discoverPhotos(directory: string): PhotoDiscoveryResult;
export function isSupportedImage(path: string): boolean;
export function getSupportedExtensions(): string[];
export function processPhoto(
	path: string,
	relativePath: string,
	thumbnailsDir: string,
): PhotoProcessingResult;
export function processPhotosBatch(
	paths: string[],
	relativePaths: string[],
	thumbnailsDir: string,
): PhotoProcessingResult[];
export function processPhotosWithCallback(
	paths: string[],
	relativePaths: string[],
	thumbnailsDir: string,
	callback: (result: PhotoProcessingResult) => void,
): number;
export function extractExif(path: string): ExifData | null;
export function perceptualHash(path: string): string;
export function generatePhash(path: string): string;
export function generateThumbnailsFromFile(
	path: string,
	relativePath: string,
	baseDir: string,
	orientation?: number,
): void;
export function clipTextEmbedding(text: string): number[];
export function batchGenerateClipEmbeddings(
	paths: string[],
): Array<number[] | null>;
