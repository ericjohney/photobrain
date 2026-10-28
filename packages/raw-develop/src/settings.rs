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
  /// Matches Apple's as-shot rendering, which corrects distortion only (its graph has
  /// `radialLens`, never the per-channel `radialLensRB`), leaving the camera's
  /// chromatic aberration and vignetting curves unapplied.
  /// Full Adobe always applies its mandatory embedded CA opcode separately.
  fn default() -> Self {
    Self {
      distortion: true,
      chromatic_aberration: false,
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

/// Camera Raw NR controls in Adobe's integer slider units (0-100).
/// When present these override the shared noise-reduction amounts on the full
/// Adobe engine. Apple and binned previews do not use this block.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AdobeNoiseReduction {
  pub color: u8,
  pub detail: u8,
  pub smoothness: u8,
  pub luminance: u8,
  pub luminance_detail: u8,
  pub luminance_contrast: u8,
}

impl Default for AdobeNoiseReduction {
  fn default() -> Self {
    Self {
      color: 25,
      detail: 50,
      smoothness: 50,
      luminance: 0,
      luminance_detail: 50,
      luminance_contrast: 0,
    }
  }
}

/// Camera Raw's five integer Basic tone controls. Exposure uses the shared
/// `DevelopSettings::exposure` field, in EV. These controls are specific to the
/// full Adobe engine and are independent of its noise-reduction controls.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AdobeTone {
  pub contrast: i32,
  pub highlights: i32,
  pub shadows: i32,
  pub whites: i32,
  pub blacks: i32,
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
  /// Optional Adobe NR controls. Omitted: shared amounts rounded to integer
  /// 0-100 sliders (absent luma = 0), details/smoothness 50, luma contrast 0.
  pub adobe_noise_reduction: Option<AdobeNoiseReduction>,
  /// Camera Raw tone sliders, each -100..100 (omitted = zero).
  pub adobe_tone: Option<AdobeTone>,
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
      adobe_noise_reduction: None,
      adobe_tone: None,
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
    if let Some(nr) = &self.adobe_noise_reduction
      && [
        nr.color,
        nr.detail,
        nr.smoothness,
        nr.luminance,
        nr.luminance_detail,
        nr.luminance_contrast,
      ]
      .iter()
      .any(|&v| v > 100)
    {
      return bad("Adobe noise reduction controls must be within 0-100");
    }
    if let Some(tone) = &self.adobe_tone
      && [
        tone.contrast,
        tone.highlights,
        tone.shadows,
        tone.whites,
        tone.blacks,
      ]
      .iter()
      .any(|v| !(-100..=100).contains(v))
    {
      return bad("Adobe tone controls must be within -100..100");
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

  #[test]
  fn adobe_noise_reduction_uses_integer_sliders_and_validates_limits() {
    let settings: DevelopSettings =
      serde_json::from_str(r#"{"adobe_noise_reduction": {}}"#).unwrap();
    assert_eq!(
      settings.adobe_noise_reduction,
      Some(AdobeNoiseReduction::default())
    );
    assert!(settings.validate().is_ok());
    let settings: DevelopSettings = serde_json::from_str(
      r#"{"adobe_noise_reduction": {"color": 62, "detail": 80, "smoothness": 75}}"#,
    )
    .unwrap();
    assert!(settings.validate().is_ok());
    assert_eq!(
      serde_json::from_str::<DevelopSettings>(&serde_json::to_string(&settings).unwrap()).unwrap(),
      settings
    );
    let invalid: DevelopSettings =
      serde_json::from_str(r#"{"adobe_noise_reduction": {"detail": 101}}"#).unwrap();
    assert!(invalid.validate().is_err());
    assert!(
      serde_json::from_str::<DevelopSettings>(r#"{"adobe_noise_reduction": {"color": 25.5}}"#)
        .is_err()
    );
  }

  #[test]
  fn adobe_tone_controls_are_integer_and_bounded() {
    let settings: DevelopSettings = serde_json::from_str(
      r#"{"adobe_tone":{"contrast":50,"highlights":-100,"shadows":100,"whites":25,"blacks":-40}}"#,
    )
    .unwrap();
    assert!(settings.validate().is_ok());
    assert_eq!(
      serde_json::from_str::<DevelopSettings>(&serde_json::to_string(&settings).unwrap()).unwrap(),
      settings
    );
    let invalid: DevelopSettings =
      serde_json::from_str(r#"{"adobe_tone":{"whites":101}}"#).unwrap();
    assert!(invalid.validate().is_err());
    assert!(serde_json::from_str::<DevelopSettings>(r#"{"adobe_tone":{"contrast":0.5}}"#).is_err());
  }
}
