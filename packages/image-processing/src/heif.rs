use image::{DynamicImage, RgbImage, RgbaImage};
use libheif_rs::{ColorSpace, HeifContext, RgbChroma};
use std::path::Path;

/// Check if a file path has a HEIF/HEIC extension
pub fn is_heif_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext_lower = ext.to_lowercase();
            ext_lower == "heif" || ext_lower == "heic"
        })
        .unwrap_or(false)
}

/// Decode a HEIF/HEIC file and return a DynamicImage
pub fn decode_heif(path: &Path) -> Result<DynamicImage, String> {
    let ctx = HeifContext::read_from_file(path.to_str().ok_or("Invalid path")?)
        .map_err(|e| format!("Failed to read HEIF file: {}", e))?;

    let handle = ctx
        .primary_image_handle()
        .map_err(|e| format!("Failed to get primary image handle: {}", e))?;

    let width = handle.width() as u32;
    let height = handle.height() as u32;
    let has_alpha = handle.has_alpha_channel();

    // Decode the image to RGB or RGBA depending on alpha channel
    if has_alpha {
        let image = handle
            .decode(ColorSpace::Rgb(RgbChroma::Rgba), None)
            .map_err(|e| format!("Failed to decode HEIF image: {}", e))?;

        let planes = image.planes();
        let interleaved = planes
            .interleaved
            .ok_or("Failed to get interleaved plane data")?;

        let stride = interleaved.stride;
        let data = interleaved.data;

        // Convert to contiguous RGBA data (remove stride padding if any)
        let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            let row_start = (y as usize) * stride;
            let row_end = row_start + (width as usize * 4);
            rgba_data.extend_from_slice(&data[row_start..row_end]);
        }

        let img = RgbaImage::from_raw(width, height, rgba_data)
            .ok_or("Failed to create RGBA image from raw data")?;

        Ok(DynamicImage::ImageRgba8(img))
    } else {
        let image = handle
            .decode(ColorSpace::Rgb(RgbChroma::Rgb), None)
            .map_err(|e| format!("Failed to decode HEIF image: {}", e))?;

        let planes = image.planes();
        let interleaved = planes
            .interleaved
            .ok_or("Failed to get interleaved plane data")?;

        let stride = interleaved.stride;
        let data = interleaved.data;

        // Convert to contiguous RGB data (remove stride padding if any)
        let mut rgb_data = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            let row_start = (y as usize) * stride;
            let row_end = row_start + (width as usize * 3);
            rgb_data.extend_from_slice(&data[row_start..row_end]);
        }

        let img = RgbImage::from_raw(width, height, rgb_data)
            .ok_or("Failed to create RGB image from raw data")?;

        Ok(DynamicImage::ImageRgb8(img))
    }
}
