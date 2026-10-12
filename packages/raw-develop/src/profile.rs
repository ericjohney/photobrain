//! Per-camera rendering profiles (see `profiles/*.toml` for provenance).

use crate::error::{Error, Result};
use crate::math::Mat3;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
pub struct ToneCurve {
  pub input: Vec<f32>,
  pub output: Vec<f32>,
}

impl ToneCurve {
  #[inline]
  pub fn eval(&self, x: f32) -> f32 {
    let k = &self.input;
    let v = &self.output;
    if x <= k[0] {
      return v[0];
    }
    // Knots are few (~25): binary search.
    let i = k.partition_point(|&t| t < x);
    if i >= k.len() {
      return v[v.len() - 1];
    }
    let (x0, x1, y0, y1) = (k[i - 1], k[i], v[i - 1], v[i]);
    y0 + (y1 - y0) * (x - x0) / (x1 - x0)
  }

  fn validate(&self) -> Result<()> {
    let ok = self.input.len() >= 2
      && self.input.len() == self.output.len()
      && self.input.windows(2).all(|w| w[1] > w[0])
      && self.output.windows(2).all(|w| w[1] >= w[0]);
    if ok {
      Ok(())
    } else {
      Err(Error::Settings(
        "tone curve knots must be increasing".into(),
      ))
    }
  }
}

#[derive(Clone, Debug, Deserialize)]
pub struct CameraProfile {
  pub make: String,
  pub model: String,
  pub white_level: f32,
  pub calibration_illuminant_1: f64,
  pub calibration_illuminant_2: f64,
  pub color_matrix_1: [f64; 9],
  pub color_matrix_2: [f64; 9],
  pub forward_matrix_1: [f64; 9],
  pub forward_matrix_2: [f64; 9],
  pub baseline_exposure: f64,
  #[serde(default)]
  pub black_render: f32,
  /// Base (lowest native) ISO; noise reduction scales with ISO relative to this.
  #[serde(default = "default_base_iso")]
  pub base_iso: f32,
  pub look_matrix_1: [f64; 9],
  pub look_matrix_2: [f64; 9],
  pub tone_curve: ToneCurve,
  pub distortion_fill_scale: f64,
}

fn default_base_iso() -> f32 {
  100.0
}

const BUILTIN: &[(&str, &str)] = &[("X-E5", include_str!("../profiles/fujifilm-x-e5.toml"))];

impl CameraProfile {
  pub fn from_toml(text: &str) -> Result<Self> {
    let p: Self = toml::from_str(text).map_err(|e| Error::Settings(format!("profile: {e}")))?;
    p.tone_curve.validate()?;
    Ok(p)
  }

  /// Built-in profile for a camera model, if one exists.
  pub fn builtin(model: &str) -> Result<Self> {
    let text = BUILTIN
      .iter()
      .find(|(m, _)| m.eq_ignore_ascii_case(model.trim()))
      .map(|(_, t)| *t)
      .ok_or_else(|| Error::Unsupported(format!("no camera profile for {model}")))?;
    Self::from_toml(text)
  }

  /// Weight of illuminant 1 for a correlated colour temperature (DNG 1/T interpolation).
  pub fn illuminant_weight(&self, cct: f64) -> f64 {
    let (t1, t2) = (self.calibration_illuminant_1, self.calibration_illuminant_2);
    let t = cct.clamp(t1.min(t2), t1.max(t2));
    ((1.0 / t - 1.0 / t2) / (1.0 / t1 - 1.0 / t2)).clamp(0.0, 1.0)
  }

  fn lerp(&self, a: &[f64; 9], b: &[f64; 9], cct: f64) -> Mat3 {
    let w = self.illuminant_weight(cct);
    Mat3::from_rows(a)
      .scale(w)
      .add(&Mat3::from_rows(b).scale(1.0 - w))
  }

  pub fn color_matrix(&self, cct: f64) -> Mat3 {
    self.lerp(&self.color_matrix_1, &self.color_matrix_2, cct)
  }

  pub fn forward_matrix(&self, cct: f64) -> Mat3 {
    self.lerp(&self.forward_matrix_1, &self.forward_matrix_2, cct)
  }

  pub fn look_matrix(&self, cct: f64) -> Mat3 {
    self.lerp(&self.look_matrix_1, &self.look_matrix_2, cct)
  }

  /// CCT and tint-free xy of a camera-neutral (camera RGB of a white object), solved
  /// iteratively as in the DNG specification.
  pub fn neutral_to_cct(&self, neutral: [f64; 3]) -> f64 {
    let mut cct = 5000.0;
    for _ in 0..30 {
      let xyz = self.color_matrix(cct).inverse().mul_vec(neutral);
      let sum = xyz[0] + xyz[1] + xyz[2];
      if sum <= 0.0 {
        break;
      }
      let next = xy_to_cct(xyz[0] / sum, xyz[1] / sum).clamp(2000.0, 50000.0);
      if (next - cct).abs() < 0.1 {
        return next;
      }
      cct = next;
    }
    cct
  }

  /// Matrix from white-balanced camera RGB (camera values divided by `neutral`) to
  /// scene-linear Display P3, and the CCT used to interpolate it.
  pub fn balanced_camera_to_display_p3(&self, neutral: [f64; 3]) -> (Mat3, f64) {
    let cct = self.neutral_to_cct(neutral);
    let m = self
      .look_matrix(cct)
      .mul(&crate::math::XYZ_D50_TO_LINEAR_P3)
      .mul(&self.forward_matrix(cct));
    (m, cct)
  }

  /// Camera neutral for a white-balance temperature/tint, using the profile's colour
  /// matrices. Tint is a shift perpendicular to the Planckian locus in CIE 1960 uv,
  /// in units of 1/3000 uv (approximately Lightroom's scale).
  pub fn neutral_for_temperature(&self, kelvin: f64, tint: f64) -> [f64; 3] {
    let (x, y) = planckian_xy(kelvin, tint);
    let xyz = [x / y, 1.0, (1.0 - x - y) / y];
    let cam = self.color_matrix(kelvin).mul_vec(xyz);
    [cam[0] / cam[1], 1.0, cam[2] / cam[1]]
  }
}

/// Planckian locus (Kim et al. cubic spline, 1667-25000 K) with a tint offset applied
/// along the locus normal in CIE 1960 uv.
fn planckian_xy(kelvin: f64, tint: f64) -> (f64, f64) {
  let t = kelvin.clamp(1667.0, 25000.0);
  let (t2, t3) = (t * t, t * t * t);
  let x = if t <= 4000.0 {
    -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.179910
  } else {
    -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.240390
  };
  let (x2, x3) = (x * x, x * x * x);
  let y = if t <= 2222.0 {
    -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
  } else if t <= 4000.0 {
    -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
  } else {
    3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483
  };
  if tint == 0.0 {
    return (x, y);
  }
  // Locus tangent from a nearby point, in uv.
  let to_uv = |x: f64, y: f64| {
    let d = -2.0 * x + 12.0 * y + 3.0;
    (4.0 * x / d, 6.0 * y / d)
  };
  let (u, v) = to_uv(x, y);
  let (xn, yn) = planckian_xy(t * 1.01, 0.0);
  let (un, vn) = to_uv(xn, yn);
  let (du, dv) = (un - u, vn - v);
  let len = (du * du + dv * dv).sqrt().max(1e-12);
  // Normal pointing towards green (+v side) for positive tint is magenta in Lightroom,
  // so positive tint moves away from green.
  let (nu, nv) = (dv / len, -du / len);
  let s = tint / 3000.0;
  let (u2, v2) = (u + nu * s, v + nv * s);
  let d = 2.0 * u2 - 8.0 * v2 + 4.0;
  (3.0 * u2 / d, 2.0 * v2 / d)
}

/// McCamy's approximation.
fn xy_to_cct(x: f64, y: f64) -> f64 {
  let n = (x - 0.3320) / (0.1858 - y);
  449.0 * n.powi(3) + 3525.0 * n.powi(2) + 6823.3 * n + 5520.33
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn builtin_xe5_loads() {
    let p = CameraProfile::builtin("X-E5").unwrap();
    assert_eq!(p.model, "X-E5");
    assert!((p.tone_curve.eval(0.18) - 0.65).abs() < 0.02);
    assert_eq!(p.tone_curve.eval(-1.0), 0.0);
    assert!((p.tone_curve.eval(100.0) - 1.0).abs() < 1e-6);
  }

  #[test]
  fn every_builtin_profile_loads() {
    for (model, _) in BUILTIN {
      let p = CameraProfile::builtin(model).unwrap();
      assert!(p.model.eq_ignore_ascii_case(model), "{model}: model field");
      assert!(p.white_level > 1000.0 && p.base_iso > 0.0, "{model}");
      for cct in [2800.0, 4000.0, 6500.0] {
        let v = p.look_matrix(cct).mul_vec([1.0, 1.0, 1.0]);
        assert!(
          v.iter().all(|c| (c - 1.0).abs() < 1e-4),
          "{model}: look matrix must preserve white"
        );
      }
    }
  }

  #[test]
  fn look_matrices_preserve_white() {
    let p = CameraProfile::builtin("X-E5").unwrap();
    for cct in [2800.0, 4000.0, 6500.0] {
      let v = p.look_matrix(cct).mul_vec([1.0, 1.0, 1.0]);
      for c in v {
        assert!((c - 1.0).abs() < 1e-5, "{v:?}");
      }
    }
  }

  #[test]
  fn white_balanced_neutral_maps_to_p3_white() {
    // DNG forward matrices map the camera neutral (after 1/neutral) to D50 white; the
    // XYZ->P3 matrix includes Bradford D50->D65, so the result is achromatic.
    let p = CameraProfile::builtin("X-E5").unwrap();
    let neutral = [302.0 / 608.0, 1.0, 302.0 / 549.0];
    let (m, cct) = p.balanced_camera_to_display_p3(neutral);
    assert!((4000.0..6500.0).contains(&cct), "{cct}");
    let v = m.mul_vec([1.0, 1.0, 1.0]);
    assert!(
      (v[0] - v[1]).abs() < 0.01 && (v[2] - v[1]).abs() < 0.01,
      "{v:?}"
    );
  }

  #[test]
  fn temperature_roundtrip() {
    let p = CameraProfile::builtin("X-E5").unwrap();
    for k in [3000.0, 4500.0, 6000.0] {
      let n = p.neutral_for_temperature(k, 0.0);
      let back = p.neutral_to_cct(n);
      assert!((back - k).abs() / k < 0.03, "{k} -> {back}");
    }
  }
}
