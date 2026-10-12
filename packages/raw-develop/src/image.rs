//! Planar-free, interleaved RGB float image used between pipeline stages.

use rayon::prelude::*;

#[derive(Clone, Debug)]
pub struct RgbImage {
  pub width: usize,
  pub height: usize,
  /// Interleaved RGB, row-major, top row first.
  pub data: Vec<f32>,
}

impl RgbImage {
  pub fn new(width: usize, height: usize) -> Self {
    Self {
      width,
      height,
      data: vec![0.0; width * height * 3],
    }
  }

  #[inline]
  pub fn px(&self, x: usize, y: usize) -> [f32; 3] {
    let i = (y * self.width + x) * 3;
    [self.data[i], self.data[i + 1], self.data[i + 2]]
  }

  pub fn rows_mut(&mut self) -> impl IndexedParallelIterator<Item = (usize, &mut [f32])> {
    self.data.par_chunks_mut(self.width * 3).enumerate()
  }

  /// Apply a per-pixel function in parallel.
  pub fn map_pixels(&mut self, f: impl Fn([f32; 3]) -> [f32; 3] + Sync) {
    self.data.par_chunks_mut(3).for_each(|p| {
      let o = f([p[0], p[1], p[2]]);
      p.copy_from_slice(&o);
    });
  }

  /// Bilinear sample with edge clamping; coordinates are pixel centres at (x + 0.5).
  #[inline]
  pub fn sample_bilinear(&self, x: f32, y: f32, c: usize) -> f32 {
    let fx = (x - 0.5).clamp(0.0, (self.width - 1) as f32);
    let fy = (y - 0.5).clamp(0.0, (self.height - 1) as f32);
    let x0 = fx as usize;
    let y0 = fy as usize;
    let x1 = (x0 + 1).min(self.width - 1);
    let y1 = (y0 + 1).min(self.height - 1);
    let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
    let g = |x: usize, y: usize| self.data[(y * self.width + x) * 3 + c];
    let a = g(x0, y0) + (g(x1, y0) - g(x0, y0)) * tx;
    let b = g(x0, y1) + (g(x1, y1) - g(x0, y1)) * tx;
    a + (b - a) * ty
  }

  /// Box downscale by an integer factor.
  pub fn downscale(&self, factor: usize) -> RgbImage {
    if factor <= 1 {
      return self.clone();
    }
    let (w, h) = (self.width / factor, self.height / factor);
    let mut out = RgbImage::new(w, h);
    let inv = 1.0 / (factor * factor) as f32;
    out.rows_mut().for_each(|(y, row)| {
      for x in 0..w {
        let mut s = [0.0f32; 3];
        for dy in 0..factor {
          let src = ((y * factor + dy) * self.width + x * factor) * 3;
          for dx in 0..factor {
            for c in 0..3 {
              s[c] += self.data[src + dx * 3 + c];
            }
          }
        }
        for c in 0..3 {
          row[x * 3 + c] = s[c] * inv;
        }
      }
    });
    out
  }

  pub fn crop(&self, x0: usize, y0: usize, w: usize, h: usize) -> RgbImage {
    let mut out = RgbImage::new(w, h);
    out.rows_mut().for_each(|(y, row)| {
      let src = ((y0 + y) * self.width + x0) * 3;
      row.copy_from_slice(&self.data[src..src + w * 3]);
    });
    out
  }

  /// Apply an EXIF orientation (1-8) to produce the display-oriented image.
  pub fn oriented(&self, orientation: u16) -> RgbImage {
    let (w, h) = (self.width, self.height);
    let swap = matches!(orientation, 5..=8);
    let (ow, oh) = if swap { (h, w) } else { (w, h) };
    let mut out = RgbImage::new(ow, oh);
    out.rows_mut().for_each(|(oy, row)| {
      for ox in 0..ow {
        // Source pixel for output (ox, oy).
        let (sx, sy) = match orientation {
          2 => (w - 1 - ox, oy),
          3 => (w - 1 - ox, h - 1 - oy),
          4 => (ox, h - 1 - oy),
          5 => (oy, ox),
          6 => (oy, h - 1 - ox),
          7 => (w - 1 - oy, h - 1 - ox),
          8 => (w - 1 - oy, ox),
          _ => (ox, oy),
        };
        let s = (sy * w + sx) * 3;
        row[ox * 3..ox * 3 + 3].copy_from_slice(&self.data[s..s + 3]);
      }
    });
    out
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn numbered(w: usize, h: usize) -> RgbImage {
    let mut im = RgbImage::new(w, h);
    for (i, p) in im.data.chunks_mut(3).enumerate() {
      p[0] = i as f32;
    }
    im
  }

  #[test]
  fn orientation_8_rotates_counter_clockwise() {
    // EXIF 8: the image must be rotated 90 degrees counter-clockwise for display, so the
    // top-right source pixel lands at the top-left.
    let im = numbered(3, 2);
    let o = im.oriented(8);
    assert_eq!((o.width, o.height), (2, 3));
    assert_eq!(o.px(0, 0)[0], 2.0);
    assert_eq!(o.px(1, 0)[0], 5.0);
    assert_eq!(o.px(0, 2)[0], 0.0);
  }

  #[test]
  fn orientation_6_rotates_clockwise() {
    let im = numbered(3, 2);
    let o = im.oriented(6);
    assert_eq!(o.px(0, 0)[0], 3.0);
    assert_eq!(o.px(1, 0)[0], 0.0);
  }

  #[test]
  fn downscale_averages() {
    let im = numbered(4, 2);
    let d = im.downscale(2);
    assert_eq!((d.width, d.height), (2, 1));
    assert_eq!(d.px(0, 0)[0], (0.0 + 1.0 + 4.0 + 5.0) / 4.0);
  }
}
