//! Lossless JPEG (ITU-T T.81 process 14, "LJ92") decoder, as used by Sony lossless
//! compressed ARW tiles and DNG `Compression = 7` tiles.
//!
//! Written from the T.81 specification (Annex H, plus Annex C/F Huffman decoding):
//! SOF3 frame, DHT tables, DRI restart intervals, SOS with predictor `Ss` (1-7) and point
//! transform `Al`. Output is one `u16` per sample, components interleaved along each row
//! (`width * components` samples per row), exactly as encoded; the container decides how
//! interleaved components map onto pixels.

use crate::error::{Error, Result};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
  pub precision: u8,
  pub width: usize,
  pub height: usize,
  pub components: usize,
  pub predictor: u8,
  pub point_transform: u8,
}

fn corrupt<T>(m: impl Into<String>) -> Result<T> {
  Err(Error::Corrupt(format!("lossless JPEG: {}", m.into())))
}

#[derive(Clone)]
struct Huffman {
  /// Fast path: (code length, symbol) for the next 9 bits, length 0 = slow path.
  fast: Vec<(u8, u8)>,
  maxcode: [i32; 18],
  valptr: [i32; 17],
  mincode: [i32; 17],
  symbols: Vec<u8>,
}

const FAST_BITS: u32 = 9;

impl Huffman {
  fn new(counts: &[u8; 16], symbols: &[u8]) -> Result<Self> {
    let mut maxcode = [-1i32; 18];
    let mut valptr = [0i32; 17];
    let mut mincode = [0i32; 17];
    let mut fast = vec![(0u8, 0u8); 1 << FAST_BITS];
    let mut code = 0i32;
    let mut k = 0usize;
    for len in 1..=16usize {
      let n = counts[len - 1] as usize;
      if n > 0 {
        valptr[len] = k as i32;
        mincode[len] = code;
        for _ in 0..n {
          if k >= symbols.len() {
            return corrupt("DHT symbol count");
          }
          if len as u32 <= FAST_BITS {
            let shift = FAST_BITS - len as u32;
            let base = (code as usize) << shift;
            for i in 0..(1usize << shift) {
              fast[base + i] = (len as u8, symbols[k]);
            }
          }
          code += 1;
          k += 1;
        }
        maxcode[len] = code - 1;
      }
      code <<= 1;
    }
    maxcode[17] = i32::MAX;
    Ok(Self {
      fast,
      maxcode,
      valptr,
      mincode,
      symbols: symbols.to_vec(),
    })
  }
}

/// MSB-first entropy-coded segment reader with 0xFF00 unstuffing; stops at markers.
struct Bits<'a> {
  data: &'a [u8],
  pos: usize,
  cache: u64,
  bits: u32,
  /// A marker (0xFF followed by non-zero) was reached; zeros are fed from here on.
  marker: bool,
}

impl<'a> Bits<'a> {
  fn new(data: &'a [u8], pos: usize) -> Self {
    Self {
      data,
      pos,
      cache: 0,
      bits: 0,
      marker: false,
    }
  }

  #[inline]
  fn refill(&mut self) {
    while self.bits <= 56 {
      let mut b = 0u8;
      if !self.marker && self.pos < self.data.len() {
        b = self.data[self.pos];
        if b == 0xff {
          match self.data.get(self.pos + 1) {
            Some(0x00) => self.pos += 2,
            _ => {
              self.marker = true;
              b = 0;
            }
          }
        } else {
          self.pos += 1;
        }
      }
      self.cache |= (b as u64) << (56 - self.bits);
      self.bits += 8;
    }
  }

  #[inline]
  fn peek(&mut self, n: u32) -> u32 {
    if self.bits < n {
      self.refill();
    }
    (self.cache >> (64 - n)) as u32
  }

  #[inline]
  fn skip(&mut self, n: u32) {
    self.cache <<= n;
    self.bits -= n;
  }

  #[inline]
  fn read(&mut self, n: u32) -> u32 {
    if n == 0 {
      return 0;
    }
    let v = self.peek(n);
    self.skip(n);
    v
  }

  #[inline]
  fn decode(&mut self, h: &Huffman) -> Result<u8> {
    let (len, sym) = h.fast[self.peek(FAST_BITS) as usize];
    if len > 0 {
      self.skip(len as u32);
      return Ok(sym);
    }
    let mut code = self.read(FAST_BITS) as i32;
    let mut len = FAST_BITS as usize;
    while code > h.maxcode[len] {
      len += 1;
      if len > 16 {
        return corrupt("bad Huffman code");
      }
      code = (code << 1) | self.read(1) as i32;
    }
    let i = (h.valptr[len] + code - h.mincode[len]) as usize;
    h.symbols
      .get(i)
      .copied()
      .ok_or_else(|| Error::Corrupt("lossless JPEG: Huffman symbol".into()))
  }

  #[inline]
  fn diff(&mut self, h: &Huffman) -> Result<i32> {
    let ssss = self.decode(h)? as u32;
    Ok(match ssss {
      0 => 0,
      // T.81 H.1.2.2: SSSS = 16 encodes 32768 with no additional bits.
      16 => 32768,
      1..=15 => {
        let v = self.read(ssss) as i32;
        if v < 1 << (ssss - 1) {
          v - (1 << ssss) + 1
        } else {
          v
        }
      }
      _ => return corrupt("SSSS > 16"),
    })
  }

  /// Byte position after the current marker (for restart intervals): drops buffered
  /// bits and expects RSTn at the read position.
  fn restart(&mut self) -> Result<()> {
    // Unread whole bytes still in the cache belong to the next segment only if no marker
    // was hit; after a full interval the encoder pads to a byte boundary, so the marker
    // is the next thing in the stream.
    let mut p = self.pos;
    while p + 1 < self.data.len() && !(self.data[p] == 0xff && (0xd0..=0xd7).contains(&self.data[p + 1])) {
      p += 1;
    }
    if p + 1 >= self.data.len() {
      return corrupt("missing RST marker");
    }
    *self = Bits::new(self.data, p + 2);
    Ok(())
  }
}

fn be16(d: &[u8], p: usize) -> Result<usize> {
  d.get(p..p + 2)
    .map(|b| u16::from_be_bytes([b[0], b[1]]) as usize)
    .ok_or_else(|| Error::Corrupt("lossless JPEG: truncated header".into()))
}

/// Decode a complete SOI..EOI lossless JPEG stream.
pub fn decode(data: &[u8]) -> Result<(Frame, Vec<u16>)> {
  if data.get(..2) != Some(&[0xff, 0xd8]) {
    return corrupt("missing SOI");
  }
  let mut p = 2;
  let mut tables: [Option<Huffman>; 4] = [None, None, None, None];
  let mut frame: Option<(Frame, Vec<u8>)> = None; // + component ids
  let mut restart_interval = 0usize;
  loop {
    // Skip fill bytes.
    while data.get(p) == Some(&0xff) && data.get(p + 1) == Some(&0xff) {
      p += 1;
    }
    if data.get(p) != Some(&0xff) {
      return corrupt(format!("expected marker at {p:#x}"));
    }
    let marker = *data.get(p + 1).ok_or_else(|| Error::Corrupt("lossless JPEG: EOF".into()))?;
    let len = be16(data, p + 2)?;
    let body = data
      .get(p + 4..p + 2 + len)
      .ok_or_else(|| Error::Corrupt("lossless JPEG: segment past end".into()))?;
    match marker {
      0xc3 => {
        if body.len() < 6 {
          return corrupt("SOF3 length");
        }
        let nf = body[5] as usize;
        if nf == 0 || nf > 4 || body.len() < 6 + 3 * nf {
          return corrupt("SOF3 components");
        }
        for c in 0..nf {
          if body[6 + 3 * c + 1] != 0x11 {
            return Err(Error::Unsupported("lossless JPEG with subsampled components".into()));
          }
        }
        let f = Frame {
          precision: body[0],
          height: u16::from_be_bytes([body[1], body[2]]) as usize,
          width: u16::from_be_bytes([body[3], body[4]]) as usize,
          components: nf,
          predictor: 0,
          point_transform: 0,
        };
        if !(2..=16).contains(&f.precision) || f.width == 0 || f.height == 0 {
          return corrupt("SOF3 values");
        }
        frame = Some((f, (0..nf).map(|c| body[6 + 3 * c]).collect()));
      }
      0xc0..=0xcf if marker != 0xc4 && marker != 0xc8 && marker != 0xcc => {
        return Err(Error::Unsupported(format!("JPEG SOF{} (only lossless SOF3)", marker - 0xc0)));
      }
      0xc4 => {
        let mut q = 0;
        while q < body.len() {
          let tc_th = body[q];
          let id = (tc_th & 0x0f) as usize;
          if tc_th >> 4 != 0 || id > 3 {
            return corrupt("DHT class/id");
          }
          let counts: [u8; 16] = body
            .get(q + 1..q + 17)
            .ok_or_else(|| Error::Corrupt("lossless JPEG: DHT".into()))?
            .try_into()
            .unwrap();
          let n: usize = counts.iter().map(|&c| c as usize).sum();
          let syms = body
            .get(q + 17..q + 17 + n)
            .ok_or_else(|| Error::Corrupt("lossless JPEG: DHT symbols".into()))?;
          tables[id] = Some(Huffman::new(&counts, syms)?);
          q += 17 + n;
        }
      }
      0xdd => restart_interval = be16(body, 0)?,
      0xda => {
        let Some((mut f, ids)) = frame.take() else {
          return corrupt("SOS before SOF3");
        };
        let ns = body[0] as usize;
        if ns != f.components || body.len() < 1 + 2 * ns + 3 {
          return Err(Error::Unsupported("lossless JPEG with multiple scans".into()));
        }
        let mut comp_tables = Vec::with_capacity(ns);
        for i in 0..ns {
          let cid = body[1 + 2 * i];
          if ids.get(i) != Some(&cid) {
            return Err(Error::Unsupported("lossless JPEG scan component order".into()));
          }
          let td = (body[2 + 2 * i] >> 4) as usize;
          comp_tables.push(
            tables
              .get(td)
              .cloned()
              .flatten()
              .ok_or_else(|| Error::Corrupt("lossless JPEG: missing Huffman table".into()))?,
          );
        }
        f.predictor = body[1 + 2 * ns];
        f.point_transform = body[3 + 2 * ns] & 0x0f;
        if !(1..=7).contains(&f.predictor) {
          return corrupt(format!("predictor {}", f.predictor));
        }
        let samples = scan(data, p + 2 + len, &f, &comp_tables, restart_interval)?;
        return Ok((f, samples));
      }
      0xd9 => return corrupt("EOI before scan"),
      _ => {}
    }
    p += 2 + len;
  }
}

fn scan(data: &[u8], start: usize, f: &Frame, tables: &[Huffman], restart: usize) -> Result<Vec<u16>> {
  let nc = f.components;
  let (w, h) = (f.width, f.height);
  let row_len = w * nc;
  let mut out = vec![0u16; row_len * h];
  let mut bits = Bits::new(data, start);
  let pt = f.point_transform as u32;
  let initial = 1i32 << (f.precision as u32 - pt - 1);
  let pred = f.predictor;
  // Restart intervals count MCUs (one sample of every component); a restart resets the
  // predictor as at the start of the scan.
  let mut mcu = 0usize;
  let mut fresh_row = 0usize; // row at which prediction last restarted
  for y in 0..h {
    for x in 0..w {
      if restart > 0 && mcu > 0 && mcu % restart == 0 {
        bits.restart()?;
        fresh_row = y;
        // A restart mid-row is legal but unused by the cameras we target.
        if x != 0 {
          return Err(Error::Unsupported("lossless JPEG restart inside a row".into()));
        }
      }
      for c in 0..nc {
        let i = y * row_len + x * nc + c;
        let ra = || out[i - nc] as i32;
        let rb = || out[i - row_len] as i32;
        let rc = || out[i - row_len - nc] as i32;
        let px = if y == fresh_row {
          if x == 0 { initial } else { ra() }
        } else if x == 0 {
          rb()
        } else {
          match pred {
            1 => ra(),
            2 => rb(),
            3 => rc(),
            4 => ra() + rb() - rc(),
            5 => ra() + ((rb() - rc()) >> 1),
            6 => rb() + ((ra() - rc()) >> 1),
            _ => (ra() + rb()) >> 1,
          }
        };
        let d = bits.diff(&tables[c])?;
        out[i] = (px + d) as u16;
      }
      mcu += 1;
    }
  }
  if pt > 0 {
    for v in &mut out {
      *v <<= pt;
    }
  }
  Ok(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A minimal lossless JPEG encoder for round-trip tests (single Huffman table with
  /// SSSS codes 0..=16 at fixed lengths).
  fn encode(samples: &[u16], w: usize, h: usize, nc: usize, precision: u8, predictor: u8) -> Vec<u8> {
    // Canonical table: 17 symbols, lengths 5 (all), which T.81 allows (no all-ones code
    // issue below 32 codes of length 5).
    let mut counts = [0u8; 16];
    counts[4] = 17;
    let syms: Vec<u8> = (0..=16).collect();
    let mut out = vec![0xff, 0xd8];
    let seg = |m: u8, body: &[u8], out: &mut Vec<u8>| {
      out.extend_from_slice(&[0xff, m]);
      out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
      out.extend_from_slice(body);
    };
    let mut sof = vec![precision];
    sof.extend_from_slice(&(h as u16).to_be_bytes());
    sof.extend_from_slice(&(w as u16).to_be_bytes());
    sof.push(nc as u8);
    for c in 0..nc {
      sof.extend_from_slice(&[c as u8 + 1, 0x11, 0]);
    }
    seg(0xc3, &sof, &mut out);
    let mut dht = vec![0u8];
    dht.extend_from_slice(&counts);
    dht.extend_from_slice(&syms);
    seg(0xc4, &dht, &mut out);
    let mut sos = vec![nc as u8];
    for c in 0..nc {
      sos.extend_from_slice(&[c as u8 + 1, 0x00]);
    }
    sos.extend_from_slice(&[predictor, 0, 0]);
    seg(0xda, &sos, &mut out);
    // Entropy data.
    let mut acc: u64 = 0;
    let mut nb = 0u32;
    let mut put = |v: u32, n: u32, out: &mut Vec<u8>| {
      acc = (acc << n) | v as u64;
      nb += n;
      while nb >= 8 {
        let b = (acc >> (nb - 8)) as u8;
        out.push(b);
        if b == 0xff {
          out.push(0);
        }
        nb -= 8;
      }
    };
    let row = w * nc;
    for y in 0..h {
      for x in 0..w {
        for c in 0..nc {
          let i = y * row + x * nc + c;
          let s = |j: usize| samples[j] as i32;
          let px = if y == 0 {
            if x == 0 { 1 << (precision - 1) } else { s(i - nc) }
          } else if x == 0 {
            s(i - row)
          } else {
            let (ra, rb, rc) = (s(i - nc), s(i - row), s(i - row - nc));
            match predictor {
              1 => ra,
              2 => rb,
              3 => rc,
              4 => ra + rb - rc,
              5 => ra + ((rb - rc) >> 1),
              6 => rb + ((ra - rc) >> 1),
              _ => (ra + rb) >> 1,
            }
          };
          let d = ((s(i) - px) as i16) as i32; // modulo 2^16
          let mag = d.unsigned_abs();
          let ssss = if d == -32768 { 16 } else { 32 - mag.leading_zeros() };
          put(ssss, 5, &mut out);
          if ssss > 0 && ssss < 16 {
            let v = if d < 0 { (d + (1 << ssss) - 1) as u32 } else { d as u32 };
            put(v, ssss, &mut out);
          }
        }
      }
    }
    put(0x7f, 7, &mut out); // pad with ones
    out.extend_from_slice(&[0xff, 0xd9]);
    out
  }

  #[test]
  fn round_trips_every_predictor() {
    let (w, h, nc) = (13usize, 7usize, 4usize);
    let samples: Vec<u16> = (0..w * h * nc)
      .map(|i| ((i * 7919 + (i / 5) * 131) % 16384) as u16)
      .collect();
    for pred in 1..=7 {
      let enc = encode(&samples, w, h, nc, 14, pred);
      let (f, dec) = decode(&enc).unwrap();
      assert_eq!((f.width, f.height, f.components, f.predictor), (w, h, nc, pred));
      assert_eq!(dec, samples, "predictor {pred}");
    }
  }

  #[test]
  fn round_trips_full_16_bit_range() {
    let (w, h) = (9usize, 5usize);
    let samples: Vec<u16> = (0..w * h).map(|i| if i % 2 == 0 { 0 } else { 0xffff }).collect();
    let enc = encode(&samples, w, h, 1, 16, 1);
    assert_eq!(decode(&enc).unwrap().1, samples);
  }

  #[test]
  fn rejects_baseline_jpeg() {
    let data = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 8, 0, 1, 0, 1, 1, 0xff, 0xd9];
    assert!(matches!(decode(&data), Err(Error::Unsupported(_))));
  }
}
