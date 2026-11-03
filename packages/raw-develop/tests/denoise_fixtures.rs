//! External learned parameters and Core ML references are never committed.
//! RAW_DENOISE_FIXTURES=/external/rust cargo test --release --features adobe-denoise \
//!   --test denoise_fixtures -- --nocapture
//! RAW_DENOISE_CAPTURE_FIXTURES=/external/wrapper enables real captured packing/crop checks.
#![cfg(feature = "adobe-denoise")]
use raw_develop::{
  Cancel,
  adobe::denoise::{
    Model, Tensor, Variant, pack_mosaic_tile,
    tiles::{Rect, TileGeometry},
  },
};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[test]
fn partial_raw_crops_preserve_global_model_and_baseline_grids() {
  use raw_develop::{Negative, adobe::denoise::partial::predict_partial_raw_tiles};
  let (Some(root), Some(raw)) = (
    std::env::var_os("RAW_DENOISE_PARTIAL_FIXTURES"),
    std::env::var_os("RAW_DENOISE_RAW_FIXTURES"),
  ) else {
    eprintln!(
      "skipped partial RAW inference: set RAW_DENOISE_PARTIAL_FIXTURES and RAW_DENOISE_RAW_FIXTURES"
    );
    return;
  };
  let root = PathBuf::from(root);
  let raw = PathBuf::from(raw);
  for (name, path, seam) in [
    ("bayer", "a1m2/12766.ARW", 799),
    ("xtrans", "x100vi/DSCF0008.RAF", 465),
  ] {
    let negative = Negative::open(raw.join(path)).unwrap();
    let model = Model::load(root.join(format!("rust/dn_{name}.pbdn"))).unwrap();
    let details = if name == "xtrans" {
      Some(Model::load(root.join("rust/xtrans_details.pbdn")).unwrap())
    } else {
      None
    };
    let render = |area: Rect| {
      let [h, w] = area.size();
      let mut data = vec![f32::NAN; 3 * h * w];
      let mut coverage = vec![0u8; h * w];
      predict_partial_raw_tiles(
        &negative,
        &model,
        details.as_ref(),
        50,
        Some(area),
        &Cancel::never(),
        |rect, tensor| {
          let [th, tw] = rect.size();
          for y in 0..th {
            for x in 0..tw {
              let dst = (rect.top() - area.top()) as usize * w
                + y * w
                + (rect.left() - area.left()) as usize
                + x;
              coverage[dst] += 1;
              for c in 0..3 {
                data[c * h * w + dst] = tensor.data()[(c * th + y) * tw + x];
              }
            }
          }
          Ok(())
        },
      )
      .unwrap();
      assert!(coverage.iter().all(|&v| v == 1));
      Tensor::new([3, h, w], data).unwrap()
    };
    let wide = render(Rect::new(seam - 9, seam - 9, seam + 11, seam + 11).unwrap());
    let small = render(Rect::new(seam - 4, seam - 4, seam + 6, seam + 6).unwrap());
    for c in 0..3 {
      for y in 0..10 {
        for x in 0..10 {
          assert_eq!(
            small.data()[(c * 10 + y) * 10 + x].to_bits(),
            wide.data()[(c * 20 + y + 5) * 20 + x + 5].to_bits(),
            "{name} grid shifted with crop"
          );
        }
      }
    }
    let cancelled = Cancel::new();
    cancelled.cancel();
    assert!(matches!(
      predict_partial_raw_tiles(
        &negative,
        &model,
        details.as_ref(),
        50,
        None,
        &cancelled,
        |_, _| panic!("cancelled export delivered pixels")
      ),
      Err(raw_develop::Error::Cancelled)
    ));
    eprintln!("{name}: 300 overlapping partial-strength samples bit-exact across seam {seam}");
  }
}

#[test]
fn partial_strength_blend_matches_real_native_corners() {
  use raw_develop::adobe::denoise::strength::{BlendWeights, blend_tile};
  let Some(root) = std::env::var_os("RAW_DENOISE_BASELINE_FIXTURES").map(PathBuf::from) else {
    eprintln!("skipped real blend captures: set RAW_DENOISE_BASELINE_FIXTURES");
    return;
  };
  let root = root.join("bayer-blend-edges");
  for corner in ["tl", "tr", "bl", "br"] {
    let read = |name| Tensor::read(root.join(format!("{corner}-{name}.f32"))).unwrap();
    let actual = blend_tile(
      &read("original"),
      &read("denoised"),
      BlendWeights::from_amount(50),
      &Cancel::never(),
    )
    .unwrap();
    let expected = read("output");
    assert_eq!(actual.shape(), expected.shape());
    let different = actual
      .data()
      .iter()
      .zip(expected.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(different, 0, "native {corner} strength blend differs");
    eprintln!("{corner}: {} blend values bit-exact", actual.data().len());
  }
}

#[test]
fn bayer_baseline_matches_all_four_native_blend_inputs() {
  use raw_develop::{Negative, adobe::denoise::baseline_bayer::BayerBaseline};
  let (Some(root), Some(raw)) = (
    std::env::var_os("RAW_DENOISE_BASELINE_FIXTURES"),
    std::env::var_os("RAW_DENOISE_RAW_FIXTURES"),
  ) else {
    return;
  };
  let root = PathBuf::from(root).join("bayer-blend-edges");
  let report: serde_json::Value =
    serde_json::from_slice(&std::fs::read(root.join("validation.json")).unwrap()).unwrap();
  let negative = Negative::open(PathBuf::from(raw).join("a1m2/12766.ARW")).unwrap();
  let baseline = BayerBaseline::new(&negative, &Cancel::never()).unwrap();
  let bounds = baseline.mosaic().bounds();
  for case in report["cases"].as_array().unwrap() {
    let name = case["name"].as_str().unwrap();
    let r: Vec<i32> = case["input_rect"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| v.as_i64().unwrap() as i32)
      .collect();
    let area = Rect::new(
      r[0].max(bounds.top()),
      r[1].max(bounds.left()),
      r[2].min(bounds.bottom()),
      r[3].min(bounds.right()),
    )
    .unwrap();
    let actual = baseline.render_area(area, &Cancel::never()).unwrap();
    let expected = Tensor::read(root.join(format!("{name}-original.f32"))).unwrap();
    let [_, h, w] = expected.shape();
    let [ah, aw] = area.size();
    for c in 0..3 {
      for y in 0..h {
        for x in 0..w {
          let sy = (r[0] + y as i32).clamp(bounds.top(), bounds.bottom() - 1) - area.top();
          let sx = (r[1] + x as i32).clamp(bounds.left(), bounds.right() - 1) - area.left();
          assert_eq!(
            actual.data()[(c * ah + sy as usize) * aw + sx as usize].to_bits(),
            expected.data()[(c * h + y) * w + x].to_bits(),
            "{name}/{c}/{y}/{x}"
          );
        }
      }
    }
  }
}

#[test]
fn enhance_details_network_agrees_with_coreml_cpu() {
  let Some(root) = std::env::var_os("RAW_DENOISE_DETAILS_FIXTURES").map(PathBuf::from) else {
    eprintln!("skipped Enhance Details model: set RAW_DENOISE_DETAILS_FIXTURES");
    return;
  };
  let refs = root.join("details-references");
  let manifest: serde_json::Value =
    serde_json::from_slice(&std::fs::read(refs.join("manifest.json")).unwrap()).unwrap();
  let model = Model::load(root.join("xtrans_details.pbdn")).unwrap();
  let validation: serde_json::Value =
    serde_json::from_str(include_str!("../docs/adobe-denoise-validation.json")).unwrap();
  let recorded = &validation["partial_strength_baselines"]["xtrans"]["network_references"];
  assert_eq!(
    manifest, *recorded,
    "reference manifest changed from the validated baseline"
  );
  assert_eq!(model.info().variant, Variant::XtransDetails);
  assert_eq!(model.info().weight_dtype, "float32");
  assert_eq!(model.info().parameters, 186819);
  assert_eq!(manifest["compute_units"], "CPU_ONLY");
  assert_eq!(manifest["source_sha256"], model.info().source_sha256);
  assert_eq!(manifest["weights_sha256"], model.info().weights_sha256);
  let cases = manifest["cases"].as_array().unwrap();
  assert_eq!(cases.len(), 4);
  for name in ["zero", "noisy", "structured", "real"] {
    let case = cases.iter().find(|c| c["name"] == name).unwrap();
    let read = |key: &str| {
      let path = refs.join(case[key]["file"].as_str().unwrap());
      assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap())),
        case[key]["sha256"].as_str().unwrap()
      );
      Tensor::read(path).unwrap()
    };
    let expected = read("output");
    let actual = model.predict(&read("input"), &Cancel::never()).unwrap();
    assert_eq!(actual.shape(), expected.shape());
    let (mut max, mut sum) = (0.0f64, 0.0f64);
    for (&a, &b) in actual.data().iter().zip(expected.data()) {
      let delta = a as f64 - b as f64;
      max = max.max(delta.abs());
      sum += delta * delta;
    }
    let rmse = (sum / actual.data().len() as f64).sqrt();
    eprintln!("xtrans_details/{name}: max_abs={max:.9e} rmse={rmse:.9e}");
    assert!(
      max <= 1e-5 && rmse <= 5e-7,
      "Enhance Details CPU agreement regressed"
    );
  }
}

#[test]
fn captured_mosaic_tile_wrapper_is_bit_exact() {
  use raw_develop::adobe::denoise::{MosaicTilePlan, Variant, tiles::Rect};
  let Some(root) = std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES").map(PathBuf::from) else {
    eprintln!("skipped inverse tile captures: set RAW_DENOISE_CAPTURE_FIXTURES");
    return;
  };
  for (name, variant, gain_offset) in [
    ("bayer-full-tile", Variant::Bayer, 0x288),
    ("xtrans-full-tile", Variant::Xtrans, 0x280),
    ("bayer-corner", Variant::Bayer, 0x288),
    ("xtrans-corner", Variant::Xtrans, 0x280),
  ] {
    let directory = root.join(name);
    let capture: serde_json::Value =
      serde_json::from_slice(&std::fs::read(directory.join("capture.json")).unwrap()).unwrap();
    assert_eq!(capture["done"], true);
    let context = std::fs::read(directory.join("context.bin")).unwrap();
    assert_eq!(
      context[gain_offset], 0,
      "capture requires optional channel gains"
    );
    let black = f64::from_le_bytes(context[0x248..0x250].try_into().unwrap());
    let coordinates: Vec<i32> = capture["post_rect"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| i32::try_from(v.as_i64().unwrap()).unwrap())
      .collect();
    let requested = Rect::new(
      coordinates[0],
      coordinates[1],
      coordinates[2],
      coordinates[3],
    )
    .unwrap();
    let plan = MosaicTilePlan::new(variant, requested, black).unwrap();
    let source = Tensor::read(directory.join("source-preserved.f32")).unwrap();
    let input_rect: Vec<i32> = capture["input_rect"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| i32::try_from(v.as_i64().unwrap()).unwrap())
      .collect();
    let source_rect =
      Rect::new(input_rect[0], input_rect[1], input_rect[2], input_rect[3]).unwrap();
    // Reconstruct the observed interior region used by this captured footprint
    // and its mirrored halo. Unknown pixels outside the footprint are not tested.
    let bounds = if let Some(values) = capture["image_bounds"].as_array() {
      let v: Vec<i32> = values.iter().map(|v| v.as_i64().unwrap() as i32).collect();
      Rect::new(v[0], v[1], v[2], v[3]).unwrap()
    } else {
      Rect::new(0, 0, source_rect.bottom(), source_rect.right()).unwrap()
    };
    let [height, width] = bounds.size();
    let mut observed_image = vec![0.0; height * width];
    for row in source_rect.top().max(0)..source_rect.bottom().min(bounds.bottom()) {
      for column in source_rect.left().max(0)..source_rect.right().min(bounds.right()) {
        observed_image[row as usize * width + column as usize] = source.data()
          [(row - source_rect.top()) as usize * 1024 + (column - source_rect.left()) as usize];
      }
    }
    let extracted = plan
      .extract_source(bounds, &observed_image, &Cancel::never())
      .unwrap();
    let (padding, period) = if variant == Variant::Bayer {
      (112, 2)
    } else {
      (80, 6)
    };
    let mirror =
      raw_develop::adobe::denoise::border::PhaseMirror::new(bounds, padding, period).unwrap();
    let mut checked = 0;
    let mut differences = 0;
    for (i, (actual, expected)) in extracted.data().iter().zip(source.data()).enumerate() {
      let [y, x] = mirror.source_coordinate_with_edge_repeat(
        source_rect.top() + (i / 1024) as i32,
        source_rect.left() + (i % 1024) as i32,
      );
      // Fuji's narrow final tile reflects one column just outside this capture's
      // visible interior. The independent decoded-RAW test covers that column.
      if y >= source_rect.top()
        && y < source_rect.bottom()
        && x >= source_rect.left()
        && x < source_rect.right()
      {
        checked += 1;
        differences += usize::from(actual.to_bits() != expected.to_bits());
      }
    }
    assert_eq!(
      checked,
      if name == "xtrans-corner" {
        1047552
      } else {
        1048576
      }
    );
    assert_eq!(differences, 0, "{name}: composed border extraction differs");
    let packed = plan
      .prepare_input(source_rect, &source, &Cancel::never())
      .unwrap();
    let expected_input = Tensor::read(directory.join("model-input.f32")).unwrap();
    assert_eq!(packed.shape(), expected_input.shape());
    let mismatches = packed
      .data()
      .iter()
      .zip(expected_input.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(mismatches, 0, "{name}: composed input wrapper differs");
    let model_output = Tensor::read(directory.join("model-output.f32")).unwrap();
    let actual = plan.finish_output(&model_output, &Cancel::never()).unwrap();
    let expected = Tensor::read(directory.join("restore-output.f32")).unwrap();
    assert_eq!(actual.shape(), expected.shape());
    let mismatches = actual
      .data()
      .iter()
      .zip(expected.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(mismatches, 0, "{name}: composed inverse wrapper differs");
    eprintln!(
      "{name}: {} composed crop/gamma/black values bit-exact",
      actual.data().len()
    );
  }
}

#[test]
fn captured_real_raw_network_inputs_agree_with_coreml_cpu() {
  let (Some(models), Some(captures)) = (
    std::env::var_os("RAW_DENOISE_FIXTURES").map(PathBuf::from),
    std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES").map(PathBuf::from),
  ) else {
    eprintln!(
      "skipped captured inference: set RAW_DENOISE_FIXTURES and RAW_DENOISE_CAPTURE_FIXTURES"
    );
    return;
  };
  let report: serde_json::Value =
    serde_json::from_str(include_str!("../docs/adobe-denoise-validation.json")).unwrap();
  for case in report["real_raw_captures"]["cases"].as_array().unwrap() {
    let variant = case["variant"].as_str().unwrap();
    let directory = captures.join(format!("{variant}-output"));
    let input = directory.join("model-input.f32");
    let reference = directory.join("coreml-cpu.f32");
    for (path, digest) in [
      (&input, &case["input_sha256"]),
      (&reference, &case["rust_vs_cpu"]["reference_sha256"]),
    ] {
      assert_eq!(
        format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
        digest.as_str().unwrap()
      );
    }
    let model = Model::load(models.join(format!("dn_{variant}.pbdn"))).unwrap();
    assert_eq!(
      model.info().source_sha256,
      case["source_sha256"].as_str().unwrap()
    );
    let actual = model
      .predict(&Tensor::read(input).unwrap(), &Cancel::never())
      .unwrap();
    let expected = Tensor::read(reference).unwrap();
    assert_eq!(actual.shape(), expected.shape());
    let mut max = 0.0f64;
    let mut squares = 0.0f64;
    for (&a, &b) in actual.data().iter().zip(expected.data()) {
      let delta = a as f64 - b as f64;
      max = max.max(delta.abs());
      squares += delta * delta;
    }
    let rmse = (squares / actual.data().len() as f64).sqrt();
    eprintln!("{variant}/captured: max_abs={max:.9e} rmse={rmse:.9e}");
    assert!(
      max <= 1e-5 && rmse <= 5e-7,
      "captured CPU reference agreement regressed"
    );
  }
}

#[test]
fn all_four_networks_agree_with_coreml_cpu() {
  let Some(root) = std::env::var_os("RAW_DENOISE_FIXTURES").map(PathBuf::from) else {
    eprintln!("skipped external models: set RAW_DENOISE_FIXTURES");
    return;
  };
  for (variant, model) in [
    ("bayer", "dn_bayer"),
    ("xtrans", "dn_xtrans"),
    ("linear_raw", "dn_s3_raw"),
    ("panorama_raw", "dn_pano_raw"),
  ] {
    let model = Model::load(root.join(format!("{model}.pbdn"))).unwrap();
    let refs = root.join("references");
    let manifest: serde_json::Value = serde_json::from_slice(
      &std::fs::read(refs.join(format!("{variant}-references.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["source_sha256"], model.info().source_sha256);
    assert_eq!(manifest["weights_sha256"], model.info().weights_sha256);
    assert_eq!(manifest["compute_units"], "CPU_ONLY");
    assert_eq!(manifest["cases"].as_array().unwrap().len(), 3);
    for case in ["zero", "noisy", "structured"] {
      let record = manifest["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["case"] == case)
        .expect("missing reference case");
      let input_path = refs.join(format!("{variant}-{case}.input.f32"));
      let expected_path = refs.join(format!("{variant}-{case}.coreml.f32"));
      for (path, key) in [(&input_path, "input"), (&expected_path, "output")] {
        assert_eq!(
          format!("{:x}", Sha256::digest(std::fs::read(path).unwrap())),
          record[key]["sha256"].as_str().unwrap()
        );
      }
      let input = Tensor::read(input_path).unwrap();
      let expected = Tensor::read(expected_path).unwrap();
      let actual = model.predict(&input, &Cancel::never()).unwrap();
      assert_eq!(actual.shape(), expected.shape());
      let (mut max, mut squares, mut exact) = (0f64, 0f64, 0usize);
      for (&a, &b) in actual.data().iter().zip(expected.data()) {
        let d = a as f64 - b as f64;
        max = max.max(d.abs());
        squares += d * d;
        exact += usize::from(a.to_bits() == b.to_bits());
      }
      let rmse = (squares / actual.data().len() as f64).sqrt();
      eprintln!(
        "{variant}/{case}: max_abs={max:.9e} rmse={rmse:.9e} exact={exact}/{}",
        actual.data().len()
      );
      // Explicit numerical, NOT bit-exact, regression gates. First measured
      // worst cases on M4 Pro: max7.30e-6, RMSE2.41e-7. Different arithmetic
      // backends must report their own measurements, not weaken these silently.
      assert!(
        max <= 1e-5 && rmse <= 5e-7,
        "{variant}/{case}: Core ML agreement regressed"
      );
    }
  }
}

/// Replay the non-neural stages around actual Adobe inference without requiring
/// external model weights or accepting backend-dependent network tolerances.
#[test]
fn captured_real_raw_packing_and_output_crop_are_bit_exact() {
  let Some(root) = std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES").map(PathBuf::from) else {
    eprintln!("skipped real RAW captures: set RAW_DENOISE_CAPTURE_FIXTURES");
    return;
  };
  for (name, variant) in [("bayer", Variant::Bayer), ("xtrans", Variant::Xtrans)] {
    let dir = root.join(format!("{name}-output"));
    let capture: serde_json::Value =
      serde_json::from_slice(&std::fs::read(dir.join("capture.json")).unwrap()).unwrap();
    assert_eq!(capture["done"], true, "{name}: incomplete capture");
    let buffer_rect = |value: &serde_json::Value| -> Rect {
      let coordinates: [i32; 4] = ["t", "l", "b", "r"]
        .map(|key| i32::try_from(value[key].as_i64().expect("missing buffer rectangle")).unwrap());
      Rect::new(
        coordinates[0],
        coordinates[1],
        coordinates[2],
        coordinates[3],
      )
      .unwrap()
    };
    let requested = buffer_rect(&capture["dst"]);
    let geometry = TileGeometry::calculate(variant, requested).unwrap();
    assert_eq!(
      geometry.source,
      buffer_rect(&capture["src"]),
      "{name}: source placement"
    );
    assert_eq!(
      geometry.output,
      buffer_rect(&capture["tensor"]),
      "{name}: output placement"
    );
    let post_rect: Vec<i32> = capture["post_rect"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| i32::try_from(v.as_i64().unwrap()).unwrap())
      .collect();
    assert_eq!(
      post_rect,
      requested.as_array(),
      "{name}: postprocess rectangle"
    );

    let source = Tensor::read(dir.join("preprocess-source.f32")).unwrap();
    let expected_input = Tensor::read(dir.join("model-input.f32")).unwrap();
    assert_eq!(source.shape(), [1, 1024, 1024]);
    let packed = pack_mosaic_tile(variant, source.data(), [0.0; 3]).unwrap();
    assert_eq!(packed.shape(), expected_input.shape());
    let packing_mismatches = packed
      .data()
      .iter()
      .zip(expected_input.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(
      packing_mismatches, 0,
      "{name}: sparse packing differs from Adobe"
    );

    let model_output = Tensor::read(dir.join("model-output.f32")).unwrap();
    let postprocess_output = Tensor::read(dir.join("postprocess-output.f32")).unwrap();
    let [height, width] = geometry.output.size();
    assert_eq!(model_output.shape(), [3, height, width]);
    let crop = geometry.output_crop().unwrap();
    let [crop_height, crop_width] = crop.size();
    assert_eq!(postprocess_output.shape(), [3, crop_height, crop_width]);
    let cropped = geometry.crop_model_output(&model_output).unwrap();
    let crop_mismatches = cropped
      .data()
      .iter()
      .zip(postprocess_output.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(
      crop_mismatches, 0,
      "{name}: zero-offset postprocess crop differs from Adobe"
    );
    eprintln!(
      "{name}: {} packed samples and {} cropped samples bit-exact with real RAW capture",
      packed.data().len(),
      postprocess_output.data().len()
    );
  }
}
