//! Independent AArch64 pixel lanes for profile colour. Gathered coefficients
//! still use the scalar table interpolation, with no horizontal float sums.

use super::ColorTable;
use std::arch::aarch64::*;

#[inline(always)]
fn splat(x: f32) -> float32x4_t {
  // NEON is baseline on AArch64.
  unsafe { vdupq_n_f32(x) }
}

#[inline(always)]
fn array(x: float32x4_t) -> [f32; 4] {
  let mut out = [0.0; 4];
  unsafe { vst1q_f32(out.as_mut_ptr(), x) };
  out
}

#[inline(always)]
fn vector(x: [f32; 4]) -> float32x4_t {
  unsafe { vld1q_f32(x.as_ptr()) }
}

#[inline(always)]
fn clamp(x: float32x4_t) -> float32x4_t {
  // Comparisons preserve f32::clamp's NaNs and signed zero.
  unsafe {
    vbslq_f32(
      vcltq_f32(x, splat(0.0)),
      splat(0.0),
      vbslq_f32(vcgtq_f32(x, splat(1.0)), splat(1.0), x),
    )
  }
}

#[inline(always)]
fn encode(x: float32x4_t) -> float32x4_t {
  unsafe {
    let mut n = vfmaq_f32(splat(17194.686), x, splat(-2933.796));
    for c in [27859.484, 2824.8418, 24.51809, -0.018882371] {
      n = vfmaq_f32(splat(c), n, x);
    }
    let mut d = vfmaq_f32(splat(10431.28), x, splat(34216.645));
    for c in [329.89874, 1.0] {
      d = vfmaq_f32(splat(c), d, x);
    }
    vbslq_f32(
      vcleq_f32(x, splat(0.0031308)),
      vmulq_f32(x, splat(12.92)),
      vbslq_f32(
        vcgtq_f32(x, splat(1.0)),
        vfmaq_f32(splat(0.5604167), x, splat(0.43958333)),
        vdivq_f32(n, d),
      ),
    )
  }
}

#[inline(always)]
fn decode(x: float32x4_t) -> float32x4_t {
  unsafe {
    let mut n = vfmaq_f32(splat(0.41711086), x, splat(-0.12352849));
    for c in [-0.630521, 0.81013817, 0.490754, 0.035080373, 0.0008571991] {
      n = vfmaq_f32(splat(c), n, x);
    }
    vbslq_f32(
      vcleq_f32(x, splat(0.040449936)),
      vmulq_f32(x, splat(0.07739938)),
      vbslq_f32(
        vcgtq_f32(x, splat(1.0)),
        vmulq_f32(
          vsubq_f32(vaddq_f32(x, splat(0.43958333)), splat(1.0)),
          splat(2.2748816),
        ),
        n,
      ),
    )
  }
}

pub(super) fn apply(table: &ColorTable, pixels: [[f32; 3]; 4]) -> [[f32; 3]; 4] {
  let [hd, sd, vd] = table.dims;
  // Every load/store addresses a complete four-float array or twelve-float RGB
  // batch. All profile coefficient accesses retain checked scalar indexing.
  unsafe {
    let float32x4x3_t(mut r, mut g, mut b) = vld3q_f32(pixels.as_ptr().cast());
    let zero = splat(0.0);
    let one = splat(1.0);
    if table.overrange {
      let convert = |x| {
        let x = vmaxnmq_f32(x, zero);
        if vd > 1 {
          vdivq_f32(
            vmulq_f32(x, vfmaq_f32(one, x, splat(1.0 / 256.0))),
            vaddq_f32(x, one),
          )
        } else {
          x
        }
      };
      r = convert(r);
      g = convert(g);
      b = convert(b);
    }
    let swap_bg = vcgtq_f32(b, g);
    let gb_hi = vmaxnmq_f32(b, g);
    let gb_lo = vminnmq_f32(b, g);
    let swap_r = vcgtq_f32(gb_lo, r);
    let candidate = vmaxnmq_f32(gb_lo, r);
    let lo = vminnmq_f32(gb_lo, r);
    let swap_hi = vcgtq_f32(gb_hi, candidate);
    let hi = vmaxnmq_f32(gb_hi, candidate);
    let mid = vminnmq_f32(gb_hi, candidate);
    let delta = vsubq_f32(hi, lo);
    let mut h = vmulq_f32(
      vsubq_f32(mid, lo),
      vdivq_f32(one, vmaxnmq_f32(delta, splat(1e-37))),
    );
    h = vbslq_f32(swap_hi, vsubq_f32(splat(2.0), h), h);
    h = vbslq_f32(swap_r, vsubq_f32(splat(4.0), h), h);
    h = vbslq_f32(swap_bg, vsubq_f32(splat(6.0), h), h);
    let v = vmaxnmq_f32(hi, zero);
    let s = vmulq_f32(delta, vdivq_f32(one, vmaxnmq_f32(v, splat(1e-37))));
    let hs = array(vmulq_f32(
      h,
      splat(if hd > 1 { hd as f32 * (1.0 / 6.0) } else { 0.0 }),
    ));
    let ss = array(vmulq_f32(s, splat((sd - 1) as f32)));
    let (vi, vf) = if vd > 1 {
      let mut x = clamp(vmulq_f32(splat(table.gain), v));
      if table.encoded {
        x = encode(x);
      }
      let x = array(vmulq_f32(x, splat((vd - 1) as f32)));
      let vi = x.map(|x| (x as usize).min(vd - 2));
      (vi, std::array::from_fn(|i| x[i] - vi[i] as f32))
    } else {
      ([0; 4], [0.0; 4])
    };
    let coefficients: [[f32; 3]; 4] = std::array::from_fn(|i| {
      let hi = (hs[i] as usize).min(hd - 1);
      let si = (ss[i] as usize).min(sd - 2);
      table.interpolate(hi, si, vi[i], hs[i] - hi as f32, ss[i] - si as f32, vf[i])
    });
    let coefficient = |c| vector(coefficients.map(|p| p[c]));
    h = vfmaq_f32(h, splat(table.amount), coefficient(0));
    let saturation = vmulq_f32(
      s,
      vmaxnmq_f32(
        vaddq_f32(
          one,
          vmulq_f32(splat(table.amount), vsubq_f32(coefficient(1), one)),
        ),
        zero,
      ),
    );
    let scale = vmaxnmq_f32(
      vaddq_f32(
        one,
        vmulq_f32(splat(table.amount), vsubq_f32(coefficient(2), one)),
      ),
      zero,
    );
    let mut value = if vd > 1 && table.encoded {
      let x = vmulq_f32(encode(v), scale);
      decode(if table.overrange { x } else { clamp(x) })
    } else {
      vmulq_f32(v, scale)
    };
    if !table.overrange && !(vd > 1 && table.encoded) {
      value = vminnmq_f32(value, one);
    }
    let saturation = vminnmq_f32(saturation, one);
    h = vbslq_f32(vcltq_f32(h, zero), vaddq_f32(h, splat(6.0)), h);
    h = vbslq_f32(vcgeq_f32(h, splat(6.0)), vsubq_f32(h, splat(6.0)), h);
    let swap_bg = vcgtq_f32(h, splat(3.0));
    h = vminnmq_f32(h, vsubq_f32(splat(6.0), h));
    let swap_r = vcgtq_f32(h, splat(2.0));
    h = vminnmq_f32(h, vsubq_f32(splat(4.0), h));
    let swap_hi = vcgtq_f32(h, one);
    h = vminnmq_f32(h, vsubq_f32(splat(2.0), h));
    let lo = vmulq_f32(vsubq_f32(one, saturation), value);
    let mid = vfmaq_f32(lo, h, vsubq_f32(value, lo));
    let a = vbslq_f32(swap_hi, value, mid);
    let b = vbslq_f32(swap_hi, mid, value);
    let r = vbslq_f32(swap_r, lo, b);
    let c = vbslq_f32(swap_r, b, lo);
    let g = vbslq_f32(swap_bg, c, a);
    let b = vbslq_f32(swap_bg, a, c);
    let finish = |v| {
      if table.overrange && vd > 1 {
        let d = vsubq_f32(v, one);
        vmulq_f32(
          vaddq_f32(
            d,
            vsqrtq_f32(vfmaq_f32(vmulq_f32(d, d), v, splat(1.0 / 64.0))),
          ),
          splat(128.0),
        )
      } else {
        v
      }
    };
    let mut out = [[0.0; 3]; 4];
    vst3q_f32(
      out.as_mut_ptr().cast(),
      float32x4x3_t(finish(r), finish(g), finish(b)),
    );
    out
  }
}
