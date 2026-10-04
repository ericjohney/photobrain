use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, RgbImage};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use crate::decode::decode_unoriented;
use crate::orientation::apply_orientation;

/// Fit inside a `max_edge` square without upscaling: the long edge becomes exactly
/// `max_edge` and the short edge is rounded from the exact ratio (at least 1).
fn fit_long_edge((width, height): (u32, u32), max_edge: u32) -> (u32, u32) {
  let long = width.max(height);
  if long <= max_edge {
    return (width, height);
  }
  let scale = |edge: u32| {
    ((u64::from(edge) * u64::from(max_edge) + u64::from(long) / 2) / u64::from(long)).max(1) as u32
  };
  if width >= height {
    (max_edge, scale(height))
  } else {
    (scale(width), max_edge)
  }
}

/// Render a shareable JPEG from any supported source through the scan decode path
/// (HEIF, RAW embedded preview, EXIF orientation applied to the pixels). The long edge
/// is fitted to `max_edge` with Lanczos3 only when it is larger (never upscaled). Alpha
/// is composited over white and every format becomes 8-bit RGB. The output carries only
/// a JFIF header: no EXIF (so no GPS or orientation), XMP, or ICC segments.
#[napi]
pub fn render_export_jpeg(path: String, max_edge: u32, quality: u32) -> napi::Result<Buffer> {
  if max_edge == 0 {
    return Err(napi::Error::from_reason("maxEdge must be positive"));
  }
  if !(1..=100).contains(&quality) {
    return Err(napi::Error::from_reason(
      "quality must be between 1 and 100",
    ));
  }
  render_export_jpeg_internal(&path, max_edge, quality as u8)
    .map(Buffer::from)
    .map_err(napi::Error::from_reason)
}

pub(crate) fn render_export_jpeg_internal(
  path: &str,
  max_edge: u32,
  quality: u8,
) -> Result<Vec<u8>, String> {
  let (image, orientation) = decode_unoriented(path)?;
  // A square bound is rotation-invariant, so resize first and rotate fewer pixels.
  let target = fit_long_edge(image.dimensions(), max_edge);
  let image = if image.dimensions() == target {
    image
  } else {
    image.resize_exact(target.0, target.1, FilterType::Lanczos3)
  };
  let rgb = to_rgb8(apply_orientation(image, orientation));
  encode_jpeg(&rgb, quality)
}

/// 8-bit RGB without copying when already RGB8; alpha is composited over white so
/// transparent regions do not turn into their (often black) hidden color.
fn to_rgb8(image: DynamicImage) -> RgbImage {
  if !image.color().has_alpha() {
    return match image {
      DynamicImage::ImageRgb8(rgb) => rgb,
      other => other.to_rgb8(),
    };
  }
  let rgba = image.into_rgba8();
  let (width, height) = rgba.dimensions();
  let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
  for pixel in rgba.pixels() {
    let [r, g, b, a] = pixel.0;
    let alpha = u32::from(a);
    for channel in [r, g, b] {
      // Rounded `channel * a + 255 * (1 - a)` in 0..=255 arithmetic.
      rgb.push(((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8);
    }
  }
  RgbImage::from_raw(width, height, rgb).expect("RGB buffer matches dimensions")
}

fn encode_jpeg(rgb: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
  // Compressed output is far smaller than the pixels; start near a typical q90 size.
  let mut output = Vec::with_capacity(rgb.as_raw().len() / 6);
  JpegEncoder::new_with_quality(&mut output, quality)
    .encode_image(rgb)
    .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
  Ok(output)
}

#[cfg(test)]
mod tests {
  use super::*;
  use image::{ImageEncoder, Rgb, Rgba};
  use std::path::Path;

  fn render(path: &Path, max_edge: u32) -> (Vec<u8>, DynamicImage) {
    let bytes = render_export_jpeg_internal(path.to_str().unwrap(), max_edge, 90).unwrap();
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).unwrap();
    (bytes, decoded)
  }

  /// JPEG marker segments before the scan data, as `(marker, payload)`.
  fn segments(bytes: &[u8]) -> Vec<(u8, &[u8])> {
    assert_eq!(&bytes[..2], [0xFF, 0xD8]);
    let mut offset = 2;
    let mut found = Vec::new();
    while offset + 4 <= bytes.len() && bytes[offset] == 0xFF {
      let marker = bytes[offset + 1];
      let length = usize::from(u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]));
      found.push((marker, &bytes[offset + 4..offset + 2 + length]));
      if marker == 0xDA {
        break;
      }
      offset += 2 + length;
    }
    found
  }

  /// A JPEG whose EXIF says `orientation` (and carries a GPS IFD pointer), with
  /// stored pixels `width` x `height`: left half red, right half blue.
  fn write_oriented_jpeg(path: &Path, width: u32, height: u32, orientation: u16) {
    let pixels = RgbImage::from_fn(width, height, |x, _| {
      if x < width / 2 {
        Rgb([230, 20, 20])
      } else {
        Rgb([20, 20, 230])
      }
    });
    // Little-endian TIFF: IFD0 with Orientation and a GPSInfo pointer to an empty IFD.
    let mut exif = b"II*\0\x08\0\0\0".to_vec();
    exif.extend_from_slice(&2u16.to_le_bytes());
    exif.extend_from_slice(&0x0112u16.to_le_bytes());
    exif.extend_from_slice(&3u16.to_le_bytes());
    exif.extend_from_slice(&1u32.to_le_bytes());
    exif.extend_from_slice(&u32::from(orientation).to_le_bytes());
    exif.extend_from_slice(&0x8825u16.to_le_bytes());
    exif.extend_from_slice(&4u16.to_le_bytes());
    exif.extend_from_slice(&1u32.to_le_bytes());
    exif.extend_from_slice(&38u32.to_le_bytes());
    exif.extend_from_slice(&0u32.to_le_bytes());
    exif.extend_from_slice(&0u16.to_le_bytes());
    exif.extend_from_slice(&0u32.to_le_bytes());
    let mut bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 95);
    encoder.set_exif_metadata(exif).unwrap();
    encoder.encode_image(&pixels).unwrap();
    std::fs::write(path, bytes).unwrap();
  }

  #[test]
  fn downscale_preserves_aspect_ratio_and_fits_the_long_edge() {
    let temp = tempfile::tempdir().unwrap();
    for (width, height, max_edge, expected) in [
      (3000, 2000, 2048, (2048, 1365)),
      (2000, 3000, 1024, (683, 1024)),
      (2400, 2400, 1024, (1024, 1024)),
      (4001, 1000, 2048, (2048, 512)),
      (6000, 2, 1024, (1024, 1)),
    ] {
      let source = temp.path().join(format!("{width}x{height}.png"));
      RgbImage::from_pixel(width, height, Rgb([90, 140, 200]))
        .save(&source)
        .unwrap();
      let (_, decoded) = render(&source, max_edge);
      assert_eq!(
        decoded.dimensions(),
        expected,
        "{width}x{height}@{max_edge}"
      );
      assert_eq!(decoded.width().max(decoded.height()), max_edge);
    }
  }

  #[test]
  fn never_upscales_smaller_or_equal_sources() {
    let temp = tempfile::tempdir().unwrap();
    for (width, height) in [(640, 480), (2048, 1000), (1, 1)] {
      let source = temp.path().join(format!("{width}x{height}.png"));
      RgbImage::from_pixel(width, height, Rgb([10, 200, 30]))
        .save(&source)
        .unwrap();
      let (_, decoded) = render(&source, 2048);
      assert_eq!(decoded.dimensions(), (width, height));
    }
  }

  #[test]
  fn exif_orientation_is_applied_to_pixels_and_never_written() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("rotated.jpg");
    // Stored landscape; orientation 6 means rotate 90 degrees clockwise for display.
    write_oriented_jpeg(&source, 400, 200, 6);
    let (bytes, decoded) = render(&source, 2048);
    assert_eq!(decoded.dimensions(), (200, 400), "portrait output");
    let rgb = decoded.to_rgb8();
    // Rotating clockwise moves the stored left (red) half to the top.
    let top = rgb.get_pixel(100, 50).0;
    let bottom = rgb.get_pixel(100, 350).0;
    assert!(top[0] > 180 && top[2] < 80, "top {top:?}");
    assert!(bottom[2] > 180 && bottom[0] < 80, "bottom {bottom:?}");

    // Also downscaled: the bound is applied to the displayed long edge.
    let (_, small) = render(&source, 100);
    assert_eq!(small.dimensions(), (50, 100));

    let markers = segments(&bytes);
    assert!(
      !markers
        .iter()
        .any(|(marker, payload)| *marker == 0xE1 && payload.starts_with(b"Exif\0")),
      "no EXIF APP1"
    );
    assert!(
      markers
        .iter()
        .all(|(marker, _)| !matches!(marker, 0xE1..=0xEF) || *marker == 0xE0),
      "only the JFIF APPn segment: {:?}",
      markers.iter().map(|(m, _)| *m).collect::<Vec<_>>()
    );
    assert!(!bytes.windows(4).any(|window| window == b"Exif"));
    assert!(!bytes.windows(4).any(|window| window == b"ICC_"));
    assert!(!bytes.windows(9).any(|window| window == b"http://ns"));
  }

  #[test]
  fn every_orientation_matches_the_shared_transform() {
    let temp = tempfile::tempdir().unwrap();
    for orientation in 1..=8u16 {
      let source = temp.path().join(format!("o{orientation}.jpg"));
      write_oriented_jpeg(&source, 60, 20, orientation);
      let (_, decoded) = render(&source, 2048);
      let expected = if orientation >= 5 { (20, 60) } else { (60, 20) };
      assert_eq!(decoded.dimensions(), expected, "orientation {orientation}");
    }
  }

  #[test]
  fn alpha_and_sixteen_bit_inputs_become_rgb8_jpeg() {
    let temp = tempfile::tempdir().unwrap();
    let alpha = temp.path().join("alpha.png");
    image::RgbaImage::from_fn(64, 32, |x, _| {
      if x < 32 {
        Rgba([0, 0, 0, 0])
      } else {
        Rgba([0, 0, 200, 255])
      }
    })
    .save(&alpha)
    .unwrap();
    let (bytes, decoded) = render(&alpha, 2048);
    assert_eq!(decoded.color(), image::ColorType::Rgb8);
    // SOF0 component count is 3 (YCbCr), not 4.
    let (_, sof) = segments(&bytes)
      .into_iter()
      .find(|(marker, _)| *marker == 0xC0)
      .unwrap();
    assert_eq!(sof[5], 3);
    let rgb = decoded.to_rgb8();
    let transparent = rgb.get_pixel(8, 16).0;
    assert!(transparent.iter().all(|&c| c > 240), "{transparent:?}");
    let opaque = rgb.get_pixel(56, 16).0;
    assert!(opaque[2] > 170 && opaque[0] < 40, "{opaque:?}");

    let deep = temp.path().join("deep.png");
    let mut encoded = Vec::new();
    let pixels: Vec<u8> = (0..16 * 8)
      .flat_map(|_| [0xFFu8, 0xFF, 0x80, 0x00, 0x00, 0x00, 0xFF, 0xFF])
      .collect();
    image::codecs::png::PngEncoder::new(&mut encoded)
      .write_image(&pixels, 16, 8, image::ExtendedColorType::Rgba16)
      .unwrap();
    std::fs::write(&deep, encoded).unwrap();
    let (_, decoded) = render(&deep, 8);
    assert_eq!(decoded.color(), image::ColorType::Rgb8);
    assert_eq!(decoded.dimensions(), (8, 4));
  }

  #[test]
  fn undecodable_and_unsupported_sources_are_errors() {
    let temp = tempfile::tempdir().unwrap();
    let corrupt = temp.path().join("corrupt.jpg");
    std::fs::write(&corrupt, b"not a jpeg").unwrap();
    assert!(render_export_jpeg_internal(corrupt.to_str().unwrap(), 2048, 90).is_err());
    let unsupported = temp.path().join("notes.txt");
    std::fs::write(&unsupported, b"text").unwrap();
    assert!(render_export_jpeg_internal(unsupported.to_str().unwrap(), 2048, 90).is_err());
    let missing = temp.path().join("missing.jpg");
    assert!(render_export_jpeg_internal(missing.to_str().unwrap(), 2048, 90).is_err());
  }
}
