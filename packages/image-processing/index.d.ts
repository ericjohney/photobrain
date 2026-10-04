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
	mediaType: "photo" | "video";
	/** Video duration in milliseconds; `null` for photos or unknown durations. */
	durationMs: number | null;
	/** ffprobe `codec_name` of the first video stream (e.g. `h264`, `hevc`); `null` for photos. */
	videoCodec: string | null;
}

export interface PhotoDiscoveryResult {
	filePaths: string[];
	relativePaths: string[];
	totalCount: number;
}

export function discoverPhotos(directory: string): PhotoDiscoveryResult;
export function isSupportedMedia(path: string): boolean;
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
/** Normalized (0..1) box in the oriented input image. */
export interface FaceBox {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface DetectedFace {
	box: FaceBox;
	/** Detector confidence `sqrt(cls * obj)`, 0-1. */
	score: number;
	/** 128 L2-normalized SFace components. */
	embedding: number[];
}
export interface FaceDetectionResult {
	path: string;
	success: boolean;
	faces: DetectedFace[];
	error?: string | null;
}
/**
 * Detect (YuNet), align, and embed (SFace) faces in each image, normally `large`
 * WebP thumbnails, on the shared processing pool. Faces are score-descending. A
 * failing path yields `success: false` for that path only; model download or load
 * failures throw.
 */
export function detectFaces(paths: string[]): FaceDetectionResult[];
/**
 * Deterministic mutual-kNN average-linkage clustering of index-aligned vectors at
 * cosine >= `threshold`. Groups have at least `minClusterSize` members, members
 * ascending, groups ordered by their smallest member.
 */
export function clusterFaceEmbeddings(
	embeddings: Float32Array,
	dimension: number,
	threshold: number,
	minClusterSize: number,
): number[][];
/**
 * Square WebP (quality 85) of `size` x `size` (64-512) centred on a face box, side
 * 1.6x the box's longer pixel side, clamped to the image.
 */
export function renderFaceCrop(
	path: string,
	box: FaceBox,
	size: number,
): Buffer;
