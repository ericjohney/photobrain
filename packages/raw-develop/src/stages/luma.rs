//! Luminance noise reduction and sharpening: a port of RawCamera's luma pyramid.
//!
//! The luminance plane (a weighted sum of the unbalanced demosaiced channels) is split
//! into a 5-level Laplacian pyramid (`reduce` / `expandAndMakeD`). It is then rebuilt
//! from coarse to fine; each level adds its detail band back through one of:
//!
//! - `plain` (`expandPlusDWithOverdrive`): unchanged detail;
//! - `thru_g` (`expandPlusDThruG`): detail is shrunk ("coring") except where a gradient
//!   mask says there is real structure. The mask comes from a direction field: Gabor
//!   gradients -> smoothed vector field -> direction/curvature (`DIRToC`) -> annealed
//!   gradient-and-curvature mask (`annealGAndC`), thresholded by a per-ISO noise model;
//! - at full resolution, `thru_g3` (`expandPlusDThruG3`), which also adds back a
//!   directionally sharpened copy of the finest band (`smoothDSharpen` x4) where
//!   structure is found; or, at the lowest ISOs, `thru_g2` (`expandPlusDThruG2`) with a
//!   simpler gradient mask (`gaborToSYAndG` / `annealG`).
//!
//! All kernels are literal translations; planes use Core Image's orientation (row 0 at
//! the bottom) so direction vectors and asymmetric stencils match. Per-ISO recipes are
//! camera-profile data (`[[noise.luma]]`).

use crate::profile::{LevelKind, LumaLevel};
use rayon::prelude::*;

pub trait Px: Copy + Send + Sync + Default {
  fn lerp(a: Self, b: Self, t: f32) -> Self;
}
impl Px for f32 {
  #[inline(always)]
  fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
  }
}
impl Px for [f32; 4] {
  #[inline(always)]
  fn lerp(a: Self, b: Self, t: f32) -> Self {
    [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      a[3] + (b[3] - a[3]) * t,
    ]
  }
}

/// Plane in Core Image orientation (row 0 = bottom), clamp-to-edge sampling.
#[derive(Clone)]
pub struct Plane<T> {
  pub w: usize,
  pub h: usize,
  pub d: Vec<T>,
}

type P1 = Plane<f32>;
type P4 = Plane<[f32; 4]>;

impl<T: Px> Plane<T> {
  #[inline(always)]
  fn at(&self, x: isize, y: isize) -> T {
    let x = x.clamp(0, self.w as isize - 1) as usize;
    let y = y.clamp(0, self.h as isize - 1) as usize;
    self.d[y * self.w + x]
  }

  /// Bilinear sample at a continuous coordinate (pixel centres at i + 0.5).
  #[inline(always)]
  fn s(&self, x: f32, y: f32) -> T {
    let fx = x - 0.5;
    let fy = y - 0.5;
    let x0 = fx.floor();
    let y0 = fy.floor();
    let (tx, ty) = (fx - x0, fy - y0);
    let (x0, y0) = (x0 as isize, y0 as isize);
    let a = T::lerp(self.at(x0, y0), self.at(x0 + 1, y0), tx);
    let b = T::lerp(self.at(x0, y0 + 1), self.at(x0 + 1, y0 + 1), tx);
    T::lerp(a, b, ty)
  }

  /// Build a plane by evaluating `f(x, y)` at integer pixel coordinates.
  fn map<F: Fn(isize, isize) -> T + Sync>(w: usize, h: usize, f: F) -> Self {
    let mut d = vec![T::default(); w * h];
    d.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
      for (x, o) in row.iter_mut().enumerate() {
        *o = f(x as isize, y as isize);
      }
    });
    Plane { w, h, d }
  }
}

impl P4 {
  fn channel(&self, c: usize) -> P1 {
    Plane {
      w: self.w,
      h: self.h,
      d: self.d.iter().map(|p| p[c]).collect(),
    }
  }
}

#[inline(always)]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
  t * t * (3.0 - 2.0 * t)
}
#[inline(always)]
fn mix(a: f32, b: f32, t: f32) -> f32 {
  a + (b - a) * t
}
#[inline(always)]
fn len(v: [f32; 2]) -> f32 {
  (v[0] * v[0] + v[1] * v[1]).sqrt()
}
#[inline(always)]
fn norm(v: [f32; 2]) -> [f32; 2] {
  let l = len(v);
  if l > 0.0 {
    [v[0] / l, v[1] / l]
  } else {
    [0.0, 0.0]
  }
}
#[inline(always)]
fn dot2(a: [f32; 2], b: [f32; 2]) -> f32 {
  a[0] * b[0] + a[1] * b[1]
}
#[inline(always)]
fn gb(p: [f32; 4]) -> [f32; 2] {
  [p[1], p[2]]
}
#[inline(always)]
fn rg(p: [f32; 4]) -> [f32; 2] {
  [p[0], p[1]]
}

/// Gabor-like gradient (fx, fy) from the 5x5 neighbourhood of integer samples.
#[inline(always)]
fn gabor_grad(src: &P1, x: isize, y: isize) -> (f32, f32) {
  let s = |dx: isize, dy: isize| src.at(x + dx, y + dy);
  let d2 = s(-1, 2) - s(1, -2);
  let d3 = s(0, 2) - s(0, -2);
  let d4 = s(1, 2) - s(-1, -2);
  let d6 = s(-2, 1) - s(2, -1);
  let d7 = s(-1, 1) - s(1, -1);
  let d8 = s(0, 1) - s(0, -1);
  let d9 = s(1, 1) - s(-1, -1);
  let d10 = s(2, 1) - s(-2, -1);
  let d11 = s(-2, 0) - s(2, 0);
  let d12 = s(-1, 0) - s(1, 0);
  let fx = -0.54470 * d12
    - 0.17643 * (d7 - d9)
    - 0.04445 * d11
    - 0.01801 * (d6 - d10)
    - 0.00900 * (d2 - d4);
  let fy =
    0.54470 * d8 + 0.17643 * (d7 + d9) + 0.04445 * d3 + 0.01801 * (d2 + d4) + 0.00900 * (d6 + d10);
  (fx, fy)
}

/// gaborToYAndVF: (Y, vector field along or across the gradient).
fn gabor_y_vf(src: &P1, thresh: f32) -> P4 {
  P4::map(src.w, src.h, |x, y| {
    let (fx, fy) = gabor_grad(src, x, y);
    let s13 = src.at(x, y);
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let across = [fx, fy];
    let along = [-fy, fx];
    let mag = (fx * fx + fy * fy).sqrt();
    let d1 = (src.s(cx + along[0], cy + along[1]) - s13).abs();
    let d2 = (src.s(cx - along[0], cy - along[1]) - s13).abs();
    let d3 = (src.s(cx + 2.0 * along[0], cy + 2.0 * along[1]) - s13).abs();
    let d4 = (src.s(cx - 2.0 * along[0], cy - 2.0 * along[1]) - s13).abs();
    let d_along = d1.max(d2).max(d3).max(d4);
    let dv = if thresh * mag - d_along < 0.0 {
      across
    } else {
      along
    };
    [s13, dv[0], dv[1], 1.0]
  })
}

/// gaborToVF.
fn gabor_vf(src: &P1) -> P4 {
  P4::map(src.w, src.h, |x, y| {
    let (fx, fy) = gabor_grad(src, x, y);
    [0.0, -fy, fx, 1.0]
  })
}

/// gaborToSYAndG: (directionally smoothed Y, band-pass, gradient magnitude * 0.7).
fn gabor_sy_g(src: &P1, smooth_amt: f32, f1: [f32; 4], f2: [f32; 2]) -> P4 {
  P4::map(src.w, src.h, |x, y| {
    let s = |dx: isize, dy: isize| src.at(x + dx, y + dy);
    let (mut fx, mut fy) = gabor_grad(src, x, y);
    let mag = (fx * fx + fy * fy).sqrt();
    let tmp = ((fx.abs() + fy.abs()) * 16.0).min(1.0);
    let tmp = tmp * tmp;
    let inv = 1.0 / mag.max(0.000001);
    fx *= inv;
    fy *= inv;
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let ya = src.s(cx - fy, cy + fx);
    let yb = src.s(cx + fy, cy - fx);
    let yc = s(0, 0);
    let dirblur = mix(yc, yc * 0.5 + (ya + yb) * 0.25, tmp * smooth_amt);
    let b = s(0, 0) * f1[0]
      + (s(0, 1) + s(-1, 0) + s(1, 0) + s(0, -1)) * f1[1]
      + (s(-1, 1) + s(1, 1) + s(-1, -1) + s(1, -1)) * f1[2]
      + (s(0, 2) + s(-2, 0) + s(2, 0) + s(0, -2)) * f1[3]
      + (s(-1, 2) + s(1, 2) + s(-2, 1) + s(2, 1) + s(-2, -1) + s(2, -1) + s(-1, -2) + s(1, -2))
        * f2[0]
      + (s(-2, 2) + s(2, 2) + s(-2, -2) + s(2, -2)) * f2[1];
    [dirblur, b.clamp(-0.015, 0.015), mag * 0.7, 1.0]
  })
}

/// reduce: 2x downsample (3x3 taps at +-1.2 px).
fn reduce(src: &P1) -> P1 {
  let (w, h) = (src.w.div_ceil(2), src.h.div_ceil(2));
  P1::map(w, h, |x, y| {
    let lx = (x as f32 + 0.5) * 2.0 - 0.5;
    let ly = (y as f32 + 0.5) * 2.0 - 0.5;
    let s = |dx: f32, dy: f32| src.s(lx + dx * 1.2, ly + dy * 1.2);
    s(0.0, 0.0) * 0.140625
      + (s(0.0, -1.0) + s(-1.0, 0.0) + s(1.0, 0.0) + s(0.0, 1.0)) * 0.1171875
      + (s(-1.0, -1.0) + s(1.0, -1.0) + s(-1.0, 1.0) + s(1.0, 1.0)) * 0.09765625
  })
}

/// 2x expand of `hsy` at fine pixel (x, y).
#[inline(always)]
fn expand(hsy: &P1, x: isize, y: isize) -> f32 {
  let (jx, jy) = (x.div_euclid(2), y.div_euclid(2));
  let s = |dx: isize, dy: isize| hsy.at(jx + dx, jy + dy);
  let ex = x.rem_euclid(2) == 0;
  let ey = y.rem_euclid(2) == 0;
  match (ex, ey) {
    (true, true) => s(0, 0),
    (false, true) => (s(0, 0) + s(1, 0)) * 0.54271 - (s(-1, 0) + s(2, 0)) * 0.04271,
    (true, false) => (s(0, 0) + s(0, 1)) * 0.54271 - (s(0, -1) + s(0, 2)) * 0.04271,
    (false, false) => {
      (s(0, 0) + s(1, 0) + s(0, 1) + s(1, 1)) * 0.29453
        - (s(0, -1) + s(1, -1) + s(-1, 0) + s(2, 0) + s(-1, 1) + s(2, 1) + s(0, 2) + s(1, 2))
          * 0.02318
        + (s(-1, -1) + s(2, -1) + s(-1, 2) + s(2, 2)) * 0.00182
    }
  }
}

/// expandAndMakeD: detail band `src - expand(hsy)`.
fn make_d(src: &P1, hsy: &P1) -> P1 {
  P1::map(src.w, src.h, |x, y| src.at(x, y) - expand(hsy, x, y))
}

/// smoothVF: smooth the vector field (in .gb) along its own direction.
fn smooth_vf(img: &P4) -> P4 {
  P4::map(img.w, img.h, |x, y| {
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let at = |o: [f32; 2], k: f32| gb(img.s(cx + o[0] * k, cy + o[1] * k));
    let v4 = gb(img.at(x, y));
    let mut u4 = norm(v4);
    let u3 = norm(at(u4, -1.0));
    let u5 = norm(at(u4, 1.0));
    u4 = norm([u3[0] + 2.0 * u4[0] + u5[0], u3[1] + 2.0 * u4[1] + u5[1]]);
    let v2 = at(u4, -2.0);
    let v3 = at(u4, -1.0);
    let v5 = at(u4, 1.0);
    let v6 = at(u4, 2.0);
    let mut v0 = [v4[0] + (v3[0] + v5[0]) * 0.5, v4[1] + (v3[1] + v5[1]) * 0.5];
    let k1 = norm([v5[0] + v6[0], v5[1] + v6[1]]);
    let k2 = norm([v2[0] + v3[0], v2[1] + v3[1]]);
    let v02 = if dot2([k1[0] - k2[0], k1[1] - k2[1]], u4) < 0.0 {
      [(v2[0] + v3[0]) * 0.5, (v2[1] + v3[1]) * 0.5]
    } else {
      [(v5[0] + v6[0]) * 0.5, (v5[1] + v6[1]) * 0.5]
    };
    if dot2(k1, k2) - 0.1 < 0.0 {
      v0 = v02;
    }
    let l1 = len(v0);
    let l2 = len(v4);
    let f = l2 / l1.max(0.001);
    v0 = [v0[0] * f, v0[1] * f];
    if dot2(v0, v4) < 0.0 {
      v0 = [-v0[0], -v0[1]];
    }
    let n = norm(v0);
    let np = [-n[1], n[0]];
    let va = at(np, -1.0);
    let vb = at(np, 1.0);
    let ua = norm(va);
    let ub = norm(vb);
    let mag = len(va).max(len(vb));
    if len([ua[0] + ub[0], ua[1] + ub[1]]) - 0.8 < 0.0 {
      v0 = [mag * n[0], mag * n[1]];
    }
    [0.0, v0[0], v0[1], 1.0]
  })
}

/// VFToGDIR: (unit direction, magnitude * 0.7).
fn vf_to_gdir(img: &P4) -> P4 {
  Plane {
    w: img.w,
    h: img.h,
    d: img
      .d
      .par_iter()
      .map(|p| {
        let v = gb(*p);
        let mag = len(v) * 0.7;
        let n = norm(v);
        [n[0], n[1], mag, 1.0]
      })
      .collect(),
  }
}

/// DIRToC: smoothed direction plus a curvature/coherence measure in alpha.
fn dir_to_c(dir: &P4, ys: &P1, params: [f32; 3]) -> P4 {
  P4::map(dir.w, dir.h, |x, y| {
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let sd = dir.at(x, y);
    let yv = ys.at(x, y);
    let at = |t: [f32; 2], k: f32| dir.s(cx + t[0] * k, cy + t[1] * k);
    let mut u9 = rg(sd);
    let (u8, u10) = (rg(at(u9, -1.0)), rg(at(u9, 1.0)));
    u9 = norm([
      u9[0] * 0.5 + (u8[0] + u10[0]) * 0.25,
      u9[1] * 0.5 + (u8[1] + u10[1]) * 0.25,
    ]);
    let (u7, u8, u10, u11) = (
      rg(at(u9, -2.0)),
      rg(at(u9, -1.0)),
      rg(at(u9, 1.0)),
      rg(at(u9, 2.0)),
    );
    u9 = norm([
      u9[0] * 0.375 + (u8[0] + u10[0]) * 0.25 + (u7[0] + u11[0]) * 0.0625,
      u9[1] * 0.375 + (u8[1] + u10[1]) * 0.25 + (u7[1] + u11[1]) * 0.0625,
    ]);
    // Samples at -8..8 steps along u9.
    let mut u = [[0.0f32; 2]; 17];
    let mut v = [[0.0f32; 2]; 17];
    for (i, k) in (-8..=8).enumerate() {
      let p = at(u9, k as f32);
      let ui = if k == 0 { u9 } else { rg(p) };
      u[i] = ui;
      v[i] = [ui[0] * p[2], ui[1] * p[2]];
    }
    let v9 = v[8];
    let mut unit = 0.0f32;
    let mut scaled = 0.0f32;
    for i in 0..8 {
      let j = 16 - i;
      let e = dot2(u[i], u9).min(dot2(u[j], u9)).max(0.0);
      let e = e * e;
      let e = e * e;
      unit += e * e;
      scaled += dot2(v[i], v9).min(dot2(v[j], v9)).max(0.0);
    }
    let unit = unit * 0.125;
    let scaled = scaled * 50.0;
    let thresh = params[0] + params[1] * yv + params[2] * yv * yv;
    let curvature = (if scaled - thresh < 0.0 { 0.0 } else { unit }).clamp(0.0, 1.0);
    let r = mix(sd[0], u9[0], curvature);
    let g = mix(sd[1], u9[1], curvature);
    [r, g, sd[2], curvature]
  })
}

/// annealGAndC: propagate the strongest-curvature direction, build the gradient mask.
fn anneal_gc(src: &P4, ys: &P1, tm: [f32; 3], cfactor: f32) -> P4 {
  P4::map(src.w, src.h, |x, y| {
    let yv = ys.at(x, y);
    let th = tm[0] + tm[1] * yv + tm[2] * yv * yv;
    let lo = th * 0.625;
    let factor = 1.333333 / th;
    let s = |dx: isize, dy: isize| src.at(x + dx, y + dy);
    let n = [
      s(-1, 1),
      s(0, 1),
      s(1, 1),
      s(-1, 0),
      s(0, 0),
      s(1, 0),
      s(-1, -1),
      s(0, -1),
      s(1, -1),
    ];
    let mut ss = n[4];
    for (i, p) in n.iter().enumerate() {
      if i != 4 && p[3] - ss[3].max(0.5) >= 0.0 {
        ss = *p;
      }
    }
    let blur = |c: usize| {
      n[4][c] * 0.25
        + (n[1][c] + n[3][c] + n[5][c] + n[7][c]) * 0.125
        + (n[0][c] + n[2][c] + n[6][c] + n[8][c]) * 0.0625
    };
    let g = blur(2);
    let g = ((g * g - lo) * factor).clamp(0.0, 1.0);
    let c = (blur(3) * cfactor).clamp(0.0, 1.0);
    [ss[0], ss[1], g.max(c), ss[3]]
  })
}

/// annealG: gradient mask from the 2x2-averaged magnitude.
fn anneal_g(src: &P4, ys: &P1, tm: [f32; 3]) -> P4 {
  P4::map(src.w, src.h, |x, y| {
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let yv = ys.at(x, y);
    let th = tm[0] + tm[1] * yv + tm[2] * yv * yv;
    let lo = th * 0.625;
    let factor = 1.333333 / th;
    let mut c = src.at(x, y);
    let b = src.s(cx - 0.5, cy + 0.5)[2]
      + src.s(cx + 0.5, cy + 0.5)[2]
      + src.s(cx - 0.5, cy - 0.5)[2]
      + src.s(cx + 0.5, cy - 0.5)[2];
    c[2] = ((b * b - lo) * factor).clamp(0.0, 1.0);
    c
  })
}

/// smoothDSharpen: one pass of directional smoothing + high-frequency boost.
/// `anti_bloom` (smoothDSharpenAntiBloom's `parms2.a`) limits the directional blur where
/// the three samples along the edge span more than that range.
fn smooth_d_sharpen(src: &P1, dir: &P4, p: [f32; 4], p2: [f32; 3], anti_bloom: Option<f32>) -> P1 {
  P1::map(src.w, src.h, |x, y| {
    let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
    let s2 = src.at(x, y);
    let ds = dir.at(x, y);
    let off = [ds[0] * p[0], ds[1] * p[0]];
    let curvature = ds[3];
    let perp = [ds[1] * p2[0], -ds[0] * p2[0]];
    let at = |a: f32, b: f32| src.s(cx + off[0] * a + perp[0] * b, cy + off[1] * a + perp[1] * b);
    let s1 = at(1.0, 0.0);
    let s3 = at(-1.0, 0.0);
    let s4 = at(1.0, -1.0);
    let s5 = at(0.0, -1.0);
    let s6 = at(-1.0, -1.0);
    let s7 = at(1.0, 1.0);
    let s8 = at(0.0, 1.0);
    let s9 = at(-1.0, 1.0);
    let sm1 = s5 * 0.5 + (s4 + s6) * 0.25;
    let mut sm2 = s2 * 0.5 + (s1 + s3) * 0.25;
    let sm3 = s8 * 0.5 + (s7 + s9) * 0.25;
    let mut hf = (sm2 * 0.5 - (sm1 + sm3) * 0.25) * curvature;
    let sign = if hf < 0.0 { -1.0 } else { 1.0 };
    hf = hf.abs().min(0.005) * sign;
    let lo = sm1.min(sm2).min(sm3);
    let hi = sm1.max(sm2).max(sm3);
    hf *= (0.5 + (hi - lo - p2[1]) * p2[2]).clamp(0.0, 1.0);
    sm2 += hf * p[3];
    let blend = match anti_bloom {
      None => p[2],
      Some(ab) => {
        let lo = s1.min(s2).min(s3);
        let hi = s1.max(s2).max(s3);
        p[2] * (3.0 * (ab - (hi - lo))).clamp(0.0, 1.0)
      }
    };
    let dirblur = mix(s2, sm2, blend);
    if curvature - p[1] < 0.0 { s2 } else { dirblur }
  })
}

/// Direction mask for a pyramid level built from luminance `y` (gaborToVF path).
fn level_mask(y: &P1, l: &LumaLevel) -> P4 {
  let gd = vf_to_gdir(&smooth_vf(&gabor_vf(y)));
  let dc = dir_to_c(&gd, y, l.dir_to_c);
  anneal_gc(&dc, y, l.anneal, l.cfactor)
}

fn sharpen_chain(d: &P1, mask: &P4, chain: &[Vec<f32>], amount: f32) -> P1 {
  let mut cur = d.clone();
  for c in chain {
    cur = smooth_d_sharpen(
      &cur,
      mask,
      [c[0], c[1], c[2], c[3] * amount],
      [c[4], c[5], c[6]],
      c.get(7).copied(),
    );
  }
  cur
}

/// User adjustments relative to the profile recipe.
#[derive(Clone, Copy, Debug)]
pub struct Amounts {
  /// Luminance NR amount (RawCamera's scale). Default: `default_lnr(recipe)`.
  pub lnr: f32,
  /// Sharpness multiplier: 1 = the profile's default for this ISO.
  pub sharpness: f32,
}

/// RawCamera's default luminance NR amount for a recipe.
pub fn default_lnr(recipe: &[LumaLevel]) -> f32 {
  match recipe.first() {
    Some(r) if r.kind == LevelKind::ThruG3 => 1.0 - r.parms[2],
    _ => 0.0,
  }
}

/// Run the luma pyramid on `y0` (Core Image orientation). `recipe[0]` is the full-
/// resolution level, `recipe[1..]` the coarser ones (four reductions in total).
pub fn process(y0: &P1, recipe: &[LumaLevel], amt: Amounts) -> P1 {
  let root = &recipe[0];
  let lnr0 = default_lnr(recipe);
  let lnr_scale = if lnr0 > 0.0 { amt.lnr / lnr0 } else { 1.0 };

  let g = match root.kind {
    LevelKind::ThruG2 => gabor_sy_g(
      y0,
      root.gabor[0],
      [root.gabor[1], root.gabor[2], root.gabor[3], root.gabor[4]],
      [root.gabor[5], root.gabor[6]],
    ),
    _ => gabor_y_vf(y0, 0.5),
  };
  let l0 = g.channel(0);

  let mut r = vec![l0];
  for _ in 0..4 {
    let n = reduce(r.last().unwrap());
    r.push(n);
  }
  let d: Vec<P1> = (0..4).map(|k| make_d(&r[k], &r[k + 1])).collect();

  // Coarse to fine through levels 3, 2, 1.
  let mut e = r[4].clone();
  for k in (1..4).rev() {
    let l = recipe.get(k);
    let (dk, rk) = (&d[k], &r[k]);
    e = match l.map(|l| l.kind) {
      Some(LevelKind::ThruG) => {
        let l = l.unwrap();
        let mask = level_mask(rk, l);
        let sd = if l.sharpen.is_empty() {
          dk.clone()
        } else {
          sharpen_chain(dk, &mask, &l.sharpen, amt.sharpness)
        };
        let pb = (l.parms[2] * lnr_scale).min(1.0);
        let pa = (l.parms[3] * lnr_scale).min(1.0);
        let (ro, om, pg) = (l.roparms, l.omparms, l.parms[1]);
        let hsy = &e;
        P1::map(dk.w, dk.h, |x, y| {
          let s = expand(hsy, x, y);
          let dd = dk.at(x, y);
          let du = mix(dd, sd.at(x, y), pb);
          let sid = if du < 0.0 { -1.0 } else { 1.0 };
          let adu = du.abs();
          let terp = smoothstep(ro[0], ro[1], adu);
          let shd = mix(du, sid * ro[2], terp);
          let cterp = (om[0] * (1.0 - adu * om[1])).max(0.0);
          let dc = du * cterp;
          let m = mask.at(x, y)[2];
          let mu = mix(1.0, m, pa);
          let md = mix(dc, du, mu);
          (s + md + shd * pg).clamp(0.0, 1.0)
        })
      }
      _ => {
        let od = l.map_or(0.0, |l| l.overdrive);
        let hsy = &e;
        P1::map(dk.w, dk.h, |x, y| {
          (expand(hsy, x, y) + dk.at(x, y) * (1.0 + od)).clamp(0.0, 1.0)
        })
      }
    };
  }

  // Full resolution.
  let d0 = &d[0];
  let (ro, om) = (root.roparms, root.omparms);
  let hsy = &e;
  match root.kind {
    LevelKind::ThruG2 => {
      let mask = anneal_g(&g, &r[0], root.anneal);
      let p = root.parms;
      let sharp = p[0] * amt.sharpness;
      P1::map(d0.w, d0.h, |x, y| {
        let s = expand(hsy, x, y);
        let dd = d0.at(x, y);
        let sid = if dd < 0.0 { -1.0 } else { 1.0 };
        let ad = dd.abs();
        let terp = smoothstep(ro[0], ro[1], ad);
        let mut shd = mix(dd, sid * ro[2], terp);
        let saf = p[1] * (p[2] / s - p[3]).clamp(0.0, 1.0);
        shd *= 1.0 - ((1.0 - sid) * 0.5) * saf;
        let cterp = (om[0] * (1.0 - ad * om[1])).max(0.0);
        let dc = dd * cterp;
        let m = mask.at(x, y)[2];
        let md = mix(dc, dd, m);
        let st = m * shd * sharp * (1.0 + saf);
        s + md + st
      })
    }
    _ => {
      let gd = vf_to_gdir(&smooth_vf(&g));
      let dc = dir_to_c(&gd, &r[0], root.dir_to_c);
      let mask = anneal_gc(&dc, &r[0], root.anneal, root.cfactor);
      let sd = sharpen_chain(d0, &mask, &root.sharpen, amt.sharpness);
      let p = root.parms;
      let pb = 1.0 - amt.lnr.clamp(0.0, 1.0);
      let sharp = p[1] * amt.sharpness;
      // FGN: a clamped high-pass of the full-resolution detail band, sampled 1.2 px
      // apart, added back by addFGN outside the structure mask.
      let fgn = (root.fine_grain != 0.0).then(|| {
        P1::map(d0.w, d0.h, |x, y| {
          let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
          let t = |dx: f32, dy: f32| d0.s(cx + dx * 1.2, cy + dy * 1.2);
          let b = t(0.0, 0.0) * 0.859375
            - (t(0.0, -1.0) + t(-1.0, 0.0) + t(1.0, 0.0) + t(0.0, 1.0)) * 0.1171875
            - (t(-1.0, -1.0) + t(1.0, -1.0) + t(-1.0, 1.0) + t(1.0, 1.0)) * 0.09765625;
          b.clamp(-0.015, 0.015)
        })
      });
      let fg = root.fine_grain;
      P1::map(d0.w, d0.h, |x, y| {
        let s = expand(hsy, x, y);
        let dd = d0.at(x, y);
        let du = mix(dd, sd.at(x, y), 1.0 - pb);
        let sid = if du < 0.0 { -1.0 } else { 1.0 };
        let adu = du.abs();
        let terp = smoothstep(ro[0], ro[1], adu);
        let mut shd = mix(du, sid * ro[2], terp);
        let cterp = (om[0] * (1.0 - adu * om[1])).max(0.0);
        let dc = du * cterp;
        let saf = p[3] * (p[0] / s - ro[3]).clamp(0.0, 1.0);
        shd *= 1.0 - ((1.0 - sid) * 0.5) * saf;
        let m = mask.at(x, y)[2];
        let mu = mix(1.0, m, 1.0 - pb);
        let md = mix(dc, du, mu);
        let st = mu * shd * sharp * (1.0 + saf);
        let grain = fgn.as_ref().map_or(0.0, |n| n.at(x, y) * fg * (1.0 - m));
        s + md + st + grain
      })
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pyramid_reconstructs_exactly_without_processing() {
    let (w, h) = (37usize, 23usize);
    let src = P1::map(w, h, |x, y| 0.2 + 0.01 * ((x * 7 + y * 3) % 11) as f32);
    let r1 = reduce(&src);
    let d = make_d(&src, &r1);
    let back = P1::map(w, h, |x, y| expand(&r1, x, y) + d.at(x, y));
    for (a, b) in back.d.iter().zip(&src.d) {
      assert!((a - b).abs() < 1e-6);
    }
  }

  #[test]
  fn flat_plane_is_unchanged() {
    let lvl = |kind| LumaLevel {
      kind,
      overdrive: 0.0,
      parms: [0.00171713, 1.0, 0.95, 1.0],
      roparms: [0.00278, 0.00835, 0.00556, 0.142857],
      omparms: [0.499, 3.603],
      dir_to_c: [-1e-7, 0.0018, 0.0069],
      anneal: [1.4e-9, 1.1e-5, 4.2e-5],
      cfactor: 7.0,
      sharpen: vec![vec![1.0, 0.0, 0.3, 0.381, 1.0, 0.0043, 348.8]],
      gabor: vec![],
      fine_grain: 0.0,
    };
    let recipe = vec![
      lvl(LevelKind::ThruG3),
      lvl(LevelKind::ThruG),
      lvl(LevelKind::Plain),
      lvl(LevelKind::Plain),
    ];
    let src = P1::map(40, 30, |_, _| 0.25);
    let out = process(
      &src,
      &recipe,
      Amounts {
        lnr: 0.05,
        sharpness: 1.0,
      },
    );
    for v in out.d {
      assert!((v - 0.25).abs() < 1e-4, "{v}");
    }
  }
}
