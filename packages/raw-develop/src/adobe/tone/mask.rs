//! The cached, scene-dependent spatial mask for Highlights and Shadows.
//!
//! The ordinary RAW mask uses the quarter-resolution preserved-black camera
//! pyramid, a default-profile D50 transform and logarithmic luminance. User
//! Basic controls are applied after this cache. The mask stores the difference
//! between a local Laplacian reconstruction and its source in exposure stops.

use super::{
  laplacian,
  statistics::Statistics,
  stats_image::{self, SmallImage},
};
use crate::adobe::{bayer::tables, color::ColorSpec, color_table, dcp::Dcp, input::InputTransform};
use crate::{Cancel, Result, metadata::RawMetadata};

#[derive(Clone, Debug)]
pub(crate) struct MaskSource {
  pub(crate) image: SmallImage,
  transform: InputTransform,
  guide_transform: InputTransform,
  black_table: Vec<u16>,
  gain: f32,
  pub(crate) flare: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct Mask {
  pub(crate) samples: Vec<f32>,
  pub(crate) width: usize,
  pub(crate) height: usize,
  pub(crate) level: usize,
  pub(crate) full_width: usize,
  pub(crate) full_height: usize,
  pub(crate) source: Statistics,
  pub(crate) filtered: Statistics,
  pub(crate) minimum: f32,
  pub(crate) maximum: f32,
}

impl MaskSource {
  pub(crate) fn new(
    image: SmallImage,
    dcp: &Dcp,
    meta: &RawMetadata,
    neutral: [f64; 3],
    black: f64,
    flare: f64,
  ) -> Self {
    let spec = ColorSpec::for_statistics(dcp, meta, neutral);
    let transform = InputTransform::new(&spec, neutral, black);
    // FindToneMapMaskParams resets white balance. Upsampling retains the
    // default As Shot transform even when the user chooses a custom white.
    let guide_spec =
      ColorSpec::for_render(dcp, meta, neutral, &crate::settings::WhiteBalance::AsShot);
    let guide_transform = InputTransform::new(&guide_spec, neutral, black);
    let black_table = color_table::remove_black_table(black);
    let gain = transform.maximum_gain();
    Self {
      image,
      transform,
      guide_transform,
      black_table,
      gain,
      flare,
    }
  }

  /// Default-profile D50 log luminance before the spatial filter. The input is
  /// a normalized, preserved-black camera pixel, including embedded lateral CA.
  pub(crate) fn log_luminance(&self, camera: [f32; 3]) -> f32 {
    let rgb = self.guide_rgb(camera);
    let gray = rgb[2]
      .mul_add(0.110000014, rgb[0].mul_add(0.3, rgb[1] * 0.59))
      .max(0.0);
    stats_image::logarithm(gray * self.gain, self.flare as f32)
  }

  pub(crate) fn guide_rgb(&self, camera: [f32; 3]) -> [f32; 3] {
    self.guide_rgb_with(camera, &self.transform)
  }

  /// Unlike the low mask's D50 white, the full-resolution guide uses the
  /// default As Shot white. Both cross the same u16 colour boundaries.
  pub(crate) fn guide_rgb_for_upsampling(&self, camera: [f32; 3]) -> [f32; 3] {
    self.guide_rgb_with(camera, &self.guide_transform)
  }

  /// The guide stays in the As Shot transform's normalized RGB domain.
  /// NegativeToFlareForLog applies that transform's input exposure to flare.
  pub(crate) fn guide_flare(&self) -> f64 {
    super::setup::log_flare(
      &super::exposure::Info {
        input_exposure: self.guide_transform.exposure_adjustment(),
        ..Default::default()
      },
      Some(self.flare),
    )
  }

  fn guide_rgb_with(&self, camera: [f32; 3], input: &InputTransform) -> [f32; 3] {
    input
      .pixel(camera)
      .map(|value| tables::normalized(self.black_table[tables::code(value) as usize]))
  }

  pub(crate) fn render(&self, cancel: &Cancel) -> Result<Mask> {
    cancel.check()?;
    let mut pixels = Vec::with_capacity(self.image.pixels.len());
    for chunk in self.image.pixels.chunks(65536) {
      cancel.check()?;
      pixels.extend(
        chunk
          .iter()
          .map(|p| self.log_luminance(p.map(tables::normalized))),
      );
    }
    let image = laplacian::Image {
      pixels,
      width: self.image.width,
      height: self.image.height,
    };
    let (filtered_image, source, mut filtered) = laplacian::filter(&image, self.flare, cancel)?;
    cancel.check()?;
    let offset = source.tone_mean as f32 - filtered.tone_mean as f32;
    let samples: Vec<_> = filtered_image
      .pixels
      .iter()
      .zip(&image.pixels)
      .map(|(&filtered, &source)| ((offset + filtered) - source).min(4.0))
      .collect();
    let minimum = samples.iter().copied().fold(f32::INFINITY, f32::min);
    let maximum = samples.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    filtered.apply_offset(source.tone_mean - filtered.tone_mean);
    Ok(Mask {
      samples,
      width: image.width,
      height: image.height,
      level: self.image.level,
      full_width: self.image.full_width,
      full_height: self.image.full_height,
      source,
      filtered,
      minimum,
      maximum,
    })
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
    fn open(file: &Path) -> Self {
      Self {
        header: serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap(),
        bytes: std::fs::read(file.with_extension("bin")).unwrap(),
      }
    }
    fn n(&self, key: &str) -> i64 {
      self.header[key].as_i64().unwrap()
    }
    fn pixel(&self, y: i64, x: i64, c: i64) -> f32 {
      let i = ((y - self.n("t")) * self.n("row_step")
        + (x - self.n("l")) * self.n("col_step")
        + c * self.n("plane_step")) as usize
        * self.n("psize") as usize;
      if self.n("psize") == 2 {
        let code = u16::from_le_bytes(self.bytes[i..i + 2].try_into().unwrap());
        tables::normalized(if self.n("ptype") == 8 {
          code ^ 32768
        } else {
          code
        })
      } else {
        f32::from_le_bytes(self.bytes[i..i + 4].try_into().unwrap())
      }
    }
  }

  fn pipe(root: &Path, name: &str) -> PathBuf {
    std::fs::read_dir(root)
      .unwrap()
      .map(|p| p.unwrap().path())
      .find(|p| p.file_name().unwrap().to_string_lossy().ends_with(name))
      .unwrap()
  }

  fn buffers(root: &Path, suffix: &str) -> Vec<Buffer> {
    std::fs::read_dir(root)
      .unwrap()
      .map(|p| p.unwrap().path())
      .filter(|p| p.file_name().unwrap().to_string_lossy().ends_with(suffix))
      .map(|p| Buffer::open(&p))
      .collect()
  }

  fn captured_source() -> Option<(PathBuf, crate::Negative, Dcp, MaskSource)> {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("ADOBE_TONE_MASK_CAPTURE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return None;
    };
    let root = PathBuf::from(root);
    let negative = crate::Negative::open(raw).unwrap();
    let meta = &negative.meta;
    let dcp =
      Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
        .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let b = std::fs::read(root.with_file_name(format!(
      "{}_negative.bin",
      root.file_name().unwrap().to_str().unwrap()
    )))
    .unwrap();
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let flare = f64::from_le_bytes(b[0x1768..0x1770].try_into().unwrap());
    let mask_json: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.with_extension("json")).unwrap()).unwrap();
    let level = mask_json["level"].as_u64().unwrap() as usize;
    let width = (meta.crop_width + (1 << (level - 1))) >> level;
    let height = (meta.crop_height + (1 << (level - 1))) >> level;
    let mut image = SmallImage {
      pixels: vec![[0; 3]; width * height],
      width,
      height,
      level,
      full_width: meta.crop_width,
      full_height: meta.crop_height,
    };
    let mut seen = vec![false; width * height];
    for buffer in buffers(
      &pipe(&root, "-MakeGrayLogImage"),
      "_cr_stage_get_image_dst.json",
    )
    .into_iter()
    .chain(buffers(
      &pipe(&root, "-MakeGrayLogImage"),
      "_cr_stage_ABCtoRGB_local_src.json",
    )) {
      for y in buffer.n("t")..buffer.n("b") {
        for x in buffer.n("l")..buffer.n("r") {
          let i = y as usize * width + x as usize;
          image.pixels[i] = std::array::from_fn(|c| tables::code(buffer.pixel(y, x, c as i64)));
          seen[i] = true;
        }
      }
    }
    assert!(seen.into_iter().all(|v| v));
    let source = MaskSource::new(image, &dcp, meta, neutral, black, flare);
    Some((root, negative, dcp, source))
  }

  #[test]
  fn captured_mask_source_transform() {
    let Some((root, _, _, source)) = captured_source() else {
      return;
    };
    let mut checked = 0;
    for buffer in buffers(
      &pipe(&root, "-MakeGrayLogImage"),
      "_cr_stage_LinearToLog2_dst.json",
    ) {
      for y in buffer.n("t")..buffer.n("b") {
        for x in buffer.n("l")..buffer.n("r") {
          let actual = source.log_luminance(
            source.image.pixels[y as usize * source.image.width + x as usize]
              .map(tables::normalized),
          );
          assert_eq!(
            actual.to_bits(),
            buffer.pixel(y, x, 0).to_bits(),
            "mask source ({y},{x}) {actual} vs {}",
            buffer.pixel(y, x, 0)
          );
          checked += 1;
        }
      }
    }
    assert!(checked > 0);
    eprintln!("Mask source log values {checked}");
  }

  #[test]
  fn captured_full_camera_mask_source() {
    let Some((_, negative, _, source)) = captured_source() else {
      return;
    };
    let camera = if negative.meta.cfa.is_xtrans() {
      crate::adobe::xtrans::develop_preserved_with_lens(
        &negative,
        crate::adobe::xtrans::rounded_neutral(negative.meta.as_shot_wb.map(|v| 1.0 / v)),
        true,
        &Cancel::never(),
      )
      .unwrap()
    } else {
      crate::adobe::bayer::develop_unbalanced_active(&negative, true, &Cancel::never()).unwrap()
    };
    let black = ((negative.meta.black_levels[0] as u32) << (16 - negative.meta.bits_per_sample))
      as f64
      / 65535.0;
    let [left, top, width, height] = if negative.meta.cfa.is_xtrans() {
      [0, 0, camera.width, camera.height]
    } else {
      [
        negative.meta.crop_left,
        negative.meta.crop_top,
        negative.meta.crop_width,
        negative.meta.crop_height,
      ]
    };
    let image = stats_image::camera_pyramid_f32_region_at_level(
      &camera,
      left,
      top,
      width,
      height,
      black,
      true,
      source.image.level,
    );
    assert_eq!(image.pixels, source.image.pixels);
    let direct = stats_image::camera_pyramid_f32_region_at_level(
      &camera, left, top, width, height, black, true, 5,
    );
    assert_eq!(
      stats_image::deepen(&image, black, true).pixels,
      direct.pixels
    );
    eprintln!("Full camera mask source codes {}", image.pixels.len() * 3);
  }

  #[test]
  fn captured_mask_and_statistics() {
    let Some((root, _, _, source)) = captured_source() else {
      return;
    };
    let mask = source.render(&Cancel::never()).unwrap();
    eprintln!(
      "mask source stats mean {} tone {} range {:?}; filtered mean {} tone {}",
      mask.source.mean,
      mask.source.tone_mean,
      mask.source.laplacian_range(),
      mask.filtered.mean,
      mask.filtered.tone_mean
    );
    let expected_stats = std::fs::read(root.with_file_name(format!(
      "{}_source_stats.bin",
      root.file_name().unwrap().to_str().unwrap()
    )))
    .unwrap();
    let native = |o| f64::from_le_bytes(expected_stats[o..o + 8].try_into().unwrap());
    assert_eq!(mask.source.mean, native(0));
    assert_eq!(mask.source.tone_mean, native(0x10));
    assert_eq!(
      mask.source.laplacian_range(),
      [native(0x68), native(0xa0), native(0xb8)]
    );
    let mut checked = 0;
    for buffer in buffers(
      &pipe(&root, "-BuildDeltaMask"),
      "_cr_stage_BuildDeltaMask_dst.json",
    ) {
      for y in buffer.n("t")..buffer.n("b") {
        for x in buffer.n("l")..buffer.n("r") {
          let actual = mask.samples[y as usize * mask.width + x as usize];
          assert_eq!(
            actual.to_bits(),
            buffer.pixel(y, x, 0).to_bits(),
            "mask ({y},{x}) {actual} vs {}",
            buffer.pixel(y, x, 0)
          );
          checked += 1;
        }
      }
    }
    assert_eq!(checked, mask.samples.len());
    for (name, stats) in [
      ("source_stats", &mask.source),
      ("filtered_stats", &mask.filtered),
    ] {
      let b = std::fs::read(root.with_file_name(format!(
        "{}_{name}.bin",
        root.file_name().unwrap().to_str().unwrap()
      )))
      .unwrap();
      let value = |o| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
      assert_eq!(stats.mean, value(0));
      assert_eq!(stats.tone_mean, value(0x10));
      assert_eq!(
        stats.laplacian_range(),
        [value(0x68), value(0xa0), value(0xb8)]
      );
    }
    for (name, actual) in [("minimum", mask.minimum), ("maximum", mask.maximum)] {
      let b = std::fs::read(root.with_file_name(format!(
        "{}_{name}.bin",
        root.file_name().unwrap().to_str().unwrap()
      )))
      .unwrap();
      assert_eq!(
        actual.to_bits(),
        f32::from_le_bytes(b.try_into().unwrap()).to_bits()
      );
    }
    eprintln!("Composed mask values {checked}");
  }
}
