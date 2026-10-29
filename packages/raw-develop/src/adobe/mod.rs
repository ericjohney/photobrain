//! Adobe engine: an alternative render back end selected with
//! [`crate::Engine::Adobe`]. Decode is shared with the Apple engine. Full X-Trans
//! and Bayer demosaic and mandatory cleanup follow Adobe 18.7 (`xtrans`, `bayer`);
//! preview uses the generic demosaic. Full rendering includes CR6 chroma/luma
//! NR, embedded lens corrections, scene statistics and modern exposure/profile
//! tone. Binned previews retain the public DNG SDK renderer (`render.rs`).
//! Both paths read a runtime, caller-supplied Adobe DCP profile.
//!
//! Provenance:
//! - Colour: public DNG SDK and captured modern CPU arithmetic. Full tone and
//!   output: reconstructed from Converter 18.7, with exact captured checks.
//! - DCP profiles: Adobe data, never bundled; read from `ADOBE_PROFILE_DIR`.
//! - Per-camera baseline exposure and the preview fallback black point: measured
//!   against Adobe DNG Converter output (`docs/adobe-engine.md`).
//! - X-Trans: reconstructed from the symbolised DNG Converter 18.7 CPU stages,
//!   validated against intermediate captures and complete no-CA linear DNGs.
//! - Bayer: the same capture-based process, including Sony per-body calibration,
//!   hot/cold-pixel suppression, green balancing and the high-ISO noise transform.

pub mod acr3;
pub(crate) mod bayer;
pub mod color;
pub(crate) mod color_table;
pub mod dcp;
pub(crate) mod input;
pub(crate) mod lens;
mod linearize;
pub(crate) mod nr;
pub(crate) mod output;
mod rank;
pub mod render;
mod temperature;
pub(crate) mod tone;
pub(crate) mod xtrans;

#[cfg(test)]
mod integration_tests;

use crate::error::{Error, Result};
use crate::image::RgbImage;
use crate::math::{Mat3, XYZ_D50_TO_LINEAR_P3, srgb_encode};
use crate::metadata::RawMetadata;
use dcp::{Dcp, HueSatMap};
use rayon::prelude::*;
use render::Table1d;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, TryLockError};

/// Environment variable naming the directory that holds Adobe DCP profiles.
pub const PROFILE_DIR_ENV: &str = "ADOBE_PROFILE_DIR";

/// Preview fallback black point (SDK "Shadows" in units of 0.001 of white).
/// Full rendering uses scene-dependent modern Blacks2012 instead.
pub const DEFAULT_BLACK: f64 = 2.5;

#[derive(Clone, Debug)]
pub(crate) struct AdobeRender {
  pub clip: [f32; 3],
  pub balanced_to_prophoto: [[f32; 3]; 3],
  pub hue_sat_map: Option<HueSatMap>,
  pub look_table: Option<HueSatMap>,
  pub hue_sat_encode: bool,
  pub look_encode: bool,
  pub tone_curve: Option<Vec<(f32, f32)>>,
  pub baseline_exposure: f64,
  pub neutral: [f64; 3],
  pub cct: f64,
  pub luma_nr: f32,
  input: Option<input::InputTransform>,
  render_color: color::ColorSpec,
  scene: Option<tone::scene::Scene>,
  mask: Option<Arc<CachedMask>>,
  modern_color: Option<ModernColor>,
  raw_to_prophoto: Mat3,
  black: f64,
  distortion: Option<lens::EmbeddedDistortion>,
  vignette: Option<lens::EmbeddedVignette>,
  active_size: [usize; 2],
}

#[derive(Debug)]
struct CachedMask {
  source: tone::mask::MaskSource,
  result: OnceLock<tone::mask::Mask>,
  guide: Mutex<Option<tone::mask_upsample::Guide>>,
  full: OnceLock<Vec<f32>>,
}

impl CachedMask {
  fn get(&self, cancel: &crate::Cancel) -> Result<&tone::mask::Mask> {
    cancel.check()?;
    if let Some(mask) = self.result.get() {
      return Ok(mask);
    }
    let mask = self.source.render(cancel)?;
    // Concurrent renders can finish the same deterministic mask. Cancellation
    // and other failures never populate the cache, so later edits can retry.
    let _ = self.result.set(mask);
    Ok(self.result.get().expect("completed Adobe tone mask"))
  }

  fn full(
    &self,
    distortion: Option<&lens::EmbeddedDistortion>,
    cancel: &crate::Cancel,
  ) -> Result<&[f32]> {
    cancel.check()?;
    if let Some(mask) = self.full.get() {
      return Ok(mask);
    }
    let mask = self.get(cancel)?;
    // Keep the original guide after cancellation, then release its full-size
    // plane once the independently cached mask has been produced successfully.
    let mut guide = loop {
      cancel.check()?;
      match self.guide.try_lock() {
        Ok(guide) => break guide,
        Err(TryLockError::Poisoned(error)) => break error.into_inner(),
        Err(TryLockError::WouldBlock) => {
          std::thread::sleep(std::time::Duration::from_millis(1));
        }
      }
    };
    if let Some(mask) = self.full.get() {
      return Ok(mask);
    }
    let full = guide
      .as_ref()
      .expect("uncached Adobe tone guide")
      .render(mask, cancel)?;
    let full = match distortion {
      Some(warp) => warp.apply_mask(&full, cancel)?,
      None => full,
    };
    cancel.check()?;
    let _ = self.full.set(full);
    *guide = None;
    Ok(self.full.get().expect("completed full Adobe tone mask"))
  }

  fn sample(&self, samples: &[f32], size: [usize; 2], x: usize, y: usize) -> f32 {
    let full = [self.source.image.full_width, self.source.image.full_height];
    if full == size {
      return samples[y * full[0] + x];
    }
    // Prepared screen proxies retain the original scene/guide coordinates.
    let [fx, fy] = std::array::from_fn(|c| {
      (([x, y][c] as f32 + 0.5) * (full[c] as f32 / size[c] as f32) - 0.5)
        .clamp(0.0, (full[c] - 1) as f32)
    });
    let [ix, iy] = [fx as usize, fy as usize];
    let [dx, dy] = [fx - ix as f32, fy - iy as f32];
    let at = |x: usize, y: usize| samples[y.min(full[1] - 1) * full[0] + x.min(full[0] - 1)];
    let a = at(ix, iy);
    let b = at(ix, iy + 1);
    let a = dx.mul_add(at(ix + 1, iy) - a, a);
    let b = dx.mul_add(at(ix + 1, iy + 1) - b, b);
    dy.mul_add(b - a, a)
  }
}

#[derive(Clone, Debug)]
struct ModernColor {
  remove_black: Vec<u16>,
  hue_sat: Option<color_table::ColorTable>,
  look: Option<color_table::ColorTable>,
}

impl ModernColor {
  fn input_pixels4(&self, pixels: [[f32; 3]; 4]) -> [[f32; 3]; 4] {
    let pixels = pixels.map(|p| {
      p.map(|v| bayer::tables::normalized(self.remove_black[bayer::tables::code(v) as usize]))
    });
    let pixels = self
      .hue_sat
      .as_ref()
      .map_or(pixels, |table| table.pixels4(pixels));
    pixels.map(|p| p.map(|v| bayer::tables::normalized(bayer::tables::code(v))))
  }

  fn input_pixel(&self, p: [f32; 3]) -> [f32; 3] {
    let p =
      p.map(|v| bayer::tables::normalized(self.remove_black[bayer::tables::code(v) as usize]));
    let p = self.hue_sat.as_ref().map_or(p, |table| table.pixel(p));
    // The float colour-map stage commits u16 before the next vignette/exposure
    // stage. Keep this boundary even when the following operation uses f32.
    p.map(|v| bayer::tables::normalized(bayer::tables::code(v)))
  }
}

/// Resolve the profile directory: explicit option, else `ADOBE_PROFILE_DIR`.
pub fn profile_dir(explicit: Option<&Path>) -> Result<PathBuf> {
  explicit
    .map(Path::to_path_buf)
    .or_else(|| std::env::var_os(PROFILE_DIR_ENV).map(PathBuf::from))
    .ok_or_else(|| {
      Error::Unsupported(format!(
        "Adobe engine needs a profile directory (Options::adobe_profile_dir or {PROFILE_DIR_ENV})"
      ))
    })
}

/// White level Adobe uses to normalise the mosaic: the file's value, else
/// `2^bits - 1` (16383 for 14-bit RAF and ARW, matching DNG Converter's `WhiteLevel`).
pub fn white_level(meta: &RawMetadata) -> f32 {
  match meta.white_level {
    Some(w) if w > 0 => w as f32,
    _ => ((1u32 << meta.bits_per_sample.clamp(8, 16)) - 1) as f32,
  }
}

/// Adobe's `BaselineExposure` for a file, as written by DNG Converter 18.7.
/// Fujifilm: `-RawExposureBias - 0.70` (0.02 at bias -0.72, 0.07 at -0.77).
/// Sony: a per-model constant.
pub fn baseline_exposure(meta: &RawMetadata) -> Result<f64> {
  let make = meta.make.trim().to_ascii_uppercase();
  let model = meta.model.trim();
  if make.starts_with("FUJIFILM") {
    let bias = meta.raw_exposure_bias.unwrap_or(-0.72);
    return Ok(-bias - 0.70);
  }
  if make.starts_with("SONY") {
    return match model {
      "ILCE-1M2" => Ok(0.15),
      "ILCE-7CR" | "ILCE-7RM5" => Ok(0.35),
      _ => Err(Error::Unsupported(format!(
        "Adobe engine: no baseline exposure for {model}"
      ))),
    };
  }
  Err(Error::Unsupported(format!(
    "Adobe engine: unsupported make {make}"
  )))
}

impl AdobeRender {
  pub(crate) fn effective_user_exposure(&self, exposure: f64) -> f64 {
    if self.input.is_some() {
      (f64::from((exposure * 100.0).round() as i32) * 0.01).clamp(-5.0, 5.0)
    } else {
      exposure
    }
  }

  pub(crate) fn new(
    dcp: &Dcp,
    meta: &RawMetadata,
    neutral: [f64; 3],
    luma_nr: f32,
    white_balance: &crate::settings::WhiteBalance,
    full: bool,
  ) -> Result<Self> {
    let spec = color::ColorSpec::for_render(dcp, meta, neutral, white_balance);
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let input = full.then(|| input::InputTransform::new(&spec, neutral, black));
    let modern_color = input.as_ref().map(|input| ModernColor {
      remove_black: color_table::remove_black_table(black),
      hue_sat: spec.hue_sat_map.as_ref().map(|map| {
        color_table::ColorTable::new(
          map,
          dcp.hue_sat_map_encoding == 1,
          (1.0 / input.noise_scale()) as f32,
          1.0,
          false,
        )
      }),
      look: dcp.look_table.as_ref().map(|map| {
        color_table::ColorTable::new(map, dcp.look_table_encoding == 1, 1.0, 1.0, false)
      }),
    });
    let raw_to_prophoto = spec.raw_to_prophoto(neutral);
    Ok(Self {
      clip: spec.clip(neutral),
      balanced_to_prophoto: spec.balanced_to_prophoto.to_f32(),
      hue_sat_map: spec.hue_sat_map.clone(),
      look_table: dcp.look_table.clone(),
      hue_sat_encode: dcp.hue_sat_map_encoding == 1,
      look_encode: dcp.look_table_encoding == 1,
      tone_curve: dcp.tone_curve.clone(),
      baseline_exposure: baseline_exposure(meta)? + dcp.baseline_exposure_offset,
      neutral,
      cct: spec.cct,
      luma_nr,
      input,
      render_color: spec,
      scene: None,
      mask: None,
      modern_color,
      raw_to_prophoto,
      black,
      distortion: None,
      vignette: None,
      active_size: [meta.crop_width, meta.crop_height],
    })
  }

  /// Full demosaic's preserved-black camera RGB -> preserved-black RIMM,
  /// including the modern highlight shoulder and optional CR6 chroma NR.
  pub(crate) fn prepare_camera(
    &mut self,
    mut img: RgbImage,
    dcp: &Dcp,
    meta: &RawMetadata,
    settings: &crate::DevelopSettings,
    cancel: &crate::Cancel,
  ) -> Result<RgbImage> {
    let Some(input) = &self.input else {
      return Ok(img);
    };
    cancel.check()?;
    // Statistics retain the unwarped default crop, after mandatory embedded CA
    // and before user noise reduction. Sony keeps its surrounding active area
    // until after NR; reducing the crop directly avoids a full-size copy.
    let [left, top, width, height] = if meta.cfa.is_xtrans() {
      [0, 0, img.width, img.height]
    } else {
      [
        meta.crop_left,
        meta.crop_top,
        meta.crop_width,
        meta.crop_height,
      ]
    };
    let mask_camera = tone::stats_image::camera_pyramid_f32_region_at_level(
      &img, left, top, width, height, self.black, true, 2,
    );
    let small = tone::stats_image::deepen(&mask_camera, self.black, true);
    let flare = tone::stats_image::flare_for_log(&small, self.black);
    self.scene = Some(tone::scene::Scene::new(
      &small,
      dcp,
      meta,
      self.neutral,
      &settings.white_balance,
      self.black,
      flare,
    )?);
    let source =
      tone::mask::MaskSource::new(mask_camera, dcp, meta, self.neutral, self.black, flare);
    let guide = tone::mask_upsample::Guide::prepare(&img, &source, [left, top], cancel)?;
    self.mask = Some(Arc::new(CachedMask {
      source,
      result: OnceLock::new(),
      guide: Mutex::new(Some(guide)),
      full: OnceLock::new(),
    }));
    cancel.check()?;
    self.active_size = [img.width, img.height];
    self.distortion = if settings.lens.distortion {
      lens::EmbeddedDistortion::from_metadata(meta, self.active_size)?
    } else {
      None
    };
    self.vignette = if settings.lens.vignetting {
      lens::EmbeddedVignette::from_metadata(meta, self.active_size)?
    } else {
      None
    };
    // GetWarpedSourcePipe precedes AppendRawConversionStages: the nonlinear
    // u16 lens warp runs before the camera transform and both CR6 NR branches.
    if let Some(distortion) = &self.distortion {
      img = distortion.apply(img, cancel)?;
    }
    img.map_pixels(|p| input.pixel(p));
    let controls = settings.adobe_noise_reduction.clone().unwrap_or_else(|| {
      crate::settings::AdobeNoiseReduction {
        color: (settings.chroma_noise_reduction * 100.0).round() as u8,
        luminance: (settings.luma_noise_reduction.unwrap_or(0.0) * 100.0).round() as u8,
        ..Default::default()
      }
    });
    if controls.color != 0 || controls.luminance != 0 {
      let mut params = nr::params::Parameters::new(
        &meta.model,
        meta.iso.filter(|&v| v > 0).unwrap_or(100),
        input.noise_scale(),
        self.raw_to_prophoto,
        self.black,
        f64::from(controls.color) * 0.01,
        f64::from(controls.detail) * 0.01,
        f64::from(controls.smoothness) * 0.01,
      )
      .ok_or_else(|| {
        Error::Unsupported(format!(
          "Adobe chroma NR: unsupported calibration for {}",
          meta.model
        ))
      })?;
      if controls.luminance != 0 {
        params.luma = nr::luma::Parameters::new(
          &meta.model,
          meta.iso.filter(|&v| v > 0).unwrap_or(100),
          input.noise_scale(),
          f64::from(controls.luminance) * 0.01,
          f64::from(controls.luminance_detail) * 0.01,
          f64::from(controls.luminance_contrast) * 0.01,
        );
        if params.luma.is_none() {
          return Err(Error::Unsupported(format!(
            "Adobe luminance NR: unsupported calibration for {}",
            meta.model
          )));
        }
      }
      img = nr::apply(img, &params, cancel)?;
    }
    cancel.check()?;
    Ok(img)
  }

  /// Render balanced camera RGB to display-encoded Display P3. Returns the
  /// scene-linear Display P3 intermediate when `keep_linear`.
  pub(crate) fn render(
    &self,
    img: &mut RgbImage,
    settings: &crate::DevelopSettings,
    keep_linear: bool,
    cancel: &crate::Cancel,
  ) -> Result<Option<RgbImage>> {
    self.render_to_space(
      img,
      settings,
      keep_linear,
      cancel,
      output::OutputSpace::DisplayP3,
    )
  }

  fn render_to_space(
    &self,
    img: &mut RgbImage,
    settings: &crate::DevelopSettings,
    keep_linear: bool,
    cancel: &crate::Cancel,
    space: output::OutputSpace,
  ) -> Result<Option<RgbImage>> {
    let user_exposure = self.effective_user_exposure(settings.exposure);
    // ABCtoRGB_local divides linear RIMM by its largest quantized camera gain
    // to retain highlight headroom. The later exposure boundary restores it.
    let input_scale = self.input.as_ref().map_or(1.0, |i| i.noise_scale()) as f32;
    let exposure = self.baseline_exposure + user_exposure;
    let mut linear = keep_linear.then(|| {
      let mut l = img.clone();
      let m = Mat3(self.balanced_to_prophoto.map(|r| r.map(f64::from)));
      let lin = if self.input.is_some() {
        XYZ_D50_TO_LINEAR_P3.mul(&color::PROPHOTO_TO_XYZ_D50)
      } else {
        XYZ_D50_TO_LINEAR_P3
          .mul(&color::PROPHOTO_TO_XYZ_D50)
          .mul(&m)
      }
      .to_f32();
      let g = 2f64.powf(exposure) as f32;
      l.map_pixels(|p| {
        let p = if self.input.is_some() {
          p.map(|v| (v - self.black as f32) / ((1.0 - self.black as f32) * input_scale))
        } else {
          p
        };
        std::array::from_fn(|r| (lin[r][0] * p[0] + lin[r][1] * p[1] + lin[r][2] * p[2]) * g)
      });
      l
    });
    // For spatial edits without vignetting, the pointwise black/profile
    // conversion can feed tone directly, preserving every u16/float boundary.
    // Global edits benchmark faster with the separate, simpler colour pass.
    let fuse_color = self.scene.is_some()
      && self.vignette.is_none()
      && settings
        .adobe_tone
        .as_ref()
        .is_some_and(|tone| tone.highlights != 0 || tone.shadows != 0);
    if !fuse_color {
      self.prepare_color(img, cancel)?;
    }
    if let Some(linear) = &mut linear {
      self.apply_vignette(linear, false, cancel)?;
    }
    cancel.check()?;
    if let Some(scene) = &self.scene {
      let controls = settings.adobe_tone.clone().unwrap_or_default();
      let setup = tone::setup::Setup::new(
        tone::setup::Parameters {
          exposure_hundredths: (user_exposure * 100.0).round() as i32,
          whites: controls.whites,
          baseline_exposure: self.baseline_exposure,
          raw_scale: 1.0,
          custom_flare: Some(scene.flare),
        },
        &self.render_color,
        self.neutral,
        &scene.gray,
        &scene.colors,
      );
      let curve = tone::composition::Curve::new(
        self.tone_curve.as_deref(),
        setup.info.tone_exposure,
        0,
        setup.key,
      );
      let primary = tone::composition::Stage::from_curve(&curve);
      let contrast = tone::composition::UserContrast::new(controls.contrast, setup.key);
      let spatial = if controls.highlights != 0 || controls.shadows != 0 {
        let cache = self.mask.as_ref().expect("full Adobe mask state");
        let mask = cache.get(cancel)?;
        let post_setup = tone::setup::Setup::new(
          tone::setup::Parameters {
            exposure_hundredths: 0,
            whites: 0,
            baseline_exposure: self.baseline_exposure,
            raw_scale: 1.0,
            custom_flare: Some(scene.flare),
          },
          &self.render_color,
          self.neutral,
          &scene.gray,
          &scene.colors,
        );
        let post_stage = tone::post_map::Stage::new(
          &mask.source,
          &mask.filtered,
          &post_setup.info,
          controls.shadows,
          controls.highlights,
          post_setup.log_flare,
        );
        let post = scene.active_post_for_controls(
          [controls.shadows, controls.highlights],
          &post_stage,
          mask,
          cancel,
        )?;
        let stage = tone::spatial::Stage::new(
          &mask.source,
          &mask.filtered,
          &setup.info,
          controls.shadows,
          controls.highlights,
          setup.log_flare,
          setup.epsilon,
        );
        Some((
          cache,
          cache.full(self.distortion.as_ref(), cancel)?,
          stage,
          post,
        ))
      } else {
        None
      };
      let mut info = setup.info;
      info.statistics = spatial
        .as_ref()
        .map_or(&scene.post, |(_, _, _, post)| post)
        .exposure();
      info.calculate();
      let mut exposure_stage = tone::exposure::Stage::from_info(&info, setup.epsilon);
      tone::blacks::Blacks::mosaic(&info, controls.blacks, None, None).apply(&mut exposure_stage);
      let output = output::Output::new(space);
      let color = self.modern_color.as_ref().expect("full Adobe colour state");
      let input_pixel = |pixel| {
        if fuse_color {
          color.input_pixel(pixel)
        } else {
          pixel
        }
      };
      let before_primary = |pixel| {
        let pixel = exposure_stage.pixel(pixel);
        let pixel = pixel.map(|v| bayer::tables::normalized(bayer::tables::code(v)));
        let pixel = color
          .look
          .as_ref()
          .map_or(pixel, |table| table.pixel(pixel));
        pixel.map(|v| bayer::tables::normalized(bayer::tables::code(v)))
      };
      let before_primary_four = |pixels: [[f32; 3]; 4]| {
        let pixels = exposure_stage
          .pixels4(pixels)
          .map(|pixel| pixel.map(|v| bayer::tables::normalized(bayer::tables::code(v))));
        let pixels = color
          .look
          .as_ref()
          .map_or(pixels, |table| table.pixels4(pixels));
        pixels.map(|p| p.map(|v| bayer::tables::normalized(bayer::tables::code(v))))
      };
      let after_primary = |pixel| {
        let pixel = contrast.as_ref().map_or(pixel, |stage| stage.pixel(pixel));
        output.pixel(pixel)
      };
      let render_pixel = |pixel| after_primary(primary.pixel(before_primary(pixel)));
      let render_four = |pixels: [[f32; 3]; 4]| {
        output.pixels4(
          primary
            .pixels4(before_primary_four(pixels))
            .map(|pixel| contrast.as_ref().map_or(pixel, |stage| stage.pixel(pixel))),
        )
      };
      if let Some((cache, mask, stage, _)) = spatial {
        let size = [img.width, img.height];
        img
          .data
          .par_chunks_mut(size[0] * 3)
          .enumerate()
          .try_for_each(|(y, row)| {
            cancel.check()?;
            let (batches, tail) = row.as_chunks_mut::<3>().0.as_chunks_mut::<4>();
            let tail_start = batches.len() * 4;
            let spatial_pixel =
              |x, pixel| stage.pixel(input_pixel(pixel), cache.sample(mask, size, x, y));
            for (i, batch) in batches.iter_mut().enumerate() {
              let pixels = if fuse_color {
                color.input_pixels4(*batch)
              } else {
                *batch
              };
              *batch = render_four(std::array::from_fn(|j| {
                stage.pixel(pixels[j], cache.sample(mask, size, i * 4 + j, y))
              }));
            }
            for (i, pixel) in tail.iter_mut().enumerate() {
              *pixel = render_pixel(spatial_pixel(tail_start + i, *pixel));
            }
            Ok::<_, Error>(())
          })?;
      } else {
        img
          .data
          .par_chunks_mut((img.width * 3).max(3))
          .try_for_each(|row| {
            cancel.check()?;
            let (batches, tail) = row.as_chunks_mut::<3>().0.as_chunks_mut::<4>();
            for batch in batches {
              *batch = render_four(*batch);
            }
            for p in tail {
              *p = render_pixel(*p);
            }
            Ok::<_, Error>(())
          })?;
      }
      cancel.check()?;
      return Ok(linear);
    }
    if settings
      .adobe_tone
      .as_ref()
      .is_some_and(|tone| *tone != crate::settings::AdobeTone::default())
    {
      return Err(Error::Unsupported(
        "Adobe tone controls require full quality".into(),
      ));
    }
    let white = 1.0 / 2f64.powf(exposure.max(0.0));
    let black = (DEFAULT_BLACK * 0.001).min(0.99 * white);
    let ramp = render::exposure_ramp(white, black);
    let exp_tone = render::exposure_tone(exposure);
    let tone = match &self.tone_curve {
      Some(pts) if pts.len() >= 2 => {
        let curve = Table1d::from_points(4096, pts);
        Table1d::from_fn(4096, |x| curve.eval(exp_tone(x) as f32) as f64)
      }
      _ => {
        let acr3 = Table1d::from_slice_ref(&render::ACR3);
        Table1d::from_fn(4096, |x| acr3.eval(exp_tone(x) as f32) as f64)
      }
    };
    let srgb = Table1d::from_fn(4096, |x| srgb_encode(x as f32) as f64);
    let to_p3 = XYZ_D50_TO_LINEAR_P3
      .mul(&color::PROPHOTO_TO_XYZ_D50)
      .to_f32();
    img.map_pixels(|mut c| {
      if self.modern_color.is_some() {
        c = c.map(|v| (v / input_scale).clamp(0.0, 1.0));
      }
      c = c.map(|v| ramp.eval(v));
      if let Some(color) = &self.modern_color {
        if let Some(table) = &color.look {
          c = table.pixel(c);
        }
      } else if let Some(l) = &self.look_table {
        c = render::hue_sat_map(c, l, self.look_encode.then_some(&srgb));
      }
      c = render::rgb_tone(c, &tone);
      std::array::from_fn(|r| {
        let v = to_p3[r][0] * c[0] + to_p3[r][1] * c[1] + to_p3[r][2] * c[2];
        srgb_encode(v.clamp(0.0, 1.0))
      })
    });
    Ok(linear)
  }

  /// The production black-removal/profile-map/vignette boundary. Kept separate
  /// so composed RAW capture checks exercise the same operations as rendering.
  pub(crate) fn prepare_color(&self, img: &mut RgbImage, cancel: &crate::Cancel) -> Result<()> {
    if let Some(color) = &self.modern_color {
      img
        .data
        .par_chunks_mut((img.width * 3).max(3))
        .try_for_each(|row| {
          cancel.check()?;
          let (batches, tail) = row.as_chunks_mut::<3>().0.as_chunks_mut::<4>();
          for batch in batches {
            *batch = color.input_pixels4(*batch);
          }
          for p in tail {
            *p = color.input_pixel(*p);
          }
          Ok::<_, Error>(())
        })?;
      return self.apply_vignette(img, true, cancel);
    }
    let srgb = self
      .hue_sat_encode
      .then(|| Table1d::from_fn(4096, |x| srgb_encode(x as f32) as f64));
    img.map_pixels(|p| {
      if let Some(color) = &self.modern_color {
        color.input_pixel(p)
      } else {
        let c = render::abc_to_rgb(p, self.clip, &self.balanced_to_prophoto);
        self
          .hue_sat_map
          .as_ref()
          .map_or(c, |map| render::hue_sat_map(c, map, srgb.as_ref()))
      }
    });
    self.apply_vignette(img, true, cancel)
  }

  fn apply_vignette(&self, img: &mut RgbImage, clip: bool, cancel: &crate::Cancel) -> Result<()> {
    if let Some(vignette) = &self.vignette {
      // Screen-sized Prepared images approximate the same level-zero rays.
      // Full-size renders use the captured integer pixel coordinates exactly.
      let size = [img.width, img.height];
      let source_position = |p: [f32; 2]| {
        let p = std::array::from_fn(|c| {
          if size[c] == self.active_size[c] {
            p[c]
          } else {
            (p[c] + 0.5) * (self.active_size[c] as f32 / size[c] as f32) - 0.5
          }
        });
        self
          .distortion
          .as_ref()
          .map_or(p, |warp| warp.source_position(p))
      };
      // The black-removal table and first profile map precede this stage.
      vignette.apply(img, 0.0, clip, source_position, cancel)?;
    }
    cancel.check()
  }
}
