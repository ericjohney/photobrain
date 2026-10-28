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

pub(super) fn apply(src: &mut [f32], table: &[u16]) {
  for value in src {
    *value = normalized(table[code(*value) as usize]);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

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
