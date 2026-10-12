//! Colour filter array patterns.

use crate::error::{Result, malformed};

/// Colour of a photosite.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Channel {
  Red = 0,
  Green = 1,
  Blue = 2,
}

impl Channel {
  pub fn from_index(i: u8) -> Option<Self> {
    match i {
      0 => Some(Self::Red),
      1 => Some(Self::Green),
      2 => Some(Self::Blue),
      _ => None,
    }
  }
}

/// A repeating CFA pattern addressed in absolute sensor coordinates (row 0, col 0 is
/// the first readout photosite, before any crop).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CfaPattern {
  pub width: usize,
  pub height: usize,
  cells: Vec<Channel>,
}

impl CfaPattern {
  pub fn new(width: usize, height: usize, cells: Vec<Channel>) -> Result<Self> {
    if width == 0 || height == 0 || cells.len() != width * height {
      return malformed("CFA pattern dimensions");
    }
    Ok(Self {
      width,
      height,
      cells,
    })
  }

  /// Parse the RAF CFA-header record 0x131: 36 bytes (0 = R, 1 = G, 2 = B) stored in
  /// reverse raster order relative to absolute sensor coordinates.
  pub fn from_raf_xtrans_layout(bytes: &[u8]) -> Result<Self> {
    if bytes.len() != 36 {
      return malformed("X-Trans layout must be 36 bytes");
    }
    let mut cells = Vec::with_capacity(36);
    for i in 0..36 {
      let v = bytes[35 - i] & 3;
      match Channel::from_index(v) {
        Some(c) => cells.push(c),
        None => return malformed("X-Trans layout value"),
      }
    }
    let p = Self::new(6, 6, cells)?;
    let greens = p.cells.iter().filter(|&&c| c == Channel::Green).count();
    if greens != 20 {
      return malformed(format!("X-Trans layout has {greens} greens, expected 20"));
    }
    Ok(p)
  }

  /// The standard X-Trans pattern used by current Fujifilm sensors, with the 2x2 green
  /// blocks at (0,0) / (0,3) / (3,0) / (3,3).
  pub fn xtrans_default() -> Self {
    use Channel::{Blue as B, Green as G, Red as R};
    #[rustfmt::skip]
    let cells = vec![
      G, G, R, G, G, B,
      G, G, B, G, G, R,
      B, R, G, R, B, G,
      G, G, B, G, G, R,
      G, G, R, G, G, B,
      R, B, G, B, R, G,
    ];
    Self {
      width: 6,
      height: 6,
      cells,
    }
  }

  #[inline]
  pub fn at(&self, row: usize, col: usize) -> Channel {
    self.cells[(row % self.height) * self.width + (col % self.width)]
  }

  pub fn is_xtrans(&self) -> bool {
    self.width == 6 && self.height == 6
  }

  /// Pattern as seen from an origin shifted by (top, left), e.g. after cropping.
  pub fn shifted(&self, top: usize, left: usize) -> Self {
    let mut cells = Vec::with_capacity(self.cells.len());
    for r in 0..self.height {
      for c in 0..self.width {
        cells.push(self.at(r + top, c + left));
      }
    }
    Self {
      width: self.width,
      height: self.height,
      cells,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_reversed_raf_layout() {
    // X-E5 record 0x131 as stored in DSCF0970.RAF.
    let bytes = [
      1, 0, 2, 1, 2, 0, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2, 1, 1, 1, 2, 0, 1, 0, 2, 0, 1, 1, 2, 1, 1, 2,
      1, 1, 0, 1, 1,
    ];
    let p = CfaPattern::from_raf_xtrans_layout(&bytes).unwrap();
    assert_eq!(p, CfaPattern::xtrans_default());
  }

  #[test]
  fn shifted_pattern_matches_offsets() {
    let p = CfaPattern::xtrans_default();
    let s = p.shifted(21, 12);
    for r in 0..12 {
      for c in 0..12 {
        assert_eq!(s.at(r, c), p.at(r + 21, c + 12));
      }
    }
  }

  #[test]
  fn every_row_and_column_has_all_colours() {
    let p = CfaPattern::xtrans_default();
    for i in 0..6 {
      for ch in [Channel::Red, Channel::Green, Channel::Blue] {
        assert!((0..6).any(|j| p.at(i, j) == ch));
        assert!((0..6).any(|j| p.at(j, i) == ch));
      }
    }
  }
}
