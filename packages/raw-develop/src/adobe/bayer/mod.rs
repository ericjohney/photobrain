//! Adobe 18.7 Sony Bayer base processing, independent of the user NR sliders.
//!
//! The input/output u16 boundaries, log LUTs, hot/cold-pixel suppression,
//! green-split correction and directional interpolation follow the observed CPU
//! pipeline. Bounded tiles keep the intermediate planes off the full readout.

mod balance;
pub(crate) mod calibration;
mod core;
mod default_color;
mod hotpixel;
pub(crate) mod noise;
mod paired_hotpixel;
pub(crate) mod tables;
#[cfg(test)]
mod tests;

use crate::error::{Error, Result};
use crate::image::RgbImage;
use crate::{Cancel, Negative};
use rayon::prelude::*;
use tables::{code, normalized};

const TILE: usize = 192;
const HALO: usize = 32;

struct Parameters {
  gain: [(f32, f32); 3],
  inverse_gain: [(f32, f32); 3],
  encode: Vec<u16>,
  decode: Vec<u16>,
  balance: balance::Parameters,
  core: core::Parameters,
  noise: Option<(noise::Noise, Vec<u16>, Vec<u16>)>,
  paired_hotpixel: Option<paired_hotpixel::Parameters>,
  hot_threshold: u16,
  cold_threshold: u16,
}

impl Parameters {
  fn new(neg: &Negative) -> Result<Self> {
    let meta = &neg.meta;
    let ratio = match meta.model.as_str() {
      "ILCE-1M2" => 1.02,
      "ILCE-7CR" | "ILCE-7RM5" => 1.03,
      _ => {
        return Err(Error::Unsupported(format!(
          "Adobe Bayer: no sensor calibration for {}",
          meta.model
        )));
      }
    };
    if !(8..=16).contains(&meta.bits_per_sample) {
      return Err(Error::Unsupported(
        "Adobe Bayer: unsupported bit depth".into(),
      ));
    }
    let black = meta.black_levels.first().copied().unwrap_or(0);
    if meta.black_levels.iter().any(|&v| v != black) || black as u32 >= 1 << meta.bits_per_sample {
      return Err(Error::Unsupported(
        "Adobe Bayer: nonuniform or invalid black calibration".into(),
      ));
    }
    let black = ((black as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let calibration = calibration::camera_calibration(&meta.model, meta.sony_daylight_wb);
    let gains = default_color::gains(&meta.model, calibration)?;
    let iso = meta.iso.filter(|&v| v > 0).unwrap_or(100);
    let noise = noise::Noise::new(&meta.model, iso, black).unwrap();
    let noise = (noise.normalization() * 65535.0 > 1000.0).then(|| {
      let encode = tables::expand(|x| noise.encode(tables::log_decode(x, black)));
      let decode = tables::expand(|x| tables::log_encode(noise.decode(x), black));
      (noise, encode, decode)
    });
    let core = core::Parameters::from_detail_factor((0.6 * (iso as f64 / 100.0).sqrt()) as f32);
    let paired_hotpixel = if meta.exposure_time.is_none_or(|v| v >= 2.0) {
      Some(paired_hotpixel::Parameters::new(
        meta.exposure_time.unwrap_or(4.0),
      ))
    } else {
      None
    };
    let (hot_threshold, cold_threshold) = match meta.exposure_time {
      Some(v) if v > 60.0 => (500, 500),
      Some(v) if v >= 2.0 => (950, 950),
      _ => (8000, 6000),
    };
    Ok(Self {
      gain: gains.map(|v| affine(v, black)),
      inverse_gain: gains.map(|v| affine(1.0 / v, black)),
      encode: tables::expand(|x| tables::log_encode(x, black)),
      decode: tables::expand(|x| tables::log_decode(x, black)),
      balance: balance::Parameters {
        min_ratio: 1.0 / ratio,
        max_ratio: ratio,
      },
      core,
      noise,
      paired_hotpixel,
      hot_threshold,
      cold_threshold,
    })
  }

  /// Same-size tile with an undefined outer halo. Coordinates are canonical RGGB.
  fn process(&self, src: &[f32], width: usize, height: usize, top: isize, left: isize) -> RgbImage {
    let mut encoded = Vec::with_capacity(src.len());
    for y in 0..height {
      for x in 0..width {
        let c = channel(top + y as isize, left + x as isize);
        let (gain, add) = self.gain[c];
        encoded.push(self.encode[code(src[y * width + x].mul_add(gain, add)) as usize]);
      }
    }
    let encoded = if let Some(parameters) = &self.paired_hotpixel {
      paired_hotpixel::suppress(&encoded, width, height, top, left, parameters)
    } else {
      encoded
    };
    let repaired = hotpixel::suppress(
      &encoded,
      width,
      height,
      top,
      left,
      self.hot_threshold,
      self.cold_threshold,
    );
    let src: Vec<_> = repaired.into_iter().map(normalized).collect();
    let mut balanced = balance::apply(&src, width, height, top, left, self.balance);
    if let Some((noise, encode, decode)) = &self.noise {
      tables::apply(&mut balanced, encode);
      balanced = balance::apply_encoded(
        &balanced,
        width,
        height,
        top,
        left,
        -0.5 * noise.normalization(),
        0.5 * noise.normalization(),
      );
      tables::apply(&mut balanced, decode);
    }
    let mut out = core::demosaic(&balanced, width, height, top, left, &self.core);
    out.map_pixels(|p| {
      std::array::from_fn(|c| {
        if !p[c].is_finite() {
          return f32::NAN;
        }
        let linear = normalized(self.decode[code(p[c]) as usize]);
        let (gain, add) = self.inverse_gain[c];
        normalized(code(linear.mul_add(gain, add).clamp(0.0, 1.0)))
      })
    });
    out
  }

  fn halo(&self) -> usize {
    2 + 7
      + if self.noise.is_some() { 7 } else { 0 }
      + self.core.halo()
      + if self.paired_hotpixel.is_some() { 5 } else { 0 }
  }
}

#[inline]
fn channel(y: isize, x: isize) -> usize {
  if (y + x).rem_euclid(2) == 1 {
    1
  } else if y.rem_euclid(2) == 0 {
    0
  } else {
    2
  }
}

fn phase_origin(neg: &Negative) -> Result<(usize, usize)> {
  let cfa = &neg.meta.cfa;
  if cfa.width == 2 && cfa.height == 2 {
    for y in 0..2 {
      for x in 0..2 {
        if (0..2).all(|dy| {
          (0..2).all(|dx| cfa.at(y + dy, x + dx) as usize == channel(dy as isize, dx as isize))
        }) {
          return Ok((y, x));
        }
      }
    }
  }
  Err(Error::Unsupported(
    "Adobe Bayer: unsupported CFA phase".into(),
  ))
}

// Preserve the two fused affine boundaries and the separately rounded f32
// intermediates used by cr_stage_bayer_gain, including the preserved black.
fn affine(gain: f64, black: f64) -> (f32, f32) {
  let b = black as f32;
  let s = -1.0 / (b - 1.0);
  let a = (0.0 - b * s) / s;
  let z = (s * b) / s;
  let gain = gain as f32;
  (gain, gain.mul_add(a, z))
}

/// Preserved-black camera RGB for the modern Adobe renderer, at DefaultCrop.
pub(crate) fn develop_unbalanced(
  neg: &Negative,
  correct_ca: bool,
  cancel: &Cancel,
) -> Result<RgbImage> {
  let parameters = Parameters::new(neg)?;
  develop_preserved_with_lens(neg, &parameters, correct_ca, cancel)
}

/// Keep the active sensor boundary through spatial NR. Sony DefaultCrop can
/// start off the eight-pixel CR6 lattice and its border needs outside pixels.
pub(crate) fn develop_unbalanced_active(
  neg: &Negative,
  correct_ca: bool,
  cancel: &Cancel,
) -> Result<RgbImage> {
  let parameters = Parameters::new(neg)?;
  let (width, height) = active_size(neg)?;
  let active = develop_area(neg, &parameters, [0, 0, height, width], cancel)?;
  if correct_ca && let Some(warp) = super::lens::embedded_ca(&neg.meta, None)? {
    return warp.apply_crop(&active, [0, 0, height, width], cancel);
  }
  Ok(active)
}

fn develop_preserved(neg: &Negative, parameters: &Parameters, cancel: &Cancel) -> Result<RgbImage> {
  let meta = &neg.meta;
  develop_area(
    neg,
    parameters,
    [
      meta.crop_top,
      meta.crop_left,
      meta.crop_height,
      meta.crop_width,
    ],
    cancel,
  )
}

fn develop_preserved_with_lens(
  neg: &Negative,
  parameters: &Parameters,
  correct_ca: bool,
  cancel: &Cancel,
) -> Result<RgbImage> {
  if correct_ca && let Some(warp) = super::lens::embedded_ca(&neg.meta, None)? {
    let (width, height) = active_size(neg)?;
    let active = develop_area(neg, parameters, [0, 0, height, width], cancel)?;
    let meta = &neg.meta;
    return warp.apply_crop(
      &active,
      [
        meta.crop_top,
        meta.crop_left,
        meta.crop_height,
        meta.crop_width,
      ],
      cancel,
    );
  }
  develop_preserved(neg, parameters, cancel)
}

fn develop_area(
  neg: &Negative,
  parameters: &Parameters,
  area: [usize; 4],
  cancel: &Cancel,
) -> Result<RgbImage> {
  cancel.check()?;
  let meta = &neg.meta;
  let (py, px) = phase_origin(neg)?;
  let halo = HALO.max(parameters.halo());
  let (sensor_width, sensor_height) = active_size(neg)?;
  let black = meta.black_levels[0];
  let white = super::white_level(meta) as f64;
  if white <= black as f64 {
    return Err(Error::Unsupported(
      "Adobe Bayer: invalid white level".into(),
    ));
  }
  let lut = super::linearize::table(black, white, meta.bits_per_sample);
  let [area_top, area_left, h, w] = area;
  let mut img = RgbImage::new(w, h);
  img
    .data
    .par_chunks_mut(w * 3 * TILE)
    .enumerate()
    .try_for_each(|(ty, strip)| -> Result<()> {
      let oh = (h - ty * TILE).min(TILE);
      for tx in (0..w).step_by(TILE) {
        cancel.check()?;
        let ow = (w - tx).min(TILE);
        let (tw, th) = (ow + 2 * halo, oh + 2 * halo);
        let top = (area_top + ty * TILE) as isize - halo as isize;
        let left = (area_left + tx) as isize - halo as isize;
        let mut input = vec![0.0; tw * th];
        for y in 0..th {
          let sy = repeat(top + y as isize, sensor_height);
          for x in 0..tw {
            let sx = repeat(left + x as isize, sensor_width);
            input[y * tw + x] = lut[neg.sample(sy, sx) as usize];
          }
        }
        let tile = parameters.process(&input, tw, th, top - py as isize, left - px as isize);
        for y in 0..oh {
          let src = ((y + halo) * tw + halo) * 3;
          let dst = (y * w + tx) * 3;
          strip[dst..dst + ow * 3].copy_from_slice(&tile.data[src..src + ow * 3]);
        }
      }
      Ok(())
    })?;
  Ok(img)
}

// dng_image::Get(edge_repeat,2,2) keeps the two Bayer populations separate.
fn repeat(value: isize, length: usize) -> usize {
  if value < 0 {
    value.rem_euclid(2) as usize
  } else if value >= length as isize {
    length - 1 - (length as isize - 1 - value).rem_euclid(2) as usize
  } else {
    value as usize
  }
}

/// ReadSony3x0 selects these active rectangles before interpolation. Stored
/// lossless-JPEG tile dimensions include padding, and SonyRawImageSize is not
/// the boundary used by the converter for these models.
fn active_size(neg: &Negative) -> Result<(usize, usize)> {
  let meta = &neg.meta;
  let size = match (meta.model.as_str(), meta.sony_raw_format, meta.raw_width) {
    ("ILCE-1M2", Some(0 | 2), 8672) | ("ILCE-1M2", Some(4), 8704) => (8662, 5782),
    ("ILCE-1M2", Some(0 | 2), 5664) => (5664, 3768),
    ("ILCE-1M2", Some(4), 6144) => (5638, 3768),
    ("ILCE-7CR" | "ILCE-7RM5", Some(0 | 2), 9600) => (9566, meta.raw_height),
    ("ILCE-7CR" | "ILCE-7RM5", Some(0 | 2), 6304) => (6270, meta.raw_height),
    ("ILCE-7CR" | "ILCE-7RM5", Some(4), 9728) => (9570, 6376),
    ("ILCE-7CR" | "ILCE-7RM5", Some(4), 6656) => (6270, 4180),
    _ => {
      return Err(Error::Unsupported(format!(
        "Adobe Bayer: unsupported readout geometry for {} ({}x{}, format {:?})",
        meta.model, meta.raw_width, meta.raw_height, meta.sony_raw_format
      )));
    }
  };
  if size.0 > meta.raw_width
    || size.1 > meta.raw_height
    || meta.crop_left + meta.crop_width > size.0
    || meta.crop_top + meta.crop_height > size.1
  {
    return Err(Error::Malformed(
      "Adobe Bayer: crop exceeds active sensor bounds".into(),
    ));
  }
  Ok(size)
}
