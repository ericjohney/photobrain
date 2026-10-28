//! Modern Camera Raw's global camera-to-RIMM boundary (`ABCtoRGB_local` with
//! no local adjustments). RIMM is linear ProPhoto with the sensor black offset
//! preserved. CR6 noise reduction follows this stage, before the profile tables.
//!
//! The 18.7 CPU path quantizes camera gains to 1/4096 and the colour matrix with
//! DNG SafeRound. Its highlight shoulder and arithmetic order differ from the
//! public SDK baseline renderer. Captured f32 input/output tiles validate this
//! helper independently; it is not yet used by the final renderer.

use super::color::ColorSpec;
use crate::math::Mat3;

#[derive(Clone, Debug)]
pub(crate) struct InputTransform {
  order: [usize; 3],
  gains: [f32; 3],
  matrix: [[f32; 3]; 3],
  scale: [f32; 3],
  bias: [f32; 3],
  knee: [f32; 3],
  inverse_shoulder: [f32; 3],
  black: f32,
}

impl InputTransform {
  pub(crate) fn new(spec: &ColorSpec, neutral: [f64; 3], black: f64) -> Self {
    let gains = spec
      .camera_white
      .map(|v| ((4096.0 / v).round().min(65535.0) / 4096.0) as f32);
    let mut order = [0, 1, 2];
    order.sort_by(|&a, &b| gains[b].total_cmp(&gains[a]));
    let matrix = spec
      .balanced_to_prophoto
      .mul(&Mat3::diag(std::array::from_fn(|c| {
        spec.camera_white[c] / neutral[c]
      })));
    let matrix = safe_round(matrix);
    Self::from_parameters(gains, order, matrix.to_f32(), black as f32)
  }

  /// Full-render sensor scale used by the following CR6 noise model. This is
  /// the reciprocal of the quantized maximum gain, rather than min(CameraWhite).
  pub(crate) fn noise_scale(&self) -> f64 {
    1.0 / f64::from(self.maximum_gain())
  }

  pub(crate) fn maximum_gain(&self) -> f32 {
    self.gains[self.order[0]]
  }

  /// Exposure state consumes the quantized f32 gain promoted directly to f64.
  /// Reconstructing it from `noise_scale` adds a reciprocal round trip.
  pub(crate) fn exposure_adjustment(&self) -> f64 {
    f64::from(self.maximum_gain()).ln() / std::f64::consts::LN_2
  }

  /// The separate one-pixel `RawLinearToRIMM` path uses ordinary RefABCtoRGB32,
  /// with full gains and hard channel clipping, instead of the modern shoulder.
  /// Its input transform is constructed with zero sensor black.
  pub(crate) fn headroom_pixel(&self, pixel: [f32; 3]) -> [f32; 3] {
    debug_assert_eq!(self.black, 0.0);
    let c = [
      (pixel[self.order[0]] * self.gains[self.order[0]]).min(1.0),
      (pixel[self.order[1]] * self.gains[self.order[1]]).min(1.0),
      pixel[self.order[2]],
    ];
    self.matrix.map(|row| {
      c[2]
        .mul_add(row[2], c[1].mul_add(row[1], c[0] * row[0]))
        .clamp(0.0, 1.0)
    })
  }

  fn from_parameters(
    gains: [f32; 3],
    order: [usize; 3],
    matrix: [[f32; 3]; 3],
    black: f32,
  ) -> Self {
    let relative = [
      1.0,
      gains[order[1]] / gains[order[0]],
      1.0 / gains[order[0]],
    ];
    let range = -(black - 1.0);
    let inverse_range = if black == 1.0 {
      0.0
    } else {
      -1.0 / (black - 1.0)
    };
    let offset = -black * inverse_range;
    // Supported RAF/ARW bodies have LinearResponseLimit = 1. The shoulder
    // starts at one quarter of each channel's relative saturation.
    let knee = relative.map(|v| v * 0.25);
    Self {
      order,
      gains,
      matrix: matrix.map(|row| std::array::from_fn(|c| row[order[c]] * range)),
      scale: relative.map(|v| v * inverse_range),
      bias: relative.map(|v| v * offset),
      knee,
      inverse_shoulder: std::array::from_fn(|c| 1.0 / (relative[c] - knee[c])),
      black,
    }
  }

  /// Preserved-black, unbalanced camera RGB -> preserved-black RIMM.
  #[inline]
  pub(crate) fn pixel(&self, pixel: [f32; 3]) -> [f32; 3] {
    let mut c: [f32; 3] =
      std::array::from_fn(|i| pixel[self.order[i]].mul_add(self.scale[i], self.bias[i]));
    if 1.0 / self.gains[self.order[0]] < 1.0 {
      let maximum = c[0].max(c[1]);
      for i in 0..2 {
        let t = ((c[i] - self.knee[i]) * self.inverse_shoulder[i]).max(0.0);
        // SIMDABCtoRGB32_2012_Global deliberately uses separate multiply/add
        // for the shoulder, then fused multiply/add for the colour matrix.
        c[i] += (maximum - c[i]) * (t * t);
      }
      let maximum = ((c[0] + c[1]) * 0.5).max(c[2]);
      let t = ((c[2] - self.knee[2]) * self.inverse_shoulder[2]).max(0.0);
      c[2] += (maximum - c[2]) * (t * t);
    }
    self.matrix.map(|row| {
      c[2]
        .mul_add(
          row[2],
          c[1].mul_add(row[1], c[0].mul_add(row[0], self.black)),
        )
        .clamp(0.0, 1.0)
    })
  }
}

/// `dng_matrix::SafeRound`: carry rounding error across each row so that the
/// rounded matrix preserves the row's total as closely as possible.
fn safe_round(matrix: Mat3) -> Mat3 {
  let norm = matrix
    .0
    .iter()
    .map(|row| {
      row
        .iter()
        .copied()
        .filter(|v| *v > 0.0)
        .sum::<f64>()
        .max(-row.iter().copied().filter(|v| *v < 0.0).sum::<f64>())
    })
    .fold(0.0, f64::max);
  let bits = (1..=12)
    .find(|&b| norm * f64::from(1 << (b + 1)) >= 16000.0)
    .unwrap_or(13);
  let factor = f64::from(1 << bits);
  Mat3(matrix.0.map(|row| {
    let mut error = 0.0;
    row.map(|v| {
      let value = v + error;
      let rounded = (value * factor).round() * (1.0 / factor);
      error = value - rounded;
      rounded
    })
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn matrix_quantization_carries_row_error() {
    let matrix = safe_round(Mat3([[0.33333; 3]; 3]));
    assert_eq!(
      matrix.0,
      [[2731.0 / 8192.0, 2730.0 / 8192.0, 2731.0 / 8192.0]; 3]
    );
  }

  #[test]
  fn unity_transform_preserves_black_and_neutral_samples() {
    let transform = InputTransform::from_parameters(
      [1.0; 3],
      [0, 1, 2],
      Mat3::IDENTITY.to_f32(),
      4096.0 / 65535.0,
    );
    for x in [0.0, 4096.0 / 65535.0, 0.25, 0.75, 1.0] {
      assert!((transform.pixel([x; 3])[0] - x).abs() < 1e-7);
    }
  }

  /// Local regular-render capture; RAWs, DCPs and binary dumps are never bundled.
  #[test]
  fn captured_modern_color_input() {
    let (Some(raw), Some(profile_dir), Some(trace)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
      std::env::var_os("RAW_DEVELOP_ADOBE_INPUT_TRACE"),
    ) else {
      return;
    };
    let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp = super::super::dcp::Dcp::open(
      &super::super::dcp::Dcp::find_adobe_standard(
        std::path::Path::new(&profile_dir),
        &meta.make,
        &meta.model,
      )
      .unwrap(),
    )
    .unwrap();
    let neutral = super::super::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let spec = ColorSpec::for_render(&dcp, &meta, neutral, &crate::settings::WhiteBalance::AsShot);
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let transform = InputTransform::new(&spec, neutral, black);
    eprintln!(
      "white {:?}, matrix {:?}",
      spec.camera_white, transform.matrix
    );
    let path = std::path::Path::new(&trace);
    let object = std::fs::read(path.with_file_name("000_obj.bin")).unwrap();
    let value = |o| f32::from_le_bytes(object[o..o + 4].try_into().unwrap());
    for c in 0..3 {
      assert_eq!(transform.gains[c], value(0x8f4 + c * 4));
      assert_eq!(
        transform.order[c],
        u32::from_le_bytes(object[0x8dc + c * 4..0x8e0 + c * 4].try_into().unwrap()) as usize
      );
      for r in 0..3 {
        assert_eq!(
          transform.matrix[r][c],
          value(0x928 + r * 12 + transform.order[c] * 4) * (1.0 - black as f32)
        );
      }
    }
    let header: serde_json::Value =
      serde_json::from_slice(&std::fs::read(path.with_file_name("000_src.json")).unwrap()).unwrap();
    let src = std::fs::read(path.with_file_name("000_src.bin")).unwrap();
    let dst = std::fs::read(path.with_file_name("000_dst.bin")).unwrap();
    let number = |k: &str| header[k].as_i64().unwrap() as usize;
    let sample = |bytes: &[u8], offset: usize| {
      f32::from_le_bytes(bytes[offset * 4..offset * 4 + 4].try_into().unwrap())
    };
    let mut different = 0;
    let mut samples = 0;
    for y in 0..number("b") - number("t") {
      for x in 0..number("r") - number("l") {
        let index = y * number("row_step") + x * number("col_step");
        let out = transform.pixel(std::array::from_fn(|c| {
          sample(&src, index + c * number("plane_step"))
        }));
        for c in 0..3 {
          different += usize::from(out[c] != sample(&dst, index + c * number("plane_step")));
          samples += 1;
        }
      }
    }
    eprintln!("modern colour input: {different} differences in {samples} samples");
    assert_eq!(different, 0);
  }

  #[test]
  fn captured_demosaic_to_modern_input() {
    let (Some(raw), Some(trace)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("RAW_DEVELOP_ADOBE_INPUT_TRACE"),
    ) else {
      return;
    };
    let neg = crate::Negative::open(raw).unwrap();
    let neutral = super::super::xtrans::rounded_neutral(neg.meta.as_shot_wb.map(|v| 1.0 / v));
    let image = if neg.meta.cfa.is_xtrans() {
      super::super::xtrans::develop_preserved_with_lens(
        &neg,
        neutral,
        true,
        &crate::Cancel::never(),
      )
      .unwrap()
    } else {
      super::super::bayer::develop_unbalanced(&neg, true, &crate::Cancel::never()).unwrap()
    };
    let path = std::path::Path::new(&trace);
    let header: serde_json::Value =
      serde_json::from_slice(&std::fs::read(path.with_file_name("000_src.json")).unwrap()).unwrap();
    let source = std::fs::read(path.with_file_name("000_src.bin")).unwrap();
    let n = |k: &str| header[k].as_i64().unwrap() as usize;
    let mut differences = 0;
    let mut max_error = 0.0f32;
    let mut samples = 0;
    let mut per_channel = [0; 3];
    for y in n("t")..n("b") {
      for x in n("l")..n("r") {
        for c in 0..3 {
          let index =
            ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step")) * 4;
          let expected = f32::from_le_bytes(source[index..index + 4].try_into().unwrap());
          let (left, top) = if neg.meta.cfa.is_xtrans() {
            (0, 0)
          } else {
            (neg.meta.crop_left, neg.meta.crop_top)
          };
          let actual = image.px(x - left, y - top)[c];
          differences += usize::from(actual != expected);
          if actual != expected {
            if per_channel[c] == 0 {
              eprintln!(
                "first {c} at {x},{y}: actual {actual} expected {expected}, codes {} {}",
                actual * 65535.0,
                expected * 65535.0
              );
            }
            per_channel[c] += 1;
          }
          max_error = max_error.max((actual - expected).abs());
          samples += 1;
        }
      }
    }
    eprintln!(
      "demosaic to modern input: {differences} differences {per_channel:?} in {samples} samples, max {max_error}"
    );
    assert_eq!((differences, max_error), (0, 0.0));
  }

  #[test]
  fn captured_full_preparation_to_chroma_output() {
    let (Some(raw), Some(tiles), Some(profiles)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("RAW_DEVELOP_ADOBE_NR_TILES"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let neg = crate::Negative::open(raw).unwrap();
    let settings = crate::DevelopSettings {
      adobe_noise_reduction: Some(crate::settings::AdobeNoiseReduction::default()),
      luma_noise_reduction: Some(0.0),
      sharpening: 0.0,
      highlight_recovery: false,
      lens: crate::settings::LensSettings {
        distortion: false,
        chromatic_aberration: true,
        vignetting: false,
      },
      ..Default::default()
    };
    let options = crate::Options {
      engine: crate::Engine::Adobe,
      adobe_profile_dir: Some(profiles.into()),
      ..Default::default()
    };
    let prepared = crate::prepare(&neg, &settings, &options).unwrap();
    let image = prepared.working_image();
    let root = std::path::Path::new(&tiles);
    let stage = std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .find(|p| {
        p.file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("_cr_stage_denoise_src.json")
      })
      .unwrap();
    let name = stage.file_name().unwrap().to_string_lossy();
    let index: usize = name[..4].parse().unwrap();
    let path = root.join(format!("{:04}_cr_stage_1d_table_dst", index + 2));
    let h: serde_json::Value =
      serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
    let bytes = std::fs::read(path.with_extension("bin")).unwrap();
    let n = |key: &str| h[key].as_i64().unwrap() as usize;
    let (left, top) = if neg.meta.cfa.is_xtrans() {
      (0, 0)
    } else {
      (neg.meta.crop_left, neg.meta.crop_top)
    };
    let mut different = 0;
    let mut max_error = 0.0f32;
    let mut samples = 0;
    for y in n("t")..n("b") {
      for x in n("l")..n("r") {
        for c in 0..3 {
          let i =
            ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step")) * 2;
          let expected = super::super::bayer::tables::normalized(
            u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap()) ^ 32768,
          );
          let actual = image.px(x - left, y - top)[c];
          different += usize::from(actual != expected);
          max_error = max_error.max((actual - expected).abs());
          samples += 1;
        }
      }
    }
    eprintln!(
      "RAW through prepared CR6: {different} differences in {samples} channels, max {max_error}"
    );
    assert_eq!((different, max_error), (0, 0.0));
  }

  #[test]
  fn captured_full_preparation_to_luminance_and_chroma_output() {
    let (Some(raw), Some(trace), Some(profiles)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("RAW_DEVELOP_ADOBE_LUMA_TRACE"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&trace);
    let negative = crate::Negative::open(raw).unwrap();
    let sliders = std::fs::read(root.join("cr_params_00.bin")).unwrap();
    let slider = |offset| {
      u8::try_from(i32::from_le_bytes(
        sliders[offset..offset + 4].try_into().unwrap(),
      ))
      .unwrap()
    };
    let controls = crate::settings::AdobeNoiseReduction {
      color: slider(0x9c),
      detail: slider(0xa0),
      smoothness: slider(0xa4),
      luminance: slider(0x90),
      luminance_detail: slider(0x94),
      luminance_contrast: slider(0x98),
    };
    let settings = crate::DevelopSettings {
      adobe_noise_reduction: Some(controls.clone()),
      luma_noise_reduction: Some(0.0),
      sharpening: 0.0,
      highlight_recovery: false,
      lens: crate::settings::LensSettings {
        distortion: false,
        chromatic_aberration: true,
        vignetting: false,
      },
      ..Default::default()
    };
    let options = crate::Options {
      engine: crate::Engine::Adobe,
      adobe_profile_dir: Some(profiles.into()),
      ..Default::default()
    };
    let prepared = crate::prepare(&negative, &settings, &options).unwrap();
    let dcp = crate::adobe::dcp::Dcp::open(
      &crate::adobe::dcp::Dcp::find_adobe_standard(
        options.adobe_profile_dir.as_ref().unwrap(),
        &negative.meta.make,
        &negative.meta.model,
      )
      .unwrap(),
    )
    .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(negative.meta.as_shot_wb.map(|v| 1.0 / v));
    let spec = crate::adobe::color::ColorSpec::for_render(
      &dcp,
      &negative.meta,
      neutral,
      &settings.white_balance,
    );
    let black = ((negative.meta.black_levels[0] as u32) << (16 - negative.meta.bits_per_sample))
      as f64
      / 65535.0;
    let input = super::InputTransform::new(&spec, neutral, black);
    let params = crate::adobe::nr::params::Parameters::new(
      &negative.meta.model,
      negative.meta.iso.unwrap_or(100),
      input.noise_scale(),
      spec.raw_to_prophoto(neutral),
      black,
      f64::from(controls.color) * 0.01,
      f64::from(controls.detail) * 0.01,
      f64::from(controls.smoothness) * 0.01,
    )
    .unwrap();
    let space =
      crate::adobe::nr::space::Space::new(&params.curve, params.ycc, params.inverse_ycc, 0.25);
    let h: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("stage_dst.json")).unwrap()).unwrap();
    let n = |k: &str| h[k].as_i64().unwrap() as usize;
    let area: [usize; 4] =
      serde_json::from_slice(&std::fs::read(root.join("area.json")).unwrap()).unwrap();
    let bytes = std::fs::read(root.join("stage_dst.bin")).unwrap();
    let (left, top) = if negative.meta.cfa.is_xtrans() {
      (0, 0)
    } else {
      (negative.meta.crop_left, negative.meta.crop_top)
    };
    let mut differences = 0;
    let mut max_delta = 0.0f32;
    let mut samples = 0;
    for y in area[0]..area[2] {
      for x in area[1]..area[3] {
        let expected = space.decode(std::array::from_fn(|c| {
          let i =
            ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step")) * 2;
          u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap()) ^ 32768
        }));
        let actual = prepared.working_image().px(x - left, y - top);
        for c in 0..3 {
          differences += usize::from(actual[c] != expected[c]);
          max_delta = max_delta.max((actual[c] - expected[c]).abs());
          samples += 1;
        }
      }
    }
    eprintln!(
      "RAW through prepared chroma+luma NR: {differences}/{samples} different, max {max_delta}"
    );
    assert_eq!((differences, max_delta), (0, 0.0));
  }
}
