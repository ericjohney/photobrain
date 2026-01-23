use image::{DynamicImage, RgbImage, RgbaImage};
use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
use std::path::Path;

/// Decode a HEIF/HEIC file to a DynamicImage
pub fn decode_heif(file_path: &str) -> Result<DynamicImage, String> {
	let path = Path::new(file_path);
	if !path.exists() {
		return Err(format!("File not found: {}", file_path));
	}

	// Initialize libheif
	let lib_heif = LibHeif::new();

	// Create HEIF context and read from file
	let ctx = HeifContext::read_from_file(file_path)
		.map_err(|e| format!("Failed to read HEIF file: {}", e))?;

	// Get the primary image handle
	let handle = ctx
		.primary_image_handle()
		.map_err(|e| format!("Failed to get primary image handle: {}", e))?;

	let width = handle.width();
	let height = handle.height();
	let has_alpha = handle.has_alpha_channel();

	// Decode the image to RGB or RGBA
	let image = if has_alpha {
		// Decode with alpha channel
		let decoded = lib_heif
			.decode(&handle, ColorSpace::Rgb(RgbChroma::Rgba), None)
			.map_err(|e| format!("Failed to decode HEIF image: {}", e))?;

		let plane = decoded
			.planes()
			.interleaved
			.ok_or_else(|| "Failed to get interleaved plane".to_string())?;

		let stride = plane.stride;
		let data = plane.data;

		// Convert to RgbaImage
		let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);
		for y in 0..height {
			let row_start = (y as usize) * stride;
			for x in 0..width {
				let pixel_start = row_start + (x as usize) * 4;
				rgba_data.push(data[pixel_start]); // R
				rgba_data.push(data[pixel_start + 1]); // G
				rgba_data.push(data[pixel_start + 2]); // B
				rgba_data.push(data[pixel_start + 3]); // A
			}
		}

		RgbaImage::from_raw(width, height, rgba_data)
			.map(DynamicImage::ImageRgba8)
			.ok_or_else(|| "Failed to create RGBA image".to_string())?
	} else {
		// Decode without alpha channel
		let decoded = lib_heif
			.decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None)
			.map_err(|e| format!("Failed to decode HEIF image: {}", e))?;

		let plane = decoded
			.planes()
			.interleaved
			.ok_or_else(|| "Failed to get interleaved plane".to_string())?;

		let stride = plane.stride;
		let data = plane.data;

		// Convert to RgbImage
		let mut rgb_data = Vec::with_capacity((width * height * 3) as usize);
		for y in 0..height {
			let row_start = (y as usize) * stride;
			for x in 0..width {
				let pixel_start = row_start + (x as usize) * 3;
				rgb_data.push(data[pixel_start]); // R
				rgb_data.push(data[pixel_start + 1]); // G
				rgb_data.push(data[pixel_start + 2]); // B
			}
		}

		RgbImage::from_raw(width, height, rgb_data)
			.map(DynamicImage::ImageRgb8)
			.ok_or_else(|| "Failed to create RGB image".to_string())?
	};

	Ok(image)
}

/// Check if a file is a HEIF/HEIC file
pub fn is_heif_file(file_path: &str) -> bool {
	let lower = file_path.to_lowercase();
	lower.ends_with(".heic") || lower.ends_with(".heif")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_is_heif_file() {
		assert!(is_heif_file("photo.HEIC"));
		assert!(is_heif_file("photo.heic"));
		assert!(is_heif_file("photo.HEIF"));
		assert!(is_heif_file("photo.heif"));
		assert!(!is_heif_file("photo.jpg"));
		assert!(!is_heif_file("photo.png"));
	}
}
