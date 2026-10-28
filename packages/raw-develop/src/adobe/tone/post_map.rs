//! Grayscale modern tone-map branch used for post-tone scene measurements.
//!
//! Camera Raw 18.7 sets `cr_stage_tone_map + 0x1eac`, selecting the modern
//! Local kernel with null adjustment masks and grayscale output. The local
//! kernel assembles its correction in a different order from the global one.

use super::{exposure::Info, spatial, statistics::Statistics};

#[derive(Clone, Debug)]
pub(crate) struct Stage(spatial::Stage);

impl Stage {
  /// Post-tone measurement retains H/S and resets the other global controls.
  pub(crate) fn new(
    source: &Statistics,
    filtered: &Statistics,
    info: &Info,
    shadows: i32,
    highlights: i32,
    flare: f64,
  ) -> Self {
    let (mut source, mut filtered) = (source.clone(), filtered.clone());
    if info.input_exposure > 0.0 {
      source.apply_offset(-info.input_exposure);
      filtered.apply_offset(-info.input_exposure);
    }
    Self::from_statistics(
      source.tone(),
      filtered.tone(),
      (f64::from(shadows) * 0.01) as f32,
      (f64::from(highlights) * -0.01) as f32,
      flare,
    )
  }

  pub(super) fn from_statistics(
    source: [f64; 6],
    filtered: [f64; 6],
    fill: f32,
    recover: f32,
    flare: f64,
  ) -> Self {
    let epsilon =
      (flare / 128.0).clamp(f64::from_bits(0x3870_0000_0000_0000), 1.0 / 65536.0) as f32;
    Self(spatial::Stage::local_gray_from_statistics(
      source, filtered, fill, recover, flare, epsilon,
    ))
  }

  pub(crate) fn pixel(&self, rgb: [f32; 3], mask: f32) -> [f32; 3] {
    self.0.gray_pixel(rgb, mask)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn uniform_statistics_and_control_extremes_stay_finite() {
    let statistics = Statistics::new(&[-4.0; 4096], 1.0 / 4096.0).unwrap();
    for shadows in [-100, -50, 0, 50, 100] {
      for highlights in [-100, -50, 0, 50, 100] {
        let stage = Stage::new(
          &statistics,
          &statistics,
          &Info::default(),
          shadows,
          highlights,
          1.0 / 4096.0,
        );
        for value in [0.0, 1.0 / 65535.0, 1.0 / 1024.0, 0.0625, 0.5, 1.0] {
          let output = stage.pixel([value; 3], 0.0);
          assert!(
            output
              .iter()
              .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
          );
        }
      }
    }
  }

  #[test]
  fn captured_modern_grayscale_local_kernel() {
    let Some(root) = std::env::var_os("ADOBE_POST_LOCAL_CAPTURE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let read = |name: &str| std::fs::read(root.join(name)).unwrap();
    let info = read("info.bin");
    let object = read("stage.bin");
    let d = |b: &[u8], o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let f = |o: usize| f32::from_le_bytes(info[o..o + 4].try_into().unwrap());
    let stat = |base: usize| [0x10, 0x68, 0xa0, 0xa8, 0xb0, 0xd0].map(|o| d(&info, base + o));
    let stage = Stage::from_statistics(
      stat(0x718),
      stat(0x820),
      f(0x708),
      f(0x70c),
      d(&object, 0x1f20),
    );
    let header: serde_json::Value = serde_json::from_slice(&read("local.json")).unwrap();
    let floats = |name: &str| {
      read(name)
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect::<Vec<_>>()
    };
    let src: [Vec<f32>; 3] = std::array::from_fn(|i| floats(&format!("local_src{i}.bin")));
    let dst: [Vec<f32>; 3] = std::array::from_fn(|i| floats(&format!("local_dst{i}.bin")));
    let mask = floats("local_mask.bin");
    let rows = header["rows"].as_u64().unwrap() as usize;
    let cols = header["cols"].as_u64().unwrap() as usize;
    let stride = header["x"][3].as_u64().unwrap() as usize;
    let mask_stride = header["x"][5].as_u64().unwrap() as usize;
    for y in 0..rows {
      for x in 0..cols {
        let i = y * stride + x;
        let actual = stage.pixel(
          std::array::from_fn(|c| src[c][i]),
          mask[y * mask_stride + x],
        );
        for c in 0..3 {
          assert_eq!(
            actual[c].to_bits(),
            dst[c][i].to_bits(),
            "post local {y},{x},{c}"
          );
        }
      }
    }
  }
}
