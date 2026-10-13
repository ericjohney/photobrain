//! Noise reduction and sharpening for DNG LinearRaw (Apple ProRAW): a port of the
//! RawCamera "8.dng" detail graph.
//!
//! Input is the linearised camera RGB scaled by the exposure gain `g = 2^BaselineExposure`
//! (the same image RawCamera feeds these kernels). Every parameter is a constant of the
//! graph or a multiple of `g`, so no per-camera data is needed (verified on 16 iPhone
//! 16/17 Pro Max files, ISO 16-6400):
//!
//! 1. `extractY`: Y = g * (0.1495, 0.2935, 0.057) . rgb; channel 0 holds signed_sqrt(Y).
//! 2. `gaborFiltersToSmoothedLuminanceAndGradient`: a 5x5 gradient (direction + magnitude),
//!    a directional blur of Y along the edge, sqrt again, and a clamped band-pass `b`.
//! 3. A 4-level Laplacian pyramid of sqrt-luminance (`reduce` 5x5, `expandAndMakeDetails`,
//!    `expandAndAddDetailsWithOverdrive` with overdrive 0.1 at the coarse levels).
//! 4. `blurGradient` turns the gradient magnitude into an edge mask; the finest level
//!    (`expandAndAddDetailsThroughGradientMask2`, sharpen = detail amount * 2) amplifies
//!    detail only on edges.
//! 5. `powerBlurFS`: a fused half-resolution chroma average in sqrt space
//!    (threshold 0.00988841, neutral factors g/2).
//! 6. `YAndRGBGather`: chroma from 5 with the processed luminance (squared back).
//!
//! Planes use Core Image orientation (row 0 = bottom) like `stages::luma`.
#![allow(clippy::too_many_arguments)]

use crate::image::RgbImage;
use rayon::prelude::*;

const NY: [f32; 3] = [0.1495, 0.2935, 0.057];
const LUM: [f32; 3] = [0.299, 0.587, 0.114];

#[derive(Clone)]
struct Plane<T> {
  w: usize,
  h: usize,
  d: Vec<T>,
}

impl<T: Copy + Default + Send + Sync> Plane<T> {
  fn map<F: Fn(isize, isize) -> T + Sync>(w: usize, h: usize, f: F) -> Self {
    let mut d = vec![T::default(); w * h];
    d.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
      for (x, o) in row.iter_mut().enumerate() {
        *o = f(x as isize, y as isize);
      }
    });
    Plane { w, h, d }
  }
  #[inline(always)]
  fn at(&self, x: isize, y: isize) -> T {
    let x = x.clamp(0, self.w as isize - 1) as usize;
    let y = y.clamp(0, self.h as isize - 1) as usize;
    self.d[y * self.w + x]
  }
}

impl Plane<f32> {
  /// Bilinear sample at a continuous coordinate (pixel centres at i + 0.5).
  #[inline(always)]
  fn s(&self, x: f32, y: f32) -> f32 {
    let (fx, fy) = (x - 0.5, y - 0.5);
    let (x0, y0) = (fx.floor(), fy.floor());
    let (tx, ty) = (fx - x0, fy - y0);
    let (x0, y0) = (x0 as isize, y0 as isize);
    let a = self.at(x0, y0) + (self.at(x0 + 1, y0) - self.at(x0, y0)) * tx;
    let b = self.at(x0, y0 + 1) + (self.at(x0 + 1, y0 + 1) - self.at(x0, y0 + 1)) * tx;
    a + (b - a) * ty
  }
}

#[inline(always)]
fn ssqrt(x: f32) -> f32 {
  x.signum() * x.abs().sqrt()
}

/// extractY + gaborFiltersToSmoothedLuminanceAndGradient: [dirblur (sqrt), b, mag*0.7].
fn gabor(y: &Plane<f32>, smooth_amt: f32, f1: [f32; 4], f2: [f32; 2]) -> Plane<[f32; 3]> {
  Plane::map(y.w, y.h, |x, yy| {
    // s(dx, dy) with dy > 0 = up (Core Image).
    let s = |dx: isize, dy: isize| ssqrt(y.at(x + dx, yy + dy));
    let (s1, s2, s3, s4, s5) = (s(-2, 2), s(-1, 2), s(0, 2), s(1, 2), s(2, 2));
    let (s6, s7, s8, s9, s10) = (s(-2, 1), s(-1, 1), s(0, 1), s(1, 1), s(2, 1));
    let (s11, s12, s13, s14, s15) = (s(-2, 0), s(-1, 0), s(0, 0), s(1, 0), s(2, 0));
    let (s16, s17, s18, s19, s20) = (s(-2, -1), s(-1, -1), s(0, -1), s(1, -1), s(2, -1));
    let (s21, s22, s23, s24, s25) = (s(-2, -2), s(-1, -2), s(0, -2), s(1, -2), s(2, -2));
    let (d2, d3, d4) = (s2 - s24, s3 - s23, s4 - s22);
    let (d6, d7, d8, d9, d10) = (s6 - s20, s7 - s19, s8 - s18, s9 - s17, s10 - s16);
    let (d11, d12) = (s11 - s15, s12 - s14);
    let mut fx = -0.54470 * d12 - 0.17643 * (d7 - d9) - 0.04445 * d11 - 0.01801 * (d6 - d10) - 0.00900 * (d2 - d4);
    let mut fy = 0.54470 * d8 + 0.17643 * (d7 + d9) + 0.04445 * d3 + 0.01801 * (d2 + d4) + 0.00900 * (d6 + d10);
    let mag = (fx * fx + fy * fy).sqrt();
    let mut tmp = ((fx.abs() + fy.abs()) * 16.0).min(1.0);
    tmp *= tmp;
    let inv = 1.0 / mag.max(0.000001);
    fx *= inv;
    fy *= inv;
    // .g of the source is linear Y; sampled at offsets along the edge (bilinear).
    let (cx, cy) = (x as f32 + 0.5, yy as f32 + 0.5);
    let ya = y.s(cx - fy, cy + fx);
    let yb = y.s(cx + fy, cy - fx);
    let y0 = y.at(x, yy);
    let db = y0 * 0.5 + (ya + yb) * 0.25;
    let db = ssqrt(y0 + (db - y0) * tmp * smooth_amt);
    let b = s13 * f1[0]
      + (s8 + s12 + s14 + s18) * f1[1]
      + (s7 + s9 + s17 + s19) * f1[2]
      + (s3 + s11 + s15 + s23) * f1[3]
      + (s2 + s4 + s6 + s10 + s16 + s20 + s22 + s24) * f2[0]
      + (s1 + s5 + s21 + s25) * f2[1];
    [db, b.clamp(-0.015, 0.015), mag * 0.7]
  })
}

/// 5x5 reduce (the DNG graph's variant).
fn reduce(src: &Plane<f32>) -> Plane<f32> {
  let (w, h) = (src.w.div_ceil(2), src.h.div_ceil(2));
  Plane::map(w, h, |x, y| {
    let (px, py) = (2 * x, 2 * y);
    let s = |dx: isize, dy: isize| src.at(px + dx, py + dy);
    let s1 = s(-2, 2) + s(2, 2) + s(-2, -2) + s(2, -2);
    let s2 = s(-1, 2) + s(1, 2) + s(-2, 1) + s(2, 1) + s(-2, -1) + s(2, -1) + s(-1, -2) + s(1, -2);
    let s3 = s(0, 2) + s(-2, 0) + s(2, 0) + s(0, -2);
    let s4 = s(-1, 1) + s(1, 1) + s(-1, -1) + s(1, -1);
    let s5 = s(0, 1) + s(-1, 0) + s(1, 0) + s(0, -1);
    s(0, 0) * 0.140625 + s5 * 0.09375 + s4 * 0.0625 + s3 * 0.0234375 + s2 * 0.015625 + s1 * 0.00390625
  })
}

/// Bilinear-style 2x expansion used by the DNG detail kernels.
#[inline(always)]
fn expand(hsy: &Plane<f32>, x: isize, y: isize) -> f32 {
  let (jx, jy) = (x.div_euclid(2), y.div_euclid(2));
  let s = |dx: isize, dy: isize| hsy.at(jx + dx, jy + dy);
  let (s1, s2, s3) = (s(-1, 1), s(0, 1), s(1, 1));
  let (s4, s5, s6) = (s(-1, 0), s(0, 0), s(1, 0));
  let (s7, s8, s9) = (s(-1, -1), s(0, -1), s(1, -1));
  match (x.rem_euclid(2), y.rem_euclid(2)) {
    (0, 0) => (s1 + s3 + s7 + s9) * 0.015625 + (s2 + s4 + s6 + s8) * 0.09375 + s5 * 0.5625,
    (1, 0) => (s2 + s3 + s8 + s9) * 0.0625 + (s5 + s6) * 0.375,
    (0, _) => (s1 + s3 + s4 + s6) * 0.0625 + (s2 + s5) * 0.375,
    _ => (s2 + s3 + s5 + s6) * 0.25,
  }
}

fn make_details(src: &Plane<f32>, hsy: &Plane<f32>) -> Plane<f32> {
  Plane::map(src.w, src.h, |x, y| src.at(x, y) - expand(hsy, x, y))
}

/// Parameters derived from the exposure gain and user amounts.
pub struct Params {
  /// 2^BaselineExposure (plus user exposure).
  pub gain: f32,
  /// Chroma NR amount (0.5 = RawCamera default; threshold scales linearly).
  pub chroma: f32,
  /// Detail (sharpening) amount (0.5 = RawCamera's DNG default; sharpen = 2 * detail).
  pub detail: f32,
}

/// Apply in place to `img` (camera RGB times the exposure gain is formed internally;
/// the image is returned unscaled).
pub fn apply(img: &mut RgbImage, p: &Params) {
  let (w, h) = (img.width, img.height);
  if w < 8 || h < 8 {
    return;
  }
  let g = p.gain;
  // extractY (Core Image orientation: row 0 = bottom).
  let im0: &RgbImage = img;
  let y_lin = Plane::map(w, h, |x, cy| {
    let q = im0.px(x as usize, h - 1 - cy as usize);
    g * (NY[0] * q[0] + NY[1] * q[1] + NY[2] * q[2])
  });
  let gab = gabor(&y_lin, 1.0, [0.859375, -0.09375, -0.0625, -0.0234375], [-0.015625, -0.00390625]);
  let l0 = Plane { w, h, d: gab.d.iter().map(|v| v[0]).collect() };
  // Pyramid: reduce three times.
  let r1 = reduce(&l0);
  let r2 = reduce(&r1);
  let r3 = reduce(&r2);
  let d1 = make_details(&r1, &r2);
  let d2 = make_details(&r2, &r3);
  let d0 = make_details(&l0, &r1);
  let od = 1.1;
  let e2 = Plane::map(r2.w, r2.h, |x, y| expand(&r3, x, y) + d2.at(x, y) * od);
  let e1 = Plane::map(r1.w, r1.h, |x, y| expand(&e2, x, y) + d1.at(x, y) * od);
  // blurGradient: mask from the gradient magnitude (2x2 average at half-pixel offsets).
  let mag = Plane { w, h, d: gab.d.iter().map(|v| v[2]).collect::<Vec<f32>>() };
  let (lo, fac) = (0.0143883f32, 57.9174f32);
  let mask = Plane::map(w, h, |x, y| {
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let b = mag.s(cx - 0.5, cy + 0.5) + mag.s(cx + 0.5, cy + 0.5) + mag.s(cx - 0.5, cy - 0.5) + mag.s(cx + 0.5, cy - 0.5);
    ((b - lo) * fac).clamp(0.0, 1.0)
  });
  let (soften, sharpen) = (0.0f32, 2.0 * p.detail);
  let y_out = Plane::map(w, h, |x, y| {
    let f = 1.0 - soften + mask.at(x, y) * (soften + sharpen);
    expand(&e1, x, y) + d0.at(x, y) * f
  });

  // powerBlurFS chroma (sqrt space), on LinearSRGB-tagged camera RGB times g.
  let nf = g * 0.5;
  let t = (0.00988841 * (p.chroma / 0.5)).powi(2);
  let im: &RgbImage = img;
  let src = |cx: f32, cy: f32| -> [f32; 3] {
    let (x, yy) = (cx, h as f32 - cy);
    [0, 1, 2].map(|c| ssqrt(im.sample_bilinear(x, yy, c) * nf))
  };
  let kc: Vec<[f32; 3]> = (0..h)
    .into_par_iter()
    .flat_map_iter(|row| {
      let py = (h - 1 - row) as f32 + 0.5;
      let src = &src;
      (0..w).map(move |x| {
        if p.chroma <= 0.0 {
          let v = im.px(x, row);
          return v.map(|c| c * nf);
        }
        let px = x as f32 + 0.5;
        let cen = (2.0 * (px * 0.5).floor() + 1.0, 2.0 * (py * 0.5).floor() + 1.0);
        let b = (((px - cen.0) * 4.0 + 0.5).floor(), ((py - cen.1) * 4.0 + 0.5).floor());
        let n = |dx: f32, dy: f32| src(cen.0 + dx, cen.1 + dy);
        let (n1, n2, n3, n4) = (n(0.0, 2.0 * b.1), n(b.0, 2.0 * b.1), n(-b.0, b.1), n(0.0, b.1));
        let (n5, n6, n7, n8) = (n(b.0, b.1), n(2.0 * b.0, b.1), n(-b.0, 0.0), n(0.0, 0.0));
        let (n9, n10, n11, n12) = (n(b.0, 0.0), n(2.0 * b.0, 0.0), n(0.0, -b.1), n(b.0, -b.1));
        let blur = |c: [f32; 3], nb: [[f32; 3]; 4]| -> [f32; 3] {
          let mut s = [c[0], c[1], c[2]];
          let mut k = 1.0;
          for v in nb {
            let e = (v[0] - c[0]).powi(2) + (v[1] - c[1]).powi(2) + (v[2] - c[2]).powi(2);
            if e < t {
              for i in 0..3 {
                s[i] += v[i];
              }
              k += 1.0;
            }
          }
          s.map(|v| v / k)
        };
        let p1 = blur(n8, [n4, n7, n9, n11]);
        let p2 = blur(n4, [n1, n3, n5, n8]);
        let p3 = blur(n9, [n5, n8, n10, n12]);
        let p4 = blur(n5, [n2, n4, n6, n9]);
        [0, 1, 2].map(|c| {
          let v = 0.5625 * p1[c] + 0.1875 * (p2[c] + p3[c]) + 0.0625 * p4[c];
          v * v.abs()
        })
      })
    })
    .collect();

  // YAndRGBGather: k * rgbfactors * Y0 / Ycnr with rgbfactors = 2 (k = g/2 * rgb and
  // Y0 = g/2 * luma, Ycnr = g * luma . k, so the output is unscaled camera RGB).
  let lf = LUM.map(|v| v * g);
  img.rows_mut().for_each(|(row, out)| {
    let cy = h - 1 - row;
    for x in 0..w {
      let mut y0 = y_out.d[cy * w + x];
      y0 *= y0.abs();
      let k = kc[row * w + x];
      let mut ycnr = k[0] * lf[0] + k[1] * lf[1] + k[2] * lf[2];
      if ycnr == 0.0 {
        ycnr = 0.0001;
      }
      for c in 0..3 {
        out[x * 3 + c] = k[c] * 2.0 * y0 / ycnr;
      }
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn flat_colour_is_unchanged() {
    let mut im = RgbImage::new(40, 30);
    for p in im.data.chunks_mut(3) {
      p.copy_from_slice(&[0.02, 0.03, 0.025]);
    }
    apply(&mut im, &Params { gain: 4.0, chroma: 0.5, detail: 0.5 });
    for p in im.data.chunks(3) {
      assert!((p[0] - 0.02).abs() < 1e-5 && (p[1] - 0.03).abs() < 1e-5 && (p[2] - 0.025).abs() < 1e-5, "{p:?}");
    }
  }
}
