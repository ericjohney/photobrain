//! Lens correction from the camera's own Fuji MakerNote/FujiIFD parameters.
//!
//! Each array is `[norm, r_1..r_9, v_1..v_9]` (chromatic aberration has two value sets,
//! red then blue). Radii are fractions of the half-diagonal of the active area.
//! - Distortion: `v` is the percentage radial displacement; an output pixel at radius r
//!   samples the source at r * (1 + v(r)/100) * fill_scale.
//! - Chromatic aberration: red/blue are additionally scaled by (1 + v(r)).
//! - Vignetting: `v` is the relative illumination in percent; pixels are divided by
//!   v(r)/100 (relative to the centre).

use crate::image::RgbImage;
use crate::raf::LensParams;
use rayon::prelude::*;

#[derive(Clone, Debug)]
struct Radial {
  knots: Vec<f32>,
  values: Vec<f32>,
}

impl Radial {
  /// Piecewise linear between knots; linear from `zero` at r = 0 to the first knot;
  /// constant beyond the last knot.
  fn eval(&self, r: f32, zero: f32) -> f32 {
    let k = &self.knots;
    let v = &self.values;
    if r <= k[0] {
      return zero + (v[0] - zero) * (r / k[0]).max(0.0);
    }
    let i = k.partition_point(|&x| x < r);
    if i >= k.len() {
      return v[v.len() - 1];
    }
    let t = (r - k[i - 1]) / (k[i] - k[i - 1]);
    v[i - 1] + (v[i] - v[i - 1]) * t
  }
}

fn split(arr: &[f64], sets: usize) -> Option<(Vec<f32>, Vec<Vec<f32>>)> {
  if arr.len() < 1 + 9 + 9 * sets {
    return None;
  }
  let knots: Vec<f32> = arr[1..10].iter().map(|&v| v as f32).collect();
  let values = (0..sets)
    .map(|s| {
      arr[10 + 9 * s..19 + 9 * s]
        .iter()
        .map(|&v| v as f32)
        .collect()
    })
    .collect();
  Some((knots, values))
}

#[derive(Clone, Debug, Default)]
pub struct LensCorrection {
  distortion: Option<Radial>,
  ca_red: Option<Radial>,
  ca_blue: Option<Radial>,
  vignetting: Option<Radial>,
  pub fill_scale: f32,
}

impl LensCorrection {
  pub fn from_params(p: &LensParams, fill_scale: f64) -> Self {
    let mk = |knots: &Vec<f32>, values: Vec<f32>| Radial {
      knots: knots.clone(),
      values,
    };
    let mut lc = LensCorrection {
      fill_scale: fill_scale as f32,
      ..Default::default()
    };
    if let Some((k, mut v)) = p.distortion.as_deref().and_then(|a| split(a, 1))
      && v[0].iter().any(|&x| x != 0.0)
    {
      lc.distortion = Some(mk(&k, v.remove(0)));
    }
    if let Some((k, mut v)) = p.chromatic_aberration.as_deref().and_then(|a| split(a, 2))
      && v.iter().flatten().any(|&x| x != 0.0)
    {
      lc.ca_red = Some(mk(&k, v.remove(0)));
      lc.ca_blue = Some(mk(&k, v.remove(0)));
    }
    if let Some((k, mut v)) = p.vignetting.as_deref().and_then(|a| split(a, 1))
      && v[0].iter().all(|&x| x > 0.0)
      && v[0].iter().any(|&x| (x - 100.0).abs() > 0.01)
    {
      lc.vignetting = Some(mk(&k, v.remove(0)));
    }
    if lc.distortion.is_none() {
      // Without a distortion curve there is no fill to compensate.
      lc.fill_scale = 1.0;
    }
    lc
  }

  pub fn is_identity(&self) -> bool {
    self.distortion.is_none() && self.ca_red.is_none() && self.vignetting.is_none()
  }

  /// Vignetting gain at a normalised radius.
  fn vignette_gain(&self, r: f32) -> f32 {
    match &self.vignetting {
      Some(v) => 100.0 / v.eval(r, 100.0).max(10.0),
      None => 1.0,
    }
  }

  fn distortion_scale(&self, r: f32) -> f32 {
    let d = self.distortion.as_ref().map_or(0.0, |d| d.eval(r, 0.0));
    (1.0 + d / 100.0) * self.fill_scale
  }

  fn ca_scale(&self, ca: &Option<Radial>, r: f32) -> f32 {
    1.0 + ca.as_ref().map_or(0.0, |c| c.eval(r, 0.0))
  }

  /// Apply to an image covering the full active area. `toggles` enables
  /// (distortion, chromatic aberration, vignetting).
  pub fn apply(&self, src: &RgbImage, toggles: (bool, bool, bool)) -> RgbImage {
    let (do_dist, do_ca, do_vig) = toggles;
    let (w, h) = (src.width, src.height);
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let half_diag = (cx * cx + cy * cy).sqrt();
    let mut out = RgbImage::new(w, h);
    out.rows_mut().for_each(|(y, row)| {
      let py = y as f32 + 0.5 - cy;
      for x in 0..w {
        let px = x as f32 + 0.5 - cx;
        let r = (px * px + py * py).sqrt() / half_diag;
        let s = if do_dist {
          self.distortion_scale(r)
        } else {
          1.0
        };
        let gain = if do_vig {
          // Vignetting is measured on the uncorrected (source) geometry.
          self.vignette_gain(r * s)
        } else {
          1.0
        };
        for c in 0..3 {
          let sc = s
            * match c {
              0 if do_ca => self.ca_scale(&self.ca_red, r),
              2 if do_ca => self.ca_scale(&self.ca_blue, r),
              _ => 1.0,
            };
          row[x * 3 + c] = src.sample_bilinear(cx + px * sc, cy + py * sc, c) * gain;
        }
      }
    });
    out
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn params(dist: [f64; 9], vig: [f64; 9]) -> LensParams {
    let knots = [
      0.3535, 0.5, 0.6127, 0.7070, 0.7908, 0.8662, 0.9352, 1.0, 1.0606,
    ];
    let mk = |v: [f64; 9]| {
      let mut a = vec![515.9];
      a.extend(knots);
      a.extend(v);
      a
    };
    LensParams {
      distortion: Some(mk(dist)),
      chromatic_aberration: None,
      vignetting: Some(mk(vig)),
    }
  }

  #[test]
  fn zero_params_are_identity() {
    let lc = LensCorrection::from_params(&params([0.0; 9], [100.0; 9]), 1.01);
    assert!(lc.is_identity());
    assert_eq!(lc.fill_scale, 1.0);
  }

  #[test]
  fn distortion_curve_interpolates() {
    let lc = LensCorrection::from_params(
      &params(
        [-0.3, -0.7, -1.2, -1.6, -2.0, -2.5, -3.0, -3.5, -4.0],
        [100.0; 9],
      ),
      1.0,
    );
    assert!((lc.distortion_scale(0.0) - 1.0).abs() < 1e-6);
    assert!((lc.distortion_scale(1.0) - 0.965).abs() < 1e-6);
    assert!((lc.distortion_scale(2.0) - 0.96).abs() < 1e-6);
  }

  #[test]
  fn vignetting_brightens_corners() {
    let lc = LensCorrection::from_params(
      &params(
        [0.0; 9],
        [95.0, 90.0, 87.0, 81.0, 75.0, 70.0, 66.0, 62.0, 62.0],
      ),
      1.0,
    );
    assert!((lc.vignette_gain(0.0) - 1.0).abs() < 1e-6);
    assert!((lc.vignette_gain(1.0) - 100.0 / 62.0).abs() < 1e-5);
    let mut im = RgbImage::new(20, 10);
    im.data.fill(0.5);
    let o = lc.apply(&im, (false, false, true));
    assert!(o.px(0, 0)[1] > o.px(10, 5)[1]);
  }
}
