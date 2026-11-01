//! The small profile-coloured image used for modern tone statistics.
//!
//! `cr_image_stats_post_tone_map_cache_request` retains Highlights/Shadows and
//! resets the other global tone and detail controls. Its ordinary RAW branch
//! applies the camera transform, first DCP colour map and optional grayscale
//! tone map, resamples the default crop in quadratic-root encoding, then
//! measures linear ProPhoto luminance. It does not measure the final output.

use super::{
  mask::Mask,
  post_map::Stage,
  resample,
  stats_image::{self, SmallImage},
};
use crate::adobe::{
  bayer::tables,
  color::ColorSpec,
  color_table::{self, ColorTable},
  dcp::Dcp,
  input::InputTransform,
};
use crate::{metadata::RawMetadata, settings::WhiteBalance};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct PostToneImage {
  input: InputTransform,
  black: Vec<u16>,
  profile: Option<ColorTable>,
}

impl PostToneImage {
  pub(crate) fn valid_portable(&self) -> bool {
    self.input.valid_portable()
      && self.black.len() == 65536
      && self.profile.as_ref().is_none_or(|p| p.valid_portable())
  }

  pub(crate) fn new(
    dcp: &Dcp,
    meta: &RawMetadata,
    neutral: [f64; 3],
    black: f64,
    white: &WhiteBalance,
  ) -> Self {
    let spec = ColorSpec::for_render(dcp, meta, neutral, white);
    let input = InputTransform::new(&spec, neutral, black);
    let profile = spec.hue_sat_map.as_ref().map(|map| {
      ColorTable::new(
        map,
        dcp.hue_sat_map_encoding == 1,
        (1.0 / input.noise_scale()) as f32,
        1.0,
        false,
      )
    });
    Self {
      input,
      black: color_table::remove_black_table(black),
      profile,
    }
  }

  fn pixel_float(&self, pixel: [u16; 3]) -> [f32; 3] {
    let pixel = self.input.pixel(pixel.map(tables::normalized));
    let pixel = pixel.map(|v| tables::normalized(self.black[tables::code(v) as usize]));
    self.profile.as_ref().map_or(pixel, |map| map.pixel(pixel))
  }

  fn pixel(&self, pixel: [u16; 3]) -> [u16; 3] {
    self.pixel_float(pixel).map(tables::code)
  }

  pub(crate) fn render(&self, image: &SmallImage, flare: f64) -> Vec<f32> {
    self.finish(
      image,
      flare,
      image.pixels.iter().map(|&p| self.pixel(p)).collect(),
    )
  }

  /// H/S remain active in the post-tone measurement, with the other global
  /// controls reset. The profile is quantized before the modern grayscale
  /// tone-map branch, and again before the following nonlinear table.
  pub(crate) fn render_active(
    &self,
    image: &SmallImage,
    flare: f64,
    stage: &Stage,
    mask: &Mask,
  ) -> Vec<f32> {
    let mask = downsample_mask(
      &mask.samples,
      mask.width,
      mask.height,
      image.width,
      image.height,
    );
    let pixels = image
      .pixels
      .iter()
      .zip(mask)
      .map(|(&pixel, mask)| {
        stage
          .pixel(self.pixel(pixel).map(tables::normalized), mask)
          .map(tables::code)
      })
      .collect();
    self.finish(image, flare, pixels)
  }

  fn finish(&self, image: &SmallImage, flare: f64, mut pixels: Vec<[u16; 3]>) -> Vec<f32> {
    let scale = 1usize << image.level;
    if image.full_width != image.width * scale || image.full_height != image.height * scale {
      let encode = tables::expand(|x| stats_image::nonlinear(x, 0.0, false));
      let decode = tables::expand(|x| stats_image::nonlinear(x, 0.0, true));
      let mut working = image.clone();
      working.pixels = pixels
        .into_iter()
        .map(|p| p.map(|v| encode[v as usize]))
        .collect();
      pixels = resample::crop(&working)
        .into_iter()
        .map(|p| p.map(|v| decode[v as usize]))
        .collect();
    }
    pixels
      .into_iter()
      .map(|p| {
        let p = p.map(u32::from);
        let gray = ((4719 * p[0] + 11663 * p[1] + 2 * p[2] + 8192) >> 14) as u16;
        stats_image::logarithm(tables::normalized(gray), flare as f32)
      })
      .collect()
  }
}

/// Ordinary affine resampling is used when the statistics image is smaller
/// than the cached mask. This path has no high-resolution luminance guide.
pub(crate) fn downsample_mask(
  samples: &[f32],
  width: usize,
  height: usize,
  target_width: usize,
  target_height: usize,
) -> Vec<f32> {
  assert!(width > 0 && height > 0 && samples.len() == width * height);
  assert!(target_width > 0 && target_height > 0);
  if width == target_width && height == target_height {
    return samples.to_vec();
  }
  let vertical = FloatResample::new(height, target_height);
  let horizontal = FloatResample::new(width, target_width);
  let rows = (0..target_height * width)
    .map(|i| {
      let (start, weights) = vertical.at(i / width);
      let mut sum = 0.0f32;
      for (j, &weight) in weights.iter().enumerate() {
        let y = (start + j as i64).clamp(0, height as i64 - 1) as usize;
        sum = samples[y * width + i % width].mul_add(weight, sum);
      }
      sum
    })
    .collect::<Vec<_>>();
  (0..target_width * target_height)
    .map(|i| {
      let (start, weights) = horizontal.at(i % target_width);
      let value = |j: usize| {
        let x = (start + j as i64).clamp(0, width as i64 - 1) as usize;
        rows[i / target_width * width + x]
      };
      // RefResampleH32's generic loop rounds its bulk products before addition,
      // then uses FMA for the final one to three taps.
      if matches!(weights.len(), 4 | 6 | 8) {
        let mut sum = value(0).mul_add(weights[0], value(1) * weights[1]);
        for j in 2..weights.len() {
          sum = value(j).mul_add(weights[j], sum);
        }
        return sum;
      }
      let mut sum = value(0) * weights[0];
      let bulk = 1 + ((weights.len() - 1) / 4) * 4;
      for j in 1..bulk {
        sum += value(j) * weights[j];
      }
      for j in bulk..weights.len() {
        sum = value(j).mul_add(weights[j], sum);
      }
      sum
    })
    .collect()
}

struct FloatResample {
  source: usize,
  step: i64,
  origin: i64,
  radius: usize,
  weights: Vec<Vec<f32>>,
}

impl FloatResample {
  fn new(source: usize, target: usize) -> Self {
    let step = ((source as f64 / target as f64) * 4294967296.0).round() as i64;
    let scale = (4294967296.0 / step as f64).min(1.0);
    let radius = (2.0 / scale).ceil() as usize;
    let weights = (0..128)
      .map(|phase| {
        let mut weights = (0..radius * 2)
          .map(|j| {
            let x = (j as f64 - radius as f64 + 1.0 - phase as f64 / 128.0) * scale;
            let x = x.abs();
            if x >= 2.0 {
              0.0
            } else if x <= 1.0 {
              ((x * x).mul_add(x.mul_add(9.0, -15.0), 6.0) * (1.0 / 6.0)) as f32
            } else {
              (x.mul_add(x.mul_add(x.mul_add(-3.0, 15.0), -24.0), 12.0) * (1.0 / 6.0)) as f32
            }
          })
          .collect::<Vec<_>>();
        let total: f64 = weights.iter().map(|&v| f64::from(v)).sum();
        let scale = (1.0 / total) as f32;
        weights.iter_mut().for_each(|v| *v *= scale);
        weights
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

  fn at(&self, index: usize) -> (i64, &[f32]) {
    let position = (self.origin + self.step * index as i64).clamp(
      (1 - self.radius as i64) << 32,
      (self.source as i64 - self.radius as i64) << 32,
    );
    (
      position >> 32,
      &self.weights[((position as u64 >> 25) & 127) as usize],
    )
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  struct Buffer {
    header: serde_json::Value,
    bytes: Vec<u8>,
  }

  impl Buffer {
    fn open(root: &Path, stem: &str) -> Self {
      Self {
        header: serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap())
          .unwrap(),
        bytes: std::fs::read(root.join(format!("{stem}.bin"))).unwrap(),
      }
    }

    fn n(&self, field: &str) -> i64 {
      self.header[field].as_i64().unwrap()
    }

    fn index(&self, y: usize, x: usize, c: usize) -> usize {
      ((y as i64 - self.n("t")) * self.n("row_step")
        + (x as i64 - self.n("l")) * self.n("col_step")
        + c as i64 * self.n("plane_step")) as usize
    }

    fn code(&self, y: usize, x: usize, c: usize) -> u16 {
      let i = self.index(y, x, c) * 2;
      let value = u16::from_le_bytes(self.bytes[i..i + 2].try_into().unwrap());
      if self.n("ptype") == 8 {
        value ^ 32768
      } else {
        value
      }
    }

    fn float(&self, y: usize, x: usize, c: usize) -> f32 {
      let i = self.index(y, x, c) * 4;
      f32::from_le_bytes(self.bytes[i..i + 4].try_into().unwrap())
    }
  }

  fn buffers(root: &Path, suffix: &str) -> Vec<Buffer> {
    let mut files: Vec<_> = std::fs::read_dir(root)
      .unwrap()
      .map(|p| p.unwrap().path())
      .collect();
    files.sort();
    files
      .into_iter()
      .filter_map(|file| {
        let name = file.file_name().unwrap().to_str().unwrap();
        name
          .ends_with(suffix)
          .then(|| Buffer::open(root, name.strip_suffix(".json").unwrap()))
      })
      .collect()
  }

  fn captured_mask(root: &Path, width: usize, height: usize) -> Vec<f32> {
    let mut samples = vec![f32::NAN; width * height];
    for buffer in buffers(root, "_cr_stage_get_image_dst.json") {
      for y in buffer.n("t").max(0) as usize..buffer.n("b").min(height as i64) as usize {
        for x in buffer.n("l").max(0) as usize..buffer.n("r").min(width as i64) as usize {
          samples[y * width + x] = buffer.float(y, x, 0);
        }
      }
    }
    assert!(samples.iter().all(|x| x.is_finite()));
    samples
  }

  #[test]
  fn captured_active_mask_downsample() {
    let Some(root) = std::env::var_os("ADOBE_POST_TONE_ACTIVE_CAPTURE") else {
      return;
    };
    let root = Path::new(&root).join("post-00/pipe-05-DownsampleToneMapMask");
    let (width, height, target_width, target_height) = (1932, 1288, 242, 161);
    let samples = captured_mask(&root, width, height);
    let actual = downsample_mask(&samples, width, height, target_width, target_height);
    let mut count = 0;
    for buffer in buffers(&root, "_cr_stage_put_image_dst.json") {
      for y in buffer.n("t") as usize..buffer.n("b") as usize {
        for x in buffer.n("l") as usize..buffer.n("r") as usize {
          assert_eq!(
            actual[y * target_width + x].to_bits(),
            buffer.float(y, x, 0).to_bits(),
            "mask ({y},{x})"
          );
          count += 1;
        }
      }
    }
    assert_eq!(count, target_width * target_height);
  }

  /// Reconstruct production post-tone statistics, then isolate the exposure
  /// stage on its captured input so upstream mask errors cannot affect it.
  #[test]
  fn captured_active_production_exposure() {
    let (Some(root), Some(raw), Some(settings), Some(profiles)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_COMPOSED_TRACE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_COMPOSED_RAW"),
      std::env::var_os("RAW_DEVELOP_ADOBE_COMPOSED_SETTINGS"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = Path::new(&root);
    let settings: crate::DevelopSettings =
      serde_json::from_slice(&std::fs::read(settings).unwrap()).unwrap();
    let controls = settings.adobe_tone.clone().unwrap_or_default();
    if controls.highlights == 0 && controls.shadows == 0 {
      return;
    }
    let negative = crate::Negative::open(raw).unwrap();
    let meta = &negative.meta;
    let dcp =
      Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
        .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let cancel = crate::Cancel::never();
    let camera = if meta.cfa.is_xtrans() {
      crate::adobe::xtrans::develop_preserved_with_lens(&negative, neutral, true, &cancel).unwrap()
    } else {
      crate::adobe::bayer::develop_unbalanced_active(&negative, true, &cancel).unwrap()
    };
    let mut render =
      crate::adobe::AdobeRender::new(&dcp, meta, neutral, 0.0, &settings.white_balance, true)
        .unwrap();
    let _camera = render
      .prepare_camera(camera, &dcp, meta, &settings, &cancel)
      .unwrap();
    let scene = render.scene.as_ref().unwrap();
    let mask = render.mask.as_ref().unwrap().get(&cancel).unwrap();
    let setup = |exposure, whites| {
      super::super::setup::Setup::new(
        super::super::setup::Parameters {
          exposure_hundredths: exposure,
          whites,
          baseline_exposure: render.baseline_exposure,
          raw_scale: 1.0,
          custom_flare: Some(scene.flare),
        },
        &render.render_color,
        neutral,
        &scene.gray,
        &scene.colors,
      )
    };
    let post_setup = setup(0, 0);
    let post_stage = Stage::new(
      &mask.source,
      &mask.filtered,
      &post_setup.info,
      controls.shadows,
      controls.highlights,
      post_setup.log_flare,
    );
    let post = scene.active_post(&post_stage, mask, &cancel).unwrap();
    let setup = setup(
      (render.effective_user_exposure(settings.exposure) * 100.0).round() as i32,
      controls.whites,
    );
    let mut info = setup.info;
    info.statistics = post.exposure();
    info.calculate();
    let object = std::fs::read(root.join("004_cr_stage_exposure_obj.bin")).unwrap();
    let bytes = &object[0x8b8..];
    for (name, offset, actual) in [
      ("exposure", 0x8, info.exposure),
      ("tone_exposure", 0x18, info.tone_exposure),
      ("baseline_adjustment", 0x28, info.baseline_adjustment),
      ("channel_flare_r", 0x30, info.channel_flare[0]),
      ("channel_flare_g", 0x38, info.channel_flare[1]),
      ("channel_flare_b", 0x40, info.channel_flare[2]),
      ("baseline", 0x50, info.baseline),
      ("ai_amount", 0x58, info.ai_amount),
      ("input_scale", 0x60, info.input_scale),
      ("whites", 0x80, info.whites),
      ("highlight_headroom", 0x88, info.highlight_headroom),
      ("input_exposure", 0x90, info.input_exposure),
      ("linear_exposure", 0x98, info.linear_exposure),
      ("rolloff_exposure", 0xa0, info.rolloff_exposure),
      ("total_exposure", 0xa8, info.total_exposure),
      ("whites_amount", 0xb0, info.whites_amount),
      ("highlight_luma_offset", 0xb8, info.highlight_luma_offset),
      ("black_reference", 0x658, info.statistics.black_reference),
      ("whites_low", 0x670, info.statistics.whites_low),
      ("whites_high", 0x678, info.statistics.whites_high),
      (
        "highlight_reference",
        0x690,
        info.statistics.highlight_reference,
      ),
    ] {
      let expected = f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
      assert_eq!(
        actual.to_bits(),
        expected.to_bits(),
        "exposure state {name}: {actual} != {expected}"
      );
    }
    assert_eq!(info.hdr, bytes[0x701] != 0);
    let epsilon = f32::from_le_bytes(bytes[0x894..0x898].try_into().unwrap());
    assert_eq!(setup.epsilon.to_bits(), epsilon.to_bits(), "epsilon");
    let mut stage = super::super::exposure::Stage::from_info(&info, setup.epsilon);
    super::super::blacks::Blacks::mosaic(&info, controls.blacks, None, None).apply(&mut stage);
    for (name, table) in [
      ("fc8", stage.rolloff.as_ref()),
      ("1020", stage.whites_reduce.as_ref()),
      ("10b8", stage.blacks_lift.as_ref()),
    ]
    .into_iter()
    .chain(stage.blacks_subtract.iter().flat_map(|tables| {
      ["1050", "1070", "1090"]
        .into_iter()
        .zip(tables.iter().map(Some))
    })) {
      if let Some(table) = table {
        let expected =
          std::fs::read(root.join(format!("004_cr_stage_exposure_table_{name}.bin"))).unwrap();
        assert_eq!(expected.len(), table.samples.len() * 4);
        for (i, (&actual, bytes)) in table
          .samples
          .iter()
          .zip(expected.chunks_exact(4))
          .enumerate()
        {
          let expected = f32::from_le_bytes(bytes.try_into().unwrap());
          assert_eq!(
            actual.to_bits(),
            expected.to_bits(),
            "exposure table{name} sample{i}"
          );
        }
      }
    }
    let source = Buffer::open(root, "004_cr_stage_exposure_src");
    let expected = Buffer::open(root, "004_cr_stage_exposure_dst");
    let mut channels = 0;
    for y in source.n("t") as usize..source.n("b") as usize {
      for x in source.n("l") as usize..source.n("r") as usize {
        let actual = stage.pixel(std::array::from_fn(|c| source.float(y, x, c)));
        for c in 0..3 {
          assert_eq!(
            actual[c].to_bits(),
            expected.float(y, x, c).to_bits(),
            "exposure ({y},{x},{c})"
          );
          channels += 1;
        }
      }
    }
    eprintln!(
      "active production post statistics, exposure state/tables and {channels} exposure channels exact"
    );
  }

  #[test]
  fn captured_active_profile_tone_and_log_image() {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("ADOBE_POST_TONE_ACTIVE_CAPTURE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = Path::new(&root);
    let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp =
      Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
        .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let post = PostToneImage::new(&dcp, &meta, neutral, black, &WhiteBalance::AsShot);
    let source = Buffer::open(
      root,
      "post-00/pipe-01-GetWarpedSourcePipe_A/000_cr_stage_get_image_dst",
    );
    let (width, height) = (source.n("r") as usize, source.n("b") as usize);
    let image = SmallImage {
      pixels: (0..width * height)
        .map(|i| std::array::from_fn(|c| source.code(i / width, i % width, c)))
        .collect(),
      width,
      height,
      level: 5,
      full_width: meta.crop_width,
      full_height: meta.crop_height,
    };
    let pipe = root.join("post-00/pipe-03-Pipe After Filters");
    let info = std::fs::read(pipe.join("tone-stage-000_info.bin")).unwrap();
    let object = std::fs::read(pipe.join("tone-stage-000.bin")).unwrap();
    let f64_at =
      |bytes: &[u8], offset| f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
    let f32_at =
      |bytes: &[u8], offset| f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let offsets = [0x10, 0x68, 0xa0, 0xa8, 0xb0, 0xd0];
    let flare = f64_at(&object, 0x1f20);
    let stage = Stage::from_statistics(
      offsets.map(|o| f64_at(&info, 0x718 + o)),
      offsets.map(|o| f64_at(&info, 0x820 + o)),
      f32_at(&info, 0x708),
      f32_at(&info, 0x70c),
      flare,
    );
    let samples = captured_mask(
      &root.join("post-00/pipe-05-DownsampleToneMapMask"),
      1932,
      1288,
    );
    let small_mask = downsample_mask(&samples, 1932, 1288, width, height);
    let mut profile_count = 0;
    for buffer in buffers(&pipe, "_cr_stage_color_table_dst.json") {
      for y in buffer.n("t").max(0) as usize..buffer.n("b").min(height as i64) as usize {
        for x in buffer.n("l").max(0) as usize..buffer.n("r").min(width as i64) as usize {
          let actual = post.pixel_float(image.pixels[y * width + x]);
          for c in 0..3 {
            assert_eq!(
              actual[c].to_bits(),
              buffer.float(y, x, c).to_bits(),
              "active profile ({y},{x},{c})"
            );
            profile_count += 1;
          }
        }
      }
    }
    let mut tone_count = 0;
    for buffer in buffers(&pipe, "_cr_stage_tone_map_dst.json") {
      for y in buffer.n("t").max(0) as usize..buffer.n("b").min(height as i64) as usize {
        for x in buffer.n("l").max(0) as usize..buffer.n("r").min(width as i64) as usize {
          let actual = stage.pixel(
            post
              .pixel(image.pixels[y * width + x])
              .map(tables::normalized),
            small_mask[y * width + x],
          );
          for c in 0..3 {
            assert_eq!(
              actual[c].to_bits(),
              buffer.float(y, x, c).to_bits(),
              "active tone ({y},{x},{c})"
            );
            tone_count += 1;
          }
        }
      }
    }
    let stats = super::super::statistics::Statistics::new(&[0.0], flare).unwrap();
    let mask = Mask {
      samples,
      width: 1932,
      height: 1288,
      level: 2,
      full_width: meta.crop_width,
      full_height: meta.crop_height,
      source: stats.clone(),
      filtered: stats,
      minimum: 0.0,
      maximum: 0.0,
    };
    let log_object = std::fs::read(
      root.join("post-00/pipe-07-ImageStatsPostToneMap/001_cr_stage_LinearToLog2_obj.bin"),
    )
    .unwrap();
    let log_flare = f32_at(&log_object, 0x24) as f64;
    let actual = post.render_active(&image, log_flare, &stage, &mask);
    let expected = Buffer::open(
      root,
      "post-00/pipe-07-ImageStatsPostToneMap/001_cr_stage_LinearToLog2_dst",
    );
    for y in 0..height {
      for x in 0..width {
        assert_eq!(
          actual[y * width + x].to_bits(),
          expected.float(y, x, 0).to_bits(),
          "active log ({y},{x})"
        );
      }
    }
    eprintln!(
      "active post statistics: {profile_count} profile, {tone_count} tone, {} log samples exact",
      actual.len()
    );
  }

  #[test]
  fn captured_profile_crop_and_log_image() {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("ADOBE_STATS_IMAGE_CAPTURE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = Path::new(&root);
    let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp =
      Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
        .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let post = PostToneImage::new(&dcp, &meta, neutral, black, &WhiteBalance::AsShot);
    let source = Buffer::open(
      root,
      "post-00/pipe-01-GetWarpedSourcePipe_A/000_cr_stage_get_image_dst",
    );
    let width = source.n("r") as usize;
    let height = source.n("b") as usize;
    let level = (0..=8)
      .find(|l| {
        ((meta.crop_width + (1 << l) / 2) >> l) == width
          && ((meta.crop_height + (1 << l) / 2) >> l) == height
      })
      .unwrap();
    let image = SmallImage {
      pixels: (0..width * height)
        .map(|i| std::array::from_fn(|c| source.code(i / width, i % width, c)))
        .collect(),
      width,
      height,
      level,
      full_width: meta.crop_width,
      full_height: meta.crop_height,
    };
    let pipe = root.join("post-00/pipe-03-Pipe After Filters");
    let encode = tables::expand(|x| stats_image::nonlinear(x, 0.0, false));
    let mut pixel_samples = 0;
    for file in std::fs::read_dir(&pipe).unwrap() {
      let file = file.unwrap().path();
      let name = file.file_name().unwrap().to_str().unwrap();
      let Some(stem) = name.strip_suffix("_cr_stage_simple_32_dst.json") else {
        continue;
      };
      let buffer = Buffer::open(&pipe, &format!("{stem}_cr_stage_simple_32_dst"));
      for y in buffer.n("t").max(0) as usize..buffer.n("b").min(height as i64) as usize {
        for x in buffer.n("l").max(0) as usize..buffer.n("r").min(width as i64) as usize {
          let actual = post.pixel(image.pixels[y * width + x]);
          for c in 0..3 {
            assert_eq!(actual[c], buffer.code(y, x, c), "profile ({y},{x},{c})");
            pixel_samples += 1;
          }
        }
      }
    }
    assert!(pixel_samples > 0);
    let mut encoded = image.clone();
    encoded.pixels = image
      .pixels
      .iter()
      .map(|&p| post.pixel(p).map(|v| encode[v as usize]))
      .collect();
    let cropped = resample::crop(&encoded);
    let mut crop_samples = 0;
    for file in std::fs::read_dir(&pipe).unwrap() {
      let file = file.unwrap().path();
      let name = file.file_name().unwrap().to_str().unwrap();
      let Some(stem) = name.strip_suffix("_cr_stage_skew_h_dst.json") else {
        continue;
      };
      let buffer = Buffer::open(&pipe, &format!("{stem}_cr_stage_skew_h_dst"));
      for y in buffer.n("t") as usize..buffer.n("b") as usize {
        for x in buffer.n("l") as usize..buffer.n("r") as usize {
          for c in 0..3 {
            assert_eq!(
              cropped[y * width + x][c],
              buffer.code(y, x, c),
              "crop ({y},{x},{c})"
            );
            crop_samples += 1;
          }
        }
      }
    }
    let log_object = std::fs::read(
      root.join("post-00/pipe-07-ImageStatsPostToneMap/001_cr_stage_LinearToLog2_obj.bin"),
    )
    .unwrap();
    let flare = f32::from_le_bytes(log_object[0x24..0x28].try_into().unwrap()) as f64;
    let actual = post.render(&image, flare);
    let expected = Buffer::open(
      root,
      "post-00/pipe-07-ImageStatsPostToneMap/001_cr_stage_LinearToLog2_dst",
    );
    let mut log_samples = 0;
    for y in 0..height {
      for x in 0..width {
        assert_eq!(
          actual[y * width + x].to_bits(),
          expected.float(y, x, 0).to_bits(),
          "log ({y},{x})"
        );
        log_samples += 1;
      }
    }
    eprintln!(
      "post statistics: {pixel_samples} profile, {crop_samples} crop, {log_samples} log samples exact"
    );
  }
}
