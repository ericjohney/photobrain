//! Signed 16-bit boundaries around CR6 noise reduction.
//!
//! Adobe 18.7 flattens RIMM sensor noise, packs optimized YCC about a chroma
//! centre of 0.5, filters, then reverses both operations. Matrix coefficients
//! and affine offsets are rounded separately before the signed integer dot
//! product (`cr_stage_matrix3by3`). Table expansion follows the DNG SDK.

use super::noise::NoiseCurve;
use crate::adobe::bayer::tables;
use crate::math::Mat3;

pub(crate) struct Space {
  encode: Vec<u16>,
  decode: Vec<u16>,
  forward: FixedMatrix,
  inverse: FixedMatrix,
}

impl Space {
  pub(crate) fn new(curve: &NoiseCurve, ycc: Mat3, inverse_ycc: Mat3, encoded_black: f64) -> Self {
    Self {
      encode: tables::expand(|v| curve.encode(v)),
      decode: tables::expand(|v| curve.decode(v)),
      forward: FixedMatrix::new(ycc, encoded_black, Direction::ToYcc),
      inverse: FixedMatrix::new(inverse_ycc, encoded_black, Direction::ToRgb),
    }
  }

  #[inline]
  pub(crate) fn encode(&self, pixel: [f32; 3]) -> [u16; 3] {
    self
      .forward
      .apply(pixel.map(|v| self.encode[tables::code(v) as usize]))
  }

  #[inline]
  pub(crate) fn decode(&self, pixel: [u16; 3]) -> [f32; 3] {
    self
      .inverse
      .apply(pixel)
      .map(|v| tables::normalized(self.decode[v as usize]))
  }
}

#[derive(Clone, Copy)]
enum Direction {
  ToYcc,
  ToRgb,
}

struct FixedMatrix {
  shift: u32,
  rows: [[i64; 4]; 3],
}

impl FixedMatrix {
  fn new(matrix: Mat3, black: f64, direction: Direction) -> Self {
    let range = -(black - 1.0);
    let inverse_range = if black == 1.0 {
      0.0
    } else {
      -1.0 / (black - 1.0)
    };
    let black_bias = -black * inverse_range;
    let (input_scale, input_bias, output_scale, output_bias, chroma_bias) = match direction {
      Direction::ToYcc => (
        [inverse_range; 3],
        [black_bias; 3],
        [range, 1.0, 1.0],
        [black, 0.0, 0.0],
        0.5,
      ),
      Direction::ToRgb => (
        [inverse_range, 1.0, 1.0],
        [black_bias, -0.5, -0.5],
        [range; 3],
        [black; 3],
        0.0,
      ),
    };
    let affine: [[f64; 4]; 3] = std::array::from_fn(|r| {
      let m = matrix.0[r];
      [
        output_scale[r] * input_scale[0] * m[0],
        m[1] * input_scale[1] * output_scale[r],
        m[2] * input_scale[2] * output_scale[r],
        output_bias[r]
          + (if r == 0 { 0.0 } else { chroma_bias }
            + input_bias[1] * m[1]
            + input_bias[0] * m[0]
            + input_bias[2] * m[2])
            * output_scale[r],
      ]
    });
    for shift in (8..=14).rev() {
      let scale = (1u32 << shift) as f64;
      let mut rows = [[0; 4]; 3];
      let mut valid = true;
      for r in 0..3 {
        let m = affine[r];
        let positive = m[..3].iter().map(|v| (v * scale).max(0.0)).sum::<f64>();
        let negative = -m[..3].iter().map(|v| (v * scale).min(0.0)).sum::<f64>();
        valid &= positive.max(negative) <= 30000.0;
        for c in 0..3 {
          rows[r][c] = (m[c] * scale).round() as i64;
        }
        rows[r][3] = (m[3] * scale).round() as i64 * 65535
          + rows[r][..3].iter().sum::<i64>() * 32768
          - (1i64 << shift) * 32768
          + (1i64 << (shift - 1));
        let bound = rows[r][..3].iter().map(|v| v.abs()).sum::<i64>() * 32768;
        valid &= rows[r][3] - bound >= i32::MIN as i64 && rows[r][3] + bound <= i32::MAX as i64;
      }
      if valid {
        return Self { shift, rows };
      }
    }
    unreachable!("CR6 YCC matrix fits signed fixed point")
  }

  #[inline]
  fn apply(&self, pixel: [u16; 3]) -> [u16; 3] {
    let x = pixel.map(|v| i64::from(v) - 32768);
    self.rows.map(|row| {
      (((row[0] * x[0] + row[1] * x[1] + row[2] * x[2] + row[3]) >> self.shift)
        .clamp(-32768, 32767)
        + 32768) as u16
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn captured_ycc_integer_coefficients() {
    let matrix = Mat3([
      [0.1872599470891074, 0.6618075651592447, 0.15093248775164778],
      [
        0.49999999999999994,
        -0.4071459027944597,
        -0.09285409720554018,
      ],
      [-0.11027388540237415, -0.38972611459762574, 0.5],
    ]);
    let fixed = FixedMatrix::new(matrix, 0.25, Direction::ToYcc);
    assert_eq!(fixed.shift, 14);
    assert_eq!(
      fixed.rows,
      [
        [3068, 10843, 2473, 8192],
        [10923, -8894, -2028, 32768],
        [-2409, -8514, 10923, 0],
      ]
    );
    let inverse = Mat3([
      [
        1.0000000000000002,
        1.6254801058217854,
        -4.933840074652368e-18,
      ],
      [
        1.0000000000000002,
        -0.4599332715958639,
        -0.38727835292094454,
      ],
      [1.0, 2.661321659716714e-17, 1.6981350244967044],
    ]);
    let fixed = FixedMatrix::new(inverse, 0.25, Direction::ToRgb);
    assert_eq!(fixed.shift, 13);
    assert_eq!(
      fixed.rows,
      [
        [8192, 9987, 0, 41857],
        [8192, -2826, -2379, 34261],
        [8192, 0, 10433, -23455],
      ]
    );
  }
}
