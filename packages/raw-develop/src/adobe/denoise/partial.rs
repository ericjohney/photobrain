//! Partial-strength RAW composition, preserving each model's full-image tile grid.
use super::{
  DecodedMosaic, Model, MosaicTilePlan, Tensor, Variant,
  baseline_bayer::BayerBaseline,
  baseline_xtrans::XtransBaseline,
  border::TileTraversal,
  gains::DenoiseGains,
  invalid,
  region::TileCache,
  strength::{BlendWeights, blend_tile},
  tiles::Rect,
};
use crate::{Cancel, Negative, Result};

fn intersection(a: Rect, b: Rect) -> Option<Rect> {
  Rect::new(
    a.top().max(b.top()),
    a.left().max(b.left()),
    a.bottom().min(b.bottom()),
    a.right().min(b.right()),
  )
  .ok()
}
fn halo(area: Rect) -> Result<Rect> {
  let add = |v: i32, d: i32| {
    v.checked_add(d)
      .ok_or_else(|| invalid("blend halo coordinate overflow"))
  };
  Rect::new(
    add(area.top(), -3)?,
    add(area.left(), -3)?,
    add(area.bottom(), 3)?,
    add(area.right(), 3)?,
  )
}

/// Stream amounts 1..99 for the calibrated Sony/Fuji RAW layouts.
///
/// Fuji requires its separate Enhance Details model. Model tiles retain the
/// original full-image grid even for a requested subregion: histogram offsets
/// and convolution context must not change with an export crop. Output is
/// preserved-black camera RGB after the native u16 blend/gain boundaries, before
/// lens correction, color or tone. Neural inference remains numerical.
///
/// Amount 100 uses the existing full-strength path, bypassing baseline/blending.
/// Callbacks already delivered are not rolled back on failure or cancellation.
#[allow(clippy::too_many_arguments)]
pub fn predict_partial_raw_tiles(
  negative: &Negative,
  model: &Model,
  details: Option<&Model>,
  amount: u32,
  region: Option<Rect>,
  cancel: &Cancel,
  mut consume: impl FnMut(Rect, Tensor) -> Result<()>,
) -> Result<()> {
  cancel.check()?;
  if !(1..100).contains(&amount) {
    return Err(invalid("partial denoise amount must be 1..99"));
  }
  let variant = model.info().variant;
  if !matches!(variant, Variant::Bayer | Variant::Xtrans) {
    return Err(invalid(
      "partial RAW denoise requires Bayer or X-Trans model",
    ));
  }
  if model.info().input_shape != [3, 1024, 1024]
    || model.info().output_shape
      != if variant == Variant::Bayer {
        [3, 800, 800]
      } else {
        [3, 864, 864]
      }
  {
    return Err(invalid("partial denoise model has unexpected geometry"));
  }
  if variant == Variant::Xtrans
    && !details.is_some_and(|m| {
      m.info().variant == Variant::XtransDetails
        && m.info().input_shape == [3, 512, 512]
        && m.info().output_shape == [3, 470, 470]
    })
  {
    return Err(invalid(
      "partial X-Trans denoise requires its Enhance Details model",
    ));
  }
  let bayer = if variant == Variant::Bayer {
    Some(BayerBaseline::new(negative, cancel)?)
  } else {
    None
  };
  let fuji = if variant == Variant::Xtrans {
    Some(DecodedMosaic::new_with_cancel(negative, cancel)?)
  } else {
    None
  };
  let mosaic = if let Some(b) = &bayer {
    b.mosaic()
  } else {
    fuji.as_ref().unwrap()
  };
  if mosaic.variant() != variant {
    return Err(invalid("model does not match decoded RAW mosaic"));
  }
  let bounds = mosaic.bounds();
  let region = region.unwrap_or(bounds);
  if !bounds.contains(region) {
    return Err(invalid("partial denoise region exceeds image bounds"));
  }
  let gains = DenoiseGains::from_negative(negative)?;
  let baseline = if variant == Variant::Xtrans {
    Some(XtransBaseline::new(mosaic, gains.reference_gains())?)
  } else {
    None
  };
  // Bounded caches keep neighboring tiles available for the blend halo. No full
  // image RGB allocation is required; eviction only repeats deterministic work.
  let mut neural_cache = TileCache::new(bounds, variant, 32)?;
  let mut baseline_cache = TileCache::new(
    bounds,
    if variant == Variant::Xtrans {
      Variant::XtransDetails
    } else {
      variant
    },
    32,
  )?;
  for area in TileTraversal::new(variant, bounds).filter_map(|r| intersection(r, region)) {
    cancel.check()?;
    let requested = halo(area)?;
    let denoised = neural_cache.read_repeated(requested, cancel, |tile| {
      let plan = MosaicTilePlan::new(variant, tile, mosaic.preserved_black())?;
      let source = mosaic.source_tile(tile, cancel)?;
      let input = plan.prepare_input(plan.geometry().source, &source, cancel)?;
      let predicted = model.predict(&input, cancel)?;
      gains.finish_balanced(&plan, &predicted, cancel)
    })?;
    let original = baseline_cache.read_repeated(requested, cancel, |tile| {
      if let Some(b) = &bayer {
        b.render_area(tile, cancel)
      } else {
        baseline
          .as_ref()
          .unwrap()
          .predict(details.unwrap(), tile, cancel)
      }
    })?;
    let blended = blend_tile(
      &original,
      &denoised,
      BlendWeights::from_amount(amount),
      cancel,
    )?;
    let output = gains.finish_after_blend(&blended, cancel)?;
    consume(area, output)?;
  }
  cancel.check()
}
