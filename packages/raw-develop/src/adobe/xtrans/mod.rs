//! Adobe 18.7 X-Trans demosaic and its mandatory false-colour cleanup.
//!
//! The six-pass directional kernel and cleanup were reconstructed from the
//! symbolised DNG Converter and checked against intermediate CPU-stage captures.
//! Float operation order, fused operations and u16 buffer boundaries are retained.
//! This is separate from Adobe's user-adjustable noise reduction and sharpening.

mod activities;
mod bilateral;
mod cleanup;
mod reconstruct;
#[cfg(test)]
mod tests;

use super::linearize::table as linearization_table;
use crate::error::{Error, Result};
use crate::image::RgbImage;
use crate::{Cancel, Negative};
use cleanup::Parameters;
use rayon::prelude::*;

const HALO: usize = 32;
const TILE: usize = 192;

#[inline(always)]
fn fm(a: f32, b: f32, c: f32) -> f32 {
  a.mul_add(b, c)
}

struct Plane {
  width: usize,
  height: usize,
  data: Vec<f32>,
}
impl Plane {
  fn new(width: usize, height: usize, value: f32) -> Self {
    Self {
      width,
      height,
      data: vec![value; width * height],
    }
  }
  #[inline(always)]
  fn at(&self, y: usize, x: usize) -> f32 {
    self.data[y * self.width + x]
  }
  #[inline(always)]
  fn tap(&self, y: usize, x: usize, dy: isize, dx: isize) -> f32 {
    self.at(y.wrapping_add_signed(dy), x.wrapping_add_signed(dx))
  }
  #[inline(always)]
  fn set(&mut self, y: usize, x: usize, v: f32) {
    self.data[y * self.width + x] = v;
  }
}

/// DNG `AsShotNeutral` uses six decimal digits, after normalising the largest entry.
pub(crate) fn rounded_neutral(neutral: [f64; 3]) -> [f64; 3] {
  let max = neutral.into_iter().fold(0.0, f64::max);
  neutral.map(|v| (v / max * 1e6).round() / 1e6)
}

// X-E5 and X100VI select the same measured sensor noise calibration in ACR 18.7.
// Each row: ISO, scale R/G/B, offset R/G/B in Adobe's 16-bit calibration units.
pub(crate) const NOISE: [[f64; 7]; 13] = [
  [64., 2.3227, 2.2563, 2.2334, 61.21, 56.18, 50.87],
  [80., 2.9345, 2.8764, 2.8564, 92.24, 83.83, 77.13],
  [100., 3.722, 3.6342, 3.6049, 133.18, 126.79, 117.55],
  [125., 1.9759, 1.9252, 1.906, 59.26, 58.3, 53.59],
  [200., 3.4451, 3.3932, 3.357, 132.56, 129.23, 109.45],
  [400., 6.9017, 6.7956, 6.7515, 448.07, 434.91, 364.69],
  [800., 13.936, 13.6576, 13.4336, 581.72, 571.63, 482.76],
  [1600., 27.6065, 27.2737, 26.8282, 2144.35, 1990.61, 1815.77],
  [3200., 55.2877, 54.3458, 53.5059, 7316.68, 7661.31, 6842.56],
  [
    6400., 109.6498, 107.7586, 105.1862, 29242.26, 27142.26, 26438.99,
  ],
  [
    12800., 172.0281, 167.0954, 165.3627, 91728.62, 94720.44, 85890.06,
  ],
  [
    25600., 145.4208, 139.3651, 137.2006, 89045.93, 86944.11, 74506.98,
  ],
  [
    51200., 102.7727, 91.6491, 95.1913, 86457.2, 82976.96, 74235.97,
  ],
];

fn noise_offset(iso: u32) -> f64 {
  let iso = iso as f64;
  let mut s = [0.0; 3];
  let mut o = [0.0; 3];
  if iso <= NOISE[0][0] || iso >= NOISE[12][0] {
    let row = if iso <= NOISE[0][0] {
      NOISE[0]
    } else {
      NOISE[12]
    };
    let q = if iso == 0.0 { 1.0 } else { iso / row[0] };
    for k in 0..3 {
      s[k] = row[1 + k] * q;
      o[k] = row[4 + k] * (q * q);
    }
  } else {
    let i = (1..NOISE.len()).find(|&i| iso <= NOISE[i][0]).unwrap();
    let a = NOISE[i - 1];
    let b = NOISE[i];
    let q = (iso - a[0]) / (b[0] - a[0]);
    for k in 0..3 {
      s[k] = a[1 + k] + (b[1 + k] - a[1 + k]) * q;
      let v = a[4 + k].sqrt() + (b[4 + k].sqrt() - a[4 + k].sqrt()) * q;
      o[k] = v * v;
    }
  }
  for k in 0..3 {
    s[k] *= 1.0 / 65535.0;
    o[k] *= 1.0 / (65535.0 * 65535.0);
  }
  // NegativeToNoise chooses the largest flattening-curve normalisation. Preserve
  // its arithmetic instead of simplifying the expression; ties keep the first.
  let score = |k: usize| 1.0 / ((2.0 * (s[k] + o[k]).sqrt()) / s[k] - (2.0 * o[k].sqrt()) / s[k]);
  let mut best = 0;
  for k in 1..3 {
    if score(best) < score(k) {
      best = k;
    }
  }
  o[best]
}

// Canonical phase used by Adobe's kernel: the isolated green in each 3x3 cell
// is at (1,1), and the red/blue estimates swap in alternating 3x3 cells.
fn canonical_channel(y: usize, x: usize) -> usize {
  let m = (y % 3) * 3 + x % 3;
  if m.is_multiple_of(2) {
    1
  } else if ((y % 6 < 3) == (x % 6 < 3)) == (m == 1 || m == 7) {
    2
  } else {
    0
  }
}

fn phase_origin(neg: &Negative) -> Result<(usize, usize)> {
  for y in 0..6 {
    for x in 0..6 {
      if (0..6).all(|dy| {
        (0..6).all(|dx| neg.meta.cfa.at(y + dy, x + dx) as usize == canonical_channel(dy, dx))
      }) {
        return Ok((y, x));
      }
    }
  }
  Err(Error::Unsupported(
    "Adobe X-Trans: unsupported CFA phase".into(),
  ))
}

fn affine(gain: f64, black: f64) -> (f32, f32) {
  let b = black as f32;
  let s = (1.0 / (1.0 - black)) as f32;
  let v = (-(b as f64) * (s as f64)) as f32;
  let g = gain as f32;
  (g, (fm(g, v, 0.0) - v) / s)
}

fn demosaic(pin: &Plane, top: isize, left: isize, params: &Parameters, offset: f64) -> RgbImage {
  let (w, h) = (pin.width, pin.height);
  let mut p = Plane::new(w, h, f32::NAN);
  let gain = params.gains.map(|v| affine(v as f64, params.black));
  for y in 0..h {
    for x in 0..w {
      let c = canonical_channel(
        (top + y as isize).rem_euclid(6) as usize,
        (left + x as isize).rem_euclid(6) as usize,
      );
      p.set(y, x, fm(gain[c].0, pin.at(y, x), gain[c].1));
    }
  }
  let mut a: [Plane; 8] = std::array::from_fn(|_| Plane::new(w, h, f32::NAN));
  for y in 3..h - 4 {
    for x in 3..w - 4 {
      if (top + y as isize).rem_euclid(3) == 1 && (left + x as isize).rem_euclid(3) == 1 {
        for (k, v) in activities::activities(&p, y, x).into_iter().enumerate() {
          a[k].set(y, x, v);
        }
      }
    }
  }
  for plane in &mut a {
    spread(plane, top, left);
  }
  let th = (offset.sqrt() * 13.0) as f32;
  let mut out = RgbImage::new(w, h);
  out.data.fill(f32::NAN);
  for y in 10..h - 10 {
    for x in 10..w - 10 {
      let (c17, c18) = directions(std::array::from_fn(|k| a[k].at(y, x)), th, th * 20.0);
      let ry = (top + y as isize).rem_euclid(6) as usize;
      let cx = (left + x as isize).rem_euclid(6) as usize;
      let mode = (ry % 3) * 3 + cx % 3;
      let g = green(&p, y, x, mode, c17);
      let (e1, e2) = reconstruct::reconstruct(&p, y, x, mode, c18);
      let (r, b) = if (ry < 3) == (cx < 3) {
        (e2, e1)
      } else {
        (e1, e2)
      };
      out.data[(y * w + x) * 3..(y * w + x) * 3 + 3].copy_from_slice(&[r, g, b]);
    }
  }
  out
}

fn directions(p: [f32; 8], th: f32, color_th: f32) -> (u8, u8) {
  let min = p.into_iter().fold(f32::INFINITY, f32::min);
  let (a, b, code, color) = if min == p[0] {
    (p[0], p[1], 0, 0)
  } else if min == p[1] {
    (p[0], p[1], 1, 1)
  } else if min == p[2] {
    (p[2], p[3], 2, 2)
  } else if min == p[3] {
    (p[2], p[3], 3, 3)
  } else if min == p[4] {
    (p[4], p[7], 5, 2)
  } else if min == p[5] {
    (p[5], p[6], 4, 3)
  } else if min == p[6] {
    (p[6], p[5], 7, 2)
  } else {
    (p[7], p[4], 6, 3)
  };
  let gap = (a - b).abs();
  (
    if gap <= th { 255 } else { code },
    if gap <= color_th { 255 } else { color },
  )
}

fn green(p: &Plane, y: usize, x: usize, m: usize, c: u8) -> f32 {
  if m.is_multiple_of(2) {
    return p.at(y, x);
  }
  let r = |dy, dx| p.tap(y, x, dy, dx);
  let blend = |near, far| fm(near, 0.75, far * 0.25);
  let clamp = |v: f32, n: f32, a: f32, b: f32| n.min(a).min(b).max(v.min(n.max(a).max(b)));
  if m == 1 || m == 7 {
    let s = if m == 1 { 1 } else { -1 };
    let (a, b) = (r(0, -1), r(0, 1));
    if c == 0 {
      let n = r(s, 0);
      return clamp(blend(n, r(-2 * s, 0)), n, b, a);
    }
    if c == 1 {
      return 0.5 * b + 0.5 * a;
    }
    if c == 255 {
      return (a + b) * 0.5;
    }
    let (r96, r107, r90) = if m == 1 { (2, -1, -4) } else { (-2, 1, 4) };
    let (n, f) = if c & 0xfe == 4 {
      let b = (m == 7) != (c == 4);
      (
        r(r96, if b { 1 } else { -1 }),
        r(r90, if b { -2 } else { 2 }),
      )
    } else {
      let b = (m == 7) == (c == 6);
      let (mut i93, mut i88) = if b { (2, -4) } else { (-2, 4) };
      let b = (m == 7) == (c == 3);
      if c & 0xfe == 2 {
        (i93, i88) = if b { (1, -2) } else { (-1, 2) };
      }
      (r(r107, i93), r(r96, i88))
    };
    return blend(n, f);
  }
  let (a, b) = (r(-1, 0), r(1, 0));
  let (mut i93, mut i88) = if m == 5 { (-1, 2) } else { (1, -2) };
  if c == 0 {
    return 0.5 * b + 0.5 * a;
  }
  if c == 1 {
    let n = r(0, i93);
    return clamp(blend(n, r(0, i88)), n, b, a);
  }
  if c == 255 {
    return (a + b) * 0.5;
  }
  let mask = c & 0xfe;
  let (r90, mut r96) = if (m == 5) == (c == 4) {
    (-4, 2)
  } else {
    (4, -2)
  };
  let (mut r99, mut r107) = if (m == 5) == (c == 6) {
    (2, -1)
  } else {
    (-2, 1)
  };
  let (r19, r47) = if (m == 5) == (c == 3) {
    (-2, 1)
  } else {
    (2, -1)
  };
  let (mut i49, mut i65) = (i93 * 4, i88);
  if mask == 2 {
    (r99, i49, r107, i65) = (r19, i88, r47, i93);
  }
  if mask != 4 {
    (i88, r96, i93) = (i49, r107, i65);
  }
  blend(r(r96, -i93), r(if mask == 4 { r90 } else { r99 }, -i88))
}

// EVDD has a distinct association in the scalar head/tail and unrolled triples.
// Retain it at each tile boundary; algebraic reassociation changes direction ties.
fn spread(p: &mut Plane, top: isize, left: isize) {
  let (w, h) = (p.width, p.height);
  let mut out = p.data.clone();
  for y in 7..h - 7 {
    let row = (top + y as isize).rem_euclid(3) as usize;
    let mode = |x: usize| row * 3 + (left + x as isize).rem_euclid(3) as usize;
    let (c0, c1) = (7, w - 7);
    let mut x = c0;
    let scalar = |x: usize| {
      let m = mode(x);
      if row == 1 {
        if m.is_multiple_of(2) {
          return p.at(y, x);
        }
        let (i9, i7) = if m == 5 { (2, -1) } else { (-2, 1) };
        let inner = p.tap(y, x, 0, i9) + (p.tap(y, x, -3, i7) + p.tap(y, x, 3, i7));
        ((p.tap(y, x, -3, i9) + p.tap(y, x, 3, i9)) + fm(p.tap(y, x, 0, i7), 8.0, inner + inner))
          * 0.0625
      } else {
        let (ny, fy) = if row == 0 { (1, -2) } else { (-1, 2) };
        if m.is_multiple_of(2) {
          let (i9, i20) = if m == 2 || m == 8 { (2, -1) } else { (-2, 1) };
          let t = (p.tap(y, x, fy, i20) + p.tap(y, x, ny, i9)) * 4.0;
          return fm(p.tap(y, x, ny, i20), 6.0, fm(p.tap(y, x, fy, i9), 2.0, t)) * 0.0625;
        }
        let inner = p.tap(y, x, fy, 0) + (p.tap(y, x, ny, -3) + p.tap(y, x, ny, 3));
        ((p.tap(y, x, fy, -3) + p.tap(y, x, fy, 3)) + fm(p.tap(y, x, ny, 0), 8.0, inner + inner))
          * 0.0625
      }
    };
    while x < c1 && mode(x) != if row == 1 { 3 } else { row * 3 } {
      out[y * w + x] = scalar(x);
      x += 1;
    }
    let end = x + (c1 - x) / 3 * 3;
    while x < end {
      if row == 1 {
        let sum = p.tap(y, x, -3, 1) + p.tap(y, x, 3, 1);
        let base = fm(p.tap(y, x, 0, 1), 8.0, sum + sum);
        out[y * w + x] =
          ((p.tap(y, x, 3, -2) + p.tap(y, x, -3, -2)) + fm(p.tap(y, x, 0, -2), 2.0, base)) * 0.0625;
        out[y * w + x + 1] = p.at(y, x + 1);
        out[y * w + x + 2] =
          (fm(p.tap(y, x, 0, 4), 2.0, base) + (p.tap(y, x, -3, 4) + p.tap(y, x, 3, 4))) * 0.0625;
      } else {
        let (ny, fy) = if row == 0 { (1, -2) } else { (-1, 2) };
        let t = (p.tap(y, x, fy, 1) + p.tap(y, x, ny, -2)) * 4.0;
        out[y * w + x] = fm(p.tap(y, x, ny, 1), 6.0, fm(p.tap(y, x, fy, -2), 2.0, t)) * 0.0625;
        let inner = p.tap(y, x, fy, 1) + (p.tap(y, x, ny, -2) + p.tap(y, x, ny, 4));
        out[y * w + x + 1] = ((p.tap(y, x, fy, -2) + p.tap(y, x, fy, 4))
          + fm(p.tap(y, x, ny, 1), 8.0, inner + inner))
          * 0.0625;
        let t = (p.tap(y, x, fy, 1) + p.tap(y, x, ny, 4)) * 4.0;
        out[y * w + x + 2] = fm(p.tap(y, x, ny, 1), 6.0, fm(p.tap(y, x, fy, 4), 2.0, t)) * 0.0625;
      }
      x += 3;
    }
    while x < c1 {
      out[y * w + x] = scalar(x);
      x += 1;
    }
  }
  p.data = out;
}

/// Full-resolution preserved-black camera RGB at the regular-render boundary.
pub(crate) fn develop_preserved_with_lens(
  neg: &Negative,
  neutral: [f64; 3],
  correct_ca: bool,
  cancel: &Cancel,
) -> Result<RgbImage> {
  let mut img = develop_preserved(neg, neutral, cancel)?;
  // The demosaic pipe commits an unsigned-16 image before optional opcodes and
  // regular rendering. Identity CA planes must cross this boundary too.
  img.map_pixels(|p| p.map(|v| super::bayer::tables::normalized(super::bayer::tables::code(v))));
  if correct_ca && let Some(warp) = super::lens::embedded_ca(&neg.meta, neg.meta.fuji_ibis_shift)? {
    return warp.apply_crop(&img, [0, 0, img.height, img.width], cancel);
  }
  Ok(img)
}

fn develop_preserved(neg: &Negative, neutral: [f64; 3], cancel: &Cancel) -> Result<RgbImage> {
  cancel.check()?;
  let meta = &neg.meta;
  if !matches!(meta.model.as_str(), "X-E5" | "X100VI") || meta.bits_per_sample > 16 {
    return Err(Error::Unsupported(format!(
      "Adobe X-Trans: no sensor calibration for {}",
      meta.model
    )));
  }
  let (py, px) = phase_origin(neg)?;
  let black = meta.black_levels.first().copied().unwrap_or(0);
  if meta.black_levels.iter().any(|&b| b != black) {
    return Err(Error::Unsupported(
      "Adobe X-Trans: nonuniform black calibration".into(),
    ));
  }
  let preserve = ((black as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
  let params = Parameters::new(neutral, preserve);
  let lut = linearization_table(black, super::white_level(meta) as f64, meta.bits_per_sample);
  let offset = noise_offset(meta.iso.unwrap_or(100));
  let (w, h) = (meta.crop_width, meta.crop_height);
  let mut img = RgbImage::new(w, h);
  // Parallel strips own disjoint output rows. Each worker keeps only one tile's
  // activity/cleanup buffers, rather than nineteen full-resolution planes.
  img
    .data
    .par_chunks_mut(w * 3 * TILE)
    .enumerate()
    .try_for_each(|(ty, strip)| -> Result<()> {
      let oh = (h - ty * TILE).min(TILE);
      for tx in (0..w).step_by(TILE) {
        cancel.check()?;
        let ow = (w - tx).min(TILE);
        let (tw, th) = (ow + 2 * HALO, oh + 2 * HALO);
        let top = (meta.crop_top + ty * TILE) as isize - HALO as isize;
        let left = (meta.crop_left + tx) as isize - HALO as isize;
        let mut pin = Plane::new(tw, th, 0.0);
        // dng_image::Get(edge_repeat,6,6): repeat the first/last six
        // rows/columns of the active crop, keeping the CFA phase intact.
        let bound = |v: isize, origin: usize, n: usize| -> usize {
          let v = v - origin as isize;
          origin
            + if v < 0 {
              v.rem_euclid(6) as usize
            } else if v >= n as isize {
              n - 1 - (n as isize - 1 - v).rem_euclid(6) as usize
            } else {
              v as usize
            }
        };
        for y in 0..th {
          for x in 0..tw {
            let v = neg.sample(
              bound(top + y as isize, meta.crop_top, h),
              bound(left + x as isize, meta.crop_left, w),
            );
            pin.set(y, x, lut[v as usize]);
          }
        }
        let mut tile = demosaic(&pin, top - py as isize, left - px as isize, &params, offset);
        cleanup::apply(&mut tile, &params);
        for y in 0..oh {
          for x in 0..ow {
            let src = ((y + HALO) * tw + x + HALO) * 3;
            let dst = (y * w + tx + x) * 3;
            strip[dst..dst + 3].copy_from_slice(&tile.data[src..src + 3]);
          }
        }
      }
      Ok(())
    })?;
  Ok(img)
}
