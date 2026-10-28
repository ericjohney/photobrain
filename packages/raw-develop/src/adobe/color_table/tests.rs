use super::*;
use std::path::Path;

fn read_image(path: &Path) -> Vec<[f32; 3]> {
  let h: serde_json::Value =
    serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
  let n = |k: &str| h[k].as_i64().unwrap() as usize;
  assert_eq!(n("ptype"), 11);
  assert_eq!(n("planes"), 3);
  let width = n("r") - n("l");
  let height = n("b") - n("t");
  let bytes = std::fs::read(path.with_extension("bin")).unwrap();
  (0..width * height)
    .map(|i| {
      std::array::from_fn(|c| {
        let off = (i / width * n("row_step") + i % width * n("col_step") + c * n("plane_step")) * 4;
        f32::from_le_bytes(bytes[off..off + 4].try_into().unwrap())
      })
    })
    .collect()
}

#[test]
fn captured_modern_color_tables() {
  let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_RENDER_TRACE") else {
    eprintln!("RAW_DEVELOP_ADOBE_RENDER_TRACE unset; skipping colour-table captures");
    return;
  };
  let root = Path::new(&root);
  let mut captures: Vec<_> = std::fs::read_dir(root)
    .unwrap()
    .map(|p| p.unwrap().path())
    .filter(|p| {
      p.file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("_cr_stage_color_table_obj.bin")
    })
    .collect();
  captures.sort();
  assert!(!captures.is_empty());
  let profile = match (
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("ADOBE_PROFILE_DIR"),
  ) {
    (Some(raw), Some(profiles)) => {
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
      Some((dcp, spec))
    }
    _ => None,
  };
  if let Some((_, spec)) = &profile {
    let raw = std::env::var_os("RAW_DEVELOP_ADOBE_RAW").unwrap();
    let meta = crate::Negative::read_metadata(&std::fs::read(raw).unwrap()).unwrap();
    let black = ((meta.black_levels[0] as u32) << (16 - meta.bits_per_sample)) as f64 / 65535.0;
    let lut = remove_black_table(black);
    let path = root.join("001_cr_stage_1d_table_data_38.bin");
    if path.exists() {
      let reference: Vec<_> = std::fs::read(path)
        .unwrap()
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
        .collect();
      let differences = lut.iter().zip(&reference).filter(|(a, b)| a != b).count();
      eprintln!(
        "black-removal table: {differences}/65536 differ; colour white {:?}",
        spec.white_xy
      );
      assert_eq!(differences, 0);
    }
  }
  for path in captures {
    let name = path
      .file_name()
      .unwrap()
      .to_string_lossy()
      .replace("_obj.bin", "");
    let object = std::fs::read(&path).unwrap();
    let u = |o| u32::from_le_bytes(object[o..o + 4].try_into().unwrap()) as usize;
    let f = |o| f32::from_le_bytes(object[o..o + 4].try_into().unwrap());
    let [hd, sd, vd] = [u(0x38), u(0x3c), u(0x40)];
    let bytes = std::fs::read(root.join(format!("{name}_map_data.bin"))).unwrap();
    let values: Vec<_> = bytes
      .chunks_exact(4)
      .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
      .collect();
    let mut data = Vec::with_capacity(hd * sd * vd);
    for v in 0..vd {
      for h in 0..hd {
        for s in 0..sd {
          let i = ((v * (hd + 1) + h) * sd + s) * 4;
          data.push([values[i], values[i + 1], values[i + 2]]);
        }
      }
    }
    let table = ColorTable {
      map: HueSatMap {
        dims: [hd, sd, vd],
        data,
      },
      encoded: object[0x58..0x60].iter().any(|&v| v != 0) && vd > 1,
      gain: f(0x70),
      amount: f(0x74),
      overrange: object[0x80] != 0,
    };
    if let Some((dcp, spec)) = &profile {
      let map = if vd == 1 {
        spec.hue_sat_map.as_ref().unwrap()
      } else {
        dcp.look_table.as_ref().unwrap()
      };
      let derived = ColorTable::new(
        map,
        if vd == 1 {
          dcp.hue_sat_map_encoding == 1
        } else {
          dcp.look_table_encoding == 1
        },
        f(0x70),
        f(0x74),
        false,
      );
      let differing = derived
        .map
        .data
        .iter()
        .zip(&table.map.data)
        .flat_map(|(a, b)| a.iter().zip(b))
        .filter(|(a, b)| a != b)
        .count();
      eprintln!("{name}: {differing} profile map values differ");
      for (a, b) in derived
        .map
        .data
        .iter()
        .zip(&table.map.data)
        .filter(|(a, b)| a != b)
        .take(5)
      {
        eprintln!("map {a:?} expected {b:?}");
      }
      assert_eq!(differing, 0, "runtime DCP-derived map");
    }
    let source = read_image(&root.join(format!("{name}_src")));
    let reference = read_image(&root.join(format!("{name}_dst")));
    let mut differences = 0;
    let mut max_delta = 0.0f32;
    for (&p, expected) in source.iter().zip(&reference) {
      let actual = table.pixel(p);
      if actual != *expected && differences < 12 {
        eprintln!("{p:?} -> {actual:?} expected {expected:?}");
      }
      for c in 0..3 {
        differences += usize::from(actual[c] != expected[c]);
        max_delta = max_delta.max((actual[c] - expected[c]).abs());
      }
    }
    eprintln!(
      "{name} dims {hd}/{sd}/{vd} encoded {}: {differences}/{} differ, max {max_delta}",
      table.encoded,
      source.len() * 3
    );
    // Keep reporting each captured stage before asserting.
    assert_eq!(differences, 0);
  }
}

#[test]
fn captured_full_preparation_to_profile_colour() {
  let (Some(root), Some(raw), Some(profiles)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_RENDER_TRACE"),
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("ADOBE_PROFILE_DIR"),
  ) else {
    return;
  };
  let root = Path::new(&root);
  let negative = crate::Negative::open(raw).unwrap();
  let settings = crate::DevelopSettings {
    adobe_noise_reduction: Some(crate::settings::AdobeNoiseReduction {
      color: 0,
      ..Default::default()
    }),
    luma_noise_reduction: Some(0.0),
    sharpening: 0.0,
    highlight_recovery: false,
    lens: crate::settings::LensSettings {
      distortion: false,
      chromatic_aberration: true,
      vignetting: false,
    },
    ..Default::default()
  };
  let options = crate::Options {
    engine: crate::Engine::Adobe,
    adobe_profile_dir: Some(profiles.into()),
    ..Default::default()
  };
  let prepared = crate::prepare(&negative, &settings, &options).unwrap();
  let dcp = crate::adobe::dcp::Dcp::open(
    &crate::adobe::dcp::Dcp::find_adobe_standard(
      options.adobe_profile_dir.as_ref().unwrap(),
      &negative.meta.make,
      &negative.meta.model,
    )
    .unwrap(),
  )
  .unwrap();
  let neutral = crate::adobe::xtrans::rounded_neutral(negative.meta.as_shot_wb.map(|v| 1.0 / v));
  let render = crate::adobe::AdobeRender::new(
    &dcp,
    &negative.meta,
    neutral,
    0.0,
    &settings.white_balance,
    true,
  )
  .unwrap();
  let color = render.modern_color.as_ref().unwrap();
  let mut paths: Vec<_> = std::fs::read_dir(root)
    .unwrap()
    .map(|p| p.unwrap().path())
    .filter(|p| {
      p.file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("_cr_stage_color_table_dst.json")
    })
    .collect();
  paths.sort();
  let path = paths[0].with_extension("");
  let h: serde_json::Value =
    serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
  let n = |k: &str| h[k].as_i64().unwrap() as usize;
  let expected = read_image(&path);
  let (left, top) = if negative.meta.cfa.is_xtrans() {
    (0, 0)
  } else {
    (negative.meta.crop_left, negative.meta.crop_top)
  };
  let mut differences = 0;
  let mut max_delta = 0.0f32;
  for y in n("t")..n("b") {
    for x in n("l")..n("r") {
      let actual = color.input_pixel(prepared.working_image().px(x - left, y - top));
      let reference = expected[(y - n("t")) * (n("r") - n("l")) + x - n("l")];
      for c in 0..3 {
        differences += usize::from(actual[c] != reference[c]);
        max_delta = max_delta.max((actual[c] - reference[c]).abs());
      }
    }
  }
  eprintln!(
    "RAW through first profile map: {differences}/{} different, max {max_delta}",
    expected.len() * 3
  );
  assert_eq!((differences, max_delta), (0, 0.0));
}
