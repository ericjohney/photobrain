//! Four independent exposure lanes. All reciprocals are exact divisions;
//! table lookups retain the original interpolation and clipping points.

use super::{Stage, Table};
use std::arch::aarch64::*;

#[inline(always)]
fn splat(x: f32) -> float32x4_t {
  // NEON is baseline on AArch64.
  unsafe { vdupq_n_f32(x) }
}

#[inline(always)]
fn reciprocal(x: float32x4_t) -> float32x4_t {
  unsafe {
    vbslq_f32(
      vceqq_f32(x, splat(0.0)),
      splat(0.0),
      vdivq_f32(splat(1.0), x),
    )
  }
}

#[inline(always)]
fn evaluate(table: &Table, value: float32x4_t) -> float32x4_t {
  table.eval4(value)
}

pub(super) fn apply(stage: &Stage, pixels: [[f32; 3]; 4]) -> [[f32; 3]; 4] {
  // Interleaved load/store addresses exactly twelve valid floats. Arithmetic
  // never mixes pixels, and no full-image scratch storage is needed.
  unsafe {
    let float32x4x3_t(r, g, b) = vld3q_f32(pixels.as_ptr().cast());
    let one = splat(1.0);
    let r = vmulq_f32(r, splat(stage.gain));
    let g = vmulq_f32(g, splat(stage.gain));
    let b = vmulq_f32(b, splat(stage.gain));
    let lo = vminnmq_f32(vminnmq_f32(r, g), b);
    let hi = vmaxnmq_f32(vmaxnmq_f32(r, g), b);
    let mid = vminnmq_f32(vmaxnmq_f32(vminnmq_f32(r, g), b), vmaxnmq_f32(r, g));
    let transform = |mut x| {
      if stage.whites_clip_squared < 1.0 {
        let v = vmulq_f32(x, splat(stage.rolloff_gain));
        let a = vmulq_f32(v, reciprocal(vaddq_f32(v, one)));
        let b = vfmaq_f32(one, v, splat(super::reciprocal(stage.whites_clip_squared)));
        x = vmulq_f32(
          vmulq_f32(b, a),
          splat(super::reciprocal(stage.rolloff_gain)),
        );
      }
      x = vminnmq_f32(x, one);
      if stage.rolloff_gain > 1.0 {
        if let Some(table) = &stage.rolloff {
          x = evaluate(table, x);
        }
      }
      if stage.overrange_squared_gain > 1.0 {
        let squared = vmulq_f32(x, x);
        let num = vmulq_f32(squared, splat(stage.overrange_squared_gain));
        let den = vfmaq_f32(one, squared, splat(stage.overrange_squared_gain - 1.0));
        x = vsqrtq_f32(vmulq_f32(num, reciprocal(den)));
      }
      x
    };
    let a = transform(lo);
    let b_out = transform(hi);
    let position = vmulq_f32(
      vsubq_f32(mid, lo),
      reciprocal(vmaxnmq_f32(vsubq_f32(hi, lo), splat(stage.epsilon))),
    );
    // The scalar middle interpolation has separate multiply and add operations.
    let middle = vaddq_f32(a, vmulq_f32(vsubq_f32(b_out, a), position));
    let channel = |x| {
      vbslq_f32(
        vceqq_f32(x, lo),
        a,
        vbslq_f32(vceqq_f32(x, hi), b_out, middle),
      )
    };
    let (mut r, mut g, mut b) = (channel(r), channel(g), channel(b));
    let ratio = |r, g, b, table: &Table| {
      let luma = vmulq_f32(vaddq_f32(vaddq_f32(vaddq_f32(g, b), g), r), splat(0.25));
      let gain = vmulq_f32(
        reciprocal(vmaxnmq_f32(luma, splat(stage.epsilon))),
        evaluate(table, luma),
      );
      (vmulq_f32(r, gain), vmulq_f32(g, gain), vmulq_f32(b, gain))
    };
    if let Some(table) = &stage.whites_reduce {
      (r, g, b) = ratio(r, g, b, table);
    }
    if let Some(tables) = &stage.blacks_subtract {
      r = evaluate(&tables[0], r);
      g = evaluate(&tables[1], g);
      b = evaluate(&tables[2], b);
    }
    if let Some(table) = &stage.blacks_lift {
      (r, g, b) = ratio(r, g, b, table);
      r = vminnmq_f32(r, one);
      g = vminnmq_f32(g, one);
      b = vminnmq_f32(b, one);
    }
    let mut out = [[0.0; 3]; 4];
    vst3q_f32(out.as_mut_ptr().cast(), float32x4x3_t(r, g, b));
    out
  }
}
