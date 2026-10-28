//! Ordinary SDR mosaic-RAW initialization of `cr_exposure_info` (18.7 ARM64).
//!
//! `InitializeForRender` (0x100e52eb8), `EstimateHighlightHeadroom`
//! (0x1008c147c), and `AppendStage_CameraToRIMM` (0x1008bffac). The gray and
//! channel statistics precede user tone controls. Post-tone statistics are
//! attached separately before `Info::calculate`.

use super::{exposure::Info, statistics::Statistics};
use crate::adobe::{color::ColorSpec, input::InputTransform};

const FLARE: f64 = 1.0 / 4096.0;
const MAX_LINEAR: f64 = f64::from_bits(0x4770_0000_0000_0000);

#[derive(Clone, Copy, Debug)]
pub(crate) struct Parameters {
  /// The native integer Exposure2012 control, in hundredths of an EV.
  pub(crate) exposure_hundredths: i32,
  pub(crate) whites: i32,
  /// Negative BaselineExposure plus the DCP BaselineExposureOffset.
  pub(crate) baseline_exposure: f64,
  /// Negative stage-three raw scale (one for the supported RAF/ARW branch).
  pub(crate) raw_scale: f64,
  /// CalculateFlareForLog's scene-dependent result, when positive.
  pub(crate) custom_flare: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct Setup {
  /// Initialized and camera-gain adjusted; attach post-tone statistics later.
  pub(crate) info: Info,
  /// Contrast2012 key from the initial gray image, not the post-tone image.
  pub(crate) key: f64,
  pub(crate) log_flare: f64,
  pub(crate) epsilon: f32,
}

impl Setup {
  pub(crate) fn new(
    parameters: Parameters,
    render_color: &ColorSpec,
    neutral: [f64; 3],
    gray: &Statistics,
    colors: &[Statistics; 3],
  ) -> Self {
    // RawLinearToRIMM uses an ordinary camera transform with zero sensor black,
    // then restores its camera-gain exposure in a separate f32 stage.
    let input = InputTransform::new(render_color, neutral, 0.0);
    let highs = colors.each_ref().map(|s| s.exposure().highlight_reference);
    let (highlight_headroom, highlight_luma_offset) = headroom(&input, highs);
    let mut info = Info {
      exposure: (f64::from(parameters.exposure_hundredths) * 0.01).clamp(-5.0, 5.0),
      whites: f64::from(parameters.whites) * 0.02,
      baseline: parameters.baseline_exposure + parameters.raw_scale.ln() / -std::f64::consts::LN_2,
      input_scale: 1.0,
      highlight_headroom,
      highlight_luma_offset,
      ..Info::default()
    };
    let input_ev = input.exposure_adjustment();
    info.adjust(input_ev, input_ev);
    Self {
      key: gray.key(),
      log_flare: log_flare(&info, parameters.custom_flare),
      epsilon: epsilon(&info, parameters.custom_flare),
      info,
    }
  }
}

fn headroom(input: &InputTransform, highs: [f64; 3]) -> (f64, f64) {
  let pixel = highs.map(|high| {
    let value = if high <= -120.0 {
      -FLARE
    } else {
      high.min(120.0).exp2() - FLARE
    };
    value.max(0.0) as f32
  });
  let gain = input.exposure_adjustment().exp2() as f32;
  let [r, g, b] = input.headroom_pixel(pixel).map(|v| f64::from(v * gain));
  let log_value = |v: f64| {
    if v <= 0.0 {
      -12.0
    } else {
      (v.min(MAX_LINEAR) + FLARE).log2()
    }
  };
  let maximum = log_value(r.max(g).max(b));
  let luma = b.mul_add(
    0.11000001430511475,
    r.mul_add(0.30000001192092896, g * 0.5899999737739563),
  );
  (-maximum, log_value(luma) - maximum)
}

/// `NegativeToFlareForLog` with an optional positive custom negative flare.
/// Supported ordinary mosaic RAWs use the default base of 2^-12.
pub(crate) fn log_flare(info: &Info, custom: Option<f64>) -> f64 {
  let base = custom.filter(|v| *v > 0.0).map_or(FLARE, |v| v.min(FLARE));
  (base * (-info.input_exposure).exp2()).clamp(0.0, FLARE)
}

/// `NegativeToEps`; custom negative flare, when present, also supplies the base.
pub(crate) fn epsilon(info: &Info, custom: Option<f64>) -> f32 {
  let base = custom
    .filter(|v| *v > 0.0)
    .map_or(1.0 / 524288.0, |v| v.min(FLARE) * (1.0 / 128.0));
  (base * (-info.input_exposure).exp2()).clamp(f64::from_bits(0x3870_0000_0000_0000), 1.0 / 65536.0)
    as f32
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn flare_and_epsilon_clamps_follow_input_exposure() {
    let mut info = Info::default();
    assert_eq!(log_flare(&info, None), FLARE);
    assert_eq!(epsilon(&info, None), 1.0 / 524288.0);
    info.input_exposure = 3.0;
    assert_eq!(log_flare(&info, None), FLARE / 8.0);
    assert_eq!(epsilon(&info, None), 1.0 / 4194304.0);
    assert_eq!(epsilon(&info, Some(FLARE / 2.0)), 1.0 / 8388608.0);
    info.input_exposure = -20.0;
    assert_eq!(log_flare(&info, None), FLARE);
    assert_eq!(epsilon(&info, None), 1.0 / 65536.0);
    info.input_exposure = 200.0;
    assert_eq!(epsilon(&info, None), f32::from_bits(0x0380_0000));
  }

  #[test]
  fn captured_exposure_initialization() {
    let (Some(paths), Some(raw), Some(profiles), Some(stats)) = (
      std::env::var_os("ADOBE_TONE_SETUP_CAPTURES"),
      std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
      std::env::var_os("ADOBE_TONE_SETUP_STATS"),
    ) else {
      return;
    };
    let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp = crate::adobe::dcp::Dcp::open(
      &crate::adobe::dcp::Dcp::find_adobe_standard(
        std::path::Path::new(&profiles),
        &meta.make,
        &meta.model,
      )
      .unwrap(),
    )
    .unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
    let spec = ColorSpec::for_render(&dcp, &meta, neutral, &crate::settings::WhiteBalance::AsShot);
    let stats = std::path::Path::new(&stats);
    let statistics: [Statistics; 5] = std::array::from_fn(|i| {
      let values = std::fs::read(stats.join(format!("stats-{i:02}.sorted.f32"))).unwrap();
      let values: Vec<f32> = values
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
      let header: serde_json::Value =
        serde_json::from_slice(&std::fs::read(stats.join(format!("stats-{i:02}.json"))).unwrap())
          .unwrap();
      Statistics::new(&values, header["d0"].as_f64().unwrap()).unwrap()
    });
    let colors = statistics[1..4].to_vec().try_into().unwrap();
    let header: serde_json::Value =
      serde_json::from_slice(&std::fs::read(stats.join("stats-00.json")).unwrap()).unwrap();
    let custom_flare = header["d0"].as_f64().unwrap();
    let mut checked = 0;
    for root in std::env::split_paths(&paths) {
      let path = root.join("tone-init");
      let expected = std::fs::read(path.join("curve_000_info.bin")).unwrap();
      let adjust = std::fs::read(path.join("curve_000_adjust.bin")).unwrap();
      let f64_at = |o| f64::from_le_bytes(expected[o..o + 8].try_into().unwrap());
      let i32_at = |o| i32::from_le_bytes(adjust[o..o + 4].try_into().unwrap());
      let setup = Setup::new(
        Parameters {
          exposure_hundredths: i32_at(0x38),
          whites: i32_at(0x48),
          baseline_exposure: crate::adobe::baseline_exposure(&meta).unwrap()
            + dcp.baseline_exposure_offset,
          raw_scale: 1.0,
          custom_flare: Some(custom_flare),
        },
        &spec,
        neutral,
        &statistics[0],
        &colors,
      );
      let i = &setup.info;
      for (offset, actual) in [
        (8, i.exposure),
        (0x18, i.tone_exposure),
        (0x28, i.baseline_adjustment),
        (0x30, i.channel_flare[0]),
        (0x38, i.channel_flare[1]),
        (0x40, i.channel_flare[2]),
        (0x50, i.baseline),
        (0x58, i.ai_amount),
        (0x60, i.input_scale),
        (0x80, i.whites),
        (0x88, i.highlight_headroom),
        (0x90, i.input_exposure),
        (0x98, i.linear_exposure),
        (0xa0, i.rolloff_exposure),
        (0xa8, i.total_exposure),
        (0xb0, i.whites_amount),
        (0xb8, i.highlight_luma_offset),
      ] {
        assert_eq!(
          actual.to_bits(),
          f64_at(offset).to_bits(),
          "{} field {offset:#x}: {actual} vs {}",
          path.display(),
          f64_at(offset)
        );
        checked += 1;
      }
      // The contrast key is measured before the profile-coloured post image.
      assert_eq!(setup.key, 0.3136132649098005);
      let model = root.join("003_cr_stage_exposure_obj.bin");
      if model.exists() {
        let object = std::fs::read(model).unwrap();
        let expected = &object[0x8b8..];
        let f64_at = |o| f64::from_le_bytes(expected[o..o + 8].try_into().unwrap());
        let mut info = setup.info;
        info.statistics = statistics[4].exposure();
        info.calculate();
        for (offset, actual) in [
          (0x98, info.linear_exposure),
          (0xa0, info.rolloff_exposure),
          (0xa8, info.total_exposure),
          (0xb0, info.whites_amount),
          (0x658, info.statistics.black_reference),
          (0x670, info.statistics.whites_low),
          (0x678, info.statistics.whites_high),
          (0x690, info.statistics.highlight_reference),
        ] {
          assert_eq!(
            actual.to_bits(),
            f64_at(offset).to_bits(),
            "post exposure {offset:#x}"
          );
        }
        assert_eq!(
          setup.epsilon.to_bits(),
          f32::from_le_bytes(expected[0x894..0x898].try_into().unwrap()).to_bits()
        );
      }
    }
    assert!(checked > 0);
  }
}
