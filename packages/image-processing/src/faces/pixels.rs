//! Borrowable 8-bit RGB(A) pixels for the face pipeline. WebP thumbnails decode through
//! the bundled libwebp (faster than the pure-Rust decoder) without an extra copy; other
//! formats go through the `image` crate. Pixels are used as stored: the scan already
//! wrote oriented thumbnails, so no EXIF orientation is applied here.

use std::fs;

use image::RgbImage;

enum Storage {
  WebP(webp::WebPImage),
  Owned(Vec<u8>),
}

pub(crate) struct Pixels {
  storage: Storage,
  width: u32,
  height: u32,
  /// 3 (RGB) or 4 (RGBA; alpha ignored).
  channels: usize,
}

impl Pixels {
  pub fn open(path: &str) -> Result<Self, String> {
    let bytes = fs::read(path).map_err(|error| format!("Failed to read {path}: {error}"))?;
    Self::decode(&bytes).map_err(|error| format!("{path}: {error}"))
  }

  pub fn decode(bytes: &[u8]) -> Result<Self, String> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
      let decoded = webp::Decoder::new(bytes)
        .decode()
        .ok_or("Failed to decode WebP (corrupt or animated)")?;
      let (width, height) = (decoded.width(), decoded.height());
      let channels = if decoded.is_alpha() { 4 } else { 3 };
      return Self::checked(Storage::WebP(decoded), width, height, channels);
    }
    let rgb = image::load_from_memory(bytes)
      .map_err(|error| format!("Failed to decode image: {error}"))?
      .into_rgb8();
    Ok(Self::from_rgb(rgb))
  }

  pub fn from_rgb(image: RgbImage) -> Self {
    let (width, height) = image.dimensions();
    Self {
      storage: Storage::Owned(image.into_raw()),
      width,
      height,
      channels: 3,
    }
  }

  fn checked(storage: Storage, width: u32, height: u32, channels: usize) -> Result<Self, String> {
    let pixels = Self {
      storage,
      width,
      height,
      channels,
    };
    if width == 0 || height == 0 {
      return Err("Image has no pixels".to_string());
    }
    if pixels.data().len() != width as usize * height as usize * channels {
      return Err("Decoded pixel buffer has an unexpected size".to_string());
    }
    Ok(pixels)
  }

  pub fn width(&self) -> u32 {
    self.width
  }

  pub fn height(&self) -> u32 {
    self.height
  }

  pub fn channels(&self) -> usize {
    self.channels
  }

  pub fn data(&self) -> &[u8] {
    match &self.storage {
      Storage::WebP(image) => image,
      Storage::Owned(bytes) => bytes,
    }
  }

  /// One row of `width * channels` bytes.
  pub fn row(&self, y: u32) -> &[u8] {
    let stride = self.width as usize * self.channels;
    let start = y as usize * stride;
    &self.data()[start..start + stride]
  }
}
