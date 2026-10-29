//! Exact nine-sample order statistics shared by the cleanup and NR stages.

/// A fixed compare/exchange selection network. Only the middle order statistic
/// is needed; fully sorting the other eight samples adds data-dependent work.
#[inline]
pub(super) fn median9<T: Ord + Copy>(mut p: [T; 9]) -> T {
  #[inline]
  fn order<T: Ord + Copy>(p: &mut [T; 9], a: usize, b: usize) {
    let low = p[a].min(p[b]);
    let high = p[a].max(p[b]);
    p[a] = low;
    p[b] = high;
  }
  for (a, b) in [
    (1, 2),
    (4, 5),
    (7, 8),
    (0, 1),
    (3, 4),
    (6, 7),
    (1, 2),
    (4, 5),
    (7, 8),
    (0, 3),
    (5, 8),
    (4, 7),
    (3, 6),
    (1, 4),
    (2, 5),
    (4, 7),
    (4, 2),
    (6, 4),
    (4, 2),
  ] {
    order(&mut p, a, b);
  }
  p[4]
}

/// Preserve `total_cmp`'s signed-zero ordering and the cleanup's canonical NaN
/// result for any nonfinite neighbourhood. No float arithmetic is introduced.
#[inline]
pub(super) fn finite_median9(p: [f32; 9]) -> f32 {
  if !p.into_iter().all(f32::is_finite) {
    return f32::NAN;
  }
  let key = |v: i32| v ^ (((v >> 31) as u32 >> 1) as i32);
  let median = median9(p.map(|v| key(v.to_bits() as i32)));
  f32::from_bits(key(median) as u32)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn selection_matches_every_permutation_and_binary_neighbourhood() {
    let mut values = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    loop {
      assert_eq!(median9(values), 4);
      let Some(i) = (0..8).rev().find(|&i| values[i] < values[i + 1]) else {
        break;
      };
      let j = (i + 1..9).rev().find(|&j| values[i] < values[j]).unwrap();
      values.swap(i, j);
      values[i + 1..].reverse();
    }
    for mask in 0..512 {
      let values = std::array::from_fn(|i| ((mask >> i) & 1) as i16);
      let mut sorted = values;
      sorted.sort_unstable();
      assert_eq!(median9(values), sorted[4]);
    }
  }

  #[test]
  fn float_selection_matches_original_bits() {
    let mut seed = 17u32;
    for sample in 0..20000 {
      let mut values = std::array::from_fn(|i| {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        match sample % 7 {
          0 => {
            if i % 2 == 0 {
              -0.0
            } else {
              0.0
            }
          }
          1 => f32::from_bits(seed & 0x807f_ffff),
          2 => f32::from_bits(seed),
          _ => (seed as i32 as f32) * (1.0 / 65536.0),
        }
      });
      let actual = finite_median9(values);
      values.sort_unstable_by(f32::total_cmp);
      let expected = if values.into_iter().all(f32::is_finite) {
        values[4]
      } else {
        f32::NAN
      };
      assert_eq!(actual.to_bits(), expected.to_bits(), "sample {sample}");
      let integers = values.map(|v| v.to_bits() as i16);
      let mut sorted = integers;
      sorted.sort_unstable();
      assert_eq!(median9(integers), sorted[4]);
    }
  }
}
