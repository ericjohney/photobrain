//! Adobe CR6 user noise-reduction building blocks.
//!
//! The runtime chain flattens sensor noise, converts RGB to an optimized YCC
//! basis, filters chroma and four luminance levels independently, and reverses
//! both transforms after recombining the filtered channels.

pub(crate) mod noise;

pub(crate) mod params;
pub(crate) mod space;

pub(crate) mod luma;
pub(crate) mod spatial;

use crate::{Cancel, Result, image::RgbImage};
use rayon::prelude::*;

/// Preserved-black RIMM -> preserved-black RIMM. Tile origins stay on the even
/// low-pass lattice, including at odd image dimensions. Only tile-sized scratch
/// planes are allocated by each worker; the source is published after success.
pub(crate) fn apply(
  image: &mut RgbImage,
  params: &params::Parameters,
  cancel: &Cancel,
) -> Result<()> {
  apply_tiled(image, params, cancel, 192)
}

fn apply_tiled(
  image: &mut RgbImage,
  params: &params::Parameters,
  cancel: &Cancel,
  tile: usize,
) -> Result<()> {
  cancel.check()?;
  if image.width == 0 || image.height == 0 {
    return Ok(());
  }
  let lattice = if params.luma.is_some() { 8 } else { 2 };
  assert!(tile > 0 && tile % lattice == 0);
  let space = space::Space::new(&params.curve, params.ycc, params.inverse_ycc, 0.25);
  let (width, height) = (image.width, image.height);
  let halo = if params.luma.is_some() {
    params.spatial.halo().max(luma::HALO).div_ceil(8) * 8
  } else {
    params.spatial.halo()
  };
  let mut output = RgbImage::new(width, height);
  output
    .data
    .par_chunks_mut(width * 3 * tile)
    .enumerate()
    .try_for_each(|(ty, strip)| -> Result<()> {
      let top = ty * tile;
      let oh = (height - top).min(tile);
      for left in (0..width).step_by(tile) {
        cancel.check()?;
        let ow = (width - left).min(tile);
        let (tw, th) = (ow + 2 * halo, oh + 2 * halo);
        let mut encoded = Vec::with_capacity(tw * th);
        for y in 0..th {
          let sy =
            (top as isize + y as isize - halo as isize).clamp(0, height as isize - 1) as usize;
          for x in 0..tw {
            let sx =
              (left as isize + x as isize - halo as isize).clamp(0, width as isize - 1) as usize;
            encoded.push(space.encode(image.px(sx, sy)));
          }
        }
        let area = [halo, halo, halo + oh, halo + ow];
        let mut filtered = if params.color_enabled {
          spatial::filter_tile(&encoded, tw, th, area, &params.spatial)
        } else {
          (halo..halo + oh)
            .flat_map(|y| encoded[y * tw + halo..y * tw + halo + ow].iter().copied())
            .collect()
        };
        if let Some(luma) = &params.luma {
          let luminance = luma::filter_tile(&encoded, tw, th, area, luma);
          for (pixel, y) in filtered.iter_mut().zip(luminance) {
            pixel[0] = y;
          }
        }
        for y in 0..oh {
          for x in 0..ow {
            let dst = (y * width + left + x) * 3;
            strip[dst..dst + 3].copy_from_slice(&space.decode(filtered[y * ow + x]));
          }
        }
      }
      Ok(())
    })?;
  cancel.check()?;
  *image = output;
  Ok(())
}

#[cfg(test)]
mod tests;
