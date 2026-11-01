//! The small camera-image pyramid used for scene statistics. This branch
//! precedes user noise reduction and uses the PCS white, rather than the
//! photograph's render white. CPU boundaries follow 18.7's BuildPyramidLevel
//! and BuildGrayLogImage; local captures validate the reductions and stages.

use crate::adobe::{bayer::tables, color::ColorSpec, dcp::Dcp, input::InputTransform};
use crate::metadata::RawMetadata;

use rayon::prelude::*;

const ENCODE_SCALE: f32 = f32::from_bits(0x3f88_3ff0);
const DECODE_SCALE: f32 = f32::from_bits(0x3f70_7fe0);

pub(super) fn nonlinear(x: f64, black: f64, inverse: bool) -> f64 {
  let encoded_black = if black > 0.0 { 0.25 } else { 0.0 };
  let (input_black, output_black) = if inverse {
    (encoded_black, black)
  } else {
    (black, encoded_black)
  };
  let x = (x - input_black) * (-1.0 / (input_black - 1.0));
  let magnitude = x.abs() as f32;
  let value = if inverse {
    let v = magnitude.mul_add(DECODE_SCALE, 0.0625);
    v.mul_add(v, -0.00390625)
  } else {
    ((magnitude + 0.00390625).sqrt() - 0.0625) * ENCODE_SCALE
  };
  let value = if x < 0.0 { -value } else { value };
  f64::from(value)
    .mul_add(1.0 - output_black, output_black)
    .clamp(0.0, 1.0)
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct SmallImage {
  pub(crate) pixels: Vec<[u16; 3]>,
  pub(crate) width: usize,
  pub(crate) height: usize,
  pub(crate) level: usize,
  pub(crate) full_width: usize,
  pub(crate) full_height: usize,
}

/// Source is the default-cropped, preserved-black camera RGB image, including
/// embedded lateral CA. Dimensions of every level round from the full image.
pub(crate) fn camera_pyramid(
  source: &[[u16; 3]],
  width: usize,
  height: usize,
  black: f64,
  use_nonlinear: bool,
) -> SmallImage {
  assert!(width > 0 && height > 0 && source.len() == width * height);
  build_pyramid(width, height, black, use_nonlinear, 5, |i| source[i])
}

/// The same source expressed as normalized, already quantized camera pixels.
/// Reducing directly avoids a second full-resolution camera-image allocation.
pub(crate) fn camera_pyramid_f32(
  source: &[[f32; 3]],
  width: usize,
  height: usize,
  black: f64,
  use_nonlinear: bool,
) -> SmallImage {
  assert!(width > 0 && height > 0 && source.len() == width * height);
  build_pyramid(width, height, black, use_nonlinear, 5, |i| {
    source[i].map(tables::code)
  })
}

/// Reduce a default-crop region while the caller retains the surrounding active
/// sensor image for noise reduction.
pub(crate) fn camera_pyramid_f32_region(
  source: &crate::image::RgbImage,
  left: usize,
  top: usize,
  width: usize,
  height: usize,
  black: f64,
  use_nonlinear: bool,
) -> SmallImage {
  assert!(width > 0 && height > 0 && left + width <= source.width && top + height <= source.height);
  build_pyramid(width, height, black, use_nonlinear, 5, |i| {
    source
      .px(left + i % width, top + i / width)
      .map(tables::code)
  })
}

/// Retain a particular camera-pyramid level for a later spatial tone edit.
pub(crate) fn camera_pyramid_f32_region_at_level(
  source: &crate::image::RgbImage,
  left: usize,
  top: usize,
  width: usize,
  height: usize,
  black: f64,
  use_nonlinear: bool,
  level: usize,
) -> SmallImage {
  assert!(level <= 5);
  assert!(width > 0 && height > 0 && left + width <= source.width && top + height <= source.height);
  build_pyramid(width, height, black, use_nonlinear, level, |i| {
    source
      .px(left + i % width, top + i / width)
      .map(tables::code)
  })
}

/// Continue a retained camera pyramid to the scene-statistics level, avoiding
/// a second pass over the full-resolution source when a tone mask is cached.
pub(crate) fn deepen(image: &SmallImage, black: f64, use_nonlinear: bool) -> SmallImage {
  let encode = use_nonlinear.then(|| tables::expand(|x| nonlinear(x, black, false)));
  let decode = use_nonlinear.then(|| tables::expand(|x| nonlinear(x, black, true)));
  let mut current = image.clone();
  for level in image.level + 1..=5 {
    let width = ((image.full_width + (1 << (level - 1))) >> level).max(1);
    let height = ((image.full_height + (1 << (level - 1))) >> level).max(1);
    if current.width.max(current.height) <= 64 || width.max(height) < 128 {
      break;
    }
    let pixels = reduce_codes(
      |i| current.pixels[i],
      [current.width, current.height],
      [width, height],
      encode.as_deref(),
      decode.as_deref(),
    );
    current = SmallImage {
      pixels,
      width,
      height,
      level,
      ..current
    };
  }
  current
}

fn build_pyramid(
  width: usize,
  height: usize,
  black: f64,
  use_nonlinear: bool,
  maximum_level: usize,
  source: impl Fn(usize) -> [u16; 3] + Sync,
) -> SmallImage {
  let encode = use_nonlinear.then(|| tables::expand(|x| nonlinear(x, black, false)));
  let decode = use_nonlinear.then(|| tables::expand(|x| nonlinear(x, black, true)));
  let mut image = SmallImage {
    pixels: Vec::new(),
    width,
    height,
    level: 0,
    full_width: width,
    full_height: height,
  };
  for level in 1..=maximum_level {
    if image.width.max(image.height) <= 64 {
      break;
    }
    let output_width = ((width + (1 << (level - 1))) >> level).max(1);
    let output_height = ((height + (1 << (level - 1))) >> level).max(1);
    // GetPyramidLevel retains the previous level once the next is < 128 px.
    if output_width.max(output_height) < 128 {
      break;
    }
    let output = reduce_codes(
      |i| {
        if image.level == 0 {
          source(i)
        } else {
          image.pixels[i]
        }
      },
      [image.width, image.height],
      [output_width, output_height],
      encode.as_deref(),
      decode.as_deref(),
    );
    image = SmallImage {
      pixels: output,
      width: output_width,
      height: output_height,
      level,
      full_width: width,
      full_height: height,
    };
  }
  if image.level == 0 {
    image.pixels = (0..width * height).map(source).collect();
  }
  image
}

fn reduce_codes(
  source: impl Fn(usize) -> [u16; 3] + Sync,
  [width, height]: [usize; 2],
  [output_width, output_height]: [usize; 2],
  encode: Option<&[u16]>,
  decode: Option<&[u16]>,
) -> Vec<[u16; 3]> {
  let mut output = vec![[0; 3]; output_width * output_height];
  // Rows are independent; retain the four integer contributions and rounding
  // within each pixel rather than parallelizing a reduction across samples.
  let reduce_row = |(y, row): (usize, &mut [[u16; 3]])| {
    for (x, out) in row.iter_mut().enumerate() {
      let mut sum = [2u32; 3];
      for dy in 0..2 {
        for dx in 0..2 {
          let pixel = source((y * 2 + dy).min(height - 1) * width + (x * 2 + dx).min(width - 1));
          for c in 0..3 {
            sum[c] += u32::from(encode.map_or(pixel[c], |t| t[pixel[c] as usize]));
          }
        }
      }
      for c in 0..3 {
        let value = (sum[c] >> 2) as u16;
        out[c] = decode.map_or(value, |t| t[value as usize]);
      }
    }
  };
  if output.len() >= 16_384 {
    output
      .par_chunks_mut(output_width)
      .enumerate()
      .for_each(reduce_row);
  } else {
    output
      .chunks_mut(output_width)
      .enumerate()
      .for_each(reduce_row);
  }
  output
}

fn black_samples(black: f64) -> Vec<f32> {
  let inverse = -1.0 / (black - 1.0);
  let mut samples: Vec<_> = (0..=4096)
    .map(|i| (((i as f64 / 4096.0) - black) * inverse).clamp(0.0, 1.0) as f32)
    .collect();
  samples.push(samples[4096]);
  samples
}

fn lookup(samples: &[f32], value: f32) -> f32 {
  let x = value * 4096.0;
  let i = (x as usize).min(4096);
  let fraction = x - i as f32;
  samples[i].mul_add(1.0 - fraction, fraction * samples[i + 1])
}

fn gray([r, g, b]: [f32; 3]) -> f32 {
  b.mul_add(0.110000014, r.mul_add(0.3, g * 0.59)).max(0.0)
}

pub(super) fn logarithm(value: f32, flare: f32) -> f32 {
  let log = (flare + value.abs().min(f32::from_bits(0x7b80_0000))).log2();
  if value < 0.0 {
    2.0 * flare.log2() - log
  } else {
    log
  }
}

/// Per-channel statistics use the same camera pyramid, black-removal table and
/// logarithm, before white balance or camera-to-RGB conversion.
pub(crate) fn channel_logs(image: &SmallImage, black: f64, flare: f64) -> [Vec<f32>; 3] {
  let table = black_samples(black);
  std::array::from_fn(|c| {
    image
      .pixels
      .iter()
      .map(|p| logarithm(lookup(&table, tables::normalized(p[c])), flare as f32))
      .collect()
  })
}

/// The regular, unencoded integer-camera path of CalculateFlareForLog. Flare
/// uses the deepest available pyramid, including levels below 128 pixels that
/// scene statistics omit. Black subtraction crosses the 16-bit boundary before
/// the three plane means. A zero estimate receives NegativeToFlareForLog's
/// default floor when this value is consumed by statistics.
pub(crate) fn flare_for_log(image: &SmallImage, black: f64) -> f64 {
  let mut deeper: Option<SmallImage> = None;
  if image.level < 5 && image.width.max(image.height) > 64 {
    let encode = tables::expand(|x| nonlinear(x, black, false));
    let decode = tables::expand(|x| nonlinear(x, black, true));
    for level in image.level + 1..=5 {
      let current = deeper.as_ref().unwrap_or(image);
      if current.width.max(current.height) <= 64 {
        break;
      }
      let width = ((image.full_width + (1 << (level - 1))) >> level).max(1);
      let height = ((image.full_height + (1 << (level - 1))) >> level).max(1);
      let pixels = reduce_codes(
        |i| current.pixels[i],
        [current.width, current.height],
        [width, height],
        Some(&encode),
        Some(&decode),
      );
      deeper = Some(SmallImage {
        pixels,
        width,
        height,
        level,
        full_width: image.full_width,
        full_height: image.full_height,
      });
    }
  }
  let image = deeper.as_ref().unwrap_or(image);
  let table = crate::adobe::color_table::remove_black_table(black);
  let mut mean = 0.0;
  for c in 0..3 {
    let sum: u64 = image
      .pixels
      .iter()
      .map(|p| u64::from(table[p[c] as usize]))
      .sum();
    mean += sum as f64 / image.pixels.len() as f64;
  }
  mean /= 3.0;
  mean *= 1.0 / 65535.0;
  let flare = (mean * (1.0 / 1048576.0)).clamp(0.0, 1.0 / 4096.0);
  if flare > 0.0 { flare } else { 1.0 / 4096.0 }
}

pub(crate) struct GrayLogImage {
  black_table: Vec<f32>,
  transform: InputTransform,
  gain: f32,
}

impl GrayLogImage {
  pub(crate) fn new(dcp: &Dcp, meta: &RawMetadata, neutral: [f64; 3], black: f64) -> Self {
    let spec = ColorSpec::for_statistics(dcp, meta, neutral);
    let transform = InputTransform::new(&spec, neutral, 0.0);
    let gain = (1.0 / transform.noise_scale()) as f32;
    Self {
      black_table: black_samples(black),
      transform,
      gain,
    }
  }

  /// Ordinary three-plane camera inputs with a NOP negative render curve.
  pub(crate) fn render(&self, image: &SmallImage, flare: f64) -> Vec<f32> {
    image
      .pixels
      .iter()
      .map(|p| {
        let input = p.map(|v| lookup(&self.black_table, tables::normalized(v)));
        logarithm(gray(self.transform.pixel(input)) * self.gain, flare as f32)
      })
      .collect()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pyramid_codes_are_identical_across_thread_counts_and_odd_edges() {
    for (width, height) in [(127, 131), (1031, 773)] {
      let source: Vec<[u16; 3]> = (0..width * height)
        .map(|i| std::array::from_fn(|c| ((i * 1297 + c * 7919) % 65536) as u16))
        .collect();
      for nonlinear in [false, true] {
        let results: Vec<_> = [1, 4]
          .into_iter()
          .map(|threads| {
            let pool = rayon::ThreadPoolBuilder::new()
              .num_threads(threads)
              .build()
              .unwrap();
            pool.install(|| camera_pyramid(&source, width, height, 4092.0 / 65535.0, nonlinear))
          })
          .collect();
        assert_eq!(results[0].pixels, results[1].pixels);
        assert_eq!(
          (results[0].width, results[0].height, results[0].level),
          (results[1].width, results[1].height, results[1].level)
        );
      }
    }
  }

  #[test]
  fn pyramid_constant_and_full_image_rounding() {
    let image = camera_pyramid(&vec![[8192; 3]; 515 * 773], 773, 515, 0.0, false);
    assert_eq!((image.width, image.height), (193, 129));
    assert!(image.pixels.iter().all(|p| *p == [8192; 3]));
    assert_eq!(gray([1.0; 3]), 1.0);
    assert_eq!(logarithm(0.0, 1.0 / 4096.0), -12.0);
    for (value, expected) in [(0, 1.0 / 4096.0), (65535, 1.0 / 1048576.0)] {
      let image = camera_pyramid(&vec![[value; 3]; 173 * 115], 173, 115, 0.0, true);
      assert_eq!(image.level, 0);
      assert_eq!(flare_for_log(&image, 0.0), expected);
    }
  }

  fn floats(path: &std::path::Path) -> Vec<f32> {
    std::fs::read(path)
      .unwrap()
      .chunks_exact(4)
      .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
      .collect()
  }

  struct Buffer {
    header: serde_json::Value,
    bytes: Vec<u8>,
  }

  impl Buffer {
    fn open(path: &std::path::Path, stem: &str, suffix: &str) -> Self {
      Self {
        header: serde_json::from_slice(
          &std::fs::read(path.join(format!("{stem}_{suffix}.json"))).unwrap(),
        )
        .unwrap(),
        bytes: std::fs::read(path.join(format!("{stem}_{suffix}.bin"))).unwrap(),
      }
    }

    fn n(&self, name: &str) -> i64 {
      self.header[name].as_i64().unwrap()
    }

    fn index(&self, y: i64, x: i64, c: i64) -> usize {
      ((y - self.n("t")) * self.n("row_step")
        + (x - self.n("l")) * self.n("col_step")
        + (c - self.n("plane")) * self.n("plane_step")) as usize
    }

    fn f32(&self, y: i64, x: i64, c: i64) -> f32 {
      let i = self.index(y, x, c) * 4;
      f32::from_le_bytes(self.bytes[i..i + 4].try_into().unwrap())
    }

    fn code(&self, y: i64, x: i64, c: i64) -> u16 {
      let i = self.index(y, x, c) * 2;
      let v = u16::from_le_bytes(self.bytes[i..i + 2].try_into().unwrap());
      if self.n("ptype") == 8 { v ^ 32768 } else { v }
    }
  }

  #[test]
  fn captured_pyramid_tables() {
    let Some(root) = std::env::var_os("ADOBE_STATS_IMAGE_CAPTURE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("gray-00.json")).unwrap()).unwrap();
    let black = meta["black"].as_f64().unwrap() / 65535.0;
    for (name, inverse) in [
      ("append-001_data_28.bin", false),
      ("append-003_data_28.bin", true),
    ] {
      let actual: Vec<_> = (0..=4096)
        .chain(std::iter::once(4096))
        .map(|i| nonlinear(i as f64 / 4096.0, black, inverse) as f32)
        .collect();
      assert_eq!(
        actual,
        floats(&root.join("pyramid-04").join(name)),
        "{name}"
      );
    }
    assert_eq!(
      black_samples(black),
      floats(&root.join("gray-00/append-001_data_28.bin"))
    );
  }

  #[test]
  fn captured_pyramid_reductions_and_gray_stages() {
    let Some(root) = std::env::var_os("ADOBE_STATS_IMAGE_CAPTURE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let mut checked = [0usize; 4];
    for directory in ["pyramid-03", "pyramid-04", "gray-00"] {
      let path = root.join(directory);
      if !path.is_dir() {
        continue;
      }
      for entry in std::fs::read_dir(&path).unwrap() {
        let file = entry.unwrap().path();
        let name = file.file_name().unwrap().to_string_lossy();
        if !name.ends_with(".json") || name.contains("_src") || name.contains("_dst") {
          continue;
        }
        let meta: serde_json::Value =
          serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let Some(function) = meta["name"].as_str() else {
          continue;
        };
        let kind = if function.starts_with("cr_stage_pyramid::") {
          0
        } else if function.starts_with("cr_stage_RGBToGray::") {
          1
        } else if function.starts_with("cr_stage_simple_exposure::") {
          2
        } else if function.starts_with("cr_stage_LinearToLog2::") {
          3
        } else {
          continue;
        };
        let stem = name.strip_suffix(".json").unwrap();
        let src = Buffer::open(&path, stem, "src");
        let dst = Buffer::open(&path, stem, "dst");
        let object = std::fs::read(path.join(format!("{stem}_obj.bin"))).unwrap();
        let parameter = |offset| f32::from_le_bytes(object[offset..offset + 4].try_into().unwrap());
        let area: Vec<i64> = if kind == 0 {
          ["t", "l", "b", "r"].map(|k| dst.n(k)).to_vec()
        } else {
          meta["area"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_i64().unwrap())
            .collect()
        };
        for y in area[0]..area[2] {
          for x in area[1]..area[3] {
            if kind == 0 {
              for c in 0..dst.n("planes") {
                let sum: u32 = (0..2)
                  .flat_map(|dy| (0..2).map(move |dx| (dy, dx)))
                  .map(|(dy, dx)| u32::from(src.code(y * 2 + dy, x * 2 + dx, c)))
                  .sum();
                assert_eq!(((sum + 2) >> 2) as u16, dst.code(y, x, c), "{stem}");
                checked[kind] += 1;
              }
            } else {
              let input = src.f32(y, x, 0);
              let actual = match kind {
                1 => gray(std::array::from_fn(|c| src.f32(y, x, c as i64))),
                2 => input * parameter(0x30),
                3 => logarithm(input, parameter(0x24)),
                _ => unreachable!(),
              };
              assert_eq!(
                actual.to_bits(),
                dst.f32(y, x, 0).to_bits(),
                "{stem} ({y},{x})"
              );
              checked[kind] += 1;
            }
          }
        }
      }
    }
    assert!(checked.iter().all(|n| *n > 0));
    eprintln!("small-image kernel samples {checked:?}");
  }

  #[test]
  fn captured_d50_camera_transform() {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("ADOBE_STATS_IMAGE_CAPTURE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&root);
    let metadata = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp = Dcp::open(
      &Dcp::find_adobe_standard(
        std::path::Path::new(&profiles),
        &metadata.make,
        &metadata.model,
      )
      .unwrap(),
    )
    .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(metadata.as_shot_wb.map(|v| 1.0 / v));
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("gray-00.json")).unwrap()).unwrap();
    let transform = GrayLogImage::new(
      &dcp,
      &metadata,
      neutral,
      meta["black"].as_f64().unwrap() / 65535.0,
    );
    let path = root.join("gray-00");
    let mut samples = 0;
    for entry in std::fs::read_dir(&path).unwrap() {
      let file = entry.unwrap().path();
      let name = file.file_name().unwrap().to_string_lossy();
      let Some(stem) = name.strip_suffix("_cr_stage_ABCtoRGB_local.json") else {
        continue;
      };
      let stem = format!("{stem}_cr_stage_ABCtoRGB_local");
      let src = Buffer::open(&path, &stem, "src");
      let dst = Buffer::open(&path, &stem, "dst");
      for y in src.n("t")..src.n("b") {
        for x in src.n("l")..src.n("r") {
          let actual = transform
            .transform
            .pixel(std::array::from_fn(|c| src.f32(y, x, c as i64)));
          for c in 0..3 {
            assert_eq!(
              actual[c].to_bits(),
              dst.f32(y, x, c as i64).to_bits(),
              "{stem} ({y},{x},{c})"
            );
            samples += 1;
          }
        }
      }
    }
    assert!(samples > 0);
  }

  #[test]
  fn captured_composed_small_image() {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("ADOBE_STATS_IMAGE_CAPTURE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&root);
    let metadata = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp = Dcp::open(
      &Dcp::find_adobe_standard(
        std::path::Path::new(&profiles),
        &metadata.make,
        &metadata.model,
      )
      .unwrap(),
    )
    .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(metadata.as_shot_wb.map(|v| 1.0 / v));
    let first_pyramid = if root.join("pyramid-03").is_dir() {
      "pyramid-03"
    } else {
      "pyramid-04"
    };
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join(format!("{first_pyramid}.json"))).unwrap())
        .unwrap();
    let width = meta["src"]["area"][3].as_u64().unwrap() as usize;
    let height = meta["src"]["area"][2].as_u64().unwrap() as usize;
    let black = meta["black"].as_f64().unwrap();
    let mut source = vec![[0; 3]; width * height];
    let path = root.join(first_pyramid);
    for entry in std::fs::read_dir(&path).unwrap() {
      let file = entry.unwrap().path();
      let name = file.file_name().unwrap().to_string_lossy();
      let Some(stem) = name.strip_suffix("_cr_stage_get_image.json") else {
        continue;
      };
      let b = Buffer::open(&path, &format!("{stem}_cr_stage_get_image"), "dst");
      for y in b.n("t")..b.n("b").min(height as i64) {
        for x in b.n("l")..b.n("r").min(width as i64) {
          source[y as usize * width + x as usize] = std::array::from_fn(|c| b.code(y, x, c as i64));
        }
      }
    }
    let remaining = if first_pyramid == "pyramid-03" { 2 } else { 1 };
    let small = build_pyramid(width, height, black, true, remaining, |i| source[i]);
    let transform = GrayLogImage::new(&dcp, &metadata, neutral, black);
    let path = root.join("gray-00");
    let mut flare = None;
    let mut expected = vec![0.0f32; small.width * small.height];
    let mut samples = 0;
    for entry in std::fs::read_dir(&path).unwrap() {
      let file = entry.unwrap().path();
      let name = file.file_name().unwrap().to_string_lossy();
      if let Some(stem) = name.strip_suffix("_cr_stage_get_image.json") {
        let b = Buffer::open(&path, &format!("{stem}_cr_stage_get_image"), "dst");
        for y in b.n("t")..b.n("b") {
          for x in b.n("l")..b.n("r") {
            for c in 0..3 {
              assert_eq!(
                small.pixels[y as usize * small.width + x as usize][c],
                tables::code(b.f32(y, x, c as i64))
              );
              samples += 1;
            }
          }
        }
      }
      if let Some(stem) = name.strip_suffix("_cr_stage_LinearToLog2.json") {
        let stem = format!("{stem}_cr_stage_LinearToLog2");
        let b = Buffer::open(&path, &stem, "dst");
        let object = std::fs::read(path.join(format!("{stem}_obj.bin"))).unwrap();
        flare = Some(f32::from_le_bytes(object[0x24..0x28].try_into().unwrap()));
        for y in b.n("t")..b.n("b") {
          for x in b.n("l")..b.n("r") {
            expected[y as usize * small.width + x as usize] = b.f32(y, x, 0);
          }
        }
      }
    }
    assert_eq!(samples, small.pixels.len() * 3);
    let actual = transform.render(&small, f64::from(flare.unwrap()));
    assert_eq!(actual, expected);
    eprintln!(
      "composed small camera image: {samples} codes and {} log samples",
      actual.len()
    );
  }

  /// AutoLateralCA is off; mandatory embedded lateral CA remains enabled.
  #[test]
  fn captured_camera_pyramid() {
    let (Some(root), Some(raw)) = (
      std::env::var_os("ADOBE_STATS_IMAGE_CAPTURE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&root);
    let negative = crate::Negative::open(raw).unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(negative.meta.as_shot_wb.map(|v| 1.0 / v));
    let image = if negative.meta.cfa.is_xtrans() {
      crate::adobe::xtrans::develop_preserved_with_lens(
        &negative,
        neutral,
        true,
        &crate::Cancel::never(),
      )
      .unwrap()
    } else {
      crate::adobe::bayer::develop_unbalanced(&negative, true, &crate::Cancel::never()).unwrap()
    };
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("gray-00.json")).unwrap()).unwrap();
    let black = meta["black"].as_f64().unwrap() / 65535.0;
    let small = camera_pyramid_f32(
      image.data.as_chunks::<3>().0,
      image.width,
      image.height,
      black,
      true,
    );
    assert_eq!(small.level, meta["level"].as_u64().unwrap() as usize);
    assert_eq!(
      (small.full_width, small.full_height),
      (image.width, image.height)
    );
    let path = root.join("gray-00");
    let mut different = 0;
    let mut samples = 0;
    for entry in std::fs::read_dir(&path).unwrap() {
      let file = entry.unwrap().path();
      let name = file.file_name().unwrap().to_string_lossy();
      let Some(stem) = name.strip_suffix("_cr_stage_get_image.json") else {
        continue;
      };
      let b = Buffer::open(&path, &format!("{stem}_cr_stage_get_image"), "dst");
      for y in b.n("t")..b.n("b") {
        for x in b.n("l")..b.n("r") {
          for c in 0..3 {
            different += usize::from(
              small.pixels[y as usize * small.width + x as usize][c]
                != tables::code(b.f32(y, x, c as i64)),
            );
            samples += 1;
          }
        }
      }
    }
    assert_eq!(samples, small.pixels.len() * 3);
    eprintln!("full camera pyramid: {different} differences in {samples} samples");
    assert_eq!(different, 0);
    let negative = std::fs::read(root.join("gray-00_negative.bin")).unwrap();
    let expected_flare = f64::from_le_bytes(negative[0x1768..0x1770].try_into().unwrap());
    let actual_flare = flare_for_log(&small, black);
    eprintln!("flare {actual_flare:.17e} vs {expected_flare:.17e}");
    assert_eq!(actual_flare.to_bits(), expected_flare.to_bits());
    let parent = root.parent().unwrap();
    if parent.join("stats-01.sorted.f32").is_file() {
      let mut captured: Vec<_> = (1..=3)
        .map(|i| floats(&parent.join(format!("stats-{i:02}.sorted.f32"))))
        .collect();
      for mut channel in channel_logs(&small, black, actual_flare) {
        channel.sort_unstable_by(f32::total_cmp);
        let index = captured
          .iter()
          .position(|expected| *expected == channel)
          .unwrap();
        captured.remove(index);
      }
      assert!(captured.is_empty());
      eprintln!("all three camera-channel log images match captured distributions");
    }
  }
}
