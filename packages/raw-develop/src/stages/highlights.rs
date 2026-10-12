//! Highlight reconstruction.
//!
//! After white balance the three channels clip at different levels (1/wb for red and
//! blue, 1.0 for green on Fuji sensors). Where some channels are clipped and others are
//! not, the clipped channels are rebuilt from the unclipped ones using the colour ratio
//! of nearby, unclipped pixels; where all channels are clipped the pixel is set to the
//! neutral maximum so blown areas render white instead of magenta/cyan.
//!
//! Input: white-balanced camera RGB (white = 1.0 in every channel for the scene white).

use crate::image::RgbImage;
use rayon::prelude::*;

/// Per-channel clip level in white-balanced units.
pub fn clip_levels(wb: [f32; 3]) -> [f32; 3] {
  // A sensor value of 1.0 (white level) becomes wb[c] after balancing.
  wb
}

pub fn recover(img: &mut RgbImage, clip: [f32; 3]) {
  // Threshold slightly below clip so demosaic-interpolated values near clipping count.
  let thresh = clip.map(|c| c * 0.97);
  let neutral_max = clip.iter().cloned().fold(f32::INFINITY, f32::min);
  let (w, h) = (img.width, img.height);

  // Downsampled map of chroma ratios from unclipped pixels (16x16 blocks), used as the
  // colour to restore inside clipped regions.
  let bs = 16usize;
  let (bw, bh) = (w.div_ceil(bs), h.div_ceil(bs));
  let mut ratios = vec![[0.0f32; 4]; bw * bh]; // r/g, b/g sums and count, valid
  ratios.par_chunks_mut(bw).enumerate().for_each(|(by, row)| {
    for (bx, cell) in row.iter_mut().enumerate() {
      let (mut rg, mut bg, mut n) = (0.0f32, 0.0f32, 0.0f32);
      for y in by * bs..((by + 1) * bs).min(h) {
        for x in bx * bs..((bx + 1) * bs).min(w) {
          let p = img.px(x, y);
          if p[0] < thresh[0] && p[1] < thresh[1] && p[2] < thresh[2] && p[1] > 0.05 {
            rg += p[0] / p[1];
            bg += p[2] / p[1];
            n += 1.0;
          }
        }
      }
      *cell = if n > 0.0 {
        [rg / n, bg / n, n, 1.0]
      } else {
        [1.0, 1.0, 0.0, 0.0]
      };
    }
  });
  // Fill blocks without valid samples from their nearest valid neighbours (a few passes).
  for _ in 0..8 {
    let prev = ratios.clone();
    let mut changed = false;
    for by in 0..bh {
      for bx in 0..bw {
        if prev[by * bw + bx][3] > 0.0 {
          continue;
        }
        let (mut rg, mut bg, mut n) = (0.0, 0.0, 0.0);
        for (dx, dy) in [(-1i32, 0i32), (1, 0), (0, -1), (0, 1)] {
          let (x, y) = (bx as i32 + dx, by as i32 + dy);
          if x >= 0 && y >= 0 && (x as usize) < bw && (y as usize) < bh {
            let c = prev[y as usize * bw + x as usize];
            if c[3] > 0.0 {
              rg += c[0];
              bg += c[1];
              n += 1.0;
            }
          }
        }
        if n > 0.0 {
          ratios[by * bw + bx] = [rg / n, bg / n, 0.0, 1.0];
          changed = true;
        }
      }
    }
    if !changed {
      break;
    }
  }

  img.rows_mut().for_each(|(y, row)| {
    for x in 0..w {
      let p = &mut row[x * 3..x * 3 + 3];
      let clipped = [p[0] >= thresh[0], p[1] >= thresh[1], p[2] >= thresh[2]];
      let n = clipped.iter().filter(|&&c| c).count();
      if n == 0 {
        continue;
      }
      if n == 3 {
        let m = p[0].max(p[1]).max(p[2]).max(neutral_max);
        p.copy_from_slice(&[m, m, m]);
        continue;
      }
      let r = ratios[(y / bs) * bw + x / bs];
      let (rg, bg) = (r[0].max(0.05), r[1].max(0.05));
      // Estimate green from the unclipped channels, then rebuild clipped channels, never
      // below their clipped value (reconstruction can only raise them).
      let g_est = if !clipped[1] {
        p[1]
      } else {
        let mut s = 0.0;
        let mut k = 0.0;
        if !clipped[0] {
          s += p[0] / rg;
          k += 1.0;
        }
        if !clipped[2] {
          s += p[2] / bg;
          k += 1.0;
        }
        (s / k).max(p[1])
      };
      if clipped[1] {
        p[1] = g_est;
      }
      if clipped[0] {
        p[0] = (g_est * rg).max(p[0]);
      }
      if clipped[2] {
        p[2] = (g_est * bg).max(p[2]);
      }
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fully_clipped_becomes_neutral() {
    let mut im = RgbImage::new(4, 4);
    for p in im.data.chunks_mut(3) {
      p.copy_from_slice(&[2.0, 1.0, 1.8]);
    }
    recover(&mut im, [2.0, 1.0, 1.8]);
    let p = im.px(1, 1);
    assert!((p[0] - p[1]).abs() < 1e-6 && (p[2] - p[1]).abs() < 1e-6);
  }

  #[test]
  fn green_clip_restored_from_neighbour_ratio() {
    let mut im = RgbImage::new(32, 32);
    for (i, p) in im.data.chunks_mut(3).enumerate() {
      // Left half: unclipped warm colour r/g = 1.2. Right half: green clipped.
      if i % 32 < 16 {
        p.copy_from_slice(&[0.6, 0.5, 0.3])
      } else {
        p.copy_from_slice(&[1.5, 1.0, 0.6])
      }
    }
    recover(&mut im, [2.0, 1.0, 1.8]);
    let p = im.px(20, 5);
    assert!(p[1] > 1.0, "{p:?}");
  }
}
