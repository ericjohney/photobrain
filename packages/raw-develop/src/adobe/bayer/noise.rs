//! Adobe 18.7 noise-flattening curve used by the additional high-ISO green
//! balancing pass. Calibration was read from the installed converter's selected
//! sensor-noise tables; it is independent of the user noise-reduction sliders.

#[derive(Clone, Copy, Debug)]
pub(super) struct Noise {
  scale: f64,
  offset: f64,
  zero: f64,
  normalization: f64,
  black: f64,
  encoded_black: f64,
}

impl Noise {
  pub(super) fn new(model: &str, iso: u32, black: f64) -> Option<Self> {
    let table: &[[f64; 7]] = match model {
      "ILCE-1M2" => &A1M2,
      "ILCE-7CR" | "ILCE-7RM5" => &A7R,
      _ => return None,
    };
    let (scale, offset) = interpolate_noise(table, iso);
    let score = |k: usize| {
      1.0 / ((2.0 * (scale[k] + offset[k]).sqrt()) / scale[k] - (2.0 * offset[k].sqrt()) / scale[k])
    };
    let mut channel = 0;
    for k in 1..3 {
      if score(channel) < score(k) {
        channel = k;
      }
    }
    let scale = scale[channel];
    let offset = offset[channel];
    let root = offset.sqrt();
    let zero = (root + root) / scale;
    let root = (scale + offset).sqrt();
    let normalization = 1.0 / ((root + root) / scale - zero);
    Some(Self {
      scale,
      offset,
      zero,
      normalization,
      black,
      encoded_black: if black > 0.0 { 0.25 } else { 0.0 },
    })
  }

  pub(super) fn normalization(&self) -> f64 {
    self.normalization
  }

  /// Raw linear sample with preserved black -> flattened-noise sample.
  pub(super) fn encode(&self, input: f64) -> f64 {
    let inverse_range = -1.0 / (self.black - 1.0);
    let value = inverse_range * (input - self.black);
    let root = self.scale.mul_add(value.abs(), self.offset).sqrt();
    let curve = (self.normalization * ((root + root) / self.scale - self.zero)).clamp(0.0, 1.0);
    let curve = if value < 0.0 { -curve } else { curve };
    (1.0 - self.encoded_black)
      .mul_add(curve, self.encoded_black)
      .clamp(0.0, 1.0)
  }

  /// Flattened-noise sample -> raw linear sample with preserved black.
  pub(super) fn decode(&self, input: f64) -> f64 {
    let inverse_range = -1.0 / (self.encoded_black - 1.0);
    let value = inverse_range * (input - self.encoded_black);
    let root = self.scale * (self.zero + value.abs() / self.normalization) * 0.5;
    let curve = (root.mul_add(root, -self.offset) / self.scale).clamp(0.0, 1.0);
    let curve = if value < 0.0 { -curve } else { curve };
    (1.0 - self.black)
      .mul_add(curve, self.black)
      .clamp(0.0, 1.0)
  }
}

fn interpolate_noise(table: &[[f64; 7]], iso: u32) -> ([f64; 3], [f64; 3]) {
  let iso = iso as f64;
  let mut scale = [0.0; 3];
  let mut offset = [0.0; 3];
  if iso <= table[0][0] || iso >= table[table.len() - 1][0] {
    let row = if iso <= table[0][0] {
      table[0]
    } else {
      table[table.len() - 1]
    };
    let ratio = if iso == 0.0 { 1.0 } else { iso / row[0] };
    for k in 0..3 {
      scale[k] = row[1 + k] * ratio;
      offset[k] = row[4 + k] * (ratio * ratio);
    }
  } else {
    let i = (1..table.len()).find(|&i| iso <= table[i][0]).unwrap();
    let a = table[i - 1];
    let b = table[i];
    let ratio = (iso - a[0]) / (b[0] - a[0]);
    for k in 0..3 {
      scale[k] = a[1 + k] + (b[1 + k] - a[1 + k]) * ratio;
      let root = a[4 + k].sqrt() + (b[4 + k].sqrt() - a[4 + k].sqrt()) * ratio;
      offset[k] = root * root;
    }
  }
  for k in 0..3 {
    scale[k] *= 1.0 / 65535.0;
    offset[k] *= 1.0 / (65535.0 * 65535.0);
  }
  (scale, offset)
}

// ISO, scale R/G/B, offset R/G/B; Adobe's 16-bit calibration units.
pub(crate) const A1M2: [[f64; 7]; 17] = [
  [50.0, 1.9499, 3.9562, 3.2655, 46.55, 47.85, 43.65],
  [64.0, 3.0039, 7.3969, 4.944, 68.27, 72.28, 62.44],
  [80.0, 2.3214, 2.4949, 2.2827, 112.66, 115.52, 102.51],
  [100.0, 1.916, 3.5812, 2.5881, 48.32, 49.17, 43.71],
  [200.0, 3.7562, 6.2427, 4.3816, 208.93, 220.09, 186.64],
  [400.0, 7.1144, 9.7059, 7.3733, 807.66, 813.19, 747.53],
  [800.0, 13.5457, 16.0391, 13.2537, 189.21, 184.92, 165.68],
  [1600.0, 26.4046, 29.2459, 24.8331, 820.05, 815.29, 733.14],
  [3200.0, 50.8517, 53.5775, 46.6703, 3183.59, 3044.46, 2765.71],
  [
    6400.0, 97.8163, 100.8449, 88.1608, 11965.57, 11111.26, 10683.11,
  ],
  [
    12800.0, 183.4678, 199.3607, 168.5696, 50475.38, 46951.79, 41608.74,
  ],
  [
    25600.0, 248.2112, 263.4951, 214.8506, 137489.74, 133115.97, 123698.82,
  ],
  [
    40000.0, 387.7318, 404.018, 338.7284, 320009.69, 316640.37, 293072.08,
  ],
  [
    51200.0, 480.5545, 500.5735, 427.0927, 482523.48, 467406.31, 433693.84,
  ],
  [
    64000.0, 611.2293, 618.4722, 529.2864, 739921.0, 716419.32, 663116.67,
  ],
  [
    80000.0, 739.4755, 769.0315, 678.9869, 1073702.79, 1060486.23, 951047.92,
  ],
  [
    102400.0, 800.4287, 853.2186, 760.4193, 1820240.1, 1778718.91, 1603796.04,
  ],
];

pub(crate) const A7R: [[f64; 7]; 17] = [
  [50.0, 1.8066, 1.7005, 1.5828, 40.17, 36.82, 35.78],
  [64.0, 2.5515, 2.3825, 2.0638, 57.43, 57.55, 53.14],
  [80.0, 2.7628, 2.6288, 2.5199, 96.07, 99.54, 89.94],
  [100.0, 1.7208, 1.736, 1.4571, 38.62, 38.25, 36.44],
  [200.0, 3.5774, 3.5553, 2.9848, 137.08, 128.32, 128.48],
  [400.0, 6.6495, 6.7405, 5.734, 95.55, 102.28, 99.33],
  [800.0, 13.3335, 13.3988, 11.4014, 356.26, 393.89, 329.62],
  [1600.0, 26.561, 26.1736, 22.803, 1487.08, 1488.67, 1330.95],
  [3200.0, 52.9396, 52.143, 45.7011, 5437.55, 5273.55, 5003.52],
  [
    6400.0, 104.3232, 104.2851, 92.486, 18611.97, 21097.76, 18331.22,
  ],
  [
    12800.0, 210.6189, 208.1163, 187.8251, 70732.22, 71951.2, 65910.81,
  ],
  [
    25600.0, 286.1764, 285.1997, 240.1994, 127208.08, 132471.08, 122790.36,
  ],
  [
    40000.0, 454.1296, 455.5755, 390.0539, 295359.02, 306390.71, 299184.38,
  ],
  [
    51200.0, 576.6208, 573.2045, 497.7903, 453307.16, 471155.82, 429961.79,
  ],
  [
    64000.0, 744.4408, 745.4285, 638.352, 681631.16, 722603.68, 674723.24,
  ],
  [
    80000.0, 929.1286, 926.4139, 814.3947, 1015085.47, 1101781.5, 1014014.17,
  ],
  [
    102400.0, 1065.9832, 1072.8395, 941.0365, 1805967.37, 1864643.55, 1715182.25,
  ],
];

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn selected_high_iso_normalization_matches_capture() {
    let noise = Noise::new("ILCE-7CR", 12800, 2048.0 / 65535.0).unwrap();
    assert_eq!(noise.normalization(), 0.030447006106426048);
    assert!(noise.normalization() * 65535.0 > 1000.0);
    let noise = Noise::new("ILCE-7RM5", 2000, 2048.0 / 65535.0).unwrap();
    assert!(noise.normalization() * 65535.0 < 1000.0);
  }

  #[test]
  fn flatten_curve_preserves_black_and_round_trips() {
    let black = 2048.0 / 65535.0;
    let noise = Noise::new("ILCE-7CR", 12800, black).unwrap();
    assert_eq!(noise.encode(black), 0.25);
    assert_eq!(noise.decode(0.25), black);
    for i in 0..=1000 {
      let sample = black + (1.0 - black) * (i as f64 / 1000.0);
      assert!((noise.decode(noise.encode(sample)) - sample).abs() < 1e-12);
    }
  }
}
