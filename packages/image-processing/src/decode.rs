use image::{DynamicImage, ImageDecoder, ImageReader, metadata::Orientation};
use std::io::Cursor;

use crate::batch::is_standard_image;
use crate::exif::extract_exif_internal;
use crate::heif::{decode_heif, is_heif_by_magic_bytes, is_heif_file};
use crate::orientation::apply_orientation;
use crate::preview::{extract_preview, is_raw_file};

/// HEIF by extension or magic bytes (iOS can save HEIC data under a `.JPEG` name).
pub(crate) fn is_heif_source(file_path: &str) -> bool {
  is_heif_file(file_path) || is_heif_by_magic_bytes(file_path)
}

/// Pixels decoded the way scans decode a source, before EXIF orientation.
pub(crate) struct DecodedSource {
  pub image: DynamicImage,
  /// Orientation the standard-image decoder read from the file's own EXIF; `None` for
  /// HEIF and RAW previews (a RAW's orientation belongs to the RAW, not its preview).
  pub embedded_orientation: Option<u32>,
}

/// HEIF through libheif (which already applies its container transforms), RAW through
/// its embedded JPEG preview, and standard formats through the `image` crate.
pub(crate) fn decode_source(file_path: &str, is_heif: bool) -> Result<DecodedSource, String> {
  if is_heif {
    return decode_heif(file_path).map(|image| DecodedSource {
      image,
      embedded_orientation: None,
    });
  }
  if is_raw_file(file_path) {
    let preview = extract_preview(file_path).ok_or("No embedded preview found")?;
    let image = ImageReader::new(Cursor::new(preview))
      .with_guessed_format()
      .map_err(|e| e.to_string())?
      .decode()
      .map_err(|e| e.to_string())?;
    return Ok(DecodedSource {
      image,
      embedded_orientation: None,
    });
  }
  if !is_standard_image(file_path) {
    return Err("Unsupported file type".to_string());
  }
  let mut decoder = ImageReader::open(file_path)
    .map_err(|e| e.to_string())?
    .into_decoder()
    .map_err(|e| e.to_string())?;
  // Formats without orientation support report NoTransforms; treat a read error the same.
  let embedded_orientation = decoder
    .orientation()
    .ok()
    .filter(|orientation| *orientation != Orientation::NoTransforms)
    .map(|orientation| u32::from(orientation.to_exif()));
  let image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
  Ok(DecodedSource {
    image,
    embedded_orientation,
  })
}

/// `decode_source` plus a caller-supplied EXIF orientation (scans pass their prefetched
/// ExifTool value). HEIF is never rotated again because libheif already applied irot/imir;
/// applying the EXIF value as well would double-rotate it.
pub(crate) fn decode_with_orientation(
  file_path: &str,
  is_heif: bool,
  orientation: Option<u32>,
) -> Result<DynamicImage, String> {
  let image = decode_source(file_path, is_heif)?.image;
  Ok(if is_heif {
    image
  } else {
    apply_orientation(image, orientation)
  })
}

/// The shared decode path with the EXIF orientation still to be applied, resolved per
/// source type: standard images from the EXIF their decoder already parsed, RAW files
/// from the RAW's metadata through ExifTool, and nothing for HEIF (libheif applied its
/// transforms). Callers may resize before orienting, since a square bound is
/// rotation-invariant and rotating the smaller image is cheaper.
pub(crate) fn decode_unoriented(file_path: &str) -> Result<(DynamicImage, Option<u32>), String> {
  let is_heif = is_heif_source(file_path);
  let decoded = decode_source(file_path, is_heif)?;
  let orientation = if is_heif {
    None
  } else if is_raw_file(file_path) {
    extract_exif_internal(file_path).and_then(|exif| exif.orientation)
  } else {
    decoded.embedded_orientation
  };
  Ok((decoded.image, orientation))
}
