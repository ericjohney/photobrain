use super::*;
use std::path::Path;

#[test]
fn batched_colour_matches_scalar_bits() {
  let mut seed = 17u32;
  let mut next = || {
    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
    seed
  };
  for dims in [[1, 2, 1], [5, 4, 1], [5, 4, 3], [90, 25, 32]] {
    for encoded in [false, true] {
      for overrange in [false, true] {
        for amount in [0.0, 0.65, 1.0] {
          let table = ColorTable {
            dims,
            data: (0..dims.into_iter().product())
              .map(|_| {
                [
                  ((next() >> 16) as f32 / 65535.0 - 0.5) * 0.5,
                  0.7 + (next() >> 16) as f32 / 65535.0 * 0.6,
                  0.7 + (next() >> 16) as f32 / 65535.0 * 0.6,
                  0.0,
                ]
              })
              .collect(),
            encoded,
            gain: 0.83,
            amount,
            overrange,
          };
          for sample in 0..2000 {
            let pixels = std::array::from_fn(|i| {
              std::array::from_fn(|c| {
                let n = next();
                match sample % 23 {
                  0 => {
                    if (i + c) % 2 == 0 {
                      -0.0
                    } else {
                      0.0
                    }
                  }
                  1 => 1.0,
                  2 => f32::from_bits(n & 0x807f_ffff),
                  3 => [0.0031308, 0.040449936, 0.5][c],
                  4 => (n >> 16) as f32 / 65535.0 * 8.0,
                  5 => {
                    if c == i % 3 {
                      1.0
                    } else {
                      0.0
                    }
                  }
                  6 => {
                    if c == i % 3 {
                      f32::NAN
                    } else {
                      0.5
                    }
                  }
                  _ => (n >> 16) as f32 / 65535.0 * 1.5 - 0.25,
                }
              })
            });
            let actual = table.pixels4(pixels);
            let expected = pixels.map(|p| table.pixel(p));
            assert_eq!(
              actual.map(|p| p.map(f32::to_bits)),
              expected.map(|p| p.map(f32::to_bits)),
              "{dims:?}, encoded {encoded}, overrange {overrange}, amount {amount}, sample {sample}, {pixels:?}"
            );
          }
        }
      }
    }
  }
}

#[test]
fn interpolation_matches_scalar_reference_at_wraps_and_endpoints() {
  let mut seed = 17u32;
  let mut next = || {
    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
    seed
  };
  for dims in [[1, 2, 1], [2, 2, 1], [5, 4, 1], [5, 4, 3], [90, 25, 32]] {
    let [hd, sd, vd] = dims;
    let table = ColorTable {
      dims,
      data: (0..hd * sd * vd)
        .map(|_| {
          let [h, s, v] = std::array::from_fn(|_| ((next() >> 8) as f32 / 16777216.0 - 0.5) * 16.0);
          [h, s, v, 0.0]
        })
        .collect(),
      encoded: false,
      gain: 1.0,
      amount: 1.0,
      overrange: false,
    };
    for sample in 0..20000 {
      let hi = next() as usize % hd;
      let si = next() as usize % (sd - 1);
      let vi = if vd == 1 {
        0
      } else {
        next() as usize % (vd - 1)
      };
      let mut fraction = || match sample % 17 {
        0 => 0.0,
        1 => 1.0,
        _ => (next() >> 8) as f32 / 16777216.0,
      };
      let [hf, sf, vf] = std::array::from_fn(|_| fraction());
      // Original scalar kernel: independent table addressing for each channel.
      let at = |v: usize, h: usize, s: usize, c: usize| table.data[(v * hd + h % hd) * sd + s][c];
      let hue = |v: usize, s: usize, c: usize| {
        hf.mul_add(at(v, hi + 1, s, c), (1.0 - hf) * at(v, hi, s, c))
      };
      let value = |s: usize, c: usize| {
        let low = hue(vi, s, c);
        if vd > 1 {
          vf.mul_add(hue(vi + 1, s, c), (1.0 - vf) * low)
        } else {
          low
        }
      };
      let expected: [f32; 3] =
        std::array::from_fn(|c| sf.mul_add(value(si + 1, c), (1.0 - sf) * value(si, c)));
      assert_eq!(
        table.interpolate(hi, si, vi, hf, sf, vf).map(f32::to_bits),
        expected.map(f32::to_bits),
        "{dims:?}, sample {sample}"
      );
    }
  }
}

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
      dims: [hd, sd, vd],
      data: data.into_iter().map(|[h, s, v]| [h, s, v, 0.0]).collect(),
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
        .data
        .iter()
        .zip(&table.data)
        .flat_map(|(a, b)| a.iter().zip(b))
        .filter(|(a, b)| a != b)
        .count();
      eprintln!("{name}: {differing} profile map values differ");
      for (a, b) in derived
        .data
        .iter()
        .zip(&table.data)
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
