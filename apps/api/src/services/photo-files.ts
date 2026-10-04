import { join } from "node:path";

/**
 * Absolute path of a photo's original file: its committed source root, or the
 * configured photo directory for legacy rows scanned before roots were recorded.
 */
export function originalFilePath(
	photo: { sourceRoot: string | null; path: string },
	photoDirectory: string,
): string {
	return join(photo.sourceRoot ?? photoDirectory, photo.path);
}
