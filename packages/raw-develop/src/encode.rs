//! Output encoders with an embedded Display P3 ICC profile.

use crate::error::{Error, Result};
use crate::image::RgbImage;
use std::io::Write;
use std::path::Path;

/// Build a minimal ICC v4 display profile for Display P3 (D65 white, sRGB transfer),
/// with D50-adapted primaries as ICC requires.
pub fn display_p3_icc() -> Vec<u8> {
  fn s15(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
  }
  fn xyz(x: f64, y: f64, z: f64) -> Vec<u8> {
    let mut t = b"XYZ \0\0\0\0".to_vec();
    t.extend(s15(x));
    t.extend(s15(y));
    t.extend(s15(z));
    t
  }
  // parametricCurveType, function 3: sRGB.
  let mut trc = b"para\0\0\0\0\0\x03\0\0".to_vec();
  for v in [2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045] {
    trc.extend(s15(v));
  }
  let desc = {
    // multiLocalizedUnicodeType
    let text: Vec<u8> = "Display P3"
      .encode_utf16()
      .flat_map(|c| c.to_be_bytes())
      .collect();
    let mut t = b"mluc\0\0\0\0".to_vec();
    t.extend(1u32.to_be_bytes());
    t.extend(12u32.to_be_bytes());
    t.extend(b"enUS");
    t.extend((text.len() as u32).to_be_bytes());
    t.extend(28u32.to_be_bytes());
    t.extend(text);
    t
  };
  let cprt = {
    let text: Vec<u8> = "No copyright, use freely"
      .encode_utf16()
      .flat_map(|c| c.to_be_bytes())
      .collect();
    let mut t = b"mluc\0\0\0\0".to_vec();
    t.extend(1u32.to_be_bytes());
    t.extend(12u32.to_be_bytes());
    t.extend(b"enUS");
    t.extend((text.len() as u32).to_be_bytes());
    t.extend(28u32.to_be_bytes());
    t.extend(text);
    t
  };
  // D50-adapted (Bradford) Display P3 primaries.
  let tags: Vec<([u8; 4], Vec<u8>)> = vec![
    (*b"desc", desc),
    (*b"cprt", cprt),
    (*b"wtpt", xyz(0.9642, 1.0, 0.8249)),
    (*b"rXYZ", xyz(0.515_075, 0.241_170, -0.001_049)),
    (*b"gXYZ", xyz(0.291_940, 0.692_236, 0.041_884)),
    (*b"bXYZ", xyz(0.157_179, 0.066_590, 0.784_546)),
    (*b"rTRC", trc.clone()),
    (*b"gTRC", trc.clone()),
    (*b"bTRC", trc),
    (*b"chad", {
      let mut t = b"sf32\0\0\0\0".to_vec();
      // Bradford D65 -> D50.
      for v in [
        1.047_882, 0.022_916, -0.050_220, 0.029_582, 0.990_484, -0.017_079, -0.009_234, 0.015_044,
        0.752_132,
      ] {
        t.extend(s15(v));
      }
      t
    }),
  ];
  let header_len = 128 + 4 + 12 * tags.len();
  let mut body = Vec::new();
  let mut table = Vec::new();
  let mut offset = header_len;
  // Identical TRCs could share data; keep it simple and aligned.
  for (sig, data) in &tags {
    table.extend(sig);
    table.extend((offset as u32).to_be_bytes());
    table.extend((data.len() as u32).to_be_bytes());
    body.extend(data);
    let pad = (4 - data.len() % 4) % 4;
    body.extend(std::iter::repeat_n(0u8, pad));
    offset += data.len() + pad;
  }
  let total = header_len + body.len();
  let mut h = vec![0u8; 128];
  h[0..4].copy_from_slice(&(total as u32).to_be_bytes());
  h[8..12].copy_from_slice(&[4, 0x30, 0, 0]); // v4.3
  h[12..16].copy_from_slice(b"mntr");
  h[16..20].copy_from_slice(b"RGB ");
  h[20..24].copy_from_slice(b"XYZ ");
  h[36..40].copy_from_slice(b"acsp");
  // Rendering intent 0 (perceptual); illuminant D50.
  h[68..72].copy_from_slice(&s15(0.9642));
  h[72..76].copy_from_slice(&s15(1.0));
  h[76..80].copy_from_slice(&s15(0.8249));
  let mut out = h;
  out.extend((tags.len() as u32).to_be_bytes());
  out.extend(table);
  out.extend(body);
  out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
  Png16,
  Png8,
  Jpeg(u8),
}

impl Format {
  pub fn from_path(p: &Path) -> Format {
    match p
      .extension()
      .and_then(|e| e.to_str())
      .map(str::to_ascii_lowercase)
      .as_deref()
    {
      Some("jpg" | "jpeg") => Format::Jpeg(92),
      _ => Format::Png16,
    }
  }
}

fn quantize8(img: &RgbImage) -> Vec<u8> {
  img
    .data
    .iter()
    .map(|&v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)
    .collect()
}

pub fn encode(img: &RgbImage, format: Format) -> Result<Vec<u8>> {
  let icc = display_p3_icc();
  let (w, h) = (img.width as u32, img.height as u32);
  let err = |e: &dyn std::fmt::Display| Error::Encode(e.to_string());
  match format {
    Format::Png16 | Format::Png8 => {
      let mut out = Vec::new();
      {
        let mut info = png::Info::with_size(w, h);
        info.color_type = png::ColorType::Rgb;
        info.bit_depth = if format == Format::Png16 {
          png::BitDepth::Sixteen
        } else {
          png::BitDepth::Eight
        };
        info.icc_profile = Some(icc.into());
        let enc = png::Encoder::with_info(&mut out, info).map_err(|e| err(&e))?;
        let mut enc = enc;
        enc.set_compression(png::Compression::Fast);
        let mut wr = enc.write_header().map_err(|e| err(&e))?;
        let bytes: Vec<u8> = if format == Format::Png16 {
          img
            .data
            .iter()
            .flat_map(|&v| ((v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16).to_be_bytes())
            .collect()
        } else {
          quantize8(img)
        };
        wr.write_image_data(&bytes).map_err(|e| err(&e))?;
      }
      Ok(out)
    }
    Format::Jpeg(q) => {
      use image::ImageEncoder;
      let mut out = Vec::new();
      let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, q);
      enc.set_icc_profile(icc).map_err(|e| err(&e))?;
      enc
        .write_image(&quantize8(img), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| err(&e))?;
      Ok(out)
    }
  }
}

pub fn write(img: &RgbImage, path: &Path, format: Format) -> Result<()> {
  let bytes = encode(img, format)?;
  let mut f = std::fs::File::create(path)?;
  f.write_all(&bytes)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn icc_is_well_formed() {
    let icc = display_p3_icc();
    assert_eq!(
      u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize,
      icc.len()
    );
    assert_eq!(&icc[36..40], b"acsp");
    assert_eq!(icc.len() % 4, 0);
  }

  #[test]
  fn png_and_jpeg_embed_profile() {
    let mut im = RgbImage::new(8, 4);
    im.data.fill(0.5);
    let png = encode(&im, Format::Png16).unwrap();
    assert!(png.windows(4).any(|w| w == b"iCCP"));
    let jpg = encode(&im, Format::Jpeg(90)).unwrap();
    assert!(jpg.windows(12).any(|w| w == b"ICC_PROFILE\0"));
  }
}
