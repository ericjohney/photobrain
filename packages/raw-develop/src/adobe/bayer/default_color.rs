//! Default D50 camera white used by Adobe 18.7's Bayer demosaic.
//!
//! `cr_mosaic_info::PostParse` creates the negative's default colour specification
//! and calls `SetWhiteXY(PCStoXY())`. This precedes selection of a user DCP: notably,
//! the ILCE-1M2 defaults differ from its installed Adobe Standard profile. The
//! coefficients below were read from that default specification for original ARWs
//! from all three supported Sony models. They are small calibration matrices, not
//! a bundled DCP. The interpolation and normalisation follow the public DNG SDK.

use crate::error::{Error, Result};

// The SDK's Robertson conversion at the fixed PCS white (.3457, .3585).
// Verified at dng_temperature::Set_xy_coord's return in Adobe 18.7.
const D50_TEMPERATURE: f64 = 5000.706605070579;
const ILLUMINANT_1_TEMPERATURE: f64 = 2850.0;
const ILLUMINANT_2_TEMPERATURE: f64 = 6500.0;

// Stored as signed ten-thousandths because dng_matrix::Round multiplies each
// integer by 1/10000. Dividing instead changes some doubles by one ULP.
const A1M2: [[i32; 9]; 2] = [
  [12010, -6965, 665, -4276, 12077, 2480, -167, 625, 7188],
  [10058, -4074, -932, -4777, 12731, 2274, -544, 1282, 6102],
];
const A7CR_RM5: [[i32; 9]; 2] = [
  [9185, -4857, 505, -3651, 11061, 2982, -161, 698, 6769],
  [8200, -2976, -719, -4296, 12053, 2532, -429, 1282, 5774],
];

/// D50 gains, normalised to a maximum of one, in camera RGB order.
/// `calibration` is the file's diagonal CameraCalibration (identity if absent).
pub(super) fn gains(model: &str, calibration: [f64; 3]) -> Result<[f64; 3]> {
  let matrices = match model {
    "ILCE-1M2" => &A1M2,
    "ILCE-7CR" | "ILCE-7RM5" => &A7CR_RM5,
    _ => {
      return Err(Error::Unsupported(format!(
        "Adobe Bayer default colour for {model}"
      )));
    }
  };
  let calibration = calibration.map(|v| (v * 10000.0).round() * 0.0001);
  let reciprocal_2 = 1.0 / ILLUMINANT_2_TEMPERATURE;
  let weight =
    (1.0 / D50_TEMPERATURE - reciprocal_2) / (1.0 / ILLUMINANT_1_TEMPERATURE - reciprocal_2);
  let xyz = [0.3457 / 0.3585, 1.0, (1.0 - 0.3457 - 0.3585) / 0.3585];
  let white: [f64; 3] = std::array::from_fn(|row| {
    let mut sum = 0.0;
    for (column, &coordinate) in xyz.iter().enumerate() {
      let k = row * 3 + column;
      let a = f64::from(matrices[0][k]) * 0.0001 * calibration[row];
      let b = f64::from(matrices[1][k]) * 0.0001 * calibration[row];
      // The two scalar matrix products and their sum are separate operations.
      let coefficient = weight * a + (1.0 - weight) * b;
      sum = coefficient.mul_add(coordinate, sum);
    }
    sum
  });
  let maximum = white.into_iter().fold(f64::NEG_INFINITY, f64::max);
  let inverse_maximum = 1.0 / maximum;
  let white = white.map(|v| (v * inverse_maximum).clamp(0.001, 1.0));
  // MakeGain normalises CameraWhite again, even though SetWhiteXY just did so.
  // Its largest entry can be one ULP below one after reciprocal multiplication.
  let inverse_maximum = 1.0 / white.into_iter().fold(f64::NEG_INFINITY, f64::max);
  let white = white.map(|v| v * inverse_maximum);
  let minimum = white.into_iter().fold(f64::INFINITY, f64::min);
  Ok(white.map(|v| minimum / v))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn matches_captured_original_arw_gains() {
    for (model, calibration, expected) in [
      (
        "ILCE-1M2",
        [2127.0 / 2156.0, 1.0, 1653.0 / 1800.0],
        [1.0, 0.4861386916117311, 0.8922941531572025],
      ),
      (
        "ILCE-1M2",
        [2127.0 / 2154.0, 1.0, 1653.0 / 1817.0],
        [1.0, 0.4866314829869078, 0.9016426599521218],
      ),
      (
        "ILCE-7CR",
        [2423.0 / 2613.0, 1.0, 1799.0 / 1767.0],
        [1.0, 0.40397626084004873, 0.6902527658760981],
      ),
      (
        "ILCE-7RM5",
        [2423.0 / 2535.0, 1.0, 1799.0 / 1779.0],
        [1.0, 0.4163922248581027, 0.7163220146043124],
      ),
    ] {
      let actual = gains(model, calibration).unwrap();
      assert_eq!(
        actual.map(f64::to_bits),
        expected.map(f64::to_bits),
        "{model}"
      );
    }
  }
}
