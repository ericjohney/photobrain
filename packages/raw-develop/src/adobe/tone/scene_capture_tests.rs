//! Optional native AI scene replay. Capture files remain outside the repository.
use super::*;
use crate::adobe::bayer::tables;
use std::path::Path;

fn json(path: impl AsRef<Path>) -> serde_json::Value {
  serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn captured_camera(root: &Path, meta: &RawMetadata) -> (SmallImage, f64) {
  let info = json(root.join("stats-image/gray-00.json"));
  let level = info["level"].as_u64().unwrap() as usize;
  let width = (meta.crop_width + (1 << level) / 2) >> level;
  let height = (meta.crop_height + (1 << level) / 2) >> level;
  let mut pixels = vec![[0u16; 3]; width * height];
  let mut seen = vec![[false; 3]; pixels.len()];
  let directory = root.join("stats-image/gray-00");
  for file in std::fs::read_dir(&directory).unwrap() {
    let path = file.unwrap().path();
    if !path
      .file_name()
      .unwrap()
      .to_string_lossy()
      .ends_with("_cr_stage_get_image_dst.json")
    {
      continue;
    }
    let h = json(&path);
    let get = |key: &str| h[key].as_i64().unwrap();
    let bytes = std::fs::read(path.with_extension("bin")).unwrap();
    assert_eq!(get("planes"), 3);
    assert_eq!(get("plane"), 0);
    assert_eq!(get("ptype"), 11);
    for y in get("t")..get("b") {
      for x in get("l")..get("r") {
        assert!(y >= 0 && y < height as i64 && x >= 0 && x < width as i64);
        let pixel = y as usize * width + x as usize;
        for c in 0..3 {
          let index = ((y - get("t")) * get("row_step")
            + (x - get("l")) * get("col_step")
            + c as i64 * get("plane_step")) as usize
            * 4;
          let value = f32::from_le_bytes(bytes[index..index + 4].try_into().unwrap());
          let code = tables::code(value);
          assert_eq!(
            tables::normalized(code).to_bits(),
            value.to_bits(),
            "native camera u16 boundary"
          );
          if seen[pixel][c] {
            assert_eq!(pixels[pixel][c], code, "overlapping native camera tiles");
          }
          seen[pixel][c] = true;
          pixels[pixel][c] = code;
        }
      }
    }
  }
  assert!(
    seen.iter().flatten().all(|&v| v),
    "complete native small camera image required"
  );
  (
    SmallImage {
      pixels,
      width,
      height,
      level,
      full_width: meta.crop_width,
      full_height: meta.crop_height,
    },
    info["black"].as_f64().unwrap() / 65535.0,
  )
}

fn fields(stats: &Statistics) -> Vec<f64> {
  let value = serde_json::to_value(stats).unwrap();
  let scalar = |name: &str| value[name].as_f64().unwrap_or(f64::NAN);
  let mut out = vec![scalar("mean"), scalar("negative_mean"), scalar("tone_mean")];
  for name in ["raw", "selected"] {
    out.extend(
      value[name]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap_or(f64::NAN)),
    );
  }
  out.extend([
    scalar("selected_mean"),
    scalar("selected_median"),
    scalar("variance").sqrt(),
    scalar("variance"),
    scalar("skewness"),
    scalar("kurtosis"),
  ]);
  out
}

#[test]
fn captured_ai_camera_image_to_scene_measurements() {
  let (Some(root), Some(raw), Some(profiles)) = (
    std::env::var_os("RAW_DENOISE_SCENE_CAPTURE"),
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("ADOBE_PROFILE_DIR"),
  ) else {
    return;
  };
  let root = Path::new(&root);
  let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
  let dcp =
    Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
      .unwrap();
  // The native default statistics profile differs from explicitly selected
  // Adobe Standard on this body. This fixture deliberately retains both.
  let statistics_dcp = if meta.model == "ILCE-1M2" {
    let name = "Sony ILCE-1M2 Adobe Standard v2.dcp";
    let path = [
      Path::new(&profiles).join("Adobe Standard").join(name),
      Path::new(&profiles).join(name),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .unwrap();
    Dcp::open(&path).unwrap()
  } else {
    dcp.clone()
  };
  let (camera, black) = captured_camera(root, &meta);
  let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
  let native_negative = std::fs::read(root.join("stats-image/gray-00_negative.bin")).unwrap();
  let flare = f64::from_le_bytes(native_negative[0x1768..0x1770].try_into().unwrap());
  let scene = Scene::new(
    &camera,
    &dcp,
    &statistics_dcp,
    &meta,
    neutral,
    &WhiteBalance::AsShot,
    black,
    flare,
  )
  .unwrap();
  let gray = GrayLogImage::new(&statistics_dcp, &meta, neutral, black).render(&camera, flare);
  let channels = stats_image::channel_logs(&camera, black, flare);
  let post = scene.post_image.render(&camera, flare);
  let mut channel_seen = [false; 3];
  let mut samples = 0;
  for index in 0..5 {
    let stem = format!("stats-{index:02}");
    let header = json(root.join(format!("{stem}.json")));
    let (values, stats) = if index == 0 {
      (&gray, &scene.gray)
    } else if index == 4 {
      (&post, &scene.post)
    } else {
      let plane = header["plane"].as_u64().unwrap() as usize;
      assert!(plane < 3 && !channel_seen[plane]);
      channel_seen[plane] = true;
      (&channels[plane], &scene.colors[plane])
    };
    let expected: Vec<f32> = std::fs::read(root.join(format!("{stem}.sorted.f32")))
      .unwrap()
      .chunks_exact(4)
      .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
      .collect();
    let mut sorted = values.clone();
    sorted.sort_unstable_by(f32::total_cmp);
    assert_eq!(sorted.len(), expected.len());
    for (i, (actual, expected)) in sorted.iter().zip(&expected).enumerate() {
      assert_eq!(
        actual.to_bits(),
        expected.to_bits(),
        "{stem} distribution sample{i}"
      );
    }
    samples += sorted.len();
    let native = std::fs::read(root.join(format!("{stem}.result.f64"))).unwrap();
    for (i, actual) in fields(stats).into_iter().enumerate() {
      let expected = f64::from_le_bytes(native[i * 8..i * 8 + 8].try_into().unwrap());
      if expected.is_nan() {
        assert!(actual.is_nan());
      } else if i < 2 {
        assert!(
          (actual - expected).abs() <= expected.abs().max(1.0) * f64::EPSILON * 32.0,
          "{stem} mean{i}"
        );
      } else {
        assert_eq!(actual.to_bits(), expected.to_bits(), "{stem} field{i}");
      }
    }
  }
  assert!(channel_seen.into_iter().all(|v| v));
  eprintln!(
    "AI scene replay: {} camera channels, {samples} distribution samples exact; 130 fields exact, 10 means within32eps",
    camera.pixels.len() * 3
  );
}
