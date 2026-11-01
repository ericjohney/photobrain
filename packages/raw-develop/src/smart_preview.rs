//! Versioned, bounded and lossless screen development state (never an original).
use crate::{Cancel, Error, PIPELINE_VERSION, Prepared, Result};
use bincode::Options;
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use std::io::{Read, Write};

pub const MAX_EDGE: usize = 2048;
pub const MAX_BYTES: usize = 96 * 1024 * 1024;
const HEADER: usize = 20;
const VERSION: u32 = 1;
fn malformed() -> Error {
  Error::Malformed("invalid or incompatible smart preview".into())
}
fn codec() -> impl Options {
  bincode::DefaultOptions::new()
    .with_fixint_encoding()
    .with_little_endian()
    .with_limit(MAX_BYTES as u64)
    .reject_trailing_bytes()
}
pub(crate) fn encode(prepared: &Prepared, cancel: &Cancel) -> Result<Vec<u8>> {
  cancel.check()?;
  let raw = codec().serialize(prepared).map_err(|_| malformed())?;
  cancel.check()?;
  let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
  for chunk in raw.chunks(256 * 1024) {
    cancel.check()?;
    encoder.write_all(chunk)?;
  }
  let compressed = encoder.finish()?;
  if compressed.len() > MAX_BYTES {
    return Err(malformed());
  }
  let mut out = Vec::with_capacity(HEADER + compressed.len());
  out.extend_from_slice(b"PBSP");
  out.extend_from_slice(&VERSION.to_le_bytes());
  out.extend_from_slice(&PIPELINE_VERSION.to_le_bytes());
  out.extend_from_slice(&(raw.len() as u64).to_le_bytes());
  out.extend(compressed);
  cancel.check()?;
  Ok(out)
}
pub(crate) fn decode(bytes: &[u8]) -> Result<Prepared> {
  if bytes.len() < HEADER
    || bytes.len() > MAX_BYTES + HEADER
    || &bytes[..4] != b"PBSP"
    || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) != VERSION
    || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != PIPELINE_VERSION
  {
    return Err(malformed());
  }
  let expected = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
  if expected == 0 || expected > MAX_BYTES as u64 {
    return Err(malformed());
  }
  let mut decoder = ZlibDecoder::new(&bytes[HEADER..]);
  let mut raw = Vec::new();
  (&mut decoder)
    .take(expected + 1)
    .read_to_end(&mut raw)
    .map_err(|_| malformed())?;
  if raw.len() as u64 != expected || decoder.total_in() as usize != bytes.len() - HEADER {
    return Err(malformed());
  }
  codec().deserialize(&raw).map_err(|_| malformed())
}

pub(crate) mod settings_json {
  use serde::{Deserialize, Deserializer, Serializer};
  pub fn serialize<S: Serializer>(value: &crate::DevelopSettings, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&serde_json::to_string(value).map_err(serde::ser::Error::custom)?)
  }
  pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<crate::DevelopSettings, D::Error> {
    let text = String::deserialize(d)?;
    if text.len() > 8192 {
      return Err(serde::de::Error::custom("oversized settings"));
    }
    serde_json::from_str(&text).map_err(serde::de::Error::custom)
  }
}
pub(crate) mod float_array {
  use serde::{Deserialize, Deserializer, Serialize, Serializer};
  pub fn serialize<S: Serializer>(v: &[f32; 256], s: S) -> Result<S::Ok, S::Error> {
    v.as_slice().serialize(s)
  }
  pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[f32; 256], D::Error> {
    Vec::<f32>::deserialize(d)?
      .try_into()
      .map_err(|_| serde::de::Error::custom("invalid tone table"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn decoded_state_dimensions_are_validated_after_decompression() {
    let neg = crate::Negative::open(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/tests/fixtures/synthetic.ARW"
    ))
    .unwrap();
    let prepared = crate::prepare(
      &neg,
      &crate::DevelopSettings::default(),
      &crate::Options::default(),
    )
    .unwrap();
    for (field, value) in [("width", 0), ("height", 2049)] {
      let mut state = serde_json::to_value(&prepared).unwrap();
      state["image"][field] = value.into();
      let invalid: Prepared = serde_json::from_value(state).unwrap();
      let bytes = encode(&invalid, &Cancel::never()).unwrap();
      assert!(Prepared::decode_smart_preview(&bytes).is_err());
    }
  }
}
