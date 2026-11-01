//! Camera-to-ProPhoto colour for the Adobe engine, following the public DNG SDK
//! `dng_color_spec` (white xy from the camera neutral by iterating the interpolated
//! ColorMatrix, then the interpolated ForwardMatrix).
//! Robertson temperature conversion, per-body camera calibration and matrix
//! normalization follow the SDK. This does not change Apple colour rendering.

use super::dcp::{Dcp, HueSatMap};
use crate::math::Mat3;

const D50_XY: (f64, f64) = (0.3457, 0.3585);

fn camera_calibration(meta: &crate::metadata::RawMetadata) -> [f64; 3] {
  if let Some(levels) = meta.fuji_daylight_wb {
    return fuji_calibration(&meta.model, levels);
  }
  super::bayer::calibration::camera_calibration(&meta.model, meta.sony_daylight_wb)
}

// ReadFuji's SetSimpleCalibration, rounded by the negative to ten-thousandths.
// These are model daylight references, not per-file gains.
fn fuji_calibration(model: &str, levels: [f64; 3]) -> [f64; 3] {
  let reference = match model {
    "X100VI" => [615.0 / 302.0, 499.0 / 302.0],
    "X-E5" => [658.0 / 302.0, 494.0 / 302.0],
    _ => return [1.0; 3],
  };
  if levels.iter().any(|v| !v.is_finite() || *v <= 0.0) {
    return [1.0; 3];
  }
  let ratios = [
    (levels[0] / levels[1]) / reference[0],
    (levels[2] / levels[1]) / reference[1],
  ];
  if ratios.iter().any(|v| !(0.8..=1.25).contains(v)) {
    return [1.0; 3];
  }
  [1.0 / ratios[0], 1.0, 1.0 / ratios[1]].map(|v| (v * 10000.0).round() * 0.0001)
}

/// `dng_space_ProPhoto` RGB -> XYZ D50. The SDK normalizes the rounded
/// coefficients so device white maps exactly to the PCS white.
pub const PROPHOTO_TO_XYZ_D50: Mat3 = Mat3([
  [
    0.7977 * ((0.3457 / 0.3585) / (0.7977 + 0.1352 + 0.0313)),
    0.1352 * ((0.3457 / 0.3585) / (0.7977 + 0.1352 + 0.0313)),
    0.0313 * ((0.3457 / 0.3585) / (0.7977 + 0.1352 + 0.0313)),
  ],
  [
    0.2880 / (0.2880 + 0.7119 + 0.0001),
    0.7119 / (0.2880 + 0.7119 + 0.0001),
    0.0001 / (0.2880 + 0.7119 + 0.0001),
  ],
  [0.0000, 0.0000, (1.0 - 0.3457 - 0.3585) / 0.3585],
]);

fn xy_to_xyz((x, y): (f64, f64)) -> [f64; 3] {
  [x / y, 1.0, (1.0 - x - y) / y]
}

fn xy_to_cct(x: f64, y: f64) -> f64 {
  super::temperature::from_xy((x, y)).0
}

/// `dng_camera_profile::IlluminantToTemperature` (the SDK's nominal values).
fn illuminant_cct(code: u16) -> f64 {
  match code {
    3 | 17 => 2850.0,
    24 => 3200.0,
    23 => 5000.0,
    1 | 4 | 9 | 18 | 20 => 5500.0,
    10 | 19 | 21 => 6500.0,
    11 | 22 => 7500.0,
    12 => 6400.0,
    13 => 5050.0,
    2 | 14 => 4150.0,
    15 => 3525.0,
    16 => 2925.0,
    _ => 0.0,
  }
}

fn matrix_vector(matrix: &Mat3, value: [f64; 3]) -> [f64; 3] {
  std::array::from_fn(|r| {
    let mut sum = 0.0;
    for (c, &v) in value.iter().enumerate() {
      sum = matrix.0[r][c].mul_add(v, sum);
    }
    sum
  })
}

// Adobe colour has its own inverse so corrections here do not change the
// existing Apple calibration. Keep the complete cofactor formula explicit.
fn inverse(Mat3(m): Mat3) -> Mat3 {
  let a = m[1][1] * m[2][2] - m[1][2] * m[2][1];
  let b = m[1][0] * m[2][2] - m[1][2] * m[2][0];
  let c = m[1][0] * m[2][1] - m[1][1] * m[2][0];
  let determinant = m[0][0] * a - m[0][1] * b + m[0][2] * c;
  Mat3([
    [
      a / determinant,
      -(m[0][1] * m[2][2] - m[0][2] * m[2][1]) / determinant,
      (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / determinant,
    ],
    [
      -b / determinant,
      (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / determinant,
      -(m[0][0] * m[1][2] - m[0][2] * m[1][0]) / determinant,
    ],
    [
      c / determinant,
      -(m[0][0] * m[2][1] - m[0][1] * m[2][0]) / determinant,
      (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / determinant,
    ],
  ])
}

fn normalized_color_matrix(values: &[f64; 9]) -> Mat3 {
  let matrix = Mat3::from_rows(values);
  let maximum = matrix_vector(&matrix, xy_to_xyz(D50_XY))
    .into_iter()
    .fold(f64::NEG_INFINITY, f64::max);
  let scale = if maximum > 0.0 && !(0.99..=1.01).contains(&maximum) {
    1.0 / maximum
  } else {
    1.0
  };
  Mat3(
    matrix
      .0
      .map(|row| row.map(|v| (v * scale * 10000.0).round() * 0.0001)),
  )
}

fn normalized_forward_matrix(values: &[f64; 9]) -> Mat3 {
  let mut matrix = Mat3::from_rows(values);
  let white = matrix_vector(&matrix, [1.0; 3]);
  let pcs = xy_to_xyz(D50_XY);
  for r in 0..3 {
    let scale = pcs[r] / white[r];
    for c in 0..3 {
      matrix.0[r][c] *= scale;
    }
  }
  matrix
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ColorSpec {
  /// White chromaticity of the neutral.
  pub white_xy: (f64, f64),
  pub cct: f64,
  /// Weight of calibration illuminant 1.
  pub weight: f64,
  /// Balanced camera RGB (white = 1,1,1) -> linear ProPhoto RGB.
  pub balanced_to_prophoto: Mat3,
  /// HueSatMap interpolated for the white, if the profile has one.
  pub hue_sat_map: Option<HueSatMap>,
  pub(crate) camera_white: [f64; 3],
}

impl ColorSpec {
  /// `neutral`: camera RGB of a white object, green = 1.
  pub fn new(dcp: &Dcp, neutral: [f64; 3]) -> Self {
    Self::with_calibration(dcp, neutral, [1.0; 3])
  }

  pub(crate) fn with_calibration(dcp: &Dcp, neutral: [f64; 3], calibration: [f64; 3]) -> Self {
    Self::build(dcp, neutral, calibration, None)
  }

  pub(crate) fn for_render(
    dcp: &Dcp,
    meta: &crate::metadata::RawMetadata,
    neutral: [f64; 3],
    white_balance: &crate::settings::WhiteBalance,
  ) -> Self {
    let calibration = camera_calibration(meta);
    let xy = match *white_balance {
      crate::settings::WhiteBalance::AsShot => {
        let as_shot = Self::with_calibration(dcp, neutral, calibration);
        super::temperature::round_as_shot(as_shot.white_xy)
      }
      crate::settings::WhiteBalance::Temperature { kelvin, tint } => {
        super::temperature::to_xy(kelvin, tint)
      }
    };
    Self::build(dcp, neutral, calibration, Some(xy))
  }

  /// The small image used for scene statistics is rendered at the PCS white,
  /// independently of the photograph's selected white balance.
  pub(crate) fn for_statistics(
    dcp: &Dcp,
    meta: &crate::metadata::RawMetadata,
    neutral: [f64; 3],
  ) -> Self {
    Self::build(dcp, neutral, camera_calibration(meta), Some(D50_XY))
  }

  fn build(
    dcp: &Dcp,
    neutral: [f64; 3],
    calibration: [f64; 3],
    white_xy: Option<(f64, f64)>,
  ) -> Self {
    let (mut t1, mut t2) = (
      illuminant_cct(dcp.calibration_illuminant_1),
      illuminant_cct(dcp.calibration_illuminant_2),
    );
    // ReadSony3x0's per-body calibration carries the "com.adobe" signature.
    // DNG colour applies it only when the selected profile has that signature.
    let calibration = if dcp.calibration_signature == "com.adobe" {
      calibration
    } else {
      [1.0; 3]
    };
    let calibrate = |matrix: Mat3| {
      Mat3(std::array::from_fn(|r| {
        matrix.0[r].map(|v| calibration[r] * v)
      }))
    };
    let cm1 = calibrate(normalized_color_matrix(&dcp.color_matrix_1));
    let mut cm2 = calibrate(normalized_color_matrix(&dcp.color_matrix_2));
    let fm1 = dcp.forward_matrix_1.as_ref().map(normalized_forward_matrix);
    let mut fm2 = dcp.forward_matrix_2.as_ref().map(normalized_forward_matrix);
    if t1 <= 0.0 || t2 <= 0.0 || t1 == t2 {
      t1 = 5000.0;
      t2 = 5000.0;
      cm2 = cm1;
      fm2 = fm1;
    }
    let weight = |cct: f64| -> f64 {
      if (t1 - t2).abs() < 1.0 {
        return 1.0;
      }
      let (lo, hi) = (t1.min(t2), t1.max(t2));
      let t = cct.clamp(lo, hi);
      ((1.0 / t - 1.0 / t2) / (1.0 / t1 - 1.0 / t2)).clamp(0.0, 1.0)
    };
    let lerp = |a: Mat3, b: Mat3, w: f64| {
      if w >= 1.0 {
        a
      } else if w <= 0.0 {
        b
      } else {
        a.scale(w).add(&b.scale(1.0 - w))
      }
    };
    // dng_color_spec::NeutralToXY
    let mut xy = D50_XY;
    for pass in 0..30 {
      let w = weight(xy_to_cct(xy.0, xy.1));
      let cm = lerp(cm1, cm2, w);
      let xyz = matrix_vector(&inverse(cm), neutral);
      let s = xyz[0] + xyz[1] + xyz[2];
      if s <= 0.0 {
        break;
      }
      let mut next = (xyz[0] / s, xyz[1] / s);
      let done = (next.0 - xy.0).abs() + (next.1 - xy.1).abs() < 1e-7;
      if pass == 29 && !done {
        next = ((xy.0 + next.0) * 0.5, (xy.1 + next.1) * 0.5);
      }
      xy = next;
      if done {
        break;
      }
    }
    let xy = white_xy.unwrap_or(xy);
    let cct = xy_to_cct(xy.0, xy.1);
    let w = weight(cct);
    let cm = lerp(cm1, cm2, w);
    // Camera white for this xy, normalised to max 1 (SDK clamps to [0.001, 1]).
    let cw = matrix_vector(&cm, xy_to_xyz(xy));
    let m = cw[0].max(cw[1]).max(cw[2]);
    let cw = cw.map(|v| (v * (1.0 / m)).clamp(0.001, 1.0));
    let camera_to_xyz = match (fm1, fm2) {
      (Some(f1), Some(f2)) => lerp(f1, f2, w).mul(&Mat3::diag(cw.map(|v| 1.0 / v))),
      (Some(f1), None) => f1.mul(&Mat3::diag(cw.map(|v| 1.0 / v))),
      (None, Some(f2)) => f2.mul(&Mat3::diag(cw.map(|v| 1.0 / v))),
      _ => adapt_to_d50(xy).mul(&inverse(cm)),
    };
    // Our working pixels are camera RGB divided by `neutral` (green = 1); the SDK's are
    // raw camera RGB. Rescale so both describe the same physical value.
    let balanced_to_prophoto = inverse(PROPHOTO_TO_XYZ_D50)
      .mul(&camera_to_xyz)
      .mul(&Mat3::diag(neutral));
    let hue_sat_map = match (&dcp.hue_sat_map_1, &dcp.hue_sat_map_2) {
      (Some(a), Some(b)) if a.dims == b.dims => Some(HueSatMap::blend(a, b, w)),
      (Some(a), _) => Some(a.clone()),
      (None, Some(b)) => Some(b.clone()),
      _ => None,
    };
    Self {
      white_xy: xy,
      cct,
      weight: w,
      balanced_to_prophoto,
      hue_sat_map,
      camera_white: cw,
    }
  }

  /// Camera clip point in balanced units: SDK clips camera RGB at `camera_white`;
  /// in our balanced units that is `camera_white / neutral`.
  pub fn balanced_clip(dcp: &Dcp, neutral: [f64; 3]) -> [f32; 3] {
    Self::new(dcp, neutral).clip(neutral)
  }

  pub(crate) fn clip(&self, neutral: [f64; 3]) -> [f32; 3] {
    std::array::from_fn(|c| (self.camera_white[c] / neutral[c]) as f32)
  }

  /// Unbalanced camera RGB -> scene-linear ProPhoto, before stage quantization.
  pub(crate) fn raw_to_prophoto(&self, neutral: [f64; 3]) -> Mat3 {
    self
      .balanced_to_prophoto
      .mul(&Mat3::diag(neutral.map(|v| 1.0 / v)))
  }
}

/// Bradford adaptation from `xy` to D50 (used only for profiles without a
/// ForwardMatrix).
fn adapt_to_d50(xy: (f64, f64)) -> Mat3 {
  const B: Mat3 = Mat3([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
  ]);
  let s = B.mul_vec(xy_to_xyz(xy));
  let d = B.mul_vec(xy_to_xyz(D50_XY));
  inverse(B)
    .mul(&Mat3::diag(
      [0, 1, 2].map(|i| (d[i] / s[i]).clamp(0.1, 10.0)),
    ))
    .mul(&B)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fuji_daylight_calibration_uses_body_ratios_and_four_decimal_precision() {
    assert_eq!(fuji_calibration("X100VI", [615.0, 302.0, 499.0]), [1.0; 3]);
    assert_eq!(fuji_calibration("X-E5", [658.0, 302.0, 494.0]), [1.0; 3]);
    // X100VI DSCF0008: the body differs from the nominal daylight reference.
    let expected = [1.025, 1.0, 1.0267];
    for levels in [[600.0, 302.0, 486.0], [1200.0, 604.0, 972.0]] {
      let calibration = fuji_calibration("X100VI", levels);
      for c in 0..3 {
        assert!((calibration[c] - expected[c]).abs() < 1e-15);
      }
    }
  }

  #[test]
  fn fuji_daylight_calibration_rejects_invalid_or_implausible_metadata() {
    for levels in [
      [0.0, 302.0, 499.0],
      [615.0, f64::NAN, 499.0],
      [615.0, 302.0, f64::INFINITY],
      [400.0, 302.0, 499.0],
      [615.0, 302.0, 700.0],
    ] {
      assert_eq!(fuji_calibration("X100VI", levels), [1.0; 3]);
    }
    assert_eq!(fuji_calibration("unknown", [600.0, 302.0, 486.0]), [1.0; 3]);
  }

  #[test]
  fn body_calibration_requires_matching_adobe_profile_signature() {
    let matrix = [0.8, -0.1, 0.1, -0.2, 1.0, 0.2, 0.1, 0.1, 0.7];
    let mut dcp = Dcp {
      camera_model: String::new(),
      profile_name: String::new(),
      calibration_signature: String::new(),
      calibration_illuminant_1: 21,
      calibration_illuminant_2: 21,
      color_matrix_1: matrix,
      color_matrix_2: matrix,
      forward_matrix_1: None,
      forward_matrix_2: None,
      hue_sat_map_1: None,
      hue_sat_map_2: None,
      look_table: None,
      hue_sat_map_encoding: 0,
      look_table_encoding: 0,
      tone_curve: None,
      baseline_exposure_offset: 0.0,
      default_black_render: 0,
    };
    let neutral = [0.5, 1.0, 0.7];
    let uncalibrated = ColorSpec::new(&dcp, neutral);
    let body = [1.025, 1.0, 1.0267];
    for signature in ["", "other.vendor"] {
      dcp.calibration_signature = signature.into();
      let spec = ColorSpec::with_calibration(&dcp, neutral, body);
      assert_eq!(spec.white_xy, uncalibrated.white_xy);
      assert_eq!(
        spec.balanced_to_prophoto.0,
        uncalibrated.balanced_to_prophoto.0
      );
    }
    dcp.calibration_signature = "com.adobe".into();
    let calibrated = ColorSpec::with_calibration(&dcp, neutral, body);
    assert!((calibrated.white_xy.0 - uncalibrated.white_xy.0).abs() > 1e-4);
  }

  #[test]
  fn nonsymmetric_matrix_inverse_maps_back_to_identity() {
    for matrix in [
      PROPHOTO_TO_XYZ_D50,
      Mat3([[1.2, -0.4, 0.2], [-0.5, 1.3, 0.1], [0.1, 0.2, 0.6]]),
    ] {
      let identity = matrix.mul(&inverse(matrix));
      for r in 0..3 {
        for c in 0..3 {
          assert!((identity.0[r][c] - f64::from(r == c)).abs() < 1e-12);
        }
      }
    }
  }

  /// External SetWhiteXY capture at the final render's requested white balance,
  /// with the same original RAW and selected DCP. Capture dumps stay local.
  #[test]
  fn captured_color_specification() {
    let (Some(raw), Some(profile_dir), Some(trace)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
      std::env::var_os("RAW_DEVELOP_ADOBE_COLOR_TRACE"),
    ) else {
      return;
    };
    let bytes = std::fs::read(raw).unwrap();
    let meta = crate::Negative::read_metadata(&bytes).unwrap();
    let profile =
      Dcp::find_adobe_standard(std::path::Path::new(&profile_dir), &meta.make, &meta.model)
        .unwrap();
    let dcp = Dcp::open(&profile).unwrap();
    let neutral = super::super::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let calibration = camera_calibration(&meta);
    let captured = std::fs::read(trace).unwrap();
    let value = |offset| f64::from_le_bytes(captured[offset..offset + 8].try_into().unwrap());
    let expected_xy = (value(0x860), value(0x868));
    let spec = ColorSpec::for_render(&dcp, &meta, neutral, &crate::settings::WhiteBalance::AsShot);
    eprintln!(
      "colour xy {:?}, captured {expected_xy:?}; CCT {}",
      spec.white_xy, spec.cct
    );
    assert!((spec.white_xy.0 - expected_xy.0).abs() < 1e-10);
    assert!((spec.white_xy.1 - expected_xy.1).abs() < 1e-10);
    let camera_to_xyz = PROPHOTO_TO_XYZ_D50
      .mul(&spec.balanced_to_prophoto)
      .mul(&Mat3::diag(neutral.map(|v| 1.0 / v)));
    let mut maximum = 0.0f64;
    eprintln!(
      "profile {}; neutral {neutral:?}; calibration {calibration:?}; weight {}; camera white {:?}, captured {:?}",
      dcp.profile_name,
      spec.weight,
      spec.camera_white,
      [0, 1, 2].map(|r| value(0x880 + r * 8))
    );
    for r in 0..3 {
      assert!((spec.camera_white[r] - value(0x880 + r * 8)).abs() < 1e-10);
      for c in 0..3 {
        maximum = maximum.max((camera_to_xyz.0[r][c] - value(0x8b0 + r * 32 + c * 8)).abs());
      }
    }
    eprintln!("colour CameraToPCS maximum difference {maximum}");
    assert!(maximum < 1e-10);
  }
}
#[test]
fn prophoto_white_maps_to_pcs_white() {
  let white = matrix_vector(&PROPHOTO_TO_XYZ_D50, [1.0; 3]);
  let pcs = xy_to_xyz(D50_XY);
  for c in 0..3 {
    assert!((white[c] - pcs[c]).abs() < 1e-15);
  }
}
