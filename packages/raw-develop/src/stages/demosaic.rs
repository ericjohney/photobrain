//! X-Trans demosaicing.
//!
//! `full` reconstructs every photosite:
//! 1. Green at red/blue sites: each of the four axes (horizontal, vertical, two
//!    diagonals) whose two neighbours are green gives an estimate; estimates are blended
//!    with weights falling off with the gradient along that axis, so interpolation runs
//!    along edges rather than across them.
//! 2. Red and blue everywhere by colour-difference interpolation: (R - G) and (B - G) are
//!    smooth, so they are averaged from same-colour sites in a 5x5 window weighted by
//!    distance and by green similarity, then added back to the local green.
//!
//! `binned` averages each aligned 3x3 cell (5 G, 2 R, 2 B in every X-Trans cell) into one
//! output pixel: exact colour at one third of the resolution, for previews.
//!
//! Input is a white-balanced, black-subtracted, white-normalised mosaic.

use crate::cfa::{CfaPattern, Channel};
use crate::image::RgbImage;
use rayon::prelude::*;

/// A float mosaic view with its CFA (pattern indexed in this view's coordinates).
pub struct Mosaic<'a> {
  pub width: usize,
  pub height: usize,
  pub data: &'a [f32],
  pub cfa: &'a CfaPattern,
}

impl Mosaic<'_> {
  #[inline]
  fn at(&self, x: isize, y: isize) -> f32 {
    let x = x.clamp(0, self.width as isize - 1) as usize;
    let y = y.clamp(0, self.height as isize - 1) as usize;
    self.data[y * self.width + x]
  }

  #[inline]
  fn ch(&self, x: isize, y: isize) -> Channel {
    // Reflect at borders so the colour matches the clamped sample.
    let x = x.clamp(0, self.width as isize - 1) as usize;
    let y = y.clamp(0, self.height as isize - 1) as usize;
    self.cfa.at(y, x)
  }
}

const AXES: [[(isize, isize); 2]; 4] = [
  [(-1, 0), (1, 0)],
  [(0, -1), (0, 1)],
  [(-1, -1), (1, 1)],
  [(1, -1), (-1, 1)],
];

fn green_plane(m: &Mosaic) -> Vec<f32> {
  let (w, h) = (m.width, m.height);
  let mut g = vec![0.0f32; w * h];
  g.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
    let y = y as isize;
    for (x, out) in row.iter_mut().enumerate() {
      let x = x as isize;
      if m.ch(x, y) == Channel::Green {
        *out = m.at(x, y);
        continue;
      }
      let mut num = 0.0f32;
      let mut den = 0.0f32;
      for axis in AXES {
        let (a, b) = (axis[0], axis[1]);
        if m.ch(x + a.0, y + a.1) != Channel::Green || m.ch(x + b.0, y + b.1) != Channel::Green {
          continue;
        }
        let ga = m.at(x + a.0, y + a.1);
        let gb = m.at(x + b.0, y + b.1);
        // Gradient along the axis, including the next green beyond each neighbour when
        // present, which detects edges the two immediate neighbours straddle.
        let mut grad = (ga - gb).abs();
        for (d, gv) in [(a, ga), (b, gb)] {
          let (fx, fy) = (x + 2 * d.0, y + 2 * d.1);
          if m.ch(fx, fy) == Channel::Green {
            grad += (m.at(fx, fy) - gv).abs();
          }
        }
        let wgt = 1.0 / (grad * grad + 1e-8);
        num += wgt * 0.5 * (ga + gb);
        den += wgt;
      }
      if den == 0.0 {
        // No axis with two green neighbours: average all green 8-neighbours.
        let mut s = 0.0;
        let mut n = 0.0;
        for dy in -1..=1 {
          for dx in -1..=1 {
            if (dx, dy) != (0, 0) && m.ch(x + dx, y + dy) == Channel::Green {
              s += m.at(x + dx, y + dy);
              n += 1.0;
            }
          }
        }
        *out = if n > 0.0 { s / n } else { m.at(x, y) };
      } else {
        *out = num / den;
      }
    }
  });
  g
}

/// Full-resolution demosaic.
pub fn full(m: &Mosaic) -> RgbImage {
  let (w, h) = (m.width, m.height);
  let g = green_plane(m);
  let gat = |x: isize, y: isize| {
    let x = x.clamp(0, w as isize - 1) as usize;
    let y = y.clamp(0, h as isize - 1) as usize;
    g[y * w + x]
  };
  let mut out = RgbImage::new(w, h);
  out.rows_mut().for_each(|(y, row)| {
    let y = y as isize;
    for x in 0..w {
      let xi = x as isize;
      let g0 = gat(xi, y);
      let own = m.ch(xi, y);
      let mut rgb = [0.0f32; 3];
      rgb[1] = g0;
      for (target, idx) in [(Channel::Red, 0usize), (Channel::Blue, 2usize)] {
        if own == target {
          rgb[idx] = m.at(xi, y);
          continue;
        }
        let mut num = 0.0f32;
        let mut den = 0.0f32;
        for dy in -2isize..=2 {
          for dx in -2isize..=2 {
            if m.ch(xi + dx, y + dy) != target {
              continue;
            }
            let gq = gat(xi + dx, y + dy);
            let diff = m.at(xi + dx, y + dy) - gq;
            let dist = (dx * dx + dy * dy) as f32;
            let sim = (gq - g0).abs();
            let wgt = 1.0 / (dist * (1.0 + sim * sim * 2.0e4));
            num += wgt * diff;
            den += wgt;
          }
        }
        rgb[idx] = g0 + if den > 0.0 { num / den } else { 0.0 };
      }
      row[x * 3..x * 3 + 3].copy_from_slice(&rgb);
    }
  });
  out
}

/// Luma/chroma refinement after `full`: chroma (each channel minus luma) is smoothed,
/// and luma is rebuilt at every photosite from that site's own measurement minus the
/// smoothed chroma of its colour. Luminance detail then comes from all photosites (not
/// only green), and high-frequency false colour is removed.
pub fn refine_luma_chroma(m: &Mosaic, img: &mut RgbImage, radius: usize) {
  const LUMA: [f32; 3] = [0.299, 0.587, 0.114];
  let (w, h) = (m.width, m.height);
  let n = w * h;
  let mut k = [vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]];
  for i in 0..n {
    let p = &img.data[i * 3..i * 3 + 3];
    let y = p[0] * LUMA[0] + p[1] * LUMA[1] + p[2] * LUMA[2];
    for c in 0..3 {
      k[c][i] = p[c] - y;
    }
  }
  let k: Vec<Vec<f32>> = k
    .into_par_iter()
    .map(|plane| crate::stages::detail::blur_plane(&plane, w, h, radius, 2))
    .collect();
  img.rows_mut().for_each(|(y, row)| {
    for x in 0..w {
      let i = y * w + x;
      let c = m.cfa.at(y, x) as usize;
      let luma = m.data[i] - k[c][i];
      for ch in 0..3 {
        row[x * 3 + ch] = luma + k[ch][i];
      }
    }
  });
}

/// Binning cell size for a CFA: 3 for X-Trans (5G/2R/2B per cell), 2 for Bayer
/// (1R/2G/1B).
pub fn bin_size(cfa: &CfaPattern) -> usize {
  if cfa.is_xtrans() { 3 } else { 2 }
}

/// One output pixel per aligned `bin_size` cell (cells start at the view origin, which
/// must be a multiple of the cell size in the CFA pattern so every cell holds all three
/// colours).
pub fn binned(m: &Mosaic) -> RgbImage {
  let b = bin_size(m.cfa);
  let (w, h) = (m.width / b, m.height / b);
  let mut out = RgbImage::new(w, h);
  out.rows_mut().for_each(|(by, row)| {
    for bx in 0..w {
      let mut s = [0.0f32; 3];
      let mut n = [0.0f32; 3];
      for dy in 0..b {
        for dx in 0..b {
          let (x, y) = (bx * b + dx, by * b + dy);
          let c = m.cfa.at(y, x) as usize;
          s[c] += m.data[y * m.width + x];
          n[c] += 1.0;
        }
      }
      for c in 0..3 {
        row[bx * 3 + c] = if n[c] > 0.0 { s[c] / n[c] } else { 0.0 };
      }
    }
  });
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  fn mosaic_of(
    img: &dyn Fn(usize, usize) -> [f32; 3],
    w: usize,
    h: usize,
    cfa: &CfaPattern,
  ) -> Vec<f32> {
    let mut v = vec![0.0; w * h];
    for y in 0..h {
      for x in 0..w {
        v[y * w + x] = img(x, y)[cfa.at(y, x) as usize];
      }
    }
    v
  }

  #[test]
  fn flat_colour_is_exact() {
    let cfa = CfaPattern::xtrans_default();
    let (w, h) = (36, 30);
    let data = mosaic_of(&|_, _| [0.3, 0.5, 0.2], w, h, &cfa);
    let m = Mosaic {
      width: w,
      height: h,
      data: &data,
      cfa: &cfa,
    };
    let out = full(&m);
    for y in 0..h {
      for x in 0..w {
        let p = out.px(x, y);
        for (c, v) in [0.3, 0.5, 0.2].into_iter().enumerate() {
          assert!((p[c] - v).abs() < 1e-5, "({x},{y}) {p:?}");
        }
      }
    }
    let b = binned(&m);
    assert!((b.px(3, 3)[0] - 0.3).abs() < 1e-6);
  }

  #[test]
  fn bayer_binning_is_exact_on_flat_colour() {
    use Channel::{Blue as B, Green as G, Red as R};
    let cfa = CfaPattern::new(2, 2, vec![R, G, G, B]).unwrap();
    let (w, h) = (10, 8);
    let data = mosaic_of(&|_, _| [0.3, 0.5, 0.2], w, h, &cfa);
    let m = Mosaic {
      width: w,
      height: h,
      data: &data,
      cfa: &cfa,
    };
    let b = binned(&m);
    assert_eq!((b.width, b.height), (5, 4));
    assert_eq!(b.px(2, 1), [0.3, 0.5, 0.2]);
  }

  #[test]
  fn every_cell_has_5_2_2() {
    let cfa = CfaPattern::xtrans_default();
    for cy in [0, 3] {
      for cx in [0, 3] {
        let mut n = [0; 3];
        for dy in 0..3 {
          for dx in 0..3 {
            n[cfa.at(cy + dy, cx + dx) as usize] += 1;
          }
        }
        assert_eq!(n, [2, 5, 2]);
      }
    }
  }

  #[test]
  fn smooth_gradient_has_small_error() {
    let cfa = CfaPattern::xtrans_default();
    let (w, h) = (60, 60);
    let f = |x: usize, y: usize| {
      let (fx, fy) = (x as f32 / 60.0, y as f32 / 60.0);
      [0.2 + 0.5 * fx, 0.3 + 0.4 * fy, 0.6 - 0.3 * fx * fy]
    };
    let data = mosaic_of(&f, w, h, &cfa);
    let m = Mosaic {
      width: w,
      height: h,
      data: &data,
      cfa: &cfa,
    };
    let out = full(&m);
    let mut worst = 0.0f32;
    for y in 3..h - 3 {
      for x in 3..w - 3 {
        let p = out.px(x, y);
        let t = f(x, y);
        for c in 0..3 {
          worst = worst.max((p[c] - t[c]).abs());
        }
      }
    }
    assert!(worst < 0.01, "worst {worst}");
  }

  #[test]
  fn sharp_edge_has_no_large_overshoot() {
    let cfa = CfaPattern::xtrans_default();
    let (w, h) = (48, 48);
    let f = |x: usize, _y: usize| {
      if x < 24 {
        [0.1, 0.1, 0.1]
      } else {
        [0.8, 0.8, 0.8]
      }
    };
    let data = mosaic_of(&f, w, h, &cfa);
    let m = Mosaic {
      width: w,
      height: h,
      data: &data,
      cfa: &cfa,
    };
    let out = full(&m);
    for y in 4..h - 4 {
      for x in 4..w - 4 {
        for v in out.px(x, y) {
          assert!((0.05..=0.85).contains(&v), "({x},{y}) {v}");
        }
      }
    }
  }
}
