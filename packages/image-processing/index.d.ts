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
export interface PhotoStreamResult {
	index: number;
	result: PhotoProcessingResult;
}
export class PhotoProcessingStream {
	private constructor();
	next(): Promise<PhotoStreamResult | null>;
	close(): Promise<void>;
}
export function startPhotoProcessing(
	filePaths: string[],
	relativePaths: string[],
	thumbnailsDir: string,
	thumbnailPaths?: string[],
): PhotoProcessingStream;
export function extractExif(path: string): ExifData | null;
export function perceptualHash(path: string): string;
export function generatePhash(path: string): string;
export function generateThumbnailsFromFile(
	path: string,
	relativePath: string,
	baseDir: string,
	orientation?: number,
): void;
export interface ThumbnailValidationItem {
	path: string;
	width: number;
	height: number;
}
export function validateThumbnails(
	items: ThumbnailValidationItem[],
	baseDir: string,
): boolean[];
export function clipTextEmbedding(text: string): number[];
export function batchGenerateClipEmbeddings(
	paths: string[],
): Array<number[] | null>;
export interface ImageQuality {
	/** Variance of the 4-neighbour 3x3 Laplacian over luma (long edge <= 512). */
	sharpness: number;
	/** Mean luma, 0-255. */
	brightness: number;
}
/** Per-path quality measurement; `null` for paths that fail to decode. */
export function analyzeImageQuality(
	paths: string[],
): Array<ImageQuality | null>;
export interface NearDuplicateGroup {
	/** Member IDs, ascending. */
	ids: number[];
	/** Largest pairwise Hamming distance between members (grouping is transitive). */
	maxDistance: number;
}
/**
 * Connected components (size >= 2) of index-aligned base64 pHashes within
 * `maxDistance` bits. Undecodable hashes are skipped.
 */
export function groupNearDuplicates(
	ids: number[],
	hashes: string[],
	maxDistance: number,
): NearDuplicateGroup[];
/**
 * Render a metadata-free sRGB 8-bit JPEG through the scan decode path (HEIF,
 * RAW embedded preview, EXIF orientation applied to the pixels). The long edge
 * is fitted to `maxEdge` only when larger (never upscaled); alpha is composited
 * over white. `quality` is 1-100. Throws when the source cannot be decoded.
 */
export function renderExportJpeg(
	path: string,
	maxEdge: number,
	quality: number,
): Buffer;
