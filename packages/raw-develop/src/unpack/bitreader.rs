//! MSB-first bit reader over a byte slice.

use crate::error::{Error, Result};

pub struct BitReader<'a> {
  data: &'a [u8],
  pos: usize,
  /// Up to 64 buffered bits, left-aligned (next bit is the MSB).
  cache: u64,
  bits: u32,
}

impl<'a> BitReader<'a> {
  pub fn new(data: &'a [u8]) -> Self {
    Self {
      data,
      pos: 0,
      cache: 0,
      bits: 0,
    }
  }

  #[inline]
  fn refill(&mut self) {
    while self.bits <= 56 {
      let byte = if self.pos < self.data.len() {
        let b = self.data[self.pos];
        self.pos += 1;
        b
      } else {
        // Past the end: feed zeros. `overrun` reports whether real data ran out.
        self.pos += 1;
        0
      };
      self.cache |= (byte as u64) << (56 - self.bits);
      self.bits += 8;
    }
  }

  /// True when more bits were consumed than the input contains.
  pub fn overrun(&self) -> bool {
    let consumed_bytes = self.pos as i64 - (self.bits as i64 / 8);
    consumed_bytes > self.data.len() as i64
  }

  /// Read `n` (0..=32) bits.
  #[inline]
  pub fn read(&mut self, n: u32) -> u32 {
    if n == 0 {
      return 0;
    }
    if self.bits < n {
      self.refill();
    }
    let v = (self.cache >> (64 - n)) as u32;
    self.cache <<= n;
    self.bits -= n;
    v
  }

  /// Count zero bits up to and including the terminating one bit; returns the count of
  /// zeros. Fails if more than `limit` zeros are seen.
  #[inline]
  pub fn read_unary_zeros(&mut self, limit: u32) -> Result<u32> {
    let mut zeros = 0u32;
    loop {
      if self.bits == 0 || self.cache == 0 {
        // Fast path for long zero runs: consume all buffered zero bits.
        zeros += self.bits;
        self.cache = 0;
        self.bits = 0;
        self.refill();
        if zeros > limit {
          return Err(Error::Corrupt("unary code too long".into()));
        }
        continue;
      }
      let lz = self.cache.leading_zeros().min(self.bits);
      if lz < self.bits {
        zeros += lz;
        self.cache <<= lz + 1;
        self.bits -= lz + 1;
        if zeros > limit {
          return Err(Error::Corrupt("unary code too long".into()));
        }
        return Ok(zeros);
      }
      zeros += self.bits;
      self.cache = 0;
      self.bits = 0;
      self.refill();
      if zeros > limit {
        return Err(Error::Corrupt("unary code too long".into()));
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_msb_first() {
    let mut r = BitReader::new(&[0b1011_0000, 0xff]);
    assert_eq!(r.read(1), 1);
    assert_eq!(r.read(3), 0b011);
    assert_eq!(r.read(4), 0);
    assert_eq!(r.read(8), 0xff);
    assert!(!r.overrun());
    r.read(1);
    assert!(r.overrun());
  }

  #[test]
  fn unary_zeros() {
    // 0001 1 00000000 00000001
    let mut r = BitReader::new(&[0b0001_1000, 0x00, 0x00, 0x40]);
    assert_eq!(r.read_unary_zeros(100).unwrap(), 3);
    assert_eq!(r.read_unary_zeros(100).unwrap(), 0);
    assert_eq!(r.read_unary_zeros(100).unwrap(), 20);
  }

  #[test]
  fn unary_limit() {
    let mut r = BitReader::new(&[0u8; 8]);
    assert!(r.read_unary_zeros(16).is_err());
  }
}
