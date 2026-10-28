//! Cooperative cancellation for long developments.
//!
//! A [`Cancel`] is a cheap, cloneable flag shared between the caller and `develop`.
//! The pipeline checks it between stages (and between rows of the streamed luma
//! level), returning [`Error::Cancelled`] once it is set. Checks never touch pixel
//! values, so an uncancelled develop is bit-identical to one without a token.

use crate::error::{Error, Result};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, Default)]
pub struct Cancel(Option<Arc<AtomicBool>>);

impl Cancel {
  /// A token that is never cancelled (no checks cost anything).
  pub fn never() -> Self {
    Cancel(None)
  }

  /// A new token, initially not cancelled.
  pub fn new() -> Self {
    Cancel(Some(Arc::new(AtomicBool::new(false))))
  }

  /// A token observing an existing flag (for example one shared with another thread).
  pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
    Cancel(Some(flag))
  }

  /// Request cancellation; every holder of this token observes it.
  pub fn cancel(&self) {
    if let Some(f) = &self.0 {
      f.store(true, Ordering::Relaxed);
    }
  }

  pub fn is_cancelled(&self) -> bool {
    self.0.as_ref().is_some_and(|f| f.load(Ordering::Relaxed))
  }

  /// `Err(Error::Cancelled)` once cancellation has been requested.
  pub fn check(&self) -> Result<()> {
    if self.is_cancelled() {
      Err(Error::Cancelled)
    } else {
      Ok(())
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn never_is_never_cancelled() {
    let c = Cancel::never();
    c.cancel();
    assert!(c.check().is_ok());
  }

  #[test]
  fn clones_share_the_flag() {
    let c = Cancel::new();
    let d = c.clone();
    assert!(d.check().is_ok());
    c.cancel();
    assert!(matches!(d.check(), Err(Error::Cancelled)));
  }

  /// A small synthetic X-E5 negative (flat grey X-Trans mosaic, ISO 10000 so every
  /// NR stage runs).
  fn synthetic_negative() -> crate::Negative {
    use crate::cfa::CfaPattern;
    use crate::metadata::{Container, LensSource, RawMetadata, RawStorage};
    let (w, h) = (96usize, 72usize);
    crate::Negative {
      meta: RawMetadata {
        container: Container::Raf,
        make: "FUJIFILM".into(),
        model: "X-E5".into(),
        raw_width: w,
        raw_height: h,
        crop_top: 0,
        crop_left: 0,
        crop_width: w,
        crop_height: h,
        bits_per_sample: 14,
        black_levels: vec![1024; 36],
        white_level: Some(16383),
        as_shot_wb: [1.8, 1.0, 1.6],
        cfa: CfaPattern::xtrans_default(),
        storage: RawStorage::Uncompressed {
          offset: 0,
          length: 0,
        },
        orientation: 1,
        iso: Some(10000),
        exposure_time: None,
        sony_raw_format: None,
        sony_daylight_wb: None,
        fuji_ibis_shift: None,
        fuji_daylight_wb: None,
        raw_exposure_bias: None,
        lens: LensSource::None,
        lens_model: None,
        focal_length: None,
      },
      mosaic: (0..w * h).map(|i| 3000 + (i % 7) as u16 * 40).collect(),
      dng: None,
    }
  }

  #[test]
  fn develop_honours_cancellation() {
    let neg = synthetic_negative();
    let settings = crate::DevelopSettings::default();
    // Uncancelled: develops, identical to the default (no-token) options.
    let token = Cancel::new();
    let with_token = crate::develop(
      &neg,
      &settings,
      &crate::Options {
        cancel: token.clone(),
        ..crate::Options::default()
      },
    )
    .unwrap();
    let plain = crate::develop(&neg, &settings, &crate::Options::default()).unwrap();
    assert_eq!(
      with_token
        .image
        .data
        .iter()
        .map(|v| v.to_bits())
        .collect::<Vec<_>>(),
      plain
        .image
        .data
        .iter()
        .map(|v| v.to_bits())
        .collect::<Vec<_>>()
    );
    // Cancelled: stops with Error::Cancelled.
    token.cancel();
    let r = crate::develop(
      &neg,
      &settings,
      &crate::Options {
        cancel: token,
        ..crate::Options::default()
      },
    );
    assert!(matches!(r, Err(Error::Cancelled)));
  }
}
