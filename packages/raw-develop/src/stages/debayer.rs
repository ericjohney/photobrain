//! Bayer demosaic: ports of RawCamera's `despeckle_v8` and `deBayer_v8` Core Image
//! kernels.
//!
//! `despeckle` clamps isolated hot/cold photosites to the range of their same-colour
//! neighbours (plus a margin set by `amount`); RawCamera stores its output as half floats,
//! which we reproduce.
//!
//! `demosaic` reads a 7x7 neighbourhood per pixel and mixes two estimates:
//! - `cf`, a smooth bilinear-style estimate;
//! - `cs`, a sharp, direction-aware estimate (horizontal/vertical choice by gradients and
//!   Laplacians, colour differences against a directional green, with an outlier-rejecting
//!   average for the diagonal colour),
//!
//! by local signal-to-noise: the neighbourhood variance against the camera's noise model
//! `rn` (`16 * (rn.y + mean * rn.z)`), so flat noisy areas take the smooth estimate. Fine
//! diagonal "high-frequency" patterns switch the direction metric to colour differences.
//! Output is black-subtracted, scaled by `range` and clipped to 1: unbalanced camera RGB
//! with the white level at 1.0.
//!
//! Neighbour names follow the kernel (N is one row up). The kernel computes everything as
//! if the centre's row held blue and swaps red/blue at the end on red rows.
#![allow(non_snake_case, clippy::too_many_arguments)]

use crate::cfa::{CfaPattern, Channel};
use crate::image::RgbImage;
use rayon::prelude::*;

/// Phase (px, py) such that the CFA at (row, col) equals the canonical RGGB pattern at
/// ((col + px) % 2, (row + py) % 2). `None` for non-Bayer patterns.
pub fn phase(cfa: &CfaPattern) -> Option<(usize, usize)> {
  if cfa.width != 2 || cfa.height != 2 {
    return None;
  }
  let canon = |x: usize, y: usize| match (x, y) {
    (0, 0) => Channel::Red,
    (1, 1) => Channel::Blue,
    _ => Channel::Green,
  };
  for py in 0..2 {
    for px in 0..2 {
      if (0..2).all(|r| (0..2).all(|c| cfa.at(r, c) == canon((c + px) % 2, (r + py) % 2))) {
        return Some((px, py));
      }
    }
  }
  None
}

/// Round to the nearest IEEE half float (normal range), as Core Image's `Rh` buffers do.
#[inline]
fn to_half(x: f32) -> f32 {
  let b = x.to_bits();
  f32::from_bits((b + 0x0fff + ((b >> 13) & 1)) & !0x1fff)
}

/// Mosaic view with sample access by (column, row) offset; dy > 0 is north (row - dy).
struct View<'a> {
  data: &'a [f32],
  w: usize,
  h: usize,
}

impl View<'_> {
  /// The kernel's edge rule: coordinates outside the image wrap by the 2-pixel period.
  #[inline(always)]
  fn at(&self, x: isize, y: isize) -> f32 {
    let wrap = |v: isize, n: usize| -> usize {
      if v < 0 {
        v.rem_euclid(2) as usize
      } else if v >= n as isize {
        n - 2 + ((v - n as isize) % 2) as usize
      } else {
        v as usize
      }
    };
    self.data[wrap(y, self.h) * self.w + wrap(x, self.w)]
  }
}

/// despeckle_v8 over the full readout (normalised raw values), returned half-rounded.
pub fn despeckle(raw: &[f32], w: usize, h: usize, cfa: &CfaPattern, amount: f32, neighbor_prevention: f32) -> Vec<f32> {
  let (px, py) = phase(cfa).expect("Bayer CFA");
  let v = View { data: raw, w, h };
  let drange = 1.8 / amount;
  let drange_n = amount * 0.4;
  let range_min = 0.005;
  let mut out = vec![0.0f32; w * h];
  out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
    for (x, o) in row.iter_mut().enumerate() {
      let s = |dx: isize, dy: isize| v.at(x as isize + dx, y as isize - dy);
      let is_g = (x + px + y + py) % 2 == 1;
      let O = s(0, 0);
      let (W, E, N, S) = (s(-1, 0), s(1, 0), s(0, 1), s(0, -1));
      let (WW, EE, NN, SS) = (s(-2, 0), s(2, 0), s(0, 2), s(0, -2));
      let (NNW, NNE, SSW, SSE) = (s(-1, 2), s(1, 2), s(-1, -2), s(1, -2));
      let (WNW, ENE, WSW, ESE) = (s(-2, 1), s(2, 1), s(-2, -1), s(2, -1));
      let (NNWW, NNEE, SSWW, SSEE) = (s(-2, 2), s(2, 2), s(-2, -2), s(2, -2));
      let ring = [NNWW, NN, NNEE, EE, SSEE, SS, SSWW, WW];
      let lo = ring.iter().copied().fold(f32::INFINITY, f32::min);
      let hi = ring.iter().copied().fold(f32::NEG_INFINITY, f32::max);
      let (lon, hin): ([f32; 4], [f32; 4]) = if is_g {
        let lonp = [
          WNW.min(ENE).min(ESE).min(WSW),
          NNW.min(NNE).min(SSW).min(SSE),
        ];
        let hinp = [
          WNW.max(ENE).max(ESE).max(WSW),
          NNW.max(NNE).max(SSW).max(SSE),
        ];
        (
          [S.min(lonp[0]), N.min(lonp[0]), W.min(lonp[1]), E.min(lonp[1])],
          [S.max(hinp[0]), N.max(hinp[0]), W.max(hinp[1]), E.max(hinp[1])],
        )
      } else {
        let k = [NNW, NNE, ENE, ESE, SSE, SSW, WSW, WNW];
        let lonp = k.iter().copied().fold(f32::INFINITY, f32::min);
        let hinp = k.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        ([lonp; 4], [hinp; 4])
      };
      let range = drange * (hi - lo);
      let (hi2, lo2) = (hi + range, lo - range);
      let neighbors = [N, S, E, W];
      let (mut hot, mut cold) = (0.0f32, 0.0f32);
      for i in 0..4 {
        let d = hin[i] - lon[i];
        let rangen = if d - range_min < 0.0 { 999999.0 } else { drange_n * d };
        if neighbors[i] - (hin[i] + rangen) > 0.0 {
          hot += 1.0;
        }
        if (lon[i] - rangen) - neighbors[i] > 0.0 {
          cold += 1.0;
        }
      }
      let hot_r = if O > hi2 && hot < 0.1 { 1.0 } else { neighbor_prevention };
      let cold_r = if O < lo2 && cold < 0.1 { 1.0 } else { neighbor_prevention };
      let mut o2 = O + (O.min(hi2) - O) * hot_r;
      o2 += (o2.max(lo2) - o2) * cold_r;
      *o = to_half(o2);
    }
  });
  out
}

/// Kernel inputs (see `dextrans::Params`).
pub struct Params {
  /// Normalised black level (black / 65535).
  pub black: f32,
  /// 65535 / (white - black).
  pub range: f32,
  pub rn: [f32; 3],
  pub exposure_factor: f32,
}

#[inline(always)]
fn sd1(a: f32, b: f32) -> f32 {
  (a - b).abs() / (a + b)
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
fn dxy(h1: f32, h2: f32, v1: f32, v2: f32) -> [f32; 2] {
  [(h1 - h2) * (h1 - h2) / (h1 + h2), (v1 - v2) * (v1 - v2) / (v1 + v2)]
}
#[inline(always)]
fn mix(a: f32, b: f32, t: f32) -> f32 {
  a + (b - a) * t
}
#[inline(always)]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
  t * t * (3.0 - 2.0 * t)
}
#[inline(always)]
fn gdir(s: f32, b0: f32, bN: f32, bS: f32, bE: f32, bW: f32, bNN: f32, bSS: f32, bEE: f32, bWW: f32) -> f32 {
  let lap_h = 2.0 * b0 - bWW - bEE;
  let lap_v = 2.0 * b0 - bNN - bSS;
  let d_h = (bE - bW).abs() + lap_h.abs();
  let d_v = (bN - bS).abs() + lap_v.abs();
  0.5 * if d_h < d_v {
    (bE + bW) + s * 0.5 * lap_h
  } else {
    (bN + bS) + s * 0.5 * lap_v
  }
}
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

/// Demosaic the `w x h` region at (`left`, `top`) of the despeckled full-readout mosaic
/// (`mw x mh`, normalised). Returns unbalanced camera RGB (white level = 1).
pub fn demosaic(
  src: &[f32],
  mw: usize,
  mh: usize,
  cfa: &CfaPattern,
  (left, top, w, h): (usize, usize, usize, usize),
  prm: &Params,
) -> Option<RgbImage> {
  let (px, py) = phase(cfa)?;
  let v = View { data: src, w: mw, h: mh };
  let mut out = RgbImage::new(w, h);
  out.rows_mut().for_each(|(y, row)| {
    let ry = top + y;
    for x in 0..w {
      let rx = left + x;
      let s = |dx: isize, dy: isize| v.at(rx as isize + dx, ry as isize - dy);
      // Canonical RGGB tile coordinates: (0,0) R, (1,1) B, else G. The kernel's
      // "isRowB" is the blue row.
      let (tx, ty) = ((rx + px) % 2, (ry + py) % 2);
      let is_g = tx != ty;
      let is_row_b = ty == 1;
      let o = pixel(&s, is_g, is_row_b, prm);
      row[x * 3..x * 3 + 3].copy_from_slice(&o);
    }
  });
  Some(out)
}

#[inline(always)]
fn pixel(s: &impl Fn(isize, isize) -> f32, is_g: bool, is_row_b: bool, prm: &Params) -> [f32; 3] {
  const HF_EPSI: f32 = 1.0;
  const HFMAG: f32 = 0.2;
  const SRB: f32 = 0.5;
  const UNSTABLE: f32 = 4000.0;
  let (black, range, rn, ef) = (prm.black, prm.range, prm.rn, prm.exposure_factor);

  let b0 = s(0, 0);
  let (bW, bE, bN, bS) = (s(-1, 0), s(1, 0), s(0, 1), s(0, -1));
  let (bNW, bNE, bSW, bSE) = (s(-1, 1), s(1, 1), s(-1, -1), s(1, -1));
  let (bNNWW, bNNW, bNN, bNNE, bNNEE) = (s(-2, 2), s(-1, 2), s(0, 2), s(1, 2), s(2, 2));
  let (bENE, bEE, bESE) = (s(2, 1), s(2, 0), s(2, -1));
  let (bSSEE, bSSE, bSS, bSSW, bSSWW) = (s(2, -2), s(1, -2), s(0, -2), s(-1, -2), s(-2, -2));
  let (bWSW, bWW, bWNW) = (s(-2, -1), s(-2, 0), s(-2, 1));
  let (bNNN, bSSS, bEEE, bWWW) = (s(0, 3), s(0, -3), s(3, 0), s(-3, 0));
  let (bNNNW, bNNNE, bSSSW, bSSSE) = (s(-1, 3), s(1, 3), s(-1, -3), s(1, -3));
  let (bWWWN, bWWWS, bEEEN, bEEES) = (s(-3, 1), s(-3, -1), s(3, 1), s(3, -1));

  let ave = if is_g {
    ave_var(&[bNN, bNW, bNE, bWW, b0, bEE, bSW, bSE, bSS], black, range)
  } else {
    ave_var(&[bNNW, bNNE, bWNW, bN, bENE, bW, bE, bWSW, bS, bESE, bSSW, bSSE], black, range)
  };

  let mut var = if is_g {
    [
      (sd2(bWW, b0, bEE) + 0.5 * (sd1(bNW, bNE) + sd1(bSW, bSE))) / 3.0,
      (sd2(bSS, bSE, bEE) + sd2(bSW, b0, bNE) + sd2(bWW, bNW, bNN)) / 6.0,
      (sd2(bNN, b0, bSS) + 0.5 * (sd1(bSW, bNW) + sd1(bSE, bNE))) / 3.0,
      (sd2(bSS, bSW, bWW) + sd2(bSE, b0, bNW) + sd2(bEE, bNE, bNN)) / 6.0,
    ]
  } else {
    [
      (sd1(bW, bE) + 0.5 * (sd2(bWNW, bN, bENE) + sd2(bWSW, bS, bESE))) / 3.0,
      (sd3(bSSW, bS, bE, bENE) + sd3(bWSW, bW, bN, bNNE)) / 6.0,
      (sd1(bN, bS) + 0.5 * (sd2(bNNE, bE, bSSE) + sd2(bNNW, bW, bSSW))) / 3.0,
      (sd3(bSSE, bS, bW, bWNW) + sd3(bESE, bE, bN, bNNW)) / 6.0,
    ]
  };
  let cano = var[0].max(var[2]);
  let diag = var[1].min(var[3]);
  let is_hf_v = ((diag - HF_EPSI * cano) / (diag + cano).max(0.000001)).clamp(0.0, 1.0);
  let is_hf = diag > HF_EPSI * cano;

  let add = |a: &mut [f32; 2], d: [f32; 2]| {
    a[0] += d[0];
    a[1] += d[1];
  };
  let (mut dR, mut dB) = ([0.0f32; 2], [0.0f32; 2]);
  if is_g {
    add(&mut dR, dxy(bNW, bNE, bNN, b0));
    add(&mut dR, dxy(bSW, bSE, b0, bSS));
    add(&mut dR, dxy(bWWWN, bNW, bNNWW, bWW));
    add(&mut dR, dxy(bNE, bEEEN, bNNEE, bEE));
    add(&mut dR, dxy(bSE, bEEES, bEE, bSSEE));
    add(&mut dR, dxy(bWWWS, bSW, bWW, bSSWW));
    dR = dR.map(|v| v / 6.0);
    add(&mut dB, dxy(b0, bEE, bNE, bSE));
    add(&mut dB, dxy(bWW, b0, bNW, bSW));
    add(&mut dB, dxy(bNN, bNNEE, bNNNE, bNE));
    add(&mut dB, dxy(bNNWW, bNN, bNNNW, bNW));
    add(&mut dB, dxy(bSS, bSSEE, bSE, bSSSE));
    add(&mut dB, dxy(bSSWW, bSS, bSW, bSSSW));
    dB = dB.map(|v| v / 6.0);
  } else {
    add(&mut dR, dxy(bW, bE, bN, bS));
    add(&mut dR, dxy(bNNW, bNNE, bNNN, bN));
    add(&mut dR, dxy(bE, bEEE, bENE, bESE));
    add(&mut dR, dxy(bSSW, bSSE, bS, bSSS));
    add(&mut dR, dxy(bWWW, bW, bWNW, bWSW));
    dR = dR.map(|v| v / 5.0);
    add(&mut dB, dxy(bWNW, bN, bNNW, bW));
    add(&mut dB, dxy(bN, bENE, bNNE, bE));
    add(&mut dB, dxy(bS, bESE, bE, bSSE));
    add(&mut dB, dxy(bWSW, bS, bW, bSSW));
    dB = dB.map(|v| v / 4.0);
  }
  let vhf = [dR[0] + dB[0], dR[1] + dB[1]];
  if is_hf {
    var[0] = vhf[0];
    var[2] = vhf[1];
  }
  let vhf_max = vhf[0].max(vhf[1]);
  let vhf_min = vhf[0].min(vhf[1]);
  let confidence_hf = smoothstep(0.0, 1.0, HFMAG * vhf_max / vhf_min.max(0.000001));
  let dirs: [f32; 2] = if var[0] < var[2] { [1.0, 0.0] } else { [0.0, 1.0] };

  let var_from_rn = 16.0 * (rn[1] + ave.0 * rn[2]);
  let mut mixer = (ave.1 / (var_from_rn + 0.000001)).clamp(0.0, 1.0);
  mixer *= ((ave.0 * ef - 0.002) * 200.0).clamp(0.0, 1.0);
  mixer = mixer.max(mix(mixer, confidence_hf, confidence_hf));
  if is_hf {
    mixer = confidence_hf;
  }

  let mut cf = if is_g {
    [
      0.5 * (bN + bS),
      mix(b0, 0.25 * (bNW + bNE + bSW + bSE), 0.25),
      0.5 * (bE + bW),
    ]
  } else {
    [
      0.25 * (bNW + bNE + bSW + bSE),
      0.25 * (bN + bS + bE + bW),
      mix(b0, 0.25 * (bNN + bSS + bEE + bWW), 0.25),
    ]
  };
  if is_hf {
    cf[1] = if is_g {
      mix(b0, 0.25 * (bNW + bNE + bSE + bSW), 0.5)
    } else {
      0.25 * (bN + bS + bE + bW)
    };
  }

  let mut cs = [1.0f32; 3];
  if is_g {
    cs[1] = b0;
    let dot = |a: f32, b: f32| dirs[0] * a + dirs[1] * b;
    let g_nhf = 0.5 * dot(bNW + bNE, bNN + b0);
    let g_shf = 0.5 * dot(bSW + bSE, bSS + b0);
    let g_whf = 0.5 * dot(bWW + b0, bNW + bSW);
    let g_ehf = 0.5 * dot(bEE + b0, bNE + bSE);
    let gN = mix(gdir(SRB, bN, bNN, b0, bNE, bNW, bNNN, bS, bENE, bWNW), g_nhf, is_hf_v);
    let gS = mix(gdir(SRB, bS, bSS, b0, bSE, bSW, bSSS, bN, bESE, bWSW), g_shf, is_hf_v);
    cs[0] = SRB * b0 + 0.5 * (bN - SRB * gN + bS - SRB * gS);
    let gW = mix(gdir(SRB, bW, bNW, bSW, b0, bWW, bNNW, bSSW, bWWW, bE), g_whf, is_hf_v);
    let gE = mix(gdir(SRB, bE, bNE, bSE, b0, bEE, bNNE, bSSE, bEEE, bW), g_ehf, is_hf_v);
    cs[2] = SRB * b0 + 0.5 * (bW - SRB * gW + bE - SRB * gE);
  } else {
    cs[2] = b0;
    let lap_h = 2.0 * b0 - bWW - bEE;
    let lap_v = 2.0 * b0 - bNN - bSS;
    let d_h = (bE - bW).abs() + lap_h.abs();
    let d_v = (bN - bS).abs() + lap_v.abs();
    let d_hg = 0.5 * ((2.0 * bN - bWNW - bENE).abs() + (2.0 * bS - bWSW - bESE).abs());
    let d_vg = 0.5 * ((2.0 * bE - bNNE - bSSE).abs() + (2.0 * bW - bNNW - bSSW).abs());
    let mix_unstable = (UNSTABLE * (d_h + d_hg + d_v + d_vg) * (bE + bW - bN - bS).abs()).min(1.0);
    let var_h = mix(
      d_h + d_hg + 0.5 * ((bNE - bNW).abs() + (bSE - bSW).abs()),
      d_h + d_hg,
      mix_unstable,
    );
    let var_v = mix(
      d_v + d_vg + 0.5 * ((bNE - bSE).abs() + (bNW - bSW).abs()),
      d_v + d_vg,
      mix_unstable,
    );
    let var_h = mix(var_h, dirs[1], is_hf_v);
    let var_v = mix(var_v, dirs[0], is_hf_v);
    let hv = if var_h < var_v { 0.0 } else { 1.0 };
    cs[1] = mix(
      0.5 * (bE + bW) + SRB * 0.25 * lap_h,
      0.5 * (bN + bS) + SRB * 0.25 * lap_v,
      hv,
    );
    let gNW = gdir(SRB, bNW, bNNW, bW, bN, bWNW, bNNNW, bSW, bNE, bWWWN);
    let gNE = gdir(SRB, bNE, bNNE, bE, bN, bENE, bNNNE, bSE, bNW, bEEEN);
    let gSW = gdir(SRB, bSW, bW, bSSW, bS, bWSW, bNW, bSSSW, bSE, bWWWS);
    let gSE = gdir(SRB, bSE, bE, bSSE, bS, bESE, bNE, bSSSE, bSW, bEEES);
    let d = [bNW - SRB * gNW, bNE - SRB * gNE, bSW - SRB * gSW, bSE - SRB * gSE];
    let dmax = d[0].max(d[1]).max(d[2]).max(d[3]);
    let dmin = d[0].min(d[1]).min(d[2]).min(d[3]);
    cs[0] = SRB * cs[1] + 0.5 * (d[0] + d[1] + d[2] + d[3] - dmax - dmin);
  }
  if !is_row_b {
    cs.swap(0, 2);
    cf.swap(0, 2);
  }
  std::array::from_fn(|k| (((mix(cf[k], cs[k], mixer)) - black).max(0.0) * range).min(1.0))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rggb() -> CfaPattern {
    use Channel::{Blue as B, Green as G, Red as R};
    CfaPattern::new(2, 2, vec![R, G, G, B]).unwrap()
  }

  #[test]
  fn phases() {
    use Channel::{Blue as B, Green as G, Red as R};
    assert_eq!(phase(&rggb()), Some((0, 0)));
    assert_eq!(phase(&CfaPattern::new(2, 2, vec![G, R, B, G]).unwrap()), Some((1, 0)));
    assert_eq!(phase(&CfaPattern::new(2, 2, vec![B, G, G, R]).unwrap()), Some((1, 1)));
    assert_eq!(phase(&CfaPattern::xtrans_default()), None);
  }

  #[test]
  fn half_rounding() {
    assert_eq!(to_half(1.0), 1.0);
    assert_eq!(to_half(0.25 + 1.0 / 65536.0), 0.25);
    assert!((to_half(0.3) - 0.3).abs() < 0.3 / 2048.0);
  }

  fn flat_mosaic(cfa: &CfaPattern, w: usize, h: usize, rgb: [f32; 3], black: f32, range: f32) -> Vec<f32> {
    (0..w * h)
      .map(|i| rgb[cfa.at(i / w, i % w) as usize] / range + black)
      .collect()
  }

  #[test]
  fn flat_colour_is_reproduced() {
    let cfa = rggb();
    let (w, h) = (24, 20);
    let (black, range) = (512.0 / 65535.0, 65535.0 / (16383.0 - 512.0));
    let rgb = [0.3, 0.6, 0.2];
    let m = flat_mosaic(&cfa, w, h, rgb, black, range);
    let prm = Params {
      black,
      range,
      rn: [0.6, 1.5e-8, 3e-4],
      exposure_factor: 2.27,
    };
    let d = despeckle(&m, w, h, &cfa, 1.25, 0.0);
    let out = demosaic(&d, w, h, &cfa, (0, 0, w, h), &prm).unwrap();
    for y in 0..h {
      for x in 0..w {
        let p = out.px(x, y);
        for c in 0..3 {
          assert!((p[c] - rgb[c]).abs() < 2e-3, "({x},{y}) {p:?}");
        }
      }
    }
  }

  #[test]
  fn despeckle_clamps_an_isolated_hot_pixel() {
    let cfa = rggb();
    let (w, h) = (16, 16);
    let mut m = flat_mosaic(&cfa, w, h, [0.3, 0.6, 0.2], 0.0078, 4.13);
    let i = 8 * w + 8; // red site
    m[i] = 0.9;
    let d = despeckle(&m, w, h, &cfa, 1.25, 0.0);
    assert!(d[i] < 0.2, "{}", d[i]);
  }
}
