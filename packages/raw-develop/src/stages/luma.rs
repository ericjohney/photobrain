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
//!
//! Each kernel is a per-pixel function (`*_px`). The coarse levels evaluate them over
//! whole planes; the full-resolution ThruG3 level streams them through rolling row
//! windows (`Level0::thru_g3_rolling`), so no full-resolution intermediate is
//! allocated. DIRToC skips its tap gather where a magnitude bound proves the curvature
//! test fails. Both are exact: the output is bit-identical to the whole-plane form.

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
impl Px for [f32; 2] {
  #[inline(always)]
  fn lerp(a: Self, b: Self, t: f32) -> Self {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
}
impl Px for [f32; 4] {
  #[inline(always)]
  fn lerp(a: Self, b: Self, t: f32) -> Self {
    #[cfg(target_arch = "aarch64")]
    {
      // Same subtract, multiply, add sequence as the scalar form (no fused multiply-add),
      // so results are bit-identical; just four lanes at once.
      use std::arch::aarch64::*;
      // SAFETY: NEON is baseline on aarch64; the arrays are 16 bytes of f32.
      unsafe {
        let av = vld1q_f32(a.as_ptr());
        let bv = vld1q_f32(b.as_ptr());
        let r = vaddq_f32(av, vmulq_f32(vsubq_f32(bv, av), vdupq_n_f32(t)));
        let mut o = [0.0f32; 4];
        vst1q_f32(o.as_mut_ptr(), r);
        o
      }
    }
    #[cfg(not(target_arch = "aarch64"))]
    {
      [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
      ]
    }
  }
}

/// Plane in Core Image orientation (row 0 = bottom), clamp-to-edge sampling.
///
/// A plane may hold only a band of rows of a taller image: `d` stores rows
/// `y0 .. y0 + d.len() / w` of an image `h` rows tall, so clamp-to-edge sampling still
/// uses the full image's edges. Full planes have `y0 == 0`. Readers must stay inside the
/// stored band (debug-asserted); the streamed full-resolution level sizes each band's
/// halo from the kernels' reach so they do.
#[derive(Clone)]
pub struct Plane<T> {
  pub w: usize,
  pub h: usize,
  pub d: Vec<T>,
  /// First stored row.
  y0: usize,
  /// Number of stored rows (`d.len() / w`).
  rows: usize,
}

type P1 = Plane<f32>;
type P2 = Plane<[f32; 2]>;
type P4 = Plane<[f32; 4]>;

impl<T> Plane<T> {
  /// A whole `w x h` plane.
  pub fn full(w: usize, h: usize, d: Vec<T>) -> Self {
    assert_eq!(d.len(), w * h);
    Plane { w, h, d, y0: 0, rows: h }
  }
}

impl<T: Px> Plane<T> {
  /// Clamp-to-edge sample. Interior taps (the overwhelming majority) skip the clamps and
  /// bounds checks; the result is identical.
  #[inline(always)]
  fn at(&self, x: isize, y: isize) -> T {
    let ry = (y as usize).wrapping_sub(self.y0);
    if (x as usize) < self.w && ry < self.rows {
      // SAFETY: x < w and ry < rows (negative coordinates wrap to huge usizes and fail
      // the checks), so the index is inside `d`.
      unsafe { *self.d.get_unchecked(ry * self.w + x as usize) }
    } else {
      self.at_edge(x, y)
    }
  }

  /// Clamp-to-edge read of the image. A row outside the stored band (a halo sized too
  /// small) panics on the index rather than reading another row.
  #[inline(never)]
  fn at_edge(&self, x: isize, y: isize) -> T {
    let x = x.clamp(0, self.w as isize - 1) as usize;
    let y = y.clamp(0, self.h as isize - 1) as usize;
    assert!(y >= self.y0 && y - self.y0 < self.rows, "row {y} outside band {}..{}", self.y0, self.y0 + self.rows);
    self.d[(y - self.y0) * self.w + x]
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
    let (xu, yu) = (x0 as usize, y0 as usize);
    // Fast path: both rows and columns inside the stored band. Negative coordinates
    // wrap to huge usizes; the sign checks come first so `+ 1` cannot overflow.
    let ry = yu.wrapping_sub(self.y0);
    let (a, b) = if x0 >= 0 && y0 >= 0 && xu + 1 < self.w && ry < self.rows.saturating_sub(1) {
      let i = ry * self.w + xu;
      // SAFETY: column xu + 1 < w and band rows ry, ry + 1 < rows, so
      // i + w + 1 < d.len().
      let (p00, p10, p01, p11) = unsafe {
        (
          *self.d.get_unchecked(i),
          *self.d.get_unchecked(i + 1),
          *self.d.get_unchecked(i + self.w),
          *self.d.get_unchecked(i + self.w + 1),
        )
      };
      (T::lerp(p00, p10, tx), T::lerp(p01, p11, tx))
    } else {
      (
        T::lerp(self.at_edge(x0, y0), self.at_edge(x0 + 1, y0), tx),
        T::lerp(self.at_edge(x0, y0 + 1), self.at_edge(x0 + 1, y0 + 1), tx),
      )
    };
    T::lerp(a, b, ty)
  }

  /// Build a plane by evaluating `f(x, y)` at integer pixel coordinates.
  fn map<F: Fn(isize, isize) -> T + Sync>(w: usize, h: usize, f: F) -> Self {
    Self::map_rows(w, h, 0..h, f)
  }

  /// Build the band of rows `rows` of a `w x h` image by evaluating `f(x, y)`.
  fn map_rows<F: Fn(isize, isize) -> T + Sync>(
    w: usize,
    h: usize,
    rows: std::ops::Range<usize>,
    f: F,
  ) -> Self {
    let mut d = vec![T::default(); w * rows.len()];
    fill_rows(&mut d, w, rows.start, f);
    Plane { w, h, d, y0: rows.start, rows: rows.len() }
  }
}

/// A plane that is produced in increasing row order and consumed through a sliding
/// window: `extend_to` computes rows up to an end row (each row exactly once) and
/// `retire_before` drops rows no consumer will read again. Reads go through `plane`,
/// whose band is the rows currently held.
struct Rolling<T> {
  plane: Plane<T>,
}

impl<T: Px> Rolling<T> {
  fn new(w: usize, h: usize) -> Self {
    Rolling {
      plane: Plane { w, h, d: Vec::new(), y0: 0, rows: 0 },
    }
  }

  /// One past the last computed row.
  fn end(&self) -> usize {
    self.plane.y0 + self.plane.rows
  }

  /// Compute rows `end() .. min(to, h)` with `f` (parallel over rows).
  fn extend_to<F: Fn(isize, isize) -> T + Sync>(&mut self, to: usize, f: F) {
    let (w, h) = (self.plane.w, self.plane.h);
    let start = self.end();
    let to = to.min(h);
    if to <= start {
      return;
    }
    let old = self.plane.d.len();
    self.plane.d.resize(old + (to - start) * w, T::default());
    fill_rows(&mut self.plane.d[old..], w, start, f);
    self.plane.rows += to - start;
  }

  /// Like `extend_to`, computing whole rows: `f(y, row)` fills image row `y`.
  fn extend_rows_to<F: Fn(usize, &mut [T]) + Sync>(&mut self, to: usize, f: F) {
    let (w, h) = (self.plane.w, self.plane.h);
    let start = self.end();
    let to = to.min(h);
    if to <= start {
      return;
    }
    let old = self.plane.d.len();
    self.plane.d.resize(old + (to - start) * w, T::default());
    self.plane.d[old..].par_chunks_mut(w).enumerate().for_each(|(i, row)| f(start + i, row));
    self.plane.rows += to - start;
  }

  /// Image row `y` as a slice (must be held).
  fn row(&self, y: usize) -> &[T] {
    let p = &self.plane;
    assert!(y >= p.y0 && y - p.y0 < p.rows);
    &p.d[(y - p.y0) * p.w..(y - p.y0 + 1) * p.w]
  }

  /// Drop the rows before `y` (no-op for rows already dropped).
  fn retire_before(&mut self, y: usize) {
    let w = self.plane.w;
    let n = y.saturating_sub(self.plane.y0).min(self.plane.rows);
    if n > 0 {
      self.plane.d.drain(..n * w);
      self.plane.y0 += n;
      self.plane.rows -= n;
    }
  }
}

/// Horizontal box maximum of `.b` over `x - r ..= x + r` (clamped to the row) for one
/// row, folded from 0 like the per-pixel form. `f32::max` is commutative and
/// associative (NaN operands are ignored), so the window is built as element-wise maxima
/// of shifted slices (vectorisable) with an identical result.
fn box_max_row_h(src: &[[f32; 4]], r: usize, out: &mut [f32]) {
  let w = src.len();
  for (o, p) in out.iter_mut().zip(src) {
    *o = 0.0f32.max(p[2]);
  }
  for d in 1..=r.min(w.saturating_sub(1)) {
    // out[x] = max(out[x], src[x + d].b) for x + d < w, and src[x - d].b for x >= d.
    for (o, p) in out[..w - d].iter_mut().zip(&src[d..]) {
      *o = o.max(p[2]);
    }
    for (o, p) in out[d..].iter_mut().zip(&src[..w - d]) {
      *o = o.max(p[2]);
    }
  }
}

/// Fill `out` (whole rows of width `w`, the first being image row `y0`) with `f(x, y)`,
/// in parallel over rows.
fn fill_rows<T: Send, F: Fn(isize, isize) -> T + Sync>(out: &mut [T], w: usize, y0: usize, f: F) {
  out.par_chunks_mut(w).enumerate().for_each(|(i, row)| {
    let y = (y0 + i) as isize;
    for (x, o) in row.iter_mut().enumerate() {
      *o = f(x as isize, y);
    }
  });
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

/// VFToGDIR: (unit direction, magnitude * 0.7) of a vector field.
#[inline(always)]
fn to_gdir(v: [f32; 2]) -> [f32; 4] {
  let mag = len(v) * 0.7;
  let n = norm(v);
  [n[0], n[1], mag, 1.0]
}



/// Reach of DIRToC's taps: offsets up to 8 * |u9| (|u9| <= 1) from the pixel centre,
/// so the bilinear footprints stay within this many pixels on each axis.
const DIR_TO_C_REACH: usize = 9;

/// Maximum of `.b` (the gradient magnitude) over the (2r+1)^2 box around each pixel,
/// with the same clamp-to-edge extension as the sampler.
fn box_max_b(dir: &P4, r: usize) -> P1 {
  let rows = dir.y0..dir.y0 + dir.d.len() / dir.w.max(1);
  box_max_b_rows(dir, r, rows)
}

/// `box_max_b` for rows `rows` of the image, reading `dir` within `rows` ± r (clamped
/// to the image), which must be inside `dir`'s stored band.
fn box_max_b_rows(dir: &P4, r: usize, rows: std::ops::Range<usize>) -> P1 {
  let (w, h) = (dir.w, dir.h);
  let mut horiz = Rolling::<f32>::new(w, h);
  horiz.retire_before(rows.start.saturating_sub(r));
  horiz.plane.y0 = rows.start.saturating_sub(r);
  {
    let dir_row = |y: usize| &dir.d[(y - dir.y0) * w..(y - dir.y0 + 1) * w];
    horiz.extend_rows_to((rows.end + r).min(h), |y, row| box_max_row_h(dir_row(y), r, row));
  }
  let mut out = Rolling::<f32>::new(w, h);
  out.plane.y0 = rows.start;
  out.extend_rows_to(rows.end, |y, row| {
    let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
    row.copy_from_slice(horiz.row(a));
    for yy in a + 1..=b {
      for (o, v) in row.iter_mut().zip(horiz.row(yy)) {
        *o = o.max(*v);
      }
    }
  });
  out.plane
}

/// gaborToYAndVF at one pixel: (Y, vector field along or across the gradient).
#[inline(always)]
fn gabor_y_vf_px(src: &P1, thresh: f32, x: isize, y: isize) -> [f32; 4] {
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
}

/// gaborToVF at one pixel.
#[inline(always)]
fn gabor_vf_px(src: &P1, x: isize, y: isize) -> [f32; 4] {
  let (fx, fy) = gabor_grad(src, x, y);
  [0.0, -fy, fx, 1.0]
}

/// gaborToSYAndG at one pixel: (directionally smoothed Y, gradient magnitude * 0.7). The
/// kernel's band-pass channel is never read by the ThruG2 graph, so it is not computed.
#[inline(always)]
fn gabor_sy_g_px(src: &P1, smooth_amt: f32, x: isize, y: isize) -> [f32; 2] {
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
  [dirblur, mag * 0.7]
}

/// smoothVF followed by VFToGDIR at one pixel: smooth the vector field (in .gb) along
/// its own direction, then return the (unit direction, magnitude * 0.7) form.
#[inline(always)]
fn smooth_vf_gdir_px(img: &P4, x: isize, y: isize) -> [f32; 4] {
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
  to_gdir(v0)
}

/// DIRToC at one pixel: smoothed direction plus a curvature/coherence measure in alpha.
/// `maxmag` (the box maximum of `.b` within `DIR_TO_C_REACH`) enables the exact
/// early-out below; `None` evaluates the kernel in full.
#[inline(always)]
fn dir_to_c_px(dir: &P4, ys: &P1, params: [f32; 3], maxmag: Option<&P1>, x: isize, y: isize) -> [f32; 4] {
  let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
  let sd = dir.at(x, y);
  let yv = ys.at(x, y);
  let thresh = params[0] + params[1] * yv + params[2] * yv * yv;
  // `scaled` below is a sum of 8 terms min(dot(va, v9), dot(vb, v9)).max(0) with
  // |va|, |vb| <= maxmag (each tap's .rg is a bilinear mix of unit-or-zero directions
  // and its .b a bilinear mix of magnitudes inside the reach box) and
  // |v9| = |u9| * sd.b <= sd.b. So scaled <= 50 * 8 * maxmag * sd.b; when that bound
  // (with a margin far above the f32 rounding of the sum) is under the threshold, the
  // kernel's `scaled - thresh < 0` test holds and curvature is 0. The output is then
  // mix(sd, u9, 0) = sd for every finite sd except -0.0 (where the sign of u9 decides
  // the zero's sign), so those rare pixels take the full path.
  let neg_zero = |v: f32| v.to_bits() == 0x8000_0000;
  if maxmag.is_some_and(|mm| 400.0 * mm.at(x, y) * sd[2] * 1.001 < thresh)
    && !neg_zero(sd[0])
    && !neg_zero(sd[1])
  {
    return [sd[0], sd[1], sd[2], 0.0];
  }
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
  // Samples at -8..8 steps along u9. The centre sample (k = 0) is `sd` itself: the
  // bilinear sample at the pixel centre is exact, so the kernel's `at(u9, 0)` returns
  // `sd` without going through the sampler.
  let v9 = [u9[0] * sd[2], u9[1] * sd[2]];
  // `unit` is only used when `scaled >= thresh`, and `scaled` is a sum of
  // non-negative terms (each clamped at 0). Accumulate `scaled` first (the 16 taps
  // along u9, same order as the kernel) and evaluate the `unit` terms from the same
  // samples only when the threshold test can pass. Each term is computed from its
  // tap pair exactly as before, so the accumulated values are identical.
  let mut taps = [([0.0f32; 2], [0.0f32; 2]); 8];
  let mut scaled = 0.0f32;
  for i in 0..8 {
    let k = i as f32 - 8.0;
    let pa = at(u9, k);
    let pb = at(u9, -k);
    let ua = rg(pa);
    let ub = rg(pb);
    let va = [ua[0] * pa[2], ua[1] * pa[2]];
    let vb = [ub[0] * pb[2], ub[1] * pb[2]];
    taps[i] = (ua, ub);
    scaled += dot2(va, v9).min(dot2(vb, v9)).max(0.0);
  }
  let scaled = scaled * 50.0;
  let curvature = if scaled - thresh < 0.0 {
    0.0
  } else {
    let mut unit = 0.0f32;
    for (ua, ub) in taps {
      let e = dot2(ua, u9).min(dot2(ub, u9)).max(0.0);
      let e = e * e;
      let e = e * e;
      unit += e * e;
    }
    (unit * 0.125).clamp(0.0, 1.0)
  };
  let r = mix(sd[0], u9[0], curvature);
  let g = mix(sd[1], u9[1], curvature);
  [r, g, sd[2], curvature]
}

/// annealGAndC at one pixel: propagate the strongest-curvature direction, build the
/// gradient mask.
#[inline(always)]
fn anneal_gc_px(src: &P4, ys: &P1, tm: [f32; 3], cfactor: f32, x: isize, y: isize) -> [f32; 4] {
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
}

/// annealG's mask (its `.b`) at one pixel, from the gradient magnitude `gm` (the `.b` of
/// gaborToSYAndG): the 2x2-averaged magnitude thresholded by the luminance model.
#[inline(always)]
fn anneal_g_px(gm: &P1, ys: &P1, tm: [f32; 3], x: isize, y: isize) -> f32 {
  let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
  let yv = ys.at(x, y);
  let th = tm[0] + tm[1] * yv + tm[2] * yv * yv;
  let lo = th * 0.625;
  let factor = 1.333333 / th;
  let b = gm.s(cx - 0.5, cy + 0.5)
    + gm.s(cx + 0.5, cy + 0.5)
    + gm.s(cx - 0.5, cy - 0.5)
    + gm.s(cx + 0.5, cy - 0.5);
  ((b * b - lo) * factor).clamp(0.0, 1.0)
}

/// smoothDSharpen at one pixel: directional smoothing + high-frequency boost.
/// `anti_bloom` (smoothDSharpenAntiBloom's `parms2.a`) limits the directional blur where
/// the three samples along the edge span more than that range.
#[inline(always)]
fn smooth_d_sharpen_px(
  src: &P1,
  dir: &P4,
  p: [f32; 4],
  p2: [f32; 3],
  anti_bloom: Option<f32>,
  x: isize,
  y: isize,
) -> f32 {
  let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
  let s2 = src.at(x, y);
  let ds = dir.at(x, y);
  let curvature = ds[3];
  // The kernel's final select keeps the centre sample below the curvature cutoff; the
  // eight taps have no other effect, so decide before gathering them.
  if curvature - p[1] < 0.0 {
    return s2;
  }
  let off = [ds[0] * p[0], ds[1] * p[0]];
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
  mix(s2, sm2, blend)
}

/// FGN at one pixel: a clamped high-pass of the detail band sampled 1.2 px apart (3x3
/// taps at ±1.2). The centre tap is the bilinear sample at the pixel centre, which is the
/// pixel itself (fraction 0), so it is read directly.
#[inline(always)]
fn fine_grain_px(d0: &P1, x: isize, y: isize) -> f32 {
  let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
  let t = |dx: f32, dy: f32| d0.s(cx + dx * 1.2, cy + dy * 1.2);
  let b = d0.at(x, y) * 0.859375
    - (t(0.0, -1.0) + t(-1.0, 0.0) + t(1.0, 0.0) + t(0.0, 1.0)) * 0.1171875
    - (t(-1.0, -1.0) + t(1.0, -1.0) + t(-1.0, 1.0) + t(1.0, 1.0)) * 0.09765625;
  b.clamp(-0.015, 0.015)
}

/// expandAndMakeD at one pixel: detail band `src - expand(hsy)`.
#[inline(always)]
fn make_d_px(src: &P1, hsy: &P1, x: isize, y: isize) -> f32 {
  src.at(x, y) - expand(hsy, x, y)
}

/// expandAndMakeD: detail band `src - expand(hsy)`.
fn make_d(src: &P1, hsy: &P1) -> P1 {
  P1::map(src.w, src.h, |x, y| make_d_px(src, hsy, x, y))
}

fn gabor_vf(src: &P1) -> P4 {
  P4::map(src.w, src.h, |x, y| gabor_vf_px(src, x, y))
}

fn smooth_vf_gdir(img: &P4) -> P4 {
  P4::map(img.w, img.h, |x, y| smooth_vf_gdir_px(img, x, y))
}

/// DIRToC over a whole plane, with the exact magnitude-bound early-out.
fn dir_to_c(dir: &P4, ys: &P1, params: [f32; 3]) -> P4 {
  let mm = box_max_b(dir, DIR_TO_C_REACH);
  P4::map(dir.w, dir.h, |x, y| dir_to_c_px(dir, ys, params, Some(&mm), x, y))
}

fn anneal_gc(src: &P4, ys: &P1, tm: [f32; 3], cfactor: f32) -> P4 {
  P4::map(src.w, src.h, |x, y| anneal_gc_px(src, ys, tm, cfactor, x, y))
}

fn smooth_d_sharpen(src: &P1, dir: &P4, p: [f32; 4], p2: [f32; 3], anti_bloom: Option<f32>) -> P1 {
  P1::map(src.w, src.h, |x, y| smooth_d_sharpen_px(src, dir, p, p2, anti_bloom, x, y))
}

/// Direction mask for a pyramid level built from luminance `y` (gaborToVF path).
fn level_mask(y: &P1, l: &LumaLevel) -> P4 {
  let gd = smooth_vf_gdir(&gabor_vf(y));
  let dc = dir_to_c(&gd, y, l.dir_to_c);
  drop(gd);
  anneal_gc(&dc, y, l.anneal, l.cfactor)
}

fn sharpen_chain(d: &P1, mask: &P4, chain: &[Vec<f32>], amount: f32) -> P1 {
  let Some((first, rest)) = chain.split_first() else {
    return d.clone();
  };
  let pass = |src: &P1, c: &Vec<f32>| {
    smooth_d_sharpen(
      src,
      mask,
      [c[0], c[1], c[2], c[3] * amount],
      [c[4], c[5], c[6]],
      c.get(7).copied(),
    )
  };
  let mut cur = pass(d, first);
  for c in rest {
    cur = pass(&cur, c);
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
///
/// The coarse levels (a quarter of the pixels and less) are computed as whole planes.
/// The full-resolution level is streamed in bands of rows (`BAND` output rows each):
/// every intermediate (the Gabor vector field, smoothed direction, DIRToC, the mask, the
/// sharpen chain, FGN) is evaluated only for the band plus the halo of rows its
/// consumers read, so no full-resolution intermediate is ever allocated. Each pixel is
/// computed by the same per-pixel function as the whole-plane form, from identical
/// inputs, so the output is bit-identical; halo rows are recomputed by both neighbouring
/// bands (see `HALO_*`).
pub fn process(y0: P1, recipe: &[LumaLevel], amt: Amounts, cancel: &crate::Cancel) -> crate::Result<P1> {
  let root = &recipe[0];
  let lnr0 = default_lnr(recipe);
  let lnr_scale = if lnr0 > 0.0 { amt.lnr / lnr0 } else { 1.0 };
  let (w, h) = (y0.w, y0.h);

  // Pyramid base: gaborToYAndVF passes Y through unchanged; gaborToSYAndG (ThruG2)
  // replaces it with the directionally smoothed Y, so ThruG2 needs that plane in full
  // for `reduce`. Its gradient magnitude (the only other channel ThruG2 reads) is kept
  // as a one-channel plane.
  let (l0, gmag) = match root.kind {
    LevelKind::ThruG2 => {
      let sa = root.gabor[0];
      let g: P2 = P2::map(w, h, |x, y| gabor_sy_g_px(&y0, sa, x, y));
      let l0 = Plane::full(w, h, g.d.par_iter().map(|p| p[0]).collect());
      let gm = Plane::full(w, h, g.d.par_iter().map(|p| p[1]).collect());
      (l0, Some(gm))
    }
    _ => (y0, None),
  };

  cancel.check()?;
  let mut r = vec![l0];
  for _ in 0..4 {
    let n = reduce(r.last().unwrap());
    r.push(n);
  }
  let d: Vec<P1> = (1..4).map(|k| make_d(&r[k], &r[k + 1])).collect();

  // Coarse to fine through levels 3, 2, 1.
  let mut e = r[4].clone();
  for k in (1..4).rev() {
    cancel.check()?;
    let l = recipe.get(k);
    let (dk, rk) = (&d[k - 1], &r[k]);
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
  drop(d);

  // Full resolution, streamed. `base` is the level-0 luminance, `r1` the first
  // reduction (for the detail band d0 = base - expand(r1)), `e` the rebuilt level 1.
  r.truncate(2);
  let r1 = r.pop().unwrap();
  let base = r.pop().unwrap();
  let mut out = vec![0.0f32; w * h];
  match root.kind {
    LevelKind::ThruG2 => {
      let gm = gmag.expect("gaborToSYAndG magnitude");
      let lvl = Level0 { root, amt, base: &base, r1: &r1, e: &e };
      out.par_chunks_mut(w * BAND).enumerate().for_each(|(b, o)| {
        let rows = b * BAND..(b * BAND + o.len() / w);
        lvl.thru_g2_band(&gm, rows, o);
      });
    }
    _ => {
      let lvl = Level0 { root, amt, base: &base, r1: &r1, e: &e };
      lvl.thru_g3_rolling(&mut out, cancel)?;
    }
  }
  Ok(Plane::full(w, h, out))
}

/// Output rows per full-resolution band (ThruG2, which has no intermediates).
const BAND: usize = 256;

/// Output rows produced per step of the rolling ThruG3 pipeline. Each step computes
/// this many new rows of every stage, in parallel over rows.
const STEP: usize = 128;

/// Halo rows each full-resolution stage reads around the rows it produces, from the
/// kernels' offsets (Core Image rows; a bilinear tap at offset t reads rows floor(t) and
/// floor(t) + 1 around the pixel centre, so a reach of t needs ceil(t) + 1 rows):
/// - smoothDSharpen: taps at `step * a + perp * b` with |a|, |b| <= 1 along a unit
///   direction: |offset| <= step + perp (per-pass, `sharpen_halo`);
/// - annealGAndC: integer 3x3, 1 row;
/// - DIRToC: 8 unit steps along u9 (|u9| <= 1), plus the bilinear footprint;
///   its magnitude bound reads the `.b` box of the same reach;
/// - smoothVF: 2 unit steps along a unit vector, plus the footprint;
/// - FGN: taps at 1.2 * {-1, 0, 1} plus the footprint.
///
/// gaborToYAndVF, expandAndMakeD and expand read whole planes (the level-0 luminance,
/// the first reduction, the rebuilt level 1), so they need no halo.
const HALO_ANNEAL: usize = 1;
const HALO_DIR_TO_C: usize = DIR_TO_C_REACH + 1;
const HALO_SMOOTH_VF: usize = 3;
const HALO_FGN: usize = 3;

/// Rows of halo one smoothDSharpen pass needs around its output rows.
fn sharpen_halo(c: &[f32]) -> usize {
  (c[0].abs() + c[4].abs()).ceil() as usize + 1
}

/// Shared inputs of the streamed full-resolution level.
struct Level0<'a> {
  root: &'a LumaLevel,
  amt: Amounts,
  base: &'a P1,
  r1: &'a P1,
  e: &'a P1,
}

impl Level0<'_> {
  /// expandPlusDThruG3 (+ addFGN) over the whole level, streamed through rolling row
  /// windows. Every intermediate (vector field, smoothed direction, its magnitude box
  /// maximum, DIRToC, the mask, the detail band and each sharpen pass) is computed once
  /// per row, in row order, as soon as its inputs reach the halo its kernel reads, and
  /// dropped once no later stage can read it. Only a few dozen rows of each are alive.
  fn thru_g3_rolling(&self, out: &mut [f32], cancel: &crate::Cancel) -> crate::Result<()> {
    let (root, amt, base) = (self.root, self.amt, self.base);
    let (w, h) = (base.w, base.h);
    let chain = &root.sharpen;
    let n = chain.len();
    let halos: Vec<usize> = chain.iter().map(|c| sharpen_halo(c)).collect();

    let mut vf = Rolling::<[f32; 4]>::new(w, h);
    let mut gd = Rolling::<[f32; 4]>::new(w, h);
    // Box maximum of gd.b: horizontal pass, then vertical over DIR_TO_C_REACH rows.
    let mut mmh = Rolling::<f32>::new(w, h);
    let mut mm = Rolling::<f32>::new(w, h);
    let mut dc = Rolling::<[f32; 4]>::new(w, h);
    let mut mask = Rolling::<[f32; 4]>::new(w, h);
    let mut d0 = Rolling::<f32>::new(w, h);
    // sh[i] is the output of sharpen pass i (its input is d0 for i = 0, sh[i - 1] else).
    let mut sh: Vec<Rolling<f32>> = (0..n).map(|_| Rolling::new(w, h)).collect();
    let mut fgn = Rolling::<f32>::new(w, h);

    let p = root.parms;
    let (ro, om) = (root.roparms, root.omparms);
    let pb = 1.0 - amt.lnr.clamp(0.0, 1.0);
    let sharp = p[1] * amt.sharpness;
    let fg = root.fine_grain;
    let r = DIR_TO_C_REACH;

    let mut y = 0;
    while y < h {
      cancel.check()?;
      let to = (y + STEP).min(h);
      // Rows each stage must have computed so the next output rows `y .. to` can be
      // produced, walking back from the output through each stage's halo.
      let mut need_sh = vec![0usize; n];
      let mut need = to;
      for i in (0..n).rev() {
        need_sh[i] = need;
        need = (need + halos[i]).min(h);
      }
      let need_d0 = need.max((to + HALO_FGN).min(h));
      // The mask is read by every sharpen pass at the rows that pass produces, and by
      // the output; the passes' outputs reach furthest at pass 0.
      let need_mask = need_sh.first().copied().unwrap_or(to).max(to);
      let need_dc = (need_mask + HALO_ANNEAL).min(h);
      let need_mm = need_dc;
      let need_mmh = (need_mm + r).min(h);
      let need_gd = (need_dc + HALO_DIR_TO_C).min(h).max(need_mmh);
      let need_vf = (need_gd + HALO_SMOOTH_VF).min(h);

      vf.extend_to(need_vf, |x, y| gabor_y_vf_px(base, 0.5, x, y));
      gd.extend_to(need_gd, |x, y| smooth_vf_gdir_px(&vf.plane, x, y));
      {
        let g = &gd;
        mmh.extend_rows_to(need_mmh, |y, row| box_max_row_h(g.row(y), r, row));
      }
      {
        let hm = &mmh;
        mm.extend_rows_to(need_mm, |y, row| {
          let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
          row.copy_from_slice(hm.row(a));
          for yy in a + 1..=b {
            for (o, v) in row.iter_mut().zip(hm.row(yy)) {
              *o = o.max(*v);
            }
          }
        });
      }
      {
        let (g, m) = (&gd.plane, &mm.plane);
        dc.extend_to(need_dc, |x, y| dir_to_c_px(g, base, root.dir_to_c, Some(m), x, y));
      }
      {
        let c = &dc.plane;
        mask.extend_to(need_mask, |x, y| anneal_gc_px(c, base, root.anneal, root.cfactor, x, y));
      }
      d0.extend_to(need_d0, |x, y| make_d_px(base, self.r1, x, y));
      for i in 0..n {
        let c = &chain[i];
        let (pp, p2, ab) = ([c[0], c[1], c[2], c[3] * amt.sharpness], [c[4], c[5], c[6]], c.get(7).copied());
        let (before, rest) = sh.split_at_mut(i);
        let src = if i == 0 { &d0.plane } else { &before[i - 1].plane };
        let m = &mask.plane;
        rest[0].extend_to(need_sh[i], |x, y| smooth_d_sharpen_px(src, m, pp, p2, ab, x, y));
      }
      if fg != 0.0 {
        let d = &d0.plane;
        fgn.extend_to(to, |x, y| fine_grain_px(d, x, y));
      }

      // Output rows y .. to.
      {
        let sd = sh.last().map_or(&d0.plane, |s| &s.plane);
        let (d, m, f, hsy) = (&d0.plane, &mask.plane, &fgn.plane, self.e);
        let use_fgn = fg != 0.0;
        fill_rows(&mut out[y * w..to * w], w, y, |x, y| {
          let s = expand(hsy, x, y);
          let dd = d.at(x, y);
          let du = mix(dd, sd.at(x, y), 1.0 - pb);
          let sid = if du < 0.0 { -1.0 } else { 1.0 };
          let adu = du.abs();
          let terp = smoothstep(ro[0], ro[1], adu);
          let mut shd = mix(du, sid * ro[2], terp);
          let cterp = (om[0] * (1.0 - adu * om[1])).max(0.0);
          let dc = du * cterp;
          let saf = p[3] * (p[0] / s - ro[3]).clamp(0.0, 1.0);
          shd *= 1.0 - ((1.0 - sid) * 0.5) * saf;
          let mv = m.at(x, y)[2];
          let mu = mix(1.0, mv, 1.0 - pb);
          let md = mix(dc, du, mu);
          let st = mu * shd * sharp * (1.0 + saf);
          let grain = if use_fgn { f.at(x, y) * fg * (1.0 - mv) } else { 0.0 };
          s + md + st + grain
        });
      }

      // Retire rows that no stage can read again. The next output step starts at `to`;
      // walking the same halos back gives the lowest row each plane will be read at.
      let mut low = to;
      let mut low_sh = vec![0usize; n];
      for i in (0..n).rev() {
        low_sh[i] = low;
        low = low.saturating_sub(halos[i]);
      }
      let low_d0 = low.min(to.saturating_sub(HALO_FGN));
      let low_mask = low_sh.first().copied().unwrap_or(to).min(to);
      let low_dc = low_mask.saturating_sub(HALO_ANNEAL);
      let low_mm = low_dc;
      let low_mmh = low_mm.saturating_sub(r);
      let low_gd = low_dc.saturating_sub(HALO_DIR_TO_C).min(low_mmh);
      let low_vf = low_gd.saturating_sub(HALO_SMOOTH_VF);
      for i in 0..n {
        // Pass i's output is read by pass i + 1 (or the output) from low_sh[i] - halo.
        let reader_low = if i + 1 < n { low_sh[i + 1].saturating_sub(halos[i + 1]) } else { to };
        sh[i].retire_before(reader_low);
      }
      d0.retire_before(low_d0);
      mask.retire_before(low_mask);
      dc.retire_before(low_dc);
      mm.retire_before(low_mm);
      mmh.retire_before(low_mmh);
      gd.retire_before(low_gd);
      vf.retire_before(low_vf);
      fgn.retire_before(to);
      y = to;
    }
    Ok(())
  }

  /// expandPlusDThruG2 for output `rows`, written to `out` (row-parallel caller).
  fn thru_g2_band(&self, gm: &P1, rows: std::ops::Range<usize>, out: &mut [f32]) {
    let (root, amt, base, w) = (self.root, self.amt, self.base, self.base.w);
    let (ro, om) = (root.roparms, root.omparms);
    let p = root.parms;
    let sharp = p[0] * amt.sharpness;
    let hsy = self.e;
    let (r1, tm) = (self.r1, root.anneal);
    for (i, row) in out.chunks_mut(w).enumerate() {
      let y = (rows.start + i) as isize;
      for (xu, o) in row.iter_mut().enumerate() {
        let x = xu as isize;
        let s = expand(hsy, x, y);
        let dd = make_d_px(base, r1, x, y);
        let sid = if dd < 0.0 { -1.0 } else { 1.0 };
        let ad = dd.abs();
        let terp = smoothstep(ro[0], ro[1], ad);
        let mut shd = mix(dd, sid * ro[2], terp);
        let saf = p[1] * (p[2] / s - p[3]).clamp(0.0, 1.0);
        shd *= 1.0 - ((1.0 - sid) * 0.5) * saf;
        let cterp = (om[0] * (1.0 - ad * om[1])).max(0.0);
        let dc = dd * cterp;
        let m = anneal_g_px(gm, base, tm, x, y);
        let md = mix(dc, dd, m);
        let st = m * shd * sharp * (1.0 + saf);
        *o = s + md + st;
      }
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
  fn dir_to_c_bound_skip_is_exact() {
    // A noisy, partly structured luminance plane through the real direction chain.
    let (w, h) = (61usize, 47usize);
    let mut seed = 7u32;
    let src = P1::map(w, h, |x, y| {
      let mut seed = seed;
      seed = seed.wrapping_mul(1664525).wrapping_add(1013904223) ^ (x as u32 * 31 + y as u32);
      let n = (seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5;
      0.2 + if x > 30 { 0.05 } else { 0.0 } + n * 0.004
    });
    let gd = smooth_vf_gdir(&gabor_vf(&src));
    let maxmag = box_max_b(&gd, DIR_TO_C_REACH);
    let (mut skipped, mut curved) = (0, 0);
    for params in [[-1.09e-7, 0.00177, 0.00687], [1e-6, 0.0, 0.0], [0.0, 0.0, 0.0]] {
      let fast = dir_to_c(&gd, &src, params);
      let full = P4::map(w, h, |x, y| dir_to_c_px(&gd, &src, params, None, x, y));
      for (i, (a, b)) in fast.d.iter().zip(&full.d).enumerate() {
        assert_eq!(a.map(f32::to_bits), b.map(f32::to_bits));
        let yv = src.d[i];
        let thresh = params[0] + params[1] * yv + params[2] * yv * yv;
        skipped += (400.0 * maxmag.d[i] * gd.d[i][2] * 1.001 < thresh) as usize;
        curved += (b[3] > 0.0) as usize;
      }
    }
    // Both the bound-skipped path and the full path must be exercised.
    assert!(skipped > 100 && curved > 100, "skipped {skipped}, curved {curved}");
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
      src,
      &recipe,
      Amounts {
        lnr: 0.05,
        sharpness: 1.0,
      },
      &crate::Cancel::never(),
    )
    .unwrap();
    for v in out.d {
      assert!((v - 0.25).abs() < 1e-4, "{v}");
    }
  }
}
