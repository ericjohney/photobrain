//! Adobe 18.7's integer radial WarpRectilinear opcode stage.
//!
//! The public DNG SDK defines the radial polynomial and two-dimensional weight
//! table. Adobe's converter uses a sampled radial ratio table and the B=.4/C=.9
//! kernel here instead of the SDK filter's direct double-coordinate evaluation.
//! This is the preserved-black u16 path, before white balance and DefaultCrop.

use super::weights;
use crate::Cancel;
use crate::error::Result;
use crate::image::RgbImage;
use rayon::prelude::*;

#[derive(Clone, Debug)]
pub(crate) struct WarpRectilinear {
  /// Per-channel kr0..kr3: source radius is r*(kr0+kr1*r²+kr2*r⁴+kr3*r⁶).
  pub radial: [[f64; 4]; 3],
  /// Normalised horizontal, vertical centre, relative to the active image.
  pub center: [f64; 2],
}

struct Prepared {
  center: [i32; 2],
  radius_scale: f32,
  ratio: [Vec<f32>; 3],
  identity: [bool; 3],
  weights: &'static weights::Weights,
}

impl WarpRectilinear {
  fn prepare(&self, width: usize, height: usize) -> Prepared {
    let center = [
      self.center[0] * width as f64,
      self.center[1] * height as f64,
    ];
    let dh = center[0].abs().max((width as f64 - center[0]).abs());
    let dv = center[1].abs().max((height as f64 - center[1]).abs());
    let radius = dv.mul_add(dv, dh * dh).sqrt();
    let radius_scale = ((1.0 / (radius * radius)) * 8192.0) as f32;
    let ratio = self.radial.map(|k| {
      (0..8192)
        .map(|i| {
          let r2 = i as f64 * (1.0 / 8191.0);
          r2.mul_add(r2.mul_add(r2.mul_add(k[3], k[2]), k[1]), k[0]) as f32
        })
        .collect()
    });
    Prepared {
      center: center.map(|v| v.round() as i32),
      radius_scale,
      ratio,
      identity: self.radial.map(|k| k == [1.0, 0.0, 0.0, 0.0]),
      weights: weights::get(),
    }
  }

  /// Warp an owned active image from a compact immutable source. Every tap
  /// keeps the code() boundary, and identity planes retain their float bits.
  /// The demosaic RGB allocation is released before the output is allocated.
  pub(crate) fn apply_active(&self, image: RgbImage, cancel: &Cancel) -> Result<RgbImage> {
    cancel.check()?;
    let (width, height) = (image.width, image.height);
    let prepared = self.prepare(width, height);
    let identity_count = prepared
      .identity
      .iter()
      .filter(|&&identity| identity)
      .count();
    if identity_count == 3 {
      return Ok(image);
    }
    // Two exact float identity planes plus the packed source would exceed a
    // float source. Keep the direct path for that less compact case.
    if identity_count == 2 {
      return self.apply_crop(&image, [0, 0, height, width], cancel);
    }
    // Page-aligned anonymous scratch can be viewed as u16/f32 slices safely;
    // dropping its mappings releases the pages before cached rendering.
    let mut encoded_source = memmap2::MmapMut::map_anon(image.data.len() * size_of::<u16>())?;
    let source: &mut [[u16; 3]] = bytemuck::cast_slice_mut(&mut encoded_source);
    source
      .par_chunks_mut(width)
      .zip(image.data.par_chunks(width * 3))
      .try_for_each(|(out, row)| -> Result<()> {
        cancel.check()?;
        for (out, pixel) in out.iter_mut().zip(row.as_chunks::<3>().0) {
          *out = pixel.map(code);
        }
        Ok(())
      })?;
    // Preserve identity planes verbatim, then release the demosaic allocation
    // before allocating the result. It can otherwise keep allocator pages live
    // throughout later cached renders even though fewer pixels are in use.
    let mut identity_maps = [None, None, None];
    for c in 0..3 {
      if prepared.identity[c] {
        let mut plane = memmap2::MmapMut::map_anon(width * height * size_of::<f32>())?;
        let values: &mut [f32] = bytemuck::cast_slice_mut(&mut plane);
        values
          .par_iter_mut()
          .zip(image.data.par_chunks(3))
          .for_each(|(out, p)| *out = p[c]);
        identity_maps[c] = Some(plane);
      }
    }
    let identity: [Option<&[f32]>; 3] = std::array::from_fn(|c| {
      identity_maps[c]
        .as_ref()
        .map(|plane| bytemuck::cast_slice(&plane[..]))
    });
    drop(image);
    cancel.check()?;
    let mut image = RgbImage::new(width, height);
    image.rows_mut().try_for_each(|(y, row)| -> Result<()> {
      cancel.check()?;
      for (x, pixel) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
        for c in 0..3 {
          if let Some(plane) = &identity[c] {
            pixel[c] = plane[y * width + x];
          } else {
            let value = prepared.sample(y, x, c, |sy, sx| {
              let sy = sy.clamp(0, height as i32 - 1) as usize;
              let sx = sx.clamp(0, width as i32 - 1) as usize;
              source[sy * width + sx][c]
            });
            pixel[c] = f32::from(value) * (1.0 / 65535.0);
          }
        }
      }
      Ok(())
    })?;
    cancel.check()?;
    Ok(image)
  }

  /// Warp a full active image and return [top, left, height, width] DefaultCrop.
  /// Input samples must be the demosaic's preserved-black, normalised u16 values.
  pub(crate) fn apply_crop(
    &self,
    src: &RgbImage,
    crop: [usize; 4],
    cancel: &Cancel,
  ) -> Result<RgbImage> {
    let [top, left, height, width] = crop;
    assert!(left + width <= src.width && top + height <= src.height);
    let prepared = self.prepare(src.width, src.height);
    let mut out = RgbImage::new(width, height);
    out
      .data
      .par_chunks_mut(width * 3)
      .enumerate()
      .try_for_each(|(y, row)| -> Result<()> {
        cancel.check()?;
        for x in 0..width {
          for c in 0..3 {
            row[x * 3 + c] = if prepared.identity[c] {
              src.data[((y + top) * src.width + x + left) * 3 + c]
            } else {
              let value = prepared.sample(y + top, x + left, c, |sy, sx| {
                let sy = sy.clamp(0, src.height as i32 - 1) as usize;
                let sx = sx.clamp(0, src.width as i32 - 1) as usize;
                code(src.data[(sy * src.width + sx) * 3 + c])
              });
              f32::from(value) * (1.0 / 65535.0)
            };
          }
        }
        Ok(())
      })?;
    Ok(out)
  }
}

#[inline]
fn code(value: f32) -> u16 {
  (value * 65535.0).round_ties_even().clamp(0.0, 65535.0) as u16
}

impl Prepared {
  #[inline]
  fn sample(&self, y: usize, x: usize, c: usize, source: impl Fn(i32, i32) -> u16) -> u16 {
    let dx = (x as i32 - self.center[0]) as f32;
    let dy = (y as i32 - self.center[1]) as f32;
    // Converter dispatches SIMDRadialWarp16: multiply, then ties-to-even.
    // The scalar RefRadialWarp16 uses fused +0.5 and differs at rare radii.
    let index = (((dy * dy + dx * dx) * self.radius_scale).round_ties_even() as usize).min(8191);
    let ratio = self.ratio[c][index];
    let horizontal = ratio.mul_add(dx, (self.center[0] - 1) as f32);
    let vertical = ratio.mul_add(dy, (self.center[1] - 1) as f32);
    let ix = horizontal.floor() as i32;
    let iy = vertical.floor() as i32;
    let fx = ((horizontal - ix as f32) * 32.0) as usize;
    let fy = ((vertical - iy as f32) * 32.0) as usize;
    let weights = &self.weights.integer[fy * 32 + fx];
    let mut total = 0i32;
    for j in 0..4 {
      for i in 0..4 {
        let value = i32::from(source(iy + j, ix + i)) - 32768;
        total += value * i32::from(weights[(j * 4 + i) as usize]);
      }
    }
    (((total + 8192) >> 14).clamp(-32768, 32767) + 32768) as u16
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  #[test]
  fn owned_active_warp_matches_float_source_and_identity_bits() {
    for (width, height) in [(1, 1), (3, 7), (17, 19), (65, 32)] {
      let mut image = RgbImage::new(width, height);
      image.data.iter_mut().enumerate().for_each(|(i, value)| {
        *value = match i % 17 {
          0 => -0.0,
          1 => -0.1,
          2 => 1.2,
          3 => f32::from_bits(1),
          4 => f32::from_bits(0x7fc12345),
          5 => f32::INFINITY,
          6 => f32::NEG_INFINITY,
          _ => (i * 1297 % 65536) as f32 / 65535.0 + 0.00001,
        };
      });
      for radial in [
        [[1.0, 0.0, 0.0, 0.0]; 3],
        [[0.999, 0.002, -0.001, 0.0001]; 3],
        [
          [0.999, 0.002, -0.001, 0.0001],
          [1.0, 0.0, 0.0, 0.0],
          [1.0, 0.0, 0.0, 0.0],
        ],
        [
          [0.999, 0.002, -0.001, 0.0001],
          [1.0, 0.0, 0.0, 0.0],
          [1.001, -0.001, 0.002, 0.0],
        ],
      ] {
        let warp = WarpRectilinear {
          radial,
          center: [0.499, 0.503],
        };
        let expected = warp
          .apply_crop(&image, [0, 0, height, width], &Cancel::never())
          .unwrap();
        for threads in [1, 4] {
          let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .unwrap();
          let actual = pool
            .install(|| warp.apply_active(image.clone(), &Cancel::never()))
            .unwrap();
          assert_eq!(
            actual.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            expected
              .data
              .iter()
              .map(|v| v.to_bits())
              .collect::<Vec<_>>(),
            "{width}x{height}, {threads} threads"
          );
        }
      }
    }
    let cancel = Cancel::new();
    cancel.cancel();
    let warp = WarpRectilinear {
      radial: [[1.0, 0.0, 0.0, 0.0]; 3],
      center: [0.5; 2],
    };
    assert!(matches!(
      warp.apply_active(RgbImage::new(3, 7), &cancel),
      Err(crate::Error::Cancelled)
    ));
  }

  #[test]
  fn captured_u16_warp_matches_exactly() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_WARP_TRACE") else {
      return;
    };
    let root = Path::new(&root);
    for tile in [0, 1] {
      let p = root.join(tile.to_string());
      let read =
        |suffix: &str| std::fs::read(p.with_file_name(format!("{tile}_{suffix}"))).unwrap();
      let obj = read("obj.bin");
      let params = read("params.bin");
      let f64_at = |offset| f64::from_le_bytes(params[offset..offset + 8].try_into().unwrap());
      let radial =
        std::array::from_fn(|c| std::array::from_fn(|k| f64_at(0x20 + c * 0x78 + k * 0x10)));
      let center = [f64_at(0x18), f64_at(0x10)];
      let u32_at = |i| u32::from_le_bytes(obj[i..i + 4].try_into().unwrap());
      let width = u32_at(0x44) as usize;
      let height = u32_at(0x40) as usize;
      let warp = WarpRectilinear { radial, center }.prepare(width, height);
      assert_eq!(warp.radius_scale.to_bits(), u32_at(0xd0));
      for c in 0..3 {
        let captured = read(&format!("ratio{c}.bin"));
        let captured: Vec<u32> = captured
          .chunks_exact(4)
          .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
          .collect();
        assert_eq!(
          warp.ratio[c]
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
          captured
        );
      }
      let src: serde_json::Value = serde_json::from_slice(&read("src.json")).unwrap();
      let dst: serde_json::Value = serde_json::from_slice(&read("dst.json")).unwrap();
      let field = |v: &serde_json::Value, key: &str| v[key].as_i64().unwrap() as i32;
      let pixels = |b: Vec<u8>| {
        b.chunks_exact(2)
          .map(|v| i16::from_le_bytes(v.try_into().unwrap()))
          .collect::<Vec<_>>()
      };
      let input = pixels(read("src.bin"));
      let expected = pixels(read("dst.bin"));
      let source = |y: i32, x: i32, c: i32| {
        let i = (y - field(&src, "t")) * field(&src, "row_step")
          + (x - field(&src, "l")) * field(&src, "col_step")
          + c * field(&src, "plane_step");
        (i32::from(input[i as usize]) + 32768) as u16
      };
      for y in field(&dst, "t")..field(&dst, "b") {
        for x in field(&dst, "l")..field(&dst, "r") {
          for c in 0..3 {
            let actual = if warp.identity[c] {
              source(y, x, c as i32)
            } else {
              warp.sample(y as usize, x as usize, c, |sy, sx| source(sy, sx, c as i32))
            };
            let i = (y - field(&dst, "t")) * field(&dst, "row_step") + x - field(&dst, "l")
              + c as i32 * field(&dst, "plane_step");
            assert_eq!(
              i32::from(actual) - 32768,
              i32::from(expected[i as usize]),
              "tile {tile}, {y},{x},{c}"
            );
          }
        }
      }
    }
  }
}
