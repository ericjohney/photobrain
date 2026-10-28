//! Adobe baseline render stages, reimplemented from Adobe's public DNG SDK reference
//! code (`dng_render.cpp`, `dng_reference.cpp`; SDK 1.4, Adobe's permissive DNG SDK
//! licence). This is Adobe's documented baseline rendering, not the closed Camera Raw
//! Process Version pipeline: colour matrices, the HueSatMap and LookTable, the exposure
//! ramp, the baseline exposure-compensation tone function, and the ACR3 default tone
//! curve. Working space is linear ProPhoto RGB, as in the SDK.

use super::dcp::HueSatMap;

/// ACR3 default tone curve (`dng_tone_curve_acr3_default`), public DNG SDK data.
pub use super::acr3::ACR3_DEFAULT as ACR3;

/// A monotone table sampled on `0..=1`, with linear interpolation, matching
/// `dng_1d_table` closely enough for an 8-bit output.
#[derive(Clone)]
pub struct Table1d {
  samples: Vec<f32>,
}

impl Table1d {
  pub fn from_fn(n: usize, f: impl Fn(f64) -> f64) -> Self {
    Self {
      samples: (0..=n).map(|i| f(i as f64 / n as f64) as f32).collect(),
    }
  }

  /// Evenly spaced samples over 0..1 (at least two).
  pub fn from_slice_ref(s: &[f32]) -> Self {
    Self {
      samples: s.to_vec(),
    }
  }

  /// `(x, y)` control points (monotone x in 0..1), resampled to `n` even steps.
  pub fn from_points(n: usize, pts: &[(f32, f32)]) -> Self {
    Self::from_fn(n, |x| interp_points(pts, x as f32) as f64)
  }

  #[inline]
  pub fn eval(&self, x: f32) -> f32 {
    let n = self.samples.len() - 1;
    let y = x.clamp(0.0, 1.0) * n as f32;
    let i = (y as usize).min(n - 1);
    let f = y - i as f32;
    self.samples[i] * (1.0 - f) + self.samples[i + 1] * f
  }
}

fn interp_points(pts: &[(f32, f32)], x: f32) -> f32 {
  if pts.is_empty() {
    return x;
  }
  if x <= pts[0].0 {
    return pts[0].1;
  }
  for w in pts.windows(2) {
    let (x0, y0) = w[0];
    let (x1, y1) = w[1];
    if x <= x1 {
      let t = if x1 > x0 { (x - x0) / (x1 - x0) } else { 0.0 };
      return y0 + (y1 - y0) * t;
    }
  }
  pts[pts.len() - 1].1
}

/// `dng_function_exposure_ramp`: linear map of `[black, white]` to `[0, 1]`, with a
/// smooth quadratic toe of radius `min(0.5*black, (1/16)/slope)` around `black`.
pub fn exposure_ramp(white: f64, black: f64) -> Table1d {
  let slope = 1.0 / (white - black);
  let radius = (0.5 * black).min((1.0 / 16.0) / slope);
  let qscale = if radius > 0.0 {
    slope / (4.0 * radius)
  } else {
    0.0
  };
  Table1d::from_fn(1024, move |x| {
    if x <= black - radius {
      0.0
    } else if x >= black + radius {
      ((x - black) * slope).min(1.0)
    } else {
      let y = x - (black - radius);
      qscale * y * y
    }
  })
}

/// `dng_function_exposure_tone`: fake negative exposure compensation by darkening the
/// tone curve. NOP for `exposure >= 0`.
pub fn exposure_tone(exposure: f64) -> impl Fn(f64) -> f64 {
  let nop = exposure >= 0.0;
  let slope = 2f64.powf(exposure);
  let a = 16.0 / 9.0 * (1.0 - slope);
  let b = slope - 0.5 * a;
  let c = 1.0 - a - b;
  move |x: f64| {
    if nop {
      x
    } else if x <= 0.25 {
      x * slope
    } else {
      (a * x + b) * x + c
    }
  }
}

/// Clip to `camera_white`, then `camera_to_rgb` matrix, clamped to 0..1
/// (`RefBaselineABCtoRGB`). `rgb` is overwritten in place.
#[inline]
pub fn abc_to_rgb(px: [f32; 3], camera_white: [f32; 3], m: &[[f32; 3]; 3]) -> [f32; 3] {
  let c = [0, 1, 2].map(|i| px[i].min(camera_white[i]));
  std::array::from_fn(|r| (m[r][0] * c[0] + m[r][1] * c[1] + m[r][2] * c[2]).clamp(0.0, 1.0))
}

/// Hue-preserving RGB tone (`RefBaselineRGBTone`): tone the max and min channels through
/// `table`, interpolate the middle channel by its position between them.
#[inline]
pub fn rgb_tone(px: [f32; 3], table: &Table1d) -> [f32; 3] {
  // Sort to lo <= mid <= hi, remembering original positions.
  let mut idx = [0usize, 1, 2];
  idx.sort_by(|&i, &j| px[i].partial_cmp(&px[j]).unwrap());
  let (lo, mid, hi) = (px[idx[0]], px[idx[1]], px[idx[2]]);
  let tlo = table.eval(lo);
  let thi = table.eval(hi);
  let tmid = if hi > lo {
    tlo + (thi - tlo) * (mid - lo) / (hi - lo)
  } else {
    table.eval(mid)
  };
  let mut out = [0.0f32; 3];
  out[idx[0]] = tlo;
  out[idx[1]] = tmid;
  out[idx[2]] = thi;
  out
}

/// `RefBaselineHueSatMap`: trilinear HSV warp. `encode`/`decode` apply the sRGB value
/// encoding when the profile's table encoding is not linear (DNG spec: value axis is
/// sampled in the encoded domain).
pub fn hue_sat_map(px: [f32; 3], lut: &HueSatMap, encode: Option<&Table1d>) -> [f32; 3] {
  let [hd, sd, vd] = lut.dims;
  let (mut h, s, mut v) = rgb_to_hsv(px);
  let h_scale = if hd < 2 { 0.0 } else { hd as f32 / 6.0 };
  let s_scale = (sd - 1) as f32;
  let v_scale = (vd - 1) as f32;

  let v_encoded = match (vd >= 2, encode) {
    (true, Some(e)) => e.eval(v.clamp(0.0, 1.0)),
    _ => v,
  };

  let hs = h * h_scale;
  let ss = s * s_scale;
  let vs = v_encoded * v_scale;
  let h0 = hs as usize;
  let s0 = (ss as usize).min(sd.saturating_sub(2));
  let (h0, h1, hf) = {
    let hf = hs - h0 as f32;
    if h0 >= hd - 1 {
      (hd - 1, 0, hf)
    } else {
      (h0, h0 + 1, hf)
    }
  };
  let sf = ss - s0 as f32;
  let (v0, v1, vf) = if vd < 2 {
    (0, 0, 0.0)
  } else {
    let v0 = (vs as usize).min(vd - 2);
    (v0, v0 + 1, vs - v0 as f32)
  };

  let at = |vi: usize, hi: usize, si: usize| lut.data[(vi * hd + hi) * sd + si];
  let lerp3 = |a: [f32; 3], b: [f32; 3], t: f32| std::array::from_fn(|k| a[k] + (b[k] - a[k]) * t);
  // sat interpolation
  let edge = |vi: usize, hi: usize| lerp3(at(vi, hi, s0), at(vi, hi, s0 + 1), sf);
  // hue interpolation
  let plane = |vi: usize| lerp3(edge(vi, h0), edge(vi, h1), hf);
  let acc = lerp3(plane(v0), plane(v1), vf);

  h += acc[0] * (6.0 / 360.0);
  let s = (s * acc[1]).min(1.0);
  let v_new = (v_encoded * acc[2]).clamp(0.0, 1.0);
  v = match (vd >= 2, encode) {
    (true, Some(e)) => decode_via(e, v_new),
    _ => v_new,
  };
  hsv_to_rgb(h, s, v)
}

/// Invert a monotone encode table by binary search over its samples.
fn decode_via(encode: &Table1d, y: f32) -> f32 {
  let n = encode.samples.len() - 1;
  // samples are increasing; find bracketing index
  let (mut lo, mut hi) = (0usize, n);
  while hi - lo > 1 {
    let mid = (lo + hi) / 2;
    if encode.samples[mid] < y {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  let (y0, y1) = (encode.samples[lo], encode.samples[hi]);
  let t = if y1 > y0 { (y - y0) / (y1 - y0) } else { 0.0 };
  (lo as f32 + t) / n as f32
}

/// `DNG_RGBtoHSV`: hue in `[0,6)`, s and v in `[0,1]`.
#[inline]
pub fn rgb_to_hsv(c: [f32; 3]) -> (f32, f32, f32) {
  let v = c[0].max(c[1]).max(c[2]);
  let min = c[0].min(c[1]).min(c[2]);
  let gap = v - min;
  if gap <= 0.0 {
    return (0.0, 0.0, v);
  }
  let h = if c[0] == v {
    let h = (c[1] - c[2]) / gap;
    if h < 0.0 { h + 6.0 } else { h }
  } else if c[1] == v {
    2.0 + (c[2] - c[0]) / gap
  } else {
    4.0 + (c[0] - c[1]) / gap
  };
  (h, gap / v, v)
}

/// `DNG_HSVtoRGB`.
#[inline]
pub fn hsv_to_rgb(h: f32, s: f32, v: f32) -> [f32; 3] {
  if s <= 0.0 {
    return [v, v, v];
  }
  let h = h.rem_euclid(6.0);
  let i = h as usize;
  let f = h - i as f32;
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let t = v * (1.0 - s * (1.0 - f));
  match i {
    0 => [v, t, p],
    1 => [q, v, p],
    2 => [p, v, t],
    3 => [p, q, v],
    4 => [t, p, v],
    _ => [v, p, q],
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn hsv_roundtrip() {
    for c in [
      [0.2, 0.5, 0.8],
      [0.9, 0.1, 0.3],
      [0.4, 0.4, 0.4],
      [1.0, 0.0, 0.0],
    ] {
      let (h, s, v) = rgb_to_hsv(c);
      let r = hsv_to_rgb(h, s, v);
      for k in 0..3 {
        assert!((r[k] - c[k]).abs() < 1e-5, "{c:?} -> {r:?}");
      }
    }
  }

  #[test]
  fn rgb_tone_preserves_order_and_grey() {
    let t = Table1d::from_slice_ref(&ACR3);
    let g = rgb_tone([0.5, 0.5, 0.5], &t);
    assert!((g[0] - g[1]).abs() < 1e-6 && (g[1] - g[2]).abs() < 1e-6);
    let o = rgb_tone([0.1, 0.5, 0.9], &t);
    assert!(o[0] <= o[1] && o[1] <= o[2]);
  }

  #[test]
  fn exposure_ramp_endpoints() {
    let r = exposure_ramp(1.0, 0.0);
    assert!(r.eval(0.0).abs() < 1e-6);
    assert!((r.eval(1.0) - 1.0).abs() < 1e-3);
  }

  #[test]
  fn identity_hue_sat_map_is_noop() {
    let lut = HueSatMap {
      dims: [2, 2, 1],
      data: vec![[0.0, 1.0, 1.0]; 4],
    };
    let o = hue_sat_map([0.3, 0.6, 0.2], &lut, None);
    for k in 0..3 {
      assert!((o[k] - [0.3, 0.6, 0.2][k]).abs() < 1e-5);
    }
  }
}
