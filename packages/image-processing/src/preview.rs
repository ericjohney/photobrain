use std::process::Command;

/// File extensions that require preview extraction (not directly decodable by image crate)
const PREVIEW_EXTENSIONS: &[&str] = &[
	// RAW formats
	".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw", ".x3f",
	".3fr", ".iiq", ".rwl", // HEIF/HEIC formats
	".heic", ".heif",
];

/// Check if a file requires preview extraction
pub fn needs_preview_extraction(file_path: &str) -> bool {
	let lower = file_path.to_lowercase();
	PREVIEW_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Get the format name for RAW files (for MIME type)
pub fn get_raw_format(file_path: &str) -> Option<String> {
	let lower = file_path.to_lowercase();
	if lower.ends_with(".heic") || lower.ends_with(".heif") {
		return None; // Not a RAW format
	}

	// Extract extension without dot
	file_path
		.rsplit('.')
		.next()
		.map(|ext| ext.to_uppercase())
}

/// Extract embedded preview JPEG from RAW or HEIF files using exiftool
/// Returns the JPEG bytes if successful
pub fn extract_preview(file_path: &str) -> Option<Vec<u8>> {
	// Try PreviewImage first (works for most RAW and HEIF)
	let output = Command::new("exiftool")
		.args(["-b", "-PreviewImage", file_path])
		.output()
		.ok()?;

	if output.status.success() && !output.stdout.is_empty() {
		// Verify it's a JPEG (starts with FFD8)
		if output.stdout.len() > 2 && output.stdout[0] == 0xFF && output.stdout[1] == 0xD8 {
			return Some(output.stdout);
		}
	}

	// Fallback: try JpgFromRaw (some cameras use this tag)
	let output = Command::new("exiftool")
		.args(["-b", "-JpgFromRaw", file_path])
		.output()
		.ok()?;

	if output.status.success() && !output.stdout.is_empty() {
		if output.stdout.len() > 2 && output.stdout[0] == 0xFF && output.stdout[1] == 0xD8 {
			return Some(output.stdout);
		}
	}

	None
}
