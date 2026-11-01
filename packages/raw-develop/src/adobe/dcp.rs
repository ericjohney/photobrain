//! DNG Camera Profile (`.dcp`) reader.
//!
//! A DCP is a TIFF-structured file with magic `IIRC` (or `MMCR`) holding the DNG
//! profile tags (DNG specification 1.6, chapter 6). Profiles are Adobe's data and are
//! never bundled: they are read at runtime from a directory the caller configures
//! (`ADOBE_PROFILE_DIR`), laid out like Adobe's
//! `CameraProfiles/Adobe Standard/<Make> <Model> Adobe Standard.dcp`.

use crate::error::{Error, Result};
use crate::tiff::{Endian, TiffReader};
use std::path::{Path, PathBuf};

pub(crate) fn valid_dims(dims: [usize; 3], count: usize) -> bool {
  dims[0] > 0
    && dims[1] >= 2
    && dims[2] > 0
    && dims.iter().all(|&d| d <= 256)
    && dims.iter().try_fold(1usize, |n, &d| n.checked_mul(d)) == Some(count)
}

/// One HueSatMap / LookTable: `dims = [hue, sat, val]`, entries in val-major,
/// then hue, then sat order, each `[hue shift degrees, sat scale, val scale]`.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct HueSatMap {
  pub dims: [usize; 3],
  pub data: Vec<[f32; 3]>,
}

impl HueSatMap {
  pub(crate) fn valid_portable(&self) -> bool {
    valid_dims(self.dims, self.data.len()) && self.data.iter().flatten().all(|v| v.is_finite())
  }

  fn new(dims: [usize; 3], flat: &[f64]) -> Result<Self> {
    let n = dims[0] * dims[1] * dims[2];
    if dims[0] == 0 || dims[1] < 2 || dims[2] == 0 || flat.len() != n * 3 {
      return Err(Error::Malformed("DCP hue/sat table size mismatch".into()));
    }
    Ok(Self {
      dims,
      data: flat
        .as_chunks::<3>()
        .0
        .iter()
        .map(|c| [c[0] as f32, c[1] as f32, c[2] as f32])
        .collect(),
    })
  }

  /// Entry-wise `w * a + (1 - w) * b` (both tables must share dimensions).
  pub fn blend(a: &Self, b: &Self, w: f64) -> Self {
    if w >= 1.0 {
      return a.clone();
    }
    if w <= 0.0 {
      return b.clone();
    }
    let w = w as f32;
    Self {
      dims: a.dims,
      data: a
        .data
        .iter()
        .zip(&b.data)
        .map(|(x, y)| std::array::from_fn(|k| w.mul_add(x[k], (1.0 - w) * y[k])))
        .collect(),
    }
  }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Dcp {
  pub camera_model: String,
  pub profile_name: String,
  /// Only a matching signature permits applying the negative's body calibration.
  pub calibration_signature: String,
  pub calibration_illuminant_1: u16,
  pub calibration_illuminant_2: u16,
  pub color_matrix_1: [f64; 9],
  pub color_matrix_2: [f64; 9],
  pub forward_matrix_1: Option<[f64; 9]>,
  pub forward_matrix_2: Option<[f64; 9]>,
  pub hue_sat_map_1: Option<HueSatMap>,
  pub hue_sat_map_2: Option<HueSatMap>,
  pub look_table: Option<HueSatMap>,
  /// `ProfileHueSatMapEncoding` / `ProfileLookTableEncoding`: 0 linear, 1 sRGB.
  pub hue_sat_map_encoding: u32,
  pub look_table_encoding: u32,
  /// `ProfileToneCurve` (x, y) pairs, if present.
  pub tone_curve: Option<Vec<(f32, f32)>>,
  pub baseline_exposure_offset: f64,
  /// `DefaultBlackRender`: 0 auto, 1 none.
  pub default_black_render: u32,
}

fn mat9(v: Vec<f64>, name: &str) -> Result<[f64; 9]> {
  v.try_into()
    .map_err(|_| Error::Malformed(format!("DCP {name} must have 9 values")))
}

impl Dcp {
  pub fn parse(data: &[u8]) -> Result<Self> {
    let endian = match data.get(..4) {
      Some(b"IIRC") => Endian::Little,
      Some(b"MMCR") => Endian::Big,
      _ => return Err(Error::Malformed("not a DCP file".into())),
    };
    let r = TiffReader::with_endian(data, endian);
    let ifd = r.ifd(r.first_ifd_offset()?)?;
    let f64s =
      |tag: u16| -> Result<Option<Vec<f64>>> { ifd.get(tag).map(|e| e.values_f64(&r)).transpose() };
    let req = |tag: u16, name: &str| -> Result<Vec<f64>> {
      f64s(tag)?.ok_or_else(|| Error::Malformed(format!("DCP missing {name}")))
    };
    let u = |tag: u16, default: u32| -> Result<u32> {
      Ok(
        f64s(tag)?
          .and_then(|v| v.first().copied())
          .map_or(default, |v| v as u32),
      )
    };
    let text = |tag: u16| -> Result<String> {
      Ok(
        ifd
          .get(tag)
          .map(|e| e.ascii(&r))
          .transpose()?
          .unwrap_or_default(),
      )
    };
    let dims = |tag: u16| -> Result<Option<[usize; 3]>> {
      Ok(f64s(tag)?.map(|v| {
        let g = |i: usize| v.get(i).copied().unwrap_or(1.0) as usize;
        [g(0), g(1), g(2)]
      }))
    };
    let table = |d: Option<[usize; 3]>, tag: u16| -> Result<Option<HueSatMap>> {
      match (d, f64s(tag)?) {
        (Some(d), Some(v)) => HueSatMap::new(d, &v).map(Some),
        _ => Ok(None),
      }
    };
    let hs_dims = dims(50937)?;
    let tone_curve = f64s(50940)?.map(|v| {
      v.as_chunks::<2>()
        .0
        .iter()
        .map(|p| (p[0] as f32, p[1] as f32))
        .collect::<Vec<_>>()
    });
    Ok(Self {
      camera_model: text(50708)?,
      profile_name: text(50936)?,
      calibration_signature: text(50932)?,
      calibration_illuminant_1: u(50778, 0)? as u16,
      calibration_illuminant_2: u(50779, 0)? as u16,
      color_matrix_1: mat9(req(50721, "ColorMatrix1")?, "ColorMatrix1")?,
      color_matrix_2: mat9(req(50722, "ColorMatrix2")?, "ColorMatrix2")?,
      forward_matrix_1: f64s(50964)?
        .map(|v| mat9(v, "ForwardMatrix1"))
        .transpose()?,
      forward_matrix_2: f64s(50965)?
        .map(|v| mat9(v, "ForwardMatrix2"))
        .transpose()?,
      hue_sat_map_1: table(hs_dims, 50938)?,
      hue_sat_map_2: table(hs_dims, 50939)?,
      look_table: table(dims(50981)?, 50982)?,
      hue_sat_map_encoding: u(51107, 0)?,
      look_table_encoding: u(51108, 0)?,
      tone_curve,
      baseline_exposure_offset: f64s(51109)?.and_then(|v| v.first().copied()).unwrap_or(0.0),
      default_black_render: u(51110, 0)?,
    })
  }

  pub fn open(path: &Path) -> Result<Self> {
    Self::parse(&std::fs::read(path)?)
  }

  /// `<dir>/Adobe Standard/<Make> <Model> Adobe Standard.dcp`, with Adobe's make
  /// capitalisation ("Fujifilm", "Sony"); falls back to `<dir>/<same name>`.
  pub fn find_adobe_standard(dir: &Path, make: &str, model: &str) -> Result<PathBuf> {
    let make = adobe_make(make);
    let name = format!("{make} {} Adobe Standard.dcp", model.trim());
    for p in [dir.join("Adobe Standard").join(&name), dir.join(&name)] {
      if p.is_file() {
        return Ok(p);
      }
    }
    Err(Error::Unsupported(format!(
      "no Adobe Standard profile \"{name}\" in {}",
      dir.display()
    )))
  }
}

fn adobe_make(make: &str) -> String {
  let m = make.trim();
  match m.to_ascii_uppercase().as_str() {
    "FUJIFILM" => "Fujifilm".into(),
    "SONY" => "Sony".into(),
    "APPLE" => "Apple".into(),
    _ => m.into(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Little-endian DCP with ColorMatrix1/2, a 2x2x1 HueSatMap and a tone curve.
  fn synthetic() -> Vec<u8> {
    let mut entries: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
    let srat = |v: &[f64]| -> Vec<u8> {
      v.iter()
        .flat_map(|x| {
          let n = (x * 10000.0).round() as i32;
          [n.to_le_bytes(), 10000i32.to_le_bytes()].concat()
        })
        .collect()
    };
    let float = |v: &[f32]| -> Vec<u8> { v.iter().flat_map(|x| x.to_le_bytes()).collect() };
    let ident = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    entries.push((50721, 10, 9, srat(&ident)));
    entries.push((50722, 10, 9, srat(&ident)));
    entries.push((50778, 3, 1, 17u16.to_le_bytes().to_vec()));
    entries.push((50779, 3, 1, 21u16.to_le_bytes().to_vec()));
    entries.push((
      50937,
      4,
      3,
      [2u32, 2, 1].iter().flat_map(|v| v.to_le_bytes()).collect(),
    ));
    let hs: Vec<f32> = (0..4).flat_map(|i| [i as f32, 1.0, 1.0]).collect();
    entries.push((50938, 11, 12, float(&hs)));
    entries.push((50940, 11, 4, float(&[0.0, 0.0, 1.0, 1.0])));
    entries.sort_by_key(|e| e.0);
    let n = entries.len();
    let mut out = b"IIRC".to_vec();
    out.extend_from_slice(&8u32.to_le_bytes());
    let mut data_off = 8 + 2 + 12 * n + 4;
    let mut ifd = (n as u16).to_le_bytes().to_vec();
    let mut blob = Vec::new();
    for (tag, typ, count, bytes) in &entries {
      ifd.extend_from_slice(&tag.to_le_bytes());
      ifd.extend_from_slice(&typ.to_le_bytes());
      ifd.extend_from_slice(&count.to_le_bytes());
      if bytes.len() <= 4 {
        let mut f = bytes.clone();
        f.resize(4, 0);
        ifd.extend_from_slice(&f);
      } else {
        ifd.extend_from_slice(&(data_off as u32).to_le_bytes());
        blob.extend_from_slice(bytes);
        data_off += bytes.len();
      }
    }
    ifd.extend_from_slice(&0u32.to_le_bytes());
    out.extend(ifd);
    out.extend(blob);
    out
  }

  #[test]
  fn parses_synthetic_profile() {
    let d = Dcp::parse(&synthetic()).unwrap();
    assert_eq!(d.calibration_illuminant_1, 17);
    assert_eq!(d.color_matrix_2[4], 1.0);
    let hs = d.hue_sat_map_1.unwrap();
    assert_eq!(hs.dims, [2, 2, 1]);
    assert_eq!(hs.data[3], [3.0, 1.0, 1.0]);
    assert!(d.hue_sat_map_2.is_none() && d.look_table.is_none());
    assert_eq!(d.tone_curve.unwrap(), vec![(0.0, 0.0), (1.0, 1.0)]);
  }

  #[test]
  fn rejects_plain_tiff() {
    assert!(Dcp::parse(b"II*\0\x08\0\0\0").is_err());
  }

  #[test]
  fn adobe_make_names() {
    assert_eq!(adobe_make("FUJIFILM"), "Fujifilm");
    assert_eq!(adobe_make("SONY "), "Sony");
  }
}
