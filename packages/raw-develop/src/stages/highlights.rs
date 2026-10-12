//! Highlight recovery: a port of RawCamera's `RAWRecoverHighlightsV2` colour kernel.
//!
//! Input is white-balanced camera RGB in which a sensor value at the white level becomes
//! `wb[c]` (1.0 for green). RawCamera runs the kernel on unbalanced data, multiplying by
//! the WB factors on entry and dividing on exit; working in balanced units is the same
//! computation without the two scalings.
//!
//! Per pixel:
//! 1. Clamp each channel to its threshold `[wb.r, 0.9, wb.b]` (green is treated as
//!    clipped from 0.9 so demosaic-softened clip edges are included).
//! 2. As red/green approach clipping (from 80% of their threshold), blend them towards
//!    a reconstruction built from the other channels, which raises the clipped channel
//!    to stay consistent with its neighbours instead of turning magenta.
//! 3. As the minimum channel climbs from the green threshold to the lower of the red and
//!    blue thresholds (every channel clipped), desaturate towards the channel mean so
//!    blown areas render white.

use crate::image::RgbImage;

#[inline]
fn tween(v: f32, a: f32, b: f32) -> f32 {
  ((v - a) / (b - a)).clamp(0.0, 1.0)
}

/// Threshold vector for the kernel, from the white-balance multipliers.
pub fn thresholds(wb: [f32; 3]) -> [f32; 3] {
  [wb[0], 0.9, wb[2]]
}

#[inline]
pub fn recover_pixel(p: [f32; 3], thresh: [f32; 3]) -> [f32; 3] {
  let mut c = [
    p[0].min(thresh[0]),
    p[1].min(thresh[1]),
    p[2].min(thresh[2]),
  ];
  let t3: [f32; 3] = std::array::from_fn(|k| tween(c[k], thresh[k] * 0.8, thresh[k]));
  let trb = (thresh[0] + thresh[2]) * 0.5;
  let rgbmax = c[0].max(c[1]).max(c[2]);
  let cc0 = [
    (thresh[0] + c[2]) * 0.5,
    (c[0] + c[2]) * 0.5,
    (thresh[2] + c[0]) * 0.5,
  ];
  let cc: [f32; 3] = std::array::from_fn(|k| {
    let tt = tween(cc0[k], trb * 0.8, trb);
    c[k].max(cc0[k] + (rgbmax - cc0[k]) * tt)
  });
  let t3 = if thresh[0] > thresh[2] {
    [0.0, t3[1], t3[2]]
  } else {
    [t3[0], t3[1], 0.0]
  };
  for k in 0..3 {
    c[k] += (cc[k] - c[k]) * t3[k];
  }
  let t = tween(
    c[0].min(c[1]).min(c[2]),
    thresh[1],
    thresh[0].min(thresh[2]),
  );
  let gray = (c[0] + c[1] + c[2]) / 3.0;
  c.map(|v| v + (gray - v) * t)
}

pub fn recover(img: &mut RgbImage, thresh: [f32; 3]) {
  img.map_pixels(|p| recover_pixel(p, thresh));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fully_clipped_becomes_neutral() {
    let th = thresholds([2.0, 1.0, 1.8]);
    let p = recover_pixel([2.0, 1.0, 1.8], th);
    assert!(
      (p[0] - p[1]).abs() < 1e-6 && (p[2] - p[1]).abs() < 1e-6,
      "{p:?}"
    );
  }

  #[test]
  fn unclipped_colours_are_untouched() {
    let th = thresholds([2.0, 1.0, 1.8]);
    for p in [[0.3, 0.5, 0.2], [1.2, 0.6, 0.4], [0.1, 0.7, 1.3]] {
      assert_eq!(recover_pixel(p, th), p);
    }
  }

  #[test]
  fn green_clip_is_raised_from_red_and_blue() {
    let th = thresholds([2.0, 1.0, 1.8]);
    let p = recover_pixel([1.9, 1.0, 1.7], th);
    assert!(p[1] > 0.9, "{p:?}");
  }
}
