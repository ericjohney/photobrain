//! Composition of the observed no-gain Bayer/X-Trans denoise tile stages.
use super::border::{PhaseMirror, TileTraversal};
use super::tiles::{Rect, TileGeometry};
use super::transfer::{AffineTable, apply_signed_gamma};
use super::{Model, Tensor, Variant, invalid, pack_mosaic_tile};
use crate::{Cancel, Result};

impl Model {
  /// Stream denoised, unblended camera-RGB tiles in native traversal order.
  ///
  /// `source` is a row-major calibrated canonical mosaic, not raw sensor codes.
  /// The callback receives each disjoint destination rectangle and planar RGB
  /// tensor; copying those pixels at that rectangle stitches the image without
  /// overlap averaging. Only one inference owns scratch at a time. An error or
  /// cancellation stops subsequent tiles; callbacks already completed are not
  /// rolled back. See [`MosaicTilePlan`] for the no-gain transfer contract.
  pub fn predict_mosaic_tiles(
    &self,
    bounds: Rect,
    source: &[f32],
    preserved_black: f64,
    cancel: &Cancel,
    mut consume: impl FnMut(Rect, Tensor) -> Result<()>,
  ) -> Result<()> {
    cancel.check()?;
    for requested in TileTraversal::new(self.info().variant, bounds) {
      let plan = MosaicTilePlan::new(self.info().variant, requested, preserved_black)?;
      let tile = plan.extract_source(bounds, source, cancel)?;
      let result = plan.predict(self, plan.geometry.source, &tile, cancel)?;
      consume(requested, result)?;
    }
    cancel.check()
  }
}

/// One tile's input transfer, sparse packing, inference and output transfer.
///
/// The caller supplies a preserved-black, calibrated mosaic covering exactly
/// `geometry().source`, with Adobe's canonical sensor phase and border policy.
/// This is not a raw-code decoder or a full-image denoiser. It implements the
/// captured denoise path with gamma 0.25/4, zero histogram offsets and no optional
/// channel gains. Output is camera RGB with black restored, before strength
/// blending, lens correction or color rendering. Network parity is numerical.
pub struct MosaicTilePlan {
  variant: Variant,
  geometry: TileGeometry,
  remove_black: AffineTable,
  restore_black: AffineTable,
}

impl MosaicTilePlan {
  pub fn new(variant: Variant, requested: Rect, preserved_black: f64) -> Result<Self> {
    if !matches!(variant, Variant::Bayer | Variant::Xtrans) {
      return Err(invalid("mosaic tile requires Bayer or X-Trans model"));
    }
    Ok(Self {
      variant,
      geometry: TileGeometry::calculate(variant, requested)?,
      remove_black: AffineTable::remove_black(preserved_black)?,
      restore_black: AffineTable::restore_black(preserved_black)?,
    })
  }

  pub fn geometry(&self) -> TileGeometry {
    self.geometry
  }

  /// Extract the planned source from a row-major, calibrated canonical mosaic.
  /// Mirrors CFA blocks, then repeats the padded edge for requests beyond the
  /// mirror allocation. This avoids allocating a full padded sensor image.
  /// Source images smaller than the required mirror padding are unsupported.
  pub fn extract_source(
    &self,
    image_bounds: Rect,
    image: &[f32],
    cancel: &Cancel,
  ) -> Result<Tensor> {
    cancel.check()?;
    let [height, width] = image_bounds.size();
    if height.checked_mul(width) != Some(image.len())
      || !image_bounds.contains(self.geometry.requested)
    {
      return Err(invalid(
        "mosaic storage or destination does not match image bounds",
      ));
    }
    let (padding, period) = match self.variant {
      Variant::Bayer => (112, 2),
      Variant::Xtrans => (80, 6),
      _ => unreachable!("constructor rejects dense models"),
    };
    let mirror = PhaseMirror::new(image_bounds, padding, period)?;
    let mut samples = Vec::with_capacity(1024 * 1024);
    for row in self.geometry.source.top()..self.geometry.source.bottom() {
      cancel.check()?;
      for column in self.geometry.source.left()..self.geometry.source.right() {
        let [y, x] = mirror.source_coordinate_with_edge_repeat(row, column);
        let index = (y - image_bounds.top()) as usize * width + (x - image_bounds.left()) as usize;
        samples.push(image[index]);
      }
    }
    Tensor::new([1, 1024, 1024], samples)
  }

  /// Normalize and pack a caller-provided, correctly padded mosaic tile.
  /// Requiring its actual rectangle prevents silently shifting the CFA phase.
  pub fn prepare_input(
    &self,
    source_rect: Rect,
    source: &Tensor,
    cancel: &Cancel,
  ) -> Result<Tensor> {
    cancel.check()?;
    if source_rect != self.geometry.source || source.shape() != [1, 1024, 1024] {
      return Err(invalid(
        "mosaic tensor does not match planned source rectangle",
      ));
    }
    let mut samples = source.data().to_vec();
    self.remove_black.apply(&mut samples)?;
    cancel.check()?;
    apply_signed_gamma(&mut samples, 0.25)?;
    cancel.check()?;
    pack_mosaic_tile(self.variant, &samples, [0.0; 3])
  }

  /// Crop a model result, apply signed fourth power and restore black.
  /// This can also replay a captured Adobe tensor independently of Rust inference.
  pub fn finish_output(&self, model_output: &Tensor, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    let cropped = self.geometry.crop_model_output(model_output)?;
    let shape = cropped.shape();
    let mut samples = cropped.into_data();
    apply_signed_gamma(&mut samples, 4.0)?;
    cancel.check()?;
    self.restore_black.apply(&mut samples)?;
    cancel.check()?;
    Tensor::new(shape, samples)
  }

  /// Run the composed tile without changing the model or source tensor.
  pub fn predict(
    &self,
    model: &Model,
    source_rect: Rect,
    source: &Tensor,
    cancel: &Cancel,
  ) -> Result<Tensor> {
    cancel.check()?;
    if model.info().variant != self.variant {
      return Err(invalid("model variant does not match mosaic tile plan"));
    }
    let input = self.prepare_input(source_rect, source, cancel)?;
    let output = model.predict(&input, cancel)?;
    self.finish_output(&output, cancel)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn trailing_tile_repeats_mirrored_edge_without_reversing_cfa_blocks() {
    let bounds = Rect::new(0, 0, 120, 120).unwrap();
    let requested = Rect::new(119, 119, 120, 120).unwrap();
    let plan = MosaicTilePlan::new(Variant::Bayer, requested, 0.0).unwrap();
    let image: Vec<f32> = (0..120 * 120).map(|i| i as f32).collect();
    let tile = plan
      .extract_source(bounds, &image, &Cancel::never())
      .unwrap();
    // The far bottom/right model footprint clamps to padded coordinate231;
    // its CFA block reflection selects original position9 on both axes.
    assert_eq!(tile.data()[1024 * 1024 - 1], image[9 * 120 + 9]);
    assert!(
      plan
        .extract_source(bounds, &image[..100], &Cancel::never())
        .is_err()
    );
    let tiny = Rect::new(119, 119, 120, 120).unwrap();
    assert!(plan.extract_source(tiny, &[0.0], &Cancel::never()).is_err());
  }

  #[test]
  fn rejects_wrong_phase_dense_models_and_cancelled_work() {
    let rect = Rect::new(0, 0, 10, 10).unwrap();
    assert!(MosaicTilePlan::new(Variant::LinearRaw, rect, 0.0).is_err());
    assert!(MosaicTilePlan::new(Variant::Bayer, rect, 1.0).is_err());
    let plan = MosaicTilePlan::new(Variant::Bayer, rect, 0.0).unwrap();
    let source = Tensor::new([1, 1024, 1024], vec![0.0; 1024 * 1024]).unwrap();
    assert!(plan.prepare_input(rect, &source, &Cancel::never()).is_err());
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
      plan.prepare_input(plan.geometry.source, &source, &cancel),
      Err(crate::Error::Cancelled)
    ));
    assert!(matches!(
      plan.finish_output(&source, &cancel),
      Err(crate::Error::Cancelled)
    ));
    assert!(plan.finish_output(&source, &Cancel::never()).is_err());
  }
}
