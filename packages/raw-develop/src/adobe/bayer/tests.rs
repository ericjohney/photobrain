use super::*;
use std::path::{Path, PathBuf};

struct Capture {
  width: usize,
  height: usize,
  planes: usize,
  top: isize,
  left: isize,
  data: Vec<f32>,
}

fn capture(path: &Path) -> Capture {
  let h: serde_json::Value =
    serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
  let get = |key: &str| h[key].as_i64().unwrap();
  let width = (get("r") - get("l")) as usize;
  let height = (get("b") - get("t")) as usize;
  let planes = get("planes") as usize;
  let bytes = std::fs::read(path.with_extension("bin")).unwrap();
  let size = get("psize") as usize;
  let mut data = Vec::with_capacity(width * height * planes);
  for y in 0..height {
    for x in 0..width {
      for c in 0..planes {
        let index = (y * get("row_step") as usize
          + x * get("col_step") as usize
          + c * get("plane_step") as usize)
          * size;
        data.push(if size == 4 {
          f32::from_le_bytes(bytes[index..index + 4].try_into().unwrap())
        } else {
          let value = u16::from_le_bytes(bytes[index..index + 2].try_into().unwrap());
          normalized(if get("ptype") == 8 {
            value ^ 32768
          } else {
            value
          })
        });
      }
    }
  }
  Capture {
    width,
    height,
    planes,
    top: get("t") as isize,
    left: get("l") as isize,
    data,
  }
}

fn traces(root: &Path, suffix: &str) -> Vec<PathBuf> {
  let mut files: Vec<_> = std::fs::read_dir(root)
    .unwrap()
    .map(|e| e.unwrap().path())
    .filter(|p| p.file_name().unwrap().to_string_lossy().ends_with(suffix))
    .collect();
  files.sort();
  files
}

#[test]
fn raw_normalization_and_composed_captured_chain() {
  let (Some(root), Some(raw)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_BAYER_TRACE"),
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
  ) else {
    eprintln!("RAW_DEVELOP_ADOBE_BAYER_TRACE/RAW unset; skipping external Bayer chain check");
    return;
  };
  let root = Path::new(&root);
  let neg = Negative::open(raw).unwrap();
  let parameters = Parameters::new(&neg).unwrap();
  let (py, px) = phase_origin(&neg).unwrap();
  let lut = super::super::linearize::table(
    neg.meta.black_levels[0],
    super::super::white_level(&neg.meta) as f64,
    neg.meta.bits_per_sample,
  );
  let output = traces(root, "_cr_stage_bayer_gain_dst.json")
    .into_iter()
    .map(|p| capture(&p))
    .find(|p| p.planes == 3)
    .unwrap();
  let mut checked = 0;
  let mut errors = 0;
  for path in traces(root, "_cr_stage_cfa_get_image_dst.json") {
    let input = capture(&path);
    for y in 0..input.height {
      for x in 0..input.width {
        let expected = lut[neg.sample(
          (input.top + y as isize) as usize,
          (input.left + x as isize) as usize,
        ) as usize];
        assert_eq!(
          input.data[y * input.width + x].to_bits(),
          expected.to_bits(),
          "normalization at {y},{x} in {}",
          path.display()
        );
      }
    }
    let ours = parameters.process(
      &input.data,
      input.width,
      input.height,
      input.top - py as isize,
      input.left - px as isize,
    );
    let margin = parameters.halo();
    for y in 0..output.height {
      for x in 0..output.width {
        let sy = output.top + y as isize - input.top;
        let sx = output.left + x as isize - input.left;
        if sy < margin as isize
          || sx < margin as isize
          || sy >= (input.height - margin) as isize
          || sx >= (input.width - margin) as isize
        {
          continue;
        }
        for c in 0..3 {
          let actual = ours.data[(sy as usize * input.width + sx as usize) * 3 + c];
          assert!(actual.is_finite());
          let expected = output.data[(y * output.width + x) * 3 + c];
          checked += 1;
          errors += usize::from(code(actual) != code(expected));
        }
      }
    }
  }
  eprintln!("composed Bayer chain: {errors}/{checked} differing u16 samples");
  assert!(checked > 30000);
  assert_eq!(errors, 0);
}

/// Compare every cropped channel against an external no-CA linear DNG. DNG
/// Converter keeps the full active sensor area; the engine returns DefaultCrop.
#[test]
fn full_file_linear_dng() {
  let (Some(raw), Some(reference)) = (
    std::env::var_os("RAW_DEVELOP_ADOBE_RAW"),
    std::env::var_os("RAW_DEVELOP_ADOBE_LINEAR"),
  ) else {
    eprintln!("RAW_DEVELOP_ADOBE_RAW/LINEAR unset; skipping external Bayer file check");
    return;
  };
  let neg = Negative::open(raw).unwrap();
  if neg.meta.cfa.is_xtrans() {
    return;
  }
  let parameters = Parameters::new(&neg).unwrap();
  let correct_ca = std::env::var_os("RAW_DEVELOP_ADOBE_LINEAR_CA").is_some();
  let ours = if correct_ca {
    let active = develop_unbalanced_active(&neg, true, &Cancel::never()).unwrap();
    active.crop(
      neg.meta.crop_left,
      neg.meta.crop_top,
      neg.meta.crop_width,
      neg.meta.crop_height,
    )
  } else {
    develop_preserved_with_lens(&neg, &parameters, false, &Cancel::never()).unwrap()
  };
  let bytes = std::fs::read(reference).unwrap();
  let t = crate::tiff::TiffReader::new(&bytes).unwrap();
  let i0 = t.ifd(t.first_ifd_offset().unwrap()).unwrap();
  let image = t
    .ifd(i0.get(330).unwrap().value_u32(&t, 0).unwrap() as usize)
    .unwrap();
  let val = |tag| image.get(tag).unwrap().value_u32(&t, 0).unwrap() as usize;
  assert_eq!(val(259), 1, "reference must be uncompressed");
  assert_eq!(val(277), 3, "reference must be linear RGB");
  let width = val(256);
  let height = val(257);
  assert_eq!((width, height), active_size(&neg).unwrap());
  let offset = val(273);
  let mut errors = [0usize; 3];
  let mut max = [0u16; 3];
  let mut first = Vec::new();
  for y in 0..ours.height {
    for x in 0..ours.width {
      for c in 0..3 {
        let value = ours.data[(y * ours.width + x) * 3 + c];
        assert!(value.is_finite(), "nonfinite at {y},{x},{c}");
        let actual = code(value);
        let i = ((y + neg.meta.crop_top) * width + x + neg.meta.crop_left) * 3 + c;
        let expected = t.u16_at(offset + i * 2).unwrap();
        let difference = actual.abs_diff(expected);
        if difference > 0 {
          errors[c] += 1;
          max[c] = max[c].max(difference);
          if first.len() < 12 {
            first.push((y, x, c, expected, actual));
          }
        }
      }
    }
  }
  eprintln!("whole-file Bayer differing channels {errors:?}; max {max:?}; first {first:?}");
  assert_eq!(errors, [0; 3]);
}

#[test]
fn border_repeat_preserves_bayer_phase() {
  for n in [2, 3, 32, 33] {
    for i in -32..n as isize + 32 {
      let extended = repeat(i, n);
      assert!(extended < n);
      assert_eq!(extended % 2, i.rem_euclid(2) as usize);
    }
  }
}
