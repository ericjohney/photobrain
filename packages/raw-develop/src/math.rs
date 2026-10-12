//! Small linear-algebra helpers and colour-space constants.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat3(pub [[f64; 3]; 3]);

impl Mat3 {
  pub const IDENTITY: Mat3 = Mat3([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);

  pub fn from_rows(v: &[f64; 9]) -> Self {
    Mat3([[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]])
  }

  pub fn diag(d: [f64; 3]) -> Self {
    Mat3([[d[0], 0.0, 0.0], [0.0, d[1], 0.0], [0.0, 0.0, d[2]]])
  }

  pub fn mul(&self, o: &Mat3) -> Mat3 {
    let mut r = [[0.0; 3]; 3];
    for (i, row) in r.iter_mut().enumerate() {
      for (j, cell) in row.iter_mut().enumerate() {
        *cell = (0..3).map(|k| self.0[i][k] * o.0[k][j]).sum();
      }
    }
    Mat3(r)
  }

  pub fn mul_vec(&self, v: [f64; 3]) -> [f64; 3] {
    let m = &self.0;
    [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
  }

  pub fn scale(&self, s: f64) -> Mat3 {
    Mat3(self.0.map(|r| r.map(|c| c * s)))
  }

  pub fn add(&self, o: &Mat3) -> Mat3 {
    let mut r = self.0;
    for i in 0..3 {
      for j in 0..3 {
        r[i][j] += o.0[i][j];
      }
    }
    Mat3(r)
  }

  pub fn determinant(&self) -> f64 {
    let m = &self.0;
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  }

  pub fn inverse(&self) -> Mat3 {
    let m = &self.0;
    let d = self.determinant();
    let c = |a: usize, b: usize, e: usize, f: usize| m[a][b] * m[e][f] - m[a][f] * m[e][b];
    Mat3([
      [c(1, 1, 2, 2) / d, -c(0, 1, 2, 2) / d, c(0, 1, 1, 2) / d],
      [-c(1, 0, 2, 2) / d, c(0, 0, 2, 2) / d, -c(0, 0, 1, 2) / d],
      [c(1, 0, 2, 1) / d, -c(0, 0, 2, 1) / d, c(0, 0, 1, 1) / d],
    ])
  }

  pub fn to_f32(&self) -> [[f32; 3]; 3] {
    self.0.map(|r| r.map(|c| c as f32))
  }
}

/// XYZ (D50, the DNG profile connection space) to linear Display P3 (D65), including a
/// Bradford D50 -> D65 adaptation.
pub const XYZ_D50_TO_LINEAR_P3: Mat3 = Mat3([
  [2.404_123_06, -0.989_842_76, -0.397_637_005],
  [-0.842_214_593, 1.798_814_702, 0.016_054_71],
  [0.048_176_273, -0.097_355_393, 1.273_234_051],
]);

/// Linear Display P3 luminance weights (Y row of P3 -> XYZ D65).
pub const P3_LUMA: [f32; 3] = [0.228_974_56, 0.691_738_5, 0.079_286_91];

/// sRGB / Display P3 transfer function (IEC 61966-2-1), linear -> encoded.
#[inline]
pub fn srgb_encode(v: f32) -> f32 {
  if v <= 0.003_130_8 {
    12.92 * v
  } else {
    1.055 * v.powf(1.0 / 2.4) - 0.055
  }
}

#[inline]
pub fn srgb_decode(v: f32) -> f32 {
  if v <= 0.040_45 {
    v / 12.92
  } else {
    ((v + 0.055) / 1.055).powf(2.4)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn inverse_roundtrip() {
    let m = XYZ_D50_TO_LINEAR_P3;
    let i = m.mul(&m.inverse());
    for r in 0..3 {
      for c in 0..3 {
        assert!((i.0[r][c] - if r == c { 1.0 } else { 0.0 }).abs() < 1e-9);
      }
    }
  }

  #[test]
  fn d50_white_maps_to_p3_white() {
    let v = XYZ_D50_TO_LINEAR_P3.mul_vec([0.9642, 1.0, 0.8249]);
    for c in v {
      assert!((c - 1.0).abs() < 2e-3, "{v:?}");
    }
  }

  #[test]
  fn transfer_roundtrip() {
    for i in 0..=100 {
      let x = i as f32 / 100.0;
      assert!((srgb_decode(srgb_encode(x)) - x).abs() < 1e-5);
    }
  }
}
