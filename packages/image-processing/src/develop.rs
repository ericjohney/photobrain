//! Full RAW development through `raw-develop` (Apple RawCamera-equivalent pipeline), for
//! the loupe's "Developed" view. Scans and thumbnails keep using the embedded preview.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// A developed RAW: a Display P3 JPEG (ICC embedded) at full resolution, with its size.
#[napi(object)]
pub struct DevelopedRaw {
  pub jpeg: Buffer,
  pub width: u32,
  pub height: u32,
}

/// Develop a RAW file at full resolution (orientation applied) and encode it as a JPEG
/// tagged Display P3. Fails for formats or cameras `raw-develop` does not support.
#[napi]
pub fn render_developed_raw(path: String, quality: u32) -> napi::Result<DevelopedRaw> {
  if !(1..=100).contains(&quality) {
    return Err(napi::Error::from_reason("quality must be between 1 and 100"));
  }
  develop_internal(&path, quality as u8).map_err(napi::Error::from_reason)
}

fn develop_internal(path: &str, quality: u8) -> Result<DevelopedRaw, String> {
  use raw_develop::{DevelopSettings, Negative, Options, develop, encode};
  let neg = Negative::open(path).map_err(|e| e.to_string())?;
  let out = develop(&neg, &DevelopSettings::default(), &Options::default()).map_err(|e| e.to_string())?;
  let jpeg = encode::encode(&out.image, encode::Format::Jpeg(quality)).map_err(|e| e.to_string())?;
  Ok(DevelopedRaw {
    jpeg: jpeg.into(),
    width: out.image.width as u32,
    height: out.image.height as u32,
  })
}
