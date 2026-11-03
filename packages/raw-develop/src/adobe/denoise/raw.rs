//! Decoded sensor adapter for camera/readout layouts checked against native tiles.
//!
//! This boundary keeps the stored readout, native canonical processing extent,
//! and final active crop distinct. Fuji's leading canonical rows/columns repeat
//! the first CFA period of the active sensor area before the mirrored halo is
//! constructed. Cropping the raw mosaic directly to the final output is wrong.
//!
//! Runtime provenance: `wrapper/geometry-{bayer,xtrans}/geometry.json` records
//! Interpolate/CFA-get/mirror/model image bounds from Converter18.7. Independent
//! full-tile and final-corner captures validate decoded samples and model inputs.

use super::{
  Tensor, Variant,
  border::PhaseMirror,
  tiles::{Rect, TileGeometry},
};
use crate::{
  Cancel, Error, Negative, Result,
  cfa::{CfaPattern, Channel},
  metadata::Container,
};

/// Calibrated, canonical mosaic view over an already decoded RAW. No full-size
/// float copy is required: each source tile is sampled directly from the u16
/// readout. Accepted layouts are deliberately narrower than ordinary development.
/// Bayer retains a calibrated u16 image so its spatial hot-pixel stage is run
/// once before any mirroring or tile extraction.
pub struct DecodedMosaic<'a> {
  negative: &'a Negative,
  variant: Variant,
  bounds: Rect,
  active_crop: Rect,
  sensor_origin: [i32; 2],
  sensor_bounds: Rect,
  period: i32,
  mirror: PhaseMirror,
  preserved_black: f64,
  table: Vec<f32>,
  calibrated_codes: Option<Vec<u16>>,
}

impl<'a> DecodedMosaic<'a> {
  pub fn new(negative: &'a Negative) -> Result<Self> {
    Self::new_with_cancel(negative, &Cancel::never())
  }

  pub fn new_with_cancel(negative: &'a Negative, cancel: &Cancel) -> Result<Self> {
    cancel.check()?;
    let m = &negative.meta;
    if negative.dng.is_some() {
      return Err(Error::Unsupported(
        "denoise RAW: dense/LinearRaw calibration is not implemented".into(),
      ));
    }
    if m.raw_width.checked_mul(m.raw_height) != Some(negative.mosaic.len()) {
      return Err(Error::Malformed(
        "denoise RAW: expected a complete sensor mosaic".into(),
      ));
    }
    // Exact camera/readout gates prevent treating inferred CFA offsets as a
    // universal raw-coordinate convention. Broaden only with independent captures.
    let (variant, bounds, active_crop, sensor_origin, sensor_bounds, period, padding) = if m
      .container
      == Container::Raf
      && m.make == "FUJIFILM"
      && m.model == "X100VI"
      && (m.raw_height, m.raw_width) == (5196, 7872)
      && (m.crop_top, m.crop_left, m.crop_height, m.crop_width) == (21, 12, 5152, 7728)
      && m.cfa == CfaPattern::xtrans_default()
      && m.bits_per_sample == 14
      && m.black_levels.len() == 36
      && m.black_levels.iter().all(|&v| v == 1023)
      && matches!(m.white_level, None | Some(16383))
    {
      (
        Variant::Xtrans,
        Rect::new(0, 0, 5154, 7733)?,
        Rect::new(2, 5, 5154, 7733)?,
        [19, 7],
        Rect::new(21, 12, 5173, 7740)?,
        6,
        80,
      )
    } else if m.container == Container::Arw
      && m.make == "SONY"
      && m.model == "ILCE-1M2"
      && (m.raw_height, m.raw_width) == (4096, 6144)
      && m.sony_raw_format == Some(4)
      && (m.crop_top, m.crop_left, m.crop_height, m.crop_width) == (12, 12, 3744, 5616)
      && m.cfa
        == CfaPattern::new(
          2,
          2,
          vec![Channel::Red, Channel::Green, Channel::Green, Channel::Blue],
        )?
      && m.bits_per_sample == 14
      && m.black_levels.len() == 4
      && m.black_levels.iter().all(|&v| v == 512)
      && matches!(m.white_level, None | Some(16383))
      && m
        .exposure_time
        .is_some_and(|v| v.is_finite() && v > 0.0 && v < 2.0)
    {
      (
        Variant::Bayer,
        Rect::new(0, 0, 3768, 5638)?,
        Rect::new(12, 12, 3756, 5628)?,
        [0, 0],
        Rect::new(0, 0, 3768, 5638)?,
        2,
        112,
      )
    } else {
      return Err(Error::Unsupported(format!(
        "denoise RAW: unvalidated calibration for {} ({}x{}, crop {},{},{},{}, exposure {:?}); Sony requires known exposure below 2 seconds",
        m.model,
        m.raw_width,
        m.raw_height,
        m.crop_top,
        m.crop_left,
        m.crop_height,
        m.crop_width,
        m.exposure_time
      )));
    };
    let black = m.black_levels[0];
    let preserved_black = ((u32::from(black)) << (16 - m.bits_per_sample)) as f64 / 65535.0;
    let table = super::super::linearize::table(
      black,
      super::super::white_level(m) as f64,
      m.bits_per_sample,
    );
    cancel.check()?;
    let calibrated_codes = if variant == Variant::Bayer {
      let [height, width] = bounds.size();
      Some(super::super::bayer::denoise_prepare_short_exposure(
        width,
        height,
        preserved_black,
        cancel,
        |row, column| {
          (table[negative.sample(row, column) as usize] * 65535.0).round_ties_even() as u16
        },
      )?)
    } else {
      None
    };
    Ok(Self {
      negative,
      variant,
      bounds,
      active_crop,
      sensor_origin,
      sensor_bounds,
      period,
      mirror: PhaseMirror::new(bounds, padding, period as u32)?,
      preserved_black,
      table,
      calibrated_codes,
    })
  }

  pub fn variant(&self) -> Variant {
    self.variant
  }
  /// Canonical processing extent; this can exceed the final active crop.
  pub fn bounds(&self) -> Rect {
    self.bounds
  }
  /// Final unrotated output crop expressed in canonical coordinates.
  pub fn active_crop(&self) -> Rect {
    self.active_crop
  }
  pub fn preserved_black(&self) -> f64 {
    self.preserved_black
  }

  /// Calibrate an unpadded canonical region, useful for checking the complete
  /// source boundary without invoking a network. Request one row/strip to bound
  /// allocation. Each requested dimension must respect Tensor's 4096 limit;
  /// split a wider source into multiple regions.
  pub fn canonical_area(&self, area: Rect, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    if !self.bounds.contains(area) {
      return Err(Error::Malformed(
        "denoise RAW: canonical region outside bounds".into(),
      ));
    }
    let [height, width] = area.size();
    let count = super::format::elements([1, height, width])?;
    let mut samples = Vec::with_capacity(count);
    for row in area.top()..area.bottom() {
      cancel.check()?;
      for column in area.left()..area.right() {
        samples.push(self.canonical_sample(row, column));
      }
    }
    Tensor::new([1, height, width], samples)
  }

  pub(super) fn canonical_sample(&self, row: i32, column: i32) -> f32 {
    if let Some(codes) = &self.calibrated_codes {
      let width = self.bounds.size()[1];
      let index =
        (row - self.bounds.top()) as usize * width + (column - self.bounds.left()) as usize;
      return codes[index] as f32 * (1.0 / 65535.0);
    }
    let repeat = |v: i32, lo: i32, hi: i32| {
      if v < lo {
        lo + (v - lo).rem_euclid(self.period)
      } else if v >= hi {
        hi - 1 - (hi - 1 - v).rem_euclid(self.period)
      } else {
        v
      }
    };
    let sy = repeat(
      row + self.sensor_origin[0],
      self.sensor_bounds.top(),
      self.sensor_bounds.bottom(),
    );
    let sx = repeat(
      column + self.sensor_origin[1],
      self.sensor_bounds.left(),
      self.sensor_bounds.right(),
    );
    self.table[self.negative.sample(sy as usize, sx as usize) as usize]
  }

  /// Extract one planned 1024-square source tile with all observed border steps.
  /// Input is the requested destination tile, in canonical image coordinates.
  pub fn source_tile(&self, requested: Rect, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    if !self.bounds.contains(requested) {
      return Err(Error::Malformed(
        "denoise RAW: requested destination outside canonical bounds".into(),
      ));
    }
    let geometry = TileGeometry::calculate(self.variant, requested)?;
    let mut samples = Vec::with_capacity(1024 * 1024);
    for row in geometry.source.top()..geometry.source.bottom() {
      cancel.check()?;
      for column in geometry.source.left()..geometry.source.right() {
        let [r, c] = self.mirror.source_coordinate_with_edge_repeat(row, column);
        samples.push(self.canonical_sample(r, c));
      }
    }
    Tensor::new([1, 1024, 1024], samples)
  }
}

#[cfg(test)]
mod tests {
  use super::super::MosaicTilePlan;
  use super::*;
  use std::path::PathBuf;

  #[test]
  fn complete_canonical_sources_match_native_capture() {
    use std::io::Read;
    let (Some(raw_root), Some(captures)) = (
      std::env::var_os("RAW_DENOISE_RAW_FIXTURES").map(PathBuf::from),
      std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES").map(PathBuf::from),
    ) else {
      return;
    };
    for (name, raw_path) in [
      ("bayer", "a1m2/12766.ARW"),
      ("xtrans", "x100vi/DSCF0008.RAF"),
    ] {
      let path = captures.join(format!("{name}-whole-source/source.f32"));
      if !path.exists() {
        eprintln!("skipped absent whole source {name}");
        continue;
      }
      let negative = Negative::open(raw_root.join(raw_path)).unwrap();
      let decoded = DecodedMosaic::new(&negative).unwrap();
      let bounds = decoded.bounds();
      let [height, width] = bounds.size();
      let file = std::fs::File::open(path).unwrap();
      assert_eq!(file.metadata().unwrap().len(), (height * width * 4) as u64);
      let mut reader = std::io::BufReader::new(file);
      let mut mismatches = 0usize;
      let mut first = Vec::new();
      for top in (bounds.top()..bounds.bottom()).step_by(64) {
        let bottom = (top + 64).min(bounds.bottom());
        let mut bytes = vec![0u8; (bottom - top) as usize * width * 4];
        reader.read_exact(&mut bytes).unwrap();
        for left in (bounds.left()..bounds.right()).step_by(2048) {
          let right = (left + 2048).min(bounds.right());
          let actual = decoded
            .canonical_area(
              Rect::new(top, left, bottom, right).unwrap(),
              &Cancel::never(),
            )
            .unwrap();
          let chunk_width = (right - left) as usize;
          for (i, sample) in actual.data().iter().enumerate() {
            let row = i / chunk_width;
            let column = left as usize + i % chunk_width;
            let offset = (row * width + column) * 4;
            let expected = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            if sample.to_bits() != expected {
              mismatches += 1;
              if first.len() < 12 {
                first.push((top + row as i32, column, *sample, f32::from_bits(expected)));
              }
            }
          }
        }
      }
      eprintln!(
        "{name}: {} whole canonical samples, {mismatches} mismatches; first {first:?}",
        height * width
      );
      assert_eq!(mismatches, 0, "{name}: whole canonical source differs");
    }
  }

  #[test]
  fn decoded_raw_source_and_network_inputs_match_native_captures() {
    let (Some(raw_root), Some(captures)) = (
      std::env::var_os("RAW_DENOISE_RAW_FIXTURES").map(PathBuf::from),
      std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES").map(PathBuf::from),
    ) else {
      eprintln!(
        "skipped decoded RAW captures: set RAW_DENOISE_RAW_FIXTURES and RAW_DENOISE_CAPTURE_FIXTURES"
      );
      return;
    };
    for (variant_name, raw_path, bounds, crop) in [
      (
        "xtrans",
        "x100vi/DSCF0008.RAF",
        [0, 0, 5154, 7733],
        [2, 5, 5154, 7733],
      ),
      (
        "bayer",
        "a1m2/12766.ARW",
        [0, 0, 3768, 5638],
        [12, 12, 3756, 5628],
      ),
    ] {
      let mut negative = Negative::open(raw_root.join(raw_path)).unwrap();
      let decoded = DecodedMosaic::new(&negative).unwrap();
      assert_eq!(decoded.bounds().as_array(), bounds);
      assert_eq!(decoded.active_crop().as_array(), crop);
      for suffix in ["full-tile", "corner"] {
        let name = format!("{variant_name}-{suffix}");
        let directory = captures.join(&name);
        let capture: serde_json::Value =
          serde_json::from_slice(&std::fs::read(directory.join("capture.json")).unwrap()).unwrap();
        assert_eq!(capture["done"], true);
        let a = capture["post_rect"].as_array().unwrap();
        let requested = Rect::new(
          a[0].as_i64().unwrap() as i32,
          a[1].as_i64().unwrap() as i32,
          a[2].as_i64().unwrap() as i32,
          a[3].as_i64().unwrap() as i32,
        )
        .unwrap();
        let plan =
          MosaicTilePlan::new(decoded.variant(), requested, decoded.preserved_black()).unwrap();
        let source = decoded.source_tile(requested, &Cancel::never()).unwrap();
        let expected = Tensor::read(directory.join("source-preserved.f32")).unwrap();
        assert_eq!(source.shape(), expected.shape());
        let mismatches = source
          .data()
          .iter()
          .zip(expected.data())
          .filter(|(a, b)| a.to_bits() != b.to_bits())
          .count();
        assert_eq!(mismatches, 0, "{name}: decoded source differs");
        let input = plan
          .prepare_input(plan.geometry().source, &source, &Cancel::never())
          .unwrap();
        let expected = Tensor::read(directory.join("model-input.f32")).unwrap();
        assert_eq!(input.shape(), expected.shape());
        let mismatches = input
          .data()
          .iter()
          .zip(expected.data())
          .filter(|(a, b)| a.to_bits() != b.to_bits())
          .count();
        assert_eq!(mismatches, 0, "{name}: decoded network input differs");
        eprintln!(
          "{name}: {} source and {} model-input samples bit-exact",
          source.data().len(),
          input.data().len()
        );
      }
      let cancel = Cancel::new();
      cancel.cancel();
      assert!(matches!(
        DecodedMosaic::new_with_cancel(&negative, &cancel),
        Err(Error::Cancelled)
      ));
      assert!(matches!(
        decoded.source_tile(Rect::new(0, 0, 1, 1).unwrap(), &cancel),
        Err(Error::Cancelled)
      ));
      assert!(
        decoded
          .source_tile(Rect::new(-1, 0, 1, 1).unwrap(), &Cancel::never())
          .is_err()
      );
      drop(decoded);
      negative.meta.crop_left += 1;
      assert!(DecodedMosaic::new(&negative).is_err());
      negative.meta.crop_left -= 1;
      negative.meta.black_levels[0] -= 1;
      assert!(DecodedMosaic::new(&negative).is_err());
      negative.meta.black_levels[0] += 1;
      if variant_name == "bayer" {
        for exposure in [None, Some(2.0), Some(f64::NAN), Some(-1.0)] {
          negative.meta.exposure_time = exposure;
          assert!(DecodedMosaic::new(&negative).is_err());
        }
      }
    }
  }
}
