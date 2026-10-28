//! The 32-phase 4x4 resampling table used by Adobe's radial DNG opcode stage.
//! Its Mitchell-Netravali kernel has B=0.4, C=0.9. Table construction follows
//! `dng_resample_weights_2d::Initialize` from the public DNG SDK.

use std::sync::OnceLock;

pub(super) struct Weights {
  pub float: Vec<[f32; 16]>,
  pub integer: Vec<[i16; 16]>,
}

fn kernel(x: f64) -> f64 {
  let x = x.abs();
  let (b, c): (f64, f64) = (0.4, 0.9);
  if x >= 2.0 {
    0.0
  } else if x <= 1.0 {
    let a = b.mul_add(-2.0, 6.0);
    let six_c = c * 6.0;
    let q = b.mul_add(12.0, six_c) - 18.0;
    let p = b.mul_add(-9.0, -six_c) + 12.0;
    (x * x).mul_add(x.mul_add(p, q), a) * (1.0 / 6.0)
  } else {
    let a = b.mul_add(8.0, c * 24.0);
    let q = b.mul_add(-12.0, c * -48.0);
    let p = b.mul_add(6.0, c * 30.0);
    let r = c * -6.0 - b;
    x.mul_add(x.mul_add(x.mul_add(r, p), q), a) * (1.0 / 6.0)
  }
}

pub(super) fn get() -> &'static Weights {
  static TABLE: OnceLock<Weights> = OnceLock::new();
  TABLE.get_or_init(|| {
    let mut float = Vec::with_capacity(1024);
    let mut integer = Vec::with_capacity(1024);
    for y in 0..32 {
      for x in 0..32 {
        let mut w: [f32; 16] = std::array::from_fn(|i| {
          let horizontal = kernel((i % 4) as f64 - 1.0 - x as f64 / 32.0) as f32;
          let vertical = kernel((i / 4) as f64 - 1.0 - y as f64 / 32.0) as f32;
          horizontal * vertical
        });
        let total: f64 = w.iter().map(|&v| f64::from(v)).sum();
        let scale = (1.0 / total) as f32;
        w.iter_mut().for_each(|v| *v *= scale);
        let mut q = w.map(|v| (f64::from(v) * 16384.0).round() as i16);
        let total: i32 = q.iter().map(|&v| i32::from(v)).sum();
        let center = (if y < 16 { 1 } else { 2 }) * 4 + if x < 16 { 1 } else { 2 };
        q[center] += (16384 - total) as i16;
        float.push(w);
        integer.push(q);
      }
    }
    Weights { float, integer }
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn integer_weights_preserve_constants() {
    assert!(
      get()
        .integer
        .iter()
        .all(|w| w.iter().map(|&v| i32::from(v)).sum::<i32>() == 16384)
    );
    // Including the rounding bias, every signed-u16 convolution fits an i32.
    assert!(get().integer.iter().all(|w| {
      w.iter().map(|&v| i64::from(v).abs() * 32768).sum::<i64>() + 8192 <= i64::from(i32::MAX)
    }));
  }

  #[test]
  fn captured_weights_match_exactly() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_WARP_TRACE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let b = std::fs::read(root.join("0_weights.bin")).unwrap();
    let captured: Vec<u32> = b
      .chunks_exact(4)
      .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
      .collect();
    let actual: Vec<u32> = get().float.iter().flatten().map(|v| v.to_bits()).collect();
    assert_eq!(actual, captured);
    if let Ok(b) = std::fs::read(root.join("0_weights16.bin")) {
      let captured: Vec<i16> = b
        .chunks_exact(2)
        .map(|v| i16::from_le_bytes(v.try_into().unwrap()))
        .collect();
      let actual: Vec<i16> = get().integer.iter().flatten().copied().collect();
      assert_eq!(actual, captured);
    }
  }
}
