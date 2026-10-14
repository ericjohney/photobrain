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
//! LinearRaw DNGs (Apple ProRAW) branch to `develop_dng`: detail, highlight recovery,
//! DNG colour, exposure, gain table map, gamut map and the `ProfileToneCurve` LUT.
//!
//! `develop` is a pure function of a `Negative` and `DevelopSettings`.

use crate::Negative;
use crate::error::Result;
use crate::image::RgbImage;
use crate::math::srgb_encode;
use crate::profile::CameraProfile;
use crate::settings::{DevelopSettings, WhiteBalance};
use crate::stages::{
  chroma_nr, debayer, demosaic, detail, dextrans, highlights, lens::LensCorrection, look, luma,
};
use rayon::prelude::*;

/// Bumped whenever developed output changes for the same input and settings.
pub const PIPELINE_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
  /// Full-resolution demosaic.
  Full,
  /// Binned to one third (X-Trans, 3x3 cells) or one half (Bayer, 2x2) resolution: fast
  /// previews and thumbnails.
  Preview,
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
}

impl Default for Options {
  fn default() -> Self {
    Self {
      quality: Quality::Full,
      keep_linear: false,
    }
  }
}

pub fn develop(neg: &Negative, settings: &DevelopSettings, opts: &Options) -> Result<Developed> {
  settings.validate()?;
  if let Some((info, rgb)) = &neg.dng {
    return develop_dng(neg, info, rgb, settings, opts);
  }
  let meta = &neg.meta;
  let profile = CameraProfile::builtin(&meta.model)?;

  let noise = profile.noise_for_iso(meta.iso);

  // White balance: as-shot multipliers (R, 1, B) from the file.
  let as_shot = meta.as_shot_wb;
  let neutral = match settings.white_balance {
    WhiteBalance::AsShot => [1.0 / as_shot[0], 1.0, 1.0 / as_shot[2]],
    WhiteBalance::Temperature { kelvin, tint } => profile.neutral_for_temperature(kelvin, tint),
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
  let white = profile.white_level;
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
        Some(n) if meta.cfa.is_xtrans() => full_dextrans(neg, profile.white_level, wb, n),
        Some(n) => full_debayer(neg, &profile, wb, n),
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

  // 5. Noise reduction (white-balanced camera space): RawCamera's chroma NR and luma
  // pyramid when the profile has a noise table for this ISO, else the generic filters.
  let mut luma_nr = settings.luma_noise_reduction.unwrap_or(0.0);
  match noise {
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
      );
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
        );
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

  // 6. Lens correction.
  let lc = LensCorrection::from_source(&meta.lens, profile.distortion_fill_scale);
  let l = &settings.lens;
  if !lc.is_identity() && (l.distortion || l.chromatic_aberration || l.vignetting) {
    img = lc.apply(&img, (l.distortion, l.chromatic_aberration, l.vignetting));
  }

  // 7. Highlights: channels clip at wb[c] in balanced units.
  if settings.highlight_recovery {
    highlights::recover(&mut img, highlights::thresholds(wb.map(|v| v as f32)));
  }

  // 8. Camera -> linear Display P3, exposure.
  let (m, cct) = profile.balanced_camera_to_display_p3(neutral);
  let exposure_ev =
    profile.baseline_exposure - meta.raw_exposure_bias.unwrap_or(0.0) + settings.exposure;
  let gain = 2f64.powf(exposure_ev) as f32;
  let m = m.to_f32();
  let br = profile.black_render;
  img.map_pixels(|p| {
    [
      (m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] - br) * gain,
      (m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] - br) * gain,
      (m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] - br) * gain,
    ]
  });

  // 9. Sharpening (scene-linear P3), when the luma pyramid did not already sharpen.
  if noise.is_none() || opts.quality != Quality::Full {
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

  // 10. Look.
  // The constant table lets the compiler fold the zero hue-preserve terms and the
  // segment breakpoints; the arithmetic is unchanged.
  const BOOST: look::Boost = look::Boost::RAWCAMERA;
  let amount = settings.tone_amount;
  img.map_pixels(|p| look::render(p, amount, &BOOST).map(|v| srgb_encode(v.clamp(0.0, 1.0))));

  // 11. Geometry.
  let orientation = rotate_orientation(meta.orientation, settings.quarter_turns);
  img = img.oriented(orientation);
  if let Some(c) = settings.crop {
    let x0 = (c.x * img.width as f64).round() as usize;
    let y0 = (c.y * img.height as f64).round() as usize;
    let cw = ((c.width * img.width as f64).round() as usize).clamp(1, img.width - x0);
    let ch = ((c.height * img.height as f64).round() as usize).clamp(1, img.height - y0);
    img = img.crop(x0, y0, cw, ch);
  }

  Ok(Developed {
    image: img,
    linear,
    info: DevelopInfo {
      neutral,
      cct,
      exposure_ev,
      luma_nr,
    },
  })
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

/// DNG LinearRaw (Apple ProRAW): RawCamera's "8.dng" path. The data is already
/// demosaiced; colour, exposure and tone come from the file's tags, so no camera
/// profile is used.
///
///  1. detail: luma pyramid with edge-masked sharpening + fused chroma NR (dng_detail)
///  2. highlight recovery (thresholds 1 / 0.9 / 1: the data is not white-balanced)
///  3. camera -> XYZ D50 (RAWConvert model, dng.rs) -> linear Display P3
///  4. exposure 2^BaselineExposure (+ user EV)
///  5. ProfileGainTableMap, gamut map, ProfileToneCurve (dng_look)
fn develop_dng(
  neg: &Negative,
  info: &crate::dng::DngInfo,
  rgb: &[f32],
  settings: &DevelopSettings,
  opts: &Options,
) -> Result<Developed> {
  use crate::stages::{dng_detail, dng_look};
  let meta = &neg.meta;
  let (w, h) = (meta.raw_width, meta.raw_height);
  let mut img = RgbImage {
    width: w,
    height: h,
    data: rgb.to_vec(),
  };
  if (meta.crop_left, meta.crop_top, meta.crop_width, meta.crop_height) != (0, 0, w, h) {
    img = img.crop(meta.crop_left, meta.crop_top, meta.crop_width, meta.crop_height);
  }
  if opts.quality == Quality::Preview {
    img = img.downscale(2);
  }

  let neutral = match settings.white_balance {
    WhiteBalance::AsShot => info.as_shot_neutral,
    WhiteBalance::Temperature { .. } => {
      return Err(crate::Error::Unsupported(
        "kelvin white balance for DNG files is not implemented yet".into(),
      ));
    }
  };
  let exposure_ev = info.baseline_exposure + settings.exposure;
  let gain = 2f64.powf(exposure_ev) as f32;

  // 1. Detail. RawCamera's DNG defaults: chroma NR 0.5, detail 0.5 (our sharpening 1.0).
  dng_detail::apply(
    &mut img,
    &dng_detail::Params {
      gain,
      chroma: settings.chroma_noise_reduction,
      detail: settings.sharpening * 0.5,
    },
  );

  // 2. Highlights on unbalanced data.
  if settings.highlight_recovery {
    highlights::recover(&mut img, [1.0, 0.9, 1.0]);
  }

  // 3-4. Colour and exposure.
  let (c2x, cct) = info.camera_to_xyz_d50(neutral);
  let m = crate::math::XYZ_D50_TO_LINEAR_P3.mul(&c2x).to_f32();
  img.map_pixels(|p| {
    [0, 1, 2].map(|r| (m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2]) * gain)
  });
  let linear = opts.keep_linear.then(|| img.clone());

  // 5. Look.
  let amount = settings.tone_amount;
  if let Some(gtm) = &info.gain_table_map {
    dng_look::gain_table_map(&mut img, gtm, amount);
  }
  let tone = dng_look::ToneLut::from_curve(&info.tone_curve);
  img.map_pixels(|p| {
    let g = look::gamut_map(p);
    let q = if amount >= 1.0 {
      g
    } else {
      std::array::from_fn(|k| p[k] + (g[k] - p[k]) * amount)
    };
    tone.apply(q, amount).map(|v| srgb_encode(v.clamp(0.0, 1.0)))
  });

  let orientation = rotate_orientation(meta.orientation, settings.quarter_turns);
  img = img.oriented(orientation);
  if let Some(c) = settings.crop {
    let x0 = (c.x * img.width as f64).round() as usize;
    let y0 = (c.y * img.height as f64).round() as usize;
    let cw = ((c.width * img.width as f64).round() as usize).clamp(1, img.width - x0);
    let ch = ((c.height * img.height as f64).round() as usize).clamp(1, img.height - y0);
    img = img.crop(x0, y0, cw, ch);
  }
  Ok(Developed {
    image: img,
    linear,
    info: DevelopInfo {
      neutral,
      cct,
      exposure_ev,
      luma_nr: 0.0,
    },
  })
}

/// Full-resolution Bayer demosaic (RawCamera's despeckle_v8 + deBayer_v8 ports) of the
/// active area, white-balanced.
fn full_debayer(
  neg: &Negative,
  profile: &CameraProfile,
  wb: [f64; 3],
  noise: &crate::profile::NoiseIso,
) -> Option<RgbImage> {
  let meta = &neg.meta;
  let black = meta.mean_black();
  let (mw, mh) = (meta.raw_width, meta.raw_height);
  let raw: Vec<f32> = neg.mosaic.par_iter().map(|&v| v as f32 * (1.0 / 65535.0)).collect();
  let src = match noise.despeckle {
    Some([amount, prevention]) => debayer::despeckle(&raw, mw, mh, &meta.cfa, amount, prevention),
    None => raw,
  };
  let prm = debayer::Params {
    black: black / 65535.0,
    range: 65535.0 / (profile.white_level - black),
    rn: noise.demosaic_noise,
    exposure_factor: profile.demosaic_exposure_factor.unwrap_or(2.0),
  };
  let mut img = debayer::demosaic(
    &src,
    mw,
    mh,
    &meta.cfa,
    (meta.crop_left, meta.crop_top, meta.crop_width, meta.crop_height),
    &prm,
  )?;
  let wbf = wb.map(|v| v as f32);
  img.map_pixels(|p| [p[0] * wbf[0], p[1] * wbf[1], p[2] * wbf[2]]);
  Some(img)
}

/// Compose an EXIF orientation with additional clockwise quarter turns.
fn rotate_orientation(o: u16, turns: u8) -> u16 {
  // Orientation as (rotation quarter turns clockwise, mirrored) applied to the sensor image.
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
  let rot = (rot + turns as u16) % 4;
  match (rot, mirror) {
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
