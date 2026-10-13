//! A decoded RAW: the sensor mosaic plus the metadata needed to develop it.
//!
//! A `Negative` is immutable and is the unit callers cache between edits; developing
//! is a pure function of a `Negative` and `DevelopSettings`.

use crate::error::Result;
use crate::metadata::RawMetadata;
use crate::raf;
use crate::unpack;
use std::path::Path;

pub struct Negative {
  pub meta: RawMetadata,
  /// Full readout mosaic, `meta.raw_width * meta.raw_height`, row-major.
  pub mosaic: Vec<u16>,
}

impl Negative {
  pub fn open(path: impl AsRef<Path>) -> Result<Self> {
    let data = std::fs::read(path)?;
    Self::from_bytes(&data)
  }

  pub fn from_bytes(data: &[u8]) -> Result<Self> {
    let meta = parse_metadata(data)?;
    let mosaic = unpack::unpack(data, &meta)?;
    Ok(Self { meta, mosaic })
  }

  /// Parse metadata only (no sensor decode).
  pub fn read_metadata(data: &[u8]) -> Result<RawMetadata> {
    parse_metadata(data)
  }

  #[inline]
  pub fn sample(&self, row: usize, col: usize) -> u16 {
    self.mosaic[row * self.meta.raw_width + col]
  }
}

/// Detect the container from its magic bytes and parse its metadata.
fn parse_metadata(data: &[u8]) -> Result<RawMetadata> {
  if data.starts_with(b"FUJIFILMCCD-RAW ") {
    return raf::parse(data);
  }
  if crate::arw::is_arw(data) {
    return crate::arw::parse(data);
  }
  Err(crate::Error::NotRaw)
}
