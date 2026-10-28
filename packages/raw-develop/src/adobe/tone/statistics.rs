//! Log-image statistics used by the modern exposure and tone stages.
//!
//! `cr_image_stats::Build_Optimized` (18.7 ARM64, 0x100a4237c) separates raw
//! percentiles from a second distribution that suppresses near-flare values
//! and repeated bright clipping spikes. Statistics-image construction is a
//! separate upstream operation; this module never estimates it from a final
//! render or substitutes fixture-specific constants.

#[derive(Clone, Debug)]
pub(crate) struct Statistics {
  pub(crate) mean: f64,
  /// Trimmed, range-normalized sRGB mean, returned to log-linear space.
  pub(crate) tone_mean: f64,
  negative_mean: f64,
  /// Min, .01%, .5%, 1%, median, 99%, 99.5%, 99.99%, max.
  raw: [f64; 9],
  /// Min, .01%, .1%, .5%, 1%, 99%, 99.5%, 99.9%, 99.99%, max.
  selected: [f64; 10],
  selected_mean: f64,
  selected_median: f64,
  variance: f64,
  skewness: f64,
  kurtosis: f64,
}

impl Statistics {
  /// Input is the small upstream image after black removal and LinearToLog2.
  /// Negative linear values have already been mapped to the supplied flare.
  pub(crate) fn new(log_image: &[f32], flare: f64) -> Option<Self> {
    if log_image.is_empty()
      || !flare.is_finite()
      || flare <= 0.0
      || log_image.iter().any(|v| !v.is_finite())
    {
      return None;
    }
    let mut sum = 0.0;
    let mut negative_sum = 0.0;
    for &value in log_image {
      sum += f64::from(value);
      negative_sum += f64::from(value.min(0.0));
    }
    let n = log_image.len();
    let mut sorted = log_image.to_vec();
    sorted.sort_unstable_by(f32::total_cmp);
    let raw_at = |fraction: f64, upper: bool| {
      let index = (n - 1) as f64 * fraction;
      let index = if upper { index.ceil() } else { index.floor() };
      f64::from(sorted[(index as usize).min(n - 1)])
    };
    let raw = [
      f64::from(sorted[0]),
      raw_at(0.0001, false),
      raw_at(0.005, false),
      raw_at(0.01, false),
      f64::from(sorted[((n as f64 / 2.0 + 0.5) as usize).min(n - 1)]),
      raw_at(0.99, true),
      raw_at(0.995, true),
      raw_at(0.9999, true),
      f64::from(sorted[n - 1]),
    ];
    let floor = flare.ln() / std::f64::consts::LN_2;
    let cutoff = (raw[5] - 0.5).max((raw[5] - raw[3]).mul_add(0.5, raw[3]));
    let mut values = Vec::new();
    let mut counts: Vec<usize> = Vec::new();
    let mut selected_sum = 0.0;
    let mut previous = -1000.0;
    for value in sorted.into_iter().map(f64::from) {
      if value >= floor + 1.0 && (value != previous || value < cutoff) {
        values.push(value);
        selected_sum += value;
        if value == previous {
          *counts.last_mut().unwrap() += 1;
        } else {
          counts.push(1);
        }
      }
      previous = value;
    }
    if values.is_empty() {
      values.push(floor);
      counts.push(1);
      // The native fallback keeps the empty distribution's zero sum.
    }
    let m = values.len();
    let selected_mean = selected_sum / m as f64;
    let at = |fraction: f64| values[((m as f64 * fraction) as usize).min(m - 1)];
    let selected = [
      values[0],
      at(0.0001),
      at(0.001),
      at(0.005),
      at(0.01),
      at(0.99),
      at(0.995),
      at(0.999),
      at(0.9999),
      values[m - 1],
    ];
    let selected_median = (values[(m - 1) >> 1] + values[m >> 1]) * 0.5;
    let tone_mean = tone_mean(&values, &counts, flare);
    let (mut second, mut third, mut fourth) = (0.0f64, 0.0f64, 0.0f64);
    let mut offset = 0;
    for count in counts {
      let delta = values[offset] - selected_mean;
      let square = delta * delta;
      let cube = delta * square;
      second = (count as f64).mul_add(square, second);
      third = (count as f64).mul_add(cube, third);
      fourth = (count as f64).mul_add(delta * cube, fourth);
      offset += count;
    }
    let inverse = 1.0 / m as f64;
    let variance = inverse * second;
    Some(Self {
      mean: sum / n as f64,
      tone_mean,
      negative_mean: negative_sum / n as f64,
      raw,
      selected,
      selected_mean,
      selected_median,
      variance,
      skewness: (inverse * third) / variance.powf(1.5),
      kurtosis: (inverse * fourth) / (variance * variance) - 3.0,
    })
  }

  /// Key used to bend the Contrast2012 curve around the scene's brightness.
  pub(crate) fn key(&self) -> f64 {
    let low = self.selected[1];
    let high = self.selected[8];
    if low < high {
      (0.18 * (2.0 * ((2.0 * self.mean - low - high) / (high - low))).exp2()).clamp(0.01125, 2.88)
    } else {
      0.18
    }
  }

  pub(crate) fn exposure(&self) -> super::exposure::Statistics {
    super::exposure::Statistics {
      black_reference: self.selected[1],
      whites_low: self.selected[4],
      whites_high: self.selected[5],
      highlight_reference: self.selected[8],
    }
  }

  /// Tone-map pivot, selected low/high/maximum, selected mean, and skewness.
  pub(crate) fn tone(&self) -> [f64; 6] {
    [
      self.tone_mean,
      self.selected[1],
      self.selected[8],
      self.selected[9],
      self.selected_mean,
      self.skewness,
    ]
  }

  /// Local Laplacian's low/high range and selected median (+0xb8).
  pub(crate) fn laplacian_range(&self) -> [f64; 3] {
    [self.selected[1], self.selected[8], self.selected_median]
  }

  /// Native ApplyOffset changes location/percentile fields through +0xa8.
  /// The negative mean and higher distribution moments remain untouched.
  pub(crate) fn apply_offset(&mut self, offset: f64) {
    self.mean = offset + self.mean;
    self.tone_mean = offset + self.tone_mean;
    for value in self.raw.iter_mut().chain(self.selected.iter_mut()) {
      *value = offset + *value;
    }
  }

  #[cfg(test)]
  fn fields(&self) -> [f64; 28] {
    let mut fields = [0.0; 28];
    fields[0] = self.mean;
    fields[1] = self.negative_mean;
    fields[2] = self.tone_mean;
    fields[3..12].copy_from_slice(&self.raw);
    fields[12..22].copy_from_slice(&self.selected);
    fields[22] = self.selected_mean;
    fields[23] = self.selected_median;
    fields[24] = self.variance.sqrt();
    fields[25] = self.variance;
    fields[26] = self.skewness;
    fields[27] = self.kurtosis;
    fields
  }
}

fn tone_mean(values: &[f64], counts: &[usize], flare: f64) -> f64 {
  let n = values.len();
  let lower = ((n as f64 * 0.0001) as usize).min(n - 1);
  let upper = ((n as f64 * 0.9999) as usize).min(n - 1);
  let linear = |v: f64| (v.clamp(-120.0, 120.0).exp2() - flare).max(0.0);
  let mut groups = Vec::with_capacity(counts.len());
  let mut offset = 0;
  for &count in counts {
    groups.push((offset, count, linear(values[offset])));
    offset += count;
  }
  let low = groups
    .iter()
    .position(|(start, count, _)| lower < start + count)
    .unwrap();
  let high = groups
    .iter()
    .position(|(start, count, _)| upper < start + count)
    .unwrap();
  let minimum = groups[low].2;
  let maximum = groups[high].2;
  let inverse = if minimum == maximum {
    0.0
  } else {
    -1.0 / (minimum - maximum)
  };
  let mut sum = if low == high {
    0.0
  } else {
    (upper - groups[high].0 + 1) as f64
  };
  for &(_, count, value) in &groups[low + 1..high.max(low + 1)] {
    let x = (value - minimum).mul_add(inverse, 0.0).clamp(0.0, 1.0);
    sum = (count as f64).mul_add(super::curves::srgb_encode(x), sum);
  }
  let mean = super::curves::srgb_decode(sum / (upper - lower + 1) as f64);
  let value = (maximum - minimum)
    .mul_add(mean, minimum)
    .clamp(0.0, f64::from_bits(0x4770_0000_0000_0000));
  (flare + value).log2()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn invalid_and_constant_images() {
    assert!(Statistics::new(&[], 1.0 / 4096.0).is_none());
    assert!(Statistics::new(&[f32::NAN], 1.0 / 4096.0).is_none());
    let constant = Statistics::new(&[-4.0; 31], 1.0 / 4096.0).unwrap();
    assert_eq!(constant.key(), 0.18);
    assert_eq!(constant.mean, -4.0);
    assert_eq!(constant.exposure().highlight_reference, -4.0);
  }

  #[test]
  fn captured_small_image_statistics() {
    let Some(paths) = std::env::var_os("ADOBE_STATS_CAPTURES") else {
      return;
    };
    let mut checked = 0;
    for root in std::env::split_paths(&paths) {
      for entry in std::fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy();
        let Some(stem) = name.strip_suffix(".sorted.f32") else {
          continue;
        };
        let meta: serde_json::Value =
          serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap())
            .unwrap();
        let input: Vec<f32> = std::fs::read(&path)
          .unwrap()
          .chunks_exact(4)
          .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
          .collect();
        let result = std::fs::read(root.join(format!("{stem}.result.f64"))).unwrap();
        let stats = Statistics::new(&input, meta["d0"].as_f64().unwrap()).unwrap();
        for (i, actual) in stats.fields().into_iter().enumerate() {
          let expected = f64::from_le_bytes(result[i * 8..i * 8 + 8].try_into().unwrap());
          if expected.is_nan() {
            assert!(actual.is_nan());
          } else if i <= 1 {
            // The retained input is sorted after the native render accumulated
            // these two means in raster order. Tiny near-zero log values can
            // make that order visible in the final few double-precision bits.
            assert!(
              (actual - expected).abs() <= expected.abs().max(1.0) * f64::EPSILON * 32.0,
              "{stem} mean field {i}: {actual} vs {expected}"
            );
          } else {
            assert_eq!(
              actual.to_bits(),
              expected.to_bits(),
              "{stem} field {:#x}",
              i * 8
            );
          }
        }
        checked += 1;
      }
    }
    assert!(checked > 0);
  }
}
