//! Sensor-data unpackers. Each produces a full readout-size `u16` mosaic.

pub mod bitreader;
pub mod fuji_compressed;
mod uncompressed;

use crate::error::Result;
use crate::raf::{RafMetadata, RawStorage};

/// Decode the sensor mosaic described by `meta` from the complete file `data`.
pub fn unpack(data: &[u8], meta: &RafMetadata) -> Result<Vec<u16>> {
  match meta.storage {
    RawStorage::FujiCompressed { offset, length } => {
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
      &data[offset..offset + length],
      meta.raw_width,
      meta.raw_height,
      meta.bits_per_sample,
    ),
  }
}
