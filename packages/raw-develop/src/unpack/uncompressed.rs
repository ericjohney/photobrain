//! Uncompressed RAF sensor data: little-endian u16 per sample, row-major.

use crate::error::{Error, Result};

pub fn decode(strip: &[u8], width: usize, height: usize, bits: u32) -> Result<Vec<u16>> {
  let n = width
    .checked_mul(height)
    .ok_or_else(|| Error::Malformed("raw size overflow".into()))?;
  if strip.len() < n * 2 {
    return Err(Error::Corrupt(format!(
      "uncompressed strip has {} bytes, need {}",
      strip.len(),
      n * 2
    )));
  }
  let max = if bits >= 16 {
    u16::MAX
  } else {
    ((1u32 << bits) - 1) as u16
  };
  Ok(
    strip[..n * 2]
      .as_chunks::<2>()
      .0
      .iter()
      .map(|b| u16::from_le_bytes([b[0], b[1]]).min(max))
      .collect(),
  )
}

#[cfg(test)]
mod tests {
  #[test]
  fn decodes_le_samples() {
    let v = super::decode(&[1, 0, 0xff, 0xff, 0x34, 0x12], 3, 1, 14).unwrap();
    assert_eq!(v, vec![1, 0x3fff, 0x1234]);
    assert!(super::decode(&[0; 4], 3, 1, 14).is_err());
  }
}
