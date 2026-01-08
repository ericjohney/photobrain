use image::{DynamicImage, ImageReader};
use napi_derive::napi;
use rayon::prelude::*;
use std::fs;
use std::path::Path;

use crate::clip::generate_clip_embedding_from_image;
use crate::exif::{extract_exif_internal, ExifData};
use crate::heif::{decode_heif, is_heif_file};
use crate::phash::generate_phash_from_image;
use crate::raw::{process_raw_complete_internal, RawCompleteResult};
use crate::thumbnails::generate_all_thumbnails_internal;

/// RAW file extensions (lowercase, with dot)
const RAW_EXTENSIONS: &[&str] = &[
	".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw", ".x3f", ".3fr",
	".iiq", ".rwl",
];

/// Standard image extensions
const STANDARD_EXTENSIONS: &[&str] = &[
	".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
];

/// HEIF/HEIC extensions
const HEIF_EXTENSIONS: &[&str] = &[".heic", ".heif"];

/// File type enum
#[derive(Debug, Clone, Copy, PartialEq)]
enum FileType {
	Raw,
	Heif,
	Standard,
	Unsupported,
}

/// Detect file type from extension
fn detect_file_type(file_path: &str) -> FileType {
	let ext = Path::new(file_path)
		.extension()
		.and_then(|e| e.to_str())
		.map(|e| format!(".{}", e.to_lowercase()))
		.unwrap_or_default();

	if RAW_EXTENSIONS.contains(&ext.as_str()) {
		FileType::Raw
	} else if HEIF_EXTENSIONS.contains(&ext.as_str()) {
		FileType::Heif
	} else if STANDARD_EXTENSIONS.contains(&ext.as_str()) {
		FileType::Standard
	} else {
		FileType::Unsupported
	}
}

/// Get RAW format name from extension
fn get_raw_format(file_path: &str) -> Option<String> {
	let ext = Path::new(file_path)
		.extension()
		.and_then(|e| e.to_str())
		.map(|e| e.to_uppercase())?;

	Some(ext)
}

/// Check if file is supported
#[napi]
pub fn is_supported_image(file_path: String) -> bool {
	detect_file_type(&file_path) != FileType::Unsupported
}

/// Get all supported extensions
#[napi]
pub fn get_supported_extensions() -> Vec<String> {
	let mut extensions: Vec<String> = Vec::new();
	extensions.extend(RAW_EXTENSIONS.iter().map(|s| s.to_string()));
	extensions.extend(HEIF_EXTENSIONS.iter().map(|s| s.to_string()));
	extensions.extend(STANDARD_EXTENSIONS.iter().map(|s| s.to_string()));
	extensions
}

/// Unified result for any photo type
#[napi(object)]
pub struct PhotoProcessingResult {
	/// Relative path of the photo
	pub path: String,
	/// File name
	pub name: String,
	/// File size in bytes
	pub size: i64,
	/// Created timestamp (ms since epoch)
	pub created_at: f64,
	/// Modified timestamp (ms since epoch)
	pub modified_at: f64,
	/// Width in pixels
	pub width: Option<u32>,
	/// Height in pixels
	pub height: Option<u32>,
	/// MIME type
	pub mime_type: Option<String>,
	/// Perceptual hash
	pub phash: Option<String>,
	/// CLIP embedding (512 f64 values)
	pub clip_embedding: Option<Vec<f64>>,
	/// EXIF data
	pub exif: Option<ExifData>,
	/// Whether this is a RAW file
	pub is_raw: bool,
	/// RAW format (CR2, NEF, etc.) if applicable
	pub raw_format: Option<String>,
	/// RAW processing status
	pub raw_status: Option<String>,
	/// Error message if processing failed
	pub raw_error: Option<String>,
	/// Whether processing succeeded
	pub success: bool,
	/// Error message if failed
	pub error: Option<String>,
}

/// Apply EXIF orientation to an image
fn apply_orientation(img: DynamicImage, orientation: Option<u32>) -> DynamicImage {
	match orientation {
		Some(2) => img.fliph(),
		Some(3) => img.rotate180(),
		Some(4) => img.flipv(),
		Some(5) => img.rotate270().fliph(),
		Some(6) => img.rotate90(),
		Some(7) => img.rotate90().fliph(),
		Some(8) => img.rotate270(),
		_ => img,
	}
}

/// Process a standard image file (JPEG, PNG, etc.)
fn process_standard_image(
	file_path: &str,
	relative_path: &str,
	thumbnails_dir: &str,
) -> PhotoProcessingResult {
	let path = Path::new(file_path);

	// Get file metadata
	let metadata = match fs::metadata(file_path) {
		Ok(m) => m,
		Err(e) => {
			return PhotoProcessingResult {
				path: relative_path.to_string(),
				name: path
					.file_name()
					.unwrap_or_default()
					.to_string_lossy()
					.to_string(),
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
				error: Some(format!("Failed to read file metadata: {}", e)),
			};
		}
	};

	let name = path
		.file_name()
		.unwrap_or_default()
		.to_string_lossy()
		.to_string();
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

	// Extract EXIF
	let exif = extract_exif_internal(file_path);
	let orientation = exif.as_ref().and_then(|e| e.orientation);

	// Decode image
	let decode_result = if is_heif_file(path) {
		decode_heif(path)
			.map(|img| (img, Some("image/heic".to_string())))
			.map_err(|e| e.to_string())
	} else {
		match ImageReader::open(file_path) {
			Ok(reader) => {
				let format = reader.format();
				match reader.decode() {
					Ok(img) => {
						let mime =
							format.map(|f| format!("image/{}", format!("{:?}", f).to_lowercase()));
						Ok((img, mime))
					}
					Err(e) => Err(e.to_string()),
				}
			}
			Err(e) => Err(e.to_string()),
		}
	};

	match decode_result {
		Ok((img, mime_type)) => {
			let img = apply_orientation(img, orientation);
			let width = img.width();
			let height = img.height();

			// Generate phash
			let phash = Some(generate_phash_from_image(&img));

			// Generate thumbnails
			if let Err(e) = generate_all_thumbnails_internal(&img, relative_path, thumbnails_dir) {
				eprintln!(
					"Warning: Failed to generate thumbnails for {}: {}",
					relative_path, e
				);
			}

			// Generate CLIP embedding
			let clip_embedding = generate_clip_embedding_from_image(img)
				.map(|vec| vec.iter().map(|&f| f as f64).collect());

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
				is_raw: false,
				raw_format: None,
				raw_status: None,
				raw_error: None,
				success: true,
				error: None,
			}
		}
		Err(e) => PhotoProcessingResult {
			path: relative_path.to_string(),
			name,
			size,
			created_at,
			modified_at,
			width: None,
			height: None,
			mime_type: None,
			phash: None,
			clip_embedding: None,
			exif,
			is_raw: false,
			raw_format: None,
			raw_status: None,
			raw_error: None,
			success: false,
			error: Some(format!("Failed to decode image: {}", e)),
		},
	}
}

/// Process a RAW file - wrapper around raw module
fn process_raw_file(
	file_path: &str,
	relative_path: &str,
	thumbnails_dir: &str,
) -> PhotoProcessingResult {
	let path = Path::new(file_path);
	let raw_format = get_raw_format(file_path);

	// Get file metadata
	let metadata = match fs::metadata(file_path) {
		Ok(m) => m,
		Err(e) => {
			return PhotoProcessingResult {
				path: relative_path.to_string(),
				name: path
					.file_name()
					.unwrap_or_default()
					.to_string_lossy()
					.to_string(),
				size: 0,
				created_at: 0.0,
				modified_at: 0.0,
				width: None,
				height: None,
				mime_type: raw_format
					.as_ref()
					.map(|f| format!("image/x-{}", f.to_lowercase())),
				phash: None,
				clip_embedding: None,
				exif: None,
				is_raw: true,
				raw_format,
				raw_status: Some("failed".to_string()),
				raw_error: Some(format!("Failed to read file metadata: {}", e)),
				success: false,
				error: Some(format!("Failed to read file metadata: {}", e)),
			};
		}
	};

	let name = path
		.file_name()
		.unwrap_or_default()
		.to_string_lossy()
		.to_string();
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

	// Use the raw processing module
	let raw_result: RawCompleteResult =
		process_raw_complete_internal(file_path, relative_path, thumbnails_dir);

	PhotoProcessingResult {
		path: relative_path.to_string(),
		name,
		size,
		created_at,
		modified_at,
		width: if raw_result.success {
			Some(raw_result.width)
		} else {
			None
		},
		height: if raw_result.success {
			Some(raw_result.height)
		} else {
			None
		},
		mime_type: raw_format
			.as_ref()
			.map(|f| format!("image/x-{}", f.to_lowercase())),
		phash: raw_result.phash,
		clip_embedding: raw_result.clip_embedding,
		exif: raw_result.exif,
		is_raw: true,
		raw_format,
		raw_status: Some(if raw_result.success {
			"converted".to_string()
		} else {
			"failed".to_string()
		}),
		raw_error: raw_result.error.clone(),
		success: raw_result.success,
		error: raw_result.error,
	}
}

/// Process a single photo of any type
fn process_photo_internal(
	file_path: &str,
	relative_path: &str,
	thumbnails_dir: &str,
) -> PhotoProcessingResult {
	match detect_file_type(file_path) {
		FileType::Raw => process_raw_file(file_path, relative_path, thumbnails_dir),
		FileType::Heif | FileType::Standard => {
			process_standard_image(file_path, relative_path, thumbnails_dir)
		}
		FileType::Unsupported => {
			let path = Path::new(file_path);
			PhotoProcessingResult {
				path: relative_path.to_string(),
				name: path
					.file_name()
					.unwrap_or_default()
					.to_string_lossy()
					.to_string(),
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
				error: Some("Unsupported file type".to_string()),
			}
		}
	}
}

/// Process a batch of photos in parallel with controlled concurrency
/// Handles all file types (RAW, HEIF, standard images) automatically
/// Uses chunked processing to limit memory usage with large RAW files
#[napi]
pub fn process_photos_batch(
	file_paths: Vec<String>,
	relative_paths: Vec<String>,
	thumbnails_dir: String,
) -> Vec<PhotoProcessingResult> {
	// Limit concurrent processing to avoid memory exhaustion with large RAW files
	// Each RAW file can use 100-200MB during processing
	let max_concurrent = std::cmp::min(num_cpus::get(), 4);

	// Build a custom thread pool with limited threads
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

/// Process a single photo of any type
#[napi]
pub fn process_photo(
	file_path: String,
	relative_path: String,
	thumbnails_dir: String,
) -> PhotoProcessingResult {
	process_photo_internal(&file_path, &relative_path, &thumbnails_dir)
}
