//! Adobe's signed Bayer logarithmic encoding and DNG 16-bit table boundaries.

const LOG_100: f64 = f64::from_bits(0x4012_6bb1_bbb5_5514);
const INV_LOG_100: f64 = f64::from_bits(0x3fcb_cb7b_1526_e510);

pub(super) fn log_encode(input: f64, black: f64) -> f64 {
  signed_curve(input, black, if black > 0.0 { 0.25 } else { 0.0 }, |x| {
    (x.mul_add(0.99, 0.01).ln() + LOG_100) * INV_LOG_100
  })
}

pub(super) fn log_decode(input: f64, black: f64) -> f64 {
  signed_curve(input, if black > 0.0 { 0.25 } else { 0.0 }, black, |x| {
    (x.mul_add(LOG_100, -LOG_100).exp() - 0.01) * (1.0 / 0.99)
  })
}

fn signed_curve(input: f64, in_black: f64, out_black: f64, curve: impl FnOnce(f64) -> f64) -> f64 {
  let input = (input - in_black) * (-1.0 / (in_black - 1.0));
  let value = curve(input.abs());
  let value = if input < 0.0 { -value } else { value };
  value.mul_add(1.0 - out_black, out_black).clamp(0.0, 1.0)
}

/// `dng_1d_table::Expand16`: sample the function in f32, then expand with a
/// running f64 fraction. Both the +0.5 rounding and the unfused sum matter.
pub(crate) fn expand(function: impl Fn(f64) -> f64) -> Vec<u16> {
  let mut values: Vec<f32> = (0..=4096)
    .map(|i| function(i as f64 / 4096.0) as f32)
    .collect();
  values.push(values[4096]);
  let mut index = 1;
  let mut fraction = 0.0;
  let step = 4096.0 / 65535.0;
  let mut a = values[0] as f64;
  let mut b = values[1] as f64;
  let mut base = a * 65535.0 + 0.5;
  let mut slope = (b - a) * 65535.0;
  let mut table = Vec::with_capacity(65536);
  for _ in 0..65536 {
    table.push((base + slope * fraction) as u16);
    fraction += step;
    if fraction > 1.0 {
      index += 1;
      fraction -= 1.0;
      a = b;
      b = values[index] as f64;
      base = a * 65535.0 + 0.5;
      slope = (b - a) * 65535.0;
    }
  }
  table
}

#[inline]
pub(crate) fn code(value: f32) -> u16 {
  (value * 65535.0).round_ties_even().clamp(0.0, 65535.0) as u16
}

#[inline]
pub(crate) fn normalized(value: u16) -> f32 {
  value as f32 * (1.0 / 65535.0)
}

/// Preserve each u16 stage boundary across four independent RGB pixels.
#[inline]
pub(crate) fn quantize4(pixels: [[f32; 3]; 4]) -> [[f32; 3]; 4] {
  #[cfg(target_arch = "aarch64")]
  {
    use std::arch::aarch64::*;
    let mut out = [[0.0; 3]; 4];
    // SAFETY: Both arrays contain twelve contiguous floats. Each four-lane
    // load/store stays inside one of their three disjoint four-float blocks.
    // NEON is baseline on AArch64; FCVTNU matches code's ties-to-even rounding
    // and saturation, including NaN, before clipping to the u16 maximum.
    unsafe {
      for offset in [0, 4, 8] {
        let values = vld1q_f32(pixels.as_ptr().cast::<f32>().add(offset));
        let codes = vminq_u32(
          vcvtnq_u32_f32(vmulq_n_f32(values, 65535.0)),
          vdupq_n_u32(65535),
        );
        let values = vmulq_n_f32(vcvtq_f32_u32(codes), 1.0 / 65535.0);
        vst1q_f32(out.as_mut_ptr().cast::<f32>().add(offset), values);
      }
    }
    out
  }
  #[cfg(not(target_arch = "aarch64"))]
  pixels.map(|p| p.map(|v| normalized(code(v))))
}

pub(super) fn apply(src: &mut [f32], table: &[u16]) {
  for value in src {
    *value = normalized(table[code(*value) as usize]);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn batched_u16_boundaries_preserve_every_float_bit() {
    let check = |pixels: [[f32; 3]; 4]| {
      assert_eq!(
        quantize4(pixels).map(|p| p.map(f32::to_bits)),
        pixels.map(|p| p.map(|v| normalized(code(v)).to_bits()))
      );
    };
    for base in (0..65536).step_by(4) {
      for delta in [-0.5, 0.0, 0.5] {
        let pixels = std::array::from_fn(|i| {
          let midpoint = (base as f32 + i as f32 + delta) / 65535.0;
          [
            f32::from_bits(midpoint.to_bits().wrapping_sub(1)),
            midpoint,
            f32::from_bits(midpoint.to_bits().wrapping_add(1)),
          ]
        });
        check(pixels);
      }
    }
    let special = [
      0.0,
      -0.0,
      f32::MIN_POSITIVE,
      -f32::MIN_POSITIVE,
      f32::from_bits(1),
      f32::from_bits(0x8000_0001),
      1.0,
      -1.0,
      f32::MAX,
      f32::NEG_INFINITY,
      f32::INFINITY,
      f32::NAN,
    ];
    check(std::array::from_fn(|i| {
      std::array::from_fn(|c| special[i * 3 + c])
    }));
    let mut seed = 0xa5c3_7e19_u32;
    for _ in 0..131072 {
      check(std::array::from_fn(|_| {
        std::array::from_fn(|_| {
          seed ^= seed << 13;
          seed ^= seed >> 17;
          seed ^= seed << 5;
          f32::from_bits(seed)
        })
      }));
    }
  }

  #[test]
  fn log_preserves_black_and_inverse() {
    let black = 2048.0 / 65535.0;
    assert_eq!(log_encode(black, black) as f32, 0.25);
    assert_eq!(log_decode(0.25, black) as f32, black as f32);
    for i in 0..=1000 {
      let input = black + (1.0 - black) * i as f64 / 1000.0;
      assert!((log_decode(log_encode(input, black), black) - input).abs() < 1e-12);
    }
  }

  #[test]
  fn expanded_identity_covers_every_u16_code() {
    assert_eq!(expand(|x| x), (0..=65535).collect::<Vec<u16>>());
  }
}
