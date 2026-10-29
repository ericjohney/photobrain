//! Two-level CR6 chroma-only CPU filter, after noise flattening and optimized YCC.
//!
//! Recovered from Adobe DNG Converter 18.7's `cr_stage_denoise::Process`,
//! `RefLpHighPass16`, and the runtime-selected SIMD cross-box helpers. Integer
//! boundaries and FMA association are part of the algorithm. This is not the
//! four-level luminance path.

/// Parameters at the spatial stage boundary. The colour/noise-dependent builder
/// is separate; these are the already-derived coefficients, not UI slider values.
pub(crate) struct Parameters {
  pub(crate) radius: usize,
  pub(crate) difference: [f32; 3],
  pub(crate) spatial: f32,
  pub(crate) detail: f32,
  pub(super) rank: usize,
  pub(super) shrink: [Vec<i16>; 2],
}

impl Parameters {
  pub(crate) fn new(
    radius: usize,
    difference: [f32; 3],
    spatial: f32,
    detail: f32,
    high_pass: [f64; 2],
  ) -> Self {
    Self::with_rank(radius, difference, spatial, detail, high_pass, 1024)
  }

  pub(crate) fn with_rank(
    radius: usize,
    difference: [f32; 3],
    spatial: f32,
    detail: f32,
    high_pass: [f64; 2],
    rank: usize,
  ) -> Self {
    assert!(radius < 64);
    assert!((256..=1024).contains(&rank));
    Self {
      radius,
      difference,
      spatial,
      detail,
      rank,
      shrink: high_pass.map(|coefficient| {
        (-32768..=32767)
          .map(|value| {
            let x = value as f64;
            let gain = (1.0 - (x * x * coefficient).exp()).clamp(0.0, 1.0);
            (x * gain).round() as i16
          })
          .collect()
      }),
    }
  }

  /// Safe tile padding for both cross-box passes and pyramid reconstruction.
  pub(crate) fn halo(&self) -> usize {
    2 * self.radius + 8
  }
}

const LP: [u32; 5] = [819, 4096, 6554, 4096, 819];

#[inline]
fn blur5(values: [u16; 5]) -> u16 {
  ((values
    .into_iter()
    .zip(LP)
    .map(|(v, weight)| v as u32 * weight)
    .sum::<u32>()
    + 8192)
    >> 14) as u16
}

fn low_pass(src: &[[u16; 3]], width: usize, height: usize) -> (Vec<[u16; 3]>, usize, usize) {
  let w = (width - 3) / 2;
  let h = (height - 3) / 2;
  // The vertical pass samples only horizontal positions 2*x+2. Compute and
  // retain those columns directly, keeping both five-tap integer roundings.
  let mut across = vec![[0; 3]; w * height];
  for y in 0..height {
    for x in 0..w {
      across[y * w + x] =
        std::array::from_fn(|c| blur5(std::array::from_fn(|i| src[y * width + 2 * x + i][c])));
    }
  }
  let mut output = vec![[0; 3]; w * h];
  for y in 0..h {
    for x in 0..w {
      output[y * w + x] =
        std::array::from_fn(|c| blur5(std::array::from_fn(|i| across[(2 * y + i) * w + x][c])));
    }
  }
  (output, w, h)
}

#[cfg(test)]
mod low_pass_tests {
  use super::*;

  #[test]
  fn compact_horizontal_columns_match_full_width_reference() {
    // Cross both odd/even dimensions and the smallest five-tap support. Use
    // full-range, constant and alternating extrema to exercise both roundings.
    for width in [5, 6, 7, 16, 17, 63, 64, 65, 225, 226] {
      for height in [5, 6, 7, 16, 17, 65, 66] {
        for pattern in 0..3 {
          let source: Vec<[u16; 3]> = (0..width * height)
            .map(|i| {
              std::array::from_fn(|c| match pattern {
                0 => ((i * 1297 + c * 7919) % 65536) as u16,
                1 => [0, 32768, 65535][c],
                _ => {
                  if (i + c) % 2 == 0 {
                    0
                  } else {
                    65535
                  }
                }
              })
            })
            .collect();
          let mut across = vec![[0; 3]; width * height];
          for y in 0..height {
            for x in 2..width - 2 {
              across[y * width + x] = std::array::from_fn(|c| {
                blur5(std::array::from_fn(|i| source[y * width + x + i - 2][c]))
              });
            }
          }
          let (actual, w, h) = low_pass(&source, width, height);
          let mut expected = vec![[0; 3]; w * h];
          for y in 0..h {
            for x in 0..w {
              expected[y * w + x] = std::array::from_fn(|c| {
                blur5(std::array::from_fn(|i| {
                  across[(2 * y + i) * width + 2 * x + 2][c]
                }))
              });
            }
          }
          assert_eq!(actual, expected, "{width}x{height}, pattern {pattern}");
        }
      }
    }
  }
}

/// The highpass predictor rounds one parity-specific 3x3 interpolation, whereas
/// reconstruction rounds two separable blurs. Substituting one for the other
/// changes the integer detail residual.
#[inline]
fn prediction(lp: &[[u16; 3]], width: usize, y: usize, x: usize, c: usize) -> i32 {
  let cy = (y - 2) / 2;
  let cx = (x - 2) / 2;
  let get = |dy: isize, dx: isize| -> u32 {
    lp[cy.wrapping_add_signed(dy) * width + cx.wrapping_add_signed(dx)][c] as u32
  };
  let value = match (y & 1, x & 1) {
    (0, 0) => {
      (get(0, 0) * 10484
        + (get(-1, 0) + get(1, 0) + get(0, -1) + get(0, 1)) * 1311
        + (get(-1, -1) + get(-1, 1) + get(1, -1) + get(1, 1)) * 164
        + 8192)
        >> 14
    }
    (0, 1) => {
      ((get(0, 0) + get(0, 1)) * 6554
        + (get(-1, 0) + get(-1, 1) + get(1, 0) + get(1, 1)) * 819
        + 8192)
        >> 14
    }
    (1, 0) => {
      ((get(0, 0) + get(1, 0)) * 6554
        + (get(0, -1) + get(1, -1) + get(0, 1) + get(1, 1)) * 819
        + 8192)
        >> 14
    }
    _ => (get(0, 0) + get(0, 1) + get(1, 0) + get(1, 1) + 2) >> 2,
  };
  value as i32
}

#[inline]
fn weight(center: [f32; 3], sample: [f32; 3], difference: [f32; 3], mix: f32) -> f32 {
  let d = std::array::from_fn::<_, 3, _>(|c| sample[c] - center[c]);
  let terms = std::array::from_fn::<_, 3, _>(|c| (d[c] * d[c]) * difference[c]);
  let distance = terms[0] + (terms[1] + terms[2]);
  let q = 0.2_f32.mul_add(distance * mix, 1.0);
  (q * (q * q)).clamp(0.0, 1.0)
}

fn cross_box(lp: &[[u16; 3]], width: usize, height: usize, params: &Parameters) -> Vec<[u16; 2]> {
  let input: Vec<[f32; 3]> = lp
    .iter()
    .map(|v| v.map(|v| v as f32 * (1.0_f32 / 65535.0)))
    .collect();
  let radius = params.radius;
  let mix: Vec<f32> = (-(radius as isize)..=radius as isize)
    .map(|d| {
      let spatial = (d * d) as f32 * params.spatial;
      (1.0 - spatial).mul_add(params.detail, spatial)
    })
    .collect();
  let mut across = vec![[0.0; 3]; input.len()];
  for y in 0..height {
    for x in radius..width - radius {
      let mut total = 0.0;
      let mut sum = [0.0; 2];
      for (i, &mix) in mix.iter().enumerate() {
        let sample = input[y * width + x + i - radius];
        let w = weight(input[y * width + x], sample, params.difference, mix);
        for c in 0..2 {
          sum[c] = w.mul_add(sample[c + 1], sum[c]);
        }
        total += w;
      }
      let inverse = if total == 0.0 { 0.0 } else { 1.0 / total };
      across[y * width + x] = [input[y * width + x][0], sum[0] * inverse, sum[1] * inverse];
    }
  }
  let mut output = vec![[0; 2]; input.len()];
  for y in radius..height - radius {
    for x in radius..width - radius {
      let mut total = 0.0;
      let mut sum = [0.0; 2];
      for (i, &mix) in mix.iter().enumerate() {
        let sample = across[(y + i - radius) * width + x];
        let w = weight(across[y * width + x], sample, params.difference, mix);
        for c in 0..2 {
          sum[c] = w.mul_add(sample[c + 1], sum[c]);
        }
        total += w;
      }
      let inverse = if total == 0.0 { 0.0 } else { 1.0 / total };
      output[y * width + x] = sum.map(|v| {
        ((v * inverse) * 65535.0)
          .round_ties_even()
          .clamp(0.0, 65535.0) as u16
      });
    }
  }
  output
}

/// One row of the original sparse expansion followed by its horizontal blur.
/// The caller's halo keeps all contributing low-pass samples inside the
/// cross-box output. Odd expansion rows are zero; even rows have samples only
/// at even columns, anchored at (2, 2). Keep the horizontal u16 rounding before
/// the separately rounded vertical blur.
fn reconstruction_row(
  filtered: &[[u16; 2]],
  width: usize,
  y: usize,
  left: usize,
  row: &mut [[u16; 2]],
) {
  if y & 1 != 0 {
    row.fill([0; 2]);
    return;
  }
  let source = &filtered[((y - 2) / 2) * width..((y - 2) / 2 + 1) * width];
  for (i, out) in row.iter_mut().enumerate() {
    let x = left + i;
    let center = (x - 2) / 2;
    *out = std::array::from_fn(|c| {
      if x & 1 == 0 {
        blur5([
          source[center - 1][c],
          0,
          source[center][c],
          0,
          source[center + 1][c],
        ])
      } else {
        blur5([0, source[center][c], 0, source[center + 1][c], 0])
      }
    });
  }
}

#[cfg(test)]
mod reconstruction_tests {
  use super::*;

  #[test]
  fn rolling_rows_match_sparse_expansion_and_both_integer_roundings() {
    for radius in [0, 1, 2, 7, 63] {
      for (ow, oh) in [(1, 1), (2, 3), (13, 17), (192, 191), (384, 384)] {
        for parity in 0..4 {
          let required = 2 * radius + 6;
          let (top, left) = (required + (parity & 1), required + (parity >> 1));
          let (bottom, right) = (top + oh, left + ow);
          let (width, height) = (right + required, bottom + required);
          let (lw, lh) = ((width - 3) / 2, (height - 3) / 2);
          for pattern in 0..3 {
            let filtered: Vec<[u16; 2]> = (0..lw * lh)
              .map(|i| {
                std::array::from_fn(|c| match pattern {
                  0 => ((i * 1297 + c * 7919) % 65536) as u16,
                  1 => [0, 65535][c],
                  _ => {
                    if (i + c) % 2 == 0 {
                      0
                    } else {
                      65535
                    }
                  }
                })
              })
              .collect();
            // Original materialized expansion and horizontal intermediate.
            let mut expanded = vec![[0; 2]; width * height];
            for y in radius..lh - radius {
              for x in radius..lw - radius {
                expanded[(2 * y + 2) * width + 2 * x + 2] = filtered[y * lw + x];
              }
            }
            let mut across = vec![[0; 2]; width * height];
            for y in top - 2..bottom + 2 {
              for x in left..right {
                across[y * width + x] = std::array::from_fn(|c| {
                  blur5(std::array::from_fn(|i| expanded[y * width + x + i - 2][c]))
                });
              }
            }
            let mut ring = vec![[0; 2]; 5 * ow];
            for y in top - 2..bottom + 2 {
              let row = &mut ring[y % 5 * ow..(y % 5 + 1) * ow];
              reconstruction_row(&filtered, lw, y, left, row);
              assert_eq!(row, &across[y * width + left..y * width + right]);
              if y < top + 2 {
                continue;
              }
              let cy = y - 2;
              for x in left..right {
                for c in 0..2 {
                  assert_eq!(
                    blur5(std::array::from_fn(
                      |i| ring[(cy + i - 2) % 5 * ow + x - left][c]
                    )),
                    blur5(std::array::from_fn(|i| across[(cy + i - 2) * width + x][c])),
                    "radius {radius}, {ow}x{oh}, parity {parity}, pattern {pattern}, ({cy},{x},{c})"
                  );
                }
              }
            }
          }
        }
      }
    }
  }
}

/// Filter one padded tile of unsigned, normalized 16-bit Y/Cb/Cr codes.
///
/// `output` is [top,left,bottom,right], relative to the source tile. The LP
/// lattice is anchored at source (2,2); callers must keep the source origin on
/// Adobe's even lattice and supply `halo()` padding. Luma is copied unchanged.
/// Returns only the requested output rectangle, in interleaved row-major order.
pub(crate) fn filter_tile(
  src: &[[u16; 3]],
  width: usize,
  height: usize,
  output: [usize; 4],
  params: &Parameters,
) -> Vec<[u16; 3]> {
  assert_eq!(src.len(), width * height);
  let [top, left, bottom, right] = output;
  assert!(top < bottom && left < right);
  // `halo()` includes two pixels for parity-independent caller tiling. Adobe's
  // own even-lattice rectangles can have two fewer at the trailing edges.
  let required = params.halo() - 2;
  assert!(
    top >= required && left >= required && bottom + required <= height && right + required <= width
  );
  let (lp, lp_width, lp_height) = low_pass(src, width, height);
  let filtered = cross_box(&lp, lp_width, lp_height, params);
  // Stream the horizontal blur through five output-width rows, replacing the
  // full padded sparse expansion and horizontal intermediate. Row y+2 is the
  // newest input needed by output y; modulo-five slots are never overwritten
  // until their last vertical use.
  let output_width = right - left;
  let mut across = vec![[0; 2]; 5 * output_width];
  for y in top - 2..top + 2 {
    reconstruction_row(
      &filtered,
      lp_width,
      y,
      left,
      &mut across[(y % 5) * output_width..(y % 5 + 1) * output_width],
    );
  }
  // The detail rank filter needs a one-pixel border around the output rectangle.
  let hp_width = right - left + 2;
  let hp_height = bottom - top + 2;
  let mut detail = vec![[0_i16; 2]; hp_width * hp_height];
  for y in 0..hp_height {
    for x in 0..hp_width {
      let sy = top + y - 1;
      let sx = left + x - 1;
      detail[y * hp_width + x] = std::array::from_fn(|c| {
        ((src[sy * width + sx][c + 1] as i32 - prediction(&lp, lp_width, sy, sx, c + 1) + 1) >> 1)
          as i16
      });
    }
  }
  let mut result = Vec::with_capacity((bottom - top) * (right - left));
  for y in top..bottom {
    reconstruction_row(
      &filtered,
      lp_width,
      y + 2,
      left,
      &mut across[((y + 2) % 5) * output_width..((y + 2) % 5 + 1) * output_width],
    );
    let rows: [&[[u16; 2]]; 5] = std::array::from_fn(|i| {
      let slot = (y + i - 2) % 5;
      &across[slot * output_width..(slot + 1) * output_width]
    });
    for x in left..right {
      let mut value = src[y * width + x];
      for c in 0..2 {
        let mut neighbours = [0_i16; 9];
        for dy in 0..3 {
          for dx in 0..3 {
            neighbours[dy * 3 + dx] = detail[(y - top + dy) * hp_width + x - left + dx][c];
          }
        }
        let high = rank_clamp(neighbours, params.rank);
        let high = params.shrink[c][(high as i32 + 32768) as usize] as i32;
        let low = blur5(std::array::from_fn(|i| rows[i][x - left][c]));
        value[c + 1] = (2 * high + 4 * low as i32).clamp(0, 65535) as u16;
      }
      result.push(value);
    }
  }
  result
}

/// Rank1024 is a median. Lower values preserve the centre sample while it is
/// between symmetric interpolated order statistics. Fractional ranks use signed
/// integer rounding before clamping, including for negative detail residuals.
fn rank_clamp(mut neighbours: [i16; 9], rank: usize) -> i16 {
  if rank == 1024 {
    return crate::adobe::rank::median9(neighbours);
  }
  let center = neighbours[4];
  neighbours.sort_unstable();
  let index = rank >> 8;
  let fraction = (rank & 255) as i32;
  let interpolate =
    |a: i16, b: i16| ((a as i32 * (256 - fraction) + b as i32 * fraction + 128) >> 8) as i16;
  center.clamp(
    interpolate(neighbours[index], neighbours[index + 1]),
    interpolate(neighbours[8 - index], neighbours[7 - index]),
  )
}
