//! Reusable development state for interactive edits.
//!
//! RAF/ARW preparation stops after highlight recovery, before colour and exposure.
//! ProRAW preparation stops before detail: that stage depends on exposure and must
//! run again when exposure changes. Neither path retains the original `Negative`.

use crate::error::{Error, Result};
use crate::image::RgbImage;
use crate::math::srgb_encode;
use crate::pipeline::{DevelopInfo, Developed, Options, Quality};
use crate::settings::DevelopSettings;
use crate::stages::{detail, dng_detail, dng_look, highlights, look};

#[derive(Clone, Debug)]
pub(crate) struct MosaicRender {
  pub matrix: [[f32; 3]; 3],
  pub black_render: f32,
  pub baseline_exposure: f64,
  pub neutral: [f64; 3],
  pub cct: f64,
  pub luma_nr: f32,
  pub sharpen_scale: Option<f32>,
}

#[derive(Clone, Debug)]
pub(crate) struct DngRender {
  pub matrix: [[f32; 3]; 3],
  pub baseline_exposure: f64,
  pub neutral: [f64; 3],
  pub cct: f64,
  pub gain_table_map: Option<crate::dng::GainTableMap>,
  pub tone: dng_look::ToneLut,
}

#[derive(Clone, Debug)]
pub(crate) enum RenderPipeline {
  Mosaic(MosaicRender),
  Adobe(Box<crate::adobe::AdobeRender>),
  Dng(Box<DngRender>),
}

/// Owned working image, reusable for exposure, Adobe tone controls, rotation and crop.
///
/// Use [`crate::prepare`] once, then [`Self::render`] for each slider position.
/// Changes to white balance, detail, highlight recovery, lens settings or quality
/// require a new preparation and return an error rather than silently using stale
/// pixels. Rendering does not mutate the working image or accumulate adjustments.
#[derive(Clone, Debug)]
pub struct Prepared {
  image: RgbImage,
  settings: DevelopSettings,
  quality: Quality,
  orientation: u16,
  pipeline: RenderPipeline,
}

impl Prepared {
  pub(crate) fn new(
    image: RgbImage,
    settings: &DevelopSettings,
    opts: &Options,
    orientation: u16,
    pipeline: RenderPipeline,
  ) -> Self {
    Self {
      image,
      settings: settings.clone(),
      quality: opts.quality,
      orientation,
      pipeline,
    }
  }

  /// Working dimensions in sensor orientation, before user rotation and crop.
  pub fn dimensions(&self) -> (usize, usize) {
    (self.image.width, self.image.height)
  }

  /// The working pixels: white-balanced camera RGB for RAF/ARW (white = 1,1,1),
  /// after demosaic, noise reduction, lens correction and highlight recovery.
  /// Full Adobe preparation instead stores preserved-black linear ProPhoto
  /// (RIMM), after its camera-input transform and chroma/luminance noise reduction.
  pub fn working_image(&self) -> &RgbImage {
    &self.image
  }

  /// Bytes occupied by the working RGB pixels, excluding cached scene/guide data.
  pub fn pixel_bytes(&self) -> usize {
    self.image.data.len() * size_of::<f32>()
  }

  /// Reduce the working image to fit `max_edge`, without upscaling or clipping its
  /// linear values. Consumes the larger image so callers need not retain both.
  ///
  /// This is an approximate screen preview: resizing happens before the nonlinear
  /// look and any remaining detail stages, so it is not a downscaled final render.
  /// For unchanged, bit-exact rendering, omit this operation.
  pub fn with_max_edge(mut self, max_edge: usize) -> Result<Self> {
    if max_edge == 0 {
      return Err(Error::Settings("max_edge must be positive".into()));
    }
    if self.image.width.max(self.image.height) > max_edge {
      let old_width = self.image.width;
      self.image = self.image.resize_to_fit(max_edge);
      if let RenderPipeline::Mosaic(m) = &mut self.pipeline
        && let Some(scale) = &mut m.sharpen_scale
      {
        *scale *= self.image.width as f32 / old_width as f32;
      }
    }
    Ok(self)
  }

  pub fn render(&self, settings: &DevelopSettings, opts: &Options) -> Result<Developed> {
    settings.validate()?;
    opts.cancel.check()?;
    // Exposure, tone and geometry are applied after the preparation boundary.
    // Keep other changes fenced even on paths that currently ignore them.
    let mut preparation = settings.clone();
    preparation.exposure = self.settings.exposure;
    preparation.tone_amount = self.settings.tone_amount;
    preparation.crop = self.settings.crop;
    preparation.quarter_turns = self.settings.quarter_turns;
    let engine = match self.pipeline {
      RenderPipeline::Adobe(_) => crate::Engine::Adobe,
      _ => crate::Engine::Apple,
    };
    if engine == crate::Engine::Adobe {
      preparation.adobe_tone = self.settings.adobe_tone.clone();
    }
    if preparation != self.settings || opts.quality != self.quality || opts.engine != engine {
      return Err(Error::Settings(
        "settings or quality changed before the render boundary; call prepare again".into(),
      ));
    }
    finish(
      self.image.clone(),
      &self.pipeline,
      self.orientation,
      settings,
      opts,
    )
  }

  /// The one-shot path transfers its working pixels instead of cloning a second
  /// full-resolution RGB buffer. Settings and options are those used to prepare it.
  pub(crate) fn into_developed(
    self,
    settings: &DevelopSettings,
    opts: &Options,
  ) -> Result<Developed> {
    finish(self.image, &self.pipeline, self.orientation, settings, opts)
  }
}

fn finish(
  mut img: RgbImage,
  pipeline: &RenderPipeline,
  orientation: u16,
  settings: &DevelopSettings,
  opts: &Options,
) -> Result<Developed> {
  let cancel = &opts.cancel;
  cancel.check()?;
  let (linear, info) = match pipeline {
    RenderPipeline::Mosaic(m) => {
      let exposure_ev = m.baseline_exposure + settings.exposure;
      let gain = 2f64.powf(exposure_ev) as f32;
      let matrix = m.matrix;
      let br = m.black_render;
      img.map_pixels(|p| {
        [
          (matrix[0][0] * p[0] + matrix[0][1] * p[1] + matrix[0][2] * p[2] - br) * gain,
          (matrix[1][0] * p[0] + matrix[1][1] * p[1] + matrix[1][2] * p[2] - br) * gain,
          (matrix[2][0] * p[0] + matrix[2][1] * p[1] + matrix[2][2] * p[2] - br) * gain,
        ]
      });
      cancel.check()?;
      // Preview/fallback sharpening is exposure-dependent and cannot be cached
      // before the colour/exposure boundary, unlike the full luma pyramid.
      if let Some(scale) = m.sharpen_scale {
        detail::apply(
          &mut img,
          &detail::DetailParams {
            luma_nr: 0.0,
            chroma_nr: 0.0,
            sharpen: settings.sharpening,
            scale,
            noise: 1.0,
          },
        );
      }
      let linear = opts.keep_linear.then(|| img.clone());
      cancel.check()?;
      const BOOST: look::Boost = look::Boost::RAWCAMERA;
      let amount = settings.tone_amount;
      img.map_pixels(|p| look::render(p, amount, &BOOST).map(|v| srgb_encode(v.clamp(0.0, 1.0))));
      (
        linear,
        DevelopInfo {
          neutral: m.neutral,
          cct: m.cct,
          exposure_ev,
          luma_nr: m.luma_nr,
        },
      )
    }
    RenderPipeline::Adobe(a) => {
      let linear = a.render(&mut img, settings, opts.keep_linear, cancel)?;
      (
        linear,
        DevelopInfo {
          neutral: a.neutral,
          cct: a.cct,
          exposure_ev: a.baseline_exposure + a.effective_user_exposure(settings.exposure),
          luma_nr: a.luma_nr,
        },
      )
    }
    RenderPipeline::Dng(d) => {
      let exposure_ev = d.baseline_exposure + settings.exposure;
      let gain = 2f64.powf(exposure_ev) as f32;
      dng_detail::apply(
        &mut img,
        &dng_detail::Params {
          gain,
          chroma: settings.chroma_noise_reduction,
          detail: settings.sharpening * 0.5,
        },
      );
      cancel.check()?;
      if settings.highlight_recovery {
        highlights::recover(&mut img, [1.0, 0.9, 1.0]);
      }
      cancel.check()?;
      let matrix = d.matrix;
      img.map_pixels(|p| {
        [0, 1, 2].map(|r| (matrix[r][0] * p[0] + matrix[r][1] * p[1] + matrix[r][2] * p[2]) * gain)
      });
      let linear = opts.keep_linear.then(|| img.clone());
      cancel.check()?;
      let amount = settings.tone_amount;
      if let Some(gtm) = &d.gain_table_map {
        dng_look::gain_table_map(&mut img, gtm, amount);
      }
      cancel.check()?;
      img.map_pixels(|p| {
        let g = look::gamut_map(p);
        let q = if amount >= 1.0 {
          g
        } else {
          std::array::from_fn(|k| p[k] + (g[k] - p[k]) * amount)
        };
        d.tone
          .apply(q, amount)
          .map(|v| srgb_encode(v.clamp(0.0, 1.0)))
      });
      (
        linear,
        DevelopInfo {
          neutral: d.neutral,
          cct: d.cct,
          exposure_ev,
          luma_nr: 0.0,
        },
      )
    }
  };
  cancel.check()?;
  let orientation = rotate_orientation(orientation, settings.quarter_turns);
  if orientation != 1 {
    img = img.oriented(orientation);
  }
  cancel.check()?;
  if let Some(c) = settings.crop {
    // A valid subpixel crop near an edge can round its origin to width/height.
    // Keep at least one pixel, including on small working previews.
    let x0 = ((c.x * img.width as f64).round() as usize).min(img.width - 1);
    let y0 = ((c.y * img.height as f64).round() as usize).min(img.height - 1);
    let cw = ((c.width * img.width as f64).round() as usize).clamp(1, img.width - x0);
    let ch = ((c.height * img.height as f64).round() as usize).clamp(1, img.height - y0);
    img = img.crop(x0, y0, cw, ch);
  }
  cancel.check()?;
  Ok(Developed {
    image: img,
    linear,
    info,
  })
}

/// Compose an EXIF orientation with additional clockwise quarter turns.
fn rotate_orientation(o: u16, turns: u8) -> u16 {
  let (rot, mirror) = match o {
    2 => (0, true),
    3 => (2, false),
    4 => (2, true),
    5 => (3, true),
    6 => (1, false),
    7 => (1, true),
    8 => (3, false),
    _ => (0, false),
  };
  match ((rot + turns as u16) % 4, mirror) {
    (0, false) => 1,
    (0, true) => 2,
    (2, false) => 3,
    (2, true) => 4,
    (3, true) => 5,
    (1, false) => 6,
    (1, true) => 7,
    (3, false) => 8,
    _ => unreachable!(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn orientation_composition() {
    assert_eq!(rotate_orientation(1, 1), 6);
    assert_eq!(rotate_orientation(8, 1), 1);
    assert_eq!(rotate_orientation(6, 2), 8);
    for o in 1..=8 {
      assert_eq!(rotate_orientation(o, 0), o);
      assert_eq!(rotate_orientation(rotate_orientation(o, 3), 1), o);
    }
  }
}
