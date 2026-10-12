//! Fujifilm lossless compressed X-Trans decoder.
//!
//! Stream layout (big-endian header at the start of the raw strip):
//!   u16 signature 0x4953, u8 version, u8 raw type (16 = X-Trans, 0 = Bayer),
//!   u8 bits per sample, u16 raw height, u16 rounded width, u16 raw width,
//!   u16 block (stripe) width, u8 blocks per row, u16 total lines (raw height / 6)
//!   then one u32 compressed size per block, padded so data starts 16-byte aligned.
//!
//! Each vertical stripe is coded independently, six sensor rows ("one line") at a
//! time. Samples are predicted from already-decoded neighbours held in per-colour line
//! buffers (two history rows plus the rows being decoded), with a gradient context
//! selecting adaptive Golomb-Rice-like parameters for the residual. Pixels the X-Trans
//! pattern does not need from a buffer are filled by interpolation instead of coded.
//!
//! The implementation is validated bit-exactly against Apple's RawCamera decode of the
//! same files (see AGENTS.md, "Validating the decoder").

use super::bitreader::BitReader;
use crate::cfa::{CfaPattern, Channel};
use crate::error::{Error, Result};
use rayon::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
  pub version: u8,
  pub raw_type: u8,
  pub raw_bits: u8,
  pub raw_height: usize,
  pub rounded_width: usize,
  pub raw_width: usize,
  pub block_width: usize,
  pub blocks: usize,
  pub total_lines: usize,
}

impl Header {
  pub fn parse(b: &[u8]) -> Result<Self> {
    if b.len() < 16 {
      return Err(Error::Corrupt("compressed header truncated".into()));
    }
    let be16 = |o: usize| u16::from_be_bytes([b[o], b[o + 1]]) as usize;
    if be16(0) != 0x4953 {
      return Err(Error::Corrupt("compressed header signature".into()));
    }
    let h = Self {
      version: b[2],
      raw_type: b[3],
      raw_bits: b[4],
      raw_height: be16(5),
      rounded_width: be16(7),
      raw_width: be16(9),
      block_width: be16(11),
      blocks: b[13] as usize,
      total_lines: be16(14),
    };
    let ok = h.version == 1
      && matches!(h.raw_type, 0 | 16)
      && matches!(h.raw_bits, 12 | 14 | 16)
      && h.block_width > 0
      && h.blocks > 0
      && h.raw_width > 0
      && h.raw_width <= h.rounded_width
      && h.rounded_width == h.block_width * h.blocks
      && h.raw_height == h.total_lines * 6
      && !(h.raw_type == 16 && !h.block_width.is_multiple_of(3))
      && !(h.raw_type == 0 && !h.block_width.is_multiple_of(2))
      && h.raw_width > h.block_width * (h.blocks - 1);
    if !ok {
      return Err(Error::Corrupt(format!(
        "implausible compressed header {h:?}"
      )));
    }
    Ok(h)
  }
}

/// Fixed decoding parameters derived from the bit depth.
struct Params {
  /// Quantisation of a neighbour difference into -4..=4, indexed by diff + max_value.
  q_table: Vec<i8>,
  max_value: i32,
  total_values: i32,
  raw_bits: u32,
  max_bits: u32,
  max_diff: i32,
  min_value: i32,
  line_width: usize,
}

impl Params {
  fn new(h: &Header) -> Result<Self> {
    let (max_bits, raw_bits) = match h.raw_bits {
      14 => (56, 14),
      12 => (48, 12),
      16 => (64, 16),
      _ => unreachable!(),
    };
    let max_value = (1i32 << raw_bits) - 1;
    let total_values = 1i32 << raw_bits;
    let (p1, p2, p3) = (0x12, 0x43, 0x114);
    let q_table = (-max_value..=max_value)
      .map(|v| match v {
        _ if v <= -p3 => -4,
        _ if v <= -p2 => -3,
        _ if v <= -p1 => -2,
        _ if v < 0 => -1,
        0 => 0,
        _ if v < p1 => 1,
        _ if v < p2 => 2,
        _ if v < p3 => 3,
        _ => 4,
      })
      .collect();
    let line_width = if h.raw_type == 16 {
      h.block_width * 2 / 3
    } else {
      h.block_width / 2
    };
    Ok(Self {
      q_table,
      max_value,
      total_values,
      raw_bits,
      max_bits,
      max_diff: ((total_values + 0x20) >> 6).max(2),
      min_value: 0x40,
      line_width,
    })
  }

  #[inline]
  fn q(&self, diff: i32) -> i32 {
    self.q_table[(diff + self.max_value) as usize] as i32
  }
}

/// Line-buffer slots. Each colour group starts with two history rows.
mod slot {
  pub const R2: usize = 2;
  pub const R3: usize = 3;
  pub const R4: usize = 4;
  pub const G2: usize = 7;
  pub const G3: usize = 8;
  pub const G4: usize = 9;
  pub const G5: usize = 10;
  pub const G6: usize = 11;
  pub const G7: usize = 12;
  pub const B2: usize = 15;
  pub const B3: usize = 16;
  pub const B4: usize = 17;
  pub const TOTAL: usize = 18;
}

/// How even positions of a line are produced during a pass.
#[derive(Clone, Copy)]
enum Even {
  Interpolate,
  Code,
  /// Code when pos % 4 != 0, interpolate otherwise.
  CodeUnlessMultipleOf4,
  /// Interpolate when pos % 4 == 2, code otherwise.
  InterpolateIf2Mod4,
}

impl Even {
  #[inline]
  fn coded(self, pos: usize) -> bool {
    match self {
      Even::Interpolate => false,
      Even::Code => true,
      Even::CodeUnlessMultipleOf4 => pos & 3 != 0,
      Even::InterpolateIf2Mod4 => pos & 3 != 2,
    }
  }
}

struct Pass {
  grads: usize,
  first: (usize, Even),
  second: (usize, Even),
  /// Colour groups whose borders are refreshed after the pass.
  extend: [(usize, usize); 2],
}

const RED: (usize, usize) = (slot::R2, slot::R4);
const GREEN: (usize, usize) = (slot::G2, slot::G7);
const BLUE: (usize, usize) = (slot::B2, slot::B4);

/// The six passes that decode one X-Trans line (six sensor rows). Each pass fills one
/// row from two colour groups; which even positions are coded rather than
/// interpolated follows from where the X-Trans pattern places samples of that colour.
/// Verified against RawCamera's decoder output.
const XTRANS_PASSES: [Pass; 6] = [
  Pass {
    grads: 0,
    first: (slot::R2, Even::Interpolate),
    second: (slot::G2, Even::Code),
    extend: [RED, GREEN],
  },
  Pass {
    grads: 1,
    first: (slot::G3, Even::Code),
    second: (slot::B2, Even::Interpolate),
    extend: [GREEN, BLUE],
  },
  Pass {
    grads: 2,
    first: (slot::R3, Even::CodeUnlessMultipleOf4),
    second: (slot::G4, Even::Interpolate),
    extend: [RED, GREEN],
  },
  Pass {
    grads: 0,
    first: (slot::G5, Even::Code),
    second: (slot::B3, Even::InterpolateIf2Mod4),
    extend: [GREEN, BLUE],
  },
  Pass {
    grads: 1,
    first: (slot::R4, Even::InterpolateIf2Mod4),
    second: (slot::G6, Even::Code),
    extend: [RED, GREEN],
  },
  Pass {
    grads: 2,
    first: (slot::G7, Even::Interpolate),
    second: (slot::B4, Even::CodeUnlessMultipleOf4),
    extend: [GREEN, BLUE],
  },
];

/// Adaptive residual statistics for one gradient context.
#[derive(Clone, Copy)]
struct Grad {
  sum: i32,
  count: i32,
}

struct Stripe<'a> {
  p: &'a Params,
  bits: BitReader<'a>,
  /// TOTAL rows of (line_width + 2): left border, samples, right border.
  lines: Vec<u16>,
  stride: usize,
  grad_even: [[Grad; 41]; 3],
  grad_odd: [[Grad; 41]; 3],
}

impl<'a> Stripe<'a> {
  fn new(p: &'a Params, data: &'a [u8]) -> Self {
    let g = Grad {
      sum: p.max_diff,
      count: 1,
    };
    let stride = p.line_width + 2;
    Self {
      p,
      bits: BitReader::new(data),
      lines: vec![0; slot::TOTAL * stride],
      stride,
      grad_even: [[g; 41]; 3],
      grad_odd: [[g; 41]; 3],
    }
  }

  /// Buffer index of sample `pos` in `line`.
  #[inline]
  fn idx(&self, line: usize, pos: usize) -> usize {
    line * self.stride + 1 + pos
  }

  /// Decode one residual with the context's adaptive parameters; returns the signed value.
  #[inline]
  fn residual(&mut self, grad: &mut Grad) -> Result<i32> {
    let p = self.p;
    let zeros = self.bits.read_unary_zeros(p.max_bits)?;
    let mut code = if zeros < p.max_bits - p.raw_bits - 1 {
      let mut k = 0u32;
      if grad.count < grad.sum {
        while k <= 14 {
          k += 1;
          if (grad.count << k) >= grad.sum {
            break;
          }
        }
      }
      ((zeros << k) | self.bits.read(k)) as i32
    } else {
      self.bits.read(p.raw_bits) as i32 + 1
    };
    if code < 0 || code >= p.total_values {
      return Err(Error::Corrupt(format!(
        "residual out of range (zeros {zeros}, code {code})"
      )));
    }
    code = if code & 1 != 0 {
      -1 - code / 2
    } else {
      code / 2
    };
    grad.sum += code.abs();
    if grad.count == p.min_value {
      grad.sum >>= 1;
      grad.count >>= 1;
    }
    grad.count += 1;
    Ok(code)
  }

  #[inline]
  fn store(&mut self, i: usize, predicted: i32, sign_negative: bool, code: i32) {
    let p = self.p;
    let mut v = if sign_negative {
      predicted - code
    } else {
      predicted + code
    };
    if v < 0 {
      v += p.total_values;
    } else if v > p.max_value {
      v -= p.total_values;
    }
    self.lines[i] = if v >= 0 { v.min(p.max_value) as u16 } else { 0 };
  }

  /// Neighbours of an even position: (b above, c above-left, d above-right, f two above).
  #[inline]
  fn even_neighbours(&self, i: usize) -> (i32, i32, i32, i32) {
    let s = self.stride;
    (
      self.lines[i - s] as i32,
      self.lines[i - s - 1] as i32,
      self.lines[i - s + 1] as i32,
      self.lines[i - 2 * s] as i32,
    )
  }

  /// Edge-directed prediction from the row above: average along the smoothest direction.
  #[inline]
  fn even_prediction(rb: i32, rc: i32, rd: i32, rf: i32) -> i32 {
    let (dc, df, dd) = ((rc - rb).abs(), (rf - rb).abs(), (rd - rb).abs());
    (if dc > df && dc > dd {
      rf + rd + 2 * rb
    } else if dd > dc && dd > df {
      rf + rc + 2 * rb
    } else {
      rd + rc + 2 * rb
    }) >> 2
  }

  fn interpolate_even(&mut self, line: usize, pos: usize) {
    let i = self.idx(line, pos);
    let (rb, rc, rd, rf) = self.even_neighbours(i);
    self.lines[i] = Self::even_prediction(rb, rc, rd, rf) as u16;
  }

  fn code_even(&mut self, line: usize, pos: usize, set: usize) -> Result<()> {
    let i = self.idx(line, pos);
    let (rb, rc, rd, rf) = self.even_neighbours(i);
    let grad = self.p.q(rb - rf) * 9 + self.p.q(rc - rb);
    let predicted = Self::even_prediction(rb, rc, rd, rf);
    let mut g = self.grad_even[set][grad.unsigned_abs() as usize];
    let code = self.residual(&mut g)?;
    self.grad_even[set][grad.unsigned_abs() as usize] = g;
    self.store(i, predicted, grad < 0, code);
    Ok(())
  }

  fn code_odd(&mut self, line: usize, pos: usize, set: usize) -> Result<()> {
    let i = self.idx(line, pos);
    let s = self.stride;
    let ra = self.lines[i - 1] as i32;
    let rb = self.lines[i - s] as i32;
    let rc = self.lines[i - s - 1] as i32;
    let rd = self.lines[i - s + 1] as i32;
    let rg = self.lines[i + 1] as i32;
    let grad = self.p.q(rb - rc) * 9 + self.p.q(rc - ra);
    let predicted = if (rb > rc && rb > rd) || (rb < rc && rb < rd) {
      (rg + ra + 2 * rb) >> 2
    } else {
      (ra + rg) >> 1
    };
    let mut g = self.grad_odd[set][grad.unsigned_abs() as usize];
    let code = self.residual(&mut g)?;
    self.grad_odd[set][grad.unsigned_abs() as usize] = g;
    self.store(i, predicted, grad < 0, code);
    Ok(())
  }

  /// Copy each line's first/last sample of the row above into its borders.
  fn extend(&mut self, (start, end): (usize, usize)) {
    let w = self.p.line_width;
    for line in start..=end {
      let above = self.idx(line - 1, 0);
      let here = line * self.stride;
      self.lines[here] = self.lines[above];
      self.lines[here + w + 1] = self.lines[above + w - 1];
    }
  }

  fn decode_even_slot(
    &mut self,
    (line, rule): (usize, Even),
    pos: usize,
    set: usize,
  ) -> Result<()> {
    if rule.coded(pos) {
      self.code_even(line, pos, set)
    } else {
      self.interpolate_even(line, pos);
      Ok(())
    }
  }

  /// Decode the six sensor rows of one line into the line buffers.
  fn decode_xtrans_line(&mut self) -> Result<()> {
    let w = self.p.line_width;
    for pass in &XTRANS_PASSES {
      let (mut even, mut odd) = (0usize, 1usize);
      while even < w || odd < w {
        if even < w {
          self.decode_even_slot(pass.first, even, pass.grads)?;
          self.decode_even_slot(pass.second, even, pass.grads)?;
          even += 2;
        }
        if even > 8 {
          self.code_odd(pass.first.0, odd, pass.grads)?;
          self.code_odd(pass.second.0, odd, pass.grads)?;
          odd += 2;
        }
      }
      for group in pass.extend {
        self.extend(group);
      }
    }
    Ok(())
  }

  /// Shift the last two decoded rows of each colour into the history rows and clear
  /// the rows for the next line, seeding their borders from the new history.
  fn advance(&mut self) {
    let s = self.stride;
    for (dst, src) in [(0, 3), (1, 4), (5, 11), (6, 12), (13, 16), (14, 17)] {
      self.lines.copy_within(src * s..(src + 1) * s, dst * s);
    }
    let w = self.p.line_width;
    for (first, count) in [(slot::R2, 3), (slot::G2, 6), (slot::B2, 3)] {
      self.lines[first * s..(first + count) * s].fill(0);
      let above = (first - 1) * s;
      self.lines[first * s] = self.lines[above + 1];
      self.lines[first * s + w + 1] = self.lines[above + w];
    }
  }
}

/// Map an output column within a six-row line to its index in a colour line buffer.
#[inline]
fn xtrans_buffer_index(col: usize) -> usize {
  (((col * 2 / 3) & !1) | ((col % 3) & 1)) + ((col % 3) >> 1)
}

/// Decode a full compressed strip into `raw_width * raw_height` samples (row-major).
pub fn decode(strip: &[u8], cfa: &CfaPattern) -> Result<(Header, Vec<u16>)> {
  let h = Header::parse(strip)?;
  if h.raw_type != 16 {
    return Err(Error::Unsupported("compressed Bayer RAF".into()));
  }
  if !cfa.is_xtrans() {
    return Err(Error::Unsupported(
      "compressed X-Trans data with non-X-Trans pattern".into(),
    ));
  }
  let p = Params::new(&h)?;

  let mut offset = 16 + 4 * h.blocks;
  let sizes: Vec<usize> = (0..h.blocks)
    .map(|i| u32::from_be_bytes(strip[16 + 4 * i..20 + 4 * i].try_into().unwrap()) as usize)
    .collect();
  if offset & 0xc != 0 {
    offset += 0x10 - (offset & 0xc);
  }
  let mut ranges = Vec::with_capacity(h.blocks);
  for &size in &sizes {
    let end = offset.checked_add(size).filter(|&e| e <= strip.len());
    let end = end.ok_or_else(|| Error::Corrupt("block exceeds strip".into()))?;
    ranges.push(offset..end);
    offset = end;
  }

  // Colour line slot for each (row within line, column % 6).
  let mut route = [[0usize; 6]; 6];
  for (r, row) in route.iter_mut().enumerate() {
    for (c, slot) in row.iter_mut().enumerate() {
      *slot = match cfa.at(r, c) {
        Channel::Red => slot::R2 + r / 2,
        Channel::Green => slot::G2 + r,
        Channel::Blue => slot::B2 + r / 2,
      };
    }
  }
  let index_lut: Vec<usize> = (0..h.block_width).map(xtrans_buffer_index).collect();

  let stripes: Vec<Vec<u16>> = ranges
    .par_iter()
    .enumerate()
    .map(|(block, range)| -> Result<Vec<u16>> {
      let width = if block + 1 == h.blocks {
        h.raw_width - h.block_width * block
      } else {
        h.block_width
      };
      let mut out = vec![0u16; width * h.raw_height];
      let mut s = Stripe::new(&p, &strip[range.clone()]);
      for line in 0..h.total_lines {
        s.decode_xtrans_line()
          .map_err(|e| Error::Corrupt(format!("block {block} line {line}: {e}")))?;
        if s.bits.overrun() {
          return Err(Error::Corrupt(format!(
            "block {block} ran out of data at line {line}"
          )));
        }
        for r in 0..6 {
          let row = &mut out[(line * 6 + r) * width..(line * 6 + r + 1) * width];
          for (col, px) in row.iter_mut().enumerate() {
            *px = s.lines[s.idx(route[r][col % 6], index_lut[col])];
          }
        }
        s.advance();
      }
      Ok(out)
    })
    .collect::<Result<_>>()?;

  let mut image = vec![0u16; h.raw_width * h.raw_height];
  for (block, stripe) in stripes.iter().enumerate() {
    let x0 = block * h.block_width;
    let width = stripe.len() / h.raw_height;
    for y in 0..h.raw_height {
      image[y * h.raw_width + x0..y * h.raw_width + x0 + width]
        .copy_from_slice(&stripe[y * width..(y + 1) * width]);
    }
  }
  Ok((h, image))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn buffer_index_pattern() {
    let idx: Vec<usize> = (0..12).map(xtrans_buffer_index).collect();
    assert_eq!(idx, vec![0, 1, 1, 2, 3, 3, 4, 5, 5, 6, 7, 7]);
  }

  #[test]
  fn quantisation_thresholds() {
    let h = Header {
      version: 1,
      raw_type: 16,
      raw_bits: 14,
      raw_height: 6,
      rounded_width: 768,
      raw_width: 768,
      block_width: 768,
      blocks: 1,
      total_lines: 1,
    };
    let p = Params::new(&h).unwrap();
    assert_eq!(p.line_width, 512);
    assert_eq!(p.max_diff, 256);
    for (d, q) in [
      (-0x3fff, -4),
      (-0x114, -4),
      (-0x113, -3),
      (-0x43, -3),
      (-0x12, -2),
      (-1, -1),
      (0, 0),
      (0x11, 1),
      (0x12, 2),
      (0x42, 2),
      (0x43, 3),
      (0x114, 4),
    ] {
      assert_eq!(p.q(d), q, "diff {d}");
    }
  }

  #[test]
  fn even_rules_cover_xtrans_line_positions() {
    // R3 receives buffer indices 1,2,3 (mod 4) from rows 2-3; position 0 is interpolated.
    assert!(!Even::CodeUnlessMultipleOf4.coded(0));
    assert!(Even::CodeUnlessMultipleOf4.coded(2));
    assert!(!Even::InterpolateIf2Mod4.coded(2));
    assert!(Even::InterpolateIf2Mod4.coded(4));
  }

  #[test]
  fn rejects_bad_header() {
    let mut b = [0u8; 16];
    assert!(Header::parse(&b).is_err());
    b[..2].copy_from_slice(&[0x49, 0x53]);
    assert!(Header::parse(&b).is_err());
  }
}
