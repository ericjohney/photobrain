use image::{DynamicImage, ImageReader};
use image_hasher::{HashAlg, HasherConfig};
use napi_derive::napi;

#[napi]
pub fn perceptual_hash(file_path: String) -> napi::Result<String> {
  let img = ImageReader::open(&file_path)
    .map_err(|e| napi::Error::from_reason(format!("Failed to open image: {}", e)))?
    .decode()
    .map_err(|e| napi::Error::from_reason(format!("Failed to decode image: {}", e)))?;

  // Create hasher with DCT-based perceptual hash (pHash)
  let hasher = HasherConfig::new()
    .hash_alg(HashAlg::DoubleGradient)
    .hash_size(8, 8)
    .to_hasher();

  let hash = hasher.hash_image(&img);

  // Convert to base64 string
  Ok(hash.to_base64())
}

pub fn generate_phash_from_image(img: &DynamicImage) -> String {
  let hasher = HasherConfig::new()
    .hash_alg(HashAlg::DoubleGradient)
    .hash_size(8, 8)
    .to_hasher();

  let hash = hasher.hash_image(img);
  hash.to_base64()
}

/// Generate perceptual hash from a file path
/// Alias for perceptual_hash with a more consistent naming scheme
#[napi]
pub fn generate_phash(file_path: String) -> napi::Result<String> {
  perceptual_hash(file_path)
}
