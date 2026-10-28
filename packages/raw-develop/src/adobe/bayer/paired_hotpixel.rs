//! Adobe18.7's long-exposure Bayer paired-hot-pixel suppression.
//!
//! `cr_stage_bayer_hot_pixel_pair` first classifies exceptional sensor values
//! against same-colour medians and adjacent-channel residuals, then repairs
//! isolated defects and mutually supported pairs. The source is the unsigned
//! logarithmic mosaic, before the ordinary hot/cold-pixel stage. Classification
//! consumes three pixels of halo; checking neighbouring classifications needs
//! another two. Pixels in the outer five-pixel border are retained unchanged.

use super::tables;

const SAME: [(isize, isize); 8] = [
  (-2, -2),
  (-2, 0),
  (-2, 2),
  (0, -2),
  (0, 2),
  (2, -2),
  (2, 0),
  (2, 2),
];
const ADJACENT: [(isize, isize); 8] = [
  (-1, -1),
  (-1, 0),
  (-1, 1),
  (0, -1),
  (0, 1),
  (1, -1),
  (1, 0),
  (1, 1),
];

pub(super) struct Parameters {
  threshold: Vec<u16>,
}

impl Parameters {
  /// Construct only for exposures of at least two seconds. Adobe lowers both
  /// paired-pixel limits above sixty seconds; these are distinct from the
  /// ordinary suppressor's following 950/950 or 500/500 limits.
  pub(super) fn new(exposure_time: f64) -> Self {
    let (minimum, maximum) = if exposure_time <= 60.0 {
      (1000.0 / 65535.0, 8000.0 / 65535.0)
    } else {
      (100.0 / 65535.0, 800.0 / 65535.0)
    };
    Self {
      threshold: tables::expand(|x| {
        let linear = log_decode(x);
        let encoded = log_encode(linear);
        let down = log_encode(linear * (1.0 / 1.8));
        let up = log_encode(linear * 1.8);
        (((encoded - down) + (up - log_encode(linear))) * 0.5).clamp(minimum, maximum)
      }),
    }
  }
}

const LOG_100: f64 = f64::from_bits(0x4012_6bb1_bbb5_5514);
const INV_LOG_100: f64 = f64::from_bits(0x3fcb_cb7b_1526_e510);

// The threshold function uses the unbounded base LogEncode/LogDecode, rather
// than the signed/black-offset image curves. In particular, multiplying the
// decoded value by1.8 can exceed the image's normalized range.
fn log_encode(x: f64) -> f64 {
  (x.mul_add(0.99, 0.01).ln() + LOG_100) * INV_LOG_100
}

fn log_decode(x: f64) -> f64 {
  (x.mul_add(LOG_100, -LOG_100).exp() - 0.01) * (1.0 / 0.99)
}

pub(super) fn suppress(
  src: &[u16],
  width: usize,
  height: usize,
  top: isize,
  left: isize,
  parameters: &Parameters,
) -> Vec<u16> {
  assert_eq!(src.len(), width * height);
  let mut out = src.to_vec();
  if width <= 10 || height <= 10 {
    return out;
  }
  let mut classes = vec![0u8; src.len()];
  let get = |y: isize, x: isize| src[y as usize * width + x as usize];
  let median = |y: isize, x: isize| {
    let mut values = [0u16; 9];
    values[0] = get(y, x);
    for (i, (dy, dx)) in SAME.into_iter().enumerate() {
      values[i + 1] = get(y + dy, x + dx);
    }
    values.sort_unstable();
    values[4] as i32
  };
  for y in 3..height - 3 {
    for x in 3..width - 3 {
      let (y, x) = (y as isize, x as isize);
      let value = get(y, x) as i32;
      let threshold = parameters.threshold[value as usize] as i32;
      let hot = SAME
        .iter()
        .filter(|&&(dy, dx)| (get(y + dy, x + dx) as i32) < value - threshold)
        .count();
      let class = if threshold < value && hot >= 7 {
        let residual = value - median(y, x);
        let adjacent = ADJACENT
          .iter()
          .filter(|&&(dy, dx)| {
            let neighbor = get(y + dy, x + dx) as i32;
            (neighbor - median(y + dy, x + dx)) * parameters.threshold[neighbor as usize] as i32 * 3
              < residual * threshold
          })
          .count();
        if adjacent >= 7 {
          1 + 2 * u8::from(hot == 7) + u8::from(adjacent == 7)
        } else {
          0
        }
      } else {
        let cold = SAME
          .iter()
          .filter(|&&(dy, dx)| (get(y + dy, x + dx) as i32) > value + threshold)
          .count();
        if cold < 7 {
          0
        } else {
          let residual = value - median(y, x);
          let adjacent = ADJACENT
            .iter()
            .filter(|&&(dy, dx)| {
              let neighbor = get(y + dy, x + dx) as i32;
              (neighbor - median(y + dy, x + dx)) * 2 > residual
            })
            .count();
          if adjacent >= 7 {
            5 + 2 * u8::from(cold == 7) + u8::from(adjacent == 7)
          } else {
            0
          }
        }
      };
      classes[y as usize * width + x as usize] = class;
    }
  }
  let class = |y: isize, x: isize| classes[y as usize * width + x as usize];
  for y in 5..height - 5 {
    for x in 5..width - 5 {
      let (y, x) = (y as isize, x as isize);
      let current = class(y, x);
      let repair = match current {
        1 | 5 => true,
        2..=4 => {
          let supported = ADJACENT
            .iter()
            .filter(|&&(dy, dx)| matches!(class(y + dy, x + dx), 1 | 2))
            .count()
            + SAME
              .iter()
              .filter(|&&(dy, dx)| matches!(class(y + dy, x + dx), 1 | 3))
              .count();
          let ambiguous = ADJACENT
            .iter()
            .chain(SAME.iter())
            .filter(|&&(dy, dx)| class(y + dy, x + dx) == 4)
            .count();
          supported == 1 || supported + ambiguous == 1
        }
        _ => false,
      };
      if repair {
        let offsets = if (top + y + left + x).rem_euclid(2) == 1 {
          [(-1, -1), (-1, 1), (1, -1), (1, 1)]
        } else {
          [(-2, 0), (0, -2), (0, 2), (2, 0)]
        };
        let mut values = offsets.map(|(dy, dx)| get(y + dy, x + dx));
        values.sort_unstable();
        out[y as usize * width + x as usize] =
          ((values[1] as u32 + values[2] as u32 + 1) >> 1) as u16;
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn repairs_adjacent_and_same_channel_hot_pairs() {
    let parameters = Parameters::new(4.0);
    for (dy, dx) in [(0, 1), (1, 0), (1, 1), (0, 2), (2, 0), (2, 2)] {
      let mut src = vec![24000; 21 * 21];
      src[10 * 21 + 10] = 65000;
      src[(10 + dy) * 21 + 10 + dx] = 65000;
      let out = suppress(&src, 21, 21, 0, 0, &parameters);
      assert_eq!(out, vec![24000; 21 * 21], "pair offset({dy},{dx})");
    }
  }

  #[test]
  fn rejects_larger_features_and_retains_the_outer_halo() {
    let parameters = Parameters::new(4.0);
    let mut src = vec![24000; 21 * 21];
    for y in 9..=11 {
      for x in 9..=11 {
        src[y * 21 + x] = 65000;
      }
    }
    src[2 * 21 + 2] = 65000;
    assert_eq!(suppress(&src, 21, 21, 0, 0, &parameters), src);
  }

  #[test]
  fn repairs_isolated_cold_values_and_rounds_the_middle_pair_for_each_cfa_phase() {
    let parameters = Parameters::new(4.0);
    let mut src = vec![24000; 21 * 21];
    src[10 * 21 + 10] = 0;
    assert_eq!(
      suppress(&src, 21, 21, 0, 0, &parameters)[10 * 21 + 10],
      24000
    );
    for top in 0..=1 {
      let mut src = vec![24000; 21 * 21];
      src[10 * 21 + 10] = 65000;
      let offsets = if top == 0 {
        [(-2, 0), (0, -2), (0, 2), (2, 0)]
      } else {
        [(-1, -1), (-1, 1), (1, -1), (1, 1)]
      };
      for ((dy, dx), value) in offsets.into_iter().zip([20000, 20001, 30000, 40000]) {
        src[((10 + dy) * 21 + 10 + dx) as usize] = value;
      }
      assert_eq!(
        suppress(&src, 21, 21, top, 0, &parameters)[10 * 21 + 10],
        25001
      );
    }
  }

  #[test]
  fn long_exposures_use_the_lower_threshold_limits() {
    let normal = Parameters::new(60.0);
    let long = Parameters::new(61.0);
    assert_eq!(normal.threshold[0], 1000);
    assert_eq!(normal.threshold[65535], 8000);
    assert_eq!(long.threshold[0], 100);
    assert_eq!(long.threshold[65535], 800);
  }
}
