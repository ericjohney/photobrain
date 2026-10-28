//! External, composed RAW-to-output checks. Proprietary RAWs, profiles and
//! capture payloads remain outside the repository.

use super::*;
use crate::{
  Cancel, DevelopSettings, Negative,
  settings::{AdobeNoiseReduction, AdobeTone, LensSettings},
};

/// The default capture has Exposure .70, Contrast 30, Whites 20, Blacks -25,
/// zero user NR/sharpening and optional lens corrections off. A settings file
/// selects other controlled global/spatial cases. Embedded CA remains mandatory.
/// Set RAW_DEVELOP_ADOBE_COMPOSED_RAW and
/// RAW_DEVELOP_ADOBE_COMPOSED_TRACE to the original RAW and trace_output folder.
#[test]
fn captured_raw_to_output() {
  let (Some(raw), Some(root), Some(profiles)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_COMPOSED_RAW"),
    std::env::var_os("RAW_DEVELOP_ADOBE_COMPOSED_TRACE"),
    std::env::var_os(PROFILE_DIR_ENV),
  ) else {
    return;
  };
  let root = Path::new(&root);
  let negative = Negative::open(raw).unwrap();
  let meta = &negative.meta;
  let dcp =
    Dcp::open(&Dcp::find_adobe_standard(Path::new(&profiles), &meta.make, &meta.model).unwrap())
      .unwrap();
  let neutral = xtrans::rounded_neutral(meta.as_shot_wb.map(|v| 1.0 / v));
  let settings = DevelopSettings {
    exposure: 0.7,
    adobe_tone: Some(AdobeTone {
      contrast: 30,
      whites: 20,
      blacks: -25,
      ..Default::default()
    }),
    adobe_noise_reduction: Some(AdobeNoiseReduction {
      color: 0,
      luminance: 0,
      ..Default::default()
    }),
    sharpening: 0.0,
    lens: LensSettings {
      distortion: false,
      chromatic_aberration: false,
      vignetting: false,
    },
    ..Default::default()
  };
  let settings = std::env::var_os("RAW_DEVELOP_ADOBE_COMPOSED_SETTINGS").map_or(settings, |path| {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
  });
  let cancel = Cancel::never();
  let mut image = if meta.cfa.is_xtrans() {
    xtrans::develop_preserved_with_lens(&negative, neutral, true, &cancel).unwrap()
  } else {
    bayer::develop_unbalanced_active(&negative, true, &cancel).unwrap()
  };
  let mut render =
    AdobeRender::new(&dcp, meta, neutral, 0.0, &settings.white_balance, true).unwrap();
  render
    .prepare_camera(&mut image, &dcp, meta, &settings, &cancel)
    .unwrap();
  if !meta.cfa.is_xtrans() {
    image = image.crop(
      meta.crop_left,
      meta.crop_top,
      meta.crop_width,
      meta.crop_height,
    );
  }
  if let Some(file) = std::fs::read_dir(root)
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .find(|file| {
      file
        .file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("_cr_stage_tone_map_src.json")
    })
  {
    let mut colored = image.clone();
    render.prepare_color(&mut colored, &cancel).unwrap();
    let header: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    let n = |key: &str| header[key].as_i64().unwrap() as usize;
    let source = std::fs::read(file.with_extension("bin")).unwrap();
    let offset = if meta.cfa.is_xtrans() {
      [0, 0]
    } else {
      [meta.crop_left, meta.crop_top]
    };
    let mut different = 0;
    let mut maximum = 0.0f32;
    for y in n("t")..n("b") {
      for x in n("l")..n("r") {
        for c in 0..3 {
          let i =
            ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step"))
              * n("psize");
          let expected = f32::from_le_bytes(source[i..i + 4].try_into().unwrap());
          let actual = colored.px(x - offset[0], y - offset[1])[c];
          if actual.to_bits() != expected.to_bits() {
            if different < 5 {
              eprintln!("spatial input {x},{y},{c}: {actual} != {expected}");
            }
            different += 1;
            maximum = maximum.max((actual - expected).abs());
          }
        }
      }
    }
    eprintln!("RAW→spatial input: {different} differences; maximum {maximum}");
    assert_eq!(different, 0, "RAW to spatial tone input");
    let cache = render.mask.as_ref().unwrap();
    let mask = cache.get(&cancel).unwrap();
    let full_mask = cache.full(render.distortion.as_ref(), &cancel).unwrap();
    let scene = render.scene.as_ref().unwrap();
    let controls = settings.adobe_tone.as_ref().unwrap();
    let setup = tone::setup::Setup::new(
      tone::setup::Parameters {
        exposure_hundredths: (settings.exposure * 100.0).round() as i32,
        whites: controls.whites,
        baseline_exposure: render.baseline_exposure,
        raw_scale: 1.0,
        custom_flare: Some(scene.flare),
      },
      &render.render_color,
      neutral,
      &scene.gray,
      &scene.colors,
    );
    let stage = tone::spatial::Stage::new(
      &mask.source,
      &mask.filtered,
      &setup.info,
      controls.shadows,
      controls.highlights,
      setup.log_flare,
      setup.epsilon,
    );
    if let Some(capture) = std::env::var_os("ADOBE_TONE_SPATIAL_CAPTURE") {
      let capture = Path::new(&capture);
      let info = std::fs::read(capture.join("global_info.bin")).unwrap();
      let d = |o| f64::from_le_bytes(info[o..o + 8].try_into().unwrap());
      let stats = |base: usize| [0x10, 0x68, 0xa0, 0xa8, 0xb0, 0xd0].map(|o| d(base + o));
      let mut source = mask.source.clone();
      let mut filtered = mask.filtered.clone();
      if setup.info.input_exposure > 0.0 {
        source.apply_offset(-setup.info.input_exposure);
        filtered.apply_offset(-setup.info.input_exposure);
      }
      assert_eq!(source.tone(), stats(0x718), "mask source tone statistics");
      assert_eq!(
        filtered.tone(),
        stats(0x820),
        "mask filtered tone statistics"
      );
      let header: serde_json::Value =
        serde_json::from_slice(&std::fs::read(capture.join("global.json")).unwrap()).unwrap();
      let stack = std::fs::read(capture.join("global_stack.bin")).unwrap();
      let p: [f32; 28] = std::array::from_fn(|i| {
        if i < 8 {
          header["s"][i].as_f64().unwrap() as f32
        } else {
          f32::from_le_bytes(
            stack[24 + (i - 8) * 4..28 + (i - 8) * 4]
              .try_into()
              .unwrap(),
          )
        }
      });
      assert_eq!(
        stage.parameters().map(f32::to_bits),
        [
          p[1], p[2], p[9], p[10], p[11], p[12], p[13], p[14], p[15], p[16], p[17], p[18], p[19],
          p[20], p[21], p[22], p[23], p[24], p[25], p[26], p[27]
        ]
        .map(f32::to_bits),
        "spatial parameters"
      );
    }
    let dst = file.with_file_name(
      file
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace("_src.json", "_dst.json"),
    );
    let header: serde_json::Value = serde_json::from_slice(&std::fs::read(&dst).unwrap()).unwrap();
    let n = |key: &str| header[key].as_i64().unwrap() as usize;
    let bytes = std::fs::read(dst.with_extension("bin")).unwrap();
    let mut different = 0;
    let mut maximum = 0.0f32;
    for y in n("t")..n("b") {
      for x in n("l")..n("r") {
        let sx = x - offset[0];
        let sy = y - offset[1];
        let actual = stage.pixel(
          colored.px(sx, sy),
          cache.sample(full_mask, [colored.width, colored.height], sx, sy),
        );
        for c in 0..3 {
          let i =
            ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step")) * 4;
          let expected = f32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
          if actual[c].to_bits() != expected.to_bits() {
            if different < 5 {
              eprintln!("spatial output {x},{y},{c}: {} != {expected}", actual[c]);
            }
            different += 1;
            maximum = maximum.max((actual[c] - expected).abs());
          }
        }
      }
    }
    eprintln!("RAW→spatial output: {different} differences; maximum {maximum}");
    assert_eq!(different, 0, "RAW to spatial tone output");
  }
  let stem = std::fs::read_dir(root)
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .filter_map(|name| {
      name
        .strip_suffix("_cr_stage_1d_table_dst.json")
        .map(|prefix| format!("{prefix}_cr_stage_1d_table_dst"))
    })
    .max()
    .expect("final output transfer capture");
  let header: serde_json::Value =
    serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap()).unwrap();
  let n = |key: &str| header[key].as_i64().unwrap() as usize;
  let (width, height) = (n("r") - n("l"), n("b") - n("t"));
  // Global tone needs only this tile after measuring the original image.
  // Spatial tone and lens corrections retain full output coordinates.
  let spatial = settings
    .adobe_tone
    .as_ref()
    .is_some_and(|tone| tone.highlights != 0 || tone.shadows != 0)
    || settings.lens.distortion
    || settings.lens.vignetting;
  let origin = if spatial {
    [n("l"), n("t")]
  } else {
    image = image.crop(n("l"), n("t"), width, height);
    [0, 0]
  };
  render
    .render_to_space(
      &mut image,
      &settings,
      false,
      &cancel,
      output::OutputSpace::Srgb,
    )
    .unwrap();
  let data = std::fs::read(root.join(format!("{stem}.bin"))).unwrap();
  let mut mismatches = 0;
  let mut maximum = 0.0f32;
  for y in 0..height {
    for x in 0..width {
      for c in 0..3 {
        let offset = (y * n("row_step") + x * n("col_step") + c * n("plane_step")) * n("psize");
        let code = u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap())
          ^ if n("ptype") == 8 { 32768 } else { 0 };
        let expected = bayer::tables::normalized(code);
        let actual = image.px(x + origin[0], y + origin[1])[c];
        if actual.to_bits() != expected.to_bits() {
          if mismatches < 5 {
            eprintln!("({x},{y},{c}) {actual} != {expected}");
          }
          mismatches += 1;
          maximum = maximum.max((actual - expected).abs());
        }
      }
    }
  }
  eprintln!(
    "{} RAW→tone→output: {} channels, {mismatches} differences, maximum {maximum}",
    meta.model,
    width * height * 3
  );
  assert_eq!(mismatches, 0);
}
