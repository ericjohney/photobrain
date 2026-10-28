//! External capture verification. No proprietary image data is checked in.
//! ADOBE_TONE_CAPTURES is a colon-separated list of trace_tone_stages directories.
//! Each directory contains controls.json: {"blacks": number}.

use super::{
  blacks::Blacks,
  curves::Table,
  exposure::{Info, Stage, Statistics},
};
use std::path::Path;

fn f64_at(bytes: &[u8], offset: usize) -> f64 {
  f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}
fn f32_at(bytes: &[u8], offset: usize) -> f32 {
  f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn number(json: &str, key: &str) -> isize {
  json
    .split(&format!("\"{key}\":"))
    .nth(1)
    .unwrap()
    .trim_start()
    .split(|c: char| !(c.is_ascii_digit() || c == '-'))
    .next()
    .unwrap()
    .parse()
    .unwrap()
}
fn read(path: &Path, name: &str) -> Vec<u8> {
  std::fs::read(path.join(name)).unwrap()
}
fn table(path: &Path, name: &str) -> Table {
  Table {
    samples: read(path, name)
      .chunks_exact(4)
      .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
      .collect(),
  }
}
fn captured_info(bytes: &[u8]) -> Info {
  Info {
    exposure: f64_at(bytes, 8),
    tone_exposure: f64_at(bytes, 0x18),
    baseline_adjustment: f64_at(bytes, 0x28),
    channel_flare: [0x30, 0x38, 0x40].map(|i| f64_at(bytes, i)),
    baseline: f64_at(bytes, 0x50),
    ai_amount: f64_at(bytes, 0x58),
    input_scale: f64_at(bytes, 0x60),
    whites: f64_at(bytes, 0x80),
    highlight_headroom: f64_at(bytes, 0x88),
    input_exposure: f64_at(bytes, 0x90),
    linear_exposure: f64_at(bytes, 0x98),
    rolloff_exposure: f64_at(bytes, 0xa0),
    total_exposure: f64_at(bytes, 0xa8),
    whites_amount: f64_at(bytes, 0xb0),
    highlight_luma_offset: f64_at(bytes, 0xb8),
    statistics: Statistics {
      black_reference: f64_at(bytes, 0x658),
      whites_low: f64_at(bytes, 0x670),
      whites_high: f64_at(bytes, 0x678),
      highlight_reference: f64_at(bytes, 0x690),
    },
    hdr: bytes[0x701] != 0,
  }
}

#[test]
fn captured_global_exposure_tables_and_pixels() {
  let Some(paths) = std::env::var_os("ADOBE_TONE_CAPTURES") else {
    return;
  };
  let mut verified = 0;
  for path in std::env::split_paths(&paths) {
    let object = read(&path, "003_cr_stage_exposure_obj.bin");
    let bytes = &object[0x8b8..];
    let info = captured_info(bytes);
    let controls = String::from_utf8(read(&path, "controls.json")).unwrap();
    let mut stage = Stage::from_info(&info, f32_at(bytes, 0x894));
    Blacks::mosaic(&info, number(&controls, "blacks") as i32, None, None).apply(&mut stage);
    for (name, actual) in [
      ("fc8", stage.rolloff.as_ref()),
      ("1020", stage.whites_reduce.as_ref()),
      ("10b8", stage.blacks_lift.as_ref()),
    ] {
      if let Some(actual) = actual {
        assert_table(&path, name, actual);
      }
    }
    if let Some(tables) = &stage.blacks_subtract {
      for (name, actual) in ["1050", "1070", "1090"].iter().zip(tables) {
        assert_table(&path, name, actual);
      }
    }
    let src = read(&path, "003_cr_stage_exposure_src.bin");
    let dst = read(&path, "003_cr_stage_exposure_dst.bin");
    let header = String::from_utf8(read(&path, "003_cr_stage_exposure_src.json")).unwrap();
    let row = number(&header, "row_step");
    let col = number(&header, "col_step");
    let plane = number(&header, "plane_step");
    for y in 0..number(&header, "b") - number(&header, "t") {
      for x in 0..number(&header, "r") - number(&header, "l") {
        let offset = |c| 4 * (y * row + x * col + c * plane) as usize;
        let input = std::array::from_fn(|c| f32_at(&src, offset(c as isize)));
        let out = stage.pixel(input);
        for c in 0..3 {
          assert_eq!(
            out[c].to_bits(),
            f32_at(&dst, offset(c as isize)).to_bits(),
            "{} ({x},{y}) channel{c}",
            path.display()
          );
          verified += 1;
        }
      }
    }
  }
  assert!(verified > 0, "capture list was empty");
}

fn assert_table(path: &Path, name: &str, actual: &Table) {
  let expected = table(path, &format!("003_cr_stage_exposure_table_{name}.bin"));
  assert_eq!(actual.samples.len(), expected.samples.len());
  for (i, (a, b)) in actual.samples.iter().zip(expected.samples).enumerate() {
    assert_eq!(
      a.to_bits(),
      b.to_bits(),
      "{} table{name} sample{i}",
      path.display()
    );
  }
}

// Hashes of the complete target-generated table payloads. These checks always
// run, including when the external photographic tile captures are unavailable.
#[test]
fn captured_curve_payload_digests() {
  let statistics = Statistics {
    black_reference: -11.192355155944824,
    whites_low: -8.790473937988281,
    whites_high: -2.392416000366211,
    highlight_reference: -1.996986746788025,
  };
  for (linear, rolloff, total, whites, blacks, expected) in [
    (
      0.7586009224920423,
      0.3888824343674653,
      0.07000000000000006,
      0.0,
      0,
      [0xc16470cf0f7cad5c, 0x70c72f70f49744ef],
    ),
    (
      1.1586009224920422,
      0.688882434367465,
      0.7699999999999998,
      0.4,
      -25,
      [0x876489e695856d58, 0xea9391fe17c6be0f],
    ),
  ] {
    let info = Info {
      linear_exposure: linear,
      rolloff_exposure: rolloff,
      total_exposure: total,
      whites,
      whites_amount: -whites,
      statistics,
      ..Info::default()
    };
    let mut stage = Stage::from_info(&info, 1e-9);
    Blacks::mosaic(&info, blacks, None, None).apply(&mut stage);
    let hash = |table: &Table| {
      table
        .samples
        .iter()
        .flat_map(|v| v.to_le_bytes())
        .fold(0xcbf29ce484222325u64, |h, b| {
          (h ^ b as u64).wrapping_mul(0x100000001b3)
        })
    };
    assert_eq!(hash(stage.rolloff.as_ref().unwrap()), expected[0]);
    for table in stage.blacks_subtract.as_ref().unwrap() {
      assert_eq!(hash(table), expected[1]);
    }
  }
}

#[test]
fn captured_rgb_profile_tone_pixels() {
  use super::composition::{Curve, Stage};
  let Some(paths) = std::env::var_os("ADOBE_TONE_CAPTURES") else {
    return;
  };
  let mut verified = 0;
  for path in std::env::split_paths(&paths) {
    let obj = read(&path, "005_cr_stage_rgb_tone_obj.bin");
    // The base/mixed controlled fixtures use Adobe Standard with ACR3 fallback
    // and zero negative exposure. The profile curve is its own first stage.
    let generated = Curve::new(None, 0.0, 0, 0.18).table();
    let native_path = path.join("005_cr_stage_rgb_tone_table.f32");
    if native_path.exists() {
      assert_eq!(
        generated.samples,
        table(&path, "005_cr_stage_rgb_tone_table.f32").samples
      );
    }
    let stage = Stage {
      table: generated,
      smooth: obj[0xf8] != 0,
    };
    let src = read(&path, "005_cr_stage_rgb_tone_src.bin");
    let dst = read(&path, "005_cr_stage_rgb_tone_dst.bin");
    let header = String::from_utf8(read(&path, "005_cr_stage_rgb_tone_src.json")).unwrap();
    let row = number(&header, "row_step");
    let col = number(&header, "col_step");
    let plane = number(&header, "plane_step");
    for y in 0..number(&header, "b") - number(&header, "t") {
      for x in 0..number(&header, "r") - number(&header, "l") {
        let offset = |c| 4 * (y * row + x * col + c * plane) as usize;
        let out = stage.pixel(std::array::from_fn(|c| f32_at(&src, offset(c as isize))));
        for c in 0..3 {
          assert_eq!(
            out[c].to_bits(),
            f32_at(&dst, offset(c as isize)).to_bits(),
            "{} RGB tone ({x},{y}) channel{c}",
            path.display()
          );
          verified += 1;
        }
      }
    }
  }
  assert!(verified > 0);
}

/// The modern Contrast stage is absent when the slider is zero. This separate
/// optional capture uses the controlled mixed-slider fixture and all-stage trace.
#[test]
fn captured_late_user_contrast_tables_and_pixels() {
  use super::{composition::UserContrast, curves::contrast_key};
  let Some(root) = std::env::var_os("ADOBE_USER_TONE_CAPTURE") else {
    return;
  };
  let path = Path::new(&root);
  let info = read(path, "tone-init/curve_000_info.bin");
  let adjust = read(path, "tone-init/curve_000_adjust.bin");
  let contrast = i32::from_le_bytes(adjust[0x3c..0x40].try_into().unwrap());
  let key = contrast_key(
    f64_at(&info, 0xc0),
    f64_at(&info, 0x128),
    f64_at(&info, 0x160),
  );
  let stage = UserContrast::new(contrast, key).unwrap();
  for (name, actual) in [
    ("a0", &stage.encode),
    ("b0", &stage.decode),
    ("c0", &stage.curve.table),
  ] {
    let expected = table(
      path,
      &format!("006_cr_stage_rgb_tone_nested_{name}_table.f32"),
    );
    assert_eq!(actual.samples.len(), expected.samples.len());
    for (i, (a, b)) in actual.samples.iter().zip(&expected.samples).enumerate() {
      assert_eq!(a.to_bits(), b.to_bits(), "late tone table{name} sample{i}");
    }
  }
  let src = read(path, "006_cr_stage_rgb_tone_src.bin");
  let dst = read(path, "006_cr_stage_rgb_tone_dst.bin");
  let header = String::from_utf8(read(path, "006_cr_stage_rgb_tone_src.json")).unwrap();
  let row = number(&header, "row_step");
  let col = number(&header, "col_step");
  let plane = number(&header, "plane_step");
  let mut verified = 0;
  for y in 0..number(&header, "b") - number(&header, "t") {
    for x in 0..number(&header, "r") - number(&header, "l") {
      let offset = |c| 4 * (y * row + x * col + c * plane) as usize;
      let out = stage.pixel(std::array::from_fn(|c| f32_at(&src, offset(c as isize))));
      for c in 0..3 {
        assert_eq!(
          out[c].to_bits(),
          f32_at(&dst, offset(c as isize)).to_bits(),
          "late tone ({x},{y}) channel{c}"
        );
        verified += 1;
      }
    }
  }
  assert!(verified > 0);
}
