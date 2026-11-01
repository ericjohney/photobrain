//! Look for DNG LinearRaw (Apple ProRAW): ports of RawCamera's `profileGainTableMap`
//! (DNG 1.7 local tone map) and `boost_lut` (the profile tone curve) kernels. The gamut
//! map between them is `look::gamut_map` (gmKernel_v7, same constants as for Fuji/Sony).
//!
//! Both run on scene-linear Display P3 after the exposure gain, in sensor coordinates.

use crate::dng::GainTableMap;
use crate::image::RgbImage;
use rayon::prelude::*;

/// profileGainTableMap: per pixel, a gain looked up from a `points_v x points_h` grid of
/// 1-D tables indexed by a weighted mix of R, G, B, min and max, bilinear across the grid
/// and linear along the table. `strength` 1 = as recorded.
pub fn gain_table_map(img: &mut RgbImage, m: &GainTableMap, strength: f32) {
  if strength == 0.0 {
    return;
  }
  let (w, h) = (img.width as f64, img.height as f64);
  let iw = img.width;
  let (n, ph, pv) = (m.points_n, m.points_h, m.points_v);
  let (sx, sy) = (m.spacing_h * w, m.spacing_v * h);
  let (ox, oy) = (m.origin_h * w, m.origin_v * h);
  let eps = 0.00001;
  img.rows_mut().for_each(|(y, row)| {
    // Row position in map units (top-down; matches RawCamera's flipped lookup).
    let fv = (((y as f64 + 0.5) - oy) / sy).clamp(0.0, (pv - 1) as f64 * (1.0 - eps));
    let v0 = fv.floor() as usize;
    let v1 = (v0 + 1).min(pv - 1);
    let tv = (fv - v0 as f64) as f32;
    for x in 0..iw {
      let p = &mut row[x * 3..x * 3 + 3];
      let fh = (((x as f64 + 0.5) - ox) / sx).clamp(0.0, ph as f64 - eps);
      let h0 = fh.floor() as usize;
      let h1 = (h0 + 1).min(ph - 1);
      let th = (fh - h0 as f64) as f32;
      let mx = p[0].max(p[1]).max(p[2]);
      let mn = p[0].min(p[1]).min(p[2]);
      let wt = m.weights;
      let mut idx = p[0] * wt[0] + p[1] * wt[1] + p[2] * wt[2] + mn * wt[3] + mx * wt[4];
      if m.gamma != 1.0 {
        idx = idx.max(0.0).powf(m.gamma);
      }
      let pos = idx.clamp(0.0, 1.0) * (n - 1) as f32;
      let i0 = (pos.floor() as usize).min(n - 1);
      let i1 = (i0 + 1).min(n - 1);
      let ti = pos - i0 as f32;
      let lut = |v: usize, hh: usize| {
        let base = (v * ph + hh) * n;
        m.table[base + i0] + (m.table[base + i1] - m.table[base + i0]) * ti
      };
      // Bilinear across rows (as the GPU sampler does), linear across columns.
      let col = |hh: usize| lut(v0, hh) + (lut(v1, hh) - lut(v0, hh)) * tv;
      let gain = col(h0) + (col(h1) - col(h0)) * th;
      let g = 1.0 + (gain - 1.0) * strength;
      for c in p.iter_mut() {
        *c *= g;
      }
    }
  });
}

/// boost_lut with RawCamera's DNG parameters: a 256-entry LUT sampled from
/// `ProfileToneCurve`, linear extension above 1 with the curve's end slope, a shadow
/// gain easing from `shadow` (0.9) to 1 over 0-0.1, and `amount` mixing with the input.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ToneLut {
  #[serde(with = "crate::smart_preview::float_array")]
  lut: [f32; 256],
  slope: f32,
  shadow: f32,
}

impl ToneLut {
  pub(crate) fn valid_portable(&self) -> bool {
    self.lut.iter().all(|v| v.is_finite()) && self.slope.is_finite() && self.shadow.is_finite()
  }

  pub fn from_curve(curve: &[(f32, f32)]) -> Self {
    let eval = |x: f32| -> f32 {
      if curve.len() < 2 {
        return x;
      }
      let i = curve.partition_point(|p| p.0 < x).clamp(1, curve.len() - 1);
      let (a, b) = (curve[i - 1], curve[i]);
      if b.0 <= a.0 {
        return b.1;
      }
      a.1 + (b.1 - a.1) * ((x - a.0) / (b.0 - a.0)).clamp(0.0, 1.0)
    };
    let lut = std::array::from_fn(|i| eval(i as f32 / 255.0));
    let slope = match curve {
      [.., a, b] if b.0 > a.0 => (b.1 - a.1) / (b.0 - a.0),
      _ => 1.0,
    };
    Self {
      lut,
      slope,
      shadow: 0.9,
    }
  }

  #[inline]
  fn channel(&self, x: f32) -> f32 {
    let out = if x - 1.0 < 0.0 {
      let pos = (x * 255.0).clamp(0.0, 255.0);
      let i = (pos.floor() as usize).min(254);
      self.lut[i] + (self.lut[i + 1] - self.lut[i]) * (pos - i as f32)
    } else {
      (x - 1.0) * self.slope + 1.0
    };
    let t = (x / 0.1).clamp(0.0, 1.0);
    let s = t * t * (3.0 - 2.0 * t);
    out * (self.shadow + (1.0 - self.shadow) * s)
  }

  pub fn apply(&self, p: [f32; 3], amount: f32) -> [f32; 3] {
    p.map(|x| x + (self.channel(x) - x) * amount)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn identity_curve_is_identity_above_shadows() {
    let t = ToneLut::from_curve(&[(0.0, 0.0), (1.0, 1.0)]);
    for x in [0.2f32, 0.5, 0.9, 1.5] {
      assert!((t.apply([x; 3], 1.0)[0] - x).abs() < 1e-5, "{x}");
    }
    assert!((t.apply([0.05; 3], 1.0)[0] - 0.05 * 0.95).abs() < 1e-3);
  }

  #[test]
  fn unit_gain_map_is_identity() {
    let m = GainTableMap {
      points_v: 2,
      points_h: 2,
      spacing_v: 1.0,
      spacing_h: 1.0,
      origin_v: 0.0,
      origin_h: 0.0,
      points_n: 3,
      weights: [0.3, 0.3, 0.3, 0.0, 0.1],
      gamma: 1.0,
      table: vec![1.0; 12],
    };
    let mut im = RgbImage::new(8, 6);
    im.data.iter_mut().for_each(|v| *v = 0.4);
    gain_table_map(&mut im, &m, 1.0);
    assert!(im.data.iter().all(|&v| (v - 0.4).abs() < 1e-6));
  }
}
