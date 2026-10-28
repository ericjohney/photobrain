//! Fuji's optional embedded lens profile, after demosaic and before CR6/colour.
//!
//! Converter 18.7 samples a physical-radius model, warps preserved-black u16
//! through a nonlinear encoding, and uses the same 32-phase integer filter as CA.

use super::{vendor, weights};
use crate::error::{Error, Result};
use crate::metadata::{LensSource, RawMetadata};
use crate::{Cancel, image::RgbImage};
use rayon::prelude::*;
use std::sync::OnceLock;

#[derive(Clone, Debug)]
pub(crate) struct EmbeddedDistortion {
  center: [f32; 2],
  inverse_radius: f32,
  pixel_radius: f32,
  table: Vec<f32>,
  active: [usize; 2],
}

impl EmbeddedDistortion {
  pub(crate) fn from_metadata(meta: &RawMetadata, active: [usize; 2]) -> Result<Option<Self>> {
    let LensSource::Fuji(params) = &meta.lens else {
      // Normal Sony rendering selects an external LCP, not this embedded route.
      return Ok(None);
    };
    let Some(values) = params.distortion.as_deref() else {
      return Ok(None);
    };
    let limit = match meta.model.trim() {
      "X-E5" => 2930,
      "X100VI" => 1490,
      _ => {
        return Err(Error::Unsupported(format!(
          "Adobe embedded distortion: unsupported Fuji {}",
          meta.model
        )));
      }
    };
    if values.len() != 19
      || values.iter().any(|v| !v.is_finite())
      || active.iter().any(|&n| n < 2)
      || values[1..10].iter().any(|&r| r <= 0.0)
      || values[1..10].windows(2).any(|r| r[0] >= r[1])
    {
      return Err(Error::Malformed(
        "Adobe Fuji distortion: invalid nine-knot table".into(),
      ));
    }
    if values[10..].iter().all(|&v| v == 0.0) {
      return Ok(None);
    }
    let focal = meta
      .focal_length
      .filter(|f| f.is_finite() && *f >= 1.0)
      .ok_or_else(|| Error::Malformed("Adobe Fuji distortion: missing focal length".into()))?;
    // Both supported bodies use the vendor's inverse-radius (mode zero) fit.
    let targets = &values[1..10];
    let radii: Vec<f64> = targets
      .iter()
      .zip(&values[10..])
      .map(|(&r, &d)| r * (1.0 / (d / 100.0 + 1.0)))
      .collect();
    let mut k = vendor::fit(&radii, targets)?;
    scale_for_padding(&mut k, active);
    let original_ppm = 1000.0f64 / 3.0267665252483718;
    let half_diagonal = (active[0] as f64).hypot(active[1] as f64) * 0.5 / original_ppm;
    let scale = focal / half_diagonal;
    for i in 1..4 {
      k[i] = k[i] * scale.powf((i * 2) as f64) / k[0];
    }
    // The profile interpolator quantizes coefficients to 1e-6. The subsequent
    // interpolation can differ in its final f64 bits; consumed f32 tables match.
    k[0] = quantize(k[0] - 1.0) + 1.0;
    for v in &mut k[1..] {
      *v = quantize(*v + 1.0) - 1.0;
    }
    let mut center = [0.5, 0.5];
    if let Some(shift) = meta
      .fuji_ibis_shift
      .filter(|s| s.iter().all(|&v| (-limit..=limit).contains(&v)))
    {
      // Make and CopyWarpRectilinearOpcodeToLCP each add the optical offset.
      for c in 0..2 {
        center[c] += 2.0 * (f64::from(shift[c]) / 10.0) / active[c] as f64;
      }
    }
    for c in 0..2 {
      center[c] = quantize(center[c]) * (active[c] - 1) as f64;
    }
    let ppm = (original_ppm * 65536.0).round() / 65536.0;
    Self::from_model(k, center, ppm * focal, active).map(Some)
  }

  fn from_model(
    k: [f64; 4],
    center: [f64; 2],
    physical_scale: f64,
    active: [usize; 2],
  ) -> Result<Self> {
    let far: [f64; 2] = std::array::from_fn(|c| {
      center[c]
        .abs()
        .max(((active[c] - 1) as f64 - center[c]).abs())
    });
    let x = far[0] / physical_scale;
    let y = far[1] / physical_scale;
    let far_radius = (y * y + x * x).sqrt();
    let radius = maximum_radius(k, far_radius)?;
    let ratio = |u: f64| {
      let u = if u == 0.0 { 1.0 / 16384.0 } else { u };
      let r = u * radius;
      let r2 = u * u * (radius * radius);
      (r * ratio_at(k, r2)) / (u * radius)
    };
    let mut table: Vec<f32> = (0..=4096)
      .map(|i| ratio(i as f64 * (1.0 / 4096.0)) as f32)
      .collect();
    table.push(table[4096]);
    Ok(Self {
      center: center.map(|v| v as f32),
      inverse_radius: ((1.0 / physical_scale) * (1.0 / radius)) as f32,
      pixel_radius: (physical_scale * radius) as f32,
      table,
      active,
    })
  }

  /// Backward level-zero position shared with the warp-aware vignette stage.
  #[inline]
  pub(crate) fn source_position(&self, position: [f32; 2]) -> [f32; 2] {
    let dx = (position[0] - self.center[0]) * self.inverse_radius;
    let dy = (position[1] - self.center[1]) * self.inverse_radius;
    let index = (dx * dx + dy * dy).sqrt().min(1.0) * 4096.0;
    let i = index as usize;
    let fraction = index - i as f32;
    let ratio = self.table[i] + fraction * (self.table[i + 1] - self.table[i]);
    [
      (dx * ratio)
        .mul_add(self.pixel_radius, self.center[0])
        .clamp(0.0, (self.active[0] - 1) as f32),
      (dy * ratio)
        .mul_add(self.pixel_radius, self.center[1])
        .clamp(0.0, (self.active[1] - 1) as f32),
    ]
  }

  pub(crate) fn apply(&self, src: &RgbImage, cancel: &Cancel) -> Result<RgbImage> {
    assert_eq!([src.width, src.height], self.active);
    let maps = transport_maps();
    let mut encoded = vec![0u16; src.data.len()];
    encoded
      .par_chunks_mut(src.width * 3)
      .zip(src.data.par_chunks(src.width * 3))
      .try_for_each(|(out, row)| -> Result<()> {
        cancel.check()?;
        for (out, &v) in out.iter_mut().zip(row) {
          let code = (v * 65535.0).round_ties_even().clamp(0.0, 65535.0) as usize;
          *out = maps[0][code];
        }
        Ok(())
      })?;
    let mut out = RgbImage::new(src.width, src.height);
    out
      .data
      .par_chunks_mut(src.width * 3)
      .enumerate()
      .try_for_each(|(y, row)| -> Result<()> {
        cancel.check()?;
        for (x, pixel) in row.chunks_exact_mut(3).enumerate() {
          let position = self.source_position([x as f32, y as f32]);
          for (c, v) in pixel.iter_mut().enumerate() {
            let code = resample(position, |sy, sx| {
              let sx = sx.clamp(0, src.width as i32 - 1) as usize;
              let sy = sy.clamp(0, src.height as i32 - 1) as usize;
              encoded[(sy * src.width + sx) * 3 + c]
            });
            *v = f32::from(maps[1][usize::from(code)]) * (1.0 / 65535.0);
          }
        }
        Ok(())
      })?;
    Ok(out)
  }

  /// Transport the logarithmic tone-map mask through the same lens geometry.
  /// This branch stays float: no nonlinear encoding, clipping or u16 boundary.
  pub(crate) fn apply_mask(&self, source: &[f32], cancel: &Cancel) -> Result<Vec<f32>> {
    let [width, height] = self.active;
    assert_eq!(source.len(), width * height);
    let mut output = vec![0.0; source.len()];
    output
      .par_chunks_mut(width)
      .enumerate()
      .try_for_each(|(y, row)| {
        cancel.check()?;
        for (x, value) in row.iter_mut().enumerate() {
          *value = resample_float(self.source_position([x as f32, y as f32]), |y, x| {
            source[y.clamp(0, height as i32 - 1) as usize * width
              + x.clamp(0, width as i32 - 1) as usize]
          });
        }
        Ok::<_, Error>(())
      })?;
    Ok(output)
  }
}

fn quantize(x: f64) -> f64 {
  (x * 1_000_000.0 + 0.5).floor() * 0.000001
}

#[inline]
fn ratio_at(k: [f64; 4], r2: f64) -> f64 {
  k[0] * r2.mul_add(r2.mul_add(r2.mul_add(k[3], k[2]), k[1]), 1.0)
}

fn maximum_radius(k: [f64; 4], far: f64) -> Result<f64> {
  // Find the first positive derivative root. Its stationary points partition the
  // derivative cubic into monotone intervals, so a bounded bisection is stable.
  let d = [1.0, 3.0 * k[1], 5.0 * k[2], 7.0 * k[3]];
  let polynomial = |s: f64| s.mul_add(s.mul_add(s.mul_add(d[3], d[2]), d[1]), d[0]);
  let mut boundaries = vec![0.0];
  if d[3] != 0.0 {
    let disc = 4.0 * d[2] * d[2] - 12.0 * d[3] * d[1];
    if disc >= 0.0 {
      for sign in [-1.0, 1.0] {
        let r = (-2.0 * d[2] + sign * disc.sqrt()) / (6.0 * d[3]);
        if r > 0.0 {
          boundaries.push(r);
        }
      }
    }
  } else if d[2] != 0.0 {
    let r = -d[1] / (2.0 * d[2]);
    if r > 0.0 {
      boundaries.push(r);
    }
  }
  // Cauchy's bound includes every positive root, even beyond the default 4r
  // search interval used when the derivative has no positive root.
  let degree = if d[3] != 0.0 {
    3
  } else if d[2] != 0.0 {
    2
  } else if d[1] != 0.0 {
    1
  } else {
    0
  };
  if degree != 0 {
    let bound = 1.0
      + d[..degree]
        .iter()
        .map(|v| (v / d[degree]).abs())
        .fold(0.0, f64::max);
    boundaries.push(bound);
  }
  boundaries.sort_by(f64::total_cmp);
  let mut bound = 4.0 * far;
  for interval in boundaries.windows(2) {
    let [mut low, mut high] = [interval[0], interval[1]];
    if polynomial(low) * polynomial(high) <= 0.0 {
      for _ in 0..60 {
        let mid = (low + high) * 0.5;
        if polynomial(low) * polynomial(mid) <= 0.0 {
          high = mid;
        } else {
          low = mid;
        }
      }
      bound = ((low + high) * 0.5).sqrt();
      break;
    }
  }
  if bound < far {
    return Err(Error::Malformed(
      "Adobe Fuji distortion: nonmonotone lens model".into(),
    ));
  }
  let forward = |r: f64| r * ratio_at(k, r * r);
  let (mut a, mut ya) = (0.0, forward(0.0));
  let (mut b, mut yb) = (bound, forward(bound));
  for _ in 0..30 {
    if (yb - ya).abs() < 1e-10 {
      break;
    }
    let next = (b + (far - yb) * (b - a) / (yb - ya)).clamp(0.0, bound);
    a = b;
    ya = yb;
    b = next;
    yb = forward(next);
  }
  Ok(b.max(far))
}

fn scale_for_padding(k: &mut [f64; 4], active: [usize; 2]) {
  let center = active.map(|n| (n - 1) as f64 * 0.5);
  let inverse = 1.0 / ((active[0] as f64).hypot(active[1] as f64) * 0.5);
  let mut maximum = -1.0;
  let mut location = [0.0, 0.0];
  let polynomial = |r: f64| {
    let r2 = r * r;
    r2.mul_add(r2.mul_add(r2.mul_add(k[3], k[2]), k[1]), k[0])
  };
  for x in 0..active[0] {
    for y in [0, active[1] - 1] {
      let r = inverse * (x as f64 - center[0]).hypot(y as f64 - center[1]);
      let ratio = (r * polynomial(r)) / r;
      if ratio > maximum {
        maximum = ratio;
        location = [x as f64, y as f64];
      }
    }
  }
  for y in 0..active[1] {
    for x in [0, active[0] - 1] {
      let r = inverse * (x as f64 - center[0]).hypot(y as f64 - center[1]);
      let ratio = (r * polynomial(r)) / r;
      if ratio > maximum {
        maximum = ratio;
        location = [x as f64, y as f64];
      }
    }
  }
  if (maximum - 0.99997).abs() < 1e-5 {
    return;
  }
  let (mut low, mut high, mut s) = if maximum >= 0.99997 {
    (0.5, 1.0, 0.75)
  } else {
    (1.0, 2.0, 1.5)
  };
  let distance = (location[0] - center[0]).hypot(location[1] - center[1]);
  for _ in 0..30 {
    let r = s * inverse * distance;
    let ratio = r * polynomial(r) / (inverse * distance);
    if (ratio - 0.99997).abs() < 1e-5 {
      break;
    }
    if ratio >= 0.99997 {
      high = s;
    } else {
      low = s;
    }
    s = (low + high) * 0.5;
  }
  for i in 0..4 {
    k[i] *= s.powf((2 * i + 1) as f64);
  }
}

fn transport_maps() -> &'static [Vec<u16>; 2] {
  static MAPS: OnceLock<[Vec<u16>; 2]> = OnceLock::new();
  MAPS.get_or_init(|| {
    std::array::from_fn(|inverse| (0..=65535).map(|v| transport(v, inverse != 0)).collect())
  })
}

fn transport(code: u16, inverse: bool) -> u16 {
  let black = (4096.0 / 65535.0) as f32;
  let (input_black, output_black) = if inverse {
    (0.25, black)
  } else {
    (black, 0.25)
  };
  let input_scale = -1.0 / (input_black - 1.0);
  let offset = -(input_black * input_scale);
  let n = (f32::from(code) * f32::from_bits(0x37800080)).mul_add(input_scale, offset);
  let value = if inverse {
    let gain = f32::from_bits(0x3f707fe0);
    if n < 0.0 {
      let v = n.mul_add(-gain, 0.0625);
      (-v).mul_add(v, 0.00390625)
    } else {
      let v = n.mul_add(gain, 0.0625);
      v.mul_add(v, -0.00390625)
    }
  } else {
    let gain = f32::from_bits(0x3f883ff0).copysign(n);
    ((n.abs() + 0.00390625).sqrt() - 0.0625) * gain
  };
  let result = (1.0 - output_black).mul_add(value, output_black) * 65535.0;
  f64::from(result).round().clamp(0.0, 65535.0) as u16
}

#[inline]
fn resample(position: [f32; 2], source: impl Fn(i32, i32) -> u16) -> u16 {
  let [x, y] = position.map(|v| v - 1.0);
  let ix = x.floor() as i32;
  let iy = y.floor() as i32;
  let fx = ((x - ix as f32) * 32.0) as usize;
  let fy = ((y - iy as f32) * 32.0) as usize;
  let weights = &weights::get().integer[fy * 32 + fx];
  let mut sum = 0i32;
  for j in 0..4 {
    for i in 0..4 {
      sum += (i32::from(source(iy + j, ix + i)) - 32768) * i32::from(weights[(j * 4 + i) as usize]);
    }
  }
  (((sum + 8192) >> 14).clamp(-32768, 32767) + 32768) as u16
}

#[inline]
fn resample_float([x, y]: [f32; 2], source: impl Fn(i32, i32) -> f32) -> f32 {
  let ix = x.floor() as i32;
  let iy = y.floor() as i32;
  let fx = ((x - ix as f32) * 32.0) as usize;
  let fy = ((y - iy as f32) * 32.0) as usize;
  let kernel = &weights::get().float[fy * 32 + fx];
  let mut columns = [0.0f32; 4];
  for i in 0..4 {
    columns[i] = source(iy - 1, ix + i as i32 - 1) * kernel[i];
    for j in 1..4 {
      columns[i] =
        source(iy + j as i32 - 1, ix + i as i32 - 1).mul_add(kernel[j * 4 + i], columns[i]);
    }
  }
  (columns[0] + columns[1]) + (columns[2] + columns[3])
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn nonlinear_transport_preserves_black_and_white() {
    assert_eq!(transport(4096, false), 16384);
    assert_eq!(transport(16384, true), 4096);
    assert_eq!(transport(65535, false), 65535);
    assert_eq!(transport(65535, true), 65535);
    assert!(
      transport_maps()
        .iter()
        .all(|map| map.windows(2).all(|v| v[0] <= v[1]))
    );
  }

  #[test]
  fn padding_and_resampling_preserve_constant_samples() {
    let k = [1.0, 0.0, 0.0, 0.0];
    assert_eq!(maximum_radius(k, 0.75).unwrap(), 0.75);
    for position in [[0.0, 0.0], [23.123, 17.675], [2000.0, 3000.0]] {
      for value in [0, 4096, 32768, 65535] {
        assert_eq!(resample(position, |_, _| value), value);
      }
    }
  }
  #[test]
  fn captured_distortion_matches() {
    let (Some(root), Some(raw)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_LENS_TRACE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_LENS_RAW"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&root);
    let neg = crate::Negative::open(raw).unwrap();
    let active = [neg.meta.crop_width, neg.meta.crop_height];
    let Some(ours) = EmbeddedDistortion::from_metadata(&neg.meta, active).unwrap() else {
      return;
    };
    let calc = std::fs::read(root.join("006_calculator.bin")).unwrap();
    let at = |i| f32::from_le_bytes(calc[i..i + 4].try_into().unwrap());
    let double = |i| f64::from_le_bytes(calc[i..i + 8].try_into().unwrap());
    assert_eq!(ours.center, [double(0xe8) as f32, double(0xf0) as f32]);
    assert_eq!(ours.inverse_radius, at(0x220));
    assert_eq!(ours.pixel_radius, at(0x228));
    let expected: Vec<u32> = std::fs::read(root.join("006_table.bin"))
      .unwrap()
      .chunks_exact(4)
      .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
      .collect();
    let mismatch = ours
      .table
      .iter()
      .zip(&expected)
      .filter(|(a, b)| a.to_bits() != **b)
      .count();
    assert_eq!(mismatch, 0, "distortion LUT");
    if let Ok(src) = std::fs::read(root.join("129_cr_stage_warp_src.bin")) {
      let srcj: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("129_cr_stage_warp_src.json")).unwrap())
          .unwrap();
      let dstj: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("129_cr_stage_warp_dst.json")).unwrap())
          .unwrap();
      let dst = std::fs::read(root.join("129_cr_stage_warp_dst.bin")).unwrap();
      let field = |v: &serde_json::Value, k: &str| v[k].as_i64().unwrap() as i32;
      let index = |j: &serde_json::Value, y: i32, x: i32, c: i32| {
        ((y - field(j, "t")) * field(j, "row_step")
          + (x - field(j, "l")) * field(j, "col_step")
          + c * field(j, "plane_step")) as usize
      };
      let read = |b: &[u8], i: usize| {
        (i32::from(i16::from_le_bytes(b[i * 2..i * 2 + 2].try_into().unwrap())) + 32768) as u16
      };
      let mut mismatches = 0;
      for y in field(&dstj, "t")..field(&dstj, "b") {
        for x in field(&dstj, "l")..field(&dstj, "r") {
          for c in 0..3 {
            let value = resample(ours.source_position([x as f32, y as f32]), |sy, sx| {
              transport(read(&src, index(&srcj, sy, sx, c)), false)
            });
            let value = transport(value, true);
            let expected = read(&dst, index(&dstj, y, x, c));
            if value != expected {
              if mismatches < 10 {
                eprintln!("{x},{y},{c}: {value} != {expected}");
              }
              mismatches += 1;
            }
          }
        }
      }
      assert_eq!(mismatches, 0, "u16 distortion pixels");
    }
  }

  #[test]
  fn captured_float_mask_warp() {
    let (Some(root), Some(raw)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_MASK_WARP_TRACE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_MASK_WARP_RAW"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&root);
    let negative = crate::Negative::open(raw).unwrap();
    let active = [negative.meta.crop_width, negative.meta.crop_height];
    let warp = EmbeddedDistortion::from_metadata(&negative.meta, active)
      .unwrap()
      .expect("nonidentity embedded distortion");
    let header = |stem: &str| -> serde_json::Value {
      serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap()).unwrap()
    };
    let srcj = header("warp_src");
    let dstj = header("warp_dst");
    let src = std::fs::read(root.join("warp_src.bin")).unwrap();
    let dst = std::fs::read(root.join("warp_dst.bin")).unwrap();
    let n = |j: &serde_json::Value, key: &str| j[key].as_i64().unwrap() as i32;
    let read = |j: &serde_json::Value, bytes: &[u8], y: i32, x: i32| {
      assert!((n(j, "t")..n(j, "b")).contains(&y));
      assert!((n(j, "l")..n(j, "r")).contains(&x));
      let index =
        ((y - n(j, "t")) * n(j, "row_step") + (x - n(j, "l")) * n(j, "col_step")) as usize * 4;
      f32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
    };
    let expected_weights = std::fs::read(root.join("weights.f32")).unwrap();
    for (&actual, bytes) in weights::get()
      .float
      .iter()
      .flatten()
      .zip(expected_weights.chunks_exact(4))
    {
      assert_eq!(
        actual.to_bits(),
        u32::from_le_bytes(bytes.try_into().unwrap()),
        "float warp weights"
      );
    }
    let mut different = 0;
    let mut checked = 0;
    for y in n(&dstj, "t")..n(&dstj, "b") {
      for x in n(&dstj, "l")..n(&dstj, "r") {
        let actual = resample_float(warp.source_position([x as f32, y as f32]), |sy, sx| {
          read(&srcj, &src, sy, sx)
        });
        let expected = read(&dstj, &dst, y, x);
        if actual.to_bits() != expected.to_bits() {
          if different < 5 {
            eprintln!("float mask warp {x},{y}: {actual} != {expected}");
          }
          different += 1;
        }
        checked += 1;
      }
    }
    eprintln!("float mask warp: {different}/{checked} differences");
    assert_eq!(different, 0);
  }
}
