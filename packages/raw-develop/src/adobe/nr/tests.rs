use super::spatial::{Parameters, filter_tile};
use std::path::Path;

struct Capture {
  data: Vec<[u16; 3]>,
  width: usize,
  height: usize,
  top: i64,
  left: i64,
}

fn capture(path: &Path) -> Capture {
  let h: serde_json::Value =
    serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
  let n = |key: &str| h[key].as_i64().unwrap();
  assert_eq!(n("ptype"), 8);
  assert_eq!(n("planes"), 3);
  let width = (n("r") - n("l")) as usize;
  let height = (n("b") - n("t")) as usize;
  let raw = std::fs::read(path.with_extension("bin")).unwrap();
  let data = (0..width * height)
    .map(|i| {
      std::array::from_fn(|c| {
        let offset = ((i / width) as i64 * n("row_step")
          + (i % width) as i64 * n("col_step")
          + c as i64 * n("plane_step")) as usize
          * 2;
        u16::from_le_bytes(raw[offset..offset + 2].try_into().unwrap()) ^ 32768
      })
    })
    .collect();
  Capture {
    data,
    width,
    height,
    top: n("t"),
    left: n("l"),
  }
}

#[test]
fn captured_default_chroma_stage() {
  let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_NR_TRACE") else {
    eprintln!("RAW_DEVELOP_ADOBE_NR_TRACE unset; skipping external user-NR check");
    return;
  };
  let root = Path::new(&root);
  let src = capture(&root.join("stage_src"));
  let reference = capture(&root.join("stage_dst"));
  let area: [i64; 4] =
    serde_json::from_slice(&std::fs::read(root.join("area.json")).unwrap()).unwrap();
  let area = [
    (area[0] - src.top) as usize,
    (area[1] - src.left) as usize,
    (area[2] - src.top) as usize,
    (area[3] - src.left) as usize,
  ];
  let object = std::fs::read(root.join("obj.bin")).unwrap();
  let double = |offset| f64::from_le_bytes(object[offset..offset + 8].try_into().unwrap());
  let integer = |offset| u32::from_le_bytes(object[offset..offset + 4].try_into().unwrap());
  assert_eq!(object[0x8b0], 0);
  assert_eq!(object[0x8b1], 1);
  assert_eq!(integer(0x96c), 2);
  let params = Parameters::with_rank(
    integer(0x920) as usize,
    std::array::from_fn(|c| double(0x930 + c * 8) as f32),
    -(double(0x928) as f32),
    double(0x948) as f32,
    [double(0x958), double(0x960)],
    integer(0x954) as usize,
  );
  let actual = filter_tile(&src.data, src.width, src.height, area, &params);
  let mut differences = 0;
  let mut max_delta = 0;
  for y in area[0]..area[2] {
    for x in area[1]..area[3] {
      let i = (y - area[0]) * (area[3] - area[1]) + x - area[1];
      let expected = reference.data[y * src.width + x];
      assert_eq!(actual[i][0], src.data[y * src.width + x][0]);
      for c in 0..3 {
        let delta = actual[i][c].abs_diff(expected[c]);
        differences += usize::from(delta != 0);
        max_delta = max_delta.max(delta);
      }
    }
  }
  eprintln!(
    "NR stage {} pixels: {differences} differing channels; max {max_delta}",
    actual.len()
  );
  assert_eq!((differences, max_delta), (0, 0));
}

#[test]
fn chroma_tile_leaves_luma_untouched() {
  let params = Parameters::new(2, [-4000.0, -8000.0, -2000.0], 0.01, 0.21404114, [-1e-5; 2]);
  let (width, height) = (37, 35);
  let input: Vec<[u16; 3]> = (0..width * height)
    .map(|i| {
      [
        ((i * 1297) % 65536) as u16,
        (24000 + (i * 379) % 10000) as u16,
        (28000 + (i * 733) % 10000) as u16,
      ]
    })
    .collect();
  let output = filter_tile(&input, width, height, [13, 13, 22, 24], &params);
  for y in 13..22 {
    for x in 13..24 {
      assert_eq!(output[(y - 13) * 11 + x - 13][0], input[y * width + x][0]);
    }
  }
  assert!(output.iter().enumerate().any(|(i, v)| {
    let source = input[(i / 11 + 13) * width + i % 11 + 13];
    v[1..] != source[1..]
  }));
}

/// The entire five-stage CR6 boundary, deriving the noise and YCC parameters
/// from RAW metadata and the runtime DCP. No captured intermediate pixels are
/// supplied to the spatial filter or either inverse transform.
#[test]
fn captured_composed_chroma_boundary() {
  let (Some(root), Some(raw), Some(profiles)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_NR_TILES"),
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("ADOBE_PROFILE_DIR"),
  ) else {
    eprintln!("NR_TILES, RAW and ADOBE_PROFILE_DIR required for composed CR6 capture");
    return;
  };
  let root = Path::new(&root);
  let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
  let dcp = crate::adobe::dcp::Dcp::open(
    &crate::adobe::dcp::Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model)
      .unwrap(),
  )
  .unwrap();
  let neutral = crate::adobe::xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
  let spec = crate::adobe::color::ColorSpec::for_render(
    &dcp,
    &meta,
    neutral,
    &crate::settings::WhiteBalance::AsShot,
  );
  let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
  let input = crate::adobe::input::InputTransform::new(&spec, neutral, black);
  let params = super::params::Parameters::new(
    &meta.model,
    meta.iso.unwrap_or(100),
    input.noise_scale(),
    spec.raw_to_prophoto(neutral),
    black,
    0.25,
    0.5,
    0.5,
  )
  .unwrap();
  let space = super::space::Space::new(&params.curve, params.ycc, params.inverse_ycc, 0.25);
  let mut stages: Vec<_> = std::fs::read_dir(root)
    .unwrap()
    .map(|e| e.unwrap().path())
    .filter(|p| {
      p.file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("_cr_stage_denoise_src.json")
    })
    .collect();
  stages.sort();
  assert_eq!(stages.len(), 1);
  let stage = stages[0].file_name().unwrap().to_string_lossy();
  let index: usize = stage[..4].parse().unwrap();
  let source = capture(&root.join(format!("{:04}_cr_stage_1d_table_src", index - 2)));
  let expected = capture(&root.join(format!("{:04}_cr_stage_1d_table_dst", index + 2)));
  let encoded: Vec<_> = source
    .data
    .iter()
    .map(|p| space.encode(p.map(crate::adobe::bayer::tables::normalized)))
    .collect();
  let expected_encoded = capture(&stages[0].with_extension(""));
  assert_eq!(encoded.len(), expected_encoded.data.len());
  let forward_differences = encoded
    .iter()
    .zip(&expected_encoded.data)
    .flat_map(|(a, b)| a.iter().zip(b))
    .filter(|(a, b)| a != b)
    .count();
  assert_eq!(forward_differences, 0, "composed forward curve + YCC");
  let area = [
    (expected.top - source.top) as usize,
    (expected.left - source.left) as usize,
    (expected.top - source.top) as usize + expected.height,
    (expected.left - source.left) as usize + expected.width,
  ];
  let filtered = filter_tile(&encoded, source.width, source.height, area, &params.spatial);
  let actual: Vec<_> = filtered.iter().map(|&p| space.decode(p)).collect();
  let mut differences = 0;
  let mut max_error = 0.0f32;
  for (actual, expected) in actual.iter().zip(&expected.data) {
    for c in 0..3 {
      let expected = crate::adobe::bayer::tables::normalized(expected[c]);
      differences += usize::from(actual[c] != expected);
      max_error = max_error.max((actual[c] - expected).abs());
    }
  }
  eprintln!(
    "composed CR6: {} samples, {differences} differences, max {max_error}",
    actual.len() * 3
  );
  assert_eq!((differences, max_error), (0, 0.0));
}

#[test]
fn tiled_chroma_preserves_lattice_across_joins_and_odd_edges() {
  let params = super::params::Parameters::new(
    "X-E5",
    10000,
    0.5,
    crate::math::Mat3::IDENTITY,
    4096.0 / 65535.0,
    0.25,
    0.5,
    0.5,
  )
  .unwrap();
  let mut one = crate::image::RgbImage::new(53, 39);
  one
    .data
    .iter_mut()
    .enumerate()
    .for_each(|(i, v)| *v = (i * 137 % 65536) as f32 / 65535.0);
  let mut many = one.clone();
  super::apply_tiled(&mut one, &params, &crate::Cancel::never(), 64).unwrap();
  super::apply_tiled(&mut many, &params, &crate::Cancel::never(), 16).unwrap();
  assert_eq!(one.data, many.data);
  let before = many.data.clone();
  let cancel = crate::Cancel::new();
  cancel.cancel();
  assert!(matches!(
    super::apply(&mut many, &params, &cancel),
    Err(crate::Error::Cancelled)
  ));
  assert_eq!(many.data, before);
}

#[test]
fn tiled_luma_and_chroma_preserve_lattice_across_joins_and_odd_edges() {
  for color in [0.0, 0.62] {
    let mut params = super::params::Parameters::new(
      "X-E5",
      10000,
      0.5,
      crate::math::Mat3::IDENTITY,
      4096.0 / 65535.0,
      color,
      0.8,
      0.75,
    )
    .unwrap();
    params.luma = super::luma::Parameters::new("X-E5", 10000, 0.5, 0.7, 0.11, 0.22);
    let mut one = crate::image::RgbImage::new(53, 39);
    one.data.iter_mut().enumerate().for_each(|(i, v)| {
      *v = (i * 137 % 65536) as f32 / 65535.0;
    });
    let mut many = one.clone();
    super::apply_tiled(&mut one, &params, &crate::Cancel::never(), 64).unwrap();
    super::apply_tiled(&mut many, &params, &crate::Cancel::never(), 24).unwrap();
    assert!(one.data.iter().all(|v| v.is_finite()));
    assert_eq!(one.data, many.data, "Color {color}");
  }
}

#[test]
fn larger_luma_tiles_match_original_tile_boundaries() {
  let mut params = super::params::Parameters::new(
    "X-E5",
    10000,
    0.5,
    crate::math::Mat3::IDENTITY,
    4096.0 / 65535.0,
    0.25,
    0.5,
    0.5,
  )
  .unwrap();
  params.luma = super::luma::Parameters::new("X-E5", 10000, 0.5, 0.7, 0.11, 0.22);
  for (width, height) in [(401, 25), (25, 401), (401, 401)] {
    let mut original = crate::image::RgbImage::new(width, height);
    original.data.iter_mut().enumerate().for_each(|(i, v)| {
      *v = (i * 137 % 65536) as f32 / 65535.0;
    });
    let mut larger = original.clone();
    super::apply_tiled(&mut original, &params, &crate::Cancel::never(), 192).unwrap();
    super::apply_tiled(&mut larger, &params, &crate::Cancel::never(), 384).unwrap();
    assert_eq!(
      original
        .data
        .iter()
        .map(|v| v.to_bits())
        .collect::<Vec<_>>(),
      larger.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
      "{width}x{height}"
    );
  }
}
