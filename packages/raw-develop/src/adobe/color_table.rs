//! Modern Camera Raw profile colour tables. Reconstructed from DNG Converter
//! 18.7's `SIMDHueSatMap2D/3D` and checked against CPU tile captures. Interpolation
//! is hue, then value, then saturation; the encoded 3D path uses the observed
//! rational/polynomial sRGB approximations rather than a sampled SDK table.

use super::dcp::HueSatMap;

#[cfg(target_arch = "aarch64")]
mod batched;

/// The 16-bit black-removal boundary before profile colour conversion.
pub(crate) fn remove_black_table(black: f64) -> Vec<u16> {
  super::bayer::tables::expand(|x| ((x - black) / (1.0 - black)).clamp(0.0, 1.0))
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct ColorTable {
  dims: [usize; 3],
  // Pad each entry so SIMD never reads past the final profile coefficient.
  data: Vec<[f32; 4]>,
  encoded: bool,
  gain: f32,
  amount: f32,
  overrange: bool,
}

impl ColorTable {
  pub(crate) fn valid_portable(&self) -> bool {
    super::dcp::valid_dims(self.dims, self.data.len())
      && self.data.iter().flatten().all(|v| v.is_finite())
      && self.gain.is_finite()
      && self.amount.is_finite()
  }

  /// Independent pixel lanes share HSV/encoding arithmetic; table gathers keep
  /// the scalar coefficient interpolation and its hue/value/saturation order.
  pub(crate) fn pixels4(&self, pixels: [[f32; 3]; 4]) -> [[f32; 3]; 4] {
    #[cfg(target_arch = "aarch64")]
    {
      batched::apply(self, pixels)
    }
    #[cfg(not(target_arch = "aarch64"))]
    pixels.map(|p| self.pixel(p))
  }

  pub(crate) fn new(
    map: &HueSatMap,
    encoded: bool,
    gain: f32,
    amount: f32,
    overrange: bool,
  ) -> Self {
    Self {
      dims: map.dims,
      data: map
        .data
        .iter()
        .map(|p| [p[0] * (1.0 / 60.0), p[1], p[2], 0.0])
        .collect(),
      encoded,
      gain,
      amount,
      overrange,
    }
  }

  #[inline]
  pub(crate) fn pixel(&self, mut p: [f32; 3]) -> [f32; 3] {
    let [hd, sd, vd] = self.dims;
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
    let delta = self.interpolate(hi, si, vi, hf, sf, vf);
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

  #[inline]
  fn interpolate(&self, hi: usize, si: usize, vi: usize, hf: f32, sf: f32, vf: f32) -> [f32; 3] {
    let [hd, sd, vd] = self.dims;
    let plane = hd * sd;
    let base = vi * plane + si;
    // Resolve hue wrap and the four/eight table addresses once per pixel,
    // rather than repeating integer division and indexing for every channel.
    let h0 = hi * sd;
    let h1 = if hi + 1 == hd { 0 } else { (hi + 1) * sd };
    let mut low = lerp(self.data[base + h0], self.data[base + h1], hf);
    let mut high = lerp(self.data[base + h0 + 1], self.data[base + h1 + 1], hf);
    if vd > 1 {
      let base = base + plane;
      let next_low = lerp(self.data[base + h0], self.data[base + h1], hf);
      let next_high = lerp(self.data[base + h0 + 1], self.data[base + h1 + 1], hf);
      low = lerp(low, next_low, vf);
      high = lerp(high, next_high, vf);
    }
    // Preserve the native hue -> value -> saturation FMA boundaries.
    let delta = lerp(low, high, sf);
    [delta[0], delta[1], delta[2]]
  }
}

/// Independent coefficient lanes, preserving the rounded product and native
/// FMA. There are no reciprocal estimates or horizontal floating-point sums.
#[inline(always)]
fn lerp(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
  #[cfg(target_arch = "aarch64")]
  {
    use std::arch::aarch64::*;
    let mut out = [0.0; 4];
    // AArch64 includes NEON/FMA; each pointer addresses four valid floats.
    unsafe {
      let product = vmulq_n_f32(vld1q_f32(a.as_ptr()), 1.0 - t);
      vst1q_f32(
        out.as_mut_ptr(),
        vfmaq_n_f32(product, vld1q_f32(b.as_ptr()), t),
      );
    }
    out
  }
  #[cfg(not(target_arch = "aarch64"))]
  {
    // Exact portable fallback; LLVM can vectorize it on FMA-enabled targets.
    std::array::from_fn(|c| t.mul_add(b[c], (1.0 - t) * a[c]))
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
