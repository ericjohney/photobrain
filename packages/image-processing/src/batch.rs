use image::ImageReader;
use napi_derive::napi;
use rayon::prelude::*;
use std::fs;
use std::io::Cursor;
use std::path::Path;

use crate::clip::generate_clip_embedding_from_image;
use crate::exif::{extract_exif_internal, ExifData};
use crate::orientation::apply_orientation;
use crate::phash::generate_phash_from_image;
use crate::preview::{extract_preview, get_raw_format, needs_preview_extraction};
use crate::thumbnails::generate_all_thumbnails_internal;

/// Standard image extensions (directly decodable by image crate)
const STANDARD_EXTENSIONS: &[&str] = &[
	".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
];

/// All supported extensions
const ALL_EXTENSIONS: &[&str] = &[
	// Standard
	".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
	// RAW
	".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw", ".x3f",
	".3fr", ".iiq", ".rwl",
	// HEIF
	".heic", ".heif",
];

/// Check if file is supported
#[napi]
pub fn is_supported_image(file_path: String) -> bool {
	let lower = file_path.to_lowercase();
	ALL_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Get all supported extensions
#[napi]
pub fn get_supported_extensions() -> Vec<String> {
	ALL_EXTENSIONS.iter().map(|s| s.to_string()).collect()
}

/// Unified result for any photo type
#[napi(object)]
pub struct PhotoProcessingResult {
	pub path: String,
	pub name: String,
	pub size: i64,
	pub created_at: f64,
	pub modified_at: f64,
	pub width: Option<u32>,
	pub height: Option<u32>,
	pub mime_type: Option<String>,
	pub phash: Option<String>,
	pub clip_embedding: Option<Vec<f64>>,
	pub exif: Option<ExifData>,
	pub is_raw: bool,
	pub raw_format: Option<String>,
	pub raw_status: Option<String>,
	pub raw_error: Option<String>,
	pub success: bool,
	pub error: Option<String>,
}

/// Check if file is a standard image (directly decodable)
fn is_standard_image(file_path: &str) -> bool {
	let lower = file_path.to_lowercase();
	STANDARD_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Get MIME type for a file
fn get_mime_type(file_path: &str, raw_format: &Option<String>) -> Option<String> {
	let lower = file_path.to_lowercase();

	if let Some(fmt) = raw_format {
		return Some(format!("image/x-{}", fmt.to_lowercase()));
	}

	if lower.ends_with(".heic") || lower.ends_with(".heif") {
		return Some("image/heic".to_string());
	}

	// For standard images, detect from file
	None // Will be set during decoding
}

/// Create error result
fn error_result(path: &str, name: String, error: String) -> PhotoProcessingResult {
	PhotoProcessingResult {
		path: path.to_string(),
		name,
		size: 0,
		created_at: 0.0,
		modified_at: 0.0,
		width: None,
		height: None,
		mime_type: None,
		phash: None,
		clip_embedding: None,
		exif: None,
		is_raw: false,
		raw_format: None,
		raw_status: None,
		raw_error: None,
		success: false,
		error: Some(error),
	}
}

/// Process a single photo (any type)
fn process_photo_internal(
	file_path: &str,
	relative_path: &str,
	thumbnails_dir: &str,
) -> PhotoProcessingResult {
	let path = Path::new(file_path);
	let name = path
		.file_name()
		.unwrap_or_default()
		.to_string_lossy()
		.to_string();

	// Get file metadata
	let metadata = match fs::metadata(file_path) {
		Ok(m) => m,
		Err(e) => return error_result(relative_path, name, format!("Failed to read file: {}", e)),
	};

	let size = metadata.len() as i64;
	let created_at = metadata
		.created()
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_millis() as f64)
		.unwrap_or(0.0);
	let modified_at = metadata
		.modified()
		.ok()
		.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
		.map(|d| d.as_millis() as f64)
		.unwrap_or(0.0);

	// Determine if this is a RAW file
	let raw_format = get_raw_format(file_path);
	let is_raw = raw_format.is_some();

	// Extract EXIF (works for all formats via exiftool)
	let exif = extract_exif_internal(file_path);
	let orientation = exif.as_ref().and_then(|e| e.orientation);

	// Decode image - either directly or via preview extraction
	let decode_result = if needs_preview_extraction(file_path) {
		// RAW or HEIF: extract embedded preview
		match extract_preview(file_path) {
			Some(preview_bytes) => {
				ImageReader::new(Cursor::new(preview_bytes))
					.with_guessed_format()
					.map_err(|e| e.to_string())
					.and_then(|reader| reader.decode().map_err(|e| e.to_string()))
			}
			None => Err("No embedded preview found".to_string()),
		}
	} else if is_standard_image(file_path) {
		// Standard image: decode directly
		ImageReader::open(file_path)
			.map_err(|e| e.to_string())
			.and_then(|reader| reader.decode().map_err(|e| e.to_string()))
	} else {
		Err("Unsupported file type".to_string())
	};

	// Process the decoded image
	match decode_result {
		Ok(img) => {
			// Apply EXIF orientation
			let img = apply_orientation(img, orientation);
			let width = img.width();
			let height = img.height();

			// Generate phash
			let phash = Some(generate_phash_from_image(&img));

			// Generate thumbnails
			if let Err(e) = generate_all_thumbnails_internal(&img, relative_path, thumbnails_dir) {
				eprintln!("Warning: Failed to generate thumbnails: {}", e);
			}

			// Generate CLIP embedding
			let clip_embedding = generate_clip_embedding_from_image(img)
				.map(|vec| vec.iter().map(|&f| f as f64).collect());

			// Determine MIME type
			let mime_type = get_mime_type(file_path, &raw_format).or_else(|| {
				let lower = file_path.to_lowercase();
				if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
					Some("image/jpeg".to_string())
				} else if lower.ends_with(".png") {
					Some("image/png".to_string())
				} else if lower.ends_with(".webp") {
					Some("image/webp".to_string())
				} else if lower.ends_with(".gif") {
					Some("image/gif".to_string())
				} else {
					Some("image/unknown".to_string())
				}
			});

			PhotoProcessingResult {
				path: relative_path.to_string(),
				name,
				size,
				created_at,
				modified_at,
				width: Some(width),
				height: Some(height),
				mime_type,
				phash,
				clip_embedding,
				exif,
				is_raw,
				raw_format,
				raw_status: if is_raw {
					Some("converted".to_string())
				} else {
					None
				},
				raw_error: None,
				success: true,
				error: None,
			}
		}
		Err(e) => {
			let mime_type = get_mime_type(file_path, &raw_format);

			PhotoProcessingResult {
				path: relative_path.to_string(),
				name,
				size,
				created_at,
				modified_at,
				width: None,
				height: None,
				mime_type,
				phash: None,
				clip_embedding: None,
				exif,
				is_raw,
				raw_format,
				raw_status: if is_raw {
					Some("failed".to_string())
				} else {
					None
				},
				raw_error: if is_raw { Some(e.clone()) } else { None },
				success: false,
				error: Some(e),
			}
		}
	}
}

/// Process a batch of photos in parallel
#[napi]
pub fn process_photos_batch(
	file_paths: Vec<String>,
	relative_paths: Vec<String>,
	thumbnails_dir: String,
) -> Vec<PhotoProcessingResult> {
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
				process_photo_internal(path, rel_path, &thumbnails_dir)
			})
			.collect()
	})
}

/// Process a single photo
#[napi]
pub fn process_photo(
	file_path: String,
	relative_path: String,
	thumbnails_dir: String,
) -> PhotoProcessingResult {
	process_photo_internal(&file_path, &relative_path, &thumbnails_dir)
}
