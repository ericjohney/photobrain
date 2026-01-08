use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageBuffer, Rgb, RgbImage};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rayon::prelude::*;
use rsraw::{RawImage, ThumbFormat, BIT_DEPTH_8};
use std::fs;

use crate::clip::generate_clip_embedding_from_image;
use crate::exif::{extract_exif_internal, ExifData};
use crate::phash::generate_phash_from_image;
use crate::thumbnails::generate_all_thumbnails_internal;

/// Result of RAW processing
#[napi(object)]
pub struct RawProcessingResult {
	/// Width of the processed image
	pub width: u32,
	/// Height of the processed image
	pub height: u32,
	/// JPEG data of the processed image
	pub jpeg_data: Buffer,
	/// Embedded preview JPEG (for CLIP embedding - avoids re-encoding)
	pub preview_jpeg: Option<Buffer>,
	/// Whether histogram matching was applied
	pub histogram_matched: bool,
	/// Processing time in milliseconds
	pub processing_time_ms: u32,
}

/// Read file into bytes
fn read_file(file_path: &str) -> Result<Vec<u8>> {
	fs::read(file_path).map_err(|e| Error::from_reason(format!("Failed to read file: {}", e)))
}

/// Extract the largest embedded JPEG preview from a RAW file
/// Returns (decoded RgbImage for histogram, original JPEG bytes for CLIP)
fn extract_preview_with_jpeg(raw: &mut RawImage) -> Option<(RgbImage, Vec<u8>)> {
	let thumbs = raw.extract_thumbs().ok()?;

	// Find largest JPEG thumbnail
	let jpeg_thumb = thumbs
		.iter()
		.filter(|t| matches!(t.format, ThumbFormat::Jpeg))
		.max_by_key(|t| t.width as u32 * t.height as u32)?;

	// Keep original JPEG bytes and decode to RgbImage
	let jpeg_bytes = jpeg_thumb.data.clone();
	let rgb_img = image::load_from_memory(&jpeg_bytes)
		.ok()
		.map(|img| img.into_rgb8())?;

	Some((rgb_img, jpeg_bytes))
}

/// Process RAW and return as RgbImage (avoids DynamicImage overhead)
fn process_raw_to_rgb(raw: &mut RawImage) -> Result<RgbImage> {
	// Unpack the raw data first (required before process)
	raw.unpack()
		.map_err(|e| Error::from_reason(format!("Failed to unpack RAW: {}", e)))?;

	// Process the raw image - rsraw handles demosaicing, white balance, color conversion
	let processed = raw
		.process::<BIT_DEPTH_8>()
		.map_err(|e| Error::from_reason(format!("Failed to process RAW: {}", e)))?;

	let width = processed.width();
	let height = processed.height();
	let data: &[u8] = &processed;

	// Create RgbImage directly (one copy, unavoidable)
	ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, data.to_vec())
		.ok_or_else(|| Error::from_reason("Failed to create image buffer"))
}

/// Compute luminance histogram from RgbImage using sampling for large images
/// For images > 1M pixels, sample every Nth pixel to reduce computation
fn compute_histogram_sampled(img: &RgbImage) -> [u64; 256] {
	let mut histogram = [0u64; 256];
	let total_pixels = img.width() as usize * img.height() as usize;

	// Sample every Nth pixel for large images (target ~500k samples max)
	let step = if total_pixels > 500_000 {
		(total_pixels / 500_000).max(1)
	} else {
		1
	};

	for (i, pixel) in img.pixels().enumerate() {
		if i % step == 0 {
			// Fast integer luminance approximation: (77*R + 150*G + 29*B) >> 8
			let luminance =
				((77 * pixel[0] as u32 + 150 * pixel[1] as u32 + 29 * pixel[2] as u32) >> 8) as u8;
			histogram[luminance as usize] += 1;
		}
	}

	histogram
}

/// Convert histogram to Cumulative Distribution Function (CDF)
fn histogram_to_cdf(histogram: &[u64; 256]) -> [f64; 256] {
	let total: u64 = histogram.iter().sum();
	if total == 0 {
		return [0.0; 256];
	}

	let mut cdf = [0.0f64; 256];
	let mut cumsum = 0u64;
	let inv_total = 1.0 / total as f64;

	for (i, &count) in histogram.iter().enumerate() {
		cumsum += count;
		cdf[i] = cumsum as f64 * inv_total;
	}

	cdf
}

/// Build tone curve mapping from source CDF to target CDF
/// Uses binary search for better performance
fn build_tone_curve(source_cdf: &[f64; 256], target_cdf: &[f64; 256]) -> [u8; 256] {
	let mut curve = [0u8; 256];

	for i in 0..256 {
		let source_percentile = source_cdf[i];

		// Binary search for closest match in target CDF
		let mut low = 0usize;
		let mut high = 255usize;

		while low < high {
			let mid = (low + high) / 2;
			if target_cdf[mid] < source_percentile {
				low = mid + 1;
			} else {
				high = mid;
			}
		}

		// Check if low-1 is closer
		if low > 0
			&& (source_percentile - target_cdf[low - 1]).abs()
				< (source_percentile - target_cdf[low]).abs()
		{
			curve[i] = (low - 1) as u8;
		} else {
			curve[i] = low as u8;
		}
	}

	curve
}

/// Apply tone curve IN-PLACE to an RgbImage (no allocation)
fn apply_tone_curve_inplace(img: &mut RgbImage, curve: &[u8; 256]) {
	for pixel in img.pixels_mut() {
		pixel[0] = curve[pixel[0] as usize];
		pixel[1] = curve[pixel[1] as usize];
		pixel[2] = curve[pixel[2] as usize];
	}
}

/// Encode RgbImage as JPEG (no conversion needed)
fn encode_jpeg_rgb(img: &RgbImage, quality: u8) -> Result<Vec<u8>> {
	let mut buffer = Vec::with_capacity(img.width() as usize * img.height() as usize / 4);

	let mut encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
	encoder
		.encode(
			img.as_raw(),
			img.width(),
			img.height(),
			image::ExtendedColorType::Rgb8,
		)
		.map_err(|e| Error::from_reason(format!("Failed to encode JPEG: {}", e)))?;

	Ok(buffer)
}

/// Process a RAW file with histogram matching to embedded preview
/// Optimized version with minimal copies
#[napi]
pub fn process_raw_with_histogram_matching(file_path: String) -> Result<RawProcessingResult> {
	let start = std::time::Instant::now();

	// Read file into memory once
	let file_data = read_file(&file_path)?;

	// Open RAW file for preview extraction
	let mut raw = RawImage::open(&file_data)
		.map_err(|e| Error::from_reason(format!("Failed to open RAW file: {}", e)))?;

	// Extract embedded preview (RgbImage for histogram, JPEG bytes for CLIP)
	let preview_data = extract_preview_with_jpeg(&mut raw);
	let (preview_img, preview_jpeg) = match preview_data {
		Some((img, jpeg)) => (Some(img), Some(jpeg)),
		None => (None, None),
	};

	// Re-open for processing (rsraw consumes RawImage on process)
	let mut raw = RawImage::open(&file_data)
		.map_err(|e| Error::from_reason(format!("Failed to reopen RAW file: {}", e)))?;

	// Process RAW directly to RgbImage
	let mut processed = process_raw_to_rgb(&mut raw)?;
	let (width, height) = (processed.width(), processed.height());

	// Apply histogram matching if we have a preview
	let histogram_matched = if let Some(ref preview) = preview_img {
		let min_dim = preview.width().min(preview.height());
		if min_dim >= 800 {
			// Compute histograms (sampled for performance)
			let source_hist = compute_histogram_sampled(&processed);
			let target_hist = compute_histogram_sampled(preview);

			// Build CDFs and tone curve
			let source_cdf = histogram_to_cdf(&source_hist);
			let target_cdf = histogram_to_cdf(&target_hist);
			let curve = build_tone_curve(&source_cdf, &target_cdf);

			// Apply curve IN-PLACE (no allocation!)
			apply_tone_curve_inplace(&mut processed, &curve);
			true
		} else {
			false
		}
	} else {
		false
	};

	// Encode as JPEG directly from RgbImage
	let jpeg_data = encode_jpeg_rgb(&processed, 90)?;

	let processing_time_ms = start.elapsed().as_millis() as u32;

	Ok(RawProcessingResult {
		width,
		height,
		jpeg_data: jpeg_data.into(),
		preview_jpeg: preview_jpeg.map(|v| v.into()),
		histogram_matched,
		processing_time_ms,
	})
}

/// Process a RAW file without histogram matching
#[napi]
pub fn process_raw_neutral_only(file_path: String) -> Result<RawProcessingResult> {
	let start = std::time::Instant::now();

	let file_data = read_file(&file_path)?;

	let mut raw = RawImage::open(&file_data)
		.map_err(|e| Error::from_reason(format!("Failed to open RAW file: {}", e)))?;

	let processed = process_raw_to_rgb(&mut raw)?;
	let (width, height) = (processed.width(), processed.height());

	let jpeg_data = encode_jpeg_rgb(&processed, 90)?;

	let processing_time_ms = start.elapsed().as_millis() as u32;

	Ok(RawProcessingResult {
		width,
		height,
		jpeg_data: jpeg_data.into(),
		preview_jpeg: None,
		histogram_matched: false,
		processing_time_ms,
	})
}

/// Process a RAW file at reduced resolution for faster thumbnails
/// Uses half-size demosaic (4x fewer pixels)
#[napi]
pub fn process_raw_half_size(file_path: String) -> Result<RawProcessingResult> {
	let start = std::time::Instant::now();

	let file_data = read_file(&file_path)?;

	let mut raw = RawImage::open(&file_data)
		.map_err(|e| Error::from_reason(format!("Failed to open RAW file: {}", e)))?;

	// Enable half-size mode via libraw params
	{
		let raw_data = raw.as_mut();
		raw_data.params.half_size = 1;
	}

	raw.unpack()
		.map_err(|e| Error::from_reason(format!("Failed to unpack RAW: {}", e)))?;

	let processed = raw
		.process::<BIT_DEPTH_8>()
		.map_err(|e| Error::from_reason(format!("Failed to process RAW: {}", e)))?;

	let width = processed.width();
	let height = processed.height();
	let data: &[u8] = &processed;

	let img = ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, data.to_vec())
		.ok_or_else(|| Error::from_reason("Failed to create image buffer"))?;

	let jpeg_data = encode_jpeg_rgb(&img, 85)?;

	let processing_time_ms = start.elapsed().as_millis() as u32;

	Ok(RawProcessingResult {
		width,
		height,
		jpeg_data: jpeg_data.into(),
		preview_jpeg: None,
		histogram_matched: false,
		processing_time_ms,
	})
}

/// Batch process multiple RAW files in parallel using Rayon
/// Returns results in the same order as input paths
#[napi]
pub fn process_raw_batch(file_paths: Vec<String>) -> Vec<RawProcessingResult> {
	file_paths
		.par_iter()
		.map(|path| {
			process_raw_with_histogram_matching(path.clone()).unwrap_or_else(|_| {
				// Return a placeholder for failed files
				RawProcessingResult {
					width: 0,
					height: 0,
					jpeg_data: Buffer::from(Vec::new()),
					preview_jpeg: None,
					histogram_matched: false,
					processing_time_ms: 0,
				}
			})
		})
		.collect()
}

/// Extract the embedded JPEG preview from a RAW file
#[napi]
pub fn extract_raw_preview(file_path: String) -> Result<Option<Buffer>> {
	let file_data = read_file(&file_path)?;

	let mut raw = RawImage::open(&file_data)
		.map_err(|e| Error::from_reason(format!("Failed to open RAW file: {}", e)))?;

	let thumbs = match raw.extract_thumbs() {
		Ok(t) => t,
		Err(_) => return Ok(None),
	};

	let jpeg_thumb = thumbs
		.iter()
		.filter(|t| matches!(t.format, ThumbFormat::Jpeg))
		.max_by_key(|t| t.width as u32 * t.height as u32);

	Ok(jpeg_thumb.map(|t| t.data.clone().into()))
}

/// Complete result of RAW processing with all metadata
/// No JPEG data is returned - only metadata to minimize JS/Rust data transfer
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
	/// Whether histogram matching was applied
	pub histogram_matched: bool,
	/// Processing time in milliseconds
	pub processing_time_ms: u32,
	/// Whether processing succeeded
	pub success: bool,
	/// Error message if processing failed
	pub error: Option<String>,
}

/// Process a single RAW file completely in Rust
/// Does EXIF extraction, demosaic, histogram matching, CLIP, phash, and thumbnails in one call
pub fn process_raw_complete_internal(
	file_path: &str,
	relative_path: &str,
	thumbnails_dir: &str,
) -> RawCompleteResult {
	let start = std::time::Instant::now();

	// Extract EXIF data first (for orientation)
	let exif = extract_exif_internal(file_path);
	let orientation = exif.as_ref().and_then(|e| e.orientation);

	// Read file into memory once
	let file_data = match fs::read(file_path) {
		Ok(data) => data,
		Err(e) => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				histogram_matched: false,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some(format!("Failed to read file: {}", e)),
			};
		}
	};

	// Open RAW file for preview extraction
	let mut raw = match RawImage::open(&file_data) {
		Ok(r) => r,
		Err(e) => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				histogram_matched: false,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some(format!("Failed to open RAW: {}", e)),
			};
		}
	};

	// Extract embedded preview (RgbImage for histogram, DynamicImage for CLIP)
	let preview_data = extract_preview_with_jpeg(&mut raw);
	let (preview_rgb, preview_for_clip) = match preview_data {
		Some((rgb, jpeg_bytes)) => {
			// Decode preview JPEG to DynamicImage for CLIP
			let clip_img = image::load_from_memory(&jpeg_bytes).ok();
			(Some(rgb), clip_img)
		}
		None => (None, None),
	};

	// Re-open for processing (rsraw consumes RawImage on process)
	let mut raw = match RawImage::open(&file_data) {
		Ok(r) => r,
		Err(e) => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				histogram_matched: false,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some(format!("Failed to reopen RAW: {}", e)),
			};
		}
	};

	// Process RAW
	if let Err(e) = raw.unpack() {
		return RawCompleteResult {
			width: 0,
			height: 0,
			phash: None,
			clip_embedding: None,
			exif,
			histogram_matched: false,
			processing_time_ms: start.elapsed().as_millis() as u32,
			success: false,
			error: Some(format!("Failed to unpack RAW: {}", e)),
		};
	}

	let processed = match raw.process::<BIT_DEPTH_8>() {
		Ok(p) => p,
		Err(e) => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				histogram_matched: false,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some(format!("Failed to process RAW: {}", e)),
			};
		}
	};

	let width = processed.width();
	let height = processed.height();
	let data: &[u8] = &processed;

	let mut rgb_img = match ImageBuffer::<Rgb<u8>, _>::from_raw(width, height, data.to_vec()) {
		Some(img) => img,
		None => {
			return RawCompleteResult {
				width: 0,
				height: 0,
				phash: None,
				clip_embedding: None,
				exif,
				histogram_matched: false,
				processing_time_ms: start.elapsed().as_millis() as u32,
				success: false,
				error: Some("Failed to create image buffer".to_string()),
			};
		}
	};

	// Apply histogram matching if we have a preview
	let histogram_matched = if let Some(ref preview) = preview_rgb {
		let min_dim = preview.width().min(preview.height());
		if min_dim >= 800 {
			let source_hist = compute_histogram_sampled(&rgb_img);
			let target_hist = compute_histogram_sampled(preview);
			let source_cdf = histogram_to_cdf(&source_hist);
			let target_cdf = histogram_to_cdf(&target_hist);
			let curve = build_tone_curve(&source_cdf, &target_cdf);
			apply_tone_curve_inplace(&mut rgb_img, &curve);
			true
		} else {
			false
		}
	} else {
		false
	};

	// Convert to DynamicImage for phash and thumbnails
	let mut dynamic_img = DynamicImage::ImageRgb8(rgb_img);

	// Apply EXIF orientation if provided
	if let Some(orient) = orientation {
		dynamic_img = match orient {
			2 => dynamic_img.fliph(),
			3 => dynamic_img.rotate180(),
			4 => dynamic_img.flipv(),
			5 => dynamic_img.rotate270().fliph(),
			6 => dynamic_img.rotate90(),
			7 => dynamic_img.rotate90().fliph(),
			8 => dynamic_img.rotate270(),
			_ => dynamic_img,
		};
	}

	// Generate phash from processed image
	let phash = Some(generate_phash_from_image(&dynamic_img));

	// Generate thumbnails
	if let Err(e) = generate_all_thumbnails_internal(&dynamic_img, relative_path, thumbnails_dir) {
		eprintln!("Warning: Failed to generate thumbnails: {}", e);
	}

	// Generate CLIP embedding from preview (or fall back to processed image)
	let clip_embedding = if let Some(preview_img) = preview_for_clip {
		generate_clip_embedding_from_image(preview_img)
			.map(|v| v.iter().map(|&f| f as f64).collect())
	} else {
		// Fall back to processed image if no preview
		generate_clip_embedding_from_image(dynamic_img)
			.map(|v| v.iter().map(|&f| f as f64).collect())
	};

	RawCompleteResult {
		width,
		height,
		phash,
		clip_embedding,
		exif,
		histogram_matched,
		processing_time_ms: start.elapsed().as_millis() as u32,
		success: true,
		error: None,
	}
}

/// Process a single RAW file completely in Rust - all processing in one call
/// Extracts EXIF, processes RAW, generates CLIP, phash, and thumbnails
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
	file_paths
		.par_iter()
		.enumerate()
		.map(|(i, path)| {
			let rel_path = relative_paths.get(i).map(|s| s.as_str()).unwrap_or("");
			process_raw_complete_internal(path, rel_path, &thumbnails_dir)
		})
		.collect()
}
