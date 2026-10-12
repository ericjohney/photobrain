//! Fujifilm RAF container: header offsets, CFA header records, the FujiIFD inside the
//! CFA block, and the TIFF/EXIF IFDs embedded in the preview JPEG.

mod tiff;

use crate::cfa::CfaPattern;
use crate::error::{Error, Result, malformed};
pub use tiff::{Endian, Ifd, IfdEntry, TiffReader};

/// How the sensor data inside the CFA block is stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawStorage {
  /// Fuji lossless compressed stream ("FujiCompressed", header signature 0x4953).
  FujiCompressed { offset: usize, length: usize },
  /// Uncompressed little-endian 16-bit samples, `bits` significant.
  Uncompressed { offset: usize, length: usize },
}

/// Fuji lens-correction parameter arrays (FujiIFD 0xf00b / 0xf00f / 0xf010).
///
/// Each array begins with the same `normalizing radius` and nine (or ten) radial
/// positions in units of the image half-diagonal, followed by per-position values.
#[derive(Clone, Debug, Default)]
pub struct LensParams {
  pub distortion: Option<Vec<f64>>,
  pub chromatic_aberration: Option<Vec<f64>>,
  pub vignetting: Option<Vec<f64>>,
}

/// Everything the pipeline needs from the RAF file, in sensor (unrotated) coordinates.
#[derive(Clone, Debug)]
pub struct RafMetadata {
  pub make: String,
  pub model: String,
  /// Full sensor readout size, in pixels.
  pub raw_width: usize,
  pub raw_height: usize,
  /// Active area (crop) within the readout.
  pub crop_top: usize,
  pub crop_left: usize,
  pub crop_width: usize,
  pub crop_height: usize,
  pub bits_per_sample: u32,
  /// 6x6 black levels, row-major over the CFA repeat (one value per CFA position).
  pub black_levels: Vec<u16>,
  /// As-shot white-balance multipliers' source levels, as (G, R, B).
  pub wb_grb: [u16; 3],
  pub cfa: CfaPattern,
  pub storage: RawStorage,
  /// EXIF orientation (1-8).
  pub orientation: u16,
  pub iso: Option<u32>,
  /// RawExposureBias (CFA header 0x9650) in EV, when present.
  pub raw_exposure_bias: Option<f64>,
  pub lens: LensParams,
  pub lens_model: Option<String>,
  pub focal_length: Option<f64>,
}

const MAGIC: &[u8] = b"FUJIFILMCCD-RAW ";

fn be32(b: &[u8], o: usize) -> Result<usize> {
  b.get(o..o + 4)
    .map(|s| u32::from_be_bytes(s.try_into().unwrap()) as usize)
    .ok_or_else(|| Error::Malformed(format!("header read past end at {o:#x}")))
}

fn be16(b: &[u8], o: usize) -> Result<u16> {
  b.get(o..o + 2)
    .map(|s| u16::from_be_bytes(s.try_into().unwrap()))
    .ok_or_else(|| Error::Malformed(format!("header read past end at {o:#x}")))
}

/// Parse the RAF container held entirely in `data`.
pub fn parse(data: &[u8]) -> Result<RafMetadata> {
  if data.len() < 0x6c || &data[..16] != MAGIC {
    return Err(Error::NotRaf);
  }
  let model = String::from_utf8_lossy(&data[0x1c..0x3c])
    .trim_end_matches('\0')
    .trim()
    .to_string();
  let jpeg_offset = be32(data, 0x54)?;
  let jpeg_length = be32(data, 0x58)?;
  let header_offset = be32(data, 0x5c)?;
  let cfa_offset = be32(data, 0x64)?;
  let cfa_length = be32(data, 0x68)?;
  if cfa_offset
    .checked_add(cfa_length)
    .is_none_or(|e| e > data.len())
  {
    return malformed("CFA block exceeds file");
  }

  // Big-endian CFA header records: count, then (tag u16, size u16, data).
  let mut raw_size = None;
  let mut crop_tl = None;
  let mut crop_size = None;
  let mut xtrans_layout: Option<Vec<u8>> = None;
  let mut raw_exposure_bias = None;
  let count = be32(data, header_offset)?;
  let mut p = header_offset + 4;
  for _ in 0..count.min(4096) {
    let tag = be16(data, p)?;
    let size = be16(data, p + 2)? as usize;
    let body = data
      .get(p + 4..p + 4 + size)
      .ok_or_else(|| Error::Malformed("CFA header record".into()))?;
    match (tag, size) {
      (0x100, 4) => raw_size = Some((be16(body, 0)? as usize, be16(body, 2)? as usize)),
      (0x110, 4) => crop_tl = Some((be16(body, 0)? as usize, be16(body, 2)? as usize)),
      (0x111, 4) => crop_size = Some((be16(body, 0)? as usize, be16(body, 2)? as usize)),
      (0x131, 36) => xtrans_layout = Some(body.to_vec()),
      // RawExposureBias: int16s value, int16s divisor (e.g. -72/100 for DR shifts).
      (0x9650, 4) => {
        let num = be16(body, 0)? as i16 as f64;
        let den = be16(body, 2)? as i16 as f64;
        if den != 0.0 {
          raw_exposure_bias = Some(num / den);
        }
      }
      _ => {}
    }
    p += 4 + size;
  }

  // FujiIFD: little-endian TIFF at the start of the CFA block.
  let block = &data[cfa_offset..cfa_offset + cfa_length];
  let tiff = TiffReader::new(block)?;
  let ifd0 = tiff.ifd(tiff.first_ifd_offset()?)?;
  let fuji_ifd_off = ifd0
    .get(0xf000)
    .map(|e| e.value_u32(&tiff, 0))
    .transpose()?
    .ok_or_else(|| Error::Malformed("missing FujiIFD (0xf000)".into()))?;
  let fuji = tiff.ifd(fuji_ifd_off as usize)?;
  let u32_tag =
    |t: u16| -> Result<Option<u32>> { fuji.get(t).map(|e| e.value_u32(&tiff, 0)).transpose() };

  let raw_width = u32_tag(0xf001)?
    .map(|v| v as usize)
    .or(raw_size.map(|s| s.1));
  let raw_height = u32_tag(0xf002)?
    .map(|v| v as usize)
    .or(raw_size.map(|s| s.0));
  let (raw_width, raw_height) = match (raw_width, raw_height) {
    (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
    _ => return malformed("missing raw dimensions"),
  };
  let bits_per_sample = u32_tag(0xf003)?.unwrap_or(14);
  let strip_offset = u32_tag(0xf007)?
    .ok_or_else(|| Error::Malformed("missing StripOffsets (0xf007)".into()))?
    as usize;
  let strip_length = u32_tag(0xf008)?
    .ok_or_else(|| Error::Malformed("missing StripByteCounts (0xf008)".into()))?
    as usize;
  if strip_offset
    .checked_add(strip_length)
    .is_none_or(|e| e > block.len())
  {
    return malformed("raw strip exceeds CFA block");
  }
  let black_levels: Vec<u16> = match fuji.get(0xf00a) {
    Some(e) => e.values_u32(&tiff)?.into_iter().map(|v| v as u16).collect(),
    None => vec![0; 36],
  };
  let wb = fuji
    .get(0xf00e)
    .map(|e| e.values_u32(&tiff))
    .transpose()?
    .filter(|v| v.len() >= 3)
    .ok_or_else(|| Error::Malformed("missing WB_GRBLevels (0xf00e)".into()))?;
  let wb_grb = [wb[0] as u16, wb[1] as u16, wb[2] as u16];

  let lens = LensParams {
    distortion: fuji.get(0xf00b).map(|e| e.values_f64(&tiff)).transpose()?,
    chromatic_aberration: fuji.get(0xf00f).map(|e| e.values_f64(&tiff)).transpose()?,
    vignetting: fuji.get(0xf010).map(|e| e.values_f64(&tiff)).transpose()?,
  };

  let abs_strip = cfa_offset + strip_offset;
  let compressed = data.get(abs_strip..abs_strip + 2) == Some(&[0x49, 0x53]);
  let storage = if compressed {
    RawStorage::FujiCompressed {
      offset: abs_strip,
      length: strip_length,
    }
  } else {
    RawStorage::Uncompressed {
      offset: abs_strip,
      length: strip_length,
    }
  };

  let cfa = match xtrans_layout {
    Some(layout) => CfaPattern::from_raf_xtrans_layout(&layout)?,
    None => {
      return Err(Error::Unsupported(
        "RAF without X-Trans layout (Bayer RAF not yet supported)".into(),
      ));
    }
  };

  let (crop_top, crop_left) = crop_tl.unwrap_or((0, 0));
  let (crop_height, crop_width) =
    crop_size.unwrap_or((raw_height - crop_top, raw_width - crop_left));
  if crop_top + crop_height > raw_height || crop_left + crop_width > raw_width {
    return malformed("crop exceeds raw size");
  }

  let mut meta = RafMetadata {
    make: "FUJIFILM".into(),
    model,
    raw_width,
    raw_height,
    crop_top,
    crop_left,
    crop_width,
    crop_height,
    bits_per_sample,
    black_levels,
    wb_grb,
    cfa,
    storage,
    orientation: 1,
    iso: None,
    raw_exposure_bias,
    lens,
    lens_model: None,
    focal_length: None,
  };
  if let Some(jpeg) = data.get(jpeg_offset..jpeg_offset.saturating_add(jpeg_length)) {
    // EXIF failures are not fatal: orientation defaults to 1.
    let _ = read_exif(jpeg, &mut meta);
  }
  Ok(meta)
}

/// Read IFD0/EXIF/MakerNote fields from the APP1 segment of the embedded JPEG.
fn read_exif(jpeg: &[u8], meta: &mut RafMetadata) -> Result<()> {
  if jpeg.len() < 12 || jpeg[0] != 0xff || jpeg[1] != 0xd8 {
    return malformed("preview is not JPEG");
  }
  let mut p = 2;
  while p + 4 <= jpeg.len() {
    if jpeg[p] != 0xff {
      break;
    }
    let marker = jpeg[p + 1];
    let len = u16::from_be_bytes([jpeg[p + 2], jpeg[p + 3]]) as usize;
    if marker == 0xe1 && jpeg.get(p + 4..p + 10) == Some(b"Exif\0\0") {
      let tiff_bytes = &jpeg[p + 10..(p + 2 + len).min(jpeg.len())];
      let tiff = TiffReader::new(tiff_bytes)?;
      let ifd0 = tiff.ifd(tiff.first_ifd_offset()?)?;
      if let Some(e) = ifd0.get(0x0112) {
        meta.orientation = e.value_u32(&tiff, 0)? as u16;
      }
      if let Some(e) = ifd0.get(0x010f) {
        meta.make = e.ascii(&tiff)?;
      }
      if let Some(e) = ifd0.get(0x0110) {
        meta.model = e.ascii(&tiff)?;
      }
      if let Some(exif_off) = ifd0
        .get(0x8769)
        .map(|e| e.value_u32(&tiff, 0))
        .transpose()?
      {
        let exif = tiff.ifd(exif_off as usize)?;
        meta.iso = exif
          .get(0x8827)
          .map(|e| e.value_u32(&tiff, 0))
          .transpose()?;
        meta.lens_model = exif.get(0xa434).map(|e| e.ascii(&tiff)).transpose()?;
        meta.focal_length = exif
          .get(0x920a)
          .map(|e| e.value_f64(&tiff, 0))
          .transpose()?;
      }
      return Ok(());
    }
    if marker == 0xda {
      break;
    }
    p += 2 + len;
  }
  malformed("no EXIF APP1 in preview")
}
