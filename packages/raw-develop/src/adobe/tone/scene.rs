//! Cached scene measurements at the pre-detail camera-image boundary.

use super::{
  post_stats::PostToneImage,
  statistics::Statistics,
  stats_image::{self, GrayLogImage, SmallImage},
};
use crate::{Error, Result, adobe::dcp::Dcp, metadata::RawMetadata, settings::WhiteBalance};
use std::sync::{Arc, Mutex};

#[derive(Debug)]
struct ActivePost {
  controls: [i32; 2],
  statistics: Statistics,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Scene {
  pub(crate) gray: Statistics,
  pub(crate) colors: [Statistics; 3],
  pub(crate) post: Statistics,
  pub(crate) flare: f64,
  pub(crate) camera: SmallImage,
  pub(crate) post_image: PostToneImage,
  #[serde(skip)]
  active_post_cache: Arc<Mutex<Option<ActivePost>>>,
}

impl Scene {
  /// This measurement resets exposure/whites/contrast/blacks and depends only
  /// on H/S within this immutable prepared scene. Retain one result, shared by
  /// resized proxies, rather than growing a cache for every slider position.
  pub(crate) fn active_post_for_controls(
    &self,
    controls: [i32; 2],
    stage: &super::post_map::Stage,
    mask: &super::mask::Mask,
    cancel: &crate::Cancel,
  ) -> Result<Statistics> {
    cancel.check()?;
    {
      let cached = self
        .active_post_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner());
      if let Some(cached) = cached.as_ref()
        && cached.controls == controls
      {
        return Ok(cached.statistics.clone());
      }
    }
    // Compute outside the mutex. Concurrent edits may duplicate a measurement
    // but cannot publish a result under another edit's control key.
    let statistics = self.active_post(stage, mask, cancel)?;
    cancel.check()?;
    *self
      .active_post_cache
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = Some(ActivePost {
      controls,
      statistics: statistics.clone(),
    });
    Ok(statistics)
  }

  pub(crate) fn active_post(
    &self,
    stage: &super::post_map::Stage,
    mask: &super::mask::Mask,
    cancel: &crate::Cancel,
  ) -> Result<Statistics> {
    cancel.check()?;
    let image = self
      .post_image
      .render_active(&self.camera, self.flare, stage, mask);
    cancel.check()?;
    Statistics::new(&image, self.flare).ok_or_else(|| {
      Error::Settings("Adobe post-tone statistics require finite image values".into())
    })
  }

  pub(crate) fn new(
    image: &SmallImage,
    dcp: &Dcp,
    meta: &RawMetadata,
    neutral: [f64; 3],
    white: &WhiteBalance,
    black: f64,
    flare: f64,
  ) -> Result<Self> {
    let statistics = |values: &[f32]| {
      Statistics::new(values, flare)
        .ok_or_else(|| Error::Settings("Adobe scene statistics require finite image values".into()))
    };
    let gray = statistics(&GrayLogImage::new(dcp, meta, neutral, black).render(image, flare))?;
    let colors: Vec<_> = stats_image::channel_logs(image, black, flare)
      .iter()
      .map(|v| statistics(v))
      .collect::<Result<_>>()?;
    let colors = colors.try_into().expect("three camera channels");
    let post_image = PostToneImage::new(dcp, meta, neutral, black, white);
    let post = statistics(&post_image.render(image, flare))?;
    Ok(Self {
      gray,
      colors,
      post,
      flare,
      camera: image.clone(),
      post_image,
      active_post_cache: Arc::new(Mutex::new(None)),
    })
  }
}
