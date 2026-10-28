//! Ordinary SDR `cr_tone_stage_curve::Evaluate2012` (0x100e55700).
//!
//! This is the DCP-profile branch without an overriding negative RenderCurve,
//! user point/parametric curves, or an AI look. Exposure/Whites/Blacks are applied
//! by the preceding exposure stage; only its negative tone exposure enters here.

#[path = "../acr3.rs"]
mod acr3;

use super::{
  curves::{Brightness, Contrast, Table, srgb_decode, srgb_encode},
  spline::Spline,
};

#[derive(Clone, Copy, Debug)]
struct ExtraExposure {
  slope: f64,
  a: f64,
  b: f64,
  c: f64,
}

impl ExtraExposure {
  fn new(ev: f64) -> Self {
    let slope = ev.exp2();
    let a = (1.0 - slope) * (16.0 / 9.0);
    let b = a.mul_add(-0.5, slope);
    Self {
      slope,
      a,
      b,
      c: (1.0 - a) - b,
    }
  }

  fn eval(self, x: f64) -> f64 {
    if x <= 0.25 {
      x * self.slope
    } else {
      self.a.mul_add(x, self.b).mul_add(x, self.c)
    }
  }
}

#[derive(Clone, Debug)]
pub struct Curve {
  extra_exposure: Option<ExtraExposure>,
  brightness: Option<Brightness>,
  profile: Option<Spline>,
  contrast: Option<Contrast>,
}

impl Curve {
  /// `tone_exposure` is exposure Info+0x18 after baseline adjustment; `key` is
  /// from the pre-render statistics stored at Info+0xc0. For PV 15.4 and newer,
  /// pass zero contrast here: `UserContrast` applies it in the separate late stage.
  pub fn new(profile: Option<&[(f32, f32)]>, tone_exposure: f64, contrast: i32, key: f64) -> Self {
    Self {
      extra_exposure: (tone_exposure < -1.0).then(|| ExtraExposure::new(tone_exposure + 1.0)),
      brightness: (tone_exposure < 0.0).then(|| Brightness::new(tone_exposure.max(-1.0))),
      profile: profile.map(Spline::from_dcp),
      contrast: (contrast != 0).then(|| Contrast::new(contrast, key)),
    }
  }

  pub fn eval(&self, mut x: f64) -> f64 {
    if let Some(exposure) = self.extra_exposure {
      x = exposure.eval(x);
    }
    if let Some(brightness) = &self.brightness {
      let gamma = if x > 0.0 {
        x.powf(f64::from_bits(0x3fdd_1745_d174_5d17))
      } else {
        x
      };
      let gamma = brightness.eval(gamma);
      x = if gamma > 0.0 { gamma.powf(2.2) } else { gamma };
    }
    x = self
      .profile
      .as_ref()
      .map_or_else(|| acr3_eval(x), |profile| profile.eval(x).clamp(0.0, 1.0));
    if let Some(contrast) = self.contrast {
      x = contrast.eval(x);
    }
    x
  }

  pub fn table(&self) -> Table {
    Table::new(4096, |x| self.eval(x))
  }
}

/// ACR3's native evaluator computes the interpolation entirely as float32.
fn acr3_eval(x: f64) -> f64 {
  let x = (x as f32) * 1024.0;
  let i = (x as i32).clamp(0, 1023) as usize;
  let t = x - i as f32;
  acr3::ACR3_DEFAULT[i].mul_add(1.0 - t, t * acr3::ACR3_DEFAULT[i + 1]) as f64
}

/// ARM64 `SIMDLinearToneSDR_32` (0x1008732a8). Modern RAW rendering enables
/// `smooth`, adjusting the endpoint interval before applying the tone table.
#[derive(Clone, Debug)]
pub struct Stage {
  pub table: Table,
  pub smooth: bool,
}

impl Stage {
  pub fn from_curve(curve: &Curve) -> Self {
    Self {
      table: curve.table(),
      smooth: true,
    }
  }

  /// PV 15.4 moves user contrast into a second RGB tone stage whose input
  /// and output are sRGB encoded working RGB (`cr_tone_stage_curve2`). Apply
  /// this after the pipeline's sRGB encoding, separately from profile tone.
  pub fn user_contrast(slider: i32, key: f64) -> Option<Self> {
    if slider == 0 {
      return None;
    }
    let contrast = Contrast::new(slider, key);
    Some(Self {
      table: Table::new(4096, |x| srgb_encode(contrast.eval(srgb_decode(x)))),
      smooth: true,
    })
  }

  pub fn pixel(&self, px: [f32; 3]) -> [f32; 3] {
    let gb_lo = px[1].min(px[2]);
    let gb_hi = px[1].max(px[2]);
    let r_or_lo = px[0].max(gb_lo);
    let lo = px[0].min(gb_lo);
    let mid = r_or_lo.min(gb_hi);
    let hi = r_or_lo.max(gb_hi);
    let range = hi - lo;
    let t = if range == 0.0 {
      0.0
    } else {
      (mid - lo) * (1.0 / range)
    };
    let mut lower = lo;
    let mut upper = hi;
    let t2 = t * t;
    if self.smooth {
      let u = 1.0 - t;
      upper = hi + (mid - hi) * (t2 * 0.5);
      lower = lo + (mid - lo) * ((u * u) * 0.5);
    }
    upper = self.table.eval_simd(upper);
    lower = self.table.eval_simd(lower);
    if self.smooth {
      let t3 = t * t2;
      let p = t - 1.0;
      let denominator = (t2 - t) + 2.0;
      let inverse = if denominator == 0.0 {
        0.0
      } else {
        1.0 / denominator
      };
      let high_coefficient = (t + (t3 - t2 * 2.0)) - 2.0;
      let low_coefficient = (t3 - t2) + 2.0;
      let high_numerator = ((p * t2) * lower) - upper * high_coefficient;
      let low_numerator = low_coefficient * lower - (t * (p * p)) * upper;
      upper = (inverse * high_numerator).clamp(0.0, 1.0);
      lower = (inverse * low_numerator).clamp(0.0, 1.0);
    }
    let middle = t.mul_add(upper - lower, lower);
    px.map(|v| {
      if v == lo {
        lower
      } else if v == hi {
        upper
      } else {
        middle
      }
    })
  }
}

#[cfg(test)]
mod tests {
  use super::{Curve, ExtraExposure};

  #[test]
  fn negative_exposure_matches_native_f64_payloads() {
    for (ev, expected) in [
      (-0.1, 0x961f5c85b61468ef),
      (-1.0, 0x93a460b55c299f11),
      (-2.0, 0x5565e32b3632f5bb),
      (-7.0, 0x74a2c186229c7e4e),
    ] {
      let curve = ExtraExposure::new(ev);
      let actual = (0..=4096)
        .map(|i| curve.eval(i as f64 * (1.0 / 4096.0)))
        .flat_map(f64::to_le_bytes)
        .fold(0xcbf29ce484222325u64, |h, b| {
          (h ^ b as u64).wrapping_mul(0x100000001b3)
        });
      assert_eq!(actual, expected, "EV {ev}");
    }
  }

  #[test]
  fn negative_composed_full_native_table_payload() {
    let table = Curve::new(None, -0.8525166431404925, 0, 0.18).table();
    let hash = table
      .samples
      .iter()
      .flat_map(|v| v.to_le_bytes())
      .fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
      });
    assert_eq!(hash, 0xd304232e6926b3f4);
  }

  #[test]
  fn user_contrast_full_native_table_payloads() {
    let stage = super::UserContrast::new(30, 0.3136132649098005).unwrap();
    for (table, expected) in [
      (&stage.encode, 0xc6ab65b7ff9bb286),
      (&stage.decode, 0xb36c29e6d90e9dc7),
      (&stage.curve.table, 0xa091f482fca032a7),
    ] {
      let hash = table
        .samples
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .fold(0xcbf29ce484222325u64, |h, b| {
          (h ^ b as u64).wrapping_mul(0x100000001b3)
        });
      assert_eq!(hash, expected);
    }
  }

  #[test]
  fn acr3_full_native_table_payload() {
    let table = Curve::new(None, 0.0, 0, 0.18).table();
    let hash = table
      .samples
      .iter()
      .flat_map(|v| v.to_le_bytes())
      .fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
      });
    assert_eq!(hash, 0x9236bc3211a8e4a4);
  }
}

/// Default (zero luma blend) `SIMDLumaCurveSDR_32` wrapper for modern user
/// contrast. Its public boundary is linear working RGB. The CPU stage first
/// encodes every channel using a table, applies smooth RGB tone in encoded RGB,
/// then decodes using another table; replacing these tables by direct powers
/// changes output and is deliberately avoided.
#[derive(Clone, Debug)]
pub struct UserContrast {
  pub encode: Table,
  pub decode: Table,
  pub curve: Stage,
}

impl UserContrast {
  pub fn new(slider: i32, key: f64) -> Option<Self> {
    Some(Self {
      encode: Table::new(4096, srgb_encode),
      decode: Table::new(4096, srgb_decode),
      curve: Stage::user_contrast(slider, key)?,
    })
  }

  pub fn pixel(&self, px: [f32; 3]) -> [f32; 3] {
    self
      .curve
      .pixel(px.map(|x| self.encode.eval_simd(x)))
      .map(|x| self.decode.eval_simd(x))
  }
}
