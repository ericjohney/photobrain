//! Optional same-run native camera-image → scene → display regression.
//! All RAWs, profiles and native pixel captures remain external.

use super::*;
use crate::adobe::{output::OutputSpace, tone::stats_image};
use crate::settings::AdobeNoiseReduction;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn json(path: &Path) -> Value {
  serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn floats(path: &Path) -> Vec<f32> {
  let bytes = fs::read(path).unwrap();
  assert_eq!(bytes.len() % 4, 0);
  bytes
    .chunks_exact(4)
    .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
    .collect()
}

fn assert_population(mut actual: Vec<f32>, root: &Path, index: usize) {
  actual.sort_unstable_by(f32::total_cmp);
  let expected = floats(&root.join(format!("stats-{index:02}.sorted.f32")));
  assert_eq!(actual.len(), expected.len());
  let mismatches = actual
    .iter()
    .zip(&expected)
    .filter(|(a, b)| a.to_bits() != b.to_bits())
    .count();
  eprintln!(
    "composed statistics population {index}: {} samples, {mismatches} differences",
    actual.len()
  );
  assert_eq!(mismatches, 0, "statistics population {index}");
}

/// Set RAW_DENOISE_RENDER_CAPTURE to composed-native-{bayer,xtrans},
/// RAW_DEVELOP_ADOBE_RAW to its source RAW and ADOBE_PROFILE_DIR to the DCPs.
/// This uses one run's complete pre-CA camera image and downstream oracles.
/// It deliberately bypasses the numerical CNN, but uses the real bridge for
/// commit/crop, metadata-derived CA, scene preparation and final rendering.
#[test]
fn captured_camera_to_scene_and_output() {
  let (Some(root), Some(raw), Some(profiles)) = (
    std::env::var_os("RAW_DENOISE_RENDER_CAPTURE"),
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("ADOBE_PROFILE_DIR"),
  ) else {
    return;
  };
  let root = Path::new(&root);
  let header = json(&root.join("camera.json"));
  let bytes = fs::read(&raw).unwrap();
  assert_eq!(
    format!("{:x}", Sha256::digest(&bytes)),
    header["source_sha256"]
  );
  let negative = Negative::from_bytes(&bytes).unwrap();
  drop(bytes);
  assert_eq!(header["amount"], 50);
  assert_eq!(header["profile"], "Adobe Standard");
  let n = |key: &str| header[key].as_u64().unwrap() as usize;
  assert_eq!((n("planes"), n("pixel_type"), n("pixel_size")), (3, 3, 2));
  assert_eq!(header["original_image"]["pixel_type"], 3);
  let data = fs::read(root.join(header["data_file"].as_str().unwrap())).unwrap();
  assert_eq!(data.len(), n("bytes"));
  assert_eq!(format!("{:x}", Sha256::digest(&data)), header["sha256"]);
  let canonical = header.get("canonical_bounds").unwrap_or(&header["bounds"]);
  let bound = |i: usize| canonical[i].as_u64().unwrap() as usize;
  assert_eq!((bound(0), bound(1)), (0, 0));
  let origin = header.get("canonical_origin").map_or([0, 0], |v| {
    [
      v[0].as_u64().unwrap() as usize,
      v[1].as_u64().unwrap() as usize,
    ]
  });
  let mut camera = RgbImage::new(bound(3), bound(2));
  let (width, height) = (n("width"), n("height"));
  let (row_step, col_step, plane_step) = (n("row_step"), n("col_step"), n("plane_step"));
  assert_eq!(origin[0] + height, camera.height);
  assert_eq!(origin[1] + width, camera.width);
  for y in 0..height {
    for x in 0..width {
      for c in 0..3 {
        let offset = (y * row_step + x * col_step + c * plane_step) * 2;
        let value = tables::normalized(u16::from_le_bytes(
          data[offset..offset + 2].try_into().unwrap(),
        ));
        camera.data[((y + origin[0]) * camera.width + x + origin[1]) * 3 + c] = value;
      }
    }
  }
  drop(data);
  let options = Options {
    engine: Engine::Adobe,
    quality: Quality::Full,
    adobe_profile_dir: Some(profiles.into()),
    ..Default::default()
  };
  let mut settings: DevelopSettings =
    serde_json::from_value(json(&root.join("output/settings.json"))).unwrap();
  // These controlled captures have the verified native post-AI defaults.
  // Keep this explicit in the Rust recipe, as required by the public bridge.
  settings.adobe_noise_reduction = Some(AdobeNoiseReduction {
    color: 0,
    luminance: 0,
    ..Default::default()
  });
  validate_policy(&settings, &options).unwrap();
  validate_storage(&camera, &options.cancel).unwrap();
  let mosaic = DecodedMosaic::new_with_cancel(&negative, &options.cancel).unwrap();
  let (variant, bounds, crop) = (mosaic.variant(), mosaic.bounds(), mosaic.active_crop());
  drop(mosaic);
  assert_eq!(
    *canonical,
    serde_json::json!([bounds.top(), bounds.left(), bounds.bottom(), bounds.right()])
  );
  if origin != [0, 0] {
    // Fuji's write-only destination wrapper discards these leading strips.
    // Only its complete backing crop is captured. The zero prefix must be
    // discarded by the bridge before CA/statistics, never used as an oracle.
    assert_eq!(variant, Variant::Xtrans);
    assert_eq!(origin, [crop.top() as usize, crop.left() as usize]);
    assert_eq!([n("height"), n("width")], crop.size());
  }
  validate_shape(&camera, bounds).unwrap();
  let dcp = load_profile(&negative, &options).unwrap();
  let (mut image, render) =
    prepare_camera_stages(&negative, camera, variant, crop, &dcp, &settings, &options).unwrap();

  let stats = root.join("stats");
  let scene = render.scene.as_ref().unwrap();
  // Use the binary native double: serde_json's default decimal parser can
  // round a captured 17-digit JSON value one ULP differently.
  let native_negative = fs::read(stats.join("stats-image/gray-00_negative.bin")).unwrap();
  let flare = f64::from_le_bytes(native_negative[0x1768..0x1770].try_into().unwrap());
  assert_eq!(scene.flare.to_bits(), flare.to_bits(), "scene flare");
  let gray = stats_image::GrayLogImage::new(
    dcp.statistics(),
    &negative.meta,
    render.neutral,
    render.black,
  );
  assert_population(gray.render(&scene.camera, scene.flare), &stats, 0);
  let colors = stats_image::channel_logs(&scene.camera, render.black, scene.flare);
  let mut seen = [false; 3];
  for index in 1..=3 {
    let c = json(&stats.join(format!("stats-{index:02}.json")))["plane"]
      .as_u64()
      .unwrap() as usize;
    assert!(
      c < 3 && !seen[c],
      "each camera channel must be captured once"
    );
    seen[c] = true;
    assert_population(colors[c].clone(), &stats, index);
  }
  assert_population(
    scene.post_image.render(&scene.camera, scene.flare),
    &stats,
    4,
  );

  let output = root.join("output");
  let stem = fs::read_dir(&output)
    .unwrap()
    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
    .filter_map(|name| {
      name
        .strip_suffix("_cr_stage_1d_table_dst.json")
        .map(str::to_owned)
    })
    .max()
    .map(|stem| format!("{stem}_cr_stage_1d_table_dst"))
    .expect("final output transfer capture");
  let h = json(&output.join(format!("{stem}.json")));
  let n = |key: &str| h[key].as_u64().unwrap() as usize;
  let (width, height) = (n("r") - n("l"), n("b") - n("t"));
  let spatial = settings.lens.distortion
    || settings.lens.vignetting
    || settings
      .adobe_tone
      .as_ref()
      .is_some_and(|t| t.highlights != 0 || t.shadows != 0);
  let origin = if spatial {
    [n("l"), n("t")]
  } else {
    image = image.into_cropped(n("l"), n("t"), width, height);
    [0, 0]
  };
  render
    .render_to_space(
      &mut image,
      &settings,
      false,
      &options.cancel,
      OutputSpace::Srgb,
    )
    .unwrap();
  assert_eq!(n("psize"), 2);
  assert!(matches!(n("ptype"), 3 | 8));
  let data = fs::read(output.join(format!("{stem}.bin"))).unwrap();
  let mut mismatches = 0;
  let mut maximum = 0.0f32;
  for y in 0..height {
    for x in 0..width {
      for c in 0..3 {
        let offset = (y * n("row_step") + x * n("col_step") + c * n("plane_step")) * 2;
        let code = u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
          ^ if n("ptype") == 8 { 32768 } else { 0 };
        let expected = tables::normalized(code);
        let actual = image.px(x + origin[0], y + origin[1])[c];
        mismatches += usize::from(actual.to_bits() != expected.to_bits());
        maximum = maximum.max((actual - expected).abs());
      }
    }
  }
  eprintln!(
    "native camera → scene → sRGB: {} channels, {mismatches} differences, maximum {maximum}",
    width * height * 3
  );
  assert_eq!(mismatches, 0);
}
