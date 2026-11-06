//! Opt-in hardware validation; unlike auto mode, these checks require a GPU.
#![cfg(feature = "adobe-denoise-gpu")]
use raw_develop::{
  Cancel,
  adobe::denoise::{Backend, Model, Tensor},
};
use std::{path::PathBuf, time::Instant};

#[test]
fn learned_models_match_cpu_and_reuse_device_arena() {
  let Some(root) = std::env::var_os("RAW_DENOISE_GPU_FIXTURES").map(PathBuf::from) else {
    eprintln!("set RAW_DENOISE_GPU_FIXTURES to the external rust model/reference directory");
    return;
  };
  for (name, file, references) in [
    ("bayer", "dn_bayer.pbdn", "references"),
    ("xtrans", "dn_xtrans.pbdn", "references"),
    ("linear_raw", "dn_s3_raw.pbdn", "references"),
    ("panorama_raw", "dn_pano_raw.pbdn", "references"),
    (
      "xtrans_details",
      "xtrans_details.pbdn",
      "details-references",
    ),
  ] {
    let start = Instant::now();
    let model = Model::load_with_backend(root.join(file), Backend::Gpu).unwrap();
    eprintln!(
      "{name}: load {:.3}s, {}",
      start.elapsed().as_secs_f64(),
      model.backend_identity()
    );
    for case in ["zero", "structured", "noisy", "real"] {
      if case == "real" && name != "xtrans_details" {
        continue;
      }
      let input_path = if name == "xtrans_details" {
        root.join(references).join(format!("{case}-input.f32"))
      } else {
        root
          .join(references)
          .join(format!("{name}-{case}.input.f32"))
      };
      let input = Tensor::read(input_path).unwrap();
      let cpu_path = if name == "xtrans_details" {
        root.join(references).join(format!("{case}-rust.f32"))
      } else {
        root.join(format!("{name}-{case}.rust.f32"))
      };
      let (expected, cpu_seconds) = if cpu_path.exists() {
        (Tensor::read(cpu_path).unwrap(), None)
      } else {
        let cpu = Model::load(root.join(file)).unwrap();
        let start = Instant::now();
        let result = cpu.predict(&input, &Cancel::never()).unwrap();
        (result, Some(start.elapsed().as_secs_f64()))
      };
      let start = Instant::now();
      let actual = model.predict(&input, &Cancel::never()).unwrap();
      let seconds = start.elapsed().as_secs_f64();
      assert_eq!(actual.shape(), expected.shape());
      // Explicitly supplied snapshots must come from the same device/driver.
      // This is stronger than CPU tolerance checks when tuning GPU arithmetic.
      if let Some(previous) = std::env::var_os("RAW_DENOISE_GPU_BASELINE_DIR") {
        let previous =
          Tensor::read(PathBuf::from(previous).join(format!("baseline-{name}-{case}.f32")))
            .unwrap();
        assert_eq!(actual.shape(), previous.shape());
        assert!(
          actual
            .data()
            .iter()
            .zip(previous.data())
            .all(|(a, b)| a.to_bits() == b.to_bits()),
          "{name}/{case}: optimization changed previous GPU output bits"
        );
      }
      let mut max = 0.0f64;
      let mut sum = 0.0f64;
      for (&a, &b) in actual.data().iter().zip(expected.data()) {
        let difference = (a as f64 - b as f64).abs();
        max = max.max(difference);
        sum += difference * difference;
      }
      let rms = (sum / actual.data().len() as f64).sqrt();
      eprintln!(
        "{}",
        serde_json::json!({"model":name,"case":case,"gpu_seconds":seconds,"cpu_seconds":cpu_seconds,"max_abs":max,"rms":rms})
      );
      assert!(
        max < 0.0002 && rms < 0.00001,
        "{name}/{case}: max {max}, rms {rms}"
      );
      let repeated = model.predict(&input, &Cancel::never()).unwrap();
      assert!(
        actual
          .data()
          .iter()
          .zip(repeated.data())
          .all(|(a, b)| a.to_bits() == b.to_bits()),
        "{name} GPU run changed"
      );
      if case == "structured" && name == "bayer" {
        let cancel = Cancel::new();
        let signal = cancel.clone();
        let start = Instant::now();
        let thread = std::thread::spawn(move || {
          std::thread::sleep(std::time::Duration::from_secs_f64(
            (seconds * 0.05).clamp(0.001, 0.1),
          ));
          signal.cancel();
        });
        assert!(matches!(
          model.predict(&input, &cancel),
          Err(raw_develop::Error::Cancelled)
        ));
        thread.join().unwrap();
        eprintln!(
          "GPU cancellation/drain {:.3}s",
          start.elapsed().as_secs_f64()
        );
        let after = model.predict(&input, &Cancel::never()).unwrap();
        assert!(
          actual
            .data()
            .iter()
            .zip(after.data())
            .all(|(a, b)| a.to_bits() == b.to_bits()),
          "cancelled work corrupted arena"
        );
      }
    }
  }
}
