//! Sony lossy "Compressed RAW" (cRAW, ARW Compression 32767).
//!
//! Each image row is coded in 32-byte groups covering 32 photosites: the first 16-byte
//! block codes the 16 even columns, the second the 16 odd columns (each a single CFA
//! colour).
//!
//! Block layout, little-endian bit order (bit 0 is the least significant bit of byte 0):
//! - bits 0..11:  max (11 bits)
//! - bits 11..22: min (11 bits)
//! - bits 22..26: index of the max sample (4 bits)
//! - bits 26..30: index of the min sample (4 bits)
//! - then 14 deltas of 7 bits for the other samples, in order, skipping the max and min
//!   positions: `value = min + (delta << shift)`, where `shift` is the smallest value
//!   such that `0x80 << shift > max - min` (at most 4).
//!
//! The 11-bit values are then expanded through the camera's tone curve (`curve`).
//!
//! Written from the publicly documented format and verified against RawCamera's decoded
//! mosaic.

use crate::error::{Error, Result};
use rayon::prelude::*;

/// Expansion table from 11-bit codes to 14-bit values. `SonyToneCurve` holds four knots
/// in 14-bit units; on the 12-bit grid (`knot >> 2`) the curve is the identity up to the
/// first knot and its slope doubles after each knot (1, 2, 4, 8, 16). An 11-bit code `c`
/// reads the curve at `2c`.
pub fn curve(knots: [u32; 4]) -> Vec<u16> {
  let mut k = [0usize; 6];
  for i in 0..4 {
    k[i + 1] = ((knots[i] >> 2) & 0xfff) as usize;
  }
  k[5] = 4095;
  let mut c: Vec<u32> = (0..=0x4000).collect();
  for i in 0..5 {
    for j in k[i] + 1..=k[i + 1].max(k[i]) {
      c[j] = c[j - 1] + (1 << i);
    }
  }
  (0..2048).map(|code| c[code << 1].min(0x3fff) as u16).collect()
}

fn decode_block(b: &[u8; 16], out: &mut [u16; 16]) {
  let bits = u128::from_le_bytes(*b);
  let max = (bits & 0x7ff) as u32;
  let min = ((bits >> 11) & 0x7ff) as u32;
  let imax = ((bits >> 22) & 0xf) as usize;
  let imin = ((bits >> 26) & 0xf) as usize;
  let mut shift = 0;
  while shift < 4 && (0x80u32 << shift) <= max.saturating_sub(min) {
    shift += 1;
  }
  let mut bit = 30;
  for (i, o) in out.iter_mut().enumerate() {
    *o = if i == imax {
      max as u16
    } else if i == imin {
      min as u16
    } else {
      let d = ((bits >> bit) & 0x7f) as u32;
      bit += 7;
      ((d << shift) + min).min(0x7ff) as u16
    };
  }
}

/// Decode a full cRAW strip of `width x height` photosites (width a multiple of 32).
pub fn decode(strip: &[u8], width: usize, height: usize, tone_knots: [u32; 4]) -> Result<Vec<u16>> {
  if width % 32 != 0 {
    return Err(Error::Unsupported(format!("cRAW width {width} not a multiple of 32")));
  }
  if strip.len() < width * height {
    return Err(Error::Corrupt(format!(
      "cRAW strip has {} bytes, need {}",
      strip.len(),
      width * height
    )));
  }
  let table = curve(tone_knots);
  let mut mosaic = vec![0u16; width * height];
  mosaic.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
    let src = &strip[y * width..(y + 1) * width];
    for (blk, chunk) in src.chunks_exact(32).enumerate() {
      let mut a = [0u16; 16];
      let mut b = [0u16; 16];
      decode_block(chunk[..16].try_into().unwrap(), &mut a);
      decode_block(chunk[16..].try_into().unwrap(), &mut b);
      let x0 = blk * 32;
      for i in 0..16 {
        row[x0 + 2 * i] = table[a[i] as usize];
        row[x0 + 2 * i + 1] = table[b[i] as usize];
      }
    }
  });
  Ok(mosaic)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn curve_matches_rawcamera_samples() {
    // A7C R SonyToneCurve; pairs observed in RawCamera's decode of a cRAW file.
    let c = curve([8000, 10400, 12900, 14100]);
    for (code, v) in [(500, 1000), (1099, 2396), (1300, 3200), (1500, 4800), (1613, 5708), (1800, 9300), (1900, 12500)] {
      assert_eq!(c[code], v, "code {code}");
    }
  }

  #[test]
  fn block_round_trip() {
    // max 300 at index 0, min 285 at index 1, deltas in order.
    let vals: [u32; 16] = [300, 285, 295, 286, 285, 289, 293, 293, 290, 297, 294, 288, 290, 288, 293, 290];
    let mut bits: u128 = 300 | (285 << 11) | (0 << 22) | (1 << 26);
    let mut pos = 30;
    for (i, &v) in vals.iter().enumerate() {
      if i > 1 {
        bits |= ((v - 285) as u128) << pos;
        pos += 7;
      }
    }
    let mut out = [0u16; 16];
    decode_block(&bits.to_le_bytes(), &mut out);
    assert_eq!(out.map(|v| v as u32), vals);
  }
}
