//! Cached scene measurements at the pre-detail camera-image boundary.

use super::{
  post_stats::PostToneImage,
  statistics::Statistics,
  stats_image::{self, GrayLogImage, SmallImage},
};
use crate::{Error, Result, adobe::dcp::Dcp, metadata::RawMetadata, settings::WhiteBalance};

#[derive(Clone, Debug)]
pub(crate) struct Scene {
  pub(crate) gray: Statistics,
  pub(crate) colors: [Statistics; 3],
  pub(crate) post: Statistics,
  pub(crate) flare: f64,
  pub(crate) camera: SmallImage,
  pub(crate) post_image: PostToneImage,
}

impl Scene {
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
    })
  }
}
