//! The development pipeline. Stage order follows Apple's RawCamera graph:
//!
//!  1. linearise: black subtract, scale by the white level           (deXtrans inputs)
//!  2. white balance                                                (deXtrans factors)
//!  3. demosaic (full, or binned for previews)                       (deXtrans_v8)
//!  4. crop to the active area                                       (crop)
//!  5. noise reduction                                               (pyramid detail)
//!  6. lens correction: distortion, CA, vignetting                   (radialLens)
//!  7. highlight reconstruction                                      (RAWRecoverHighlightsV2)
//!  8. camera -> scene-linear Display P3, exposure                   (colour matrices)
//!  9. sharpening
//! 10. hue magnet, gamut map, tone boost -> encoded Display P3       (RAWHueMagnetMR, gmKernel_v7, boost_v7)
//! 11. orientation, user rotation and crop
//!
//! Stage 3 is `deXtrans_v8` for X-Trans and `despeckle_v8` + `deBayer_v8` for Bayer (Sony).
//! LinearRaw DNGs (Apple ProRAW) branch to `prepare_dng` and the prepared renderer:
//! detail, highlight recovery, DNG colour, exposure, gain table map, gamut map and
//! the `ProfileToneCurve` LUT.
//!
//! `develop` is a pure function of a `Negative` and `DevelopSettings`.

use crate::Negative;
use crate::error::Result;
use crate::image::RgbImage;
use crate::prepared::{DngRender, MosaicRender, Prepared, RenderPipeline};
use crate::profile::CameraProfile;
use crate::settings::{DevelopSettings, WhiteBalance};
use crate::stages::{
  chroma_nr, debayer, demosaic, detail, dextrans, highlights, lens::LensCorrection, luma,
};
use rayon::prelude::*;

/// Bumped whenever developed output changes for the same input and settings.
pub const PIPELINE_VERSION: u32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
  /// Full-resolution demosaic.
  Full,
  /// Binned to one third (X-Trans, 3x3 cells) or one half (Bayer, 2x2) resolution: fast
  /// previews and thumbnails.
  Preview,
}

/// Development engine. Decode is shared; Adobe has its own full X-Trans/Bayer
/// demosaic, mandatory cleanup, lens corrections, colour and tone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Engine {
  /// Apple RawCamera rendering (default).
  #[default]
  Apple,
  /// Reconstructed Camera Raw 18.7 rendering with an Adobe DCP profile.
  /// RAF and ARW only; binned previews use the DNG SDK baseline renderer.
  Adobe,
}

#[derive(Clone, Debug)]
pub struct Developed {
  /// Display-oriented, display-encoded Display P3 RGB in 0-1.
  pub image: RgbImage,
  /// Scene-linear Display P3 before the look (same geometry as the sensor crop, not
  /// oriented), when requested.
  pub linear: Option<RgbImage>,
  pub info: DevelopInfo,
}

#[derive(Clone, Debug)]
pub struct DevelopInfo {
  pub neutral: [f64; 3],
  pub cct: f64,
  pub exposure_ev: f64,
  pub luma_nr: f32,
}

pub struct Options {
  pub quality: Quality,
  /// Keep the scene-linear intermediate in `Developed::linear`.
  pub keep_linear: bool,
  /// Cooperative cancellation: `develop` returns `Error::Cancelled` at the next stage
  /// boundary (or streamed luma step) after it is set. Never cancels by default.
  pub cancel: crate::Cancel,
  /// Colour and tone back end.
  pub engine: Engine,
  /// Directory holding Adobe DCP profiles for `Engine::Adobe`; falls back to the
  /// `ADOBE_PROFILE_DIR` environment variable.
  pub adobe_profile_dir: Option<std::path::PathBuf>,
}

impl Default for Options {
  fn default() -> Self {
    Self {
      quality: Quality::Full,
      keep_linear: false,
      cancel: crate::Cancel::never(),
      engine: Engine::Apple,
      adobe_profile_dir: None,
    }
  }
}

pub fn develop(neg: &Negative, settings: &DevelopSettings, opts: &Options) -> Result<Developed> {
  prepare(neg, settings, opts)?.into_developed(settings, opts)
}

/// Prepare an owned working image for repeated exposure, tone and geometry edits.
///
/// RAF/ARW stop after highlight recovery; DNG stops before exposure-dependent detail.
/// Without resizing, `prepare(...).render(...)` is bit-identical to `develop(...)`.
pub fn prepare(neg: &Negative, settings: &DevelopSettings, opts: &Options) -> Result<Prepared> {
  settings.validate()?;
  let cancel = &opts.cancel;
  cancel.check()?;
  if let Some((info, rgb)) = &neg.dng {
    if opts.engine == Engine::Adobe {
      return Err(crate::Error::Unsupported(
        "Adobe engine supports RAF and ARW only".into(),
      ));
    }
    return prepare_dng(neg, info, rgb, settings, opts);
  }
  let meta = &neg.meta;
  let profile = CameraProfile::builtin(&meta.model)?;
  let adobe_dcp = match opts.engine {
    Engine::Adobe => {
      let dir = crate::adobe::profile_dir(opts.adobe_profile_dir.as_deref())?;
      let path = crate::adobe::dcp::Dcp::find_adobe_standard(&dir, &meta.make, &meta.model)?;
      crate::adobe::baseline_exposure(meta)?;
      Some(crate::adobe::dcp::Dcp::open(&path)?)
    }
    Engine::Apple => None,
  };

  let noise = profile.noise_for_iso(meta.iso);

  // White balance: as-shot multipliers (R, 1, B) from the file.
  let as_shot = meta.as_shot_wb;
  let neutral = match settings.white_balance {
    WhiteBalance::AsShot => [1.0 / as_shot[0], 1.0, 1.0 / as_shot[2]],
    WhiteBalance::Temperature { kelvin, tint } => profile.neutral_for_temperature(kelvin, tint),
  };
  let neutral = if adobe_dcp.is_some() {
    // Adobe's demosaic cleanup uses the recorded sensor neutral. Requested
    // temperature/tint is applied later by its own colour specification.
    crate::adobe::xtrans::rounded_neutral([1.0 / as_shot[0], 1.0, 1.0 / as_shot[2]])
  } else {
    neutral
  };
  let wb = [1.0 / neutral[0], 1.0, 1.0 / neutral[2]];

  // 1-2. Linearise and white balance the active area. For Preview the crop origin is
  // snapped down to a multiple of the binning cell (3 for X-Trans, 2 for Bayer).
  let bin = demosaic::bin_size(&meta.cfa);
  let (top, left) = match opts.quality {
    Quality::Full => (meta.crop_top, meta.crop_left),
    Quality::Preview => (meta.crop_top / bin * bin, meta.crop_left / bin * bin),
  };
  let (w, h) = (
    meta.crop_width + (meta.crop_left - left),
    meta.crop_height + (meta.crop_top - top),
  );
  let adobe = adobe_dcp.is_some();
  // Adobe normalises with the file's white level (2^bits - 1 when absent) and keeps
  // negative values after black subtraction; RawCamera clips at its own level.
  let white = if adobe {
    crate::adobe::white_level(meta)
  } else {
    profile.white_level
  };
  // The linearised plane is only an input to the generic demosaics; the RawCamera ports
  // read the raw mosaic directly, so it is built lazily.
  let cfa = meta.cfa.shifted(top, left);
  let linearise = || {
    let mut lin = vec![0.0f32; w * h];
    lin.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
      let sy = y + top;
      for (x, out) in row.iter_mut().enumerate() {
        let sx = x + left;
        let ch = meta.cfa.at(sy, sx) as usize;
        let black = meta.black_at(sy, sx) as f32;
        let v = (neg.sample(sy, sx) as f32 - black) / (white - black);
        *out = v * wb[ch] as f32;
      }
    });
    lin
  };

  // 3-4. Demosaic and crop to the exact active area.
  let (mut img, scale) = match opts.quality {
    Quality::Full => {
      let d = match noise {
        // The Adobe engine does not use RawCamera's NR-integrated demosaics.
        _ if adobe && meta.cfa.is_xtrans() => {
          Some(crate::adobe::xtrans::develop_preserved_with_lens(
            neg, neutral,
            true, // Embedded CA is mandatory; AutoLateralCA is a separate Adobe control.
            cancel,
          )?)
        }
        _ if adobe => Some(crate::adobe::bayer::develop_unbalanced_active(
          neg, true, cancel,
        )?),
        Some(n) if meta.cfa.is_xtrans() => full_dextrans(neg, profile.white_level, wb, n),
        Some(n) => full_debayer(neg, &profile, wb, n, cancel)?,
        None => None,
      };
      let d = d.unwrap_or_else(|| {
        let lin = linearise();
        let mosaic = demosaic::Mosaic {
          width: w,
          height: h,
          data: &lin,
          cfa: &cfa,
        };
        let mut d = demosaic::full(&mosaic);
        demosaic::refine_luma_chroma(&mosaic, &mut d, 1);
        d
      });
      (d, 1.0f32)
    }
    Quality::Preview => {
      let lin = linearise();
      let mosaic = demosaic::Mosaic {
        width: w,
        height: h,
        data: &lin,
        cfa: &cfa,
      };
      let b = demosaic::binned(&mosaic);
      // Binned origin is the snapped origin; drop the partial leading cell offset.
      let (dx, dy) = ((meta.crop_left - left) / bin, (meta.crop_top - top) / bin);
      let (bw, bh) = (meta.crop_width / bin, meta.crop_height / bin);
      (
        b.crop(dx, dy, bw.min(b.width - dx), bh.min(b.height - dy)),
        1.0 / bin as f32,
      )
    }
  };

  cancel.check()?;
  // 5. Noise reduction (white-balanced camera space): RawCamera's chroma NR and luma
  // pyramid when the profile has a noise table for this ISO, else the generic filters.
  let mut luma_nr = settings.luma_noise_reduction.unwrap_or(0.0);
  // Adobe NR runs after its own camera-to-RIMM transform below.
  let noise = if adobe { None } else { noise };
  match noise {
    _ if adobe => {}
    Some(n) if opts.quality == Quality::Full => {
      let default = luma::default_lnr(&n.luma);
      luma_nr = settings.luma_noise_reduction.unwrap_or(default);
      chroma_nr::apply(
        &mut img,
        wb.map(|v| v as f32),
        n,
        settings.chroma_noise_reduction,
        Some(luma::Amounts {
          lnr: luma_nr,
          sharpness: settings.sharpening,
        }),
        cancel,
      )?;
    }
    _ => {
      if settings.luma_noise_reduction.is_none() {
        luma_nr = detail::default_luma_nr(meta.iso);
      }
      if let Some(n) = noise {
        chroma_nr::apply(
          &mut img,
          wb.map(|v| v as f32),
          n,
          settings.chroma_noise_reduction,
          None,
          cancel,
        )?;
      }
      detail::apply(
        &mut img,
        &detail::DetailParams {
          luma_nr,
          chroma_nr: if noise.is_some() {
            0.0
          } else {
            settings.chroma_noise_reduction
          },
          sharpen: 0.0,
          scale,
          noise: detail::noise_level(meta.iso, profile.base_iso),
        },
      );
    }
  }

  cancel.check()?;
  // 6. Lens correction.
  let lc = LensCorrection::from_source(&meta.lens, profile.distortion_fill_scale);
  let l = &settings.lens;
  // Full Adobe paths own their lens stages. In particular, normal Sony Adobe
  // rendering does not apply the embedded distortion curve used by RawCamera;
  // its optional correction requires an external LCP.
  let adobe_full = adobe && opts.quality == Quality::Full;
  if !adobe_full && !lc.is_identity() && (l.distortion || l.chromatic_aberration || l.vignetting) {
    img = lc.apply(
      &img,
      (l.distortion, !adobe && l.chromatic_aberration, l.vignetting),
    );
  }

  cancel.check()?;
  // 7. Highlights: channels clip at wb[c] in balanced units.
  if settings.highlight_recovery && !(adobe && opts.quality == Quality::Full) {
    highlights::recover(&mut img, highlights::thresholds(wb.map(|v| v as f32)));
  }

  cancel.check()?;
  if let Some(dcp) = &adobe_dcp {
    let luma_nr = settings
      .adobe_noise_reduction
      .as_ref()
      .map_or(luma_nr, |nr| f32::from(nr.luminance) * 0.01);
    let mut render = crate::adobe::AdobeRender::new(
      dcp,
      meta,
      neutral,
      luma_nr,
      &settings.white_balance,
      opts.quality == Quality::Full,
    )?;
    render.prepare_camera(&mut img, dcp, meta, settings, cancel)?;
    if opts.quality == Quality::Full && !meta.cfa.is_xtrans() {
      img = img.crop(
        meta.crop_left,
        meta.crop_top,
        meta.crop_width,
        meta.crop_height,
      );
    }
    return Ok(Prepared::new(
      img,
      settings,
      opts,
      meta.orientation,
      RenderPipeline::Adobe(Box::new(render)),
    ));
  }
  let (matrix, cct) = profile.balanced_camera_to_display_p3(neutral);
  Ok(Prepared::new(
    img,
    settings,
    opts,
    meta.orientation,
    RenderPipeline::Mosaic(MosaicRender {
      matrix: matrix.to_f32(),
      black_render: profile.black_render,
      baseline_exposure: profile.baseline_exposure - meta.raw_exposure_bias.unwrap_or(0.0),
      neutral,
      cct,
      luma_nr,
      sharpen_scale: (noise.is_none() || opts.quality != Quality::Full).then_some(scale),
    }),
  ))
}

/// Full-resolution X-Trans demosaic (RawCamera's deXtrans_v8 port) of the active area,
/// returned white-balanced like the rest of the pipeline expects.
fn full_dextrans(
  neg: &Negative,
  white: f32,
  wb: [f64; 3],
  noise: &crate::profile::NoiseIso,
) -> Option<RgbImage> {
  let meta = &neg.meta;
  let black = meta.mean_black();
  // RawCamera's exposureFactor (only gates the demosaic noise mixer in deep shadows)
  // tracks its baseline exposure, -RawExposureBias - 0.5; fitted log-linear relation.
  let be = -meta.raw_exposure_bias.unwrap_or(-0.72) - 0.5;
  let prm = dextrans::Params {
    black: black / 65535.0,
    range: 65535.0 / (white - black),
    rn: noise.demosaic_noise,
    exposure_factor: 2f64.powf(1.0146 + 0.452 * be) as f32,
    wb: wb.map(|v| v as f32),
  };
  let mut img = dextrans::demosaic(
    &neg.mosaic,
    meta.raw_width,
    meta.raw_height,
    &meta.cfa,
    (
      meta.crop_left,
      meta.crop_top,
      meta.crop_width,
      meta.crop_height,
    ),
    &prm,
  )?;
  let wbf = wb.map(|v| v as f32);
  img.map_pixels(|p| [p[0] * wbf[0], p[1] * wbf[1], p[2] * wbf[2]]);
  Some(img)
}

/// DNG preparation retains cropped linear camera RGB before detail: the detail
/// graph takes the exposure gain and cannot be cached across exposure changes.
fn prepare_dng(
  neg: &Negative,
  info: &crate::dng::DngInfo,
  rgb: &[f32],
  settings: &DevelopSettings,
  opts: &Options,
) -> Result<Prepared> {
  let neutral = match settings.white_balance {
    WhiteBalance::AsShot => info.as_shot_neutral,
    WhiteBalance::Temperature { .. } => {
      return Err(crate::Error::Unsupported(
        "kelvin white balance for DNG files is not implemented yet".into(),
      ));
    }
  };
  let meta = &neg.meta;
  let (w, h) = (meta.raw_width, meta.raw_height);
  let mut img = RgbImage {
    width: w,
    height: h,
    data: rgb.to_vec(),
  };
  if (
    meta.crop_left,
    meta.crop_top,
    meta.crop_width,
    meta.crop_height,
  ) != (0, 0, w, h)
  {
    img = img.crop(
      meta.crop_left,
      meta.crop_top,
      meta.crop_width,
      meta.crop_height,
    );
  }
  if opts.quality == Quality::Preview {
    img = img.downscale(2);
  }
  opts.cancel.check()?;
  let (c2x, cct) = info.camera_to_xyz_d50(neutral);
  Ok(Prepared::new(
    img,
    settings,
    opts,
    meta.orientation,
    RenderPipeline::Dng(Box::new(DngRender {
      matrix: crate::math::XYZ_D50_TO_LINEAR_P3.mul(&c2x).to_f32(),
      baseline_exposure: info.baseline_exposure,
      neutral,
      cct,
      gain_table_map: info.gain_table_map.clone(),
      tone: crate::stages::dng_look::ToneLut::from_curve(&info.tone_curve),
    })),
  ))
}

/// Full-resolution Bayer demosaic (RawCamera's despeckle_v8 + deBayer_v8 ports) of the
/// active area, white-balanced.
fn full_debayer(
  neg: &Negative,
  profile: &CameraProfile,
  wb: [f64; 3],
  noise: &crate::profile::NoiseIso,
  cancel: &crate::Cancel,
) -> Result<Option<RgbImage>> {
  let meta = &neg.meta;
  let black = meta.mean_black();
  let (mw, mh) = (meta.raw_width, meta.raw_height);
  let raw: Vec<f32> = neg
    .mosaic
    .par_iter()
    .map(|&v| v as f32 * (1.0 / 65535.0))
    .collect();
  let src = match noise.despeckle {
    Some([amount, prevention]) => debayer::despeckle(&raw, mw, mh, &meta.cfa, amount, prevention),
    None => raw,
  };
  cancel.check()?;
  let prm = debayer::Params {
    black: black / 65535.0,
    range: 65535.0 / (profile.white_level - black),
    rn: noise.demosaic_noise,
    exposure_factor: profile.demosaic_exposure_factor.unwrap_or(2.0),
  };
  let Some(mut img) = debayer::demosaic(
    &src,
    mw,
    mh,
    &meta.cfa,
    (
      meta.crop_left,
      meta.crop_top,
      meta.crop_width,
      meta.crop_height,
    ),
    &prm,
  ) else {
    return Ok(None);
  };
  let wbf = wb.map(|v| v as f32);
  img.map_pixels(|p| [p[0] * wbf[0], p[1] * wbf[1], p[2] * wbf[2]]);
  Ok(Some(img))
}
