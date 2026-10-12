//! Rendering ("look"): scene-linear Display P3 to display-encoded Display P3.
//!
//! - Gamut compression: out-of-gamut (negative) components are pulled towards the
//!   achromatic axis at constant luminance, so saturated colours do not clip hard.
//! - Tone curve: the profile's per-channel curve maps scene-linear values to encoded
//!   values. Applied per channel, it also produces the natural highlight desaturation.
//! - Contrast/tone amount: blend between the tone curve and a plain transfer encode.

use crate::math::{P3_LUMA, srgb_encode};
use crate::profile::ToneCurve;

/// Pull a linear RGB colour with negative components back into gamut.
#[inline]
pub fn compress_gamut(p: [f32; 3]) -> [f32; 3] {
  let y = (p[0] * P3_LUMA[0] + p[1] * P3_LUMA[1] + p[2] * P3_LUMA[2]).max(0.0);
  let min = p[0].min(p[1]).min(p[2]);
  if min >= 0.0 {
    return p;
  }
  if y <= 0.0 {
    return [0.0; 3];
  }
  // Largest t in [0,1] with y + (p - y) * t >= 0 for every channel.
  let t = y / (y - min);
  [y + (p[0] - y) * t, y + (p[1] - y) * t, y + (p[2] - y) * t]
}

/// Apply curve per channel. `amount` 1 = full curve, 0 = linear encode (no contrast).
#[inline]
pub fn tone(p: [f32; 3], curve: &ToneCurve, amount: f32) -> [f32; 3] {
  p.map(|v| {
    let c = curve.eval(v);
    if amount >= 1.0 {
      c
    } else {
      srgb_encode(v.clamp(0.0, 1.0)) * (1.0 - amount) + c * amount
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn gamut_compression_preserves_luminance_and_hue_direction() {
    let p = [-0.1, 0.5, 0.2];
    let q = compress_gamut(p);
    assert!(q.iter().all(|&v| v >= -1e-6));
    let y0 = p[0] * P3_LUMA[0] + p[1] * P3_LUMA[1] + p[2] * P3_LUMA[2];
    let y1 = q[0] * P3_LUMA[0] + q[1] * P3_LUMA[1] + q[2] * P3_LUMA[2];
    assert!((y0 - y1).abs() < 1e-6);
    assert!(q[1] > q[2] && q[2] > q[0]);
    assert_eq!(compress_gamut([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
  }
}
