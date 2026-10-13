//! Sensor-data unpackers. Each produces a full readout-size `u16` mosaic.

pub mod bitreader;
pub mod fuji_compressed;
pub mod ljpeg;
mod uncompressed;

use crate::error::Result;
use crate::metadata::{RawMetadata, RawStorage};

/// Decode the sensor mosaic described by `meta` from the complete file `data`.
pub fn unpack(data: &[u8], meta: &RawMetadata) -> Result<Vec<u16>> {
  match &meta.storage {
    RawStorage::FujiCompressed { offset, length } => {
      let (offset, length) = (*offset, *length);
      let (header, mosaic) = fuji_compressed::decode(&data[offset..offset + length], &meta.cfa)?;
      if header.raw_width != meta.raw_width || header.raw_height != meta.raw_height {
        return Err(crate::Error::Malformed(format!(
          "compressed size {}x{} disagrees with FujiIFD {}x{}",
          header.raw_width, header.raw_height, meta.raw_width, meta.raw_height
        )));
      }
      Ok(mosaic)
    }
    RawStorage::Uncompressed { offset, length } => uncompressed::decode(
      &data[*offset..*offset + *length],
      meta.raw_width,
      meta.raw_height,
      meta.bits_per_sample,
    ),
    RawStorage::LosslessJpegTiles {
      tiles,
      tile_width,
      tile_height,
    } => ljpeg_tiles(data, tiles, *tile_width, *tile_height, meta.raw_width, meta.raw_height),
    RawStorage::SonyCompressed { .. } => Err(
      crate::Error::Unsupported(format!("{:?} storage not implemented yet", meta.container)),
    ),
  }
}

/// Assemble a mosaic from lossless JPEG tiles laid out row-major over the image.
///
/// A tile of `tile_width x tile_height` pixels may be encoded as an LJ92 frame of any
/// shape with the same sample count: Sony codes a 2x2 CFA block per 4-component sample
/// (frame `w/2 x h/2`, components 0-1 on the even row, 2-3 on the odd row); DNG codes a
/// 2-component frame as `w/2` wide. Samples outside the image are discarded.
fn ljpeg_tiles(
  data: &[u8],
  tiles: &[(usize, usize)],
  tw: usize,
  th: usize,
  width: usize,
  height: usize,
) -> Result<Vec<u16>> {
  use rayon::prelude::*;
  let across = width.div_ceil(tw);
  let down = height.div_ceil(th);
  if tiles.len() < across * down {
    return Err(crate::Error::Malformed(format!(
      "{} tiles for a {across}x{down} grid",
      tiles.len()
    )));
  }
  let decoded: Vec<Vec<u16>> = tiles[..across * down]
    .par_iter()
    .map(|&(off, len)| -> Result<Vec<u16>> {
      let bytes = off
        .checked_add(len)
        .and_then(|e| data.get(off..e))
        .ok_or_else(|| crate::Error::Malformed("tile past end of file".into()))?;
      let (f, s) = ljpeg::decode(bytes)?;
      let fw = f.width * f.components;
      if fw * f.height != tw * th {
        return Err(crate::Error::Malformed(format!(
          "tile frame {}x{}x{} does not cover {tw}x{th}",
          f.width, f.height, f.components
        )));
      }
      if fw == tw {
        return Ok(s);
      }
      if fw % tw != 0 || f.components % (fw / tw) != 0 {
        return Err(crate::Error::Unsupported(format!(
          "tile frame layout {}x{}x{}",
          f.width, f.height, f.components
        )));
      }
      // fw = k * tw: each sample's components are split over k output rows.
      let k = fw / tw;
      let per_row = f.components / k;
      let mut out = vec![0u16; tw * th];
      for fy in 0..f.height {
        for fx in 0..f.width {
          for c in 0..f.components {
            let (sub, cc) = (c / per_row, c % per_row);
            out[(fy * k + sub) * tw + fx * per_row + cc] = s[fy * fw + fx * f.components + c];
          }
        }
      }
      Ok(out)
    })
    .collect::<Result<_>>()?;
  let mut mosaic = vec![0u16; width * height];
  mosaic.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
    let ty = y / th;
    for tx in 0..across {
      let t = &decoded[ty * across + tx];
      let x0 = tx * tw;
      let n = tw.min(width - x0);
      let src = &t[(y - ty * th) * tw..(y - ty * th) * tw + n];
      row[x0..x0 + n].copy_from_slice(src);
    }
  });
  Ok(mosaic)
}
