/**
 * RAW format extension to format name mapping
 * Supports common camera manufacturer RAW formats
 */
export const RAW_EXTENSIONS: Record<string, string> = {
	".cr2": "CR2", // Canon
	".cr3": "CR3", // Canon (newer)
	".nef": "NEF", // Nikon
	".arw": "ARW", // Sony
	".dng": "DNG", // Adobe/Generic
	".raf": "RAF", // Fujifilm
	".orf": "ORF", // Olympus
	".rw2": "RW2", // Panasonic
	".pef": "PEF", // Pentax
	".srw": "SRW", // Samsung
	".x3f": "X3F", // Sigma
	".3fr": "3FR", // Hasselblad
	".iiq": "IIQ", // Phase One
	".rwl": "RWL", // Leica
};

/**
 * Check if a file extension is a RAW format
 */
export function isRawFile(extension: string): boolean {
	return extension.toLowerCase() in RAW_EXTENSIONS;
}

/**
 * Get the RAW format name for a given extension
 */
export function getRawFormat(extension: string): string | null {
	return RAW_EXTENSIONS[extension.toLowerCase()] ?? null;
}

/**
 * Get all supported RAW file extensions
 */
export function getAllRawExtensions(): string[] {
	return Object.keys(RAW_EXTENSIONS);
}
