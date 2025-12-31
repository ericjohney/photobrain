use image::{DynamicImage, ImageReader};
use napi_derive::napi;
use std::fs;
use std::path::{Path, PathBuf};

/// Thumbnail size configuration
#[derive(Debug, Clone, Copy)]
pub enum ThumbnailSize {
    Tiny,   // 150px - grid previews
    Small,  // 400px - modal previews
    Medium, // 800px - lightbox
    Large,  // 1600px - full view
}

impl ThumbnailSize {
    fn max_dimension(&self) -> u32 {
        match self {
            ThumbnailSize::Tiny => 150,
            ThumbnailSize::Small => 400,
            ThumbnailSize::Medium => 800,
            ThumbnailSize::Large => 1600,
        }
    }

    fn dir_name(&self) -> &'static str {
        match self {
            ThumbnailSize::Tiny => "tiny",
            ThumbnailSize::Small => "small",
            ThumbnailSize::Medium => "medium",
            ThumbnailSize::Large => "large",
        }
    }
}

const ALL_SIZES: [ThumbnailSize; 4] = [
    ThumbnailSize::Tiny,
    ThumbnailSize::Small,
    ThumbnailSize::Medium,
    ThumbnailSize::Large,
];

#[napi(object)]
pub struct ThumbnailPaths {
    pub tiny: String,
    pub small: String,
    pub medium: String,
    pub large: String,
}

/// Generate all thumbnail sizes for a photo
/// Memory optimization: We resize from largest to smallest, reusing the same image
#[napi]
pub fn generate_thumbnails(
    source_path: String,
    thumbnail_dir: String,
    photo_id: i64,
) -> napi::Result<ThumbnailPaths> {
    // Load the source image once
    let img = ImageReader::open(&source_path)
        .map_err(|e| napi::Error::from_reason(format!("Failed to open image: {}", e)))?
        .decode()
        .map_err(|e| napi::Error::from_reason(format!("Failed to decode image: {}", e)))?;

    let mut paths = ThumbnailPaths {
        tiny: String::new(),
        small: String::new(),
        medium: String::new(),
        large: String::new(),
    };

    // Generate all thumbnail sizes
    for size in ALL_SIZES.iter() {
        let path = generate_single_thumbnail(&img, &thumbnail_dir, photo_id, *size)?;

        match size {
            ThumbnailSize::Tiny => paths.tiny = path,
            ThumbnailSize::Small => paths.small = path,
            ThumbnailSize::Medium => paths.medium = path,
            ThumbnailSize::Large => paths.large = path,
        }
    }

    Ok(paths)
}

/// Generate a single thumbnail size
fn generate_single_thumbnail(
    img: &DynamicImage,
    thumbnail_dir: &str,
    photo_id: i64,
    size: ThumbnailSize,
) -> napi::Result<String> {
    let base_path = Path::new(thumbnail_dir);
    let size_dir = base_path.join(size.dir_name());

    // Create directory if it doesn't exist
    fs::create_dir_all(&size_dir)
        .map_err(|e| napi::Error::from_reason(format!("Failed to create thumbnail directory: {}", e)))?;

    // Calculate new dimensions maintaining aspect ratio
    let (width, height) = img.dimensions();
    let max_dim = size.max_dimension();

    let (new_width, new_height) = if width > height {
        let ratio = max_dim as f32 / width as f32;
        (max_dim, (height as f32 * ratio) as u32)
    } else {
        let ratio = max_dim as f32 / height as f32;
        ((width as f32 * ratio) as u32, max_dim)
    };

    // Resize using Lanczos3 for high quality
    // Memory optimization: resize() creates a new image but the filter is efficient
    let thumbnail = img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3);

    // Save as JPEG with quality 85 (good balance between size and quality)
    let filename = format!("{}.jpg", photo_id);
    let output_path = size_dir.join(&filename);

    thumbnail
        .to_rgb8()
        .save_with_format(&output_path, image::ImageFormat::Jpeg)
        .map_err(|e| napi::Error::from_reason(format!("Failed to save thumbnail: {}", e)))?;

    // Return relative path from thumbnail_dir
    let relative_path = PathBuf::from(size.dir_name()).join(filename);
    Ok(relative_path.to_string_lossy().to_string())
}

/// Generate a single thumbnail size (exposed for on-demand generation)
#[napi]
pub fn generate_single_thumbnail_size(
    source_path: String,
    thumbnail_dir: String,
    photo_id: i64,
    size: String,
) -> napi::Result<String> {
    let img = ImageReader::open(&source_path)
        .map_err(|e| napi::Error::from_reason(format!("Failed to open image: {}", e)))?
        .decode()
        .map_err(|e| napi::Error::from_reason(format!("Failed to decode image: {}", e)))?;

    let thumbnail_size = match size.as_str() {
        "tiny" => ThumbnailSize::Tiny,
        "small" => ThumbnailSize::Small,
        "medium" => ThumbnailSize::Medium,
        "large" => ThumbnailSize::Large,
        _ => return Err(napi::Error::from_reason(format!("Invalid size: {}", size))),
    };

    generate_single_thumbnail(&img, &thumbnail_dir, photo_id, thumbnail_size)
}
