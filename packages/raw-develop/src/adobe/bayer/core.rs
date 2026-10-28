//! Adobe 18.7 Bayer direction estimates, green interpolation and colour differences.
//!
//! Reconstructed from the symbolised converter's `cr_stage_bayer_core3` CPU path.
//! The separately rounded SIMD arithmetic is intentional: the green blend is not
//! fused, while the interpolation correction and red/blue interpolation are.

use crate::image::RgbImage;

#[derive(Clone, Copy, Debug)]
pub(super) struct Parameters {
  pub angle_threshold: f32,
  pub inverse_angle_range: f32,
  pub refinement: f32,
  pub blend: f32,
  pub refine_down: f32,
  pub refine_up: f32,
}

impl Parameters {
  pub fn from_detail_factor(factor: f32) -> Self {
    Self {
      angle_threshold: 22.5,
      inverse_angle_range: 1.0 / 45.0,
      refinement: ((factor - 1.0) / 5.0)
        .clamp(0.0, 1.0)
        .min(((factor - 12.0) / -6.0).clamp(0.0, 1.0)),
      blend: ((factor - 1.0) / 5.4).clamp(0.0, 1.0).mul_add(-0.4, 0.5),
      refine_down: 750.0 / 65535.0,
      refine_up: 1500.0 / 65535.0,
    }
  }

  pub fn halo(&self) -> usize {
    if self.refinement == 0.0 { 8 } else { 12 }
  }
}

struct Plane {
  width: usize,
  data: Vec<f32>,
}
impl Plane {
  fn new(width: usize, height: usize) -> Self {
    Self {
      width,
      data: vec![f32::NAN; width * height],
    }
  }
  #[inline(always)]
  fn at(&self, y: usize, x: usize) -> f32 {
    self.data[y * self.width + x]
  }
  #[inline(always)]
  fn tap(&self, y: usize, x: usize, dy: isize, dx: isize) -> f32 {
    self.at(y.wrapping_add_signed(dy), x.wrapping_add_signed(dx))
  }
  #[inline(always)]
  fn set(&mut self, y: usize, x: usize, v: f32) {
    self.data[y * self.width + x] = v;
  }
}

#[inline(always)]
fn sum<const N: usize>(values: [f32; N]) -> f32 {
  let mut out = values[0];
  for &v in &values[1..] {
    out += v;
  }
  out
}

#[inline(always)]
fn stddev(values: [f32; 5]) -> f32 {
  let mean = sum(values) * 0.2;
  let d = values.map(|v| v - mean);
  let s = d.map(|v| v * v);
  // SIMD squares first, then accumulates. No fused multiply-add at this boundary.
  sum(s).sqrt()
}

#[inline(always)]
fn angle(a: f32, b: f32) -> f32 {
  if a == 0.0 && b == 0.0 {
    return 0.0;
  }
  let ratio = if a <= b {
    a * if b == 0.0 { 0.0 } else { 1.0 / b }
  } else {
    b * if a == 0.0 { 0.0 } else { 1.0 / a }
  };
  let v = ratio * ratio.mul_add(-15.970_165, 60.970_165);
  if a <= b { 90.0 - v } else { v }
}

/// The tile uses canonical RGGB coordinates: absolute even/even is red. The
/// caller supplies real CFA-phase-preserving halo pixels. Returned pixels in the
/// outer `parameters.halo()` rows/columns are intentionally undefined (NaN).
pub(super) fn demosaic(
  src: &[f32],
  width: usize,
  height: usize,
  top: isize,
  left: isize,
  parameters: &Parameters,
) -> RgbImage {
  assert_eq!(src.len(), width * height);
  let mut out = RgbImage::new(width, height);
  out.data.fill(f32::NAN);
  if width <= parameters.halo() * 2 || height <= parameters.halo() * 2 {
    return out;
  }
  let m = Plane {
    width,
    data: src.to_vec(),
  };
  let mut p: [Plane; 9] = std::array::from_fn(|_| Plane::new(width, height));
  for y in 2..height - 2 {
    for x in 2..width - 2 {
      let c = m.at(y, x);
      let right = (c - m.tap(y, x, 0, 2)).abs();
      let down = (c - m.tap(y, x, 2, 0)).abs();
      p[0].set(y, x, right);
      p[1].set(y, x, (c - m.tap(y, x, 0, -2)).abs() + right);
      p[2].set(y, x, down);
      p[5].set(y, x, (c - m.tap(y, x, -2, 0)).abs() + down);
      p[3].set(
        y,
        x,
        ((m.tap(y, x, 0, -1) + m.tap(y, x, 0, 1)) - (c + c)).abs(),
      );
      p[4].set(
        y,
        x,
        ((m.tap(y, x, -1, 0) + m.tap(y, x, 1, 0)) - (c + c)).abs(),
      );
    }
  }
  for y in 4..height - 4 {
    for x in 4..width - 4 {
      p[7].set(
        y,
        x,
        stddev(std::array::from_fn(|k| p[3].tap(y, x, 0, k as isize - 2))),
      );
      p[8].set(
        y,
        x,
        stddev(std::array::from_fn(|k| p[4].tap(y, x, k as isize - 2, 0))),
      );
    }
  }
  // Green must have its own output plane: p[4] is an input to the previous pass.
  let mut green = Plane {
    width,
    data: src.to_vec(),
  };
  let mut blend_amount = Plane::new(width, height);
  for y in 7..height - 7 {
    for x in 7..width - 7 {
      if (top + left + y as isize + x as isize).rem_euclid(2) == 1 {
        continue;
      }
      let std_h = sum(std::array::from_fn::<_, 5, _>(|k| {
        p[8].tap(y, x, 0, k as isize - 2)
      }));
      let std_v = sum(std::array::from_fn::<_, 5, _>(|k| {
        p[7].tap(y, x, k as isize - 2, 0)
      }));
      let grad_h = sum([
        p[1].tap(y, x, -3, 0),
        p[1].tap(y, x, -2, -1),
        p[1].tap(y, x, -1, 0),
        p[1].tap(y, x, 0, -1),
        p[1].tap(y, x, 1, 0),
        p[1].tap(y, x, 2, -1),
        p[1].tap(y, x, 3, 0),
        p[0].tap(y, x, -2, 1),
        p[0].tap(y, x, 0, 1),
        p[0].tap(y, x, 2, 1),
      ]);
      let grad_v = sum([
        p[5].tap(y, x, -1, -2),
        p[5].tap(y, x, -1, 0),
        p[5].tap(y, x, -1, 2),
        p[5].tap(y, x, 0, -3),
        p[5].tap(y, x, 0, -1),
        p[5].tap(y, x, 0, 1),
        p[5].tap(y, x, 0, 3),
        p[2].tap(y, x, 1, -2),
        p[2].tap(y, x, 1, 0),
        p[2].tap(y, x, 1, 2),
      ]);
      let a = angle(std_h, std_v);
      let b = angle(grad_v, grad_h);
      let mut weight = (((a + b) * 0.5 - parameters.angle_threshold)
        * parameters.inverse_angle_range)
        .clamp(0.0, 1.0);
      if parameters.blend > 0.0 && parameters.blend < 0.5 {
        let inv = 1.0 / (parameters.blend + parameters.blend);
        weight = if weight <= parameters.blend {
          weight * inv
        } else if 1.0 - parameters.blend <= weight {
          (weight - 1.0).mul_add(inv, 1.0)
        } else {
          0.5
        };
      } else if parameters.blend < 0.5 {
        weight = 0.5;
      }
      let twice = m.at(y, x) + m.at(y, x);
      let horizontal = (((twice - m.tap(y, x, 0, -2)) - m.tap(y, x, 0, 2))
        .mul_add(0.25, m.tap(y, x, 0, -1) + m.tap(y, x, 0, 1))
        * 0.5)
        .clamp(0.0, 1.0);
      let vertical = (((twice - m.tap(y, x, -2, 0)) - m.tap(y, x, 2, 0))
        .mul_add(0.25, m.tap(y, x, -1, 0) + m.tap(y, x, 1, 0))
        * 0.5)
        .clamp(0.0, 1.0);
      let hi = 90.0 - parameters.angle_threshold;
      let lo = parameters.angle_threshold;
      let mut value = horizontal + (vertical - horizontal) * weight;
      if a > hi {
        value = vertical;
      }
      if a < lo {
        value = horizontal;
      }
      if b > hi {
        value = vertical;
      }
      if b < lo {
        value = horizontal;
      }
      green.set(y, x, value);
      let strength = if a < lo || a > hi || b < lo || b > hi {
        0.0
      } else {
        (2.0 * (1.0 - (2.0 * weight - 1.0).abs())).clamp(0.0, 1.0) * parameters.refinement
      };
      blend_amount.set(y, x, strength);
    }
  }
  for y in 8..height - 8 {
    for x in 8..width - 8 {
      let base = (y * width + x) * 3;
      let g = green.at(y, x);
      let row_colour = if (top + y as isize).rem_euclid(2) == 0 {
        0
      } else {
        2
      };
      out.data[base + 1] = g;
      let diff = |dy, dx| m.tap(y, x, dy, dx) - green.tap(y, x, dy, dx);
      if (top + left + y as isize + x as isize).rem_euclid(2) == 0 {
        out.data[base + row_colour] = m.at(y, x);
        let d = diff(-1, -1) + (diff(-1, 1) + (diff(1, -1) + diff(1, 1)));
        out.data[base + 2 - row_colour] = d.mul_add(0.25, g).clamp(0.0, 1.0);
      } else {
        out.data[base + row_colour] = (diff(0, -1) + diff(0, 1)).mul_add(0.5, g).clamp(0.0, 1.0);
        out.data[base + 2 - row_colour] =
          (diff(-1, 0) + diff(1, 0)).mul_add(0.5, g).clamp(0.0, 1.0);
      }
    }
  }
  if parameters.refinement != 0.0 {
    refine(&mut out, &blend_amount, top, left, parameters);
  }
  out
}

#[inline(always)]
fn refine_channel(
  src: &RgbImage,
  y: usize,
  x: usize,
  guide: usize,
  channel: usize,
  strength: f32,
  p: &Parameters,
) -> f32 {
  let w = src.width;
  let at = |dy: isize, dx: isize, c: usize| {
    src.data[(y.wrapping_add_signed(dy) * w + x.wrapping_add_signed(dx)) * 3 + c]
  };
  let center = at(0, 0, guide);
  let vertical = (at(-1, 0, channel) - at(1, 0, channel)).abs() + 1.0 / 65535.0;
  let horizontal = (at(0, -1, channel) - at(0, 1, channel)).abs() + 1.0 / 65535.0;
  let up = 1.0 / ((center - at(-2, 0, guide)).abs() + vertical);
  let down = 1.0 / ((center - at(2, 0, guide)).abs() + vertical);
  let left = 1.0 / ((center - at(0, -2, guide)).abs() + horizontal);
  let right = 1.0 / ((center - at(0, 2, guide)).abs() + horizontal);
  let norm = 1.0 / (up + (down + (left + right)));
  let u = (at(-1, 0, channel) - at(-1, 0, guide)) * up;
  let d = (at(1, 0, channel) - at(1, 0, guide)) * down;
  let l = (at(0, -1, channel) - at(0, -1, guide)) * left;
  let r = (at(0, 1, channel) - at(0, 1, guide)) * right;
  let current = at(0, 0, channel);
  let estimate = norm
    .mul_add(u + (d + (l + r)), center)
    .clamp(current - p.refine_down, current + p.refine_up);
  strength
    .mul_add(estimate - current, current)
    .clamp(0.0, 1.0)
}

fn refine(out: &mut RgbImage, blend: &Plane, top: isize, left: isize, p: &Parameters) {
  let (width, height) = (out.width, out.height);
  let mut first = RgbImage::new(width, height);
  first.data.clone_from(&out.data);
  for y in 10..height - 10 {
    for x in 10..width - 10 {
      if (top + left + y as isize + x as isize).rem_euclid(2) != 0 {
        continue;
      }
      let guide = if (top + y as isize).rem_euclid(2) == 0 {
        0
      } else {
        2
      };
      for channel in [1, 2 - guide] {
        first.data[(y * width + x) * 3 + channel] =
          refine_channel(out, y, x, guide, channel, blend.at(y, x), p);
      }
    }
  }
  out.data.clone_from(&first.data);
  for y in 12..height - 12 {
    for x in 12..width - 12 {
      if (top + left + y as isize + x as isize).rem_euclid(2) != 1 {
        continue;
      }
      let strength = (blend.tap(y, x, -1, 0)
        + blend.tap(y, x, 0, -1)
        + blend.tap(y, x, 0, 1)
        + blend.tap(y, x, 1, 0))
        * 0.25;
      for channel in [0, 2] {
        out.data[(y * width + x) * 3 + channel] =
          refine_channel(&first, y, x, 1, channel, strength, p);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  #[test]
  fn preserves_flat_colours_in_every_cfa_phase() {
    let (width, height) = (40, 42);
    for top in 0..2 {
      for left in 0..2 {
        let src: Vec<f32> = (0..height)
          .flat_map(|y| {
            (0..width).map(move |x| {
              if (y + top + x + left) % 2 == 1 {
                0.5
              } else if (y + top) % 2 == 0 {
                0.25
              } else {
                0.75
              }
            })
          })
          .collect();
        for factor in [0.6, 2.683_281_7, 6.788_225] {
          let p = Parameters::from_detail_factor(factor);
          let out = demosaic(&src, width, height, top as isize, left as isize, &p);
          for y in p.halo()..height - p.halo() {
            for x in p.halo()..width - p.halo() {
              assert_eq!(
                &out.data[(y * width + x) * 3..(y * width + x) * 3 + 3],
                &[0.25, 0.5, 0.75]
              );
            }
          }
        }
      }
    }
  }

  fn capture(path: &Path) -> (Vec<Vec<f32>>, [isize; 4]) {
    let h: serde_json::Value =
      serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
    let bytes = std::fs::read(path.with_extension("bin")).unwrap();
    let n = |key: &str| h[key].as_i64().unwrap() as usize;
    assert_eq!(n("psize"), 4);
    let (width, height) = (n("r") - n("l"), n("b") - n("t"));
    let planes = (0..n("planes"))
      .map(|c| {
        (0..height)
          .flat_map(|y| {
            let bytes = &bytes;
            let h = &h;
            (0..width).map(move |x| {
              let n = |key: &str| h[key].as_i64().unwrap() as usize;
              let i = (y * n("row_step") + x * n("col_step") + c * n("plane_step")) * 4;
              f32::from_le_bytes(bytes[i..i + 4].try_into().unwrap())
            })
          })
          .collect()
      })
      .collect();
    (
      planes,
      [
        n("t") as isize,
        n("l") as isize,
        n("b") as isize,
        n("r") as isize,
      ],
    )
  }

  /// Optional external stage regression. A trace directory contains the core3
  /// src/dst buffers and object, as produced by the local LLDB stage tracer.
  #[test]
  fn captured_core_matches_exactly() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_BAYER_TRACE") else {
      return;
    };
    let obj = std::fs::read_dir(root)
      .unwrap()
      .map(|v| v.unwrap().path())
      .find(|p| {
        p.file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("cr_stage_bayer_core3_obj.bin")
      })
      .expect("trace has no Bayer core object");
    let name = obj.file_name().unwrap().to_string_lossy();
    let prefix = name.strip_suffix("_obj.bin").unwrap();
    let src_path = obj.with_file_name(format!("{prefix}_src.bin"));
    let dst_path = obj.with_file_name(format!("{prefix}_dst.bin"));
    let (src, rect) = capture(&src_path);
    let (dst, dst_rect) = capture(&dst_path);
    let obj = std::fs::read(obj).unwrap();
    let parameter = |offset| f32::from_le_bytes(obj[offset..offset + 4].try_into().unwrap());
    let p = Parameters::from_detail_factor(parameter(0x34));
    for (value, offset) in [
      (p.angle_threshold, 0x2c),
      (p.inverse_angle_range, 0x30),
      (p.refinement, 0x44),
      (p.blend, 0x50),
      (p.refine_down, 0x58),
      (p.refine_up, 0x54),
    ] {
      assert_eq!(
        value.to_bits(),
        parameter(offset).to_bits(),
        "parameter {offset:x}"
      );
    }
    let width = (rect[3] - rect[1]) as usize;
    let height = (rect[2] - rect[0]) as usize;
    let out = demosaic(&src[0], width, height, rect[0], rect[1], &p);
    let dw = (dst_rect[3] - dst_rect[1]) as usize;
    let dh = (dst_rect[2] - dst_rect[0]) as usize;
    for y in 0..dh {
      for x in 0..dw {
        let oy = y + (dst_rect[0] - rect[0]) as usize;
        let ox = x + (dst_rect[1] - rect[1]) as usize;
        for (c, plane) in dst.iter().enumerate() {
          assert_eq!(
            out.data[(oy * width + ox) * 3 + c].to_bits(),
            plane[y * dw + x].to_bits(),
            "Bayer core channel {c} at {},{}",
            dst_rect[0] + y as isize,
            dst_rect[1] + x as isize
          );
        }
      }
    }
    eprintln!("Bayer core: {} captured channel values exact", dw * dh * 3);
  }
}
