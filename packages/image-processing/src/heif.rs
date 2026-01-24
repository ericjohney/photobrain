use image::{DynamicImage, RgbImage, RgbaImage};
use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};
use std::fs::File;
use std::io::Read;
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

/// Check if a file is a HEIF/HEIC file by extension
pub fn is_heif_file(file_path: &str) -> bool {
	let lower = file_path.to_lowercase();
	lower.ends_with(".heic") || lower.ends_with(".heif")
}

/// Check if file is a HEIF/HEIC file by checking magic bytes
/// This handles mislabeled files (e.g., iOS saving HEIC as .JPEG)
/// HEIF files have "ftyp" at offset 4 followed by heic/heif/heix/mif1/msf1
pub fn is_heif_by_magic_bytes(file_path: &str) -> bool {
	let mut file = match File::open(file_path) {
		Ok(f) => f,
		Err(_) => return false,
	};

	// Read first 12 bytes to check for HEIF signature
	let mut buffer = [0u8; 12];
	if file.read_exact(&mut buffer).is_err() {
		return false;
	}

	// HEIF files have "ftyp" at offset 4
	if &buffer[4..8] != b"ftyp" {
		return false;
	}

	// Check for HEIF brand identifiers at offset 8
	// Common brands: heic, heix, hevc, hevx, heim, heis, hevm, hevs, mif1, msf1
	let brand = &buffer[8..12];
	matches!(
		brand,
		b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"hevm" | b"hevs" | b"mif1"
			| b"msf1" | b"avif"
	)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;
	use tempfile::NamedTempFile;

	#[test]
	fn test_is_heif_file() {
		assert!(is_heif_file("photo.HEIC"));
		assert!(is_heif_file("photo.heic"));
		assert!(is_heif_file("photo.HEIF"));
		assert!(is_heif_file("photo.heif"));
		assert!(!is_heif_file("photo.jpg"));
		assert!(!is_heif_file("photo.png"));
	}

	#[test]
	fn test_is_heif_by_magic_bytes() {
		// Create a temp file with HEIC magic bytes
		let mut temp_file = NamedTempFile::new().unwrap();
		// HEIF header: 4 bytes size + "ftyp" + "heic"
		let heic_header: [u8; 12] = [0x00, 0x00, 0x00, 0x24, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c'];
		temp_file.write_all(&heic_header).unwrap();
		temp_file.flush().unwrap();

		assert!(is_heif_by_magic_bytes(temp_file.path().to_str().unwrap()));

		// Create a temp file with JPEG magic bytes
		let mut jpeg_file = NamedTempFile::new().unwrap();
		let jpeg_header: [u8; 12] = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00, 0x01];
		jpeg_file.write_all(&jpeg_header).unwrap();
		jpeg_file.flush().unwrap();

		assert!(!is_heif_by_magic_bytes(jpeg_file.path().to_str().unwrap()));
	}
}
