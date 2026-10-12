//! Rendering ("look"): scene-linear Display P3 to display-referred linear Display P3.
//!
//! A port of the three colour kernels RawCamera runs after the camera matrix, in order:
//!
//! 1. `hue_magnet` (RAWHueMagnetMR): nudges orange hues (r > b > g) towards red.
//! 2. `gamut_map` (gmKernel_v7): compresses colours towards a luminance anchor so every
//!    component lands in 0-1, with extra desaturation for saturated blues/magentas and a
//!    green push that keeps bright yellows yellow.
//! 3. `boost` (boost_v7): a piecewise-cubic tone curve applied per channel, then partly
//!    re-mixed to the input's hue ("hue-preserving blend").
//!
//! The output is still linear; the caller applies the Display P3 (sRGB) transfer.

/// boost_v7 parameters. RawCamera uses the same values for every camera and file we
/// have observed (see docs/color.md).
#[derive(Clone, Copy, Debug)]
pub struct Boost {
  pub breaks: [f32; 4],
  pub c1: [f32; 4],
  pub c2: [f32; 4],
  pub c3: [f32; 4],
  pub c4a: [f32; 4],
  pub c4b: [f32; 4],
  pub blend: f32,
  pub preserve_hue1: [f32; 3],
  pub preserve_hue2: [f32; 3],
}

impl Default for Boost {
  fn default() -> Self {
    Self {
      breaks: [0.1, 0.2, 0.5, 1.0],
      c1: [-61.09, 18.418, 0.7191, 0.0],
      c2: [-12.3, 2.62, 2.415, -0.0604],
      c3: [2.64815, -4.82889, 3.60078, -0.119185],
      c4a: [0.492, -1.72, 2.109, 0.119],
      c4b: [0.0, 0.0, 0.758, 0.426],
      blend: 0.0,
      preserve_hue1: [0.25, 0.0, 0.0],
      preserve_hue2: [0.0, 0.0, 0.0],
    }
  }
}

#[inline]
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
  let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
  t * t * (3.0 - 2.0 * t)
}

#[inline]
fn maxv(p: [f32; 3]) -> f32 {
  p[0].max(p[1]).max(p[2])
}

#[inline]
fn minv(p: [f32; 3]) -> f32 {
  p[0].min(p[1]).min(p[2])
}

/// RAWHueMagnetMR.
#[inline]
pub fn hue_magnet(p: [f32; 3], amt: f32) -> [f32; 3] {
  let [r, g, b] = p;
  if r > b && r > g && b > g {
    let k = 24.0 * amt * (b - g) * (r - b) / (r - g);
    [r, g, b - k]
  } else {
    p
  }
}

/// gmKernel_v7 with RawCamera's constants (maxValue 1).
#[inline]
pub fn gamut_map(t: [f32; 3]) -> [f32; 3] {
  const PUSH_YELLOW: f32 = 1.3;
  const CENTER: f32 = 0.05;
  const SCALE: f32 = 0.25;
  const MB_ADD_LIGHT: f32 = 0.5;
  const MB_DESAT: f32 = 0.6;

  let tmax0 = maxv(t);
  let tmin0 = minv(t);
  let k_mb = smoothstep(0.0, 0.75, ((t[2] - t[1]) + (t[2] - t[0])).max(0.0));

  let near = ((1.0 - tmin0 - 1.0) * 2.0 + 1.0).clamp(0.0, 1.0);
  let near = near * near;

  let mut yellow = smoothstep(0.6, 2.0, tmax0);
  yellow *= ((t[1] - tmin0) * (tmax0 - t[1]) / (0.00001 + tmax0 - tmin0)).max(0.0);
  if t[0] - t[2] < 0.0 {
    yellow = 0.0;
  }

  // sat_dist(c) = length(2c - c.zxy - c.yzx)
  let sd = {
    let a = 2.0 * t[0] - t[2] - t[1];
    let b = 2.0 * t[1] - t[0] - t[2];
    let c = 2.0 * t[2] - t[1] - t[0];
    (a * a + b * b + c * c).sqrt()
  };
  let md = sd * MB_DESAT * near * k_mb;

  let k = t[0] * 0.35 + t[1] * 0.40 + t[2] * 0.25;
  let mixed = SCALE + (1.0 - SCALE) * (k_mb * MB_ADD_LIGHT + 0.5 * yellow);
  let k = ((k - CENTER) * mixed + CENTER).clamp(0.0, 1.0);

  // Per channel: largest scale s <= 1 keeping k + (t - k) * s within [0, 1].
  // Division by zero follows IEEE semantics like the GPU (inf/nan fall out via min/max).
  let mut scale = 1.0f32;
  for &v in &t {
    let d = v - k;
    let s = ((1.0 - k) / d).max((0.0 - k) / d).min(1.0);
    if !s.is_nan() {
      scale = scale.min(s);
    }
  }
  scale = scale.min(1.0 / (1.0 + md));
  let mut o = t.map(|v| (v - k) * scale + k);

  let tmax = maxv(o);
  let tmin = minv(o);
  let mut add_green = PUSH_YELLOW * smoothstep(0.6, 2.0, tmax0);
  add_green *= ((o[1] - tmin) * (tmax - o[1]) / (0.00001 + tmax - tmin)).max(0.0);
  // compare(r - b, 0.1, 1.0): 0.1 when r < b.
  if o[0] - o[2] < 0.0 {
    add_green *= 0.1;
  }
  o[1] += add_green;
  o
}

#[inline]
fn cubic(x: f32, c: [f32; 4]) -> f32 {
  c[0] * x * x * x + c[1] * x * x + c[2] * x + c[3]
}

/// boost_v7.
#[inline]
pub fn boost(i: [f32; 3], b: &Boost) -> [f32; 3] {
  let imin = minv(i);
  let imax = maxv(i);

  let w = (i[0].min(i[1]) + 1.0 - i[2].max(i[1]) + 1.5 * imin.max(0.0)).clamp(0.0, 1.0);
  let c4: [f32; 4] = std::array::from_fn(|k| b.c4b[k] + (b.c4a[k] - b.c4b[k]) * w);
  let scale_above1 = c4[0] * 3.0 + c4[1] * 2.0 + c4[2];
  let val_at1 = c4[0] + c4[1] + c4[2] + c4[3];

  let o = i.map(|v| {
    if v < 0.0 {
      // mix(coeffs1.b * v, v, smoothstep(0, 0.44, -v))
      let a = b.c1[2] * v;
      a + (v - a) * smoothstep(0.0, 0.44, -v)
    } else if v < b.breaks[0] {
      cubic(v, b.c1)
    } else if v < b.breaks[1] {
      cubic(v, b.c2)
    } else if v < b.breaks[2] {
      cubic(v, b.c3)
    } else if v < b.breaks[3] {
      cubic(v, c4)
    } else {
      v * scale_above1 + val_at1 - scale_above1
    }
  });

  let omin = minv(o);
  let omax = maxv(o);
  let ir = imax - imin;
  let or = omax - omin;

  let mut bm = 0.3 + (b.blend - 0.3) * smoothstep(0.4, 0.8, imax);
  if i[1] <= imin || i[1] >= imax {
    bm = 1.0;
  }
  let (ph1, ph2) = (b.preserve_hue1, b.preserve_hue2);
  if i[2] <= imin && i[0] >= imax {
    bm += ph1[0];
  }
  if i[2] <= imin && i[1] >= imax {
    bm += ph1[1];
  }
  if i[0] <= imin && i[1] >= imax {
    bm += ph1[2];
  }
  if i[0] <= imin && i[2] >= imax {
    bm += ph2[0];
  }
  if i[1] <= imin && i[2] >= imax {
    bm += ph2[1];
  }
  if i[1] <= imin && i[0] >= imax {
    bm += ph2[2];
  }
  let bm = bm.clamp(0.0, 1.0);

  let odng = if ir > 0.00001 {
    std::array::from_fn(|k| omin + (i[k] - imin) * (or / ir))
  } else {
    o
  };
  std::array::from_fn(|k| o[k] + (odng[k] - o[k]) * bm)
}

/// The full look. `amount` 1 = RawCamera's look; 0 = no look (clamped linear).
#[inline]
pub fn render(p: [f32; 3], amount: f32, b: &Boost) -> [f32; 3] {
  let o = boost(gamut_map(hue_magnet(p, 0.03)), b);
  if amount >= 1.0 {
    o
  } else {
    std::array::from_fn(|k| p[k].clamp(0.0, 1.0) * (1.0 - amount) + o[k] * amount)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn neutral_axis_maps_monotonically_to_0_1() {
    let b = Boost::default();
    let mut prev = -1.0;
    for i in 0..=200 {
      let v = i as f32 / 100.0;
      let o = render([v, v, v], 1.0, &b);
      assert!(
        (o[0] - o[1]).abs() < 1e-5 && (o[1] - o[2]).abs() < 1e-5,
        "{v} {o:?}"
      );
      assert!(o[0] >= prev - 1e-6, "monotone at {v}");
      prev = o[0];
    }
    assert!(render([0.0; 3], 1.0, &b)[0].abs() < 1e-4);
    assert!((render([1.0; 3], 1.0, &b)[0] - 1.0).abs() < 0.02);
  }

  #[test]
  fn gamut_map_brings_out_of_gamut_colours_inside() {
    for p in [[-0.2, 0.5, 0.1], [1.5, 0.2, 0.1], [0.1, 0.1, 1.4]] {
      let q = gamut_map(p);
      assert!(
        q.iter().all(|&v| v > -1e-4 && v < 1.0 + 1.3),
        "{p:?} -> {q:?}"
      );
      assert!(q.iter().all(|&v| v > -1e-4), "{p:?} -> {q:?}");
    }
  }

  #[test]
  fn hue_magnet_only_touches_orange() {
    assert_eq!(hue_magnet([0.2, 0.5, 0.3], 0.03), [0.2, 0.5, 0.3]);
    let q = hue_magnet([0.8, 0.2, 0.4], 0.03);
    assert!(q[2] < 0.4);
  }
}
