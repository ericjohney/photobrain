use image::ImageReader;
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

pub fn generate_phash(file_path: &str) -> Option<String> {
  match ImageReader::open(file_path) {
    Ok(reader) => match reader.decode() {
      Ok(img) => {
        let hasher = HasherConfig::new()
          .hash_alg(HashAlg::DoubleGradient)
          .hash_size(8, 8)
          .to_hasher();

        let hash = hasher.hash_image(&img);
        Some(hash.to_base64())
      }
      Err(_) => None,
    },
    Err(_) => None,
  }
}
