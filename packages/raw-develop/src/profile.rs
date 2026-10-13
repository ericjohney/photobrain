//! Per-camera rendering profiles (see `profiles/*.toml` for provenance).

use crate::error::{Error, Result};
use crate::math::Mat3;
use serde::Deserialize;

/// One chroma noise-reduction pass (see `stages::chroma_nr`).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PassKind {
  Plain,
  EarlyOut,
  Hf,
  HfEarlyOut,
  /// Early-out average with a second, stricter threshold (`params3 = [t2 factor, range
  /// factor]`) preferred for already-saturated pixels.
  EarlyOut2,
  Despeckle,
  /// powerBlurLFS: one fused pass (extract, 4-neighbour cross average at half
  /// resolution, expand); used alone instead of a chain.
  Fs,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChromaNrPass {
  pub kind: PassKind,
  /// Tap spacing in half-resolution pixels.
  pub scale: u32,
  /// `[c0, c1, c2, moire]`: neighbour accepted when its weighted squared colour
  /// difference is below `c0 + c1*Y + c2*Y^2`; `moire` sets the moire threshold.
  pub threshold: [f32; 4],
  /// `hf_early_out` only: blend between the plain and moire-aware averages.
  #[serde(default)]
  pub interpolant: f32,
  /// `despeckle`: speckle detector parameters (13 values); `early_out2`: [t2 factor,
  /// range factor].
  #[serde(default)]
  pub despeckle: Vec<f32>,
}

/// How a luma pyramid level adds its detail band back (see `stages::luma`).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LevelKind {
  /// expandPlusDWithOverdrive: detail unchanged.
  Plain,
  /// expandPlusDThruG: noise coring outside a structure mask.
  ThruG,
  /// expandPlusDThruG2: full-resolution coring and sharpening, simple gradient mask.
  ThruG2,
  /// expandPlusDThruG3: full-resolution coring and directional sharpening.
  ThruG3,
}

/// One level of the luma pyramid, finest first. Parameter names follow the kernels.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LumaLevel {
  pub kind: LevelKind,
  #[serde(default)]
  pub overdrive: f32,
  #[serde(default)]
  pub parms: [f32; 4],
  #[serde(default)]
  pub roparms: [f32; 4],
  #[serde(default)]
  pub omparms: [f32; 2],
  /// DIRToC curvature threshold model (c0 + c1*Y + c2*Y^2).
  #[serde(default)]
  pub dir_to_c: [f32; 3],
  /// annealGAndC / annealG gradient threshold model.
  #[serde(default)]
  pub anneal: [f32; 3],
  #[serde(default)]
  pub cfactor: f32,
  /// smoothDSharpen passes: [step, curvature min, mix, hf gain, perp step, hf thresh, hf slope],
  /// plus an 8th value (anti-bloom range) for smoothDSharpenAntiBloom passes.
  #[serde(default)]
  pub sharpen: Vec<Vec<f32>>,
  /// thru_g2 only: gaborToSYAndG [smoothAmt, f1 (4), f2 (2)].
  #[serde(default)]
  pub gabor: Vec<f32>,
  /// Full-resolution level only: addFGN factor (fine-grain noise re-added outside the
  /// structure mask), 0 = off.
  #[serde(default)]
  pub fine_grain: f32,
}

/// Noise tuning at one ISO.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoiseIso {
  pub iso: f32,
  /// Demosaic noise model `rn`: raw variance ~ rn[1] + v * rn[2].
  pub demosaic_noise: [f32; 3],
  /// Chroma NR: use the moire-detecting extract (fine green texture alpha).
  pub moire_detect: bool,
  /// Chroma NR pass chain.
  pub chroma_passes: Vec<ChromaNrPass>,
  /// Luma pyramid recipe: full resolution first, then three coarser levels.
  pub luma: Vec<LumaLevel>,
  /// Bayer only: despeckle_v8 `[amount, neighborPrevention]` before the demosaic.
  #[serde(default)]
  pub despeckle: Option<[f32; 2]>,
}

impl CameraProfile {
  /// The noise entry nearest to `iso` in log2 (ISO 100 when unknown).
  pub fn noise_for_iso(&self, iso: Option<u32>) -> Option<&NoiseIso> {
    let iso = iso.unwrap_or(100).max(1) as f32;
    self.noise.iter().min_by(|a, b| {
      let da = (a.iso.log2() - iso.log2()).abs();
      let db = (b.iso.log2() - iso.log2()).abs();
      da.total_cmp(&db)
    })
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
  /// Per-ISO noise tuning (demosaic noise model, chroma NR), any order.
  #[serde(default)]
  pub noise: Vec<NoiseIso>,
  #[serde(default = "one")]
  pub distortion_fill_scale: f64,
  /// Bayer demosaic `exposureFactor` (RawCamera's constant per body; only gates the
  /// noise mixer in deep shadows). X-Trans derives it from RawExposureBias.
  #[serde(default)]
  pub demosaic_exposure_factor: Option<f32>,
}

fn one() -> f64 {
  1.0
}

fn default_base_iso() -> f32 {
  100.0
}

const BUILTIN: &[(&str, &str)] = &[
  ("X-E5", include_str!("../profiles/fujifilm-x-e5.toml")),
  ("X100VI", include_str!("../profiles/fujifilm-x100vi.toml")),
  ("ILCE-1M2", include_str!("../profiles/sony-ilce-1m2.toml")),
  ("ILCE-7CR", include_str!("../profiles/sony-ilce-7cr.toml")),
  ("ILCE-7RM5", include_str!("../profiles/sony-ilce-7rm5.toml")),
];

impl CameraProfile {
  pub fn from_toml(text: &str) -> Result<Self> {
    let p: Self = toml::from_str(text).map_err(|e| Error::Settings(format!("profile: {e}")))?;
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
  }

  #[test]
  fn every_builtin_profile_loads() {
    for (model, _) in BUILTIN {
      let p = CameraProfile::builtin(model).unwrap();
      assert!(p.model.eq_ignore_ascii_case(model), "{model}: model field");
      assert!(p.white_level > 1000.0 && p.base_iso > 0.0, "{model}");
      assert!(!p.noise.is_empty(), "{model}: noise table");
      for c in &p.noise {
        assert_eq!(c.luma.len(), 4, "{model}: luma levels at ISO {}", c.iso);
        assert!(
          matches!(c.luma[0].kind, LevelKind::ThruG2 | LevelKind::ThruG3),
          "{model}: full-resolution luma level"
        );
        if c.luma[0].kind == LevelKind::ThruG2 {
          assert_eq!(c.luma[0].gabor.len(), 7, "{model}: gabor parameters");
        }
        for level in &c.luma {
          for s in &level.sharpen {
            assert!(matches!(s.len(), 7 | 8), "{model}: sharpen pass has 7 or 8 values");
          }
        }
        if c.chroma_passes.iter().any(|p| p.kind == PassKind::Fs) {
          assert_eq!(c.chroma_passes.len(), 1, "{model}: fs is a single fused pass");
        }
        for pass in &c.chroma_passes {
          assert!(pass.scale >= 1 || pass.kind == PassKind::Fs, "{model}: chroma NR pass scale");
          if pass.kind == PassKind::Despeckle {
            assert_eq!(pass.despeckle.len(), 13, "{model}: despeckle parameters");
          }
          if pass.kind == PassKind::EarlyOut2 {
            assert_eq!(pass.despeckle.len(), 2, "{model}: early_out2 parameters");
          }
        }
      }
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
