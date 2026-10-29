//! Highlight-aware WB, fixed-point matrices, Fuji log gamma and opponent cleanup.
use super::{affine, fm};
use crate::{image::RgbImage, math::Mat3};

pub(super) struct Parameters {
  pub black: f64,
  pub gains: [f32; 3],
  order: [usize; 3],
  scale: f64,
  forward: FixedMatrix,
  inverse: FixedMatrix,
  encode: Vec<u16>,
  decode: Vec<u16>,
}
impl Parameters {
  pub fn new(neutral: [f64; 3], black: f64) -> Self {
    let max = neutral.into_iter().fold(0.0, f64::max);
    let gains = neutral.map(|n| (max / n) as f32);
    let mut order = [0, 1, 2];
    order.sort_by(|&a, &b| gains[b].total_cmp(&gains[a]));
    let matrix = Mat3([
      [0.7977 / 0.9642, 0.1352 / 0.9642, 0.0313 / 0.9642],
      [0.2880, 0.7119, 0.0001],
      [0.0, 0.0, 1.0],
    ])
    .scale(32768.0 / 65535.0);
    Self {
      black,
      gains,
      order,
      scale: neutral.into_iter().fold(f64::INFINITY, f64::min) / max,
      forward: FixedMatrix::new(matrix, black),
      inverse: FixedMatrix::new(matrix.inverse(), black),
      encode: log_table(black, false),
      decode: log_table(black, true),
    }
  }

  fn wb(&self, p: [f32; 3], inverse: bool) -> [f32; 3] {
    let [i, j, k] = self.order;
    let [g1, g2, g3] = [self.gains[i], self.gains[j], self.gains[k]];
    let c = g1 * 0.25;
    let [t1, t2, t3] = [g1 * c, g2 * c, g3 * c];
    let [r1, r2, r3] = [1.0 / (g1 - t1), 1.0 / (g2 - t2), 1.0 / (g3 - t3)];
    let l = self.black as f32;
    let lm1 = l - 1.0;
    let s = if l == 1.0 { 0.0 } else { -1.0 / lm1 };
    let inv = -lm1;
    let add = 0.0 - l * s;
    let restore = l + lm1 * 0.0;
    let [mut a, mut b, mut v] = [fm(s, p[i], add), fm(s, p[j], add), fm(s, p[k], add)];
    if !inverse {
      let blend = |x, other, r, t| fm(r * (x - t), other - x, x);
      let ob = if b <= a && t2 < b {
        blend(b, a, r2, t2)
      } else {
        b
      };
      let oa = if b > a && t1 < a {
        blend(a, b, r1, t1)
      } else {
        a
      };
      let half = (oa + ob) * 0.5;
      v = if v < half && t3 < v {
        blend(v, half, r3, t3)
      } else {
        v
      };
      a = oa;
      b = ob;
    } else {
      let root = |value, other, t, r| {
        let p = fm(r, t + other, 1.0);
        let q = fm(p, p, (r * (-4.0)) * fm(t * r, other, value));
        if q < 0.0 {
          -1.0
        } else {
          (-0.5 / r) * (q.sqrt() - p)
        }
      };
      let half = (a + b) * 0.5;
      let vroot = root(v, half, t3, r3);
      if vroot > t3 && half > vroot {
        v = vroot;
      }
      let rb = root(b, a, t2, r2);
      let ra = root(a, b, t1, r1);
      let ra = if ra > t1 && b > ra { ra } else { a };
      if a >= rb && rb > t2 {
        b = rb;
      } else {
        a = ra;
      }
      a *= 1.0 / g1;
      b *= 1.0 / g2;
    }
    let mut out = [0.0; 3];
    out[i] = fm(a, inv, restore);
    out[j] = fm(b, inv, restore);
    out[k] = fm(v, inv, restore);
    out
  }

  fn before(&self, p: [f32; 3]) -> [f32; 3] {
    if !p.into_iter().all(f32::is_finite) {
      return [f32::NAN; 3];
    }
    let p = self.wb(p, false);
    let (g, add) = affine(self.scale, self.black);
    let q = self.forward.apply(p.map(|v| quantize(fm(v, g, add))));
    let p = q.map(|v| self.encode[v as usize] as f32 * (1.0 / 65535.0));
    opponent(p, false).map(|v| quantize(v) as f32 * (1.0 / 65535.0))
  }

  fn after(&self, p: [f32; 3]) -> [f32; 3] {
    if !p.into_iter().all(f32::is_finite) {
      return [f32::NAN; 3];
    }
    // The pipe clips the cleanup buffer before the inverse opponent stage.
    // Negative blur lobes can otherwise carry luma above one into the log
    // decoder and turn a saturated highlight into a large colour error.
    let p = p.map(|v| v.clamp(0.0, 1.0));
    let q = opponent(p, true).map(|v| self.decode[quantize(v) as usize]);
    let p = self.inverse.apply(q).map(|v| v as f32 * (1.0 / 65535.0));
    let (g, add) = affine(1.0 / self.scale, self.black);
    self.wb(p.map(|v| fm(v, g, add)), true)
  }
}

#[inline]
fn quantize(v: f32) -> u16 {
  (v * 65535.0).round_ties_even().clamp(0.0, 65535.0) as u16
}

struct FixedMatrix {
  shift: u32,
  rows: [[i64; 4]; 3],
}
impl FixedMatrix {
  fn new(matrix: Mat3, black: f64) -> Self {
    for shift in (8..=14).rev() {
      let scale = (1u32 << shift) as f64;
      let mut rows = [[0; 4]; 3];
      let mut valid = true;
      for r in 0..3 {
        let m = matrix.0[r];
        let max = m
          .into_iter()
          .map(|v| v.max(0.0))
          .sum::<f64>()
          .max(-m.into_iter().map(|v| v.min(0.0)).sum::<f64>());
        if max * scale > 30000.0 {
          valid = false;
        }
        for c in 0..3 {
          rows[r][c] = (m[c] * scale).round() as i64;
        }
        let offset = black * (1.0 - m.into_iter().sum::<f64>());
        rows[r][3] = (offset * scale).round() as i64 * 65535
          + rows[r][..3].iter().sum::<i64>() * 32768
          - (1i64 << shift) * 32768
          + (1i64 << (shift - 1));
        let bound = rows[r][..3].iter().map(|v| v.abs()).sum::<i64>() * 32768;
        if rows[r][3] - bound < i32::MIN as i64 || rows[r][3] + bound > i32::MAX as i64 {
          valid = false;
        }
      }
      if valid {
        return Self { shift, rows };
      }
    }
    unreachable!("Fuji cleanup matrix fits signed fixed point")
  }
  fn apply(&self, q: [u16; 3]) -> [u16; 3] {
    let x = q.map(|v| v as i64 - 32768);
    self.rows.map(|m| {
      (((m[0] * x[0] + m[1] * x[1] + m[2] * x[2] + m[3]) >> self.shift).clamp(-32768, 32767)
        + 32768) as u16
    })
  }
}

fn log_table(black: f64, inverse: bool) -> Vec<u16> {
  let a = 2f64.powi(-12);
  let k = 4096f64.ln();
  let scalein = 65535.0 / 32768.0;
  let scaleout = 32768.0 / 65535.0;
  let func = |x: f64| {
    let (ib, ob) = if inverse {
      (0.25, black)
    } else {
      (black, 0.25)
    };
    let u = (x - ib) * (-1.0 / (ib - 1.0));
    let sign = if u < 0.0 { -1.0 } else { 1.0 };
    let u = u.abs();
    let v = if inverse {
      (1.0 / (1.0 - a)) * ((u * scalein * k - k).exp() - a) * scaleout
    } else {
      (1.0 / k) * (k + (a + (1.0 - a) * u * scalein).ln()) * scaleout
    };
    (ob + sign * v * -(ob - 1.0)).clamp(0.0, 1.0) as f32
  };
  let mut samples: Vec<_> = (0..=4096).map(|i| func(i as f64 / 4096.0)).collect();
  samples.push(samples[4096]);
  let mut table = vec![0; 65536];
  let mut index = 1;
  let mut frac = 0.0;
  let step = 4096.0 / 65535.0;
  let mut a = samples[0] as f64;
  let mut b = samples[1] as f64;
  let mut base = a * 65535.0 + 0.5;
  let mut slope = (b - a) * 65535.0;
  for out in &mut table {
    *out = (base + slope * frac) as u16;
    frac += step;
    if frac > 1.0 {
      index += 1;
      frac -= 1.0;
      a = b;
      b = samples[index] as f64;
      base = a * 65535.0 + 0.5;
      slope = (b - a) * 65535.0;
    }
  }
  table
}

fn opponent(p: [f32; 3], inverse: bool) -> [f32; 3] {
  let scale = 1.0f32 / 0.75;
  let add = 0.0 - 0.25 * scale;
  if !inverse {
    let [r, g, b] = p.map(|v| fm(v, scale, add));
    [
      fm(g + g, 0.75, 0.25).clamp(0.0, 1.0),
      fm(r - g, 3.367457, 0.5).clamp(0.0, 1.0),
      fm(g - b, 1.3469827, 0.5).clamp(0.0, 1.0),
    ]
  } else {
    let g = fm(p[0], scale, add) * 0.5;
    let r = fm(p[1] - 0.5, 0.29696, g);
    let b = fm(p[2] - 0.5, -0.7424, g);
    [r, g, b].map(|v| fm(v, 0.75, 0.25).clamp(0.0, 1.0))
  }
}

pub(super) fn apply(img: &mut RgbImage, params: &Parameters) {
  for pixel in img.data.as_chunks_mut::<3>().0 {
    *pixel = params.before(*pixel);
  }
  let (w, h) = (img.width, img.height);
  let before = img.data.clone();
  for y in 1..h - 1 {
    for x in 1..w - 1 {
      for c in 1..3 {
        let mut q = [0.0; 9];
        let mut i = 0;
        for dy in -1..=1 {
          for dx in -1..=1 {
            q[i] = before[((y as isize + dy) as usize * w + (x as isize + dx) as usize) * 3 + c];
            i += 1;
          }
        }
        img.data[(y * w + x) * 3 + c] = crate::adobe::rank::finite_median9(q);
      }
    }
  }
  let before = img.data.clone();
  super::bilateral::apply(&before, img);
  let weights = [
    0.885_462_6_f32,
    0.109_030_835,
    -0.078_193_836,
    0.045_154_184,
    -0.018_722_467,
  ];
  let mut across = vec![f32::NAN; w * h];
  for y in 0..h {
    for x in 4..w - 4 {
      let mut v = img.data[(y * w + x) * 3] * weights[0];
      for k in 1..=4 {
        v = fm(
          img.data[(y * w + x - k) * 3] + img.data[(y * w + x + k) * 3],
          weights[k],
          v,
        );
      }
      across[y * w + x] = v;
    }
  }
  for y in 4..h - 4 {
    for x in 4..w - 4 {
      let mut v = across[y * w + x] * weights[0];
      for k in 1..=4 {
        v = fm(
          across[(y - k) * w + x] + across[(y + k) * w + x],
          weights[k],
          v,
        );
      }
      img.data[(y * w + x) * 3] = v;
    }
  }
  for pixel in img.data.as_chunks_mut::<3>().0 {
    *pixel = params.after(*pixel);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn cleanup_overshoot_matches_adobe_highlight_capture() {
    let params = Parameters::new([0.52069, 1.0, 0.539286], 4092.0 / 65535.0);
    // CPU captures immediately after cleanup and after the inverse WB stage,
    // X-E5 DSCF0604: pipeline (2433,2911) and (2433,2917). The negative-lobed
    // cleanup filter takes luma above one at both pixels.
    for (input, expected) in [
      (
        [0x3f801565, 0x3eff08b3, 0x3efee34e],
        [0x3f6c2157, 0x3f80e083, 0x3f844935],
      ),
      (
        [0x3f804fdb, 0x3eff2e0d, 0x3eff103c],
        [0x3f6da269, 0x3f80bf2f, 0x3f844935],
      ),
    ] {
      assert_eq!(
        params.after(input.map(f32::from_bits)).map(f32::to_bits),
        expected
      );
    }
  }
}
