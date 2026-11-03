//! Explicit experimental bridge from denoised camera RGB to the Adobe renderer.
//!
//! This is separate from the ordinary development entry point. It requires
//! full-quality Adobe options and explicitly disabled post-denoise CR6 colour
//! and luminance NR. The display renderer is reused, but complete native ACR
//! denoise-to-display parity has not been established. Neural inference remains
//! numerical, not bit-exact.

use super::{
  DecodedMosaic, Model, MosaicTilePlan, Tensor, Variant, border::TileTraversal, tiles::Rect,
};
use crate::{
  Cancel, DevelopSettings, Engine, Error, Negative, Options, Prepared, Quality, Result,
  adobe::{AdobeRender, bayer::tables, dcp::Dcp, lens, xtrans},
  image::RgbImage,
  prepared::RenderPipeline,
};

/// Prepare a complete, canonical preserved-black camera-RGB image for display.
///
/// `canonical` must be interleaved RGB in the exact canonical bounds returned by
/// [`DecodedMosaic`], before lens correction, white balance, colour or tone. For
/// partial strength it must already include blending and inverse reference gain.
/// The caller is responsible for associating these pixels with `negative`; this
/// function validates calibration and storage, not external file provenance.
/// Both full and partial inputs cross the native u16 commit before lens stages.
///
/// Requires `Engine::Adobe`, `Quality::Full`, and `adobe_noise_reduction: Some`
/// with `color == 0` and `luminance == 0`. Other supported Adobe settings retain
/// their normal renderer semantics. Ordinary `crate::prepare` is unchanged.
/// A1 II also requires its external Adobe Standard v2 DCP for the negative's
/// default statistics calibration; display colour still uses Adobe Standard.
pub fn prepare_camera_rgb(
  negative: &Negative,
  canonical: RgbImage,
  settings: &DevelopSettings,
  options: &Options,
) -> Result<Prepared> {
  validate_policy(settings, options)?;
  validate_storage(&canonical, &options.cancel)?;
  let mosaic = DecodedMosaic::new_with_cancel(negative, &options.cancel)?;
  let (variant, bounds, crop) = (mosaic.variant(), mosaic.bounds(), mosaic.active_crop());
  drop(mosaic);
  validate_shape(&canonical, bounds)?;
  let dcp = load_profile(negative, options)?;
  finish_camera(negative, canonical, variant, crop, &dcp, settings, options)
}

/// Check render policy and required external profiles before expensive inference.
pub fn validate_render_inputs(
  negative: &Negative,
  settings: &DevelopSettings,
  options: &Options,
) -> Result<()> {
  validate_policy(settings, options)?;
  load_profile(negative, options)?;
  Ok(())
}

/// Run the calibrated denoiser and prepare its complete image for display.
///
/// Amounts 1..99 use the native partial-strength baseline and blend; Fuji needs
/// its separate Enhance Details model. Amount 100 bypasses baseline and blend.
/// This owns the complete output and returns no partial image after failure or
/// cancellation. The same explicit no-post-NR policy as [`prepare_camera_rgb`]
/// applies. Model files and DCP profiles remain caller supplied.
pub fn prepare(
  negative: &Negative,
  model: &Model,
  details: Option<&Model>,
  amount: u32,
  settings: &DevelopSettings,
  options: &Options,
) -> Result<Prepared> {
  validate_render_inputs(negative, settings, options)?;
  let image = predict_camera_rgb(negative, model, details, amount, options, |_, _| {})?;
  prepare_camera_rgb(negative, image, settings, options)
}

/// Complete canonical camera RGB. Progress counts completed output tiles; a failed
/// or cancelled inference never returns a partial image. Callers may cache the
/// committed u16 pixels before passing them to `prepare_camera_rgb`.
pub fn predict_camera_rgb(
  negative: &Negative,
  model: &Model,
  details: Option<&Model>,
  amount: u32,
  options: &Options,
  mut progress: impl FnMut(usize, usize),
) -> Result<RgbImage> {
  if !(1..=100).contains(&amount) {
    return Err(Error::Settings("denoise amount must be in 1..=100".into()));
  }
  let mosaic = DecodedMosaic::new_with_cancel(negative, &options.cancel)?;
  let (variant, bounds) = (mosaic.variant(), mosaic.bounds());
  let info = model.info();
  let edge = if variant == Variant::Bayer { 800 } else { 864 };
  if info.variant != variant
    || info.input_shape != [3, 1024, 1024]
    || info.output_shape != [3, edge, edge]
  {
    return Err(Error::Settings(
      "denoise model does not match the calibrated RAW layout".into(),
    ));
  }
  if amount < 100
    && variant == Variant::Xtrans
    && !details.is_some_and(|model| {
      let info = model.info();
      info.variant == Variant::XtransDetails
        && info.input_shape == [3, 512, 512]
        && info.output_shape == [3, 470, 470]
    })
  {
    return Err(Error::Settings(
      "partial X-Trans denoise requires its Enhance Details model".into(),
    ));
  }
  let [height, width] = bounds.size();
  let mut image = RgbImage::new(width, height);
  let total = TileTraversal::new(variant, bounds).count();
  let mut completed = 0;
  progress(completed, total);
  if amount == 100 {
    for area in TileTraversal::new(variant, bounds) {
      options.cancel.check()?;
      let plan = MosaicTilePlan::new(variant, area, mosaic.preserved_black())?;
      let source = mosaic.source_tile(area, &options.cancel)?;
      let output = plan.predict(model, plan.geometry().source, &source, &options.cancel)?;
      place_tile(&mut image, bounds, area, &output, &options.cancel)?;
      completed += 1;
      progress(completed, total);
    }
    drop(mosaic);
  } else {
    // Partial composition owns its calibrated source/cache; release this copy.
    drop(mosaic);
    super::partial::predict_partial_raw_tiles(
      negative,
      model,
      details,
      amount,
      None,
      &options.cancel,
      |area, output| {
        place_tile(&mut image, bounds, area, &output, &options.cancel)?;
        completed += 1;
        progress(completed, total);
        Ok(())
      },
    )?;
  }
  Ok(image)
}

fn validate_policy(settings: &DevelopSettings, options: &Options) -> Result<()> {
  options.cancel.check()?;
  settings.validate()?;
  if options.engine != Engine::Adobe || options.quality != Quality::Full {
    return Err(Error::Settings(
      "denoise rendering requires full-quality Adobe options".into(),
    ));
  }
  if !settings
    .adobe_noise_reduction
    .as_ref()
    .is_some_and(|nr| nr.color == 0 && nr.luminance == 0)
  {
    return Err(Error::Settings(
      "experimental denoise rendering requires explicit Adobe color and luminance noise reduction of zero".into(),
    ));
  }
  Ok(())
}

fn validate_storage(image: &RgbImage, cancel: &Cancel) -> Result<()> {
  if image.width == 0
    || image.height == 0
    || image
      .width
      .checked_mul(image.height)
      .and_then(|n| n.checked_mul(3))
      != Some(image.data.len())
  {
    return Err(Error::Malformed(
      "denoise camera RGB storage does not match its dimensions".into(),
    ));
  }
  for row in image.data.chunks(image.width * 3) {
    cancel.check()?;
    if row.iter().any(|v| !v.is_finite()) {
      return Err(Error::Malformed(
        "denoise camera RGB contains nonfinite samples".into(),
      ));
    }
  }
  Ok(())
}

fn validate_shape(image: &RgbImage, bounds: Rect) -> Result<()> {
  if [image.height, image.width] != bounds.size() {
    return Err(Error::Malformed(
      "denoise camera RGB must cover the complete canonical bounds".into(),
    ));
  }
  Ok(())
}

struct Profiles {
  render: Dcp,
  statistics: Option<Dcp>,
}

impl Profiles {
  fn statistics(&self) -> &Dcp {
    self.statistics.as_ref().unwrap_or(&self.render)
  }
}

fn load_profile(negative: &Negative, options: &Options) -> Result<Profiles> {
  let meta = &negative.meta;
  let directory = crate::adobe::profile_dir(options.adobe_profile_dir.as_deref())?;
  let path = Dcp::find_adobe_standard(&directory, &meta.make, &meta.model)?;
  crate::adobe::baseline_exposure(meta)?;
  let render = Dcp::open(&path)?;
  // A1 II's negative default is Standard v2 even when the selected display
  // profile is Standard. Native D50 statistics captures distinguish them.
  // Keep both external; never silently substitute the display profile.
  let statistics = if meta.model == "ILCE-1M2" {
    let statistics_path = path.with_file_name("Sony ILCE-1M2 Adobe Standard v2.dcp");
    if !statistics_path.is_file() {
      return Err(Error::Unsupported(
        "A1 II denoise rendering requires Sony ILCE-1M2 Adobe Standard v2.dcp for scene statistics"
          .into(),
      ));
    }
    Some(Dcp::open(&statistics_path)?)
  } else {
    None
  };
  Ok(Profiles { render, statistics })
}

fn place_tile(
  image: &mut RgbImage,
  bounds: Rect,
  area: Rect,
  tile: &Tensor,
  cancel: &Cancel,
) -> Result<()> {
  let [height, width] = area.size();
  if !bounds.contains(area) || tile.shape() != [3, height, width] {
    return Err(Error::Malformed(
      "denoise output tile does not match its rectangle".into(),
    ));
  }
  let top = (area.top() - bounds.top()) as usize;
  let left = (area.left() - bounds.left()) as usize;
  let plane = height * width;
  for y in 0..height {
    cancel.check()?;
    let row = &mut image.data[((top + y) * image.width + left) * 3..][..width * 3];
    for (x, pixel) in row.as_chunks_mut::<3>().0.iter_mut().enumerate() {
      for c in 0..3 {
        pixel[c] = tile.data()[c * plane + y * width + x];
      }
    }
  }
  Ok(())
}

fn finish_camera(
  negative: &Negative,
  image: RgbImage,
  variant: Variant,
  crop: Rect,
  dcp: &Profiles,
  settings: &DevelopSettings,
  options: &Options,
) -> Result<Prepared> {
  let (image, render) =
    prepare_camera_stages(negative, image, variant, crop, dcp, settings, options)?;
  Ok(Prepared::new(
    image,
    settings,
    options,
    negative.meta.orientation,
    RenderPipeline::Adobe(Box::new(render)),
  ))
}

// Keep the actual bridge stages shared with the external native-pixel replay.
// The replay bypasses only CNN inference, never lens, statistics or colour work.
fn prepare_camera_stages(
  negative: &Negative,
  mut image: RgbImage,
  variant: Variant,
  crop: Rect,
  dcp: &Profiles,
  settings: &DevelopSettings,
  options: &Options,
) -> Result<(RgbImage, AdobeRender)> {
  let cancel = &options.cancel;
  // Required even for full-strength inference and identity CA planes. Repeating
  // this commit on an already committed partial image is exactly idempotent.
  for row in image.data.chunks_mut(image.width * 3) {
    cancel.check()?;
    for value in row {
      *value = tables::normalized(tables::code(*value));
    }
  }
  let meta = &negative.meta;
  if variant == Variant::Xtrans {
    let [height, width] = crop.size();
    image = image.into_cropped(crop.left() as usize, crop.top() as usize, width, height);
  }
  if let Some(warp) = lens::embedded_ca(meta, meta.fuji_ibis_shift)? {
    image = warp.apply_active(image, cancel)?;
  }
  let wb = meta.as_shot_wb;
  let neutral = xtrans::rounded_neutral([1.0 / wb[0], 1.0, 1.0 / wb[2]]);
  let mut render = AdobeRender::new(
    &dcp.render,
    meta,
    neutral,
    0.0,
    &settings.white_balance,
    true,
  )?;
  image = render.prepare_camera_with_statistics_profile(
    image,
    &dcp.render,
    dcp.statistics(),
    meta,
    settings,
    cancel,
  )?;
  if variant == Variant::Bayer {
    let [height, width] = crop.size();
    image = image.into_cropped(crop.left() as usize, crop.top() as usize, width, height);
  }
  cancel.check()?;
  Ok((image, render))
}

#[cfg(test)]
#[path = "render_capture_tests.rs"]
mod capture_tests;

#[cfg(test)]
mod tests {
  use super::*;
  use crate::settings::AdobeNoiseReduction;

  fn settings() -> DevelopSettings {
    DevelopSettings {
      adobe_noise_reduction: Some(AdobeNoiseReduction {
        color: 0,
        luminance: 0,
        ..Default::default()
      }),
      ..Default::default()
    }
  }

  #[test]
  fn requires_explicit_full_adobe_and_no_post_nr() {
    let mut options = Options::default();
    let mut settings = settings();
    assert!(validate_policy(&settings, &options).is_err());
    options.engine = Engine::Adobe;
    assert!(validate_policy(&settings, &options).is_ok());
    options.quality = Quality::Preview;
    assert!(validate_policy(&settings, &options).is_err());
    options.quality = Quality::Full;
    settings.adobe_noise_reduction = None;
    assert!(validate_policy(&settings, &options).is_err());
    for (color, luminance) in [(1, 0), (0, 1)] {
      settings.adobe_noise_reduction = Some(AdobeNoiseReduction {
        color,
        luminance,
        ..Default::default()
      });
      assert!(validate_policy(&settings, &options).is_err());
    }
    options.cancel = Cancel::new();
    options.cancel.cancel();
    assert!(matches!(
      validate_policy(&settings, &options),
      Err(Error::Cancelled)
    ));
  }

  #[test]
  fn validates_storage_shape_and_finite_values() {
    let cancel = Cancel::never();
    let bounds = Rect::new(0, 0, 2, 3).unwrap();
    let mut image = RgbImage::new(3, 2);
    assert!(validate_storage(&image, &cancel).is_ok());
    assert!(validate_shape(&image, bounds).is_ok());
    assert!(validate_shape(&image, Rect::new(0, 0, 3, 2).unwrap()).is_err());
    image.data[0] = f32::NAN;
    assert!(validate_storage(&image, &cancel).is_err());
    image.data.clear();
    assert!(validate_storage(&image, &cancel).is_err());
    image.width = usize::MAX;
    assert!(validate_storage(&image, &cancel).is_err());
    assert!(validate_storage(&RgbImage::new(0, 0), &cancel).is_err());
  }

  #[test]
  fn stitches_planar_tiles_at_their_canonical_origin() {
    let bounds = Rect::new(7, 11, 10, 15).unwrap();
    let mut image = RgbImage::new(4, 3);
    let area = Rect::new(8, 12, 10, 14).unwrap();
    let tensor = Tensor::new([3, 2, 2], (1..=12).map(|v| v as f32).collect()).unwrap();
    place_tile(&mut image, bounds, area, &tensor, &Cancel::never()).unwrap();
    assert_eq!(image.px(1, 1), [1.0, 5.0, 9.0]);
    assert_eq!(image.px(2, 2), [4.0, 8.0, 12.0]);
    assert_eq!(image.px(0, 0), [0.0; 3]);
    assert!(place_tile(&mut image, bounds, bounds, &tensor, &Cancel::never()).is_err());
  }
}
