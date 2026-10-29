//! Four-pixel implementation of the mandatory X-Trans directional cleanup.
//!
//! Lanes are independent pixels. Each of the 68 neighbours is accumulated in
//! the scalar order, including its rounded distance products and explicit FMAs.

use crate::image::RgbImage;

fn pixel(source: &[f32], width: usize, y: usize, x: usize) -> [f32; 2] {
  let center = &source[(y * width + x) * 3..][..3];
  let (mut s1, mut s2, mut sw) = (0.0, 0.0, 0.0);
  for (dy, dx) in [(0, 1), (1, 0), (1, 1), (1, -1)] {
    for i in -8..=8 {
      let sy = (y as isize + dy * i) as usize;
      let sx = (x as isize + dx * i) as usize;
      let p = &source[(sy * width + sx) * 3..][..3];
      let a = (p[0] - center[0]) * (p[0] - center[0]) * (-256.0);
      let b = (p[1] - center[1]) * (p[1] - center[1]) * (-256.0);
      let c = (p[2] - center[2]) * (p[2] - center[2]) * (-256.0);
      let v = 0.2_f32.mul_add(a + (b + c), 1.0);
      let weight = (v * (v * v)).clamp(0.0, 1.0);
      s1 = weight.mul_add(p[1], s1);
      s2 = weight.mul_add(p[2], s2);
      sw += weight;
    }
  }
  let eps = 2f32.powi(-15);
  let rec = 1.0 / (sw + eps);
  [(s1 + eps) * rec, (s2 + eps) * rec]
}

#[cfg(target_arch = "aarch64")]
unsafe fn pixels4(source: &[f32], width: usize, y: usize, x: usize) -> [[f32; 2]; 4] {
  use std::arch::aarch64::*;
  debug_assert!(width > 0 && source.len() % (width * 3) == 0);
  debug_assert!(y >= 8 && y + 8 < source.len() / (width * 3));
  debug_assert!(x >= 8 && x + 4 <= width - 8);
  // NEON is baseline on AArch64. The caller reserves the eight-pixel stencil
  // and all four lanes, so every interleaved load addresses twelve valid floats.
  unsafe {
    let load = |y, x| vld3q_f32(source.as_ptr().add((y * width + x) * 3));
    let center = load(y, x);
    let zero = vdupq_n_f32(0.0);
    let one = vdupq_n_f32(1.0);
    let negative = vdupq_n_f32(-256.0);
    let fifth = vdupq_n_f32(0.2);
    let (mut s1, mut s2, mut sw) = (zero, zero, zero);
    for (dy, dx) in [(0, 1), (1, 0), (1, 1), (1, -1)] {
      for i in -8..=8 {
        let sy = (y as isize + dy * i) as usize;
        let sx = (x as isize + dx * i) as usize;
        let p = load(sy, sx);
        let a = vsubq_f32(p.0, center.0);
        let b = vsubq_f32(p.1, center.1);
        let c = vsubq_f32(p.2, center.2);
        let a = vmulq_f32(vmulq_f32(a, a), negative);
        let b = vmulq_f32(vmulq_f32(b, b), negative);
        let c = vmulq_f32(vmulq_f32(c, c), negative);
        let v = vfmaq_f32(one, fifth, vaddq_f32(a, vaddq_f32(b, c)));
        let cube = vmulq_f32(v, vmulq_f32(v, v));
        // f32::clamp retains NaNs and signed zero; min/max-number do not.
        let weight = vbslq_f32(
          vcltq_f32(cube, zero),
          zero,
          vbslq_f32(vcgtq_f32(cube, one), one, cube),
        );
        s1 = vfmaq_f32(s1, weight, p.1);
        s2 = vfmaq_f32(s2, weight, p.2);
        sw = vaddq_f32(sw, weight);
      }
    }
    let eps = vdupq_n_f32(2f32.powi(-15));
    let inverse = vdivq_f32(one, vaddq_f32(sw, eps));
    let mut c1 = [0.0; 4];
    let mut c2 = [0.0; 4];
    vst1q_f32(c1.as_mut_ptr(), vmulq_f32(vaddq_f32(s1, eps), inverse));
    vst1q_f32(c2.as_mut_ptr(), vmulq_f32(vaddq_f32(s2, eps), inverse));
    std::array::from_fn(|i| [c1[i], c2[i]])
  }
}

pub(super) fn apply(source: &[f32], image: &mut RgbImage) {
  let width = image.width;
  assert_eq!(
    width
      .checked_mul(image.height)
      .and_then(|n| n.checked_mul(3)),
    Some(source.len())
  );
  assert_eq!(image.data.len(), source.len());
  for y in 8..image.height - 8 {
    let mut x = 8;
    #[cfg(target_arch = "aarch64")]
    while x + 4 <= width - 8 {
      // The source extent is checked above. Both coordinates reserve the
      // eight-pixel stencil; the loop also reserves all four output lanes.
      let values = unsafe { pixels4(source, width, y, x) };
      for (i, values) in values.into_iter().enumerate() {
        image.data[(y * width + x + i) * 3 + 1..][..2].copy_from_slice(&values);
      }
      x += 4;
    }
    for x in x..width - 8 {
      image.data[(y * width + x) * 3 + 1..][..2].copy_from_slice(&pixel(source, width, y, x));
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn batched_cleanup_matches_original_bits_and_tail() {
    let mut seed = 17u32;
    for width in [31, 32, 33, 34, 35, 64] {
      for mode in 0..4 {
        let mut image = RgbImage::new(width, 37);
        for (i, value) in image.data.iter_mut().enumerate() {
          seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
          *value = match mode {
            0 => (seed >> 16) as f32 * (1.0 / 65535.0),
            1 => {
              if i % 7 == 0 {
                -0.0
              } else {
                0.0
              }
            }
            2 => f32::from_bits(seed & 0x807f_ffff),
            _ => {
              if i % 97 == 0 {
                f32::NAN
              } else {
                (seed >> 16) as f32 * (1.0 / 65535.0)
              }
            }
          };
        }
        let source = image.data.clone();
        let mut expected = image.clone();
        for y in 8..image.height - 8 {
          for x in 8..width - 8 {
            expected.data[(y * width + x) * 3 + 1..][..2]
              .copy_from_slice(&pixel(&source, width, y, x));
          }
        }
        apply(&source, &mut image);
        assert_eq!(
          image.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
          expected
            .data
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
          "width {width}, mode {mode}"
        );
      }
    }
  }
}
