//! Scalar curve construction for the 18.7 SDR tone pipeline.
//!
//! Converter addresses: MakeBrightnessCurve 0x100e5af44, brightness part Evaluate
//! 0x100e5d188, contrast-key Evaluate 0x100e59bbc, white reduce/expand Evaluate
//! 0x10098b988/0x10098ba18. No curve coefficients are fitted to photographs.

/// `dng_1d_function::EvaluateInverse` (0x1013cad28): bounded secant iteration.
pub fn inverse(f: impl Fn(f64) -> f64, y: f64) -> f64 {
  let (mut x0, mut x1) = (0.0, 1.0);
  let (mut y0, mut y1) = (f(x0), f(x1));
  for _ in 0..30 {
    if (y1 - y0).abs() < 1e-10 {
      break;
    }
    let x2 = (x1 + (y - y1) * (x1 - x0) / (y1 - y0)).clamp(0.0, 1.0);
    let y2 = f(x2);
    (x0, y0, x1, y1) = (x1, y1, x2, y2);
  }
  x1
}

#[derive(Clone, Copy, Debug)]
struct BrightnessPart {
  slope: f64,
  end_slope: f64,
  start: f64,
  span: f64,
}

impl BrightnessPart {
  fn new(amount: f64) -> Self {
    let slope = f64::from_bits(0x3ff5_ecf5_2776_a115).powf(amount);
    let start = 0.5 / slope;
    Self {
      slope,
      end_slope: (1.0 / ((slope - 1.0).mul_add(12.0, 1.0))).max(0.1),
      start,
      span: 1.0 - start,
    }
  }

  fn eval(self, x: f64) -> f64 {
    if x < self.start {
      return x * self.slope;
    }
    let t = (x - self.start) / self.span;
    let u = 1.0 - t;
    let a = ((2.0 - t) + u) - u * (self.span * self.end_slope);
    let b = (t + (2.0 - u)).mul_add(0.5, t * (self.span * self.slope));
    b.mul_add(u * u, (t * t) * a)
  }
}

/// Four bounded brightness segments, applied forwards or inversely according to
/// the sign of the EV amount. Used for the exposure highlight rolloff.
#[derive(Clone, Debug)]
pub struct Brightness {
  negative: bool,
  amounts: [f64; 4],
  parts: [BrightnessPart; 4],
}

impl Brightness {
  pub fn new(ev: f64) -> Self {
    let a = ev.abs();
    let amounts = [
      a.min(2.0),
      (a - 2.0).clamp(0.0, 2.0),
      (a - 4.0).clamp(0.0, 2.0),
      (a - 6.0).clamp(0.0, 2.0),
    ];
    Self {
      negative: ev < 0.0,
      amounts,
      parts: amounts.map(BrightnessPart::new),
    }
  }

  pub fn eval(&self, mut x: f64) -> f64 {
    if self.negative {
      for i in (0..4).rev() {
        if self.amounts[i] != 0.0 {
          x = inverse(|v| self.parts[i].eval(v), x);
        }
      }
    } else {
      for i in 0..4 {
        if self.amounts[i] != 0.0 {
          x = self.parts[i].eval(x);
        }
      }
    }
    x
  }

  pub fn linear_eval(&self, x: f64) -> f64 {
    self.eval(x.powf(1.0 / 2.2)).powf(2.2)
  }
}

/// Image-keyed Contrast2012 curve. `key` is `cr_image_stats::Key()`, before the
/// optional HDR-specific scaling (HDR rendering is outside this module).
#[derive(Clone, Copy, Debug)]
pub struct Contrast {
  positive: bool,
  gain: f64,
  amount: f64,
  gamma: f64,
  inverse_gamma: f64,
}

impl Contrast {
  pub fn new(slider: i32, key: f64) -> Self {
    let gamma = -std::f64::consts::LN_2 / key.ln();
    Self {
      positive: slider > 0,
      gain: (slider as f64 * 0.01).exp2(),
      amount: slider as f64 * 0.00095,
      gamma,
      inverse_gamma: 1.0 / gamma,
    }
  }

  pub fn eval(self, x: f64) -> f64 {
    let x = x.powf(self.gamma);
    let y = if self.positive {
      let q = if x > 0.5 {
        let t = (x - 0.75) * 4.0;
        (-t).mul_add(t, 1.0)
      } else {
        let t = (x - 0.25) * 4.0;
        t.mul_add(t, -1.0)
      };
      q.mul_add(self.amount, x)
    } else if x > 0.5 {
      0.5 + ((x - 0.5) * (0.5 * self.gain)) / ((x - 0.5).mul_add(self.gain - 1.0, 0.5))
    } else {
      (x * 0.5) / 0.5f64.mul_add(self.gain, -(x * (self.gain - 1.0)))
    };
    y.powf(self.inverse_gamma)
  }
}

/// `cr_image_stats::Key` from the mean and two log-domain statistics (offsets
/// 0x00, 0x68, 0xa0 in `cr_image_stats`).
pub fn contrast_key(mean: f64, low: f64, high: f64) -> f64 {
  if low < high {
    let t = ((mean * 2.0 - low) - high) / (high - low);
    ((t + t).exp2() * 0.18).clamp(0.01125, 2.88)
  } else {
    0.18
  }
}

#[derive(Clone, Copy, Debug)]
pub enum Whites {
  Identity,
  Reduce { exponent: f64 },
  Expand { clip_squared: f64 },
}

impl Whites {
  /// The amount is `exposure_info + 0xb0`, after CalculateExposure2012. Positive
  /// amounts reduce whites; negative amounts expand them to `clip_point`.
  pub fn new(amount: f64, clip_point: f64) -> Self {
    if amount > 0.0 {
      Self::Reduce {
        exponent: f64::from_bits(0x3ffb_b67a_e858_4caa).powf(amount),
      }
    } else if amount < 0.0 {
      Self::Expand {
        clip_squared: clip_point * clip_point,
      }
    } else {
      Self::Identity
    }
  }

  pub fn eval(self, x: f64) -> f64 {
    match self {
      Self::Identity => x,
      Self::Reduce { exponent } => x.mul_add(x.powf(exponent) - x, x),
      Self::Expand { clip_squared } => ((x / (x + 1.0)) * (x / clip_squared + 1.0)).min(1.0),
    }
  }
}

/// Non-subsampled `dng_1d_table` (0x1013cb7a4), including the duplicate endpoint.
#[derive(Clone, Debug)]
pub struct Table {
  pub samples: Vec<f32>,
}

impl Table {
  pub fn new(n: usize, f: impl Fn(f64) -> f64) -> Self {
    let scale = 1.0 / n as f64;
    let mut samples: Vec<_> = (0..=n).map(|i| f(i as f64 * scale) as f32).collect();
    samples.push(samples[n]);
    Self { samples }
  }

  pub fn eval(&self, x: f32) -> f32 {
    let n = self.samples.len() - 2;
    let x = x * n as f32;
    let i = (x as usize).min(n);
    let t = x - i as f32;
    t.mul_add(self.samples[i + 1], (1.0 - t) * self.samples[i])
  }

  /// Exposure's rolloff table uses the difference interpolation form.
  pub fn eval_difference(&self, x: f32) -> f32 {
    let n = self.samples.len() - 2;
    let x = x * n as f32;
    let i = (x as usize).min(n);
    (self.samples[i + 1] - self.samples[i]).mul_add(x - i as f32, self.samples[i])
  }

  /// ARM64 SIMD kernel's explicit multiply followed by add, without contraction.
  pub fn eval_simd(&self, x: f32) -> f32 {
    let n = self.samples.len() - 2;
    let x = x.clamp(0.0, 1.0) * n as f32;
    let i = (x as usize).min(n);
    self.samples[i] + (x - i as f32) * (self.samples[i + 1] - self.samples[i])
  }

  /// Four independent lookups with the same rounded multiply/add interpolation.
  /// Coefficient gathers retain checked scalar indexing, including the padded
  /// final sample; no floating-point contraction or index approximation is used.
  #[cfg(target_arch = "aarch64")]
  #[inline]
  pub(crate) fn eval4(
    &self,
    x: std::arch::aarch64::float32x4_t,
  ) -> std::arch::aarch64::float32x4_t {
    use std::arch::aarch64::*;
    let n = self.samples.len() - 2;
    // Every load/store addresses a complete four-float array. NEON is baseline
    // on AArch64; the only profile/table accesses below use checked indexing.
    unsafe {
      let zero = vdupq_n_f32(0.0);
      let one = vdupq_n_f32(1.0);
      let x = vbslq_f32(
        vcltq_f32(x, zero),
        zero,
        vbslq_f32(vcgtq_f32(x, one), one, x),
      );
      let x = vmulq_n_f32(x, n as f32);
      let mut positions = [0.0; 4];
      vst1q_f32(positions.as_mut_ptr(), x);
      let indices = positions.map(|v| (v as usize).min(n));
      let low = indices.map(|i| self.samples[i]);
      let high = indices.map(|i| self.samples[i + 1]);
      let offsets = indices.map(|i| i as f32);
      let low = vld1q_f32(low.as_ptr());
      let high = vld1q_f32(high.as_ptr());
      let t = vsubq_f32(x, vld1q_f32(offsets.as_ptr()));
      vaddq_f32(low, vmulq_f32(t, vsubq_f32(high, low)))
    }
  }
}

#[cfg(all(test, target_arch = "aarch64"))]
mod tests {
  use super::Table;
  use std::arch::aarch64::*;

  #[test]
  fn batched_table_matches_scalar_bits() {
    let mut seed = 17u32;
    for n in [1, 16, 4096] {
      let table = Table::new(n, |x| (x - 0.25) * (x - 0.75));
      for sample in 0..20000 {
        let values: [f32; 4] = std::array::from_fn(|i| {
          seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
          match sample % 11 {
            0 => {
              if i % 2 == 0 {
                -0.0
              } else {
                0.0
              }
            }
            1 => 1.0,
            2 => f32::from_bits(seed),
            3 => f32::from_bits(seed & 0x807f_ffff),
            4 => [0.0, 0.25, 0.75, 1.0][i],
            _ => (seed >> 16) as f32 * (2.0 / 65535.0) - 0.5,
          }
        });
        let expected = values.map(|x| table.eval_simd(x));
        let mut actual = [0.0f32; 4];
        unsafe { vst1q_f32(actual.as_mut_ptr(), table.eval4(vld1q_f32(values.as_ptr()))) };
        assert_eq!(
          actual.map(f32::to_bits),
          expected.map(f32::to_bits),
          "{n}, {sample}, {values:?}"
        );
      }
    }
  }
}

/// Modern DNG sRGB transfer functions, including reciprocal constants and FMA.
pub fn srgb_encode(x: f64) -> f64 {
  if x <= 0.0031308 {
    x * 12.92
  } else {
    x.powf(1.0 / 2.4).mul_add(1.055, -0.055)
  }
}
pub fn srgb_decode(x: f64) -> f64 {
  if x <= 0.04045 {
    x * f64::from_bits(0x3fb3_d072_2149_b580)
  } else {
    ((x + 0.055) * f64::from_bits(0x3fee_54ed_cd0a_eb60)).powf(2.4)
  }
}
