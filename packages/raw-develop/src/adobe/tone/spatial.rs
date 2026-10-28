//! Global Process Version 2012 Highlights/Shadows CPU stage.
//!
//! Parameters follow `cr_stage_tone_map::Process_32` (18.7 ARM64,
//! 0x100e4a274); pixel arithmetic follows `SIMDToneMap32_2012_Global`
//! (0x10086d164). The separately reconstructed spatial mask is an input.
//! Local painted adjustments and the older amount-curve implementation use
//! different native kernels and are not substituted here.

use super::{exposure::Info, statistics::Statistics};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Stage {
  flare: f32,
  log_minimum: f32,
  shadows: f32,
  highlights: f32,
  detail: f32,
  pivot: f32,
  correction: f32,
  blend: [[f32; 2]; 2],
  mapping: [[f32; 2]; 2],
  shadow_amount: f32,
  highlight_amount: f32,
  shadow_mask_amount: f32,
  highlight_mask_amount: f32,
  highlight_weight: f32,
  epsilon: f32,
}

impl Stage {
  #[cfg(test)]
  pub(crate) fn parameters(&self) -> [f32; 21] {
    [
      self.flare,
      self.log_minimum,
      self.shadows,
      self.highlights,
      self.detail,
      self.pivot,
      self.correction,
      self.blend[0][0],
      self.blend[0][1],
      self.blend[1][0],
      self.blend[1][1],
      self.mapping[0][0],
      self.mapping[0][1],
      self.mapping[1][0],
      self.mapping[1][1],
      self.shadow_amount,
      self.highlight_amount,
      self.shadow_mask_amount,
      self.highlight_mask_amount,
      self.highlight_weight,
      self.epsilon,
    ]
  }

  /// The two statistics objects are the source and filtered log-mask images.
  /// Controls are the integer -100..100 Shadows2012/Highlights2012 values.
  pub(crate) fn new(
    source: &Statistics,
    filtered: &Statistics,
    info: &Info,
    shadows: i32,
    highlights: i32,
    flare: f64,
    epsilon: f32,
  ) -> Self {
    let mut source = source.clone();
    let mut filtered = filtered.clone();
    // The native transition intentionally leaves selected_mean unchanged.
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
      epsilon,
    )
  }

  fn from_statistics(
    source: [f64; 6],
    filtered: [f64; 6],
    fill: f32,
    recover: f32,
    flare: f64,
    epsilon: f32,
  ) -> Self {
    let pivot = source[0] as f32;
    let low = source[1] as f32;
    let high = source[2] as f32;
    let filtered_low = filtered[1] as f32;
    let filtered_high = filtered[2] as f32;
    let map_low = low - (filtered_low - low);
    let map_high = (filtered_high - high).mul_add(-0.0, high);
    let slope = |x: f32, y: f32| {
      if x == pivot {
        0.0
      } else {
        (y - pivot) / (x - pivot)
      }
    };
    let low_mapping = slope(map_low, filtered_low);
    let high_mapping = slope(map_high, filtered_high);
    let mut low_blend = if low == pivot {
      0.0
    } else {
      -0.5 / (low - pivot)
    };
    let mut high_blend = if high == pivot {
      0.0
    } else {
      -0.5 / (pivot - high)
    };
    let mut low_intercept = (-low_blend).mul_add(low, 0.0);
    let mut high_intercept = (-high_blend).mul_add(pivot, 0.5);
    if low + epsilon >= pivot {
      low_blend = 0.0;
      low_intercept = 0.5;
    }
    if high - epsilon <= pivot {
      high_blend = 0.0;
      high_intercept = 0.5;
    }
    let low_delta = low - filtered_low;
    let high_delta = high - filtered_high;
    let correction = (high_delta - (low_delta + high_delta) * 0.5)
      * ((fill - recover) / fill.abs().max(recover.abs()).max(epsilon))
      * ((source[5].abs() - 0.5)
        .mul_add(0.375, 0.125)
        // Native FMINNM selects .5 for the NaN skew of a constant image.
        .min(0.5)
        .max(0.125) as f32);
    Self {
      flare: flare as f32,
      log_minimum: (flare.ln() / std::f64::consts::LN_2) as f32,
      shadows: fill,
      highlights: -recover,
      detail: 0.0,
      pivot,
      correction,
      blend: [[low_blend, low_intercept], [high_blend, high_intercept]],
      mapping: [
        [low_mapping, (-low_mapping).mul_add(map_low, filtered_low)],
        [
          high_mapping,
          (-high_mapping).mul_add(map_high, filtered_high),
        ],
      ],
      shadow_amount: fill.abs(),
      highlight_amount: recover.abs(),
      shadow_mask_amount: fill.clamp(-1.0, 1.0),
      highlight_mask_amount: recover.clamp(-1.0, 1.0),
      highlight_weight: (1.0 - ((source[3] - source[4]) - 4.0)).clamp(0.0, 1.0) as f32,
      epsilon,
    }
  }

  pub(super) fn local_gray_from_statistics(
    source: [f64; 6],
    filtered: [f64; 6],
    fill: f32,
    recover: f32,
    flare: f64,
    epsilon: f32,
  ) -> Self {
    let mut stage = Self::from_statistics(source, filtered, fill, recover, flare, epsilon);
    let low_delta = source[1] as f32 - filtered[1] as f32;
    let high_delta = source[2] as f32 - filtered[2] as f32;
    let skew = (source[5].abs() - 0.5)
      .mul_add(0.375, 0.125)
      .min(0.5)
      .max(0.125) as f32;
    let base = (high_delta - (low_delta + high_delta) * 0.5) * skew;
    let denominator = fill.abs().max(recover.abs()).max(epsilon);
    let inverse = if denominator == 0.0 {
      0.0
    } else {
      1.0 / denominator
    };
    stage.correction = ((fill - recover) * inverse) * base;
    stage
  }

  fn map_luma(&self, rgb: [f32; 3], mask: f32) -> (f32, f32) {
    let [r, g, b] = rgb;
    // This SIMD kernel rounds each product and addition; unlike the reference
    // scalar kernel, the luma sum does not use fused multiply-add.
    let luma = (r * 0.3 + g * 0.59) + b * 0.110000014;
    let log = (self.flare + luma.clamp(0.0, f32::from_bits(0x7b80_0000))).log2();
    let side = usize::from(log > self.pivot);
    let blend = self.blend[side][0]
      .mul_add(log, self.blend[side][1])
      .clamp(0.0, 1.0);
    let inverse = 1.0 - blend;
    let eighth = |x: f32| {
      let square = x * x;
      let fourth = square * square;
      fourth * fourth
    };
    let inverse_weight = 1.0 - eighth(inverse);
    let blend_weight = 1.0 - eighth(1.0 - inverse);
    let shadow_weight = if self.shadows > 0.0 {
      0.5 + inverse_weight * 0.5
    } else {
      1.0
    };
    let highlight_weight = if self.highlight_weight > 0.0 && self.highlights < 0.0 {
      1.0 + ((0.5 + blend_weight * 0.5) - 1.0) * self.highlight_weight
    } else {
      1.0
    };
    let mapped = self.mapping[side][0].mul_add(log, self.mapping[side][1]);
    let delta = ((mask + log) - mapped) * self.detail;
    let highlight = highlight_weight
      * ((blend * self.correction) * self.highlight_amount
        + mask.min(0.0) * self.highlight_mask_amount);
    let shadow = shadow_weight
      * ((inverse * self.correction) * self.shadow_amount
        + mask.max(0.0) * self.shadow_mask_amount);
    let mut shift =
      blend_weight * delta.min(0.0) + (inverse_weight * delta.max(0.0) + (highlight + shadow));
    let start = shift * -2.0;
    if shift > 0.0 && log > start {
      let denominator = 0.0 - start;
      let inverse = if denominator == 0.0 {
        0.0
      } else {
        1.0 / denominator
      };
      let t = ((log - start) * inverse).clamp(0.0, 1.0);
      let t = t * t;
      shift += (0.0 - shift) * t;
    }
    let start = self.log_minimum - shift * 2.0;
    if shift < 0.0 && log < start {
      let denominator = self.log_minimum - start;
      let inverse = if denominator == 0.0 {
        0.0
      } else {
        1.0 / denominator
      };
      let t = ((log - start) * inverse).clamp(0.0, 1.0);
      let t = t * t;
      shift += (0.0 - shift) * t;
    }
    let output = log + shift;
    let linear = if output <= -120.0 {
      f32::from_bits(0x0380_0000)
    } else {
      output.min(120.0).exp2()
    };
    let linear = (linear - self.flare).max(0.0);
    (luma, linear)
  }

  pub(super) fn gray_pixel(&self, rgb: [f32; 3], mask: f32) -> [f32; 3] {
    [self.map_luma(rgb, mask).1.clamp(0.0, 1.0); 3]
  }

  pub(crate) fn pixel(&self, rgb: [f32; 3], mask: f32) -> [f32; 3] {
    let (luma, linear) = self.map_luma(rgb, mask);
    let denominator = luma.max(self.epsilon);
    let inverse = if denominator == 0.0 {
      0.0
    } else {
      1.0 / denominator
    };
    let scale = inverse * linear;
    rgb.map(|value| (value * scale).max(0.0))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn native_parameters(p: [f32; 28]) -> Stage {
    Stage {
      flare: p[1],
      log_minimum: p[2],
      shadows: p[9],
      highlights: p[10],
      detail: p[11],
      pivot: p[12],
      correction: p[13],
      blend: [[p[14], p[15]], [p[16], p[17]]],
      mapping: [[p[18], p[19]], [p[20], p[21]]],
      shadow_amount: p[22],
      highlight_amount: p[23],
      shadow_mask_amount: p[24],
      highlight_mask_amount: p[25],
      highlight_weight: p[26],
      epsilon: p[27],
    }
  }

  #[test]
  fn zero_mask_and_zero_controls_preserve_luma_with_log_rounding() {
    let stage = Stage::from_statistics(
      [-4.0, -10.0, -1.0, 0.0, -4.0, 0.0],
      [-4.0, -8.0, -2.0, 0.0, -4.0, 0.0],
      0.0,
      0.0,
      1.0 / 4096.0,
      1.0 / 524288.0,
    );
    for rgb in [
      [0.0; 3],
      [0.01, 0.05, 0.1],
      [0.25, 0.5, 1.0],
      [2.0, 1.0, 4.0],
    ] {
      let output = stage.pixel(rgb, 0.0);
      for (a, b) in rgb.into_iter().zip(output) {
        assert!((a - b).abs() <= a.abs().max(1.0) * 0.000001);
      }
    }
  }

  #[test]
  fn uniform_image_has_finite_highlights_and_shadows() {
    let statistics = Statistics::new(&vec![-4.0; 4096], 1.0 / 4096.0).unwrap();
    assert!(statistics.tone()[5].is_nan());
    let stage = Stage::new(
      &statistics,
      &statistics,
      &Info::default(),
      40,
      -50,
      1.0 / 4096.0,
      1.0 / 524288.0,
    );
    assert!(stage.correction.is_finite());
    for value in stage.pixel([0.0625; 3], 0.0) {
      assert!(value.is_finite());
      assert!((value - 0.0625).abs() < 0.000001);
    }
  }

  #[test]
  fn captured_global_kernel() {
    let Some(root) = std::env::var_os("ADOBE_TONE_SPATIAL_CAPTURE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let header: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("global.json")).unwrap()).unwrap();
    let stack = std::fs::read(root.join("global_stack.bin")).unwrap();
    let f = |i: usize| f32::from_le_bytes(stack[24 + i * 4..28 + i * 4].try_into().unwrap());
    let s = &header["s"];
    let stage = native_parameters(std::array::from_fn(|i| {
      if i < 8 {
        s[i].as_f64().unwrap() as f32
      } else {
        f(i - 8)
      }
    }));
    if let (Ok(info), Ok(object)) = (
      std::fs::read(root.join("global_info.bin")),
      std::fs::read(root.join("global_stage.bin")),
    ) {
      let f64_at = |o| f64::from_le_bytes(info[o..o + 8].try_into().unwrap());
      let f32_at = |o| f32::from_le_bytes(info[o..o + 4].try_into().unwrap());
      let statistics = |base: usize| [0x10, 0x68, 0xa0, 0xa8, 0xb0, 0xd0].map(|o| f64_at(base + o));
      let rebuilt = Stage::from_statistics(
        statistics(0x718),
        statistics(0x820),
        f32_at(0x708),
        f32_at(0x70c),
        f64::from_le_bytes(object[0x1f20..0x1f28].try_into().unwrap()),
        f(19),
      );
      let fields = |s: &Stage| {
        [
          s.flare,
          s.log_minimum,
          s.shadows,
          s.highlights,
          s.detail,
          s.pivot,
          s.correction,
          s.blend[0][0],
          s.blend[0][1],
          s.blend[1][0],
          s.blend[1][1],
          s.mapping[0][0],
          s.mapping[0][1],
          s.mapping[1][0],
          s.mapping[1][1],
          s.shadow_amount,
          s.highlight_amount,
          s.shadow_mask_amount,
          s.highlight_mask_amount,
          s.highlight_weight,
          s.epsilon,
        ]
        .map(f32::to_bits)
      };
      assert_eq!(fields(&rebuilt), fields(&stage), "native stage parameters");
    }
    let read = |name: String| -> Vec<f32> {
      std::fs::read(root.join(name))
        .unwrap()
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect()
    };
    let source: [Vec<f32>; 3] = std::array::from_fn(|i| read(format!("global_src{i}.bin")));
    let expected: [Vec<f32>; 3] = std::array::from_fn(|i| read(format!("global_dst{i}.bin")));
    let mask = read("global_mask.bin".into());
    let rows = header["rows"].as_u64().unwrap() as usize;
    let cols = header["cols"].as_u64().unwrap() as usize;
    let stride = header["x"][3].as_u64().unwrap() as usize;
    let mask_stride = header["x"][5].as_u64().unwrap() as usize;
    let mut errors = 0;
    for y in 0..rows {
      for x in 0..cols {
        let offset = y * stride + x;
        let rgb = std::array::from_fn(|i| source[i][offset]);
        let actual = stage.pixel(rgb, mask[y * mask_stride + x]);
        for c in 0..3 {
          if actual[c].to_bits() != expected[c][offset].to_bits() {
            errors += 1;
            if errors < 8 {
              eprintln!(
                "{x},{y} c{c}: {:?} mask {} actual {} expected {}",
                rgb,
                mask[y * mask_stride + x],
                actual[c],
                expected[c][offset]
              );
            }
          }
        }
      }
    }
    assert_eq!(errors, 0, "{} channel values checked", rows * cols * 3);
  }

  #[test]
  fn native_synthetic_controls_and_range_fades() {
    let Some(root) = std::env::var_os("ADOBE_TONE_SPATIAL_SYNTHETIC") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let header: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join("cases.json")).unwrap()).unwrap();
    let read = |name: &str| -> Vec<f32> {
      std::fs::read(root.join(name))
        .unwrap()
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect()
    };
    let source = read("source.rgb.f32");
    let mask = read("mask.f32");
    let pixels = header["pixels"].as_u64().unwrap() as usize;
    let mut errors = 0;
    for (case_index, case) in header["cases"].as_array().unwrap().iter().enumerate() {
      let stage = native_parameters(std::array::from_fn(|i| {
        case["parameters"][i].as_f64().unwrap() as f32
      }));
      let expected = read(case["output"].as_str().unwrap());
      for i in 0..pixels {
        let rgb = source[i * 3..i * 3 + 3].try_into().unwrap();
        let actual = stage.pixel(rgb, mask[i]);
        for c in 0..3 {
          if actual[c].to_bits() != expected[c * pixels + i].to_bits() {
            errors += 1;
            if errors < 8 {
              eprintln!(
                "case {case_index} pixel {i} channel {c}: {} vs {}",
                actual[c],
                expected[c * pixels + i]
              );
            }
          }
        }
      }
    }
    assert_eq!(errors, 0);
  }
}
