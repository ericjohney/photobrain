//! Adobe 18.7's non-paired Bayer hot/cold-pixel suppression (`BayerHotPixel16V2`).
//!
//! The input is the unsigned 16-bit logarithmically encoded mosaic. An isolated
//! same-colour outlier is clamped to its closest four neighbours only when the
//! other colour samples do not support a real light/dark feature. Reconstructed
//! from the symbolised CPU implementation and checked against both Adobe's scalar
//! and SIMD kernels with synthetic hot/cold pixels as well as a captured tile.

/// Preserve dimensions and leave the two-pixel border untouched. `top` and
/// `left` are absolute coordinates in Adobe's canonical RGGB mosaic: odd parity
/// marks a green site. The caller supplies the halo needed by subsequent stages.
pub(super) fn suppress(
  src: &[u16],
  width: usize,
  height: usize,
  top: isize,
  left: isize,
  hot: u16,
  cold: u16,
) -> Vec<u16> {
  assert_eq!(src.len(), width * height);
  let mut out = src.to_vec();
  if width < 5 || height < 5 {
    return out;
  }
  for y in 2..height - 2 {
    for x in 2..width - 2 {
      let p = y * width + x;
      let at = |dy: isize, dx: isize| -> i32 {
        src[y.wrapping_add_signed(dy) * width + x.wrapping_add_signed(dx)] as i32
      };
      let center = src[p] as i32;
      let green = (top + y as isize + left + x as isize) & 1 != 0;
      let near = if green {
        [at(-1, -1), at(-1, 1), at(1, -1), at(1, 1)]
      } else {
        [at(-2, 0), at(0, -2), at(0, 2), at(2, 0)]
      };
      let far = if green {
        [at(-2, 0), at(0, -2), at(0, 2), at(2, 0)]
      } else {
        [at(-2, -2), at(-2, 2), at(2, -2), at(2, 2)]
      };
      let neighbors = [
        near[0], near[1], near[2], near[3], far[0], far[1], far[2], far[3],
      ];
      let is_hot = neighbors.iter().all(|&v| v < center - hot as i32);
      let is_cold = neighbors.iter().all(|&v| center + (cold as i32) < v);
      if !is_hot && !is_cold {
        continue;
      }
      let mut same = [
        center, near[0], near[1], near[2], near[3], far[0], far[1], far[2], far[3],
      ];
      same.sort_unstable();
      // The two middle samples in each six-sample stencil are averaged with
      // integer rounding; keep the doubled sum to avoid another rounding step.
      let mut vertical = [
        at(-1, 0),
        at(-1, 2),
        at(1, -2),
        at(1, 0),
        at(-1, -2),
        at(1, 2),
      ];
      let mut horizontal = [
        at(0, -1),
        at(2, -1),
        at(-2, 1),
        at(0, 1),
        at(-2, -1),
        at(2, 1),
      ];
      vertical.sort_unstable();
      horizontal.sort_unstable();
      let support =
        ((vertical[2] + vertical[3] + 1) & !1) + ((horizontal[2] + horizontal[3] + 1) & !1);
      let adjacent = at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1);
      let delta = ((center - same[4]) * 3 + 2) >> 2;
      let replace = if is_hot {
        adjacent - support < delta
      } else {
        support - adjacent + delta < 0
      };
      if replace {
        out[p] = if is_hot {
          *near.iter().max().unwrap() as u16
        } else {
          *near.iter().min().unwrap() as u16
        };
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn isolated_hot_and_cold_pixels_match_adobe() {
    // Synthetic probe checked against both RefBayerHotPixel16V2 and its SIMD
    // dispatch in a locally installed Adobe DNG Converter 18.7 process.
    let src = [
      28277, 37407, 17566, 22896, 34656, 15070, 37702, 26821, 28536, 18889, 26697, 32986, 0, 22415,
      23776, 32472, 17436, 22454, 19653, 26340, 26552, 35948, 26374, 26703, 28753,
    ];
    assert_eq!(suppress(&src, 5, 5, 0, 0, 8000, 6000)[12], 17566);
    let mut hot = src;
    hot[12] = 65535;
    assert_eq!(suppress(&hot, 5, 5, 0, 0, 8000, 6000)[12], 26697);
  }

  #[test]
  fn green_sites_use_diagonal_neighbors() {
    let mut src = [30000; 25];
    src[6] = 24000;
    src[8] = 25000;
    src[16] = 26000;
    src[18] = 27000;
    src[12] = 0;
    assert_eq!(suppress(&src, 5, 5, 0, 1, 8000, 6000)[12], 24000);
    src[12] = 65535;
    assert_eq!(suppress(&src, 5, 5, 0, 1, 8000, 6000)[12], 27000);
  }

  #[test]
  fn neighboring_channels_protect_a_real_feature() {
    let mut src = [20000; 25];
    src[12] = 50000;
    // Matching brightness in the immediate red/blue or green cross supports a
    // real feature; the isolated-pixel detector must retain the centre sample.
    for p in [7, 11, 13, 17] {
      src[p] = 50000;
    }
    assert_eq!(suppress(&src, 5, 5, 0, 0, 8000, 6000)[12], 50000);
  }

  #[test]
  fn flat_and_small_inputs_are_preserved() {
    let src = vec![12345; 81];
    assert_eq!(suppress(&src, 9, 9, -2, -2, 8000, 6000), src);
    let small = [1, 2, 3, 4];
    assert_eq!(suppress(&small, 2, 2, 0, 0, 8000, 6000), small);
  }
}
