//! Real NVIDIA tests. Fixtures are external; explicit opt-in never falls back.
#![cfg(all(feature = "adobe-denoise-cuda", target_os = "linux"))]
use raw_develop::{
  Cancel, Error,
  adobe::denoise::{Backend, Model, Tensor},
};
use std::{
  path::PathBuf,
  time::{Duration, Instant},
};

fn difference(a: &Tensor, b: &Tensor) -> (f64, f64, bool) {
  assert_eq!(a.shape(), b.shape());
  let mut max = 0.0f64;
  let mut sum = 0.0;
  let mut exact = true;
  for (&a, &b) in a.data().iter().zip(b.data()) {
    let d = (a as f64 - b as f64).abs();
    max = max.max(d);
    sum += d * d;
    exact &= a.to_bits() == b.to_bits();
  }
  (max, (sum / a.data().len() as f64).sqrt(), exact)
}
#[test]
fn learned_models_repeats_and_cancellation() {
  let Some(root) = std::env::var_os("RAW_DENOISE_CUDA_FIXTURES").map(PathBuf::from) else {
    eprintln!("set RAW_DENOISE_CUDA_FIXTURES to models/ and fixtures/ validation root");
    return;
  };
  let report = std::env::var_os("RAW_DENOISE_CUDA_REPORT").map(PathBuf::from);
  if let Some(path) = &report {
    std::fs::create_dir_all(path).unwrap();
  }
  let mut records = Vec::new();
  let backend = match std::env::var("RAW_DENOISE_COMPARE_BACKEND").as_deref() {
    Ok("vulkan") => Backend::Vulkan,
    Err(std::env::VarError::NotPresent) | Ok("cuda") => Backend::Cuda,
    _ => panic!("comparison backend must be cuda or vulkan"),
  };
  for (name, file) in [
    ("bayer", "dn_bayer"),
    ("xtrans", "dn_xtrans"),
    ("linear_raw", "dn_s3_raw"),
    ("panorama_raw", "dn_pano_raw"),
    ("xtrans_details", "xtrans_details"),
  ] {
    let start = Instant::now();
    let model =
      Model::load_with_backend(root.join(format!("models/{file}.pbdn")), backend).unwrap();
    let load = start.elapsed().as_secs_f64();
    assert!(
      model
        .backend_identity()
        .starts_with(if backend == Backend::Cuda {
          "cuda-onnx-f32-v1:"
        } else {
          "wgpu24-f32-v3:"
        })
    );
    for case in ["zero", "structured", "noisy", "real"] {
      if case == "real" && name != "xtrans_details" {
        continue;
      }
      let stem = format!("{name}-{case}");
      let input = Tensor::read(root.join(format!("fixtures/{stem}.input.f32"))).unwrap();
      let expected = Tensor::read(root.join(format!("fixtures/{stem}.cpu.f32"))).unwrap();
      let start = Instant::now();
      let actual = model.predict(&input, &Cancel::never()).unwrap();
      let cold = start.elapsed().as_secs_f64();
      let (max, rms, _) = difference(&actual, &expected);
      assert!(max < 0.0002 && rms < 0.00001, "{stem}: max={max} rms={rms}");
      let mut seconds = Vec::new();
      for _ in 0..5 {
        let start = Instant::now();
        let repeat = model.predict(&input, &Cancel::never()).unwrap();
        seconds.push(start.elapsed().as_secs_f64());
        assert!(
          difference(&repeat, &actual).2,
          "{stem}: repeated bits differ"
        );
      }
      if case == "structured" {
        let cancel = Cancel::new();
        let signal = cancel.clone();
        let thread = std::thread::spawn(move || {
          std::thread::sleep(Duration::from_millis(2));
          signal.cancel();
        });
        let start = Instant::now();
        let result = model.predict(&input, &cancel);
        thread.join().unwrap();
        assert!(
          matches!(result, Err(Error::Cancelled)),
          "{stem}: did not cancel"
        );
        let elapsed = start.elapsed().as_secs_f64();
        let after = model.predict(&input, &Cancel::never()).unwrap();
        assert!(
          difference(&after, &actual).2,
          "{stem}: cancellation corrupted reuse"
        );
        records.push(serde_json::json!({"model":name,"cancel_seconds":elapsed,"request_delay_seconds":0.002,"reuse_exact":true}));
      }
      let mut sorted = seconds.clone();
      sorted.sort_by(f64::total_cmp);
      let record = serde_json::json!({"model":name,"case":case,"backend":model.backend_identity(),"load_seconds":load,"cold_seconds":cold,"warm_seconds":seconds,"median_seconds":sorted[2],"max_abs_vs_cpu":max,"rms_vs_cpu":rms,"five_repeats_exact":true});
      eprintln!("{record}");
      records.push(record);
      if let Some(path) = &report {
        actual.write(path.join(format!("{stem}.f32"))).unwrap();
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
fn cuda_partial_strength_crops_preserve_global_grids() {
  use raw_develop::{
    Negative,
    adobe::denoise::{partial::predict_partial_raw_tiles, tiles::Rect},
  };
  let (Some(root), Some(raw)) = (
    std::env::var_os("RAW_DENOISE_CUDA_FIXTURES"),
    std::env::var_os("RAW_DENOISE_CUDA_FIXTURES"),
  ) else {
    eprintln!(
      "skipped partial RAW inference: set RAW_DENOISE_CUDA_FIXTURES and RAW_DENOISE_CUDA_FIXTURES"
    );
    return;
  };
  let root = PathBuf::from(root);
  let raw = PathBuf::from(raw);
  for (name, path, seam) in [
    ("bayer", "12766.ARW", 799),
    ("xtrans", "DSCF0008.RAF", 465),
    ("xtrans", "DSCF0008.RAF", 859),
  ] {
    let negative = Negative::open(raw.join(path)).unwrap();
    let model =
      Model::load_with_backend(root.join(format!("models/dn_{name}.pbdn")), Backend::Cuda).unwrap();
    let details = if name == "xtrans" {
      Some(
        Model::load_with_backend(root.join("models/xtrans_details.pbdn"), Backend::Cuda).unwrap(),
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
