//! A decoded RAW: the sensor mosaic plus the metadata needed to develop it.
//!
//! A `Negative` is immutable and is the unit callers cache between edits; developing
//! is a pure function of a `Negative` and `DevelopSettings`.

use crate::error::Result;
use crate::raf::{self, RafMetadata};
use crate::unpack;
use std::path::Path;

pub struct Negative {
  pub meta: RafMetadata,
  /// Full readout mosaic, `meta.raw_width * meta.raw_height`, row-major.
  pub mosaic: Vec<u16>,
}

impl Negative {
  pub fn open(path: impl AsRef<Path>) -> Result<Self> {
    let data = std::fs::read(path)?;
    Self::from_bytes(&data)
  }

  pub fn from_bytes(data: &[u8]) -> Result<Self> {
    let meta = raf::parse(data)?;
    let mosaic = unpack::unpack(data, &meta)?;
    Ok(Self { meta, mosaic })
  }

  /// Parse metadata only (no sensor decode).
  pub fn read_metadata(data: &[u8]) -> Result<RafMetadata> {
    raf::parse(data)
  }

  #[inline]
  pub fn sample(&self, row: usize, col: usize) -> u16 {
    self.mosaic[row * self.meta.raw_width + col]
  }
}
