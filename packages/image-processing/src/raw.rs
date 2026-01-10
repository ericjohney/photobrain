use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use rsraw::{RawImage, ThumbFormat};
use std::fs;
use std::process::Command;

use crate::clip::generate_clip_embedding_from_image;
use crate::exif::{extract_exif_internal, ExifData};
use crate::orientation::apply_orientation;
use crate::phash::generate_phash_from_image;
use crate::thumbnails::generate_all_thumbnails_internal;

/// Complete result of RAW processing with all metadata
#[napi(object)]
pub struct RawCompleteResult {
	/// Width of the processed image
	pub width: u32,
	/// Height of the processed image
	pub height: u32,
	/// Perceptual hash of the processed image
	pub phash: Option<String>,
	/// CLIP embedding (512 f64 values)
	pub clip_embedding: Option<Vec<f64>>,
	/// EXIF data extracted from the RAW file
	pub exif: Option<ExifData>,
	/// Processing time in milliseconds
	pub processing_time_ms: u32,
	/// Whether processing succeeded
	pub success: bool,
	/// Error message if processing failed
	pub error: Option<String>,
}

/// Extract the largest embedded JPEG preview from a RAW file using rsraw
fn extract_preview_rsraw(file_data: &[u8]) -> Option<Vec<u8>> {
	let mut raw = RawImage::open(file_data).ok()?;
	let thumbs = raw.extract_thumbs().ok()?;

	// Find largest JPEG thumbnail
	thumbs
		.iter()
		.filter(|t| matches!(t.format, ThumbFormat::Jpeg))
		.max_by_key(|t| t.width as u32 * t.height as u32)
		.map(|t| t.data.clone())
}

/// Extract preview using exiftool (fallback for files rsraw can't handle)
fn extract_preview_exiftool(file_path: &str) -> Option<Vec<u8>> {
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

	None
}

/// Check if file is a DNG (often problematic with rsraw, especially iPhone ProRAW)
fn is_dng_file(file_path: &str) -> bool {
	file_path.to_lowercase().ends_with(".dng")
}

/// Extract embedded preview - optimized for different file types
fn extract_largest_preview(file_path: &str, file_data: Option<&[u8]>) -> Option<Vec<u8>> {
	// For DNG files, try exiftool first (rsraw often fails with iPhone ProRAW DNGs)
	if is_dng_file(file_path) {
		if let Some(preview) = extract_preview_exiftool(file_path) {
			return Some(preview);
		}
	}

	// Try rsraw if we have file data (faster than exiftool for supported formats)
	if let Some(data) = file_data {
		if let Some(preview) = extract_preview_rsraw(data) {
			return Some(preview);
		}
	}

	// Fall back to exiftool for any remaining cases
	if !is_dng_file(file_path) {
		extract_preview_exiftool(file_path)
	} else {
		None // Already tried exiftool above
	}
}

/// Process a RAW file using its embedded preview
/// This approach works for all RAW files including iPhone ProRAW DNGs
pub fn process_raw_complete_internal(
	file_path: &str,
	relative_path: &str,
	thumbnails_dir: &str,
) -> RawCompleteResult {
	let start = std::time::Instant::now();

	// Extract EXIF data from the RAW file
	let exif = extract_exif_internal(file_path);

	// For DNG files, skip reading the full file - exiftool reads directly from disk
	// This saves ~20-75MB of memory and disk I/O for files rsraw can't handle
	let file_data = if is_dng_file(file_path) {
		None
	} else {
		match fs::read(file_path) {
			Ok(data) => Some(data),
			Err(e) => {
				return RawCompleteResult {
					width: 0,
					height: 0,
					phash: None,
					clip_embedding: None,
					exif,
					processing_time_ms: start.elapsed().as_millis() as u32,
					success: false,
					error: Some(format!("Failed to read file: {}", e)),
				};
			}
		}
	};

	// Extract embedded preview JPEG
	let preview_jpeg = match extract_largest_preview(file_path, file_data.as_deref()) {
		Some(data) => data,
		None => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some("No embedded preview found in RAW file".to_string()),
			};
		}
	};

	// Drop file_data to free memory before decoding preview
	drop(file_data);

	// Decode the preview JPEG
	let img = match image::load_from_memory(&preview_jpeg) {
		Ok(img) => img,
		Err(e) => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some(format!("Failed to decode preview: {}", e)),
			};
		}
	};

	// Apply EXIF orientation if needed
	// Note: Embedded previews in RAW files are typically already rotated correctly,
	// but we apply orientation just in case
	let orientation = exif.as_ref().and_then(|e| e.orientation);
	let img = apply_orientation(img, orientation);

	let width = img.width();
	let height = img.height();

	// Generate phash
	let phash = Some(generate_phash_from_image(&img));

	// Generate thumbnails
	if let Err(e) = generate_all_thumbnails_internal(&img, relative_path, thumbnails_dir) {
		eprintln!("Warning: Failed to generate thumbnails: {}", e);
	}

	// Generate CLIP embedding (takes ownership of img)
	let clip_embedding =
		generate_clip_embedding_from_image(img).map(|v| v.iter().map(|&f| f as f64).collect());

	RawCompleteResult {
		width,
		height,
		phash,
		clip_embedding,
		exif,
		processing_time_ms: start.elapsed().as_millis() as u32,
		success: true,
		error: None,
	}
}

/// Process a single RAW file completely in Rust - all processing in one call
/// Extracts EXIF, uses embedded preview, generates CLIP, phash, and thumbnails
#[napi]
pub fn process_raw_complete(
	file_path: String,
	relative_path: String,
	thumbnails_dir: String,
) -> RawCompleteResult {
	process_raw_complete_internal(&file_path, &relative_path, &thumbnails_dir)
}

/// Batch process multiple RAW files completely in parallel
/// All processing happens in Rust - returns only metadata (including EXIF)
#[napi]
pub fn process_raw_batch_complete(
	file_paths: Vec<String>,
	relative_paths: Vec<String>,
	thumbnails_dir: String,
) -> Vec<RawCompleteResult> {
	// Limit concurrent processing to avoid memory exhaustion
	let max_concurrent = std::cmp::min(num_cpus::get(), 4);

	let pool = rayon::ThreadPoolBuilder::new()
		.num_threads(max_concurrent)
		.build()
		.unwrap_or_else(|_| rayon::ThreadPoolBuilder::new().build().unwrap());

	pool.install(|| {
		file_paths
			.par_iter()
			.enumerate()
			.map(|(i, path)| {
				let rel_path = relative_paths.get(i).map(|s| s.as_str()).unwrap_or("");
				process_raw_complete_internal(path, rel_path, &thumbnails_dir)
			})
			.collect()
	})
}

/// Extract the embedded JPEG preview from a RAW file
#[napi]
pub fn extract_raw_preview(file_path: String) -> Result<Option<Buffer>> {
	// For DNG files, use exiftool directly (skip file read)
	if is_dng_file(&file_path) {
		return Ok(extract_largest_preview(&file_path, None).map(|v| v.into()));
	}

	// For other RAW files, read and use rsraw
	let file_data =
		fs::read(&file_path).map_err(|e| Error::from_reason(format!("Failed to read file: {}", e)))?;

	Ok(extract_largest_preview(&file_path, Some(&file_data)).map(|v| v.into()))
}
