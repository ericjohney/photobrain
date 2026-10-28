use super::*;
use std::path::{Path, PathBuf};

fn capture(root: &Path, tag: &str) -> (RgbImage, isize, isize) {
  let h: serde_json::Value =
    serde_json::from_slice(&std::fs::read(root.join(format!("{tag}.json"))).unwrap()).unwrap();
  let v = |k: &str| h[k].as_i64().unwrap();
  let (w, ht) = ((v("r") - v("l")) as usize, (v("b") - v("t")) as usize);
  let bytes = std::fs::read(root.join(format!("{tag}.bin"))).unwrap();
  let planes = v("planes") as usize;
  let mut out = RgbImage::new(w, ht);
  for y in 0..ht {
    for x in 0..w {
      for c in 0..3 {
        let i = (y * v("row_step") as usize
          + x * v("col_step") as usize
          + (c % planes) * v("plane_step") as usize)
          * 4;
        out.data[(y * w + x) * 3 + c] = f32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
      }
    }
  }
  (out, v("t") as isize, v("l") as isize)
}
fn check(
  ours: &RgbImage,
  top: isize,
  left: isize,
  target: &RgbImage,
  t: isize,
  l: isize,
  margin: usize,
) {
  let mut errors = 0;
  let mut count = 0;
  let mut max = 0.0f32;
  for y in margin..target.height - margin {
    for x in margin..target.width - margin {
      let a = ours.px((l - left) as usize + x, (t - top) as usize + y);
      let b = target.px(x, y);
      if !a.into_iter().all(f32::is_finite) {
        continue;
      }
      for c in 0..3 {
        count += 1;
        if a[c].to_bits() != b[c].to_bits() {
          errors += 1;
          max = max.max((a[c] - b[c]).abs());
        }
      }
    }
  }
  assert!(count > 30000, "too few valid samples: {count}");
  assert_eq!(errors, 0, "{errors}/{count} unequal, max error {max}");
}

/// External captured pixels stay outside the repository. Set the trace directory
/// to run exact reconstruction checks against Adobe's CPU stages.
#[test]
fn captured_xtrans_chain() {
  let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_TRACE").map(PathBuf::from) else {
    eprintln!("RAW_DEVELOP_ADOBE_TRACE unset; skipping Adobe capture checks");
    return;
  };
  let (src, top, left) = capture(&root, "0001_cr_stage_new_fuji6x6_src");
  let pin = Plane {
    width: src.width,
    height: src.height,
    data: src.data.chunks_exact(3).map(|p| p[0]).collect(),
  };
  let neg = std::env::var_os("RAW_DEVELOP_ADOBE_RAW").map(|p| Negative::open(p).unwrap());
  let (n, black, iso) = if let Some(neg) = &neg {
    (
      neg.meta.as_shot_wb.map(|v| 1.0 / v),
      ((neg.meta.black_levels[0] as u32) << (16 - neg.meta.bits_per_sample)) as f64 / 65535.0,
      neg.meta.iso.unwrap_or(100),
    )
  } else {
    ([0.52069, 1.0, 0.539286], 4092.0 / 65535.0, 125)
  };
  let neutral = rounded_neutral(n);
  let params = Parameters::new(neutral, black);
  let mut out = demosaic(&pin, top, left, &params, noise_offset(iso));
  let (target, t, l) = capture(&root, "0001_cr_stage_new_fuji6x6_dst");
  check(&out, top, left, &target, t, l, 12);
  cleanup::apply(&mut out, &params);
  let (target, t, l) = capture(&root, "0009_cr_stage_white_balance_3_dst");
  check(&out, top, left, &target, t, l, 8);
}

#[test]
fn noise_calibration_interpolates_read_noise_amplitude() {
  assert_eq!(noise_offset(125), 59.26 / (65535.0 * 65535.0));
  let q = (160.0 - 125.0) / (200.0 - 125.0);
  let expected =
    (59.26f64.sqrt() + (132.56f64.sqrt() - 59.26f64.sqrt()) * q).powi(2) / (65535.0 * 65535.0);
  assert!((noise_offset(160) - expected).abs() < 1e-22);
}

#[test]
fn raw_normalization_matches_captured_tile() {
  let (Some(root), Some(fixture)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_TRACE"),
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
  ) else {
    eprintln!("RAW_DEVELOP_ADOBE_TRACE/RAW unset; skipping RAW capture check");
    return;
  };
  let neg = Negative::open(fixture).unwrap();
  let (src, t, l) = capture(Path::new(&root), "0001_cr_stage_new_fuji6x6_src");
  let black = neg.meta.black_levels[0];
  let lut = linearization_table(
    black,
    super::super::white_level(&neg.meta) as f64,
    neg.meta.bits_per_sample,
  );
  let (py, px) = phase_origin(&neg).unwrap();
  let origin_y = neg.meta.crop_top - (neg.meta.crop_top + 6 - py) % 6;
  let origin_x = neg.meta.crop_left - (neg.meta.crop_left + 6 - px) % 6;
  for y in 0..src.height {
    for x in 0..src.width {
      let raw = neg.sample(t as usize + y + origin_y, l as usize + x + origin_x);
      assert_eq!(
        lut[raw as usize].to_bits(),
        src.px(x, y)[0].to_bits(),
        "input {y},{x}"
      );
    }
  }
}

/// Reference must be a linear, uncompressed DNG generated with the optional lens
/// CA opcode removed from a separate mosaic-DNG input. User NR is not in this DNG.
#[test]
fn full_file_linear_dng() {
  let (Some(raw), Some(reference)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("RAW_DEVELOP_ADOBE_LINEAR"),
  ) else {
    eprintln!("RAW_DEVELOP_ADOBE_RAW/LINEAR unset; skipping full Adobe base check");
    return;
  };
  let neg = Negative::open(raw).unwrap();
  let neutral = rounded_neutral(neg.meta.as_shot_wb.map(|v| 1.0 / v));
  let correct_ca = std::env::var_os("RAW_DEVELOP_ADOBE_LINEAR_CA").is_some();
  let ours = develop_preserved_with_lens(&neg, neutral, correct_ca, &Cancel::never()).unwrap();
  let bytes = std::fs::read(reference).unwrap();
  let tiff = crate::tiff::TiffReader::new(&bytes).unwrap();
  let i0 = tiff.ifd(tiff.first_ifd_offset().unwrap()).unwrap();
  let raw = tiff
    .ifd(i0.get(330).unwrap().value_u32(&tiff, 0).unwrap() as usize)
    .unwrap();
  let val = |tag| raw.get(tag).unwrap().value_u32(&tiff, 0).unwrap() as usize;
  assert_eq!((ours.width, ours.height), (val(256), val(257)));
  assert_eq!(val(259), 1, "reference must be uncompressed");
  let offset = val(273);
  let mut unequal = [0usize; 3];
  let mut max = [0u16; 3];
  let mut large = Vec::new();
  for (i, &v) in ours.data.iter().enumerate() {
    assert!(v.is_finite(), "nonfinite output at {i}");
    let expected = tiff.u16_at(offset + i * 2).unwrap();
    let actual = (v * 65535.0).round_ties_even().clamp(0.0, 65535.0) as u16;
    let d = expected.abs_diff(actual);
    if d > 0 {
      unequal[i % 3] += 1;
      max[i % 3] = max[i % 3].max(d);
    }
    if d > 1 && large.len() < 16 {
      large.push((
        i / 3 / ours.width,
        i / 3 % ours.width,
        i % 3,
        expected,
        actual,
      ));
    }
  }
  eprintln!("unequal {unequal:?}, max {max:?}, first differences {large:?}");
  assert_eq!(unequal, [0; 3]);
}
