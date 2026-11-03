use super::*;

#[test]
fn short_exposure_repairs_defects_across_strip_seam() {
  let (width, height) = (32, 260);
  let black = 2048.0 / 65535.0;
  let mut source = vec![10000; width * height];
  // Both parities and both sides of the 128-row scratch-strip boundary.
  for (y, x, value) in [
    (127, 6, 65535),
    (128, 23, 0),
    (255, 10, 0),
    (256, 25, 65535),
  ] {
    source[y * width + x] = value;
  }
  let actual = denoise_prepare_short_exposure(width, height, black, &Cancel::never(), |y, x| {
    source[y * width + x]
  })
  .unwrap();
  let expected = denoise_roundtrip_table(black)[10000];
  assert!(actual.iter().all(|&v| v == expected));
}

#[test]
fn short_exposure_checks_extent_and_cancellation() {
  assert!(denoise_prepare_short_exposure(3, 4, 0.0, &Cancel::never(), |_, _| 1).is_err());
  assert!(denoise_prepare_short_exposure(4, 4, f64::NAN, &Cancel::never(), |_, _| 1).is_err());
  let cancel = Cancel::new();
  cancel.cancel();
  assert!(matches!(
    denoise_prepare_short_exposure(4, 4, 0.0, &cancel, |_, _| panic!(
      "sample after cancellation"
    )),
    Err(Error::Cancelled)
  ));
}

#[test]
fn synthetic_hotpixel_stage_matches_native_digest() {
  use sha2::{Digest, Sha256};
  let fixture: serde_json::Value =
    serde_json::from_str(include_str!("denoise-hotpixel-fixture.json")).unwrap();
  let rect = |key: &str| -> [isize; 4] {
    std::array::from_fn(|i| fixture[key]["rect"][i].as_i64().unwrap() as isize)
  };
  let source_rect = rect("input");
  let output_rect = rect("output");
  let width = (source_rect[3] - source_rect[1]) as usize;
  let height = (source_rect[2] - source_rect[0]) as usize;
  let mut source = Vec::new();
  for row in source_rect[0]..source_rect[2] {
    for col in source_rect[1]..source_rect[3] {
      source.push(((row * 131 + col * 43 + 8192).rem_euclid(18000) + 22000) as u16);
    }
  }
  let index = |row: isize, col: isize| {
    (row - source_rect[0]) as usize * width + (col - source_rect[1]) as usize
  };
  for spot in fixture["spots"].as_array().unwrap() {
    let row = spot[0].as_i64().unwrap() as isize;
    let col = spot[1].as_i64().unwrap() as isize;
    for dy in -5..=5 {
      for dx in -5..=5 {
        source[index(row + dy, col + dx)] = 30000;
      }
    }
    source[index(row, col)] = spot[2].as_u64().unwrap() as u16;
  }
  let digest = |values: &[u16]| {
    let mut hash = Sha256::new();
    for v in values {
      hash.update(v.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
  };
  assert_eq!(
    digest(&source),
    fixture["input"]["sha256"].as_str().unwrap()
  );
  let repaired = hotpixel::suppress(
    &source,
    width,
    height,
    source_rect[0],
    source_rect[1],
    8000,
    6000,
  );
  let mut result = Vec::new();
  for row in output_rect[0]..output_rect[2] {
    for col in output_rect[1]..output_rect[3] {
      result.push(repaired[index(row, col)]);
    }
  }
  assert_eq!(result.len(), 168857);
  assert_eq!(
    digest(&result),
    fixture["output"]["sha256"].as_str().unwrap()
  );
}

#[test]
fn synthetic_baseline_pipeline_matches_native_digest() {
  use sha2::{Digest, Sha256};
  let fixture: serde_json::Value =
    serde_json::from_str(include_str!("denoise-baseline-fixture.json")).unwrap();
  let black = fixture["context"]["black"].as_f64().unwrap();
  let gains: [f64; 3] = std::array::from_fn(|c| fixture["context"]["gains"][c].as_f64().unwrap());
  let detail = fixture["context"]["detail"].as_f64().unwrap() as f32;
  let parameters = DenoiseBaseline {
    gain: gains.map(|v| affine(v, black)),
    encode: tables::expand(|v| tables::log_encode(v, black)),
    decode: tables::expand(|v| tables::log_decode(v, black)),
    core: core::Parameters::from_detail_factor(detail),
  };
  let rect = |key: &str| -> [isize; 4] {
    std::array::from_fn(|i| fixture[key]["rect"][i].as_i64().unwrap() as isize)
  };
  let input = rect("input");
  let output = rect("output");
  let width = (input[3] - input[1]) as usize;
  let height = (input[2] - input[0]) as usize;
  let mut source = Vec::new();
  for y in input[0]..input[2] {
    for x in input[1]..input[3] {
      source.push(normalized(
        ((y * 137 + x * 53 + 33333).rem_euclid(50000) + 4096) as u16,
      ));
    }
  }
  let digest = |values: &[f32]| {
    let mut hash = Sha256::new();
    for v in values {
      hash.update(v.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
  };
  assert_eq!(
    digest(&source),
    fixture["input"]["f32_interleaved_sha256"].as_str().unwrap()
  );
  let result = parameters
    .process(&source, width, height, input[0], input[1], &Cancel::never())
    .unwrap();
  let mut cropped = Vec::new();
  for y in output[0]..output[2] {
    for x in output[1]..output[3] {
      let index = ((y - input[0]) as usize * width + (x - input[1]) as usize) * 3;
      cropped.extend_from_slice(&result.data[index..index + 3]);
    }
  }
  assert_eq!(cropped.len(), 81672);
  assert_eq!(
    digest(&cropped),
    fixture["output"]["f32_interleaved_sha256"]
      .as_str()
      .unwrap()
  );
  let cancelled = Cancel::new();
  cancelled.cancel();
  assert!(matches!(
    parameters.process(&source, width, height, input[0], input[1], &cancelled),
    Err(Error::Cancelled)
  ));
}
