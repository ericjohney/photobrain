//! Minimal bounds-checked TIFF IFD reader (enough for FujiIFD and EXIF).

use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endian {
  Little,
  Big,
}

pub struct TiffReader<'a> {
  data: &'a [u8],
  endian: Endian,
}

#[derive(Clone, Debug)]
pub struct IfdEntry {
  pub tag: u16,
  pub typ: u16,
  pub count: u32,
  /// Raw 4-byte value/offset field.
  pub field: [u8; 4],
}

#[derive(Clone, Debug, Default)]
pub struct Ifd {
  pub entries: Vec<IfdEntry>,
}

impl Ifd {
  pub fn get(&self, tag: u16) -> Option<&IfdEntry> {
    self.entries.iter().find(|e| e.tag == tag)
  }
}

fn type_size(typ: u16) -> Option<usize> {
  Some(match typ {
    1 | 2 | 6 | 7 => 1,
    3 | 8 => 2,
    4 | 9 | 11 | 13 => 4,
    5 | 10 | 12 => 8,
    _ => return None,
  })
}

impl<'a> TiffReader<'a> {
  /// Parse a TIFF header ("II*\0" or "MM\0*").
  pub fn new(data: &'a [u8]) -> Result<Self> {
    let endian = match data.get(..4) {
      Some([0x49, 0x49, 0x2a, 0x00]) => Endian::Little,
      Some([0x4d, 0x4d, 0x00, 0x2a]) => Endian::Big,
      _ => return Err(Error::Malformed("bad TIFF header".into())),
    };
    Ok(Self { data, endian })
  }

  pub fn with_endian(data: &'a [u8], endian: Endian) -> Self {
    Self { data, endian }
  }

  pub fn first_ifd_offset(&self) -> Result<usize> {
    Ok(self.u32_at(4)? as usize)
  }

  fn bytes(&self, off: usize, len: usize) -> Result<&'a [u8]> {
    off
      .checked_add(len)
      .and_then(|end| self.data.get(off..end))
      .ok_or_else(|| Error::Malformed(format!("TIFF read {len} bytes at {off:#x} past end")))
  }

  pub fn u16_at(&self, off: usize) -> Result<u16> {
    let b: [u8; 2] = self.bytes(off, 2)?.try_into().unwrap();
    Ok(match self.endian {
      Endian::Little => u16::from_le_bytes(b),
      Endian::Big => u16::from_be_bytes(b),
    })
  }

  pub fn u32_at(&self, off: usize) -> Result<u32> {
    let b: [u8; 4] = self.bytes(off, 4)?.try_into().unwrap();
    Ok(match self.endian {
      Endian::Little => u32::from_le_bytes(b),
      Endian::Big => u32::from_be_bytes(b),
    })
  }

  pub fn ifd(&self, off: usize) -> Result<Ifd> {
    let n = self.u16_at(off)? as usize;
    if n > 4096 {
      return Err(Error::Malformed(format!("implausible IFD entry count {n}")));
    }
    let mut entries = Vec::with_capacity(n);
    for i in 0..n {
      let e = off + 2 + 12 * i;
      entries.push(IfdEntry {
        tag: self.u16_at(e)?,
        typ: self.u16_at(e + 2)?,
        count: self.u32_at(e + 4)?,
        field: self.bytes(e + 8, 4)?.try_into().unwrap(),
      });
    }
    Ok(Ifd { entries })
  }
}

impl IfdEntry {
  /// All payload bytes; values of four bytes or fewer live in the entry itself.
  pub fn raw_bytes(&self, r: &TiffReader) -> Result<Vec<u8>> {
    let size = type_size(self.typ).unwrap_or(1);
    let len = size
      .checked_mul(self.count as usize)
      .ok_or_else(|| Error::Malformed("TIFF entry size overflow".into()))?;
    if len <= 4 {
      return Ok(self.field[..len].to_vec());
    }
    let off = match r.endian {
      Endian::Little => u32::from_le_bytes(self.field),
      Endian::Big => u32::from_be_bytes(self.field),
    } as usize;
    Ok(r.bytes(off, len)?.to_vec())
  }

  fn element(&self, bytes: &[u8], i: usize, endian: Endian) -> Result<f64> {
    let size = type_size(self.typ)
      .ok_or_else(|| Error::Malformed(format!("unknown TIFF type {}", self.typ)))?;
    let b = bytes
      .get(i * size..(i + 1) * size)
      .ok_or_else(|| Error::Malformed("TIFF element index out of range".into()))?;
    let u16v = |b: &[u8]| match endian {
      Endian::Little => u16::from_le_bytes([b[0], b[1]]),
      Endian::Big => u16::from_be_bytes([b[0], b[1]]),
    };
    let u32v = |b: &[u8]| match endian {
      Endian::Little => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
      Endian::Big => u32::from_be_bytes([b[0], b[1], b[2], b[3]]),
    };
    Ok(match self.typ {
      1 | 2 | 7 => b[0] as f64,
      6 => b[0] as i8 as f64,
      3 => u16v(b) as f64,
      8 => u16v(b) as i16 as f64,
      4 | 13 => u32v(b) as f64,
      9 => u32v(b) as i32 as f64,
      11 => f32::from_bits(u32v(b)) as f64,
      5 => {
        let d = u32v(&b[4..]);
        if d == 0 {
          0.0
        } else {
          u32v(b) as f64 / d as f64
        }
      }
      10 => {
        let d = u32v(&b[4..]) as i32;
        if d == 0 {
          0.0
        } else {
          u32v(b) as i32 as f64 / d as f64
        }
      }
      12 => match endian {
        Endian::Little => f64::from_le_bytes(b.try_into().unwrap()),
        Endian::Big => f64::from_be_bytes(b.try_into().unwrap()),
      },
      _ => unreachable!(),
    })
  }

  pub fn values_f64(&self, r: &TiffReader) -> Result<Vec<f64>> {
    let bytes = self.raw_bytes(r)?;
    (0..self.count as usize)
      .map(|i| self.element(&bytes, i, r.endian))
      .collect()
  }

  pub fn values_u32(&self, r: &TiffReader) -> Result<Vec<u32>> {
    Ok(self.values_f64(r)?.into_iter().map(|v| v as u32).collect())
  }

  pub fn value_u32(&self, r: &TiffReader, i: usize) -> Result<u32> {
    let bytes = self.raw_bytes(r)?;
    Ok(self.element(&bytes, i, r.endian)? as u32)
  }

  pub fn value_f64(&self, r: &TiffReader, i: usize) -> Result<f64> {
    let bytes = self.raw_bytes(r)?;
    self.element(&bytes, i, r.endian)
  }

  pub fn ascii(&self, r: &TiffReader) -> Result<String> {
    let b = self.raw_bytes(r)?;
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    Ok(String::from_utf8_lossy(&b[..end]).trim().to_string())
  }
}
