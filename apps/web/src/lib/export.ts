import type { ExportSize } from "@/lib/thumbnails";

/** Export choices in menu order. */
export const EXPORT_SIZES: readonly ExportSize[] = ["original", "2048", "1024"];

/** The API's per-photo export filename: the original name, or `{stem}_{size}.jpg`. */
export function exportFileName(name: string, size: ExportSize): string {
	if (size === "original") return name;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	return `${stem}_${size}.jpg`;
}

/**
 * Starts a browser download through a detached anchor so the response streams
 * to disk (no fetch/blob buffering). The API's `Content-Disposition: attachment`
 * names the file when the API is cross-origin and `download` is ignored.
 */
export function downloadUrl(href: string, fileName: string): void {
	const anchor = document.createElement("a");
	anchor.href = href;
	anchor.download = fileName;
	anchor.click();
}
