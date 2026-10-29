//! Gaussian and local Laplacian operations for the Highlights/Shadows mask.
//!
//! Camera Raw 18.7 uses a separable Gaussian resampler, not a fixed binomial
//! reduction. Each level rounds its size up and retains the original log image
//! as the interpolation guide. The remap used by the tone mask clips each
//! sample image to an interval around its sample centre.

use super::statistics::Statistics;
use crate::{Cancel, Error, Result};
use rayon::prelude::*;

/// Rows are independent; tap order and the outer remap-sample accumulation stay
/// serial. Small pyramid levels avoid scheduling overhead.
fn for_rows(
  pixels: &mut [f32],
  width: usize,
  cancel: &Cancel,
  f: impl Fn(usize, &mut [f32]) + Sync,
) -> Result<()> {
  let apply = |(y, row): (usize, &mut [f32])| {
    cancel.check()?;
    f(y, row);
    Ok(())
  };
  if pixels.len() >= 65536 {
    pixels
      .par_chunks_mut(width)
      .enumerate()
      .with_min_len((8192 / width).max(1))
      .try_for_each(apply)
  } else {
    pixels.chunks_mut(width).enumerate().try_for_each(apply)
  }
}

#[derive(Clone, Debug)]
pub(super) struct Image {
  pub(super) pixels: Vec<f32>,
  pub(super) width: usize,
  pub(super) height: usize,
}

impl Image {
  fn reduce(&self, cancel: &Cancel) -> Result<Self> {
    self.resize(self.width.div_ceil(2), self.height.div_ceil(2), cancel)
  }

  fn resize(&self, width: usize, height: usize, cancel: &Cancel) -> Result<Self> {
    cancel.check()?;
    let mut pixels = self.pixels.clone();
    if height != self.height {
      let axis = Axis::new(self.height, height);
      pixels = vec![0.0; self.width * height];
      for_rows(&mut pixels, self.width, cancel, |y, row| {
        for (x, value) in row.iter_mut().enumerate() {
          *value = axis.sample(y as i64, true, |i| {
            self.pixels[i.clamp(0, self.height as i64 - 1) as usize * self.width + x]
          });
        }
      })?;
    }
    if width != self.width {
      let axis = Axis::new(self.width, width);
      let mut output = vec![0.0; width * height];
      for_rows(&mut output, width, cancel, |y, row| {
        for (x, value) in row.iter_mut().enumerate() {
          *value = axis.sample(x as i64, false, |j| {
            pixels[y * self.width + j.clamp(0, self.width as i64 - 1) as usize]
          });
        }
      })?;
      pixels = output;
    }
    Ok(Self {
      pixels,
      width,
      height,
    })
  }

  fn reduce_and_expand(&self, cancel: &Cancel) -> Result<(Self, Self)> {
    let width = self.width.div_ceil(2);
    let height = self.height.div_ceil(2);
    let halo = 2;
    let stride = width + halo * 2;
    let rows = height + halo * 2;
    let reduce_y = Axis::new(self.height, height);
    let reduce_x = Axis::new(self.width, width);
    let mut vertical = vec![0.0; self.width * rows];
    for_rows(&mut vertical, self.width, cancel, |y, row| {
      for (x, value) in row.iter_mut().enumerate() {
        *value = if height == self.height {
          self.pixels
            [(y as i64 - halo as i64).clamp(0, self.height as i64 - 1) as usize * self.width + x]
        } else {
          reduce_y.sample(y as i64 - halo as i64, true, |j| {
            self.pixels[j.clamp(0, self.height as i64 - 1) as usize * self.width + x]
          })
        };
      }
    })?;
    let mut extended = vec![0.0; stride * rows];
    for_rows(&mut extended, stride, cancel, |y, row| {
      for (x, value) in row.iter_mut().enumerate() {
        *value = if width == self.width {
          vertical
            [y * self.width + (x as i64 - halo as i64).clamp(0, self.width as i64 - 1) as usize]
        } else {
          reduce_x.sample(x as i64 - halo as i64, false, |j| {
            vertical[y * self.width + j.clamp(0, self.width as i64 - 1) as usize]
          })
        };
      }
    })?;
    let next = Self {
      pixels: (0..height)
        .flat_map(|y| {
          extended[(y + halo) * stride + halo..(y + halo) * stride + halo + width]
            .iter()
            .copied()
        })
        .collect(),
      width,
      height,
    };
    // The incremental graph expands the freshly reduced buffer, including
    // its resampled halo. Repeating the retained next image's edge would
    // change the Laplacian details along every pyramid boundary.
    let expand_y = Axis::new(height, self.height);
    let expand_x = Axis::new(width, self.width);
    let mut vertical = vec![0.0; stride * self.height];
    for_rows(&mut vertical, stride, cancel, |y, row| {
      for (x, value) in row.iter_mut().enumerate() {
        *value = if height == self.height {
          extended[(y + halo) * stride + x]
        } else {
          expand_y.sample(y as i64, true, |j| {
            extended[(j + halo as i64) as usize * stride + x]
          })
        };
      }
    })?;
    let mut expanded = self.clone();
    for_rows(&mut expanded.pixels, self.width, cancel, |y, row| {
      for (x, value) in row.iter_mut().enumerate() {
        *value = if width == self.width {
          vertical[y * stride + x + halo]
        } else {
          expand_x.sample(x as i64, false, |j| {
            vertical[y * stride + (j + halo as i64) as usize]
          })
        };
      }
    })?;
    Ok((next, expanded))
  }
}

struct Axis {
  source: usize,
  step: i64,
  origin: i64,
  radius: usize,
  weights: Vec<Vec<f32>>,
}

impl Axis {
  fn new(source: usize, target: usize) -> Self {
    let step = (source as f64 / target as f64 * 4294967296.0).round() as i64;
    let scale = (1.0 / (step as f64 * (1.0 / 4294967296.0))).min(1.0);
    let radius = (2.0 / scale).ceil() as usize;
    let weights = (0..128)
      .map(|phase| {
        let mut values: Vec<_> = (0..radius * 2)
          .map(|j| {
            let x = ((j as i64 - radius as i64 + 1) as f64 - phase as f64 / 128.0) * scale;
            if x >= 2.0 {
              0.0
            } else {
              ((x * -2.0) * x).exp() as f32
            }
          })
          .collect();
        let sum = values.iter().fold(0.0f64, |sum, &v| sum + f64::from(v));
        let inverse = (1.0 / sum) as f32;
        values.iter_mut().for_each(|v| *v *= inverse);
        values
      })
      .collect();
    Self {
      source,
      step,
      origin: (step >> 1) + ((1 - radius as i64) << 32) - 0x7f00_0000,
      radius,
      weights,
    }
  }

  fn coordinate(&self, index: i64) -> (i64, usize) {
    let coordinate = (self.origin + self.step * index).clamp(
      (1 - self.radius as i64) << 32,
      (self.source as i64 - self.radius as i64) << 32,
    );
    let start = coordinate >> 32;
    let phase = ((coordinate as u64 >> 25) & 127) as usize;
    (start, phase)
  }

  fn sample(&self, index: i64, vertical: bool, source: impl Fn(i64) -> f32) -> f32 {
    let (start, phase) = self.coordinate(index);
    let weights = &self.weights[phase];
    if vertical {
      weights.iter().enumerate().fold(0.0, |sum, (j, &w)| {
        if w == 0.0 {
          sum
        } else {
          source(start + j as i64).mul_add(w, sum)
        }
      })
    } else {
      // RefResampleH32's four-, six- and eight-tap paths evaluate the
      // second product before fusing the first, then append the other taps.
      let mut sum = source(start).mul_add(weights[0], source(start + 1) * weights[1]);
      for (j, &w) in weights.iter().enumerate().skip(2) {
        sum = source(start + j as i64).mul_add(w, sum);
      }
      sum
    }
  }
}

fn pyramid(source: &Image, cancel: &Cancel) -> Result<Vec<Image>> {
  let mut images = vec![source.clone()];
  while images.len() < 16 {
    let image = images.last().unwrap();
    if image.width < 2 && image.height < 2 {
      break;
    }
    images.push(image.reduce(cancel)?);
  }
  Ok(images)
}

fn statistics_level(images: &[Image]) -> usize {
  images
    .iter()
    .enumerate()
    .skip(1)
    .find(|(_, image)| image.width.max(image.height) < 128)
    .map_or(images.len() - 1, |(level, _)| level - 1)
}

fn sigma(stats: &Statistics, flare: f64) -> f32 {
  let [low, high, _] = stats.laplacian_range();
  let x = high - low;
  let points: [(f64, f64); 6] = [
    (2.0, 1.4),
    (3.5, 1.6),
    (5.0, 2.3),
    (6.5, 2.5),
    (12.0, 2.5),
    (14.0, 2.0),
  ];
  let value = if x <= points[0].0 {
    points[0].1
  } else {
    points
      .windows(2)
      .find_map(|p| {
        (x <= p[1].0).then(|| {
          let t = (x - p[0].0) / (p[1].0 - p[0].0);
          (p[1].1 - p[0].1).mul_add(t, p[0].1)
        })
      })
      .unwrap_or(points[5].1)
  };
  (flare + value).log2() as f32
}

/// Filter a finite one-plane log image, returning the image and the statistics
/// measured at the matching small pyramid level before mean normalization.
pub(super) fn filter(
  source: &Image,
  flare: f64,
  cancel: &Cancel,
) -> Result<(Image, Statistics, Statistics)> {
  cancel.check()?;
  let invalid = || Error::Settings("Adobe tone mask requires finite image values".into());
  let gaussian = pyramid(source, cancel)?;
  let stats_level = statistics_level(&gaussian);
  let stats = Statistics::new(&gaussian[stats_level].pixels, flare).ok_or_else(invalid)?;
  if gaussian.len() == 1 {
    return Ok((source.clone(), stats.clone(), stats));
  }
  let radius = sigma(&stats, flare);
  let [low, high, median] = stats.laplacian_range().map(|v| v as f32);
  let low = low.max(median - 20.0);
  let high = high.min(median + 20.0);
  let count = ((high - low).ceil() as usize).max(1);
  let count = if count < 2 { 1 } else { count };
  let step = (high - low) / count as f32;
  let inverse = 1.0 / step;
  let mut laplacian: Vec<_> = gaussian
    .iter()
    .map(|image| Image {
      pixels: vec![0.0; image.pixels.len()],
      width: image.width,
      height: image.height,
    })
    .collect();
  *laplacian.last_mut().unwrap() = gaussian.last().unwrap().clone();
  for sample in 0..=count {
    cancel.check()?;
    let centre = (sample as f32).mul_add(step, low);
    let remapped = Image {
      pixels: source
        .pixels
        .iter()
        .map(|v| v.clamp(centre - radius, centre + radius))
        .collect(),
      width: source.width,
      height: source.height,
    };
    let mut current = remapped;
    for level in 0..gaussian.len() - 1 {
      let (next, expanded) = current.reduce_and_expand(cancel)?;
      for i in 0..current.pixels.len() {
        if i % 65536 == 0 {
          cancel.check()?;
        }
        let guide = gaussian[level].pixels[i];
        let weight = if sample == 0 {
          if guide < centre {
            1.0
          } else if guide < centre + step {
            (guide - (centre + step)) * -inverse
          } else {
            0.0
          }
        } else if sample == count {
          if guide < centre - step {
            0.0
          } else if guide < centre {
            inverse * (guide - (centre - step))
          } else {
            1.0
          }
        } else if guide < centre - step || guide >= centre + step {
          0.0
        } else if guide < centre {
          inverse * (guide - (centre - step))
        } else {
          (guide - (centre + step)) * -inverse
        };
        if weight != 0.0 {
          let detail = current.pixels[i] - expanded.pixels[i];
          laplacian[level].pixels[i] = if sample == 0 {
            weight * detail
          } else {
            detail.mul_add(weight, laplacian[level].pixels[i])
          };
        }
      }
      current = next;
    }
  }
  let mut filtered_stats = None;
  let mut collapsed = laplacian.pop().unwrap();
  for level in (0..laplacian.len()).rev() {
    let detail = &laplacian[level];
    let mut expanded = collapsed.resize(detail.width, detail.height, cancel)?;
    for (i, (value, &detail)) in expanded.pixels.iter_mut().zip(&detail.pixels).enumerate() {
      if i % 65536 == 0 {
        cancel.check()?;
      }
      *value += detail;
    }
    collapsed = expanded;
    if level == stats_level {
      filtered_stats = Statistics::new(&collapsed.pixels, flare);
    }
  }
  Ok((collapsed, stats, filtered_stats.ok_or_else(invalid)?))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::{Path, PathBuf};

  #[test]
  fn resampling_is_bit_identical_across_thread_counts() {
    let serial = rayon::ThreadPoolBuilder::new()
      .num_threads(1)
      .build()
      .unwrap();
    let parallel = rayon::ThreadPoolBuilder::new()
      .num_threads(4)
      .build()
      .unwrap();
    for (width, height) in [(513, 517), (1, 65537), (65537, 1), (17, 19)] {
      let source = Image {
        pixels: (0..width * height)
          .map(|i| ((i * 137 % 65536) as f32 - 32768.0) * (1.0 / 4096.0))
          .collect(),
        width,
        height,
      };
      let run = || {
        let (low, expanded) = source.reduce_and_expand(&Cancel::never()).unwrap();
        let resized = source
          .resize(width.div_ceil(2), height.div_ceil(2), &Cancel::never())
          .unwrap();
        [low, expanded, resized].map(|image| {
          image
            .pixels
            .into_iter()
            .map(f32::to_bits)
            .collect::<Vec<_>>()
        })
      };
      assert_eq!(
        serial.install(run),
        parallel.install(run),
        "{width}x{height}"
      );
    }
  }

  #[test]
  fn constant_skinny_images_and_cancellation() {
    for (width, height) in [(1, 1), (1, 17), (17, 1), (3, 5)] {
      let source = Image {
        pixels: vec![-2.0; width * height],
        width,
        height,
      };
      let (result, _, _) = filter(&source, 1e-7, &Cancel::never()).unwrap();
      assert_eq!((result.width, result.height), (width, height));
      assert!(
        result
          .pixels
          .iter()
          .all(|v| v.is_finite() && (v + 2.0).abs() < 1e-5)
      );
      let cancel = Cancel::new();
      cancel.cancel();
      assert!(matches!(
        filter(&source, 1e-7, &cancel),
        Err(Error::Cancelled)
      ));
    }
  }

  struct Buffer {
    header: serde_json::Value,
    bytes: Vec<u8>,
  }

  impl Buffer {
    fn open(path: &Path) -> Self {
      Self {
        header: serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap(),
        bytes: std::fs::read(path.with_extension("bin")).unwrap(),
      }
    }

    fn n(&self, field: &str) -> i64 {
      self.header[field].as_i64().unwrap()
    }

    fn pixel(&self, y: i64, x: i64, plane: i64) -> f32 {
      let i = ((y - self.n("t")) * self.n("row_step")
        + (x - self.n("l")) * self.n("col_step")
        + plane * self.n("plane_step")) as usize
        * 4;
      f32::from_le_bytes(self.bytes[i..i + 4].try_into().unwrap())
    }
  }

  fn root() -> Option<PathBuf> {
    std::env::var_os("ADOBE_TONE_MASK_CAPTURE").map(PathBuf::from)
  }

  fn captured_log_image(root: &Path) -> Image {
    let image: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("laplacian-00.json")).unwrap()).unwrap();
    let width = image["source"]["area"][3].as_u64().unwrap() as usize;
    let height = image["source"]["area"][2].as_u64().unwrap() as usize;
    let first = std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .filter(|p| {
        p.file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("-GP-Reduce")
      })
      .min()
      .unwrap();
    let mut current = Image {
      pixels: vec![0.0; width * height],
      width,
      height,
    };
    let mut seen = vec![false; width * height];
    for entry in std::fs::read_dir(first).unwrap() {
      let p = entry.unwrap().path();
      if !p
        .file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("_cr_stage_get_image_dst.json")
      {
        continue;
      }
      let b = Buffer::open(&p);
      for y in b.n("t").max(0)..b.n("b").min(height as i64) {
        for x in b.n("l").max(0)..b.n("r").min(width as i64) {
          let i = y as usize * width + x as usize;
          current.pixels[i] = b.pixel(y, x, 0);
          seen[i] = true;
        }
      }
    }
    assert!(seen.into_iter().all(|v| v));
    current
  }

  #[test]
  fn captured_remapped_pyramids() {
    let Some(root) = root() else { return };
    let source = captured_log_image(&root);
    let cancel = Cancel::never();
    let gaussian = pyramid(&source, &cancel).unwrap();
    let params = std::fs::read(root.join("laplacian-00_params.bin")).unwrap();
    let flare = f64::from_le_bytes(params[0x20..0x28].try_into().unwrap());
    let stats = Statistics::new(&gaussian[statistics_level(&gaussian)].pixels, flare).unwrap();
    let radius = sigma(&stats, flare);
    let [low, high, median] = stats.laplacian_range().map(|v| v as f32);
    let low = low.max(median - 20.0);
    let high = high.min(median + 20.0);
    let count = ((high - low).ceil() as usize).max(1);
    let step = (high - low) / count as f32;
    let mut pipes: Vec<_> = std::fs::read_dir(&root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .filter(|p| {
        p.file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("-RenderIncremental_B")
      })
      .collect();
    pipes.sort();
    let mut checked = 0;
    for sample in 0..=count {
      let centre = (sample as f32).mul_add(step, low);
      let mut current = Image {
        pixels: source
          .pixels
          .iter()
          .map(|v| v.clamp(centre - radius, centre + radius))
          .collect(),
        width: source.width,
        height: source.height,
      };
      for pipe in pipes.iter().skip(1) {
        current = current.reduce(&cancel).unwrap();
        for entry in std::fs::read_dir(pipe).unwrap() {
          let p = entry.unwrap().path();
          if !p
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with("_cr_stage_get_image_dst.json")
          {
            continue;
          }
          let b = Buffer::open(&p);
          for y in b.n("t").max(0)..b.n("b").min(current.height as i64) {
            for x in b.n("l").max(0)..b.n("r").min(current.width as i64) {
              let actual = current.pixels[y as usize * current.width + x as usize];
              assert_eq!(
                actual.to_bits(),
                b.pixel(y, x, sample as i64).to_bits(),
                "{} sample{sample} ({y},{x}) {actual} != {}",
                p.display(),
                b.pixel(y, x, sample as i64)
              );
              checked += 1;
            }
          }
        }
      }
    }
    eprintln!("Remapped Gaussian pyramid samples {checked}");
    assert!(checked > 0);
  }

  #[test]
  fn captured_gaussian_weight_tables() {
    let Some(root) = std::env::var_os("ADOBE_TONE_WEIGHT_CAPTURE").map(PathBuf::from) else {
      return;
    };
    let mut checked = 0;
    for entry in std::fs::read_dir(&root).unwrap() {
      let file = entry.unwrap().path();
      let name = file.file_name().unwrap().to_string_lossy();
      let Some(stem) = name.strip_suffix("_weights.f32") else {
        continue;
      };
      let object = std::fs::read(root.join(format!("{stem}_obj.bin"))).unwrap();
      let i64_at = |o| i64::from_le_bytes(object[o..o + 8].try_into().unwrap());
      let i32_at = |o| i32::from_le_bytes(object[o..o + 4].try_into().unwrap());
      let step = i64_at(0x30).max(i64_at(0x38));
      let size = i32_at(0x44) as usize;
      let target = (size as f64 * 4294967296.0 / step as f64).round() as usize;
      let axis = Axis::new(size, target);
      let values = std::fs::read(&file).unwrap();
      let stride = i32_at(0x64) as usize;
      for phase in 0..128 {
        for j in 0..axis.radius * 2 {
          let i = (phase * stride + j) * 4;
          let expected = f32::from_le_bytes(values[i..i + 4].try_into().unwrap());
          assert_eq!(
            axis.weights[phase][j].to_bits(),
            expected.to_bits(),
            "{stem} {size}->{target} phase{phase} tap{j}: {} != {expected}",
            axis.weights[phase][j]
          );
          checked += 1;
        }
      }
    }
    assert!(checked > 0);
    eprintln!("Gaussian weight samples {checked}");
  }

  #[test]
  fn captured_gaussian_pyramid() {
    let Some(root) = root() else { return };
    let mut current = captured_log_image(&root);
    let mut pipes: Vec<_> = std::fs::read_dir(&root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .filter(|p| {
        p.file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("-GP-Reduce")
      })
      .collect();
    pipes.sort();
    let mut checked = 0;
    for pipe in pipes {
      current = current.reduce(&Cancel::never()).unwrap();
      for entry in std::fs::read_dir(&pipe).unwrap() {
        let p = entry.unwrap().path();
        if !p
          .file_name()
          .unwrap()
          .to_string_lossy()
          .ends_with("_cr_stage_put_image_src.json")
        {
          continue;
        }
        let b = Buffer::open(&p);
        for y in b.n("t")..b.n("b") {
          for x in b.n("l")..b.n("r") {
            assert_eq!(
              current.pixels[y as usize * current.width + x as usize].to_bits(),
              b.pixel(y, x, 0).to_bits(),
              "{} ({y},{x})",
              p.display()
            );
            checked += 1;
          }
        }
      }
    }
    eprintln!("Gaussian pyramid values {checked}");
    assert!(checked > 0);
  }

  #[test]
  fn captured_gaussian_resampling() {
    let Some(root) = root() else { return };
    let mut checked = [0; 2];
    let mut incomplete = 0;
    for directory in std::fs::read_dir(root).unwrap() {
      let directory = directory.unwrap().path();
      if !directory.is_dir() {
        continue;
      }
      for file in std::fs::read_dir(&directory).unwrap() {
        let file = file.unwrap().path();
        let name = file.file_name().unwrap().to_string_lossy();
        let vertical = name.ends_with("_cr_stage_skew_v_dst.json");
        if !vertical && !name.ends_with("_cr_stage_skew_h_dst.json") {
          continue;
        }
        let stem = name.strip_suffix("_dst.json").unwrap();
        let source = Buffer::open(&directory.join(format!("{stem}_src.json")));
        let target = Buffer::open(&file);
        let object = std::fs::read(directory.join(format!("{stem}_obj.bin"))).unwrap();
        let i64_at = |offset| i64::from_le_bytes(object[offset..offset + 8].try_into().unwrap());
        let i32_at = |offset| i32::from_le_bytes(object[offset..offset + 4].try_into().unwrap());
        let step = i64_at(if vertical { 0x38 } else { 0x30 });
        let size = i32_at(0x44) as usize;
        let target_size = (size as f64 * 4294967296.0 / step as f64).round() as usize;
        let axis = Axis::new(size, target_size);
        assert_eq!(axis.step, step, "{stem} step");
        assert_eq!(axis.origin, i64_at(0x28), "{stem} origin");
        assert_eq!(axis.radius, i32_at(0x60) as usize, "{stem} radius");
        // A few multithreaded debugger returns retained a reused buffer
        // header. Reject pairs whose recorded source cannot supply the
        // destination before indexing the capture, rather than treating
        // unrelated tiles as a resampler result.
        let complete = (target.n("t")..target.n("b")).all(|y| {
          (target.n("l")..target.n("r")).all(|x| {
            let (start, _) = axis.coordinate(if vertical { y } else { x });
            if vertical {
              source.n("t") <= start
                && start + axis.radius as i64 * 2 <= source.n("b")
                && source.n("l") <= x
                && x < source.n("r")
            } else {
              source.n("l") <= start
                && start + axis.radius as i64 * 2 <= source.n("r")
                && source.n("t") <= y
                && y < source.n("b")
            }
          })
        });
        if !complete {
          incomplete += 1;
          continue;
        }
        for y in target.n("t")..target.n("b") {
          for x in target.n("l")..target.n("r") {
            for c in 0..target.n("planes") {
              let actual = axis.sample(if vertical { y } else { x }, vertical, |j| {
                source.pixel(
                  if vertical { j } else { y },
                  if vertical { x } else { j },
                  c,
                )
              });
              assert_eq!(
                actual.to_bits(),
                target.pixel(y, x, c).to_bits(),
                "{} ({y},{x},{c}): {actual} != {}",
                file.display(),
                target.pixel(y, x, c)
              );
              checked[vertical as usize] += 1;
            }
          }
        }
      }
    }
    eprintln!("Gaussian resampler values {checked:?}; incomplete capture pairs {incomplete}");
    assert!(checked.iter().all(|&n| n > 0));
  }
}
