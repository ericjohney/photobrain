//! Robertson xy/temperature/tint conversion, following the public DNG SDK's
//! `dng_temperature.cpp`. The isotherm data is from Wyszecki & Stiles, Color
//! Science, second edition, p. 228. This is separate from Apple's colour path.

const TINT_SCALE: f64 = -3000.0;
const ISOTHERMS: [[f64; 4]; 31] = [
  [0.0, 0.18006, 0.26352, -0.24341],
  [10.0, 0.18066, 0.26589, -0.25479],
  [20.0, 0.18133, 0.26846, -0.26876],
  [30.0, 0.18208, 0.27119, -0.28539],
  [40.0, 0.18293, 0.27407, -0.30470],
  [50.0, 0.18388, 0.27709, -0.32675],
  [60.0, 0.18494, 0.28021, -0.35156],
  [70.0, 0.18611, 0.28342, -0.37915],
  [80.0, 0.18740, 0.28668, -0.40955],
  [90.0, 0.18880, 0.28997, -0.44278],
  [100.0, 0.19032, 0.29326, -0.47888],
  [125.0, 0.19462, 0.30141, -0.58204],
  [150.0, 0.19962, 0.30921, -0.70471],
  [175.0, 0.20525, 0.31647, -0.84901],
  [200.0, 0.21142, 0.32312, -1.0182],
  [225.0, 0.21807, 0.32909, -1.2168],
  [250.0, 0.22511, 0.33439, -1.4512],
  [275.0, 0.23247, 0.33904, -1.7298],
  [300.0, 0.24010, 0.34308, -2.0637],
  [325.0, 0.24702, 0.34655, -2.4681],
  [350.0, 0.25591, 0.34951, -2.9641],
  [375.0, 0.26400, 0.35200, -3.5814],
  [400.0, 0.27218, 0.35407, -4.3633],
  [425.0, 0.28039, 0.35577, -5.3762],
  [450.0, 0.28863, 0.35714, -6.7262],
  [475.0, 0.29685, 0.35823, -8.5955],
  [500.0, 0.30505, 0.35907, -11.324],
  [525.0, 0.31320, 0.35968, -15.628],
  [550.0, 0.32129, 0.36011, -23.325],
  [575.0, 0.32931, 0.36038, -40.770],
  [600.0, 0.33724, 0.36051, -116.45],
];

/// Correlated colour temperature and Adobe tint from CIE xy.
pub(crate) fn from_xy((x, y): (f64, f64)) -> (f64, f64) {
  let u = 2.0 * x / (1.5 - x + 6.0 * y);
  let v = 3.0 * y / (1.5 - x + 6.0 * y);
  let mut last_distance = 0.0;
  let mut last_direction = (0.0, 0.0);
  for i in 1..31 {
    let row = ISOTHERMS[i];
    let length = (1.0 + row[3] * row[3]).sqrt();
    let (mut du, mut dv) = (1.0 / length, row[3] / length);
    let distance = -(u - row[1]) * dv + (v - row[2]) * du;
    if distance <= 0.0 || i == 30 {
      let distance = -distance.min(0.0);
      let f = if i == 1 {
        0.0
      } else {
        distance / (last_distance + distance)
      };
      let previous = ISOTHERMS[i - 1];
      let temperature = 1e6 / (previous[0] * f + row[0] * (1.0 - f));
      let uu = u - (previous[1] * f + row[1] * (1.0 - f));
      let vv = v - (previous[2] * f + row[2] * (1.0 - f));
      du = du * (1.0 - f) + last_direction.0 * f;
      dv = dv * (1.0 - f) + last_direction.1 * f;
      let length = (du * du + dv * dv).sqrt();
      return (
        temperature,
        (uu * (du / length) + vv * (dv / length)) * TINT_SCALE,
      );
    }
    last_distance = distance;
    last_direction = (du, dv);
  }
  unreachable!()
}

/// The inverse Robertson transform, `dng_temperature::Get_xy_coord`.
pub(crate) fn to_xy(temperature: f64, tint: f64) -> (f64, f64) {
  let reciprocal = 1e6 / temperature;
  let offset = tint * (1.0 / TINT_SCALE);
  for i in 0..30 {
    let a = ISOTHERMS[i];
    let b = ISOTHERMS[i + 1];
    if reciprocal < b[0] || i == 29 {
      let f = (b[0] - reciprocal) / (b[0] - a[0]);
      let mut u = a[1] * f + b[1] * (1.0 - f);
      let mut v = a[2] * f + b[2] * (1.0 - f);
      let length_a = (1.0 + a[3] * a[3]).sqrt();
      let length_b = (1.0 + b[3] * b[3]).sqrt();
      let du = (1.0 / length_a) * f + (1.0 / length_b) * (1.0 - f);
      let dv = (a[3] / length_a) * f + (b[3] / length_b) * (1.0 - f);
      let length = (du * du + dv * dv).sqrt();
      u += (du / length) * offset;
      v += (dv / length) * offset;
      let denominator = u - 4.0 * v + 2.0;
      return (1.5 * u / denominator, v / denominator);
    }
  }
  unreachable!()
}

/// Camera Raw's as-shot white passes through its integer temperature/tint UI
/// grid (`RoundWhiteXY`). This is separate from an explicitly requested WB.
pub(crate) fn round_as_shot(xy: (f64, f64)) -> (f64, f64) {
  let (temperature, tint) = from_xy(xy);
  let temperature = temperature.round().clamp(2000.0, 50000.0);
  let slider = if temperature <= 7900.0 {
    (temperature - 2000.0) / 50.0
  } else if temperature <= 10000.0 {
    118.0 + (temperature - 7900.0) / 100.0
  } else if temperature <= 17000.0 {
    139.0 + (temperature - 10000.0) / 250.0
  } else {
    167.0 + (temperature - 17000.0) / 1000.0
  }
  .round();
  let temperature = if slider < 119.0 {
    2000.0 + slider * 50.0
  } else if slider < 140.0 {
    7900.0 + (slider - 118.0) * 100.0
  } else if slider < 168.0 {
    10000.0 + (slider - 139.0) * 250.0
  } else {
    50000.0 + (slider - 200.0) * 1000.0
  };
  to_xy(temperature, tint.round().clamp(-150.0, 150.0))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn d50_matches_converter_temperature() {
    // Captured at dng_temperature::Set_xy_coord's return in Adobe 18.7.
    assert_eq!(from_xy((0.3457, 0.3585)).0, 5000.706605070579);
  }

  #[test]
  fn requested_render_white_matches_converter() {
    let xy = to_xy(5550.0, 12.0);
    assert_eq!(xy, (0.33127982884679963, 0.3477748384714136));
  }

  #[test]
  fn as_shot_white_uses_temperature_grid_and_integer_tint() {
    for (temperature, rounded) in [
      (5524.0, 5500.0),
      (5526.0, 5550.0),
      (7910.0, 7900.0),
      (7960.0, 8000.0),
      (10090.0, 10000.0),
      (10130.0, 10250.0),
      (17200.0, 17000.0),
      (17800.0, 18000.0),
    ] {
      assert_eq!(
        round_as_shot(to_xy(temperature, 11.4)),
        to_xy(rounded, 11.0)
      );
    }
  }
}
