//! Modern Camera Raw profile colour tables. Reconstructed from DNG Converter
//! 18.7's `SIMDHueSatMap2D/3D` and checked against CPU tile captures. Interpolation
//! is hue, then value, then saturation; the encoded 3D path uses the observed
//! rational/polynomial sRGB approximations rather than a sampled SDK table.

use super::dcp::HueSatMap;

/// The 16-bit black-removal boundary before profile colour conversion.
pub(crate) fn remove_black_table(black: f64) -> Vec<u16> {
  super::bayer::tables::expand(|x| ((x - black) / (1.0 - black)).clamp(0.0, 1.0))
}

#[derive(Clone, Debug)]
pub(crate) struct ColorTable {
  map: HueSatMap,
  encoded: bool,
  gain: f32,
  amount: f32,
  overrange: bool,
}

impl ColorTable {
  pub(crate) fn new(
    map: &HueSatMap,
    encoded: bool,
    gain: f32,
    amount: f32,
    overrange: bool,
  ) -> Self {
    let mut map = map.clone();
    for p in &mut map.data {
      p[0] *= 1.0 / 60.0;
    }
    Self {
      map,
      encoded,
      gain,
      amount,
      overrange,
    }
  }

  #[inline]
  pub(crate) fn pixel(&self, mut p: [f32; 3]) -> [f32; 3] {
    let [hd, sd, vd] = self.map.dims;
    if self.overrange {
      p = p.map(|x| x.max(0.0));
      if vd > 1 {
        p = p.map(|x| x * (x.mul_add(1.0 / 256.0, 1.0)) / (x + 1.0));
      }
    }
    let (mut h, s, v) = to_hsv(p);
    let hs = h * if hd > 1 { hd as f32 * (1.0 / 6.0) } else { 0.0 };
    let ss = s * (sd - 1) as f32;
    let hi = (hs as usize).min(hd - 1);
    let si = (ss as usize).min(sd - 2);
    let hf = hs - hi as f32;
    let sf = ss - si as f32;
    let (vi, vf) = if vd > 1 {
      let mut x = (self.gain * v).clamp(0.0, 1.0);
      if self.encoded {
        x = encode(x);
      }
      let x = x * (vd - 1) as f32;
      let i = (x as usize).min(vd - 2);
      (i, x - i as f32)
    } else {
      (0, 0.0)
    };
    let at = |v: usize, h: usize, s: usize, c: usize| self.map.data[(v * hd + h % hd) * sd + s][c];
    let hue =
      |v: usize, s: usize, c: usize| hf.mul_add(at(v, hi + 1, s, c), (1.0 - hf) * at(v, hi, s, c));
    let value = |s: usize, c: usize| {
      let low = hue(vi, s, c);
      if vd > 1 {
        vf.mul_add(hue(vi + 1, s, c), (1.0 - vf) * low)
      } else {
        low
      }
    };
    let delta: [f32; 3] =
      std::array::from_fn(|c| sf.mul_add(value(si + 1, c), (1.0 - sf) * value(si, c)));
    h = self.amount.mul_add(delta[0], h);
    let saturation = s * (1.0 + self.amount * (delta[1] - 1.0)).max(0.0);
    let scale = (1.0 + self.amount * (delta[2] - 1.0)).max(0.0);
    let mut value = if vd > 1 && self.encoded {
      let x = encode(v) * scale;
      decode(if self.overrange { x } else { x.clamp(0.0, 1.0) })
    } else {
      v * scale
    };
    if !self.overrange && !(vd > 1 && self.encoded) {
      value = value.min(1.0);
    }
    let mut out = hsv(h, saturation.min(1.0), value);
    if self.overrange && vd > 1 {
      out = out.map(|v| {
        let d = v - 1.0;
        (d + v.mul_add(1.0 / 64.0, d * d).sqrt()) * 128.0
      });
    }
    out
  }
}

#[inline]
fn hsv(mut h: f32, s: f32, v: f32) -> [f32; 3] {
  if h < 0.0 {
    h += 6.0;
  }
  if h >= 6.0 {
    h -= 6.0;
  }
  let swap_bg = h > 3.0;
  h = h.min(6.0 - h);
  let swap_r = h > 2.0;
  h = h.min(4.0 - h);
  let swap_hi = h > 1.0;
  h = h.min(2.0 - h);
  let lo = (1.0 - s) * v;
  let mid = h.mul_add(v - lo, lo);
  let a = if swap_hi { v } else { mid };
  let b = if swap_hi { mid } else { v };
  let r = if swap_r { lo } else { b };
  let c = if swap_r { b } else { lo };
  [r, if swap_bg { c } else { a }, if swap_bg { a } else { c }]
}

#[inline]
fn to_hsv([r, g, b]: [f32; 3]) -> (f32, f32, f32) {
  let swap_bg = b > g;
  let gb_hi = b.max(g);
  let gb_lo = b.min(g);
  let swap_r = gb_lo > r;
  let candidate = gb_lo.max(r);
  let lo = gb_lo.min(r);
  let swap_hi = gb_hi > candidate;
  let hi = gb_hi.max(candidate);
  let mid = gb_hi.min(candidate);
  let delta = hi - lo;
  let mut h = (mid - lo) * (1.0 / delta.max(1e-37));
  if swap_hi {
    h = 2.0 - h;
  }
  if swap_r {
    h = 4.0 - h;
  }
  if swap_bg {
    h = 6.0 - h;
  }
  let v = hi.max(0.0);
  (h, delta * (1.0 / v.max(1e-37)), v)
}

#[inline]
fn encode(x: f32) -> f32 {
  if x <= 0.0031308 {
    return x * 12.92;
  }
  if x > 1.0 {
    return x.mul_add(0.43958333, 0.5604167);
  }
  let n = x
    .mul_add(-2933.796, 17194.686)
    .mul_add(x, 27859.484)
    .mul_add(x, 2824.8418)
    .mul_add(x, 24.51809)
    .mul_add(x, -0.018882371);
  let d = x
    .mul_add(34216.645, 10431.28)
    .mul_add(x, 329.89874)
    .mul_add(x, 1.0);
  n / d
}

#[inline]
fn decode(x: f32) -> f32 {
  if x <= 0.040449936 {
    return x * 0.07739938;
  }
  if x > 1.0 {
    return (x + 0.43958333 - 1.0) * 2.2748816;
  }
  x.mul_add(-0.12352849, 0.41711086)
    .mul_add(x, -0.630521)
    .mul_add(x, 0.81013817)
    .mul_add(x, 0.490754)
    .mul_add(x, 0.035080373)
    .mul_add(x, 0.0008571991)
}

#[cfg(test)]
mod tests;
