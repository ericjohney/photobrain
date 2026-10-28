//! Adobe 18.7 Bayer green-split correction in logarithmic space.
//!
//! `cr_stage_bayer_balance3`: form the signed difference between the two green
//! populations, remove a Gaussian low-pass along both diagonals, and bound the
//! resulting correction with the camera's green-split ratios. The observed CPU
//! kernels use the quantized Gaussian weights and fused accumulation below.
//! This is mandatory base processing, independent of user noise reduction.

/// Green-split bounds from the camera calibration, before logarithmic encoding.
#[derive(Clone, Copy, Debug)]
pub(super) struct Parameters {
  pub min_ratio: f64,
  pub max_ratio: f64,
}

impl Parameters {
  fn bounds(self) -> ([f32; 2], [f32; 2]) {
    let lo = log_encode(self.min_ratio) - 1.0;
    let hi = log_encode(self.max_ratio) - 1.0;
    (
      [(-0.5 * hi).min(0.0) as f32, (0.5 * lo).min(0.0) as f32],
      [(-0.5 * lo).max(0.0) as f32, (0.5 * hi).max(0.0) as f32],
    )
  }
}

fn log_encode(value: f64) -> f64 {
  const LOG_100: f64 = f64::from_bits(0x4012_6bb1_bbb5_5514);
  const INV_LOG_100: f64 = f64::from_bits(0x3fcb_cb7b_1526_e510);
  (value.mul_add(0.99, 0.01).ln() + LOG_100) * INV_LOG_100
}

const WEIGHTS: [f32; 4] = [0.36083984375, 0.240966796875, 0.06982421875, 0.0087890625];

/// Correct a contiguous mosaic in the canonical RGGB coordinate system. `top`
/// and `left` are the absolute coordinates of its first sample; green sites have
/// an odd coordinate sum. The returned buffer has the same dimensions. Samples
/// within seven pixels of its boundary are copied, and must be discarded by the
/// tiled caller. No boundary extension is performed here.
pub(super) fn apply(
  src: &[f32],
  width: usize,
  height: usize,
  top: isize,
  left: isize,
  parameters: Parameters,
) -> Vec<f32> {
  apply_bounds(src, width, height, top, left, parameters.bounds())
}

/// Apply an additional green-split pass whose limits are already in the working
/// encoding (Adobe enables this after noise flattening at high sensor noise).
pub(super) fn apply_encoded(
  src: &[f32],
  width: usize,
  height: usize,
  top: isize,
  left: isize,
  minimum: f64,
  maximum: f64,
) -> Vec<f32> {
  let bounds = (
    [
      (-0.5 * maximum).min(0.0) as f32,
      (0.5 * minimum).min(0.0) as f32,
    ],
    [
      (-0.5 * minimum).max(0.0) as f32,
      (0.5 * maximum).max(0.0) as f32,
    ],
  );
  apply_bounds(src, width, height, top, left, bounds)
}

fn apply_bounds(
  src: &[f32],
  width: usize,
  height: usize,
  top: isize,
  left: isize,
  (minimum, maximum): ([f32; 2], [f32; 2]),
) -> Vec<f32> {
  assert_eq!(src.len(), width * height);
  let mut out = src.to_vec();
  if width < 15 || height < 15 {
    return out;
  }
  let mut difference = vec![0.0f32; src.len()];
  for y in 1..height - 1 {
    let row_even = (top + y as isize).rem_euclid(2) == 0;
    for x in 1..width - 1 {
      let i = y * width + x;
      let mean =
        (src[i - width - 1] + src[i - width + 1] + src[i + width - 1] + src[i + width + 1]) * 0.25;
      difference[i] = if row_even {
        mean - src[i]
      } else {
        src[i] - mean
      };
    }
  }
  let mut first_diagonal = vec![0.0f32; src.len()];
  for y in 4..height - 4 {
    for x in 4..width - 4 {
      let i = y * width + x;
      let mut sum = difference[i] * WEIGHTS[0];
      for (k, &weight) in WEIGHTS.iter().enumerate().skip(1) {
        let d = k * (width + 1);
        sum = (difference[i - d] + difference[i + d]).mul_add(weight, sum);
      }
      first_diagonal[i] = sum;
    }
  }
  for y in 7..height - 7 {
    let parity = (top + y as isize).rem_euclid(2) as usize;
    for x in 7..width - 7 {
      if (top + y as isize + left + x as isize).rem_euclid(2) != 1 {
        continue;
      }
      let i = y * width + x;
      let mut sum = first_diagonal[i] * WEIGHTS[0];
      for (k, &weight) in WEIGHTS.iter().enumerate().skip(1) {
        let d = k * (width - 1);
        sum = (first_diagonal[i - d] + first_diagonal[i + d]).mul_add(weight, sum);
      }
      let high_pass = difference[i] - sum;
      let diagonal =
        (src[i - width - 1] + src[i - width + 1] + src[i + width - 1] + src[i + width + 1]) * 0.125;
      let mean = src[i].mul_add(0.5, diagonal);
      let sign = if parity == 0 { -0.5 } else { 0.5 };
      let correction = high_pass.mul_add(sign, mean) - src[i];
      out[i] = (src[i] + correction.clamp(minimum[parity], maximum[parity])).clamp(0.0, 1.0);
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn flat_mosaic_and_untouched_colour_sites() {
    let (width, height) = (28, 26);
    let mut src = vec![0.4; width * height];
    for y in 0..height {
      for x in 0..width {
        if (y + x) % 2 == 0 {
          src[y * width + x] = if y % 2 == 0 { 0.25 } else { 0.6 };
        }
      }
    }
    let out = apply(
      &src,
      width,
      height,
      -3,
      5,
      Parameters {
        min_ratio: 1.0 / 1.02,
        max_ratio: 1.02,
      },
    );
    assert_eq!(out, src);
  }

  #[test]
  fn correction_respects_camera_bounds() {
    let (width, height) = (32, 32);
    let mut src = vec![0.5f32; width * height];
    src[15 * width + 16] = 0.8;
    let parameters = Parameters {
      min_ratio: 1.0 / 1.02,
      max_ratio: 1.02,
    };
    let (minimum, maximum) = parameters.bounds();
    let out = apply(&src, width, height, 0, 0, parameters);
    let i = 15 * width + 16;
    assert!(out[i] < src[i]);
    assert_eq!(out[i], src[i] + minimum[1]);
    for y in 7..height - 7 {
      for x in 7..width - 7 {
        let i = y * width + x;
        if (y + x) % 2 == 1 {
          assert!(out[i] <= src[i] + maximum[y % 2]);
          assert!(out[i] >= src[i] + minimum[y % 2]);
        } else {
          assert_eq!(out[i], src[i]);
        }
      }
    }
  }
}
