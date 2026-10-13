//! Sony ARW container: a little-endian TIFF whose IFD0 `SubIFDs` entry points to the raw
//! image IFD. Everything the pipeline needs is in plain tags there (verified against
//! RawCamera's graph inputs on A1 II, A7C R and A7R V files):
//!
//! | Tag | Use |
//! |---|---|
//! | 0x0100/0x0101 ImageWidth/Length | stored readout size (tiled files are padded to 512) |
//! | 0x0103 Compression | 1 uncompressed, 7 lossless JPEG tiles, 32767 Sony cRAW |
//! | 0x828d/0x828e CFARepeatPatternDim/CFAPattern2 | 2x2 CFA, 0 = R, 1 = G, 2 = B |
//! | 0x0111/0x0117 StripOffsets/ByteCounts | uncompressed and cRAW data |
//! | 0x0142..0x0145 Tile* | lossless JPEG tiles |
//! | 0xc61f/0xc620 DefaultCropOrigin/Size | active area (RawCamera crops to exactly this) |
//! | 0x7310 BlackLevel | 4 levels, one per CFA position |
//! | 0x787f WhiteLevel | 3 levels (R, G, B) |
//! | 0x7313 WB_RGGBLevels | as-shot white balance (RawCamera's highlight factors are R/G, B/G) |
//! | 0x7032/0x7035/0x7037 Vignetting/ChromaticAberration/DistortionCorrParams | lens arrays |
//! | 0x7036 DistortionCorrection | 1 when RawCamera applies the distortion array |
//!
//! Orientation, make, model, ISO and lens model come from IFD0 and its EXIF IFD.

use crate::cfa::{CfaPattern, Channel};
use crate::error::{Error, Result, malformed};
use crate::metadata::{Container, LensParams, LensSource, RawMetadata, RawStorage};
use crate::tiff::{Ifd, TiffReader};

fn u32s(t: &TiffReader, ifd: &Ifd, tag: u16) -> Result<Option<Vec<u32>>> {
  ifd.get(tag).map(|e| e.values_u32(t)).transpose()
}

fn one(t: &TiffReader, ifd: &Ifd, tag: u16) -> Result<Option<u32>> {
  ifd.get(tag).map(|e| e.value_u32(t, 0)).transpose()
}

fn need(v: Option<u32>, what: &str) -> Result<usize> {
  v.map(|v| v as usize)
    .ok_or_else(|| Error::Malformed(format!("ARW: missing {what}")))
}

/// True when `data` is a TIFF whose IFD0 Make is Sony and that is not a DNG.
pub fn is_arw(data: &[u8]) -> bool {
  let Ok(t) = TiffReader::new(data) else {
    return false;
  };
  let Ok(off) = t.first_ifd_offset() else {
    return false;
  };
  let Ok(ifd0) = t.ifd(off) else { return false };
  ifd0.get(0xc612).is_none()
    && ifd0
      .get(0x010f)
      .and_then(|e| e.ascii(&t).ok())
      .is_some_and(|m| m.to_ascii_uppercase().starts_with("SONY"))
}

pub fn parse(data: &[u8]) -> Result<RawMetadata> {
  let t = TiffReader::new(data)?;
  let ifd0 = t.ifd(t.first_ifd_offset()?)?;
  let sub_offsets = u32s(&t, &ifd0, 0x014a)?.unwrap_or_default();
  // The raw IFD is the SubIFD with a CFA photometric interpretation.
  let raw = sub_offsets
    .iter()
    .filter_map(|&o| t.ifd(o as usize).ok())
    .find(|ifd| one(&t, ifd, 0x0106).ok().flatten() == Some(32803))
    .ok_or_else(|| Error::Malformed("ARW: no CFA SubIFD".into()))?;

  let raw_width = need(one(&t, &raw, 0x0100)?, "ImageWidth")?;
  let raw_height = need(one(&t, &raw, 0x0101)?, "ImageLength")?;
  let bits_per_sample = one(&t, &raw, 0x0102)?.unwrap_or(14);
  let compression = one(&t, &raw, 0x0103)?.unwrap_or(1);

  let dim = u32s(&t, &raw, 0x828d)?.unwrap_or(vec![2, 2]);
  let pat = raw
    .get(0x828e)
    .map(|e| e.raw_bytes(&t))
    .transpose()?
    .ok_or_else(|| Error::Malformed("ARW: missing CFAPattern".into()))?;
  if dim != [2, 2] || pat.len() != 4 {
    return Err(Error::Unsupported(format!("ARW CFA {dim:?} {pat:?}")));
  }
  let cells = pat
    .iter()
    .map(|&v| Channel::from_index(v).ok_or_else(|| Error::Malformed("ARW: CFA value".into())))
    .collect::<Result<Vec<_>>>()?;
  let cfa = CfaPattern::new(2, 2, cells)?;

  let storage = match compression {
    1 | 32767 => {
      let offset = need(one(&t, &raw, 0x0111)?, "StripOffsets")?;
      let length = need(one(&t, &raw, 0x0117)?, "StripByteCounts")?;
      if offset.checked_add(length).is_none_or(|e| e > data.len()) {
        return malformed("ARW: raw strip past end of file");
      }
      if compression == 1 {
        RawStorage::Uncompressed { offset, length }
      } else {
        RawStorage::SonyCompressed { offset, length }
      }
    }
    7 => {
      let offs = u32s(&t, &raw, 0x0144)?.ok_or_else(|| Error::Malformed("ARW: TileOffsets".into()))?;
      let lens = u32s(&t, &raw, 0x0145)?.ok_or_else(|| Error::Malformed("ARW: TileByteCounts".into()))?;
      if offs.len() != lens.len() {
        return malformed("ARW: tile table sizes differ");
      }
      RawStorage::LosslessJpegTiles {
        tiles: offs.iter().zip(&lens).map(|(&o, &l)| (o as usize, l as usize)).collect(),
        tile_width: need(one(&t, &raw, 0x0142)?, "TileWidth")?,
        tile_height: need(one(&t, &raw, 0x0143)?, "TileLength")?,
      }
    }
    c => return Err(Error::Unsupported(format!("ARW compression {c}"))),
  };

  let (crop_left, crop_top) = match u32s(&t, &raw, 0xc61f)? {
    Some(v) if v.len() == 2 => (v[0] as usize, v[1] as usize),
    _ => (0, 0),
  };
  let (crop_width, crop_height) = match u32s(&t, &raw, 0xc620)? {
    Some(v) if v.len() == 2 => (v[0] as usize, v[1] as usize),
    _ => (raw_width - crop_left, raw_height - crop_top),
  };
  if crop_left + crop_width > raw_width || crop_top + crop_height > raw_height {
    return malformed("ARW: crop exceeds raw size");
  }

  let black_levels: Vec<u16> = match u32s(&t, &raw, 0x7310)? {
    Some(v) if v.len() == 4 => v.into_iter().map(|b| b as u16).collect(),
    _ => vec![512; 4],
  };
  let white_level = u32s(&t, &raw, 0x787f)?.and_then(|v| v.into_iter().max());

  // WB_RGGBLevels: int16s R, G, G, B.
  let wb = raw
    .get(0x7313)
    .map(|e| e.values_f64(&t))
    .transpose()?
    .filter(|v| v.len() == 4 && v.iter().all(|&x| x > 0.0))
    .ok_or_else(|| Error::Malformed("ARW: missing WB_RGGBLevels (0x7313)".into()))?;
  let g = (wb[1] + wb[2]) * 0.5;
  let as_shot_wb = [wb[0] / g, 1.0, wb[3] / g];

  let arr = |tag: u16| -> Result<Option<Vec<f64>>> { raw.get(tag).map(|e| e.values_f64(&t)).transpose() };
  // RawCamera applies distortion only when the camera flags it (DistortionCorrection
  // 0x7036 = 1; it ignores the CA and vignetting arrays).
  let dist_on = one(&t, &raw, 0x7036)?.unwrap_or(0) != 0;
  let lens = LensSource::Sony(LensParams {
    distortion: if dist_on { arr(0x7037)? } else { None },
    chromatic_aberration: arr(0x7035)?,
    vignetting: arr(0x7032)?,
  });

  let mut meta = RawMetadata {
    container: Container::Arw,
    make: "SONY".into(),
    model: String::new(),
    raw_width,
    raw_height,
    crop_top,
    crop_left,
    crop_width,
    crop_height,
    bits_per_sample,
    black_levels,
    white_level,
    as_shot_wb,
    cfa,
    storage,
    orientation: 1,
    iso: None,
    raw_exposure_bias: None,
    lens,
    lens_model: None,
    focal_length: None,
  };
  crate::tiff::read_ifd0_exif(&t, &ifd0, &mut meta)?;
  Ok(meta)
}
