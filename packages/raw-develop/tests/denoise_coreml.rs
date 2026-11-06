//! Opt-in learned-model and retained native-Adobe comparisons on macOS.
#![cfg(all(feature = "adobe-denoise-coreml", target_os = "macos"))]
use raw_develop::{
  Cancel, Error,
  adobe::denoise::{Backend, Model, Tensor},
};
use std::{
  path::PathBuf,
  time::{Duration, Instant},
};

fn error(a: &Tensor, b: &Tensor) -> serde_json::Value {
  assert_eq!(a.shape(), b.shape());
  let mut maximum = 0.0f64;
  let mut sum = 0.0f64;
  let mut exact = true;
  for (&a, &b) in a.data().iter().zip(b.data()) {
    let delta = (a as f64 - b as f64).abs();
    maximum = maximum.max(delta);
    sum += delta * delta;
    exact &= a.to_bits() == b.to_bits();
  }
  serde_json::json!({"max_abs":maximum,"rms":(sum/a.data().len() as f64).sqrt(),"bit_exact":exact})
}

#[test]
fn details_real_input_matches_captured_adobe() {
  let Some(root) = std::env::var_os("RAW_DENOISE_COREML_FIXTURES").map(PathBuf::from) else {
    return;
  };
  let capture = root.parent().unwrap().join("baseline/xtrans-tile");
  let input = Tensor::read(capture.join("model-input.f32")).unwrap();
  let expected = Tensor::read(capture.join("model-output.f32")).unwrap();
  let model = Model::load_with_backend(root.join("xtrans_details.pbdn"), Backend::CoreMl).unwrap();
  let actual = model.predict(&input, &Cancel::never()).unwrap();
  assert_eq!(error(&actual, &expected)["bit_exact"], true);
}

#[test]
fn learned_models_and_captured_adobe_tensors() {
  let Some(root) = std::env::var_os("RAW_DENOISE_COREML_FIXTURES").map(PathBuf::from) else {
    eprintln!(
      "set RAW_DENOISE_COREML_FIXTURES to prepared external rust model/reference directory"
    );
    return;
  };
  let destination = std::env::var_os("RAW_DENOISE_COREML_REPORT").map(PathBuf::from);
  if let Some(path) = &destination {
    std::fs::create_dir_all(path).unwrap();
  }
  let mut records = Vec::new();
  for backend in [Backend::CoreMl, Backend::CoreMlGpu] {
    let mode = if backend == Backend::CoreMl {
      "all"
    } else {
      "gpu"
    };
    for (name, file) in [
      ("bayer", "dn_bayer"),
      ("xtrans", "dn_xtrans"),
      ("linear_raw", "dn_s3_raw"),
      ("panorama_raw", "dn_pano_raw"),
      ("xtrans_details", "xtrans_details"),
    ] {
      let model = Model::load_with_backend(root.join(format!("{file}.pbdn")), backend).unwrap();
      for case in ["zero", "structured", "noisy", "real"] {
        if case == "real" && name != "xtrans_details" {
          continue;
        }
        let (input, reference) = if name == "xtrans_details" {
          (
            root.join(format!("details-references/{case}-input.f32")),
            root.join(format!("details-references/{case}-rust.f32")),
          )
        } else {
          (
            root.join(format!("references/{name}-{case}.input.f32")),
            root.join(format!("{name}-{case}.rust.f32")),
          )
        };
        let input = Tensor::read(input).unwrap();
        let expected = Tensor::read(reference).unwrap();
        let start = Instant::now();
        let actual = model.predict(&input, &Cancel::never()).unwrap();
        let cold_seconds = start.elapsed().as_secs_f64();
        let mut samples = Vec::new();
        for _ in 0..5 {
          let start = Instant::now();
          let repeated = model.predict(&input, &Cancel::never()).unwrap();
          samples.push(start.elapsed().as_secs_f64());
          assert_eq!(
            error(&actual, &repeated)["bit_exact"],
            true,
            "{mode}/{name}/{case}"
          );
        }
        let mut sorted = samples.clone();
        sorted.sort_by(f64::total_cmp);
        if let Some(path) = &destination {
          actual
            .write(path.join(format!("{mode}-{name}-{case}.f32")))
            .unwrap();
        }
        let record = serde_json::json!({"mode":mode,"model":name,"case":case,"backend":model.backend_identity(),
          "first_prediction_seconds":cold_seconds,"warm_seconds":samples,"median_seconds":sorted[2],
          "vs_cpu":error(&actual,&expected),"repeat_bit_exact":true});
        eprintln!("{record}");
        records.push(record);
      }
      if matches!(name, "bayer" | "xtrans") {
        for capture in [format!("{name}-output"), format!("{name}-corner")] {
          let folder = root.parent().unwrap().join("wrapper").join(&capture);
          let input = Tensor::read(folder.join("model-input.f32")).unwrap();
          let expected = Tensor::read(folder.join("model-output.f32")).unwrap();
          let actual = model.predict(&input, &Cancel::never()).unwrap();
          let difference = error(&actual, &expected);
          // These captures were taken with Core ML All on the documented Mac.
          if backend == Backend::CoreMl {
            assert_eq!(difference["bit_exact"], true, "Adobe capture {capture}");
          }
          let record = serde_json::json!({"mode":mode,"model":name,"adobe_capture":capture,"vs_adobe":difference});
          eprintln!("{record}");
          records.push(record);
        }
      }
      if name == "bayer" {
        let input = Tensor::read(root.join("references/bayer-structured.input.f32")).unwrap();
        let before = model.predict(&input, &Cancel::never()).unwrap();
        let cancel = Cancel::new();
        let signal = cancel.clone();
        let thread = std::thread::spawn(move || {
          std::thread::sleep(Duration::from_millis(10));
          signal.cancel();
        });
        let start = Instant::now();
        let result = model.predict(&input, &cancel);
        let seconds = start.elapsed().as_secs_f64();
        thread.join().unwrap();
        assert!(matches!(result, Err(Error::Cancelled)));
        let after = model.predict(&input, &Cancel::never()).unwrap();
        assert_eq!(error(&before, &after)["bit_exact"], true);
        records.push(serde_json::json!({"mode":mode,"cancelled":true,"seconds":seconds,"request_delay_seconds":0.01,"reuse_bit_exact":true}));
      }
      if let Some(path) = &destination {
        std::fs::write(
          path.join("validation.json"),
          serde_json::to_vec_pretty(&records).unwrap(),
        )
        .unwrap();
      }
    }
  }
}

#[test]
fn coreml_partial_strength_crops_preserve_global_grids() {
  use raw_develop::{
    Negative,
    adobe::denoise::{partial::predict_partial_raw_tiles, tiles::Rect},
  };
  let (Some(root), Some(raw)) = (
    std::env::var_os("RAW_DENOISE_COREML_RAW_ROOT"),
    std::env::var_os("RAW_DENOISE_RAW_FIXTURES"),
  ) else {
    eprintln!(
      "skipped partial RAW inference: set RAW_DENOISE_COREML_RAW_ROOT and RAW_DENOISE_RAW_FIXTURES"
    );
    return;
  };
  let root = PathBuf::from(root);
  let raw = PathBuf::from(raw);
  for (name, path, seam) in [
    ("bayer", "a1m2/12766.ARW", 799),
    ("xtrans", "x100vi/DSCF0008.RAF", 465),
    ("xtrans", "x100vi/DSCF0008.RAF", 859),
  ] {
    let negative = Negative::open(raw.join(path)).unwrap();
    let model =
      Model::load_with_backend(root.join(format!("rust/dn_{name}.pbdn")), Backend::CoreMl).unwrap();
    let details = if name == "xtrans" {
      Some(
        Model::load_with_backend(root.join("rust/xtrans_details.pbdn"), Backend::CoreMl).unwrap(),
      )
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
