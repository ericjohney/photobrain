//! X-Trans demosaic: a port of RawCamera's `deXtrans_v8` Core Image kernel.
//!
//! Per output pixel it reads a 7x7 neighbourhood of the raw (black-included, unbalanced)
//! mosaic and, depending on the pixel's position in the 6x6 X-Trans tile:
//!
//! 1. scores four interpolation directions (horizontal, two diagonals, vertical) by the
//!    relative differences of same-colour neighbours along them, and blends the best two
//!    when they are close;
//! 2. computes a sharp, direction-aware interpolation `cs` and a smooth, isotropic one `c`
//!    for all three channels;
//! 3. mixes them by local signal-to-noise: the 12-sample neighbourhood variance against
//!    the camera's noise model `rn` (`16 * (rn.y + mean * rn.z)`), so flat noisy areas
//!    use the smooth estimate and textured areas the sharp one;
//! 4. builds red/blue from a soft colour estimate plus the green Laplacian (sharpening
//!    0.75), with special handling for neutral areas and fine "high-frequency" patterns.
//!
//! The output is black-subtracted, scaled by `range` and clipped to 1 (i.e. unbalanced
//! camera RGB with the white level at 1.0).
//!
//! The per-phase case tables below are a mechanical translation of the kernel source and
//! keep its sample names (O = centre, N = one row up, NNE = two up one right, ...).
#![allow(
  non_snake_case,
  clippy::too_many_arguments,
  clippy::excessive_precision
)]

use crate::cfa::{CfaPattern, Channel};
use crate::image::RgbImage;
use rayon::prelude::*;

#[derive(Clone, Copy, Debug, Default)]
struct V4 {
  x: f32,
  y: f32,
  z: f32,
  w: f32,
}

#[inline(always)]
fn vec4(x: f32, y: f32, z: f32, w: f32) -> V4 {
  V4 { x, y, z, w }
}
#[inline(always)]
fn dot(a: V4, b: V4) -> f32 {
  a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
}
#[inline(always)]
fn mix(a: f32, b: f32, t: f32) -> f32 {
  a + (b - a) * t
}
#[inline(always)]
fn mix4(a: V4, b: V4, t: f32) -> V4 {
  vec4(
    mix(a.x, b.x, t),
    mix(a.y, b.y, t),
    mix(a.z, b.z, t),
    mix(a.w, b.w, t),
  )
}
#[inline(always)]
fn min(a: f32, b: f32) -> f32 {
  a.min(b)
}
#[inline(always)]
fn max(a: f32, b: f32) -> f32 {
  a.max(b)
}
#[inline(always)]
fn abs(a: f32) -> f32 {
  a.abs()
}
/// GLSL sign: 0 at 0.
#[inline(always)]
fn sign(a: f32) -> f32 {
  if a > 0.0 {
    1.0
  } else if a < 0.0 {
    -1.0
  } else {
    0.0
  }
}
#[inline(always)]
fn sd1(a: f32, b: f32) -> f32 {
  abs(a - b) / (a + b)
}
#[inline(always)]
fn sd2(a: f32, b: f32, c: f32) -> f32 {
  sd1(a, b) + sd1(b, c)
}
#[inline(always)]
fn sd3(a: f32, b: f32, c: f32, d: f32) -> f32 {
  sd1(a, b) + sd1(b, c) + sd1(c, d)
}
#[inline(always)]
fn sd4(a: f32, b: f32, c: f32, d: f32, e: f32) -> f32 {
  sd1(a, b) + sd1(b, c) + sd1(c, d) + sd1(d, e)
}
#[inline(always)]
fn sgneql_eps(eps: f32, a: f32, b: f32) -> f32 {
  if a * b >= -eps { 1.0 } else { 0.0 }
}
#[inline(always)]
fn ave_var(v: &[f32], black: f32, range: f32) -> (f32, f32) {
  let n = v.len() as f32;
  let avg = v.iter().map(|x| (x - black) * range).sum::<f32>() / n;
  let var = v
    .iter()
    .map(|x| {
      let d = (x - black) * range - avg;
      d * d
    })
    .sum::<f32>()
    / n;
  (avg, var)
}
fn ave_var11(
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  e: f32,
  f: f32,
  g: f32,
  h: f32,
  i: f32,
  j: f32,
  k: f32,
  black: f32,
  range: f32,
) -> (f32, f32) {
  ave_var(&[a, b, c, d, e, f, g, h, i, j, k], black, range)
}
fn ave_var12(
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  e: f32,
  f: f32,
  g: f32,
  h: f32,
  i: f32,
  j: f32,
  k: f32,
  l: f32,
  black: f32,
  range: f32,
) -> (f32, f32) {
  ave_var(&[a, b, c, d, e, f, g, h, i, j, k, l], black, range)
}
fn ave_var13(
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  e: f32,
  f: f32,
  g: f32,
  h: f32,
  i: f32,
  j: f32,
  k: f32,
  l: f32,
  m: f32,
  black: f32,
  range: f32,
) -> (f32, f32) {
  ave_var(&[a, b, c, d, e, f, g, h, i, j, k, l, m], black, range)
}

/// Kernel inputs.
pub struct Params {
  /// Normalised black level (black / 65535).
  pub black: f32,
  /// 65535 / (white - black).
  pub range: f32,
  /// Noise model: variance of a raw value v (in range-scaled units) is ~ rn.y + v * rn.z.
  pub rn: [f32; 3],
  /// Exposure gain applied after the demosaic (gates the noise mixer in deep shadows).
  pub exposure_factor: f32,
  /// White-balance multipliers (camera RGB, green = 1).
  pub wb: [f32; 3],
}

/// Phase of the CFA relative to the tile layout the kernel's case table assumes.
/// Returns (px, py) such that the tile coordinate is (col + px, py - row) mod 6.
pub fn phase(cfa: &CfaPattern) -> Option<(usize, usize)> {
  // Canonical centre colour by (x mod 3, y mod 3), red/blue swapped in the odd 3x3
  // half-tiles of each axis.
  const CANON: [[Channel; 3]; 3] = [
    [Channel::Red, Channel::Blue, Channel::Green],
    [Channel::Green, Channel::Green, Channel::Red],
    [Channel::Green, Channel::Green, Channel::Blue],
  ];
  let canon = |x: usize, y: usize| {
    let c = CANON[y % 3][x % 3];
    let swaps = (x % 6 >= 3) as u8 + (y % 6 >= 3) as u8;
    match (c, swaps % 2) {
      (Channel::Red, 1) => Channel::Blue,
      (Channel::Blue, 1) => Channel::Red,
      (c, _) => c,
    }
  };
  if !cfa.is_xtrans() {
    return None;
  }
  for py in 0..6 {
    for px in 0..6 {
      let ok = (0..6)
        .all(|row| (0..6).all(|col| cfa.at(row, col) == canon((col + px) % 6, (py + 6 - row) % 6)));
      if ok {
        return Some((px, py));
      }
    }
  }
  None
}

/// Demosaic the `w x h` region at (`left`, `top`) of the full-readout `mosaic`
/// (`mw x mh`, raw u16). Returns unbalanced camera RGB (white level = 1).
pub fn demosaic(
  mosaic: &[u16],
  mw: usize,
  mh: usize,
  cfa: &CfaPattern,
  (left, top, w, h): (usize, usize, usize, usize),
  prm: &Params,
) -> Option<RgbImage> {
  let (px, py) = phase(cfa)?;
  let black = prm.black;
  let range = prm.range;
  let rn = prm.rn;
  let exposureFactor = prm.exposure_factor;
  let wmax = prm.wb[0].max(prm.wb[1]).max(prm.wb[2]);
  let factors = prm.wb.map(|v| v / wmax * range * 0.5);

  // The kernel reads a 7x7 neighbourhood (offsets within ±3).
  const R: usize = 3;
  assert_eq!(mosaic.len(), mw * mh);
  let mut out = RgbImage::new(w, h);
  out.rows_mut().for_each(|(y, row)| {
    let ry = (top + y) as isize;
    let ty = (py + 6 * (1 + ry as usize / 6) - ry as usize) % 6;
    // Rows ±3 around ry, with the kernel's periodic (one-tile) edge extension, resolved
    // once per output row; dy > 0 is north.
    let rows: [usize; 2 * R + 1] = std::array::from_fn(|i| {
      // rows[R - dy] is the row ry - dy.
      let mut r = ry - R as isize + i as isize;
      if r < 0 {
        r += 6;
      } else if r >= mh as isize {
        r -= 6;
      }
      r as usize * mw
    });
    for x in 0..w {
      let rx = (left + x) as isize;
      let tx = (rx as usize + px) % 6;
      let o = if rx >= R as isize && rx + (R as isize) < mw as isize {
        // Interior columns: no horizontal wrap and every index is in range.
        let s = |dx: isize, dy: isize| -> f32 {
          let c = (rx + dx) as usize;
          let i = rows[(R as isize - dy) as usize] + c;
          // SAFETY: the row base is a valid row start (< mh * mw) and c < mw.
          unsafe { *mosaic.get_unchecked(i) as f32 * (1.0 / 65535.0) }
        };
        pixel(&s, tx, ty, black, range, rn, exposureFactor, factors)
      } else {
        let s = |dx: isize, dy: isize| -> f32 {
          let mut c = rx + dx;
          if c < 0 {
            c += 6;
          } else if c >= mw as isize {
            c -= 6;
          }
          mosaic[rows[(R as isize - dy) as usize] + c as usize] as f32 * (1.0 / 65535.0)
        };
        pixel(&s, tx, ty, black, range, rn, exposureFactor, factors)
      };
      row[x * 3] = o[0];
      row[x * 3 + 1] = o[1];
      row[x * 3 + 2] = o[2];
    }
  });
  Some(out)
}

#[inline(always)]
fn pixel(
  s: &impl Fn(isize, isize) -> f32,
  tx: usize,
  ty: usize,
  black: f32,
  range: f32,
  rn: [f32; 3],
  exposureFactor: f32,
  factors: [f32; 3],
) -> [f32; 3] {
  const HF_EPS: f32 = 0.000001;
  let eps: f32 = 0.0000001;
  let dirMixer: f32 = 1.0;
  let dirMixerCutoff: f32 = 0.2;
  let hfFactor: f32 = 2.0;
  let minVarNeutral: f32 = 0.1;
  let varNeutralMixer: f32 = 0.01;
  let cardinalMixing: f32 = 2.0;
  let sharpen: f32 = 0.75;

  let O = s(0, 0);
  let W = s(-1, 0);
  let E = s(1, 0);
  let N = s(0, 1);
  let S = s(0, -1);
  let NW = s(-1, 1);
  let NE = s(1, 1);
  let SW = s(-1, -1);
  let SE = s(1, -1);
  let WW = s(-2, 0);
  let EE = s(2, 0);
  let NN = s(0, 2);
  let SS = s(0, -2);
  let NNW = s(-1, 2);
  let NNE = s(1, 2);
  let SSW = s(-1, -2);
  let SSE = s(1, -2);
  let WNW = s(-2, 1);
  let ENE = s(2, 1);
  let WSW = s(-2, -1);
  let ESE = s(2, -1);
  let NNWW = s(-2, 2);
  let NNEE = s(2, 2);
  let SSWW = s(-2, -2);
  let SSEE = s(2, -2);
  let WWW = s(-3, 0);
  let EEE = s(3, 0);
  let NNN = s(0, 3);
  let SSS = s(0, -3);
  let SEEE = s(3, -1);
  let NEEE = s(3, 1);
  let SWWW = s(-3, -1);
  let NWWW = s(-3, 1);
  let WSSS = s(-1, -3);
  let ESSS = s(1, -3);
  let WNNN = s(-1, 3);
  let ENNN = s(1, 3);

  let i = ((tx % 3) + 3 * (ty % 3)) as f32;
  let diralt: f32;
  let mut dirvars: V4;
  let ave_var: (f32, f32);
  if i < 0.5 {
    diralt = sgneql_eps(HF_EPS, W * 2.0 - (N + S), E * 2.0 - (NW + SW))
      * sgneql_eps(HF_EPS, W * 2.0 - (NN + SS), O * 2.0 - (NNW + SSW));
    dirvars = vec4(
      (sd1(SS, SSE)
        + sd1(SWWW, WSW)
        + sd1(S, SE)
        + sd1(NWWW, WNW)
        + sd1(N, NE)
        + sd1(NN, NNE)
        + 0.5
          * (sd1(SS, SSWW)
            + sd1(S, WSW)
            + sd1(N, WNW)
            + sd1(NN, NNWW)
            + sd1(NE, NEEE)
            + sd1(SE, SEEE)))
        * 0.11111111,
      (sd4(WSSS, SS, SE, EE, NEEE) + sd3(WSW, W, N, NNE) + sd2(NWWW, NNWW, WNNN)) * 0.11111111,
      (sd1(SSWW, WSW)
        + sd1(WNW, NNWW)
        + sd1(NN, N)
        + sd1(S, SS)
        + sd1(NNE, NE)
        + sd1(SE, SSE)
        + 0.5 * (sd1(NWWW, SWWW) + sd1(WNW, WSW) + sd1(N, S) + sd1(NE, SE) + sd1(NEEE, SEEE)))
        * 0.11764705882352941,
      (sd2(SWWW, SSWW, WSSS) + sd3(SSE, S, W, WNW) + sd4(SEEE, EE, NE, NN, WNNN)) * 0.11111111,
    );
    ave_var = ave_var12(
      WNW, WSW, W, NN, N, S, SS, NNE, NE, SE, SSE, EE, black, range,
    );
  } else if i < 1.5 {
    diralt = sgneql_eps(HF_EPS, E * 2.0 - (N + S), W * 2.0 - (NE + SE))
      * sgneql_eps(HF_EPS, E * 2.0 - (NN + SS), O * 2.0 - (NNE + SSE));
    dirvars = vec4(
      (sd1(SSW, SS)
        + sd1(SW, S)
        + sd1(ESE, SEEE)
        + sd1(NW, N)
        + sd1(ENE, NEEE)
        + sd1(NNW, NN)
        + 0.5
          * (sd1(SS, SSEE)
            + sd1(S, ESE)
            + sd1(N, ENE)
            + sd1(NN, NNEE)
            + sd1(SWWW, SW)
            + sd1(NWWW, NW)))
        * 0.11111111,
      (sd3(SSW, S, E, ENE) + sd2(ESSS, SSEE, SEEE) + sd4(SWWW, WW, NW, NN, ENNN)) * 0.11111111,
      (sd1(SSW, SW)
        + sd1(NW, NNW)
        + sd1(N, NN)
        + sd1(SS, S)
        + sd1(ENE, NNEE)
        + sd1(SSEE, ESE)
        + 0.5 * (sd1(SWWW, NWWW) + sd1(SW, NW) + sd1(N, S) + sd1(ENE, ESE) + sd1(NEEE, SEEE)))
        * 0.11764705882352941,
      (sd4(ESSS, SS, SW, WW, NWWW) + sd3(ESE, E, N, NNW) + sd2(NEEE, NNEE, ENNN)) * 0.11111111,
    );
    ave_var = ave_var12(
      ENE, ESE, E, NN, N, S, SS, NNW, NW, SW, SSW, WW, black, range,
    );
  } else if i < 2.5 {
    diralt = 1.0
      - sgneql_eps(
        HF_EPS,
        O * 4.0 - (NW + NE + SW + SE),
        2.0 * (NN + SS) - 2.0 * (E + W),
      );
    dirvars = vec4(
      (sd1(SSWW, SSW)
        + sd1(SSE, SSEE)
        + sd1(WSW, SW)
        + sd1(SE, ESE)
        + sd1(WNW, NW)
        + sd1(NE, ENE)
        + sd1(NNWW, NNW)
        + sd1(NNE, NNEE)
        + 0.5 * (sd1(SSW, SSE) + sd1(SW, SE) + sd1(NW, NE) + sd1(NNW, NNE)))
        * 0.1,
      (sd3(SSS, SSE, ESE, EEE) + sd4(SSWW, SW, O, NE, NNEE) + sd3(WWW, WNW, NNW, NNN)) * 0.1,
      (sd1(SSWW, WSW)
        + sd1(WNW, NNWW)
        + sd1(SSW, SW)
        + sd1(NW, NNW)
        + sd1(SSE, SE)
        + sd1(NE, NNE)
        + sd1(SSEE, ESE)
        + sd1(ENE, NNEE)
        + 0.5 * (sd1(WNW, WSW) + sd1(NW, SW) + sd1(NE, SE) + sd1(ENE, ESE)))
        * 0.1,
      (sd3(SSS, SSW, WSW, WWW) + sd4(SSEE, SE, O, NW, NNWW) + sd3(EEE, ENE, NNE, NNN)) * 0.1,
    );
    ave_var = ave_var13(
      WNW, WSW, NNW, NW, SW, SSW, O, NNE, NE, SE, SSE, ENE, ESE, black, range,
    );
  } else if i < 3.5 {
    diralt = 1.0 - sgneql_eps(HF_EPS, SW * 2.0 - (O + WW), NW * 2.0 - (WSW + S));
    dirvars = vec4(
      (sd1(SSS, ESSS)
        + sd1(SS, SSE)
        + sd1(WWW, WW)
        + sd1(O, E)
        + sd1(NWWW, WNW)
        + sd1(N, NE)
        + sd1(NNN, ENNN)
        + 0.5 * (sd1(O, WW) + sd1(N, WNW) + sd1(NE, NEEE) + sd1(E, EEE)))
        * 0.11111111,
      (sd3(SSS, SSE, ESE, EEE) + sd4(SSWW, SW, O, NE, NNEE) + sd3(WWW, WNW, NNW, NNN)) * 0.1,
      (sd1(WWW, NWWW)
        + sd1(WW, WNW)
        + sd1(N, O)
        + sd1(SS, SSS)
        + sd1(ESSS, SSE)
        + sd1(E, NE)
        + sd1(EEE, NEEE)
        + 0.5 * (sd1(O, SS) + sd1(E, SSE) + sd1(N, NNN) + sd1(NE, ENNN)))
        * 0.11111111,
      (sd4(ESSS, SS, SW, WW, NWWW) + sd3(ESE, E, N, NNW) + sd2(NEEE, NNEE, ENNN)) * 0.11111111,
    );
    ave_var = ave_var11(WNW, WW, NNW, SW, N, O, SS, NE, E, SSE, ESE, black, range);
  } else if i < 4.5 {
    diralt = 1.0 - sgneql_eps(HF_EPS, SE * 2.0 - (O + EE), NE * 2.0 - (ESE + S));
    dirvars = vec4(
      (sd1(WSSS, SSS)
        + sd1(SSW, SS)
        + sd1(W, O)
        + sd1(EE, EEE)
        + sd1(NW, N)
        + sd1(ENE, NEEE)
        + sd1(WNNN, NNN)
        + 0.5 * (sd1(W, WWW) + sd1(NW, NWWW) + sd1(N, ENE) + sd1(O, EE)))
        * 0.11111111,
      (sd4(WSSS, SS, SE, EE, NEEE) + sd3(WSW, W, N, NNE) + sd2(NWWW, NNWW, WNNN)) * 0.11111111,
      (sd1(WWW, NWWW)
        + sd1(SSW, WSSS)
        + sd1(NW, W)
        + sd1(N, O)
        + sd1(SS, SSS)
        + sd1(ENE, EE)
        + sd1(NEEE, EEE)
        + 0.5 * (sd1(W, SSW) + sd1(O, SS) + sd1(NW, WNNN) + sd1(N, NNN)))
        * 0.11111111,
      (sd3(SSS, SSW, WSW, WWW) + sd4(SSEE, SE, O, NW, NNWW) + sd3(EEE, ENE, NNE, NNN)) * 0.1,
    );
    ave_var = ave_var11(ENE, EE, NNE, SE, N, O, SS, NW, W, SSW, WSW, black, range);
  } else if i < 5.5 {
    diralt = (1.0 - sgneql_eps(HF_EPS, 2.0 * S - WW - EE, 2.0 * O - WSW - ESE))
      * (1.0 - sgneql_eps(HF_EPS, S * 2.0 - (W + E), N * 2.0 - (SW + SE)));
    dirvars = vec4(
      (sd1(SSWW, SSW)
        + sd1(SSE, SSEE)
        + sd1(WW, W)
        + sd1(E, EE)
        + sd1(WNW, NW)
        + sd1(NE, ENE)
        + 0.5 * (sd1(WSSS, ESSS) + sd1(SSW, SSE) + sd1(W, E) + sd1(NW, NE) + sd1(WNNN, ENNN)))
        * 0.11764705882352941,
      (sd2(ESSS, SSEE, SEEE) + sd3(SSW, S, E, ENE) + sd4(SWWW, WW, NW, NN, ENNN)) * 0.11111111,
      (sd1(WW, WNW)
        + sd1(W, NW)
        + sd1(WSSS, SSW)
        + sd1(ESSS, SSE)
        + sd1(E, NE)
        + sd1(EE, ENE)
        + 0.5
          * (sd1(WW, SSWW)
            + sd1(W, SSW)
            + sd1(E, SSE)
            + sd1(EE, SSEE)
            + sd1(NW, WNNN)
            + sd1(NE, ENNN)))
        * 0.11111111,
      (sd2(WSSS, SSWW, SWWW) + sd3(SSE, S, W, WNW) + sd4(SEEE, EE, NE, NN, WNNN)) * 0.11111111,
    );
    ave_var = ave_var12(
      WNW, WW, NW, W, SSW, NN, S, NE, E, SSE, ENE, EE, black, range,
    );
  } else if i < 6.5 {
    diralt = 1.0 - sgneql_eps(HF_EPS, NW * 2.0 - (O + WW), SW * 2.0 - (WNW + N));
    dirvars = vec4(
      (sd1(SSS, ESSS)
        + sd1(SWWW, WSW)
        + sd1(S, SE)
        + sd1(WWW, WW)
        + sd1(O, E)
        + sd1(NN, NNE)
        + sd1(NNN, ENNN)
        + 0.5 * (sd1(S, WSW) + sd1(O, WW) + sd1(E, EEE) + sd1(SE, SEEE)))
        * 0.11111111,
      (sd2(ESSS, SSEE, SEEE) + sd3(SSW, S, E, ENE) + sd4(SWWW, WW, NW, NN, ENNN)) * 0.11111111,
      (sd1(WWW, SWWW)
        + sd1(WW, WSW)
        + sd1(S, O)
        + sd1(NNN, NN)
        + sd1(SE, E)
        + sd1(NNE, ENNN)
        + sd1(EEE, SEEE)
        + 0.5 * (sd1(SE, ESSS) + sd1(S, SSS) + sd1(E, NNE) + sd1(O, NN)))
        * 0.11111111,
      (sd3(SSS, SSW, WSW, WWW) + sd4(SSEE, SE, O, NW, NNWW) + sd3(EEE, ENE, NNE, NNN)) * 0.1,
    );
    ave_var = ave_var11(WSW, WW, SSW, NW, S, O, NN, SE, E, NNE, ENE, black, range);
  } else if i < 7.5 {
    diralt = 1.0 - sgneql_eps(HF_EPS, NE * 2.0 - (O + EE), SE * 2.0 - (ENE + N));
    dirvars = vec4(
      (sd1(WSSS, SSS)
        + sd1(SW, S)
        + sd1(ESE, SEEE)
        + sd1(W, O)
        + sd1(EE, EEE)
        + sd1(NNW, NN)
        + sd1(WNNN, NNN)
        + 0.5 * (sd1(W, WWW) + sd1(SW, SWWW) + sd1(O, EE) + sd1(S, ESE)))
        * 0.11111111,
      (sd3(SSS, SSE, ESE, EEE) + sd4(SSWW, SW, O, NE, NNEE) + sd3(WWW, WNW, NNW, NNN)) * 0.1,
      (sd1(SWWW, WWW)
        + sd1(SW, W)
        + sd1(NNW, WNNN)
        + sd1(NNN, NN)
        + sd1(O, S)
        + sd1(ESE, EE)
        + sd1(EEE, SEEE)
        + 0.5 * (sd1(SW, WSSS) + sd1(W, NNW) + sd1(O, NN) + sd1(S, SSS)))
        * 0.11111111,
      (sd2(WSSS, SSWW, SWWW) + sd3(SSE, S, W, WNW) + sd4(SEEE, EE, NE, NN, WNNN)) * 0.11111111,
    );
    ave_var = ave_var11(ESE, EE, SSE, NE, S, O, NN, SW, W, NNW, WNW, black, range);
  } else {
    diralt = (1.0 - sgneql_eps(HF_EPS, 2.0 * N - WW - EE, 2.0 * O - WNW - ENE))
      * (1.0 - sgneql_eps(HF_EPS, N * 2.0 - (W + E), S * 2.0 - (NW + NE)));
    dirvars = vec4(
      (sd1(WSW, SW)
        + sd1(SE, ESE)
        + sd1(WW, W)
        + sd1(E, EE)
        + sd1(NNWW, NNW)
        + sd1(NNE, NNEE)
        + 0.5 * (sd1(WSSS, ESSS) + sd1(SW, SE) + sd1(W, E) + sd1(NNW, NNE) + sd1(WNNN, ENNN)))
        * 0.11764705882352941,
      (sd4(WSSS, SS, SE, EE, NEEE) + sd3(WSW, W, N, NNE) + sd2(NWWW, NNWW, WNNN)) * 0.11111111,
      (sd1(WW, WSW)
        + sd1(W, SW)
        + sd1(WNNN, NNW)
        + sd1(ENNN, NNE)
        + sd1(E, SE)
        + sd1(EE, ESE)
        + 0.5
          * (sd1(WSSS, SW)
            + sd1(ESSS, SE)
            + sd1(WW, NNWW)
            + sd1(W, NNW)
            + sd1(E, NNE)
            + sd1(EE, NNEE)))
        * 0.11111111,
      (sd4(ESSS, SS, SW, WW, NWWW) + sd3(ESE, E, N, NNW) + sd2(NEEE, NNEE, ENNN)) * 0.11111111,
    );
    ave_var = ave_var12(
      WSW, WW, SW, W, NNW, SS, N, SE, E, NNE, ESE, EE, black, range,
    );
  }

  dirvars.y *= 0.7071067811865475;
  dirvars.w *= 0.7071067811865475;

  let varFromRN = 16.0 * (rn[1] + ave_var.0 * rn[2]);
  let mut mixer = (ave_var.1 / (varFromRN + 0.000001)).clamp(0.0, 1.0);
  mixer *= ((ave_var.0 * exposureFactor - 0.002) * 200.0).clamp(0.0, 1.0);

  let mut dirs = vec4(1., 0., 0., 0.);
  let mut dirvarmin = dirvars.x;
  if dirvars.y < dirvarmin {
    dirvarmin = dirvars.y;
    dirs = vec4(0., 1., 0., 0.);
  }
  if dirvars.z < dirvarmin {
    dirvarmin = dirvars.z;
    dirs = vec4(0., 0., 1., 0.);
  }
  if dirvars.w < dirvarmin {
    dirvarmin = dirvars.w;
    dirs = vec4(0., 0., 0., 1.);
  }
  let mut dirvarmax = dirvars.x;
  if dirvars.y > dirvarmax {
    dirvarmax = dirvars.y;
  }
  if dirvars.z > dirvarmax {
    dirvarmax = dirvars.z;
  }
  if dirvars.w > dirvarmax {
    dirvarmax = dirvars.w;
  }
  let mut dirs3 = vec4(0., 0., 0., 0.);
  let mut dirvarmin2 = dirvarmax;
  if dirvars.x > dirvarmin && dirvars.x < dirvarmin2 {
    dirvarmin2 = dirvars.x;
    dirs3 = vec4(1., 0., 0., 0.);
  }
  if dirvars.y > dirvarmin && dirvars.y < dirvarmin2 {
    dirvarmin2 = dirvars.y;
    dirs3 = vec4(0., 1., 0., 0.);
  }
  if dirvars.z > dirvarmin && dirvars.z < dirvarmin2 {
    dirvarmin2 = dirvars.z;
    dirs3 = vec4(0., 0., 1., 0.);
  }
  if dirvars.w > dirvarmin && dirvars.w < dirvarmin2 {
    dirs3 = vec4(0., 0., 0., 1.);
  }
  let _ = dirvarmin2;

  let cardinalInstability = min(dirvars.x, dirvars.z) / (max(dirvars.x, dirvars.z) + eps);
  let directionInstability = dirvarmin / (dirvarmax + eps);
  let vmixer = (dirMixer * directionInstability - dirMixerCutoff).clamp(0.0, 1.0);
  dirs = mix4(dirs, dirs3, vmixer);

  let isHF = min(dirvars.y, dirvars.w) > hfFactor * max(dirvars.x, dirvars.z);
  if isHF {
    dirs = vec4(diralt, 0., 1. - diralt, 0.);
  }

  let w0: f32 = 187.;
  let w1: f32 = 87.;
  let w2: f32 = 40.;
  let w3: f32 = 9.;
  let w4: f32 = 4.;
  let s12344: f32 = 0.00696362057651;
  let s122: f32 = 0.00598172531232;
  let s1133: f32 = 0.00524116444768;
  let s034444: f32 = 0.0047195837286;
  let s111223334444: f32 = 0.00261365774953;
  let s0112233444: f32 = 0.00212559011481;
  let s0222244444444: f32 = 0.00263109485452;

  let mixoffdiag: f32 = 0.2;
  let rbcorr: f32 = 9.;
  let farth: f32 = 0.1;
  let sharpen3: f32 = 0.13;
  let sj1: f32 = 0.1875;
  let hdw: f32 = 1.;
  let cdw: f32 = 2.;
  let cth = 1.25 / (O + eps);

  let c: V4;
  let cs: V4;
  let (tgN, tgS, tgE, tgW): (f32, f32, f32, f32);
  let (rN, rS, rE, rW): (f32, f32, f32, f32);
  let (bN, bS, bE, bW): (f32, f32, f32, f32);
  if i < 0.5 {
    c = vec4(
      (w0 * O + w3 * WW + w4 * NNW + w4 * ENE + w4 * ESE + w4 * SSW) * s034444,
      (w1 * W
        + w1 * N
        + w1 * S
        + w2 * NE
        + w2 * SE
        + w3 * NN
        + w3 * SS
        + w3 * EE
        + w4 * NNE
        + w4 * SSE
        + w4 * WNW
        + w4 * WSW)
        * s111223334444,
      (w1 * E + w2 * NW + w2 * SW) * s122,
      1.0,
    );

    tgN = N;
    tgS = S;
    tgE = dot(
      vec4(
        EE + sj1 * (NE - NEEE + SE - SEEE),
        (NE + EE + S) * 0.33333333,
        0.5 * (NE + SE),
        (SE + EE + N) * 0.33333333,
      ),
      dirs,
    );
    tgW = W;

    cs = vec4(
      O,
      dot(
        vec4(
          0.75 * (W + 0.25 * hdw * (O - WW)) + 0.25 * (EE + 0.5 * hdw * (E - EEE)),
          (NE + W + S) * 0.33333333 + cdw * (O - c.x) * c.y / (c.x + eps),
          (N + S) * 0.5,
          (W + N + SE) * 0.33333333 + cdw * (O - c.x) * c.y / (c.x + eps),
        ),
        dirs,
      ),
      dot(
        vec4(
          E,
          0.6 * SW + 0.4 * (E + mixoffdiag * sign((NW - E) * (W - SE)) * (O - tgE)),
          if abs(NNN - SSS) / (eps + NNN + SSS) < farth {
            (NNN + SSS) * 0.5
          } else {
            0.5 * E + 0.25 * (NW + SW)
              - sharpen3 * ((2.0 * W - N - S) * 0.7071067811865475 + NE - N + SE - S)
          },
          0.6 * NW + 0.4 * (E + mixoffdiag * sign((E - SW) * (NE - W)) * (O - tgE)),
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w1 * O + w2 * NNW + w3 * ENE + w4 * (WW + ENNN)) * s12344;
    bN = (w1 * NW + w2 * E + w3 * NNN + w4 * (NNEE + SW)) * s12344;
    rS = (w1 * O + w2 * SSW + w3 * ESE + w4 * (ESSS + WW)) * s12344;
    bS = (w1 * SW + w2 * E + w3 * SSS + w4 * (SSEE + NW)) * s12344;
    rE = (w1 * O + w2 * ENE + w2 * ESE) * s122;
    bE = (w0 * E + w3 * EEE + w4 * (NW + NNEE + SSEE + SW)) * s034444;
    rW = (w1 * (WW + O) + w3 * (NNW + SSW)) * s1133;
    bW = (w1 * (NW + SW) + w3 * (WWW + E)) * s1133;
  } else if i < 1.5 {
    c = vec4(
      (w1 * W + w2 * NE + w2 * SE) * s122,
      (w1 * E
        + w1 * N
        + w1 * S
        + w2 * NW
        + w2 * SW
        + w3 * NN
        + w3 * SS
        + w3 * WW
        + w4 * NNW
        + w4 * SSW
        + w4 * ENE
        + w4 * ESE)
        * s111223334444,
      (w0 * O + w3 * EE + w4 * WNW + w4 * WSW + w4 * NNE + w4 * SSE) * s034444,
      1.0,
    );

    tgN = N;
    tgS = S;
    tgE = E;
    tgW = dot(
      vec4(
        WW + sj1 * (NW - NWWW + SW - SWWW),
        (WW + SW + N) * 0.33333333,
        0.5 * (NW + SW),
        (WW + NW + S) * 0.33333333,
      ),
      dirs,
    );

    cs = vec4(
      dot(
        vec4(
          W,
          0.6 * NE + 0.4 * (W + mixoffdiag * sign((W - SE) * (NW - E)) * (O - tgW)),
          if abs(NNN - SSS) / (eps + NNN + SSS) < farth {
            (NNN + SSS) * 0.5
          } else {
            0.5 * W + 0.25 * (NE + SE)
              - sharpen3 * ((2.0 * E - N - S) * 0.7071067811865475 + NW - N + SW - S)
          },
          0.6 * SE + 0.4 * (W + mixoffdiag * sign((NE - W) * (E - SW)) * (O - tgW)),
        ),
        dirs,
      ),
      dot(
        vec4(
          0.75 * (E + 0.25 * hdw * (O - EE)) + 0.25 * (WW + 0.5 * hdw * (W - WWW)),
          (N + E + SW) * 0.33333333 + cdw * (O - c.z) * c.y / (c.z + eps),
          (N + S) * 0.5,
          (S + E + NW) * 0.33333333 + cdw * (O - c.z) * c.y / (c.z + eps),
        ),
        dirs,
      ),
      O,
      1.0,
    );

    rN = (w1 * NE + w2 * W + w3 * NNN + w4 * (NNWW + SE)) * s12344;
    bN = (w1 * O + w2 * NNE + w3 * WNW + w4 * (EE + WNNN)) * s12344;
    rS = (w1 * SE + w2 * W + w3 * SSS + w4 * (SSWW + NE)) * s12344;
    bS = (w1 * O + w2 * SSE + w3 * WSW + w4 * (EE + WSSS)) * s12344;
    rE = (w1 * (NE + SE) + w3 * (EEE + W)) * s1133;
    bE = (w1 * (O + EE) + w3 * (NNE + SSE)) * s1133;
    rW = (w0 * W + w3 * WWW + w4 * (NNWW + NE + SE + SSWW)) * s034444;
    bW = (w1 * O + w2 * (WNW + WSW)) * s122;
  } else if i < 2.5 {
    c = vec4(
      (w1 * N + w1 * S + w3 * EE + w3 * WW) * s1133,
      (w0 * O
        + w2 * NE
        + w2 * SE
        + w2 * NW
        + w2 * SW
        + w4 * NNW
        + w4 * NNE
        + w4 * SSW
        + w4 * SSE
        + w4 * WNW
        + w4 * ENE
        + w4 * WSW
        + w4 * ESE)
        * s0222244444444,
      (w1 * E + w1 * W + w3 * NN + w3 * SS) * s1133,
      1.0,
    );

    tgN = dot(
      vec4(
        0.5 * (NW + NE),
        (NW + O + NNE) * 0.33333333,
        O + sj1 * (NW - SW + NE - SE),
        (NE + NNW + O) * 0.33333333,
      ),
      dirs,
    );
    tgS = dot(
      vec4(
        0.5 * (SE + SW),
        (O + SE + SSW) * 0.33333333,
        O + sj1 * (SW - NW + SE - NE),
        (O + SW + SSE) * 0.33333333,
      ),
      dirs,
    );
    tgE = dot(
      vec4(
        O + sj1 * (NE - NW + SE - SW),
        (O + SE + ENE) * 0.33333333,
        0.5 * (SE + NE),
        (O + NE + ESE) * 0.33333333,
      ),
      dirs,
    );
    tgW = dot(
      vec4(
        O + sj1 * (NW - NE + SW - SE),
        (NW + O + WSW) * 0.33333333,
        0.5 * (NW + SW),
        (SW + O + WNW) * 0.33333333,
      ),
      dirs,
    );

    cs = vec4(
      dot(
        vec4(
          (WW + EE) * 0.5,
          0.5 * (S + N + mixoffdiag * (O - tgN + O - tgS)),
          (N + S) * 0.5,
          0.5 * (S + N + mixoffdiag * (O - tgN + O - tgS)),
        ),
        dirs,
      ),
      O,
      dot(
        vec4(
          (W + E) * 0.5,
          0.5 * (W + E + mixoffdiag * (O - tgW + O - tgE)),
          (NN + SS) * 0.5,
          0.5 * (W + E + mixoffdiag * (O - tgW + O - tgE)),
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w0 * N + w3 * S + w4 * (WW + EE + WNNN + ENNN)) * s034444;
    bN = (w1 * NN + w2 * (W + E)) * s122;
    rS = (w0 * S + w3 * N + w4 * (WW + EE + WSSS + ESSS)) * s034444;
    bS = (w1 * SS + w2 * (W + E)) * s122;
    rE = (w1 * EE + w2 * (N + S)) * s122;
    bE = (w0 * E + w3 * W + w4 * (NN + SS + NEEE + SEEE)) * s034444;
    rW = (w1 * WW + w2 * (N + S)) * s122;
    bW = (w0 * W + w3 * E + w4 * (NWWW + SWWW + SS + NN)) * s034444;
  } else if i < 3.5 {
    c = vec4(
      (w1 * S + w2 * NW + w3 * EE + w4 * WSW + w4 * NNE) * s12344,
      (w0 * O
        + w1 * N
        + w1 * E
        + w2 * NE
        + w2 * SW
        + w3 * WW
        + w3 * SS
        + w4 * NNW
        + w4 * ESE
        + w4 * SSE)
        * s0112233444,
      (w1 * W + w2 * SE + w3 * NN + w4 * ENE + w4 * SSW) * s12344,
      1.0,
    );

    tgN = N;
    tgS = dot(
      vec4(
        0.75 * SW + 0.25 * ESE,
        (SW + SS + E) * 0.33333333,
        0.5 * (O + SS),
        (O + SW + SSE) * 0.33333333,
      ),
      dirs,
    );
    tgE = E;
    tgW = dot(
      vec4(
        0.5 * (WW + O),
        (WW + SW + N) * 0.33333333,
        SW + sj1 * (WW - SSWW + O - SS),
        (SW + O + WNW) * 0.33333333,
      ),
      dirs,
    );

    cs = vec4(
      dot(
        vec4(
          mix(
            EE + (O - E)
              * min(rbcorr * abs(EE - c.x) / (eps + EE + c.x), 1.0)
              * max(0.0, sign((O - E) * (EE - c.x))),
            c.x,
            min(1.0, cth * abs(EEE + NEEE - O - N)),
          ),
          0.6 * S
            + 0.4 * NW
            + mixoffdiag * sign((NW - EE) * (WW - SS)) * (0.6 * (O - tgS) + 0.4 * (SW - WW)),
          S,
          NW,
        ),
        dirs,
      ),
      O,
      dot(
        vec4(
          W,
          0.6 * W
            + 0.4 * SE
            + mixoffdiag * sign((NN - SE) * (WW - SS)) * (0.6 * (O - tgW) + 0.4 * (SW - SS)),
          mix(
            NN + (O - N)
              * min(rbcorr * abs(NN - c.z) / (eps + NN + c.z), 1.0)
              * max(0.0, sign((O - N) * (c.z - NN))),
            c.z,
            min(1.0, cth * abs(NNN + ENNN - O - E)),
          ),
          SE,
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w1 * NW + w2 * NNE + w3 * S + w4 * (WNNN + EE)) * s12344;
    bN = (w1 * NN + w2 * W + w3 * ENE + w4 * (SE + NNWW)) * s12344;
    rS = (w0 * S + w3 * WSW + w4 * (NW + EE + SSEE + WSSS)) * s034444;
    bS = (w1 * SE + w2 * (W + SSW)) * s122;
    rE = (w1 * EE + w2 * S + w3 * NNE + w4 * (NW + SSEE)) * s12344;
    bE = (w1 * SE + w2 * ENE + w3 * W + w4 * (NN + SEEE)) * s12344;
    rW = (w1 * NW + w2 * (WSW + S)) * s122;
    bW = (w0 * W + w3 * SSW + w4 * (SWWW + SE + NNWW + NN)) * s034444;
  } else if i < 4.5 {
    c = vec4(
      (w1 * E + w2 * SW + w3 * NN + w4 * WNW + w4 * SSE) * s12344,
      (w0 * O
        + w1 * N
        + w1 * W
        + w2 * NW
        + w2 * SE
        + w3 * EE
        + w3 * SS
        + w4 * NNE
        + w4 * ENE
        + w4 * SSW)
        * s0112233444,
      (w1 * S + w2 * NE + w3 * WW + w4 * NNW + w4 * ESE) * s12344,
      1.0,
    );

    tgN = N;
    tgS = dot(
      vec4(
        SE + sj1 * (O - EE + SS - SSEE),
        (O + SE + SSW) * 0.33333333,
        0.5 * (O + SS),
        (SE + SS + W) * 0.33333333,
      ),
      dirs,
    );
    tgE = dot(
      vec4(
        0.5 * (O + EE),
        (O + SE + ENE) * 0.33333333,
        SE + sj1 * (O - SS + EE - SSEE),
        (SE + EE + N) * 0.33333333,
      ),
      dirs,
    );
    tgW = W;

    cs = vec4(
      dot(
        vec4(
          E,
          SW,
          mix(
            NN + (O - N)
              * min(rbcorr * abs(NN - c.x) / (eps + NN + c.x), 1.0)
              * max(0.0, sign((O - N) * (c.x - NN))),
            c.x,
            min(1.0, cth * abs(NNN + WNNN - O - W)),
          ),
          0.6 * E
            + 0.4 * SW
            + mixoffdiag * sign((NN - SW) * (EE - SS)) * (0.6 * (O - tgE) + 0.4 * (SE - SS)),
        ),
        dirs,
      ),
      O,
      dot(
        vec4(
          mix(
            WW + (O - W)
              * min(rbcorr * abs(WW - c.z) / (eps + WW + c.z), 1.0)
              * max(0.0, sign((O - W) * (c.z - WW))),
            c.z,
            min(1.0, cth * abs(WWW + NWWW - O - N)),
          ),
          NE,
          S,
          0.6 * S
            + 0.4 * NE
            + mixoffdiag * sign((NE - WW) * (EE - SS)) * (0.6 * (O - tgS) + 0.4 * (SE - EE)),
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w1 * NN + w2 * E + w3 * WNW + w4 * (NNEE + SW)) * s12344;
    bN = (w1 * NE + w2 * NNW + w3 * S + w4 * (WW + ENNN)) * s12344;
    rS = (w1 * SW + w2 * (E + SSE)) * s122;
    bS = (w0 * S + w3 * ESE + w4 * (WW + NE + ESSS + SSWW)) * s034444;
    rE = (w0 * E + w3 * SSE + w4 * (SW + NN + NNEE + SEEE)) * s034444;
    bE = (w1 * NE + w2 * (S + ESE)) * s122;
    rW = (w1 * SW + w2 * WNW + w3 * E + w4 * (NN + SWWW)) * s12344;
    bW = (w1 * WW + w2 * S + w3 * NNW + w4 * (SSWW + NE)) * s12344;
  } else if i < 5.5 {
    c = vec4(
      (w0 * O + w3 * SS + w4 * NNW + w4 * NNE + w4 * WSW + w4 * ESE) * s034444,
      (w1 * W
        + w1 * S
        + w1 * E
        + w2 * NW
        + w2 * NE
        + w3 * WW
        + w3 * EE
        + w3 * NN
        + w4 * WNW
        + w4 * ENE
        + w4 * SSW
        + w4 * SSE)
        * s111223334444,
      (w1 * N + w2 * SW + w2 * SE) * s122,
      1.0,
    );

    tgN = dot(
      vec4(
        0.5 * (NW + NE),
        (NN + NE + W) * 0.33333333,
        NN + sj1 * (NW - WNNN + NE - ENNN),
        (NW + NN + E) * 0.33333333,
      ),
      dirs,
    );
    tgS = S;
    tgE = E;
    tgW = W;

    cs = vec4(
      O,
      dot(
        vec4(
          (E + W) * 0.5,
          (W + S + NE) * 0.33333333 + cdw * (O - c.x) * c.y / (c.x + eps),
          0.75 * (S + 0.25 * hdw * (O - SS)) + 0.25 * (NN + 0.5 * hdw * (N - NNN)),
          (S + E + NW) * 0.33333333 + cdw * (O - c.x) * c.y / (c.x + eps),
        ),
        dirs,
      ),
      dot(
        vec4(
          if abs(WWW - EEE) / (eps + WWW + EEE) < farth {
            (WWW + EEE) * 0.5
          } else {
            0.5 * N + 0.25 * (SW + SE)
              - sharpen3 * ((2.0 * S - E - W) * 0.7071067811865475 + NE - E + NW - W)
          },
          0.6 * SW + 0.4 * (N + mixoffdiag * sign((N - SE) * (NW - S)) * (O - tgN)),
          N,
          0.6 * SE + 0.4 * (N + mixoffdiag * sign((N - SW) * (NE - S)) * (O - tgN)),
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w1 * O + w2 * (NNW + NNE)) * s122;
    bN = (w0 * N + w3 * NNN + w4 * (NNWW + NNEE + SW + SE)) * s034444;
    rS = (w1 * (O + SS) + w3 * (WSW + ESE)) * s1133;
    bS = (w1 * (SW + SE) + w3 * (N + SSS)) * s1133;
    rE = (w1 * O + w2 * ESE + w3 * NNE + w4 * (SS + NEEE)) * s12344;
    bE = (w1 * SE + w2 * N + w3 * EEE + w4 * (SW + NNEE)) * s12344;
    rW = (w1 * O + w2 * WSW + w3 * NNW + w4 * (NWWW + SS)) * s12344;
    bW = (w1 * SW + w2 * N + w3 * WWW + w4 * (NNWW + SE)) * s12344;
  } else if i < 6.5 {
    c = vec4(
      (w1 * W + w2 * NE + w3 * SS + w4 * NNW + w4 * ESE) * s12344,
      (w0 * O
        + w1 * S
        + w1 * E
        + w2 * NW
        + w2 * SE
        + w3 * WW
        + w3 * NN
        + w4 * NNE
        + w4 * WSW
        + w4 * SSW)
        * s0112233444,
      (w1 * N + w2 * SW + w3 * EE + w4 * WNW + w4 * SSE) * s12344,
      1.0,
    );

    tgN = dot(
      vec4(
        NW,
        (NW + O + NNE) * 0.33333333,
        0.5 * (NN + O),
        (NN + NW + E) * 0.33333333,
      ),
      dirs,
    );
    tgS = S;
    tgE = E;
    tgW = dot(
      vec4(
        0.5 * (WW + O),
        (NW + O + WSW) * 0.33333333,
        NW + sj1 * (WW - NNWW + O - NN),
        (WW + NW + S) * 0.33333333,
      ),
      dirs,
    );

    cs = vec4(
      dot(
        vec4(
          W,
          NE,
          mix(
            SS + (O - S)
              * min(rbcorr * abs(SS - c.x) / (eps + SS + c.x), 1.0)
              * max(0.0, sign((O - S) * (c.x - SS))),
            c.x,
            min(1.0, cth * abs(SSS + ESSS - O - E)),
          ),
          0.6 * W
            + 0.4 * NE
            + mixoffdiag * sign((NE - SS) * (NN - WW)) * (0.6 * (O - tgW) + 0.4 * (NW - NN)),
        ),
        dirs,
      ),
      O,
      dot(
        vec4(
          mix(
            EE + (O - E)
              * min(rbcorr * abs(EE - c.z) / (eps + EE + c.z), 1.0)
              * max(0.0, sign((O - E) * (c.z - EE))),
            c.z,
            min(1.0, cth * abs(EEE + SEEE - O - S)),
          ),
          SW,
          N,
          0.6 * N
            + 0.4 * SW
            + mixoffdiag * sign((EE - SW) * (NN - WW)) * (0.6 * (O - tgN) + 0.4 * (NW - WW)),
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w1 * NE + w2 * (NNW + W)) * s122;
    bN = (w0 * N + w3 * WNW + w4 * (NNEE + EE + WNNN + SW)) * s034444;
    rS = (w1 * SS + w2 * W + w3 * ESE + w4 * (SSWW + NE)) * s12344;
    bS = (w1 * SW + w2 * SSE + w3 * N + w4 * (EE + WSSS)) * s12344;
    rE = (w1 * NE + w2 * ESE + w3 * W + w4 * (NEEE + SS)) * s12344;
    bE = (w1 * EE + w2 * N + w3 * SSE + w4 * (SW + NNEE)) * s12344;
    rW = (w0 * W + w3 * NNW + w4 * (NWWW + NE + SS + SSWW)) * s034444;
    bW = (w1 * SW + w2 * (WNW + N)) * s122;
  } else if i < 7.5 {
    c = vec4(
      (w1 * N + w2 * SE + w3 * WW + w4 * SSW + w4 * ENE) * s12344,
      (w0 * O
        + w1 * S
        + w1 * W
        + w2 * NE
        + w2 * SW
        + w3 * EE
        + w3 * NN
        + w4 * NNW
        + w4 * ESE
        + w4 * SSE)
        * s0112233444,
      (w1 * E + w2 * NW + w3 * SS + w4 * WSW + w4 * NNE) * s12344,
      1.0,
    );

    tgN = dot(
      vec4(
        NE + sj1 * (NN - NNEE + O - EE),
        (NN + NE + W) * 0.33333333,
        0.5 * (NN + O),
        (O + NE + NNW) * 0.33333333,
      ),
      dirs,
    );
    tgS = S;
    tgE = dot(
      vec4(
        0.5 * (O + EE),
        (S + NE + EE) * 0.33333333,
        NE + sj1 * (O - NN + EE - NNEE),
        (ESE + O + NE) * 0.33333333,
      ),
      dirs,
    );
    tgW = W;

    cs = vec4(
      dot(
        vec4(
          mix(
            WW + (O - W)
              * min(rbcorr * abs(WW - c.x) / (eps + WW + c.x), 1.0)
              * max(0.0, sign((O - W) * (c.x - WW))),
            c.x,
            min(1.0, cth * abs(WWW + SWWW - O - S)),
          ),
          0.6 * N
            + 0.4 * SE
            + mixoffdiag * sign((WW - SE) * (NN - EE)) * (0.6 * (O - tgN) + 0.4 * (NE - EE)),
          N,
          SE,
        ),
        dirs,
      ),
      O,
      dot(
        vec4(
          E,
          0.6 * E
            + 0.4 * NW
            + mixoffdiag * sign((NW - SS) * (NN - EE)) * (0.6 * (O - tgE) + 0.4 * (NE - NN)),
          mix(
            SS + (O - S)
              * min(rbcorr * abs(SS - c.z) / (eps + SS + c.z), 1.0)
              * max(0.0, sign((O - S) * (c.z - EE))),
            c.z,
            min(1.0, cth * abs(SSS + WSSS - O - SW)),
          ),
          NW,
        ),
        dirs,
      ),
      1.0,
    );

    rN = (w0 * N + w3 * ENE + w4 * (NNWW + WW + ENNN + SE)) * s034444;
    bN = (w1 * NW + w2 * (NNE + E)) * s122;
    rS = (w1 * SE + w2 * SSW + w3 * N + w4 * (WW + ESSS)) * s12344;
    bS = (w1 * SS + w2 * E + w3 * WSW + w4 * (SSEE + NW)) * s12344;
    rE = (w1 * SE + w2 * (N + ENE)) * s122;
    bE = (w0 * E + w3 * NNE + w4 * (NW + NEEE + SS + SSEE)) * s034444;
    rW = (w1 * WW + w2 * N + w3 * SSW + w4 * (NNWW + SE)) * s12344;
    bW = (w1 * NW + w2 * WSW + w3 * E + w4 * (SS + NWWW)) * s12344;
  } else {
    c = vec4(
      (w1 * S + w2 * NW + w2 * NE) * s122,
      (w1 * W
        + w1 * N
        + w1 * E
        + w2 * SW
        + w2 * SE
        + w3 * WW
        + w3 * SS
        + w3 * EE
        + w4 * NNW
        + w4 * NNE
        + w4 * WSW
        + w4 * ESE)
        * s111223334444,
      (w0 * O + w3 * NN + w4 * WNW + w4 * ENE + w4 * SSW + w4 * SSE) * s034444,
      1.0,
    );

    tgN = N;
    tgS = dot(
      vec4(
        0.5 * (SW + SE),
        (SW + SS + E) * 0.33333333,
        0.75 * SS + 0.25 * N,
        (SS + SE + W) * 0.33333333,
      ),
      dirs,
    );
    tgE = E;
    tgW = W;

    cs = vec4(
      dot(
        vec4(
          if abs(WWW - EEE) / (eps + WWW + EEE) < farth {
            (WWW + EEE) * 0.5
          } else {
            0.5 * S + 0.25 * (NW + NE)
              - sharpen3 * ((2.0 * N - E - W) * 0.7071067811865475 + SE - E + SW - W)
          },
          0.6 * NE + 0.4 * (S + mixoffdiag * sign((NW - S) * (N - SE)) * (O - tgS)),
          S,
          0.6 * NW + 0.4 * (S + mixoffdiag * sign((NE - S) * (N - SW)) * (O - tgS)),
        ),
        dirs,
      ),
      dot(
        vec4(
          (E + W) * 0.5,
          (N + E + SW) * 0.33333333 + cdw * (O - c.z) * c.y / (c.z + eps),
          0.75 * (N + 0.25 * hdw * (O - NN)) + 0.25 * (SS + 0.5 * hdw * (S - SSS)),
          (W + N + SE) * 0.33333333 + cdw * (O - c.z) * c.y / (c.z + eps),
        ),
        dirs,
      ),
      O,
      1.0,
    );

    rN = (w1 * (NW + NE) + w3 * (NNN + S)) * s1133;
    bN = (w1 * (NN + O) + w3 * (WNW + ENE)) * s1133;
    rS = (w0 * S + w3 * SSS + w4 * (SSWW + SSEE + NW + NE)) * s034444;
    bS = (w1 * O + w2 * (SSW + SSE)) * s122;
    rE = (w1 * NE + w2 * S + w3 * EEE + w4 * (SSEE + NW)) * s12344;
    bE = (w1 * O + w2 * ENE + w3 * SSE + w4 * (NN + SEEE)) * s12344;
    rW = (w1 * NW + w2 * S + w3 * WWW + w4 * (NE + SSWW)) * s12344;
    bW = (w1 * O + w2 * WNW + w3 * SSW + w4 * (NN + SWWW)) * s12344;
  }

  let mut c = c;
  let mut cs = cs;
  let mut rbsoft = [
    0.2 * (c.x + rN + rS + rE + rW),
    0.2 * (c.z + bN + bS + bE + bW),
  ];
  let gsharpsoft = 0.25 * (tgN + tgS + tgE + tgW);
  let lapG = cs.y - gsharpsoft;

  let swap = (tx >= 3) as u8 + (ty >= 3) as u8;
  if swap % 2 == 1 {
    rbsoft.swap(0, 1);
    std::mem::swap(&mut c.x, &mut c.z);
    std::mem::swap(&mut cs.x, &mut cs.z);
  }

  let cmixed = mix4(c, cs, mixer);
  let soft = c;
  let ck = [cs.x - black, cs.y - black, cs.z - black];
  let vc = {
    let (a, b, d) = (ck[0] * factors[0], ck[1] * factors[1], ck[2] * factors[2]);
    let m = (a + b + d) / 3.0;
    ((a - m) * (a - m) + (b - m) * (b - m) + (d - m) * (d - m)) / 3.0
  };

  c.x = rbsoft[0] + sharpen * lapG;
  c.z = rbsoft[1] + sharpen * lapG;
  c.y = cmixed.y;
  let k = min(1., cardinalMixing * cardinalInstability);
  c.x = mix(cmixed.x, c.x, k);
  c.z = mix(cmixed.z, c.z, k);

  if vc < 0.0001 * minVarNeutral {
    let drb = [abs(cs.x - soft.x), abs(cs.z - soft.z)];
    c.x = mix(
      c.x,
      cmixed.x,
      min(1.0, drb[0] * varNeutralMixer / (vc + eps)),
    );
    c.z = mix(
      c.z,
      cmixed.z,
      min(1.0, drb[1] * varNeutralMixer / (vc + eps)),
    );
  }
  if isHF {
    c.x = cmixed.x;
    c.z = cmixed.z;
  }
  [c.x, c.y, c.z].map(|v| ((v - black).max(0.0) * range).min(1.0))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn xe5_layout_matches_rawcamera_phase() {
    // RawCamera uses phase [3, -3] for the X-E5 (5196-row readout): py = 5192 mod 6.
    assert_eq!(phase(&CfaPattern::xtrans_default()), Some((3, 2)));
  }

  #[test]
  fn flat_grey_is_exact() {
    let (w, h) = (24usize, 24usize);
    let cfa = CfaPattern::xtrans_default();
    let black = 1000u16;
    let v = 5000u16;
    let mosaic = vec![v; w * h];
    let prm = Params {
      black: black as f32 / 65535.0,
      range: 65535.0 / 15000.0,
      rn: [0.28, 1.3e-8, 5.2e-5],
      exposure_factor: 2.0,
      wb: [2.0, 1.0, 1.8],
    };
    let img = demosaic(&mosaic, w, h, &cfa, (0, 0, w, h), &prm).unwrap();
    let want = (v - black) as f32 / 15000.0;
    for p in img.data.chunks(3) {
      for &c in p {
        // RawCamera's normalisation constants are not exact reciprocals of the weight
        // sums (e.g. s12344 = 1/143.6 for weights summing to 144): within 1%.
        assert!((c / want - 1.0).abs() < 0.01, "{p:?} vs {want}");
      }
    }
  }
}
