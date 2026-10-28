//! Edge-aware expansion of the cached Highlights/Shadows mask.
//!
//! The CPU path averages quantized As Shot RGB before computing the low-resolution
//! logarithmic guide. Its 4 by 4 Gaussian interpolation is modulated by the
//! difference between the low and high logarithmic luminance. Arithmetic order
//! follows DNG Converter 18.7's SIMDHybridUpsample32. Guide flare follows the
//! As Shot input exposure, independently of the low mask's scene flare.

use super::mask::{Mask, MaskSource};
use crate::{Cancel, Result, image::RgbImage};
use rayon::prelude::*;
use std::sync::OnceLock;

const PHASES: usize = 32;
const HALO: isize = 2;
// 0.05 / float(1 / sqrt(4 pi)), from the native Gaussian normalization.
const MINIMUM_WEIGHT: f32 = f32::from_bits(0x3e35_7fd0);

#[derive(Clone, Debug)]
pub(crate) struct Guide {
  high: Vec<f32>,
  low: Vec<f32>,
  width: usize,
  height: usize,
  low_width: usize,
  low_height: usize,
  level: usize,
}

#[inline]
fn log_luminance([r, g, b]: [f32; 3], flare: f32) -> f32 {
  let gray = b.mul_add(0.110000014, r.mul_add(0.3, g * 0.59));
  let gray = if gray > 0.0 {
    gray.min(f32::from_bits(0x7b80_0000))
  } else {
    0.0
  };
  (gray + flare).log2()
}

fn weights() -> &'static [[f32; 16]] {
  static WEIGHTS: OnceLock<Vec<[f32; 16]>> = OnceLock::new();
  WEIGHTS.get_or_init(|| {
    (0..PHASES * PHASES)
      .map(|phase| {
        let fy = (phase / PHASES) as f64 / PHASES as f64;
        let fx = (phase % PHASES) as f64 / PHASES as f64;
        let mut sum = 0.0f64;
        let mut kernel = std::array::from_fn(|i| {
          let x = (i % 4) as f64 - 1.0 - fx;
          let y = (i / 4) as f64 - 1.0 - fy;
          let weight = ((-x * x).exp() as f32) * ((-y * y).exp() as f32);
          sum += f64::from(weight);
          weight
        });
        let inverse = (1.0 / sum) as f32;
        for weight in &mut kernel {
          *weight *= inverse;
        }
        kernel
      })
      .collect()
  })
}

#[inline]
fn interpolate(
  high: f32,
  y: f32,
  x: f32,
  low: impl Fn(isize, isize) -> f32,
  mask: impl Fn(isize, isize) -> f32,
) -> f32 {
  let iy = y.floor();
  let ix = x.floor();
  let py = ((y - iy) * PHASES as f32) as usize;
  let px = ((x - ix) * PHASES as f32) as usize;
  let spatial = &weights()[py * PHASES + px];
  let mut numerator = [0.0f32; 4];
  let mut denominator = [0.0f32; 4];
  for row in 0..4 {
    for col in 0..4 {
      let y = iy as isize + row as isize - 1;
      let x = ix as isize + col as isize - 1;
      let delta = low(y, x) - high;
      let range = (1.0 - (delta * delta) * 0.05).max(0.0);
      let range = range * range;
      let range = (range * range).max(MINIMUM_WEIGHT);
      let weight = spatial[row * 4 + col] * range;
      numerator[col] = mask(y, x).mul_add(weight, numerator[col]);
      denominator[col] += weight;
    }
  }
  let numerator = (numerator[0] + numerator[1]) + (numerator[2] + numerator[3]);
  let denominator = (denominator[0] + denominator[1]) + (denominator[2] + denominator[3]);
  numerator
    * if denominator == 0.0 {
      0.0
    } else {
      1.0 / denominator
    }
}

impl Guide {
  /// Cache the two minimal guide planes from the original, preserved-black
  /// camera image, before user noise reduction or distortion. `origin` is the
  /// default-crop origin within that camera image (zero for Fujifilm). Sony
  /// guide halos use the surrounding active pixels outside that crop. The
  /// guide uses As Shot white balance; the low mask itself uses D50.
  pub(crate) fn prepare(
    camera: &RgbImage,
    source: &MaskSource,
    origin: [usize; 2],
    cancel: &Cancel,
  ) -> Result<Self> {
    cancel.check()?;
    let width = source.image.full_width;
    let height = source.image.full_height;
    let low_width = source.image.width;
    let low_height = source.image.height;
    let level = source.image.level;
    let flare = source.guide_flare() as f32;
    let scale = 1isize << level;
    if level == 0 {
      return Ok(Self {
        high: Vec::new(),
        low: Vec::new(),
        width,
        height,
        low_width,
        low_height,
        level,
      });
    }
    assert!(origin[0] + width <= camera.width && origin[1] + height <= camera.height);
    let rgb = |y: isize, x: isize| {
      let y = (y + origin[1] as isize).clamp(0, camera.height as isize - 1) as usize;
      let x = (x + origin[0] as isize).clamp(0, camera.width as isize - 1) as usize;
      source.guide_rgb_for_upsampling(camera.px(x, y))
    };
    let mut high = vec![0.0; width * height];
    high
      .par_chunks_mut(width)
      .enumerate()
      .try_for_each(|(y, row)| {
        cancel.check()?;
        for (x, value) in row.iter_mut().enumerate() {
          *value = log_luminance(rgb(y as isize, x as isize), flare);
        }
        Ok::<_, crate::Error>(())
      })?;
    let stride = low_width + 2 * HALO as usize;
    let mut low = vec![0.0; stride * (low_height + 2 * HALO as usize)];
    low
      .par_chunks_mut(stride)
      .enumerate()
      .try_for_each(|(y, row)| {
        cancel.check()?;
        for (x, value) in row.iter_mut().enumerate() {
          let y = (y as isize - HALO) * scale;
          let x = (x as isize - HALO) * scale;
          let mut sum = [0.0f32; 3];
          for dy in 0..scale {
            for dx in 0..scale {
              let pixel = rgb(y + dy, x + dx);
              for c in 0..3 {
                sum[c] += pixel[c];
              }
            }
          }
          let inverse = 1.0 / (scale * scale) as f32;
          *value = log_luminance(sum.map(|v| v * inverse), flare);
        }
        Ok::<_, crate::Error>(())
      })?;
    Ok(Self {
      high,
      low,
      width,
      height,
      low_width,
      low_height,
      level,
    })
  }

  /// Produce a crop-relative, full-resolution mask. This result can be cached
  /// independently of the user Highlights/Shadows slider values.
  pub(crate) fn render(&self, mask: &Mask, cancel: &Cancel) -> Result<Vec<f32>> {
    assert_eq!(
      (mask.full_width, mask.full_height),
      (self.width, self.height)
    );
    assert_eq!(
      (mask.width, mask.height, mask.level),
      (self.low_width, self.low_height, self.level)
    );
    if self.level == 0 {
      cancel.check()?;
      return Ok(mask.samples.clone());
    }
    let scale = 1.0 / (1usize << self.level) as f32;
    let offset = scale * 0.5 - 0.5;
    let mut output = vec![0.0; self.width * self.height];
    let stride = self.low_width + 2 * HALO as usize;
    output
      .par_chunks_mut(self.width)
      .enumerate()
      .try_for_each(|(y, row)| {
        cancel.check()?;
        let fy = scale.mul_add(y as f32, offset);
        for (x, value) in row.iter_mut().enumerate() {
          let fx = scale.mul_add(x as f32, offset);
          *value = interpolate(
            self.high[y * self.width + x],
            fy,
            fx,
            |y, x| self.low[(y + HALO) as usize * stride + (x + HALO) as usize],
            |y, x| {
              mask.samples[y.clamp(0, self.low_height as isize - 1) as usize * self.low_width
                + x.clamp(0, self.low_width as isize - 1) as usize]
            },
          );
        }
        Ok::<_, crate::Error>(())
      })?;
    Ok(output)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::{Path, PathBuf};

  struct Buffer {
    header: serde_json::Value,
    bytes: Vec<u8>,
  }
  impl Buffer {
    fn open(root: &Path, name: &str) -> Self {
      Self {
        header: serde_json::from_slice(&std::fs::read(root.join(format!("{name}.json"))).unwrap())
          .unwrap(),
        bytes: std::fs::read(root.join(format!("{name}.bin"))).unwrap(),
      }
    }
    fn n(&self, key: &str) -> i64 {
      self.header[key].as_i64().unwrap()
    }
    fn pixel(&self, y: i64, x: i64, c: i64) -> f32 {
      let i = ((y - self.n("t")) * self.n("row_step")
        + (x - self.n("l")) * self.n("col_step")
        + c * self.n("plane_step")) as usize
        * 4;
      f32::from_le_bytes(self.bytes[i..i + 4].try_into().unwrap())
    }
  }
  fn captured_root() -> Option<PathBuf> {
    std::env::var_os("ADOBE_MASK_UPSAMPLE_CAPTURE").map(PathBuf::from)
  }
  #[test]
  fn captured_spatial_weights() {
    let Some(root) = captured_root() else {
      return;
    };
    let expected: Vec<_> = std::fs::read(root.join("weights.f32"))
      .unwrap()
      .chunks_exact(4)
      .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
      .collect();
    let actual: Vec<_> = weights().iter().flatten().copied().collect();
    let different = actual
      .iter()
      .zip(&expected)
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(actual.len(), expected.len());
    assert_eq!(different, 0, "spatial weights");
  }
  #[test]
  fn captured_rgb_reduction_and_upsampling() {
    let Some(root) = captured_root() else {
      return;
    };
    let high = Buffer::open(&root, "gray0_src");
    let low = Buffer::open(&root, "gray1_src");
    let output = Buffer::open(&root, "stage_dst");
    let object = std::fs::read(root.join("stage_obj.bin")).unwrap();
    let flare = f32::from_le_bytes(object[0x188..0x18c].try_into().unwrap());
    let scale = i32::from_le_bytes(object[0x38..0x3c].try_into().unwrap()) as i64;
    let origin_y = i32::from_le_bytes(object[0x3c..0x40].try_into().unwrap()) as i64;
    let origin_x = i32::from_le_bytes(object[0x40..0x44].try_into().unwrap()) as i64;
    for y in low.n("t")..low.n("b") {
      for x in low.n("l")..low.n("r") {
        for c in 0..3 {
          let mut sum = 0.0f32;
          for dy in 0..scale {
            for dx in 0..scale {
              sum += high.pixel(origin_y + y * scale + dy, origin_x + x * scale + dx, c);
            }
          }
          let actual = sum * (1.0 / (scale * scale) as f32);
          assert_eq!(
            actual.to_bits(),
            low.pixel(y, x, c + 1).to_bits(),
            "RGB reduction {y},{x},{c}"
          );
        }
      }
    }
    let kernel: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("kernel.json")).unwrap()).unwrap();
    let p: Vec<f32> = kernel["s"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| v.as_f64().unwrap() as f32)
      .collect();
    let mut different = 0;
    let mut maximum = 0.0f32;
    let mut checked = 0;
    for y in output.n("t")..output.n("b") {
      for x in output.n("l")..output.n("r") {
        let hi = log_luminance(std::array::from_fn(|c| high.pixel(y, x, c as i64)), flare);
        let fy = p[0].mul_add(y as f32, p[1]).clamp(p[4], p[5]);
        let fx = p[2].mul_add(x as f32, p[3]).clamp(p[6], p[7]);
        let actual = interpolate(
          hi,
          fy,
          fx,
          |y, x| {
            log_luminance(
              std::array::from_fn(|c| low.pixel(y as i64, x as i64, c as i64 + 1)),
              flare,
            )
          },
          |y, x| low.pixel(y as i64, x as i64, 0),
        );
        let expected = output.pixel(y, x, 0);
        if actual.to_bits() != expected.to_bits() {
          if different == 0 {
            eprintln!("first upsample {y},{x}: {actual} vs {expected}");
          }
          different += 1;
        }
        maximum = maximum.max((actual - expected).abs());
        checked += 1;
      }
    }
    eprintln!("upsample: {different}/{checked} different; maximum {maximum}");
    assert_eq!((different, maximum), (0, 0.0));
  }

  #[test]
  fn captured_camera_guide() {
    let (Some(root), Some(raw), Some(profiles)) = (
      captured_root(),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let negative = crate::Negative::open(raw).unwrap();
    let meta = &negative.meta;
    let dcp = crate::adobe::dcp::Dcp::open(
      &crate::adobe::dcp::Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model)
        .unwrap(),
    )
    .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let object = std::fs::read(root.join("stage_obj.bin")).unwrap();
    let parameter =
      |offset: usize| u32::from_le_bytes(object[offset..offset + 4].try_into().unwrap()) as usize;
    let level = parameter(0x30);
    let origin = [parameter(0x40), parameter(0x3c)];
    let flare = f64::from_le_bytes(object[0x180..0x188].try_into().unwrap());
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let camera = if meta.cfa.is_xtrans() {
      crate::adobe::xtrans::develop_preserved_with_lens(&negative, neutral, true, &Cancel::never())
        .unwrap()
    } else {
      crate::adobe::bayer::develop_unbalanced_active(&negative, true, &Cancel::never()).unwrap()
    };
    let image = super::super::stats_image::camera_pyramid_f32_region_at_level(
      &camera,
      origin[0],
      origin[1],
      meta.crop_width,
      meta.crop_height,
      black,
      true,
      level,
    );
    assert_eq!(
      (image.width, image.height),
      (parameter(0x50), parameter(0x4c))
    );
    let small = super::super::stats_image::deepen(&image, black, true);
    let scene_flare = super::super::stats_image::flare_for_log(&small, black);
    let source = MaskSource::new(image, &dcp, meta, neutral, black, scene_flare);
    assert_eq!(source.guide_flare(), flare, "As Shot guide flare");
    let high = Buffer::open(&root, "stage_src");
    let mut checked = 0;
    for y in high.n("t")..high.n("b") {
      for x in high.n("l")..high.n("r") {
        let sy = y.clamp(0, camera.height as i64 - 1) as usize;
        let sx = x.clamp(0, camera.width as i64 - 1) as usize;
        let actual = source.guide_rgb_for_upsampling(camera.px(sx, sy));
        for c in 0..3 {
          assert_eq!(
            actual[c].to_bits(),
            high.pixel(y, x, c as i64).to_bits(),
            "camera guide ({y},{x},{c})"
          );
          checked += 1;
        }
      }
    }
    eprintln!("RAW through quantized As Shot guide: {checked} channels");
    let guide = Guide::prepare(&camera, &source, origin, &Cancel::never()).unwrap();
    let low = Buffer::open(&root, "gray1_src");
    let stride = guide.low_width + 4;
    let mut low_checked = 0;
    for y in low.n("t")..low.n("b") {
      for x in low.n("l")..low.n("r") {
        let expected = log_luminance(
          std::array::from_fn(|c| low.pixel(y, x, c as i64 + 1)),
          flare as f32,
        );
        let actual = guide.low[(y + HALO as i64) as usize * stride + (x + HALO as i64) as usize];
        assert_eq!(actual.to_bits(), expected.to_bits(), "low guide ({y},{x})");
        low_checked += 1;
      }
    }
    let output = Buffer::open(&root, "stage_dst");
    let scale = 1.0 / (1usize << level) as f32;
    let offset = scale * 0.5 - 0.5;
    let mut output_checked = 0;
    for y in output.n("t")..output.n("b") {
      for x in output.n("l")..output.n("r") {
        let sy = (y - origin[1] as i64) as usize;
        let sx = (x - origin[0] as i64) as usize;
        let actual = interpolate(
          guide.high[sy * guide.width + sx],
          scale.mul_add(sy as f32, offset),
          scale.mul_add(sx as f32, offset),
          |y, x| guide.low[(y + HALO) as usize * stride + (x + HALO) as usize],
          |y, x| low.pixel(y as i64, x as i64, 0),
        );
        assert_eq!(
          actual.to_bits(),
          output.pixel(y, x, 0).to_bits(),
          "composed guide+upsample ({y},{x})"
        );
        output_checked += 1;
      }
    }
    eprintln!(
      "Cached guide: {low_checked} low samples; {output_checked} exact composed mask pixels"
    );
  }

  #[test]
  fn captured_main_pipeline_mask() {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("ADOBE_MAIN_MASK_CAPTURE").map(PathBuf::from),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let negative = crate::Negative::open(raw).unwrap();
    let meta = &negative.meta;
    let dcp = crate::adobe::dcp::Dcp::open(
      &crate::adobe::dcp::Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model)
        .unwrap(),
    )
    .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let cancel = Cancel::never();
    let camera = if meta.cfa.is_xtrans() {
      crate::adobe::xtrans::develop_preserved_with_lens(&negative, neutral, true, &cancel).unwrap()
    } else {
      crate::adobe::bayer::develop_unbalanced_active(&negative, true, &cancel).unwrap()
    };
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let [left, top, width, height] = if meta.cfa.is_xtrans() {
      [0, 0, camera.width, camera.height]
    } else {
      [
        meta.crop_left,
        meta.crop_top,
        meta.crop_width,
        meta.crop_height,
      ]
    };
    let image = super::super::stats_image::camera_pyramid_f32_region_at_level(
      &camera, left, top, width, height, black, true, 2,
    );
    let small = super::super::stats_image::deepen(&image, black, true);
    let flare = super::super::stats_image::flare_for_log(&small, black);
    let source = MaskSource::new(image, &dcp, meta, neutral, black, flare);
    let mask = source.render(&cancel).unwrap();
    if let Some(upsample) = captured_root() {
      let low = Buffer::open(&upsample, "gray1_src");
      for y in low.n("t")..low.n("b") {
        for x in low.n("l")..low.n("r") {
          let actual = mask.samples[y.clamp(0, mask.height as i64 - 1) as usize * mask.width
            + x.clamp(0, mask.width as i64 - 1) as usize];
          let expected = low.pixel(y, x, 0);
          assert_eq!(actual.to_bits(), expected.to_bits(), "low mask ({y},{x})");
        }
      }
    }
    let guide = Guide::prepare(&camera, &source, [left, top], &cancel).unwrap();
    if let Some(upsample) = captured_root() {
      let high = Buffer::open(&upsample, "kernel_high_log");
      let low = Buffer::open(&upsample, "kernel_low_log_mask");
      for y in high.n("t")..high.n("b") {
        for x in high.n("l")..high.n("r") {
          let actual = guide.high[(y as usize - top) * guide.width + x as usize - left];
          assert_eq!(
            actual.to_bits(),
            high.pixel(y, x, 0).to_bits(),
            "high guide log ({y},{x})"
          );
        }
      }
      for y in low.n("t")..low.n("b") {
        for x in low.n("l")..low.n("r") {
          let actual = guide.low
            [(y + HALO as i64) as usize * (guide.low_width + 4) + (x + HALO as i64) as usize];
          assert_eq!(
            actual.to_bits(),
            low.pixel(y, x, 1).to_bits(),
            "low guide log ({y},{x})"
          );
        }
      }
    }
    let full = guide.render(&mask, &cancel).unwrap();
    let kernel: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("global.json")).unwrap()).unwrap();
    let rows = kernel["rows"].as_u64().unwrap() as usize;
    let cols = kernel["cols"].as_u64().unwrap() as usize;
    let stride = kernel["x"][5].as_u64().unwrap() as usize;
    let rect_file = std::fs::read_dir(&root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .find(|p| {
        p.file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("_cr_stage_tone_map_rect.json")
      })
      .unwrap();
    let rect: serde_json::Value =
      serde_json::from_slice(&std::fs::read(rect_file).unwrap()).unwrap();
    let y0 = rect["rect"][0].as_u64().unwrap() as usize - top;
    let x0 = rect["rect"][1].as_u64().unwrap() as usize - left;
    let expected = std::fs::read(root.join("global_mask.bin")).unwrap();
    let mut different = 0;
    let mut maximum = 0.0f32;
    for y in 0..rows {
      for x in 0..cols {
        let offset = (y * stride + x) * 4;
        let expected = f32::from_le_bytes(expected[offset..offset + 4].try_into().unwrap());
        let actual = full[(y0 + y) * width + x0 + x];
        if actual.to_bits() != expected.to_bits() {
          if different < 8 {
            eprintln!(
              "main mask {},{}: {actual:?} vs {expected:?} ({:08x} vs {:08x})",
              y0 + y,
              x0 + x,
              actual.to_bits(),
              expected.to_bits()
            );
          }
          different += 1;
          maximum = maximum.max((actual - expected).abs());
        }
      }
    }
    eprintln!(
      "main pipeline mask: {different}/{} different; maximum {maximum}",
      rows * cols
    );
    assert_eq!(different, 0);
  }
}
