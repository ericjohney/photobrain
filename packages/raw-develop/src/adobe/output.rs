//! Modern Adobe output boundary, after the primary tone and late contrast.
//!
//! Converter 18.7 appends solid-frame, `cr_stage_matrix3by3`, and the output
//! `cr_stage_1d_table`. Working RIMM is committed to u16 before the signed
//! fixed-point matrix; matrix output is then encoded through a 65,536-entry
//! transfer table. The central captured solid-frame stage is an identity.
//!
//! Colour-space matrices and normalization follow `dng_color_space` in the
//! public DNG SDK. Display P3's rounded PCS coefficients are from Converter's
//! `dng_space_DisplayP3` constructor (0x1013d2444); both destinations use
//! `dng_function_GammaEncode_sRGB`. Fixed-point construction follows
//! `cr_stage_matrix3by3` (0x100b2e094). Local `trace/output-xe5-mixed` and
//! `trace/output-a7rm5-mixed` captures, produced by `scripts/trace_output.py`
//! under `/Users/eric/acr-re`, validate every channel from exposure input through
//! sRGB: 135,424 Fuji and 142,113 Sony RGB pixels. Both have Sharpness=0 and do
//! not establish Adobe sharpening behavior.
//!
//! The composed regression also establishes u16 commits after exposure and
//! after the profile LookTable, followed by float primary tone -> late contrast
//! without an intervening commit. Run it with `RAW_DEVELOP_ADOBE_OUTPUT_TRACE`
//! naming that capture directory, `RAW_DEVELOP_ADOBE_OUTPUT_RAW` naming its
//! mixed.RAF/mixed.ARW source, and `ADOBE_PROFILE_DIR` naming the installed DCP
//! directory. Sony's DefaultCrop translates the output tile origin by (-20,-32)
//! while retaining the pixel order.

use super::bayer::tables;
use super::color::PROPHOTO_TO_XYZ_D50;
use crate::math::Mat3;

#[derive(Clone, Copy, Debug)]
pub(crate) enum OutputSpace {
  DisplayP3,
  Srgb,
}

impl OutputSpace {
  fn matrix_to_pcs(self) -> Mat3 {
    let matrix = match self {
      Self::DisplayP3 => Mat3([
        [0.5151, 0.2920, 0.1571],
        [0.2412, 0.6922, 0.0666],
        [-0.0010, 0.0419, 0.7843],
      ]),
      Self::Srgb => Mat3([
        [0.4361, 0.3851, 0.1431],
        [0.2225, 0.7169, 0.0606],
        [0.0139, 0.0971, 0.7141],
      ]),
    };
    let white = [0.3457 / 0.3585, 1.0, (1.0 - 0.3457 - 0.3585) / 0.3585];
    Mat3(std::array::from_fn(|r| {
      let scale = white[r] / matrix.0[r].iter().sum::<f64>();
      matrix.0[r].map(|v| v * scale)
    }))
  }
}

#[derive(Clone, Debug)]
pub(crate) struct Output {
  matrix: FixedMatrix,
  gamma: Vec<u16>,
}

impl Output {
  pub(crate) fn new(space: OutputSpace) -> Self {
    Self {
      matrix: FixedMatrix::new(space.matrix_to_pcs().inverse().mul(&PROPHOTO_TO_XYZ_D50)),
      gamma: tables::expand(gamma_encode),
    }
  }

  #[inline]
  pub(crate) fn pixel(&self, pixel: [f32; 3]) -> [f32; 3] {
    self
      .matrix
      .apply(pixel.map(tables::code))
      .map(|v| tables::normalized(self.gamma[v as usize]))
  }
}

fn gamma_encode(value: f64) -> f64 {
  if value <= 0.0031308 {
    value * 12.92
  } else {
    value.powf(1.0 / 2.4).mul_add(1.055, -0.055)
  }
}

#[derive(Clone, Debug)]
struct FixedMatrix {
  shift: u32,
  rows: [[i64; 4]; 3],
}

impl FixedMatrix {
  fn new(matrix: Mat3) -> Self {
    for shift in (8..=14).rev() {
      let scale = (1u32 << shift) as f64;
      let mut rows = [[0; 4]; 3];
      let mut valid = true;
      for r in 0..3 {
        let m = matrix.0[r];
        let positive = m.iter().map(|v| (v * scale).max(0.0)).sum::<f64>();
        let negative = -m.iter().map(|v| (v * scale).min(0.0)).sum::<f64>();
        valid &= positive.max(negative) <= 30000.0;
        for c in 0..3 {
          rows[r][c] = (m[c] * scale).round() as i64;
        }
        rows[r][3] = rows[r][..3].iter().sum::<i64>() * 32768 - (1i64 << shift) * 32768
          + (1i64 << (shift - 1));
        let bound = rows[r][..3].iter().map(|v| v.abs()).sum::<i64>() * 32768;
        valid &= rows[r][3] - bound >= i32::MIN as i64 && rows[r][3] + bound <= i32::MAX as i64;
      }
      if valid {
        return Self { shift, rows };
      }
    }
    unreachable!("Adobe output matrix fits signed fixed point")
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
  use std::path::Path;

  #[test]
  fn captured_srgb_fixed_matrix() {
    let output = Output::new(OutputSpace::Srgb);
    assert_eq!(output.matrix.shift, 13);
    assert_eq!(
      output.matrix.rows,
      [
        [16665, -5958, -2515, 4096],
        [-1875, 10090, -23, 4096],
        [-69, -1256, 9517, 4096],
      ]
    );
  }

  #[test]
  fn output_spaces_encode_endpoints_and_clip_gamut() {
    for space in [OutputSpace::DisplayP3, OutputSpace::Srgb] {
      let output = Output::new(space);
      assert_eq!(output.pixel([0.0; 3]), [0.0; 3]);
      assert_eq!(output.pixel([1.0; 3]), [1.0; 3]);
      for pixel in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
        assert!(
          output
            .pixel(pixel)
            .into_iter()
            .all(|v| (0.0..=1.0).contains(&v))
        );
      }
    }
  }

  fn captured_pixels(root: &Path, stem: &str) -> Vec<[f32; 3]> {
    let h: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap()).unwrap();
    let n = |key: &str| h[key].as_i64().unwrap() as usize;
    let width = n("r") - n("l");
    let height = n("b") - n("t");
    let raw = std::fs::read(root.join(format!("{stem}.bin"))).unwrap();
    (0..width * height)
      .map(|i| {
        std::array::from_fn(|c| {
          let offset =
            ((i / width) * n("row_step") + (i % width) * n("col_step") + c * n("plane_step"))
              * n("psize");
          match n("ptype") {
            8 => tables::normalized(
              u16::from_le_bytes(raw[offset..offset + 2].try_into().unwrap()) ^ 32768,
            ),
            11 => f32::from_le_bytes(raw[offset..offset + 4].try_into().unwrap()),
            other => panic!("unsupported captured pixel type {other}"),
          }
        })
      })
      .collect()
  }

  fn stage_stems(root: &Path, class: &str) -> Vec<String> {
    let suffix = format!("_{class}_obj.bin");
    let mut stems: Vec<_> = std::fs::read_dir(root)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .filter(|name| name.ends_with(&suffix))
      .map(|name| name.trim_end_matches("_obj.bin").to_owned())
      .collect();
    stems.sort();
    assert!(!stems.is_empty(), "capture has no {class}");
    stems
  }

  #[test]
  fn captured_output_boundary() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_OUTPUT_TRACE") else {
      return;
    };
    let root = Path::new(&root);
    let output = Output::new(OutputSpace::Srgb);
    let gamma = stage_stems(root, "cr_stage_1d_table").pop().unwrap();
    let tone = stage_stems(root, "cr_stage_rgb_tone").pop().unwrap();
    let frame = stage_stems(root, "cr_stage_solid_frame").pop().unwrap();
    let matrix = stage_stems(root, "cr_stage_matrix3by3").pop().unwrap();
    let expected_table: Vec<f32> = std::fs::read(root.join(format!("{gamma}_data_28.bin")))
      .unwrap()
      .chunks_exact(4)
      .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
      .collect();
    let actual_table: Vec<f32> = (0..4098)
      .map(|i| gamma_encode(i.min(4096) as f64 / 4096.0) as f32)
      .collect();
    assert_eq!(actual_table, expected_table, "sampled float gamma table");
    let expected_lut: Vec<u16> = std::fs::read(root.join(format!("{gamma}_data_38.bin")))
      .unwrap()
      .chunks_exact(2)
      .map(|v| u16::from_le_bytes(v.try_into().unwrap()))
      .collect();
    assert_eq!(output.gamma, expected_lut, "expanded gamma table");

    let input = captured_pixels(root, &format!("{tone}_dst"));
    let committed = captured_pixels(root, &format!("{frame}_src"));
    let framed = captured_pixels(root, &format!("{frame}_dst"));
    let matrix_input = captured_pixels(root, &format!("{matrix}_src"));
    let matrix_output = captured_pixels(root, &format!("{matrix}_dst"));
    let gamma_input = captured_pixels(root, &format!("{gamma}_src"));
    let expected = captured_pixels(root, &format!("{gamma}_dst"));
    assert_eq!(input.len(), expected.len());
    assert_eq!(committed, framed, "central solid frame is identity");
    assert_eq!(framed, matrix_input, "frame to matrix boundary");
    assert_eq!(matrix_output, gamma_input, "matrix to gamma boundary");
    for (i, pixel) in input.iter().enumerate() {
      let quantized = pixel.map(|v| tables::normalized(tables::code(v)));
      assert_eq!(quantized, committed[i], "late tone u16 commit, pixel {i}");
      assert_eq!(
        output
          .matrix
          .apply(quantized.map(tables::code))
          .map(tables::normalized),
        matrix_output[i],
        "fixed matrix, pixel {i}"
      );
      assert_eq!(
        output.pixel(*pixel),
        expected[i],
        "composed output, pixel {i}"
      );
    }
    eprintln!("Adobe output boundary: {} exact RGB pixels", input.len());
  }

  /// Profile data comes from the caller's DCP; the private exposure state is
  /// captured separately from the test pixels. Settings default to the original
  /// mixed fixture when the capture has no settings.json sidecar.
  #[test]
  fn captured_exposure_to_output_composition() {
    use crate::adobe::{
      color_table::ColorTable,
      dcp::Dcp,
      tone::{
        blacks::Blacks,
        composition::{Curve, Stage, UserContrast},
        curves::contrast_key,
        exposure::{Info, Stage as Exposure, Statistics},
      },
    };
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_OUTPUT_TRACE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_OUTPUT_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = Path::new(&root);
    let settings_path = root.join("settings.json");
    let settings = if settings_path.exists() {
      serde_json::from_slice::<crate::DevelopSettings>(&std::fs::read(settings_path).unwrap())
        .unwrap()
    } else {
      crate::DevelopSettings {
        exposure: 0.7,
        adobe_tone: Some(crate::settings::AdobeTone {
          contrast: 30,
          whites: 20,
          blacks: -25,
          ..Default::default()
        }),
        ..Default::default()
      }
    };
    settings.validate().unwrap();
    let controls = settings.adobe_tone.clone().unwrap_or_default();
    let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let dcp =
      Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
        .unwrap();
    let exposure_stem = stage_stems(root, "cr_stage_exposure").pop().unwrap();
    let tone_stems = stage_stems(root, "cr_stage_rgb_tone");
    let primary_stem = &tone_stems[0];
    let gamma_stem = stage_stems(root, "cr_stage_1d_table").pop().unwrap();
    let object = std::fs::read(root.join(format!("{exposure_stem}_obj.bin"))).unwrap();
    let bytes = &object[0x8b8..];
    let f64_at = |o| f64::from_le_bytes(bytes[o..o + 8].try_into().unwrap());
    let info = Info {
      exposure: f64_at(8),
      tone_exposure: f64_at(0x18),
      baseline_adjustment: f64_at(0x28),
      channel_flare: [0x30, 0x38, 0x40].map(f64_at),
      baseline: f64_at(0x50),
      ai_amount: f64_at(0x58),
      input_scale: f64_at(0x60),
      whites: f64_at(0x80),
      highlight_headroom: f64_at(0x88),
      input_exposure: f64_at(0x90),
      linear_exposure: f64_at(0x98),
      rolloff_exposure: f64_at(0xa0),
      total_exposure: f64_at(0xa8),
      whites_amount: f64_at(0xb0),
      highlight_luma_offset: f64_at(0xb8),
      statistics: Statistics {
        black_reference: f64_at(0x658),
        whites_low: f64_at(0x670),
        whites_high: f64_at(0x678),
        highlight_reference: f64_at(0x690),
      },
      hdr: bytes[0x701] != 0,
    };
    assert_eq!(
      info.exposure,
      (settings.exposure * 100.0).round() * 0.01,
      "capture exposure must match settings"
    );
    let epsilon = f32::from_le_bytes(bytes[0x894..0x898].try_into().unwrap());
    let mut exposure = Exposure::from_info(&info, epsilon);
    Blacks::mosaic(&info, controls.blacks, None, None).apply(&mut exposure);
    let key = contrast_key(f64_at(0xc0), f64_at(0x128), f64_at(0x160));
    let look = dcp
      .look_table
      .as_ref()
      .map(|map| ColorTable::new(map, dcp.look_table_encoding == 1, 1.0, 1.0, false));
    let primary = Stage::from_curve(&Curve::new(
      dcp.tone_curve.as_deref(),
      info.tone_exposure,
      0,
      key,
    ));
    let contrast = UserContrast::new(controls.contrast, key);
    let output = Output::new(OutputSpace::Srgb);
    let input = captured_pixels(root, &format!("{exposure_stem}_src"));
    let primary_input = captured_pixels(root, &format!("{primary_stem}_src"));
    let primary_output = captured_pixels(root, &format!("{primary_stem}_dst"));
    let contrast_output = contrast.as_ref().map(|_| {
      assert_eq!(tone_stems.len(), 2);
      let contrast_input = captured_pixels(root, &format!("{}_src", tone_stems[1]));
      assert_eq!(
        primary_output, contrast_input,
        "tone to contrast stays float"
      );
      captured_pixels(root, &format!("{}_dst", tone_stems[1]))
    });
    let expected = captured_pixels(root, &format!("{gamma_stem}_dst"));
    assert_eq!(input.len(), expected.len());
    let commit = |p: [f32; 3]| p.map(|v| tables::normalized(tables::code(v)));
    for (i, pixel) in input.iter().enumerate() {
      let exposed = commit(exposure.pixel(*pixel));
      let mapped = commit(look.as_ref().map_or(exposed, |look| look.pixel(exposed)));
      assert_eq!(mapped, primary_input[i], "exposure + LookTable, pixel {i}");
      let toned = primary.pixel(mapped);
      assert_eq!(toned, primary_output[i], "primary tone, pixel {i}");
      let contrasted = contrast
        .as_ref()
        .map_or(toned, |contrast| contrast.pixel(toned));
      if let Some(expected) = &contrast_output {
        assert_eq!(contrasted, expected[i], "late contrast, pixel {i}");
      }
      assert_eq!(
        output.pixel(contrasted),
        expected[i],
        "full composition, pixel {i}"
      );
    }
    eprintln!(
      "Adobe exposure-to-output composition: {} exact RGB pixels",
      input.len()
    );
  }
}
