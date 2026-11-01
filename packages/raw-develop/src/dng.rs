//! DNG `LinearRaw` (Apple ProRAW): container, decode and colour from tags.
//!
//! iPhone ProRAW files store already-demosaiced RGB (PhotometricInterpretation 34892) in a
//! SubIFD as tiles: lossless JPEG (Compression 7, iPhone 16 and earlier) or JPEG XL
//! (Compression 52546, DNG 1.7, iPhone 17). Samples are codes that index the
//! `LinearizationTable` (black 0, white 65535). Colour comes from the file:
//! `ColorMatrix1/2`, `AnalogBalance`, `AsShotNeutral`, `BaselineExposure`; tone from
//! `ProfileToneCurve` and the DNG 1.7 `ProfileGainTableMap`.
//!
//! Camera to XYZ follows RawCamera's `RAWConvert` (observed with `outputMatrix` probes and
//! matched to 2e-3 on 16 files): when a profile has colour matrices but no forward
//! matrices, a forward matrix is synthesised per illuminant (Bradford adaptation of that
//! illuminant's white to D50, as in the DNG SDK) and both the colour and forward
//! matrices are interpolated by the mired-weighted CCT of the as-shot white.

use crate::cfa::CfaPattern;
use crate::error::{Error, Result, malformed};
use crate::math::Mat3;
use crate::metadata::{Container, LensSource, RawMetadata, RawStorage};
use crate::tiff::{Ifd, TiffReader};

/// DNG-specific data the pipeline needs beyond `RawMetadata`.
#[derive(Clone, Debug)]
pub struct DngInfo {
  pub color_matrix_1: [f64; 9],
  pub color_matrix_2: [f64; 9],
  pub calibration_illuminant_1: u16,
  pub calibration_illuminant_2: u16,
  pub analog_balance: [f64; 3],
  pub as_shot_neutral: [f64; 3],
  pub baseline_exposure: f64,
  /// Code -> 16-bit linear value.
  pub linearization: Vec<u16>,
  pub samples_per_pixel: usize,
  /// `ProfileToneCurve` (x, y) pairs.
  pub tone_curve: Vec<(f32, f32)>,
  pub gain_table_map: Option<GainTableMap>,
  /// Lossless JPEG or JPEG XL tiles.
  pub jxl: bool,
}

/// DNG 1.7 `ProfileGainTableMap` (big-endian binary tag).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct GainTableMap {
  pub points_v: usize,
  pub points_h: usize,
  pub spacing_v: f64,
  pub spacing_h: f64,
  pub origin_v: f64,
  pub origin_h: f64,
  pub points_n: usize,
  /// Index weights: R, G, B, min, max.
  pub weights: [f32; 5],
  pub gamma: f32,
  /// `points_v * points_h * points_n` gains, row-major (v, h, n).
  pub table: Vec<f32>,
}

impl GainTableMap {
  pub(crate) fn valid_portable(&self) -> bool {
    let dims = [self.points_v, self.points_h, self.points_n];
    dims.iter().all(|&d| d > 0 && d <= 4096)
      && dims.iter().try_fold(1usize, |n, &d| n.checked_mul(d)) == Some(self.table.len())
      && self
        .table
        .iter()
        .chain(&self.weights)
        .all(|v| v.is_finite())
      && [self.spacing_v, self.spacing_h]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0)
      && self.origin_v.is_finite()
      && self.origin_h.is_finite()
      && self.gamma.is_finite()
  }


  pub fn parse(b: &[u8]) -> Result<Self> {
    let u32_at = |o: usize| -> Result<u32> {
      b.get(o..o + 4)
        .map(|s| u32::from_be_bytes(s.try_into().unwrap()))
        .ok_or_else(|| Error::Malformed("ProfileGainTableMap truncated".into()))
    };
    let f64_at = |o: usize| -> Result<f64> {
      b.get(o..o + 8)
        .map(|s| f64::from_be_bytes(s.try_into().unwrap()))
        .ok_or_else(|| Error::Malformed("ProfileGainTableMap truncated".into()))
    };
    let f32_at = |o: usize| -> Result<f32> { Ok(f32::from_bits(u32_at(o)?)) };
    let points_v = u32_at(0)? as usize;
    let points_h = u32_at(4)? as usize;
    let points_n = u32_at(40)? as usize;
    if points_v == 0 || points_h == 0 || points_n < 2 || points_v * points_h * points_n > 50_000_000 {
      return malformed("ProfileGainTableMap dimensions");
    }
    let mut weights = [0f32; 5];
    for (i, w) in weights.iter_mut().enumerate() {
      *w = f32_at(44 + 4 * i)?;
    }
    let n = points_v * points_h * points_n;
    let table = (0..n).map(|i| f32_at(64 + 4 * i)).collect::<Result<Vec<_>>>()?;
    let gamma = if b.len() >= 64 + 4 * n + 4 { f32_at(64 + 4 * n)? } else { 1.0 };
    Ok(Self {
      points_v,
      points_h,
      spacing_v: f64_at(8)?,
      spacing_h: f64_at(16)?,
      origin_v: f64_at(24)?,
      origin_h: f64_at(32)?,
      points_n,
      weights,
      gamma,
      table,
    })
  }
}

/// True when `data` is a TIFF with a DNGVersion tag in IFD0.
pub fn is_dng(data: &[u8]) -> bool {
  TiffReader::new(data)
    .ok()
    .and_then(|t| t.first_ifd_offset().ok().and_then(|o| t.ifd(o).ok()))
    .is_some_and(|ifd0| ifd0.get(0xc612).is_some())
}

fn f64s(t: &TiffReader, ifd: &Ifd, tag: u16) -> Result<Option<Vec<f64>>> {
  ifd.get(tag).map(|e| e.values_f64(t)).transpose()
}

fn one(t: &TiffReader, ifd: &Ifd, tag: u16) -> Result<Option<u32>> {
  ifd.get(tag).map(|e| e.value_u32(t, 0)).transpose()
}

fn arr9(v: Option<Vec<f64>>, what: &str) -> Result<[f64; 9]> {
  v.filter(|v| v.len() == 9)
    .map(|v| v.try_into().unwrap())
    .ok_or_else(|| Error::Malformed(format!("DNG: missing {what}")))
}

fn arr3(v: Option<Vec<f64>>, default: [f64; 3]) -> [f64; 3] {
  v.filter(|v| v.len() == 3).map_or(default, |v| [v[0], v[1], v[2]])
}

pub fn parse(data: &[u8]) -> Result<(RawMetadata, DngInfo)> {
  let t = TiffReader::new(data)?;
  let ifd0 = t.ifd(t.first_ifd_offset()?)?;
  // Main image: the SubIFD with NewSubfileType 0 (full resolution) and LinearRaw/CFA data.
  let subs: Vec<u32> = ifd0.get(0x014a).map(|e| e.values_u32(&t)).transpose()?.unwrap_or_default();
  let raw = subs
    .iter()
    .filter_map(|&o| t.ifd(o as usize).ok())
    .find(|ifd| one(&t, ifd, 0x00fe).ok().flatten().unwrap_or(0) == 0)
    .ok_or_else(|| Error::Malformed("DNG: no full-resolution SubIFD".into()))?;
  let photometric = one(&t, &raw, 0x0106)?.unwrap_or(0);
  if photometric != 34892 {
    return Err(Error::Unsupported(format!(
      "DNG photometric interpretation {photometric} (only LinearRaw is supported)"
    )));
  }
  let width = one(&t, &raw, 0x0100)?.ok_or_else(|| Error::Malformed("DNG: width".into()))? as usize;
  let height = one(&t, &raw, 0x0101)?.ok_or_else(|| Error::Malformed("DNG: height".into()))? as usize;
  let spp = one(&t, &raw, 0x0115)?.unwrap_or(1) as usize;
  if spp != 3 {
    return Err(Error::Unsupported(format!("DNG LinearRaw with {spp} samples per pixel")));
  }
  let compression = one(&t, &raw, 0x0103)?.unwrap_or(1);
  let jxl = match compression {
    7 => false,
    52546 => true,
    c => return Err(Error::Unsupported(format!("DNG compression {c}"))),
  };
  let offs = raw.get(0x0144).map(|e| e.values_u32(&t)).transpose()?.ok_or_else(|| Error::Malformed("DNG: TileOffsets".into()))?;
  let lens = raw.get(0x0145).map(|e| e.values_u32(&t)).transpose()?.ok_or_else(|| Error::Malformed("DNG: TileByteCounts".into()))?;
  let storage = RawStorage::LosslessJpegTiles {
    tiles: offs.iter().zip(&lens).map(|(&o, &l)| (o as usize, l as usize)).collect(),
    tile_width: one(&t, &raw, 0x0142)?.ok_or_else(|| Error::Malformed("DNG: TileWidth".into()))? as usize,
    tile_height: one(&t, &raw, 0x0143)?.ok_or_else(|| Error::Malformed("DNG: TileLength".into()))? as usize,
  };

  let linearization: Vec<u16> = match raw.get(0xc618) {
    Some(e) => e.values_u32(&t)?.into_iter().map(|v| v.min(65535) as u16).collect(),
    None => (0..=65535u32).map(|v| v as u16).collect(),
  };
  let black = f64s(&t, &raw, 0xc61a)?.unwrap_or_default();
  let white = f64s(&t, &raw, 0xc61d)?.unwrap_or_default();
  if black.iter().any(|&b| b != 0.0) || white.iter().any(|&w| w != 65535.0) {
    return Err(Error::Unsupported("DNG with non-trivial BlackLevel/WhiteLevel".into()));
  }

  let tone_curve = match ifd0.get(0xc6fc) {
    Some(e) => e.values_f64(&t)?.chunks_exact(2).map(|p| (p[0] as f32, p[1] as f32)).collect(),
    None => vec![(0.0, 0.0), (1.0, 1.0)],
  };
  let gain_table_map = raw
    .get(0xcd2d)
    .or_else(|| ifd0.get(0xcd2d))
    .map(|e| e.raw_bytes(&t).and_then(|b| GainTableMap::parse(&b)))
    .transpose()?;

  let info = DngInfo {
    color_matrix_1: arr9(f64s(&t, &ifd0, 0xc621)?, "ColorMatrix1")?,
    color_matrix_2: arr9(f64s(&t, &ifd0, 0xc622)?, "ColorMatrix2")?,
    calibration_illuminant_1: one(&t, &ifd0, 0xc65a)?.unwrap_or(17) as u16,
    calibration_illuminant_2: one(&t, &ifd0, 0xc65b)?.unwrap_or(21) as u16,
    analog_balance: arr3(f64s(&t, &ifd0, 0xc627)?, [1.0; 3]),
    as_shot_neutral: arr3(f64s(&t, &ifd0, 0xc628)?, [1.0; 3]),
    baseline_exposure: f64s(&t, &ifd0, 0xc62a)?.and_then(|v| v.first().copied()).unwrap_or(0.0),
    linearization,
    samples_per_pixel: spp,
    tone_curve,
    gain_table_map,
    jxl,
  };

  let mut meta = RawMetadata {
    container: Container::Dng,
    make: String::new(),
    model: String::new(),
    raw_width: width,
    raw_height: height,
    crop_top: 0,
    crop_left: 0,
    crop_width: width,
    crop_height: height,
    bits_per_sample: 16,
    black_levels: vec![0],
    white_level: Some(65535),
    as_shot_wb: [1.0; 3],
    // LinearRaw has no mosaic; a 1x1 placeholder pattern.
    cfa: CfaPattern::new(1, 1, vec![crate::cfa::Channel::Green])?,
    storage,
    orientation: 1,
    iso: None,
    exposure_time: None,
    sony_raw_format: None,
    sony_daylight_wb: None,
    fuji_ibis_shift: None,
    fuji_daylight_wb: None,
    raw_exposure_bias: None,
    lens: LensSource::None,
    lens_model: None,
    focal_length: None,
  };
  crate::tiff::read_ifd0_exif(&t, &ifd0, &mut meta)?;
  if let Some((x, y, w, h)) = default_crop(&t, &raw)? {
    meta.crop_left = x;
    meta.crop_top = y;
    meta.crop_width = w.min(width - x);
    meta.crop_height = h.min(height - y);
  }
  Ok((meta, info))
}

fn default_crop(t: &TiffReader, raw: &Ifd) -> Result<Option<(usize, usize, usize, usize)>> {
  let o = f64s(t, raw, 0xc61f)?;
  let s = f64s(t, raw, 0xc620)?;
  Ok(match (o, s) {
    (Some(o), Some(s)) if o.len() == 2 && s.len() == 2 => {
      Some((o[0] as usize, o[1] as usize, s[0] as usize, s[1] as usize))
    }
    _ => None,
  })
}

/// Decode the LinearRaw tiles into linear RGB in 0-1 (after the LinearizationTable).
pub fn decode(data: &[u8], meta: &RawMetadata, info: &DngInfo) -> Result<Vec<f32>> {
  let RawStorage::LosslessJpegTiles {
    tiles,
    tile_width: tw,
    tile_height: th,
  } = &meta.storage
  else {
    return malformed("DNG storage");
  };
  let (tw, th) = (*tw, *th);
  let (w, h) = (meta.raw_width, meta.raw_height);
  let across = w.div_ceil(tw);
  let down = h.div_ceil(th);
  if tiles.len() < across * down {
    return malformed("DNG: too few tiles");
  }
  use rayon::prelude::*;
  let lin = &info.linearization;
  let decoded: Vec<Vec<u16>> = tiles[..across * down]
    .par_iter()
    .map(|&(off, len)| -> Result<Vec<u16>> {
      let bytes = off
        .checked_add(len)
        .and_then(|e| data.get(off..e))
        .ok_or_else(|| Error::Malformed("DNG tile past end of file".into()))?;
      if info.jxl {
        decode_jxl_tile(bytes, tw, th)
      } else {
        let (f, s) = crate::unpack::ljpeg::decode(bytes)?;
        if f.width * f.components != tw * 3 || f.height != th {
          return malformed(format!("DNG tile frame {}x{}x{}", f.width, f.height, f.components));
        }
        Ok(s)
      }
    })
    .collect::<Result<_>>()?;
  let mut out = vec![0f32; w * h * 3];
  out.par_chunks_mut(w * 3).enumerate().for_each(|(y, row)| {
    let ty = y / th;
    for tx in 0..across {
      let t = &decoded[ty * across + tx];
      let x0 = tx * tw;
      let n = tw.min(w - x0);
      let src = &t[(y - ty * th) * tw * 3..(y - ty * th) * tw * 3 + n * 3];
      for (o, &c) in row[x0 * 3..(x0 + n) * 3].iter_mut().zip(src) {
        *o = lin.get(c as usize).copied().unwrap_or(65535) as f32 / 65535.0;
      }
    }
  });
  Ok(out)
}

#[cfg(feature = "jxl")]
fn decode_jxl_tile(bytes: &[u8], tw: usize, th: usize) -> Result<Vec<u16>> {
  let img = jxl_oxide::JxlImage::builder()
    .read(bytes)
    .map_err(|e| Error::Corrupt(format!("JPEG XL tile: {e}")))?;
  let r = img
    .render_frame(0)
    .map_err(|e| Error::Corrupt(format!("JPEG XL tile: {e}")))?;
  let fb = r.image_all_channels();
  if fb.channels() != 3 || fb.width() != tw || fb.height() != th {
    return malformed(format!("JPEG XL tile {}x{}x{}", fb.width(), fb.height(), fb.channels()));
  }
  // Samples are integer codes stored at 16 bits; jxl-oxide returns them normalised.
  Ok(fb.buf().iter().map(|&v| (v * 65535.0).round().clamp(0.0, 65535.0) as u16).collect())
}

#[cfg(not(feature = "jxl"))]
fn decode_jxl_tile(_: &[u8], _: usize, _: usize) -> Result<Vec<u16>> {
  Err(Error::Unsupported("JPEG XL DNG tiles need the `jxl` feature".into()))
}

const BRADFORD: Mat3 = Mat3([
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
]);
const D50_XY: (f64, f64) = (0.3457, 0.3585);

fn xy_to_xyz((x, y): (f64, f64)) -> [f64; 3] {
  let x = x.clamp(0.01, 0.99);
  let y = y.clamp(0.01, 0.99);
  let (x, y) = if x + y > 0.99 { (x * 0.99 / (x + y), y * 0.99 / (x + y)) } else { (x, y) };
  [x / y, 1.0, (1.0 - x - y) / y]
}

fn bradford(src: [f64; 3], dst: [f64; 3]) -> Mat3 {
  let s = BRADFORD.mul_vec(src);
  let d = BRADFORD.mul_vec(dst);
  let r = [0, 1, 2].map(|i| (d[i] / s[i]).clamp(0.1, 10.0));
  BRADFORD.inverse().mul(&Mat3::diag(r)).mul(&BRADFORD)
}

fn illuminant_xy(code: u16) -> (f64, f64) {
  match code {
    17 => (0.4476, 0.4074),         // Standard light A
    20 => (0.3324, 0.3474),         // D55
    21 => (0.3127, 0.3290),         // D65
    22 => (0.2990, 0.3149),         // D75
    23 => (0.3457, 0.3585),         // D50
    _ => (0.3127, 0.3290),
  }
}

fn xy_to_cct(x: f64, y: f64) -> f64 {
  let n = (x - 0.3320) / (0.1858 - y);
  449.0 * n * n * n + 3525.0 * n * n + 6823.3 * n + 5520.33
}

impl DngInfo {
  fn illuminant_cct(&self, which: u16) -> f64 {
    let (x, y) = illuminant_xy(which);
    xy_to_cct(x, y)
  }

  /// Weight of matrix 1 for a white at `cct` (inverse-CCT interpolation).
  fn weight(&self, cct: f64) -> f64 {
    let (t1, t2) = (
      self.illuminant_cct(self.calibration_illuminant_1),
      self.illuminant_cct(self.calibration_illuminant_2),
    );
    let (lo, hi) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
    let c = cct.clamp(lo, hi);
    let w = (1.0 / c - 1.0 / t2) / (1.0 / t1 - 1.0 / t2);
    w.clamp(0.0, 1.0)
  }

  fn xyz_to_camera(&self, w: f64) -> Mat3 {
    let m = |a: &[f64; 9]| Mat3::from_rows(a);
    let cm = m(&self.color_matrix_1).scale(w).add(&m(&self.color_matrix_2).scale(1.0 - w));
    Mat3::diag(self.analog_balance).mul(&cm)
  }

  /// White point (xy) of the camera neutral, iterating CCT -> matrix like the DNG SDK.
  pub fn neutral_xy(&self, neutral: [f64; 3]) -> (f64, f64) {
    let (mut x, mut y) = D50_XY;
    for _ in 0..30 {
      let w = self.weight(xy_to_cct(x, y));
      let xyz = self.xyz_to_camera(w).inverse().mul_vec(neutral);
      let s = xyz[0] + xyz[1] + xyz[2];
      if s <= 0.0 {
        break;
      }
      let (nx, ny) = (xyz[0] / s, xyz[1] / s);
      let done = (nx - x).abs() + (ny - y).abs() < 1e-7;
      (x, y) = (nx, ny);
      if done {
        break;
      }
    }
    (x, y)
  }

  /// Forward matrix synthesised for one calibration illuminant: camera (normalised to
  /// that illuminant's neutral) to XYZ D50.
  fn synth_forward(&self, which: u16, cm: &[f64; 9]) -> Mat3 {
    let white = xy_to_xyz(illuminant_xy(which));
    let x2c = Mat3::diag(self.analog_balance).mul(&Mat3::from_rows(cm));
    let cam_n = x2c.mul_vec(white);
    let f = bradford(white, xy_to_xyz(D50_XY)).mul(&x2c.inverse()).mul(&Mat3::diag(cam_n));
    let y = f.mul_vec([1.0; 3])[1];
    f.scale(1.0 / y)
  }

  /// Camera RGB (as stored, after linearisation) -> XYZ D50, for the as-shot neutral,
  /// and the white's CCT.
  pub fn camera_to_xyz_d50(&self, neutral: [f64; 3]) -> (Mat3, f64) {
    let (x, y) = self.neutral_xy(neutral);
    let cct = xy_to_cct(x, y);
    let w = self.weight(cct);
    let fm = self
      .synth_forward(self.calibration_illuminant_1, &self.color_matrix_1)
      .scale(w)
      .add(&self.synth_forward(self.calibration_illuminant_2, &self.color_matrix_2).scale(1.0 - w));
    // Reference neutral: the camera neutral with analog balance removed, max = 1.
    let ab = self.analog_balance;
    let rn = [0, 1, 2].map(|i| neutral[i] / ab[i]);
    let m = rn[0].max(rn[1]).max(rn[2]);
    let rn = rn.map(|v| v / m);
    let c2x = fm.mul(&Mat3::diag(rn.map(|v| 1.0 / v))).mul(&Mat3::diag(ab.map(|v| 1.0 / v)));
    (c2x, cct)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn info() -> DngInfo {
    // iPhone 17 Pro Max file 116 tags.
    DngInfo {
      color_matrix_1: [1.299852848, -0.6473193765, -0.2318986207, -0.4558799863, 1.513552666, -0.02695739456, -0.04014902189, 0.1442424506, 0.6399207115],
      color_matrix_2: [0.9567329288, -0.379699856, -0.1292831898, -0.4220122099, 1.30898881, 0.08943350613, -0.09921766818, 0.2101706117, 0.467231214],
      calibration_illuminant_1: 17,
      calibration_illuminant_2: 21,
      analog_balance: [2.364257812, 1.0, 1.809081912],
      as_shot_neutral: [1.0; 3],
      baseline_exposure: 5.24,
      linearization: vec![],
      samples_per_pixel: 3,
      tone_curve: vec![],
      gain_table_map: None,
      jxl: true,
    }
  }

  #[test]
  fn neutral_maps_to_d50_white() {
    let i = info();
    let (m, _) = i.camera_to_xyz_d50([1.0; 3]);
    let w = m.mul_vec([1.0; 3]);
    let d50 = xy_to_xyz(D50_XY);
    for k in 0..3 {
      assert!((w[k] - d50[k]).abs() < 1e-6, "{w:?}");
    }
  }

  #[test]
  fn white_point_matches_rawcamera() {
    // RAWConvert inputNeutral for file 116 was (0.33832, 0.35236).
    let (x, y) = info().neutral_xy([1.0; 3]);
    assert!((x - 0.33832).abs() < 1.5e-3 && (y - 0.35236).abs() < 1.5e-3, "{x} {y}");
  }
}
