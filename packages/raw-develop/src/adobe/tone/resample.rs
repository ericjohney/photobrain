//! Integer small-image crop resampling used by post-tone statistics.
//!
//! The 128-phase weight construction follows the public DNG SDK's
//! `dng_resample_weights`. Camera Raw 18.7 selects its general cubic kernel
//! with B=0, C=.5 for this near-unity crop and uses signed-u16 convolution.

fn kernel(x: f64) -> f64 {
  let x = x.abs();
  if x >= 2.0 {
    0.0
  } else if x <= 1.0 {
    (x * x).mul_add(x.mul_add(9.0, -15.0), 6.0) * (1.0 / 6.0)
  } else {
    x.mul_add(x.mul_add(x.mul_add(-3.0, 15.0), -24.0), 12.0) * (1.0 / 6.0)
  }
}

fn weights() -> [[i16; 4]; 128] {
  std::array::from_fn(|phase| {
    let t = phase as f64 * (1.0 / 128.0);
    let mut w: [f32; 4] = std::array::from_fn(|j| kernel(j as f64 - 1.0 - t) as f32);
    let total: f64 = w.iter().map(|&v| f64::from(v)).sum();
    let scale = (1.0 / total) as f32;
    w.iter_mut().for_each(|v| *v *= scale);
    let mut q = w.map(|v| (f64::from(v) * 16384.0).round() as i16);
    let total: i32 = q.iter().map(|&v| i32::from(v)).sum();
    q[if phase < 64 { 1 } else { 2 }] += (16384 - total) as i16;
    q
  })
}

/// Preserve the fractional last pyramid cell when mapping the default crop
/// to its rounded small-image dimensions. Edge pixels replicate.
pub(super) fn crop(image: &super::stats_image::SmallImage) -> Vec<[u16; 3]> {
  let mut pixels = image.pixels.clone();
  let weights = weights();
  for (vertical, full, size) in [
    (false, image.full_width, image.width),
    (true, image.full_height, image.height),
  ] {
    let step = full as f64 / ((1usize << image.level) * size) as f64;
    if step == 1.0 {
      continue;
    }
    pixels = axis(&pixels, image.width, image.height, vertical, step, &weights);
  }
  pixels
}

fn axis(
  input: &[[u16; 3]],
  width: usize,
  height: usize,
  vertical: bool,
  step: f64,
  weights: &[[i16; 4]; 128],
) -> Vec<[u16; 3]> {
  let step = (step * 4294967296.0).round() as i64;
  // Initialize adds half a destination pixel, the radius offset, and 1/256
  // before extracting the integer source coordinate and 1/128 phase.
  let origin = (step >> 1) - (1i64 << 32) - 0x7f00_0000;
  let size = if vertical { height } else { width };
  (0..width * height)
    .map(|i| {
      let (x, y) = (i % width, i / width);
      let index = if vertical { y } else { x };
      let position = origin + step * index as i64;
      let start = position >> 32;
      let phase = ((position as u64 >> 25) & 127) as usize;
      std::array::from_fn(|c| {
        let mut sum = 8192i32;
        for (j, &weight) in weights[phase].iter().enumerate() {
          let source = (start + j as i64).clamp(0, size as i64 - 1) as usize;
          let source = if vertical {
            source * width + x
          } else {
            y * width + source
          };
          sum += (i32::from(input[source][c]) - 32768) * i32::from(weight);
        }
        ((sum >> 14).clamp(-32768, 32767) + 32768) as u16
      })
    })
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn weights_and_resampling_preserve_constants() {
    assert!(
      weights()
        .iter()
        .all(|w| w.iter().map(|&v| i32::from(v)).sum::<i32>() == 16384)
    );
    let image = super::super::stats_image::SmallImage {
      pixels: vec![[12, 32768, 65535]; 242 * 161],
      width: 242,
      height: 161,
      level: 5,
      full_width: 7728,
      full_height: 5152,
    };
    assert_eq!(crop(&image), image.pixels);
  }
}
