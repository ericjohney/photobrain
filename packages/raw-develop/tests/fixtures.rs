//! Fixture tests against real RAW files (RAF, ARW, DNG) and Apple reference renders.
//!
//! Skipped (with a message) unless both are set:
//!   RAW_DEVELOP_FIXTURES  directory of *.RAF / *.ARW / *.DNG files
//!   RAW_DEVELOP_REFS      directory produced by tools/apple-reference (one subdir per stem)
//!
//!   RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures RAW_DEVELOP_REFS=~/raw-develop-refs \
//!     cargo test --release --test fixtures -- --nocapture

use raw_develop::{DevelopSettings, Negative, Options, develop};
use std::path::{Path, PathBuf};

fn dirs() -> Option<(PathBuf, PathBuf)> {
  let f = std::env::var_os("RAW_DEVELOP_FIXTURES")?;
  let r = std::env::var_os("RAW_DEVELOP_REFS")?;
  Some((PathBuf::from(f), PathBuf::from(r)))
}

fn fixtures(dir: &Path) -> Vec<PathBuf> {
  let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
    .unwrap()
    .filter_map(|e| e.ok().map(|e| e.path()))
    .filter(|p| {
      p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| ["raf", "arw", "dng"].contains(&e.to_ascii_lowercase().as_str()))
    })
    .collect();
  v.sort();
  v
}

#[test]
fn decoder_is_bit_exact_with_rawcamera() {
  let Some((fx, refs)) = dirs() else {
    eprintln!("skipped: set RAW_DEVELOP_FIXTURES and RAW_DEVELOP_REFS");
    return;
  };
  for raf in fixtures(&fx) {
    let stem = raf.file_stem().unwrap().to_string_lossy().to_string();
    let rgb_ref = refs.join(&stem).join("cfa.rgb.f32");
    if rgb_ref.exists() {
      // LinearRaw DNG: RawCamera's provider holds half floats.
      let (w, h, apple) = load_f32(&rgb_ref);
      let neg = Negative::open(&raf).unwrap();
      let (_, ours) = neg.dng.as_ref().expect("DNG");
      assert_eq!((w, h), (neg.meta.raw_width, neg.meta.raw_height), "{stem}: size");
      let bad = ours
        .iter()
        .zip(&apple)
        .filter(|(a, b)| half(**a) != **b)
        .count();
      assert!(bad == 0, "{stem}: {bad} samples differ from RawCamera");
      eprintln!("{stem}: bit-exact (half float)");
      continue;
    }
    let Ok(apple) = std::fs::read(refs.join(&stem).join("cfa.u16")) else {
      eprintln!("{stem}: no reference cfa.u16");
      continue;
    };
    let neg = Negative::open(&raf).unwrap();
    let ours: Vec<u8> = neg.mosaic.iter().flat_map(|v| v.to_le_bytes()).collect();
    assert!(
      ours == apple,
      "{stem}: decoded mosaic differs from RawCamera"
    );
    eprintln!("{stem}: bit-exact");
  }
}

/// Round to the nearest IEEE half float (normal range).
fn half(x: f32) -> f32 {
  let b = x.to_bits();
  f32::from_bits((b + 0x0fff + ((b >> 13) & 1)) & !0x1fff)
}

fn load_f32(p: &Path) -> (usize, usize, Vec<f32>) {
  let b = std::fs::read(p).unwrap();
  let w = u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize;
  let h = u32::from_le_bytes(b[12..16].try_into().unwrap()) as usize;
  (
    w,
    h,
    b[16..]
      .chunks_exact(4)
      .map(|c| f32::from_le_bytes(c.try_into().unwrap()))
      .collect(),
  )
}

/// Mean absolute difference of display-encoded values after box-downscaling ours to the
/// reference size (a cheap, dependency-free proxy for the ΔE00 reported by raw-compare).
#[test]
fn final_render_close_to_apple() {
  let Some((fx, refs)) = dirs() else {
    eprintln!("skipped: set RAW_DEVELOP_FIXTURES and RAW_DEVELOP_REFS");
    return;
  };
  for raf in fixtures(&fx) {
    let stem = raf.file_stem().unwrap().to_string_lossy().to_string();
    let rp = refs.join(&stem).join("final.q.f32");
    if !rp.exists() {
      continue;
    }
    let (rw, rh, r) = load_f32(&rp);
    let neg = Negative::open(&raf).unwrap();
    let out = develop(&neg, &DevelopSettings::default(), &Options::default())
      .unwrap()
      .image;
    let f = out.width / rw;
    assert_eq!(
      (out.width / f, out.height / f),
      (rw, rh),
      "{stem}: geometry"
    );
    let small = out.downscale(f);
    let mad = small
      .data
      .iter()
      .zip(&r)
      .map(|(a, b)| (a - b).abs() as f64)
      .sum::<f64>()
      / r.len() as f64;
    eprintln!("{stem}: mean |Δ| {mad:.4}");
    assert!(mad < 0.006, "{stem}: mean |Δ| {mad:.4} vs Apple");
  }
}
