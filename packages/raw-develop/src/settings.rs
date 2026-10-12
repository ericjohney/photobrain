//! User-adjustable development settings. Serializable and versioned so edits can be
//! stored alongside a photo and replayed.

use serde::{Deserialize, Serialize};

pub const SETTINGS_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum WhiteBalance {
  /// Camera's recorded white balance.
  AsShot,
  /// Correlated colour temperature in kelvin and tint (positive = magenta).
  Temperature { kelvin: f64, tint: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LensSettings {
  pub distortion: bool,
  pub chromatic_aberration: bool,
  pub vignetting: bool,
}

impl Default for LensSettings {
  /// Matches Apple's as-shot rendering, which corrects distortion and chromatic
  /// aberration but leaves the camera's vignetting curve unapplied.
  fn default() -> Self {
    Self {
      distortion: true,
      chromatic_aberration: true,
      vignetting: false,
    }
  }
}

/// Crop in display-oriented, normalised coordinates (0-1), applied after orientation.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Crop {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DevelopSettings {
  pub settings_version: u32,
  pub white_balance: WhiteBalance,
  /// Exposure adjustment in EV on top of the as-shot rendering.
  pub exposure: f64,
  /// Highlight reconstruction of clipped channels.
  pub highlight_recovery: bool,
  /// Luminance noise reduction 0-1; None = ISO-based default.
  pub luma_noise_reduction: Option<f32>,
  /// Colour noise reduction 0-1.
  pub chroma_noise_reduction: f32,
  /// Sharpening 0-2.
  pub sharpening: f32,
  /// Tone curve strength 0-1 (0 = flat transfer encode).
  pub tone_amount: f32,
  pub lens: LensSettings,
  pub crop: Option<Crop>,
  /// Additional rotation in quarter turns clockwise, applied after EXIF orientation.
  pub quarter_turns: u8,
}

impl Default for DevelopSettings {
  fn default() -> Self {
    Self {
      settings_version: SETTINGS_VERSION,
      white_balance: WhiteBalance::AsShot,
      exposure: 0.0,
      highlight_recovery: true,
      luma_noise_reduction: None,
      chroma_noise_reduction: 0.5,
      sharpening: 1.0,
      tone_amount: 1.0,
      lens: LensSettings::default(),
      crop: None,
      quarter_turns: 0,
    }
  }
}

impl DevelopSettings {
  pub fn validate(&self) -> crate::Result<()> {
    let bad = |m: &str| Err(crate::Error::Settings(m.into()));
    if self.settings_version != SETTINGS_VERSION {
      return bad("unsupported settings_version");
    }
    if !(-10.0..=10.0).contains(&self.exposure) {
      return bad("exposure must be within ±10 EV");
    }
    if let WhiteBalance::Temperature { kelvin, tint } = self.white_balance
      && (!(2000.0..=50000.0).contains(&kelvin) || !(-150.0..=150.0).contains(&tint))
    {
      return bad("white balance out of range");
    }
    for (v, hi, name) in [
      (
        self.luma_noise_reduction.unwrap_or(0.0),
        1.0,
        "luma_noise_reduction",
      ),
      (self.chroma_noise_reduction, 1.0, "chroma_noise_reduction"),
      (self.sharpening, 2.0, "sharpening"),
      (self.tone_amount, 1.0, "tone_amount"),
    ] {
      if !(0.0..=hi).contains(&v) {
        return Err(crate::Error::Settings(format!("{name} out of range")));
      }
    }
    if let Some(c) = self.crop {
      let ok = c.x >= 0.0
        && c.y >= 0.0
        && c.width > 0.0
        && c.height > 0.0
        && c.x + c.width <= 1.0 + 1e-9
        && c.y + c.height <= 1.0 + 1e-9;
      if !ok {
        return bad("crop must lie within the image");
      }
    }
    if self.quarter_turns > 3 {
      return bad("quarter_turns must be 0-3");
    }
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn json_roundtrip_and_defaults() {
    let s = DevelopSettings {
      white_balance: WhiteBalance::Temperature {
        kelvin: 5500.0,
        tint: 10.0,
      },
      exposure: 0.5,
      ..Default::default()
    };
    let j = serde_json::to_string(&s).unwrap();
    assert_eq!(serde_json::from_str::<DevelopSettings>(&j).unwrap(), s);
    let partial: DevelopSettings = serde_json::from_str(r#"{"exposure": -1}"#).unwrap();
    assert_eq!(partial.white_balance, WhiteBalance::AsShot);
    assert!(partial.validate().is_ok());
    assert!(serde_json::from_str::<DevelopSettings>(r#"{"bogus": 1}"#).is_err());
  }
}
