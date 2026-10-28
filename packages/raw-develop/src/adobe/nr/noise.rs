//! Noise-flattening boundary of Adobe 18.7's `AppendStage_Denoise_CR6`.
//!
//! `cr_denoise_params` takes the selected sensor-noise function, raises its
//! offset to at least scale/3968, and constructs a signed flattening curve.
//! This floor is specific to user NR: the mandatory Bayer green-balancing
//! curve uses the original sensor-noise function.

#[derive(Clone, Copy, Debug)]
pub(crate) struct NoiseCurve {
  scale: f64,
  offset: f64,
  zero: f64,
  normalization: f64,
  linear_black: f64,
  encoded_black: f64,
}

impl NoiseCurve {
  /// `scale` and `offset` describe normalized linear samples, before applying
  /// the user-NR offset floor. The sensor channel must already be selected.
  pub(crate) fn new(scale: f64, offset: f64, linear_black: f64, encoded_black: f64) -> Self {
    let offset = offset.max(scale / 3968.0);
    let root = offset.sqrt();
    let zero = (root + root) / scale;
    let root = (scale + offset).sqrt();
    let normalization = 1.0 / ((root + root) / scale - zero);
    Self {
      scale,
      offset,
      zero,
      normalization,
      linear_black,
      encoded_black,
    }
  }

  pub(crate) fn normalization(&self) -> f64 {
    self.normalization
  }

  /// Linear sample with preserved black -> flattened sensor-noise sample.
  pub(crate) fn encode(&self, input: f64) -> f64 {
    let inverse_range = -1.0 / (self.linear_black - 1.0);
    let value = inverse_range * (input - self.linear_black);
    let root = self.scale.mul_add(value.abs(), self.offset).sqrt();
    let curve = (self.normalization * ((root + root) / self.scale - self.zero)).clamp(0.0, 1.0);
    let curve = if value < 0.0 { -curve } else { curve };
    (1.0 - self.encoded_black)
      .mul_add(curve, self.encoded_black)
      .clamp(0.0, 1.0)
  }

  /// Flattened sensor-noise sample -> linear sample with preserved black.
  pub(crate) fn decode(&self, input: f64) -> f64 {
    let inverse_range = -1.0 / (self.encoded_black - 1.0);
    let value = inverse_range * (input - self.encoded_black);
    let root = self.scale * (self.zero + value.abs() / self.normalization) * 0.5;
    let curve = (root.mul_add(root, -self.offset) / self.scale).clamp(0.0, 1.0);
    let curve = if value < 0.0 { -curve } else { curve };
    (1.0 - self.linear_black)
      .mul_add(curve, self.linear_black)
      .clamp(0.0, 1.0)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn captured_fuji_and_sony_normalizations() {
    for (scale, offset, black, expected) in [
      (
        0.0010465337394732785,
        3.142701793719923e-6,
        4096.0 / 65535.0,
        0.01708573859683354,
      ),
      (
        0.0001878408035872312,
        7.198335928157115e-8,
        2048.0 / 65535.0,
        0.006988212823205891,
      ),
    ] {
      let curve = NoiseCurve::new(scale, offset, black, 0.25);
      assert_eq!(curve.normalization(), expected);
      assert_eq!(curve.encode(black), 0.25);
      assert_eq!(curve.decode(0.25), black);
    }
  }

  #[test]
  fn offset_floor_limits_the_dark_end_curve() {
    let scale = 0.001;
    let curve = NoiseCurve::new(scale, 0.0, 0.0625, 0.25);
    let floored = NoiseCurve::new(scale, scale / 3968.0, 0.0625, 0.25);
    assert_eq!(curve.normalization(), floored.normalization());
    assert_eq!(curve.encode(0.0626), floored.encode(0.0626));
  }
}

/// Sensor-noise channel selected by `NegativeToNoise`, before the CR6 offset
/// floor. The input gain is the reciprocal of the largest quantized camera gain.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SelectedNoise {
  pub(crate) scale: f64,
  pub(crate) offset: f64,
  pub(crate) normalization: f64,
}

pub(crate) fn selected_sensor_noise(model: &str, iso: u32, gain: f64) -> Option<SelectedNoise> {
  let table: &[[f64; 7]] = match model {
    "X-E5" | "X100VI" => &super::super::xtrans::NOISE,
    "ILCE-1M2" => &super::super::bayer::noise::A1M2,
    "ILCE-7CR" | "ILCE-7RM5" => &super::super::bayer::noise::A7R,
    _ => return None,
  };
  let iso = iso as f64;
  let (a, b, ratio, extrapolate) = if iso <= table[0][0] || iso >= table[table.len() - 1][0] {
    let row = if iso <= table[0][0] {
      table[0]
    } else {
      table[table.len() - 1]
    };
    (row, row, if iso == 0.0 { 1.0 } else { iso / row[0] }, true)
  } else {
    let i = (1..table.len()).find(|&i| iso <= table[i][0]).unwrap();
    let (a, b) = (table[i - 1], table[i]);
    (a, b, (iso - a[0]) / (b[0] - a[0]), false)
  };
  let mut best: Option<SelectedNoise> = None;
  for c in 0..3 {
    let (scale, offset) = if extrapolate {
      (a[1 + c] * ratio, a[4 + c] * (ratio * ratio))
    } else {
      let scale = a[1 + c] + (b[1 + c] - a[1 + c]) * ratio;
      let root = a[4 + c].sqrt() + (b[4 + c].sqrt() - a[4 + c].sqrt()) * ratio;
      (scale, root * root)
    };
    let scale = gain * (scale * (1.0 / 65535.0));
    let offset = (offset * (1.0 / (65535.0 * 65535.0))) * gain * gain;
    let root = offset.sqrt();
    let zero = (root + root) / scale;
    let root = (scale + offset).sqrt();
    let normalization = 1.0 / ((root + root) / scale - zero);
    if best.is_none_or(|v| v.normalization < normalization) {
      best = Some(SelectedNoise {
        scale,
        offset,
        normalization,
      });
    }
  }
  best
}

#[cfg(test)]
mod selection_tests {
  use super::*;

  #[test]
  fn selected_regular_render_noise_matches_captures() {
    for (model, iso, gain, scale, offset, normalization) in [
      (
        "X-E5",
        10000,
        0.4738546968995835,
        0.0010465337394732785,
        3.142701793719923e-6,
        0.01708573859683354,
      ),
      (
        "ILCE-7RM5",
        2000,
        0.37128353879622916,
        0.0001878408035872312,
        7.198335928157115e-8,
        0.006988212823205891,
      ),
    ] {
      let actual = selected_sensor_noise(model, iso, gain).unwrap();
      assert_eq!(actual.scale, scale);
      assert_eq!(actual.offset, offset);
      assert_eq!(actual.normalization, normalization);
    }
  }
}
