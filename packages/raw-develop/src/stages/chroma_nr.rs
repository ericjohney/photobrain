//! Chroma noise reduction: a port of RawCamera's half-resolution "powerBlur" chain.
//!
//! 1. Extract (`extractHRGB` / `extractHRGBHF`): 2x2-average the white-balanced image to
//!    half resolution, scaled so the brightest white-balance channel has weight 0.5. The
//!    moire-detecting variant (low ISO) also writes an alpha measuring fine green
//!    texture, which lets later passes average across strong but colour-neutral detail
//!    (moire) more aggressively.
//! 2. Several selective-average passes at growing tap spacing `scale` (1, 3, 7, 14): each
//!    output pixel averages itself with those of its 12 neighbours whose colour
//!    difference (weighted by the inverse white balance) is below a luminance-dependent
//!    threshold `c0 + c1*Y + c2*Y^2`. Variants:
//!    - `early_out`: if none of the 4 nearest neighbours qualifies, keep the pixel
//!      (protects isolated detail);
//!    - `hf` / `hf_early_out`: moire-aware threshold where the extract alpha is set;
//!    - `despeckle`: additionally replaces isolated dark/saturated/red speckles by the
//!      average of their 4 neighbours (high ISO).
//! 3. Expand (`expandHRGB`): bilinear (9/3/3/1) upsample to full resolution.
//! 4. Gather (`YAndRGBGather`): keep the filtered chromaticity but restore each pixel's
//!    own full-resolution luminance, so detail is untouched.
//!
//! The per-ISO pass chains and thresholds are camera-profile data (`[[noise]]`).

use crate::image::RgbImage;
use crate::profile::{ChromaNrPass, NoiseIso, PassKind};
use rayon::prelude::*;

const LUM: [f32; 3] = [0.299, 0.587, 0.114];
const HT: f32 = 0.003_906_25;

#[inline]
fn lum(c: [f32; 4]) -> f32 {
  c[0] * LUM[0] + c[1] * LUM[1] + c[2] * LUM[2]
}

/// Half-resolution RGBA plane.
struct Plane {
  w: usize,
  h: usize,
  d: Vec<[f32; 4]>,
}

impl Plane {
  #[inline]
  fn at(&self, x: isize, y: isize) -> [f32; 4] {
    let x = x.clamp(0, self.w as isize - 1) as usize;
    let y = y.clamp(0, self.h as isize - 1) as usize;
    self.d[y * self.w + x]
  }
}

/// Sample the full-resolution image at a continuous coordinate (pixel centres at +0.5),
/// times the neutral factors.
#[inline]
fn samp(img: &RgbImage, x: f32, y: f32, nf: [f32; 3]) -> [f32; 4] {
  [
    img.sample_bilinear(x, y, 0) * nf[0],
    img.sample_bilinear(x, y, 1) * nf[1],
    img.sample_bilinear(x, y, 2) * nf[2],
    1.0,
  ]
}

fn extract(img: &RgbImage, nf: [f32; 3], moire: Option<f32>) -> Plane {
  let (w, h) = (img.width.div_ceil(2), img.height.div_ceil(2));
  let mut d = vec![[0.0f32; 4]; w * h];
  d.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
    for (x, o) in row.iter_mut().enumerate() {
      // destCoord * 2: the corner shared by the 2x2 block -> bilinear = box average.
      let (px, py) = (2.0 * x as f32 + 1.0, 2.0 * y as f32 + 1.0);
      let s = samp(img, px, py, nf);
      let Some(hf_factor) = moire else {
        *o = s;
        continue;
      };
      // Core Image's y axis points up; offsets are given in its convention.
      let off = [
        (-1.5, -1.5),
        (0.5, -1.5),
        (-0.5, -0.5),
        (1.5, -0.5),
        (-1.5, 0.5),
        (0.5, 0.5),
        (-0.5, 1.5),
        (1.5, 1.5),
      ];
      let c: [[f32; 4]; 8] = off.map(|(dx, dy)| samp(img, px + dx, py - dy, nf));
      let ms = c
        .iter()
        .map(|c| {
          let lo = c[0].min(c[1]).min(c[2]);
          let hi = c[0].max(c[1]).max(c[2]);
          (hi - lo) / hi
        })
        .fold(f32::NEG_INFINITY, |a, b| if b > a { b } else { a });
      let hf = if ms - 0.5 < 0.0 {
        hf_factor * 3.0
      } else {
        hf_factor
      };
      let g: [f32; 8] = c.map(|c| c[1]);
      let d1 = (g[6] + g[7] + g[2] + g[3]) * 0.25 - g[5];
      let d2 = (g[4] + g[5] + g[0] + g[1]) * 0.25 - g[2];
      let mut alpha = ((d1 * d1 + d2 * d2) * hf).clamp(0.0, 1.0);
      // 1000 * length(varianceRGB8(c0..c7)) over the four RGBA components.
      let mut avg = [0.0f32; 4];
      for c in &c {
        for k in 0..4 {
          avg[k] += c[k] / 8.0;
        }
      }
      let mut var = [0.0f32; 4];
      for c in &c {
        for k in 0..4 {
          var[k] += (c[k] - avg[k]).powi(2) / 8.0;
        }
      }
      let e = 1000.0 * var.iter().map(|v| v * v).sum::<f32>().sqrt();
      let high_bit = if alpha > 0.1 { 1.0 } else { 0.0 };
      alpha *= if e > 0.1 { high_bit } else { 1.0 };
      *o = [s[0], s[1], s[2], alpha];
    }
  });
  Plane { w, h, d }
}

/// The 12 taps (in units of `scale`). The first four of `CROSS` are the early-out set.
const TAPS: [(isize, isize); 12] = [
  (0, 2),
  (-1, 1),
  (0, 1),
  (1, 1),
  (-2, 0),
  (-1, 0),
  (1, 0),
  (2, 0),
  (-1, -1),
  (0, -1),
  (1, -1),
  (0, -2),
];
const CROSS: [(isize, isize); 4] = [(0, 1), (-1, 0), (1, 0), (0, -1)];
const OUTER: [(isize, isize); 8] = [
  (0, 2),
  (-1, 1),
  (1, 1),
  (-2, 0),
  (2, 0),
  (-1, -1),
  (1, -1),
  (0, -2),
];

#[inline]
fn add(sum: &mut [f32; 4], v: [f32; 4]) {
  sum[0] += v[0];
  sum[1] += v[1];
  sum[2] += v[2];
  sum[3] += 1.0;
}

#[inline]
fn nf_err(v: [f32; 4], c: [f32; 4], nf: [f32; 3]) -> f32 {
  let d = [
    (v[0] - c[0]) * nf[0],
    (v[1] - c[1]) * nf[1],
    (v[2] - c[2]) * nf[2],
  ];
  d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

#[inline]
fn hf_err(v: [f32; 4], c: [f32; 4]) -> f32 {
  let (dr, dg, db) = (v[0] - c[0], v[1] - c[1], v[2] - c[2]);
  (dr + db) * (dr + db) * 0.25 + dg * dg
}

#[inline]
fn avg(sum: [f32; 4], a: f32) -> [f32; 4] {
  [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3], a]
}

fn pass(src: &Plane, p: &ChromaNrPass, nf: [f32; 3], strength: f32) -> Plane {
  let s = p.scale as isize;
  let th = p.threshold;
  let moire = th[3] * th[3];
  let mut d = vec![[0.0f32; 4]; src.w * src.h];
  d.par_chunks_mut(src.w).enumerate().for_each(|(y, row)| {
    let (y, s) = (y as isize, s);
    for (x, o) in row.iter_mut().enumerate() {
      let x = x as isize;
      let tap = |(dx, dy): (isize, isize)| src.at(x + dx * s, y + dy * s);
      let c = src.at(x, y);
      let yl = lum(c);
      let t = (th[0] + th[1] * yl + th[2] * yl * yl) * strength;
      let mut sum = [c[0], c[1], c[2], 1.0];
      *o = match p.kind {
        PassKind::Plain => {
          for off in TAPS {
            let v = tap(off);
            if nf_err(v, c, nf) < t {
              add(&mut sum, v);
            }
          }
          avg(sum, c[3])
        }
        PassKind::EarlyOut => {
          for off in CROSS {
            let v = tap(off);
            if nf_err(v, c, nf) < t {
              add(&mut sum, v);
            }
          }
          let ct = sum[3];
          for off in OUTER {
            let v = tap(off);
            if nf_err(v, c, nf) < t {
              add(&mut sum, v);
            }
          }
          if ct <= 1.5 { c } else { avg(sum, 1.0) }
        }
        PassKind::Hf | PassKind::HfEarlyOut => {
          let early = p.kind == PassKind::HfEarlyOut;
          if c[3] > HT {
            let lt = t.max(moire * c[3]);
            let mut sumhf = sum;
            let mut ct = 0.0;
            for (i, off) in CROSS.iter().chain(OUTER.iter()).enumerate() {
              let v = tap(*off);
              if v[3] > HT && hf_err(v, c) < lt {
                add(&mut sumhf, v);
              }
              if early && nf_err(v, c, nf) < t {
                add(&mut sum, v);
              }
              if i == 3 {
                ct = sum[3];
              }
            }
            if !early {
              avg(sumhf, c[3])
            } else if ct <= 1.5 {
              c
            } else {
              let a = avg(sum, c[3]);
              let b = avg(sumhf, c[3]);
              let k = p.interpolant;
              [
                a[0] + (b[0] - a[0]) * k,
                a[1] + (b[1] - a[1]) * k,
                a[2] + (b[2] - a[2]) * k,
                c[3],
              ]
            }
          } else {
            let mut ct = 0.0;
            for (i, off) in CROSS.iter().chain(OUTER.iter()).enumerate() {
              let v = tap(*off);
              if nf_err(v, c, nf) < t {
                add(&mut sum, v);
              }
              if i == 3 {
                ct = sum[3];
              }
            }
            if early && ct <= 1.5 {
              c
            } else {
              avg(sum, c[3])
            }
          }
        }
        PassKind::EarlyOut2 => {
          let (f2, fr) = (p.despeckle[0], p.despeckle[1]);
          let t2 = t * f2;
          let mut sum2 = sum;
          let mut ct = 0.0;
          for (i, off) in CROSS.iter().chain(OUTER.iter()).enumerate() {
            let v = tap(*off);
            let e = nf_err(v, c, nf);
            if e < t {
              add(&mut sum, v);
            }
            if e < t2 {
              add(&mut sum2, v);
            }
            if i == 3 {
              ct = sum[3];
            }
          }
          if ct <= 1.5 {
            c
          } else {
            let range = |p: [f32; 4]| p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]);
            let c1 = avg(sum, 1.0);
            let c2 = avg(sum2, 1.0);
            let av = (c[0] + c[1] + c[2]) * 0.33333;
            // Saturated centre: keep the stricter average if it is more saturated.
            if range(c) - av * fr >= 0.0 && range(c2) - range(c1) >= 0.0 {
              c2
            } else {
              c1
            }
          }
        }
        PassKind::Despeckle => {
          for off in TAPS {
            let v = tap(off);
            if nf_err(v, c, nf) < t {
              add(&mut sum, v);
            }
          }
          let largect = sum[3];
          let largesum = avg(sum, c[3]);
          let (v3, v6, v8, v11) = (tap((0, 1)), tap((-1, 0)), tap((1, 0)), tap((0, -1)));
          let av: [f32; 3] = std::array::from_fn(|k| (v3[k] + v6[k] + v8[k] + v11[k]) * 0.25);
          despeckle(src, x, y, c, av, largect, largesum, &p.despeckle)
        }
      };
    }
  });
  Plane {
    w: src.w,
    h: src.h,
    d,
  }
}

#[allow(clippy::too_many_arguments)]
#[inline]
fn despeckle(
  src: &Plane,
  x: isize,
  y: isize,
  c: [f32; 4],
  av: [f32; 3],
  largect: f32,
  largesum: [f32; 4],
  q: &[f32],
) -> [f32; 4] {
  // q = params3 (4), params4 (4), params5 (4), params6.r
  let (p3, p4, p5, p6r) = (&q[0..4], &q[4..8], &q[8..12], q[12]);
  let alum = av[0] * LUM[0] + av[1] * LUM[1] + av[2] * LUM[2];
  let clum = lum(c);
  // Local luminance contrast over the unscaled 3x3 neighbourhood.
  let (mut lo, mut hi) = (clum, clum);
  for dy in -1..=1 {
    for dx in -1..=1 {
      let l = lum(src.at(x + dx, y + dy));
      lo = lo.min(l);
      hi = hi.max(l);
    }
  }
  let lcon = hi.sqrt() - lo.sqrt();
  let st = |edge: f32, v: f32| if v >= edge { 1.0f32 } else { 0.0 };

  let lumlo = st(alum, p3[2]);
  let sparkle = st(alum * p3[3], clum);
  let scs = lumlo.min(sparkle);

  let lo = av[0].min(av[1]).min(av[2]).sqrt();
  let hi = av[0].max(av[1]).max(av[2]).sqrt();
  let satlo = st(hi - lo, p4[1] * hi);
  let d: [f32; 3] = std::array::from_fn(|k| {
    let r = c[k] / av[k].max(0.000001);
    r.max(1.0 / r)
  });
  let rbpop = st(d[1] * p4[2], d[0].max(d[2]));
  let nconlo = st(lcon, p4[3]);
  let lowct = st(largect, p5[0]);
  let lumhi = st(p3[2], alum);
  let ncs = satlo.min(rbpop).min(nconlo).min(lowct).min(lumhi);

  let rpop = st(d[1].max(d[2]) * p5[2], d[0]);
  let blueness = st(av[0].max(av[1]) * p5[3], av[2]);
  let bconlo = st(lcon, p6r);
  let bcs = rpop.min(blueness).min(bconlo);

  let mut speckle = 0.0f32;
  if p3[1] != 0.0 {
    speckle = speckle.max(scs);
  }
  if p4[0] != 0.0 {
    speckle = speckle.max(ncs);
  }
  if p5[1] != 0.0 {
    speckle = speckle.max(bcs);
  }
  std::array::from_fn(|k| {
    if k == 3 {
      c[3]
    } else {
      largesum[k] + (av[k] - largesum[k]) * speckle
    }
  })
}

/// Noise reduction on a white-balanced camera-RGB image (a sensor white of `wb[c]`):
/// chroma NR (`chroma` = the user amount, 0.5 = RawCamera's default; thresholds scale
/// linearly with `amount / 0.5`, 0 disables) and the luma pyramid (`luma`, None disables),
/// recombined like `YAndRGBGather`.
pub fn apply(
  img: &mut RgbImage,
  wb: [f32; 3],
  noise: &NoiseIso,
  chroma: f32,
  luma: Option<crate::stages::luma::Amounts>,
) {
  if img.width < 4 || img.height < 4 {
    return;
  }
  let do_chroma = chroma > 0.0 && !noise.chroma_passes.is_empty();
  let do_luma = luma.is_some() && !noise.luma.is_empty();
  if !do_chroma && !do_luma {
    return;
  }
  // RawCamera runs on unbalanced camera RGB scaled by neutralFactors = WB * k with
  // max = 0.5. On balanced input that is a uniform scale k; its tap-weights are 1/WB
  // with green 1.
  let k = 0.5 / wb[0].max(wb[1]).max(wb[2]);
  let nf = [1.0 / wb[0], 1.0 / wb[1], 1.0 / wb[2]];
  let (w, h) = (img.width, img.height);

  let plane = do_chroma.then(|| {
    let strength = chroma / 0.5;
    let mut plane = extract(img, [k, k, k], noise.moire_detect.then_some(1000.0));
    for p in &noise.chroma_passes {
      plane = pass(&plane, p, nf, strength);
    }
    plane
  });

  // Luma (extractY): k * dot(rgb, LUM), in Core Image orientation (row 0 = bottom).
  let y_out = luma.filter(|_| do_luma).map(|amt| {
    let mut d = vec![0.0f32; w * h];
    d.par_chunks_mut(w).enumerate().for_each(|(cy, row)| {
      let y = h - 1 - cy;
      for (x, o) in row.iter_mut().enumerate() {
        let p = img.px(x, y);
        *o = (p[0] * LUM[0] + p[1] * LUM[1] + p[2] * LUM[2]) * k;
      }
    });
    crate::stages::luma::process(&crate::stages::luma::Plane { w, h, d }, &noise.luma, amt)
  });

  // Expand + gather: filtered chromaticity with the (processed) luminance.
  img.rows_mut().for_each(|(y, row)| {
    let (hy, vy) = (y / 2, if y % 2 == 0 { -1 } else { 1 });
    for x in 0..w {
      let p = &mut row[x * 3..x * 3 + 3];
      let yorig = (p[0] * LUM[0] + p[1] * LUM[1] + p[2] * LUM[2]) * k;
      let kc: [f32; 3] = match &plane {
        Some(plane) => {
          let (hx, vx) = (x / 2, if x % 2 == 0 { -1 } else { 1 });
          let (hx, hy) = (hx as isize, hy as isize);
          let c1 = plane.at(hx, hy);
          let c2 = plane.at(hx, hy + vy);
          let c3 = plane.at(hx + vx, hy);
          let c4 = plane.at(hx + vx, hy + vy);
          std::array::from_fn(|i| c1[i] * 0.5625 + (c2[i] + c3[i]) * 0.1875 + c4[i] * 0.0625)
        }
        None => [p[0] * k, p[1] * k, p[2] * k],
      };
      let mut y0 = match &y_out {
        Some(l) => l.d[(h - 1 - y) * w + x],
        None => yorig,
      };
      // Near sensor clipping keep the original luminance (ksushi = unbalanced value).
      let maxc = (kc[0] / wb[0]).max(kc[1] / wb[1]).max(kc[2] / wb[2]) / k;
      y0 += (yorig - y0) * smoothstep(0.9, 1.0, maxc);
      let mut ycnr = kc[0] * LUM[0] + kc[1] * LUM[1] + kc[2] * LUM[2];
      if ycnr == 0.0 {
        ycnr = 0.0001;
      }
      let s = y0 / ycnr / k;
      p[0] = kc[0] * s;
      p[1] = kc[1] * s;
      p[2] = kc[2] * s;
    }
  });
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
  t * t * (3.0 - 2.0 * t)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn chain(kind: PassKind) -> NoiseIso {
    NoiseIso {
      iso: 1600.0,
      demosaic_noise: [0.7, 2.3e-7, 3.2e-4],
      moire_detect: false,
      chroma_passes: vec![
        ChromaNrPass {
          kind,
          scale: 1,
          threshold: [1e-4, 1e-3, 1e-3, 0.0],
          interpolant: 0.0,
          despeckle: vec![
            0., 1., 0.006, 0., 1., 0.6, -0.6, 0.35, 4., 1., 1.457, 1.5, 0.2,
          ],
        },
        ChromaNrPass {
          kind: PassKind::EarlyOut,
          scale: 3,
          threshold: [1e-4, 1e-3, 1e-3, 0.0],
          interpolant: 0.0,
          despeckle: vec![],
        },
      ],
      luma: vec![],
    }
  }

  #[test]
  fn flat_colour_is_preserved() {
    for kind in [PassKind::Plain, PassKind::Despeckle] {
      let mut im = RgbImage::new(33, 21);
      for p in im.data.chunks_mut(3) {
        p.copy_from_slice(&[0.4, 0.3, 0.2]);
      }
      apply(&mut im, [2.0, 1.0, 1.8], &chain(kind), 0.5, None);
      for p in im.data.chunks(3) {
        assert!(
          (p[0] - 0.4).abs() < 1e-5 && (p[1] - 0.3).abs() < 1e-5,
          "{p:?}"
        );
      }
    }
  }

  #[test]
  fn chroma_noise_is_reduced_and_luma_kept() {
    let mut im = RgbImage::new(64, 64);
    let mut seed = 1u32;
    let mut rnd = || {
      seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
      (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
    };
    for p in im.data.chunks_mut(3) {
      let n = rnd() * 0.02;
      p.copy_from_slice(&[0.3 + n, 0.3 - n * 0.5, 0.3 + rnd() * 0.02]);
    }
    let before = im.clone();
    apply(&mut im, [1.0, 1.0, 1.0], &chain(PassKind::Plain), 0.5, None);
    let var = |im: &RgbImage| {
      im.data
        .chunks(3)
        .map(|p| (p[0] - p[1]).powi(2))
        .sum::<f32>()
        / (64.0 * 64.0)
    };
    assert!(var(&im) < var(&before) * 0.5);
    for (a, b) in im.data.chunks(3).zip(before.data.chunks(3)) {
      let la = a[0] * LUM[0] + a[1] * LUM[1] + a[2] * LUM[2];
      let lb = b[0] * LUM[0] + b[1] * LUM[1] + b[2] * LUM[2];
      assert!((la - lb).abs() < 1e-4);
    }
  }
}
