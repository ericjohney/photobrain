//! Metadata-derived coefficients for Adobe 18.7's full-resolution CR6 NR.
//!
//! The selected sensor-noise function, optimized YCC basis, propagated channel
//! noise, and quantized Gaussian support follow the captured constructor. The
//! optional luminance parameters share the same noise-flattened source.

use super::{luma, noise, spatial};
use crate::math::Mat3;

pub(crate) struct Parameters {
  pub(crate) curve: noise::NoiseCurve,
  pub(crate) ycc: Mat3,
  pub(crate) inverse_ycc: Mat3,
  pub(crate) spatial: spatial::Parameters,
  pub(crate) luma: Option<luma::Parameters>,
  pub(crate) color_enabled: bool,
}

impl Parameters {
  /// All three colour controls use normalized slider units. `noise_gain` is
  /// the reciprocal of the largest quantized camera gain; `raw_to_rgb` is the
  /// camera-to-ProPhoto matrix before render-stage fixed-point quantization.
  pub(crate) fn new(
    model: &str,
    iso: u32,
    noise_gain: f64,
    raw_to_rgb: Mat3,
    linear_black: f64,
    amount: f64,
    detail: f64,
    smoothness: f64,
  ) -> Option<Self> {
    if !(0.0..=1.0).contains(&detail) || !(0.0..=1.0).contains(&amount) {
      return None;
    }
    let selected = noise::selected_sensor_noise(model, iso, noise_gain)?;
    let unscaled = noise::selected_sensor_noise(model, iso, 1.0)?;
    let (ycc, inverse_ycc) = optimized_ycc(raw_to_rgb);
    let norms = channel_noise(ycc, raw_to_rgb);
    let noise = unscaled.normalization * norms.into_iter().fold(0.0, f64::max) * 65535.0;
    let radius = if noise <= 2000.0 {
      ((noise - 200.0) / 1800.0).clamp(0.0, 1.0) * 18.0 + 6.0
    } else {
      ((noise - 2000.0) / 8000.0).clamp(0.0, 1.0) * 12.0 + 24.0
    };
    let smoothness = smoothness.clamp(0.0, 1.0);
    let radius = if smoothness < 0.5 {
      let low = (radius * 0.5).clamp(1.5, 6.0);
      low + (radius - low) * (smoothness / 0.5)
    } else if smoothness > 0.5 {
      let high = (radius + radius).clamp(24.0, 48.0);
      radius + (high - radius) * ((smoothness - 0.5) / 0.5)
    } else {
      radius
    } * 0.5;
    // Preserve the constructor's association, including both square-root
    // factors. Folding sqrt(0.5)*sqrt(2) changes the used f32 coefficients.
    let strength = selected.normalization
      * std::f64::consts::FRAC_1_SQRT_2
      * (amount + amount)
      * std::f64::consts::SQRT_2;
    let difference = [
      -1.0 / (norms[0] * strength * norms[0] * strength),
      -1.0 / (norms[1] * strength * norms[1] * strength),
      -1.0 / (strength * norms[2] * strength * norms[2]),
    ];
    let threshold =
      selected.normalization * 0.5 * 65535.0 * (((detail - 0.25) + detail - 0.25) * -0.5 + 1.0);
    let threshold = [norms[1] * threshold, norms[2] * threshold];
    let high_pass = threshold.map(|v| -1.0 / (v * v));
    let rank = (1024.0 - 768.0 * (((detail - 0.5) + detail - 0.5).clamp(0.0, 1.0)))
      .round()
      .clamp(256.0, 1024.0) as usize;
    let detail = if detail <= 0.04045 {
      detail / 12.92
    } else {
      ((detail + 0.055) / 1.055).powf(2.4)
    };
    Some(Self {
      curve: noise::NoiseCurve::new(selected.scale, selected.offset, linear_black, 0.25),
      ycc,
      inverse_ycc,
      luma: None,
      color_enabled: amount > 0.0,
      spatial: spatial::Parameters::with_rank(
        gaussian_support(radius),
        difference.map(|v| v as f32),
        (1.0 / ((radius + radius) * (radius + radius))) as f32,
        detail as f32,
        high_pass,
        rank,
      ),
    })
  }
}

// DNG's complete cofactor inverse; keep this local to the Adobe builder so it
// cannot change the existing Apple pipeline's matrix arithmetic.
fn inverse(Mat3(m): Mat3) -> Mat3 {
  let temp = [
    [
      m[1][1].mul_add(m[2][2], -(m[1][2] * m[2][1])),
      m[2][1].mul_add(m[0][2], m[0][1] * -m[2][2]),
      m[0][1].mul_add(m[1][2], -(m[0][2] * m[1][1])),
    ],
    [
      m[2][0].mul_add(m[1][2], -m[2][2] * m[1][0]),
      m[0][0].mul_add(m[2][2], -(m[0][2] * m[2][0])),
      m[1][0].mul_add(m[0][2], m[0][0] * -m[1][2]),
    ],
    [
      m[1][0].mul_add(m[2][1], -m[1][1] * m[2][0]),
      m[2][0].mul_add(m[0][1], m[0][0] * -m[2][1]),
      m[1][1].mul_add(m[0][0], m[1][0] * -m[0][1]),
    ],
  ];
  let determinant = m[0][0].mul_add(temp[0][0], temp[1][0] * m[0][1]);
  let determinant = m[0][2].mul_add(temp[2][0], determinant);
  Mat3(temp.map(|row| row.map(|v| v / determinant)))
}

fn optimized_ycc(raw_to_rgb: Mat3) -> (Mat3, Mat3) {
  let inverse_raw = inverse(raw_to_rgb);
  let mut weights = std::array::from_fn::<_, 3, _>(|c| {
    let sum = 0.25_f64.mul_add(inverse_raw.0[0][c], 0.0);
    let sum = 0.5_f64.mul_add(inverse_raw.0[1][c], sum);
    0.25_f64.mul_add(inverse_raw.0[2][c], sum)
  });
  weights[0] = (weights[0].max(0.01) - 0.29) + 0.29;
  weights[1] = (weights[1].max(0.01) - 0.71) + 0.71;
  weights[2] = weights[2].max(0.01);
  let scale = 1.0 / (weights[2] + (weights[0] + weights[1]));
  let weights = weights.map(|v| v * scale);
  let cb_scale = 0.5 / (weights[0] - 1.0);
  let cr_scale = 0.5 / (weights[2] - 1.0);
  let ycc = Mat3([
    weights,
    [
      (weights[0] - 1.0) * cb_scale,
      weights[1] * cb_scale,
      weights[2] * cb_scale,
    ],
    [
      weights[0] * cr_scale,
      weights[1] * cr_scale,
      (weights[2] - 1.0) * cr_scale,
    ],
  ]);
  (ycc, inverse(ycc))
}

fn channel_noise(ycc: Mat3, raw_to_rgb: Mat3) -> [f64; 3] {
  let combined: [[f64; 3]; 3] = std::array::from_fn(|r| {
    std::array::from_fn(|c| {
      let mut sum = 0.0;
      for k in 0..3 {
        sum = ycc.0[r][k].mul_add(raw_to_rgb.0[k][c], sum);
      }
      sum
    })
  });
  let norm = |row: usize| {
    let mut sum = 0.0;
    for v in combined[row] {
      sum += v * v;
    }
    sum.sqrt()
  };
  let cb = norm(1);
  let cr = norm(2);
  let values = [(cb * cr).sqrt(), cb, cr];
  let scale = 1.0 / values.into_iter().fold(f64::INFINITY, f64::min);
  values.map(|v| v * scale)
}

// GaussianWeights16 integrates each integer sample's pixel interval with ten
// trapezoids, quantizes to a 14-bit kernel, then trims zero tail weights. The
// returned support controls the cross-box filter even though its weights are
// computed from distance rather than this Gaussian kernel.
fn gaussian_support(radius: f64) -> usize {
  let max_radius = (radius * 4.0 + 0.5).floor() as usize;
  let sample = |i: usize| {
    let x = (i as f64 / radius) / 10.0;
    (-(x * x)).exp()
  };
  let mut normalization = 1.0;
  for i in 1..=max_radius * 10 {
    normalization += sample(i) * 2.0;
  }
  let mut support = 1;
  for j in 1..=max_radius {
    let start = j * 10 - 5;
    let mut sum = sample(start) * 0.5;
    for i in start + 1..start + 10 {
      sum += sample(i);
    }
    sum += sample(start + 10) * 0.5;
    let weight = (16384.0 / normalization * sum + 0.5).floor() as i32;
    if weight != 0 {
      support = j;
    }
  }
  support
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  #[test]
  fn captured_slider_coefficients() {
    let (Some(params_root), Some(spatial_root), Some(controls)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_NR_PARAMS"),
      std::env::var_os("RAW_DEVELOP_ADOBE_NR_TRACE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_NR_CONTROLS"),
    ) else {
      eprintln!("NR_PARAMS, NR_TRACE and NR_CONTROLS required for external slider coefficients");
      return;
    };
    let bytes = std::fs::read(Path::new(&params_root).join("params_00.bin")).unwrap();
    let raw = std::fs::read(Path::new(&params_root).join("raw_to_rgb_00.bin")).unwrap();
    let object = std::fs::read(Path::new(&spatial_root).join("obj.bin")).unwrap();
    let double = |bytes: &[u8], offset: usize| {
      f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    };
    let controls: Vec<f64> = controls
      .to_str()
      .unwrap()
      .split(',')
      .map(|v| v.parse::<f64>().unwrap() * 0.01)
      .collect();
    assert_eq!(controls.len(), 3);
    let gain = double(&bytes, 0x50);
    let (model, iso) = if gain > 0.4 {
      ("X-E5", 10000)
    } else {
      ("ILCE-7RM5", 2000)
    };
    let matrix = Mat3(std::array::from_fn(|r| {
      std::array::from_fn(|c| double(&raw, 16 + r * 32 + c * 8))
    }));
    let params = Parameters::new(
      model,
      iso,
      gain,
      matrix,
      double(&bytes, 0x60),
      controls[0],
      controls[1],
      controls[2],
    )
    .unwrap();
    let integer =
      |offset: usize| u32::from_le_bytes(object[offset..offset + 4].try_into().unwrap()) as usize;
    let expected = spatial::Parameters::with_rank(
      integer(0x920),
      std::array::from_fn(|c| double(&object, 0x930 + c * 8) as f32),
      -double(&object, 0x928) as f32,
      double(&object, 0x948) as f32,
      [double(&object, 0x958), double(&object, 0x960)],
      integer(0x954),
    );
    assert_eq!(params.spatial.radius, expected.radius);
    assert_eq!(params.spatial.difference, expected.difference);
    assert_eq!(params.spatial.spatial, expected.spatial);
    assert_eq!(params.spatial.detail, expected.detail);
    assert_eq!(params.spatial.rank, expected.rank);
    assert_eq!(params.spatial.shrink, expected.shrink);
  }

  #[test]
  fn captured_constructor_coefficients() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_NR_PARAMS") else {
      eprintln!("RAW_DEVELOP_ADOBE_NR_PARAMS unset; skipping external CR6 coefficients");
      return;
    };
    let root = Path::new(&root);
    let bytes = std::fs::read(root.join("params_00.bin")).unwrap();
    let raw = std::fs::read(root.join("raw_to_rgb_00.bin")).unwrap();
    let double = |bytes: &[u8], offset: usize| {
      f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
    };
    let matrix = |bytes: &[u8], offset: usize| {
      Mat3(std::array::from_fn(|r| {
        std::array::from_fn(|c| double(bytes, offset + 16 + r * 32 + c * 8))
      }))
    };
    let gain = double(&bytes, 0x50);
    let (model, iso) = if gain > 0.4 {
      ("X-E5", 10000)
    } else {
      ("ILCE-7RM5", 2000)
    };
    let control = std::fs::read(root.join("cr_params_00.bin")).unwrap();
    let slider = |offset: usize| {
      i32::from_le_bytes(control[offset..offset + 4].try_into().unwrap()) as f64 * 0.01
    };
    let params = Parameters::new(
      model,
      iso,
      gain,
      matrix(&raw, 0),
      double(&bytes, 0x60),
      slider(0x9c),
      slider(0xa0),
      slider(0xa4),
    )
    .unwrap();
    for (actual, expected) in [
      (params.ycc, matrix(&bytes, 0x198)),
      (params.inverse_ycc, matrix(&bytes, 0x228)),
    ] {
      for r in 0..3 {
        for c in 0..3 {
          assert_eq!(actual.0[r][c], expected.0[r][c], "matrix [{r}][{c}]");
        }
      }
    }
    assert_eq!(
      params.spatial.radius,
      u32::from_le_bytes(bytes[0x168..0x16c].try_into().unwrap()) as usize
    );
    assert_eq!(
      params.spatial.difference,
      std::array::from_fn(|c| double(&bytes, 0x178 + c * 8) as f32)
    );
    assert_eq!(params.spatial.spatial, -double(&bytes, 0x170) as f32);
    assert_eq!(params.spatial.detail, double(&bytes, 0x140) as f32);
    assert_eq!(
      params.spatial.rank,
      u32::from_le_bytes(bytes[0x190..0x194].try_into().unwrap()) as usize
    );
    let expected_spatial = spatial::Parameters::new(
      params.spatial.radius,
      params.spatial.difference,
      params.spatial.spatial,
      params.spatial.detail,
      [double(&bytes, 0x158), double(&bytes, 0x160)],
    );
    assert_eq!(params.spatial.shrink, expected_spatial.shrink);
    let selected = noise::selected_sensor_noise(model, iso, gain).unwrap();
    let expected =
      noise::NoiseCurve::new(selected.scale, selected.offset, double(&bytes, 0x60), 0.25);
    for i in 0..=65535 {
      let v = i as f64 / 65535.0;
      assert_eq!(params.curve.encode(v), expected.encode(v));
      assert_eq!(params.curve.decode(v), expected.decode(v));
    }
  }
}
