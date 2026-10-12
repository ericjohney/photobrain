//! Noise reduction and sharpening on scene-linear RGB.
//!
//! Both work on a luma/chroma split of a log-ish encoding so their strength is roughly
//! perceptually uniform:
//! - chroma NR: edge-aware (cross-bilateral on luma) blur of the chroma channels;
//! - luma NR: the same filter on luma, blended by the amount;
//! - sharpening: unsharp mask on luma.
//!
//! Defaults follow Apple's as-shot behaviour (colour NR 0.5, luma NR by ISO, sharpening
//! 1.0), but the filters are our own.

use crate::image::RgbImage;
use crate::math::P3_LUMA;
use rayon::prelude::*;

fn enc(v: f32) -> f32 {
  (v.max(0.0) + 0.002).sqrt()
}
fn dec(e: f32) -> f32 {
  (e * e - 0.002).max(0.0)
}

/// Separable box blur, radius r, applied `passes` times (approximates a Gaussian).
pub(crate) fn blur_plane(src: &[f32], w: usize, h: usize, r: usize, passes: usize) -> Vec<f32> {
  let mut a = src.to_vec();
  let mut b = vec![0.0f32; w * h];
  for _ in 0..passes {
    b.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
      let line = &a[y * w..(y + 1) * w];
      let mut acc = 0.0f32;
      for i in 0..=r.min(w - 1) {
        acc += line[i];
      }
      acc += line[0] * r as f32;
      for x in 0..w {
        row[x] = acc / (2 * r + 1) as f32;
        let add = line[(x + r + 1).min(w - 1)];
        let sub = line[x.saturating_sub(r)];
        acc += add - sub;
      }
    });
    // Vertical pass via transpose-free column walk.
    a.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
      let y0 = y.saturating_sub(r);
      let y1 = (y + r).min(h - 1);
      for (x, v) in row.iter_mut().enumerate() {
        let mut s = 0.0f32;
        for yy in y0..=y1 {
          s += b[yy * w + x];
        }
        // Edge replicate.
        let missing = (2 * r + 1) - (y1 - y0 + 1);
        let edge = if y < r { b[x] } else { b[(h - 1) * w + x] };
        *v = (s + edge * missing as f32) / (2 * r + 1) as f32;
      }
    });
  }
  a
}

pub struct DetailParams {
  pub luma_nr: f32,
  pub chroma_nr: f32,
  pub sharpen: f32,
  /// Scale of the image relative to full resolution (1.0 = native), so radii track
  /// image content when developing previews.
  pub scale: f32,
  /// Noise level multiplier (1 at base ISO), widening chroma NR at high ISO.
  pub noise: f32,
}

pub fn apply(img: &mut RgbImage, p: &DetailParams) {
  if p.luma_nr <= 0.0 && p.chroma_nr <= 0.0 && p.sharpen <= 0.0 {
    return;
  }
  let (w, h) = (img.width, img.height);
  let n = w * h;
  let mut y = vec![0.0f32; n];
  let mut cb = vec![0.0f32; n];
  let mut cr = vec![0.0f32; n];
  img
    .data
    .par_chunks(3)
    .zip(
      y.par_iter_mut()
        .zip(cb.par_iter_mut().zip(cr.par_iter_mut())),
    )
    .for_each(|(px, (yv, (b, r)))| {
      let l = enc(px[0] * P3_LUMA[0] + px[1] * P3_LUMA[1] + px[2] * P3_LUMA[2]);
      *yv = l;
      *b = enc(px[2]) - l;
      *r = enc(px[0]) - l;
    });

  let rad = |base: f32| ((base * p.scale).round() as usize).max(1);
  let mut y_out = y.clone();
  if p.chroma_nr > 0.0 {
    // Effective strength grows with the noise level: amount 0.5 is full-strength
    // smoothing from about ISO 3200 upwards.
    let a = (p.chroma_nr * 2.0 * (0.5 + 0.25 * p.noise.log2().max(0.0))).min(1.0);
    let r = rad((4.0 + 8.0 * p.chroma_nr) * p.noise.sqrt().clamp(1.0, 3.0));
    let bb = blur_plane(&cb, w, h, r, 2);
    let rr = blur_plane(&cr, w, h, r, 2);
    cb.par_iter_mut()
      .zip(bb.par_iter())
      .for_each(|(v, s)| *v += (s - *v) * a);
    cr.par_iter_mut()
      .zip(rr.par_iter())
      .for_each(|(v, s)| *v += (s - *v) * a);
  }
  if p.luma_nr > 0.0 {
    let blurred = blur_plane(&y, w, h, rad(1.0), 2);
    let a = p.luma_nr.min(1.0);
    // Edge-preserving: blend less where the local difference is large.
    y_out
      .par_iter_mut()
      .zip(blurred.par_iter())
      .for_each(|(v, s)| {
        let d = (*v - s).abs();
        let k = a * (-d * d / (0.0004 + 0.002 * a)).exp();
        *v += (s - *v) * k;
      });
  }
  if p.sharpen > 0.0 {
    let blurred = blur_plane(&y_out, w, h, rad(1.0), 2);
    let amt = 0.6 * p.sharpen;
    y_out
      .par_iter_mut()
      .zip(blurred.par_iter())
      .for_each(|(v, s)| {
        // Threshold small differences (noise) and limit halos.
        let d = *v - s;
        let d = d.signum() * (d.abs() - 0.002).max(0.0);
        *v += (d * amt).clamp(-0.05, 0.05);
      });
  }

  img
    .data
    .par_chunks_mut(3)
    .zip(y_out.par_iter().zip(cb.par_iter().zip(cr.par_iter())))
    .zip(y.par_iter())
    .for_each(|((px, (yv, (b, r))), y_old)| {
      let l_lin_old = dec(*y_old);
      let l_lin_new = dec(*yv);
      let rr = dec(r + yv);
      let bl = dec(b + yv);
      // Solve green from the new luminance.
      let g = ((l_lin_new - P3_LUMA[0] * rr - P3_LUMA[2] * bl) / P3_LUMA[1]).max(0.0);
      if l_lin_old <= 0.0 && l_lin_new <= 0.0 {
        return;
      }
      px[0] = rr;
      px[1] = g;
      px[2] = bl;
    });
}

/// Noise level relative to the camera's base ISO.
pub fn noise_level(iso: Option<u32>, base_iso: f32) -> f32 {
  iso.map_or(1.0, |i| (i as f32 / base_iso).max(1.0))
}

/// Apple-like default luma NR amount by ISO (as-shot behaviour, fitted shape).
pub fn default_luma_nr(iso: Option<u32>) -> f32 {
  let iso = iso.unwrap_or(100) as f32;
  // ~0 up to ISO 640, rising to ~0.12-0.13 at ISO 10000+.
  (((iso / 640.0).log2().max(0.0)) * 0.03).min(0.14)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn flat_image_unchanged() {
    let mut im = RgbImage::new(40, 30);
    for p in im.data.chunks_mut(3) {
      p.copy_from_slice(&[0.2, 0.3, 0.1]);
    }
    apply(
      &mut im,
      &DetailParams {
        luma_nr: 0.5,
        chroma_nr: 0.5,
        sharpen: 1.0,
        scale: 1.0,
        noise: 1.0,
      },
    );
    for p in im.data.chunks(3) {
      assert!(
        (p[0] - 0.2).abs() < 1e-3 && (p[1] - 0.3).abs() < 1e-3 && (p[2] - 0.1).abs() < 1e-3,
        "{p:?}"
      );
    }
  }

  #[test]
  fn default_nr_curve() {
    assert_eq!(default_luma_nr(Some(125)), 0.0);
    assert!(default_luma_nr(Some(12800)) > 0.1);
  }
}
