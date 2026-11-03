//! Verified tile stages of the separate Fuji Enhance Details baseline.
//!
//! DNG Converter 18.7 arm64: geometry 0x100761bc0, histogram/sparse packing
//! 0x10146a8fc, common offset removal 0x100e37244. Captured from the recursive
//! amount-50 baseline path, whose optional super-resolution fallback is absent.
//! `XtransBaseline` borrows a calibrated mosaic and adds reference gains, u16 log
//! transfer, edge-clamped halos and inverse-log output. It retains reference gains
//! for the outer partial-strength blend; it does not perform that blend.

use super::{
  DecodedMosaic, Model, Tensor, Variant,
  tiles::{Rect, TileGeometry},
};
use crate::adobe::bayer::tables;
use crate::{Cancel, Error, Result};

const CFA: [[usize; 6]; 6] = [
  [1, 2, 1, 1, 0, 1],
  [0, 1, 0, 2, 1, 2],
  [1, 2, 1, 1, 0, 1],
  [1, 0, 1, 1, 2, 1],
  [2, 1, 2, 0, 1, 0],
  [1, 0, 1, 1, 2, 1],
];

fn bad(message: &str) -> Error {
  Error::Malformed(format!("X-Trans baseline: {message}"))
}

/// Baseline geometry is 512 input → 470 output, with at most 465 requested pixels
/// per edge. Source origins align down to multiples of six, including negatives.
pub fn geometry(requested: Rect) -> Result<TileGeometry> {
  if requested.size().iter().any(|&n| n > 465) {
    return Err(bad("destination exceeds 465 pixels"));
  }
  let top = (i64::from(requested.top()) - 21).div_euclid(6) * 6;
  let left = (i64::from(requested.left()) - 21).div_euclid(6) * 6;
  let rect = |t, l, b, r| -> Result<Rect> {
    let c = |n| i32::try_from(n).map_err(|_| bad("coordinate overflow"));
    Rect::new(c(t)?, c(l)?, c(b)?, c(r)?)
  };
  let source = rect(top, left, top + 512, left + 512)?;
  let output = rect(top + 21, left + 21, top + 491, left + 491)?;
  if !output.contains(requested) {
    return Err(bad("output does not contain destination"));
  }
  Ok(TileGeometry {
    requested,
    source,
    output,
    valid: output,
  })
}

/// Borrowed decoded RAW adapter for the recursive Fuji partial-strength baseline.
/// Gains must be the canonical reference-camera gains, normalized to maximum one.
/// These are retained in the returned camera RGB for the outer strength blend.
pub struct XtransBaseline<'m, 'raw> {
  mosaic: &'m DecodedMosaic<'raw>,
  gain: [(f32, f32); 3],
  encode: Vec<u16>,
  decode: Vec<u16>,
}

impl<'m, 'raw> XtransBaseline<'m, 'raw> {
  pub fn new(mosaic: &'m DecodedMosaic<'raw>, reference_gains: [f64; 3]) -> Result<Self> {
    if mosaic.variant() != Variant::Xtrans {
      return Err(bad("expected a validated X-Trans mosaic"));
    }
    if reference_gains
      .iter()
      .any(|&g| !g.is_finite() || g <= 0.0 || g > 1.0)
      || reference_gains.into_iter().fold(0.0f64, f64::max) != 1.0
    {
      return Err(bad(
        "reference gains must be positive and normalized to maximum one",
      ));
    }
    let black = mosaic.preserved_black();
    let b = black as f32;
    let scale = -1.0 / (b - 1.0);
    let offset = -b * scale;
    let gain = reference_gains.map(|g| {
      let g = g as f32;
      (g, (g.mul_add(offset, 0.0) - offset) / scale)
    });
    Ok(Self {
      mosaic,
      gain,
      encode: tables::expand(|v| tables::log_encode(v, black)),
      decode: tables::expand(|v| tables::log_decode(v, black)),
    })
  }

  /// Produce the already encoded 1×512×512 baseline source. The baseline does
  /// not use denoise's CFA-block mirrored allocation: GetImage repeats its
  /// nearest encoded pixel at the image edge, after CFA gain and u16 log coding.
  pub fn source_tile(&self, requested: Rect, cancel: &Cancel) -> Result<Tensor> {
    let geometry = geometry(requested)?;
    let bounds = self.mosaic.bounds();
    if !bounds.contains(requested) {
      return Err(bad("destination outside mosaic"));
    }
    let mut data = Vec::with_capacity(512 * 512);
    for row in geometry.source.top()..geometry.source.bottom() {
      cancel.check()?;
      let row = row.clamp(bounds.top(), bounds.bottom() - 1);
      for column in geometry.source.left()..geometry.source.right() {
        let column = column.clamp(bounds.left(), bounds.right() - 1);
        let channel = CFA[row.rem_euclid(6) as usize][column.rem_euclid(6) as usize];
        let (gain, offset) = self.gain[channel];
        let value = gain.mul_add(self.mosaic.canonical_sample(row, column), offset);
        data.push(tables::normalized(
          self.encode[tables::code(value) as usize],
        ));
      }
    }
    Tensor::new([1, 512, 512], data)
  }

  pub fn prepare(&self, requested: Rect, cancel: &Cancel) -> Result<BaselineTile> {
    BaselineTile::prepare(
      requested,
      self.mosaic.bounds(),
      &self.source_tile(requested, cancel)?,
    )
  }

  /// Preserve the assembled baseline's u16 boundary and native inverse-log
  /// table. Output retains the reference gains and preserved black level.
  pub fn decode_output(&self, encoded: &Tensor, cancel: &Cancel) -> Result<Tensor> {
    if encoded.shape()[0] != 3 {
      return Err(bad("expected RGB baseline output"));
    }
    let mut data = Vec::with_capacity(encoded.data().len());
    for chunk in encoded.data().chunks(4096) {
      cancel.check()?;
      data.extend(
        chunk
          .iter()
          .map(|&v| tables::normalized(self.decode[tables::code(v) as usize])),
      );
    }
    Tensor::new(encoded.shape(), data)
  }

  /// Render one baseline tile. Wrapper stages are exact for captured inputs;
  /// the Rust network has numerical, rather than bit-exact, CPU agreement.
  pub fn predict(&self, model: &Model, requested: Rect, cancel: &Cancel) -> Result<Tensor> {
    if model.info().variant != Variant::XtransDetails {
      return Err(bad("expected Enhance Details model"));
    }
    let tile = self.prepare(requested, cancel)?;
    self.decode_output(
      &tile.postprocess(&model.predict(tile.input(), cancel)?)?,
      cancel,
    )
  }
}

/// One observed histogram-normalized baseline input, retaining offsets needed
/// to undo normalization after network prediction.
#[derive(Debug)]
pub struct BaselineTile {
  geometry: TileGeometry,
  offsets: [f32; 3],
  input: Tensor,
}

impl BaselineTile {
  /// Pack an already prepared 1×512×512 source. Histogram samples are limited
  /// to the intersection with canonical image bounds; halo samples are packed
  /// but excluded from the histogram. Source must have canonical X-Trans phase.
  pub fn prepare(requested: Rect, image_bounds: Rect, source: &Tensor) -> Result<Self> {
    let geometry = geometry(requested)?;
    if !image_bounds.contains(requested) || source.shape() != [1, 512, 512] {
      return Err(bad("expected in-bounds destination and 512-square source"));
    }
    if source.data().iter().any(|v| !v.is_finite()) {
      return Err(bad("nonfinite source"));
    }
    let mut histogram = vec![0u32; 3 * 65536];
    let mut counts = [0u32; 3];
    for row in 0..512 {
      let y = geometry.source.top() + row as i32;
      if y < image_bounds.top() || y >= image_bounds.bottom() {
        continue;
      }
      for column in 0..512 {
        let x = geometry.source.left() + column as i32;
        if x < image_bounds.left() || x >= image_bounds.right() {
          continue;
        }
        let channel = CFA[row % 6][column % 6];
        let code = (source.data()[row * 512 + column].clamp(0.0, 1.0) * 65535.0) as usize;
        histogram[channel * 65536 + code] += 1;
        counts[channel] += 1;
      }
    }
    if counts.contains(&0) {
      return Err(bad("histogram has an empty color plane"));
    }
    let mut offsets = [0.0; 3];
    for channel in 0..3 {
      let target = ((counts[channel] as f64 * 0.0001 + 0.5) as u32).max(1);
      let mut count = 0;
      for code in (0..65536).rev() {
        count += histogram[channel * 65536 + code];
        if count >= target {
          offsets[channel] = (0.95 - code as f64 / 65535.0).max(0.0) as f32;
          break;
        }
      }
    }
    let mut data = vec![0.0; 3 * 512 * 512];
    for (i, &value) in source.data().iter().enumerate() {
      let channel = CFA[(i / 512) % 6][(i % 512) % 6];
      data[channel * 512 * 512 + i] = value + offsets[channel];
    }
    Ok(Self {
      geometry,
      offsets,
      input: Tensor::new([3, 512, 512], data)?,
    })
  }

  pub fn geometry(&self) -> TileGeometry {
    self.geometry
  }
  pub fn offsets(&self) -> [f32; 3] {
    self.offsets
  }
  pub fn input(&self) -> &Tensor {
    &self.input
  }

  /// Crop the 3×470×470 prediction and remove offsets. Native clipping occurs
  /// only when any offset is nonzero. Output is still encoded, before inverse log.
  pub fn postprocess(&self, prediction: &Tensor) -> Result<Tensor> {
    let cropped = self.geometry.crop_model_output(prediction)?;
    if self.offsets == [0.0; 3] {
      return Ok(cropped);
    }
    let shape = cropped.shape();
    let mut data = cropped.into_data();
    let plane = shape[1] * shape[2];
    for (channel, samples) in data.chunks_exact_mut(plane).enumerate() {
      for sample in samples {
        *sample = (*sample - self.offsets[channel]).clamp(0.0, 1.0);
      }
    }
    Tensor::new(shape, data)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn assert_exact(actual: &Tensor, expected: &Tensor) {
    assert_eq!(actual.shape(), expected.shape());
    for (i, (a, b)) in actual.data().iter().zip(expected.data()).enumerate() {
      assert_eq!(a.to_bits(), b.to_bits(), "sample {i}");
    }
  }

  #[test]
  fn decoded_baseline_transfers_match_native() {
    let (Some(raw), Some(captures)) = (
      std::env::var_os("RAW_DENOISE_RAW_FIXTURES"),
      std::env::var_os("RAW_DENOISE_BASELINE_FIXTURES"),
    ) else {
      eprintln!(
        "skipped baseline transfers: set RAW_DENOISE_RAW_FIXTURES and RAW_DENOISE_BASELINE_FIXTURES"
      );
      return;
    };
    let root = std::path::PathBuf::from(captures);
    let negative =
      crate::Negative::open(std::path::PathBuf::from(raw).join("x100vi/DSCF0008.RAF")).unwrap();
    let mosaic = DecodedMosaic::new(&negative).unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(negative.meta.as_shot_wb.map(|v| 1.0 / v));
    let inverse = neutral.map(|v| 1.0 / v);
    let maximum = inverse.into_iter().fold(0.0f64, f64::max);
    let gains = inverse.map(|v| v / maximum);
    assert_eq!(gains, [1.0, 0.519793, 0.9931142134937723]);
    let baseline = XtransBaseline::new(&mosaic, gains).unwrap();
    let read = |directory: &str, name: &str| {
      Tensor::read(root.join(directory).join(format!("{name}.f32"))).unwrap()
    };
    for (dir, table) in [
      ("xtrans-log-tile", &baseline.encode),
      ("xtrans-inverse-tile", &baseline.decode),
    ] {
      let name = if dir == "xtrans-log-tile" {
        "log"
      } else {
        "inverse"
      };
      let bytes = std::fs::read(root.join(dir).join(format!("{name}-table.bin"))).unwrap();
      let expected: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|v| u16::from_le_bytes(v.try_into().unwrap()))
        .collect();
      assert_eq!(table, &expected, "{name} table");
    }
    for name in [
      "xtrans-tile",
      "xtrans-log-tile",
      "xtrans-inverse-origin",
      "xtrans-corner",
    ] {
      let capture: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join(name).join("capture.json")).unwrap())
          .unwrap();
      let a = capture["post_rect"].as_array().unwrap();
      let requested = Rect::new(
        a[0].as_i64().unwrap() as i32,
        a[1].as_i64().unwrap() as i32,
        a[2].as_i64().unwrap() as i32,
        a[3].as_i64().unwrap() as i32,
      )
      .unwrap();
      assert_exact(
        &baseline.source_tile(requested, &Cancel::never()).unwrap(),
        &read(name, "preprocess-source"),
      );
      let tile = baseline.prepare(requested, &Cancel::never()).unwrap();
      assert_exact(tile.input(), &read(name, "model-input"));
      assert_exact(
        &tile.postprocess(&read(name, "model-output")).unwrap(),
        &read(name, "postprocess-output"),
      );
    }
    if let Some(models) = std::env::var_os("RAW_DENOISE_DETAILS_FIXTURES") {
      let model =
        Model::load(std::path::PathBuf::from(models).join("xtrans_details.pbdn")).unwrap();
      // Converter default outputs are FP16-rounded; these tolerances are for
      // that native backend, not the stricter separate Core ML CPU reference.
      for (name, requested) in [
        ("xtrans-tile", Rect::new(0, 0, 465, 465).unwrap()),
        ("xtrans-corner", Rect::new(5115, 7440, 5154, 7733).unwrap()),
      ] {
        let actual = baseline
          .predict(&model, requested, &Cancel::never())
          .unwrap();
        let expected = baseline
          .decode_output(&read(name, "postprocess-output"), &Cancel::never())
          .unwrap();
        let mut max = 0.0f64;
        let mut sum = 0.0f64;
        let mut changed = 0;
        for (&a, &b) in actual.data().iter().zip(expected.data()) {
          let d = a as f64 - b as f64;
          max = max.max(d.abs());
          sum += d * d;
          changed += usize::from(a.to_bits() != b.to_bits());
        }
        let rmse = (sum / actual.data().len() as f64).sqrt();
        eprintln!(
          "{name} full baseline: max_abs={max:.9e} rmse={rmse:.9e} changed={changed}/{}",
          actual.data().len()
        );
        assert!(
          max <= 3e-4 && rmse <= 7e-5,
          "baseline numerical agreement regressed"
        );
      }
    }
    let inverse_input = read("xtrans-inverse-tile", "inverse-input");
    assert_exact(
      &baseline
        .decode_output(&inverse_input, &Cancel::never())
        .unwrap(),
      &read("xtrans-inverse-tile", "inverse-output"),
    );
    // Native postprocess writes u16 before the inverse-log whole-image pipe.
    let post = read("xtrans-inverse-origin", "postprocess-output");
    let decoded = baseline.decode_output(&post, &Cancel::never()).unwrap();
    let expected = read("xtrans-inverse-origin", "inverse-output");
    let [_, h, w] = expected.shape();
    let mut crop = Vec::new();
    for c in 0..3 {
      for y in 0..h {
        let start = c * 465 * 465 + y * 465;
        crop.extend_from_slice(&decoded.data()[start..start + w]);
      }
    }
    assert_exact(&Tensor::new([3, h, w], crop).unwrap(), &expected);
  }

  #[test]
  fn native_geometry_oracle() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../tests/fixtures/adobe-denoise-details-tiles.json"
    ))
    .unwrap();
    let rect = |v: &serde_json::Value| {
      let a = v.as_array().unwrap();
      Rect::new(
        a[0].as_i64().unwrap() as i32,
        a[1].as_i64().unwrap() as i32,
        a[2].as_i64().unwrap() as i32,
        a[3].as_i64().unwrap() as i32,
      )
      .unwrap()
    };
    for case in fixture["cases"].as_array().unwrap() {
      let actual = geometry(rect(&case["requested"])).unwrap();
      assert_eq!(actual.source, rect(&case["source"]));
      assert_eq!(actual.output, rect(&case["output"]));
      assert_eq!(actual.valid, rect(&case["valid"]));
    }
    assert!(geometry(Rect::new(0, 0, 466, 1).unwrap()).is_err());
    assert!(geometry(Rect::new(i32::MIN, 0, i32::MIN + 1, 1).unwrap()).is_err());
  }

  #[test]
  fn recursive_native_baseline_capture() {
    let Some(root) = std::env::var_os("RAW_DENOISE_BASELINE_FIXTURES") else {
      eprintln!("skipped baseline capture: set RAW_DENOISE_BASELINE_FIXTURES");
      return;
    };
    let root = std::path::PathBuf::from(root).join("xtrans-tile");
    let read = |name: &str| Tensor::read(root.join(format!("{name}.f32"))).unwrap();
    let tile = BaselineTile::prepare(
      Rect::new(0, 0, 465, 465).unwrap(),
      Rect::new(0, 0, 5154, 7733).unwrap(),
      &read("preprocess-source"),
    )
    .unwrap();
    let equal = |actual: &Tensor, expected: &Tensor| {
      assert_eq!(actual.shape(), expected.shape());
      for (i, (a, b)) in actual.data().iter().zip(expected.data()).enumerate() {
        assert_eq!(a.to_bits(), b.to_bits(), "sample {i}");
      }
    };
    equal(tile.input(), &read("model-input"));
    equal(
      &tile.postprocess(&read("model-output")).unwrap(),
      &read("postprocess-output"),
    );
    assert_eq!(
      tile.offsets(),
      [29192, 28882, 29623].map(|v| (0.95 - v as f64 / 65535.0) as f32)
    );
  }

  #[test]
  fn zero_offsets_preserve_unclipped_output() {
    let tile = BaselineTile::prepare(
      Rect::new(0, 0, 6, 6).unwrap(),
      Rect::new(0, 0, 512, 512).unwrap(),
      &Tensor::new([1, 512, 512], vec![1.0; 512 * 512]).unwrap(),
    )
    .unwrap();
    assert_eq!(tile.offsets(), [0.0; 3]);
    let prediction = Tensor::new([3, 470, 470], vec![-0.5; 3 * 470 * 470]).unwrap();
    assert!(
      tile
        .postprocess(&prediction)
        .unwrap()
        .data()
        .iter()
        .all(|&v| v == -0.5)
    );
  }
}
