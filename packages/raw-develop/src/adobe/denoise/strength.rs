//! Denoise strength coefficients reconstructed from Adobe 18.7.
//!
//! `GetDenoiseBlendParams` (100e5e8e4) normalizes the amount, then
//! `ExpandDenoiseParameters` (100bf408c) expands it into two frequency-band
//! weights. The committed numeric fixture captures both native functions from
//! an owned DNG Converter process. The RGB blend reproduces the stage's color
//! transforms and Gaussian low/high decomposition. Image boundary padding is a
//! separate caller responsibility. SIMD entry points were also observed during
//! normal InterpolateBayer execution (wrapper/dispatch/dispatch.json); synthetic
//! native full-stage calls validate both dispatch arithmetic paths.

use super::{Result, Tensor, invalid};
use crate::Cancel;

/// Two frequency-band weights, kept in f64 until Adobe's pixel-stage boundary.
/// Index zero weights the high-frequency residual, index one the Gaussian
/// low-frequency image. Chroma applies to both chrominance components.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BlendWeights {
  pub luminance: [f64; 2],
  pub chroma: [f64; 2],
}

impl BlendWeights {
  /// Match the enabled Adobe amount path: clamp the unsigned amount to 1..100,
  /// divide by 100, and keep the chroma parameter at one.
  pub fn from_amount(amount: u32) -> Self {
    Self::from_options(true, amount)
  }

  /// Match the captured enhance-options flag and amount. With `enabled=false`,
  /// Adobe supplies full-strength coefficients regardless of the amount field;
  /// this flag must not be interpreted as a request to bypass model inference.
  pub fn from_options(enabled: bool, amount: u32) -> Self {
    let luminance = if enabled {
      amount.clamp(1, 100) as f64 / 100.0
    } else {
      1.0
    };
    Self::expand(luminance, 1.0)
  }

  /// Expand explicit normalized parameters, as in Adobe's helper. This is useful
  /// for controlled tests; the observed UI path always supplies chroma=1.
  pub fn from_normalized(luminance: f64, chroma: f64) -> Result<Self> {
    if ![luminance, chroma]
      .iter()
      .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
    {
      return Err(invalid("blend parameters must be finite and in [0, 1]"));
    }
    Ok(Self::expand(luminance, chroma))
  }

  fn expand(luminance: f64, chroma: f64) -> Self {
    // The immediate constant is one ULP below the nearest f64 value of 7/3.
    // The native assembly uses separate mul/add/sub/div operations, not FMA.
    let fine = luminance * f64::from_bits(0x4002_aaaa_aaaa_aaaa);
    let coarse = luminance * 3.0;
    let chroma = chroma / ((chroma + 1.0) - chroma);
    Self {
      luminance: [
        fine / ((fine + 1.0) - luminance),
        coarse / ((coarse + 1.0) - luminance),
      ],
      chroma: [chroma; 2],
    }
  }
}

/// Blend two linear RGB tiles using the arithmetic of Adobe's ARM SIMD dispatch.
///
/// Both tiles must include a three-pixel halo on every side; the returned tile
/// excludes the halo. No boundary padding is invented here. `original` is the
/// baseline RGB image and `denoised` the model result. This reproduces the
/// captured matrix, Gaussian low/high decomposition and frequency-band blend.
/// This is the blend stage only: it does not construct the baseline or implement
/// the caller's full-strength bypass (observed when both parameters equal one).
pub fn blend_tile(
  original: &Tensor,
  denoised: &Tensor,
  weights: BlendWeights,
  cancel: &Cancel,
) -> Result<Tensor> {
  blend_dispatch(original, denoised, weights, cancel, false)
}

/// Blend two linear RGB tiles using Adobe's reference matrix/blur dispatch.
///
/// Both tiles must include a three-pixel halo on every side. The returned tile
/// excludes that halo. This reproduces controlled native stage calls with Ref
/// dispatch, not the application's CPU-selected SIMD path or image-edge policy.
/// `original` is the baseline RGB image; `denoised` is the model result. Like
/// [`blend_tile`], this does not implement the caller's full-strength bypass.
pub fn blend_reference_tile(
  original: &Tensor,
  denoised: &Tensor,
  weights: BlendWeights,
  cancel: &Cancel,
) -> Result<Tensor> {
  blend_dispatch(original, denoised, weights, cancel, true)
}

fn blend_dispatch(
  original: &Tensor,
  denoised: &Tensor,
  weights: BlendWeights,
  cancel: &Cancel,
  reference: bool,
) -> Result<Tensor> {
  let [channels, height, width] = original.shape();
  if channels != 3 || original.shape() != denoised.shape() || height < 7 || width < 7 {
    return Err(invalid(
      "strength blend requires matching RGB tiles with a three-pixel halo",
    ));
  }
  if !weights
    .luminance
    .iter()
    .chain(weights.chroma.iter())
    .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
  {
    return Err(invalid("strength weights must be finite and in [0, 1]"));
  }
  cancel.check()?;
  let n = height * width;
  let mut pair = [original.data().to_vec(), denoised.data().to_vec()];
  const FORWARD: [[f32; 3]; 3] = [
    [0.25, 0.5, 0.25],
    [-1.0 / 6.0, -1.0 / 3.0, 0.5],
    [0.5, -1.0 / 3.0, -1.0 / 6.0],
  ];
  for data in &mut pair {
    matrix_transform(data, n, FORWARD, cancel, reference)?;
  }
  let out_width = width - 6;
  let out_height = height - 6;
  let out_n = out_width * out_height;
  let mut output = vec![0.0; 3 * out_n];
  // Quantized sigma=1 kernel captured from cr_stage_blend_multiscale's ctor.
  const K: [f32; 4] = [
    8516.0 / 16384.0,
    3654.0 / 16384.0,
    277.0 / 16384.0,
    3.0 / 16384.0,
  ];
  let mut across = [vec![0.0; height * out_width], vec![0.0; height * out_width]];
  for channel in 0..3 {
    for image in 0..2 {
      for y in 0..height {
        cancel.check()?;
        for x in 3..width - 3 {
          let i = channel * n + y * width + x;
          let data = &pair[image];
          // RefBlurAcross32 radius=3 uses individual taps, starting at -2.
          let mut sum = if reference {
            data[i - 2] * K[2]
          } else {
            data[i] * K[0]
          };
          if reference {
            for (offset, weight) in [
              (-3, K[3]),
              (-1, K[1]),
              (0, K[0]),
              (1, K[1]),
              (2, K[2]),
              (3, K[3]),
            ] {
              sum = data[i.wrapping_add_signed(offset)].mul_add(weight, sum);
            }
          } else {
            for radius in 1..=3 {
              sum = (data[i - radius] + data[i + radius]).mul_add(K[radius], sum);
            }
          }
          across[image][y * out_width + x - 3] = sum;
        }
      }
    }
    let [high_weight, low_weight] = if channel == 0 {
      weights.luminance
    } else {
      weights.chroma
    }
    .map(|v| v as f32);
    for y in 3..height - 3 {
      cancel.check()?;
      for x in 0..out_width {
        let i = y * out_width + x;
        let low = across.each_ref().map(|data| {
          // RefBlurDown32 instead sums symmetric pairs, center FMA second.
          let mut sum;
          let start;
          if reference {
            sum = (data[i - out_width] + data[i + out_width]) * K[1];
            sum = data[i].mul_add(K[0], sum);
            start = 2;
          } else {
            sum = data[i] * K[0];
            start = 1;
          }
          for radius in start..=3 {
            sum =
              (data[i - radius * out_width] + data[i + radius * out_width]).mul_add(K[radius], sum);
          }
          sum
        });
        let source_i = channel * n + y * width + x + 3;
        let high_a = pair[0][source_i] - low[0];
        let high_b = pair[1][source_i] - low[1];
        let low_blend = (low[1] - low[0]).mul_add(low_weight, low[0]);
        let high_blend = (high_b - high_a).mul_add(high_weight, high_a);
        output[channel * out_n + (y - 3) * out_width + x] = low_blend + high_blend;
      }
    }
  }
  const INVERSE: [[f32; 3]; 3] = [[1.0, 0.0, 1.5], [1.0, -0.75, -0.75], [1.0, 1.5, 0.0]];
  matrix_transform(&mut output, out_n, INVERSE, cancel, reference)?;
  Tensor::new([3, out_height, out_width], output)
}

fn matrix_transform(
  data: &mut [f32],
  n: usize,
  matrix: [[f32; 3]; 3],
  cancel: &Cancel,
  reference: bool,
) -> Result<()> {
  for i in 0..n {
    if i % 4096 == 0 {
      cancel.check()?;
    }
    let rgb = [data[i], data[n + i], data[2 * n + i]];
    for c in 0..3 {
      // RefMatrix3by4_32 starts with G, then FMA R, FMA B, separate bias.
      data[c * n + i] = if reference {
        let value = rgb[0].mul_add(matrix[c][0], rgb[1] * matrix[c][1]);
        rgb[2].mul_add(matrix[c][2], value) + 0.0
      } else {
        let value = rgb[0].mul_add(matrix[c][0], 0.0);
        let value = rgb[1].mul_add(matrix[c][1], value);
        rgb[2].mul_add(matrix[c][2], value)
      };
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(serde::Deserialize)]
  struct Fixture {
    cases: Vec<AmountCase>,
    normalized_cases: Vec<NormalizedCase>,
  }
  #[derive(serde::Deserialize)]
  struct AmountCase {
    enabled: bool,
    amount: u32,
    parameter_bits: [String; 2],
    luminance_bits: [String; 2],
    chroma_bits: [String; 2],
  }
  #[derive(serde::Deserialize)]
  struct NormalizedCase {
    parameters: [f64; 2],
    luminance_bits: [String; 2],
    chroma_bits: [String; 2],
  }
  fn assert_bits(actual: [f64; 2], expected: &[String; 2]) {
    for (a, b) in actual.into_iter().zip(expected) {
      assert_eq!(a.to_bits(), u64::from_str_radix(b, 16).unwrap());
    }
  }

  #[derive(serde::Deserialize)]
  struct BlendFixture {
    cases: Vec<BlendCase>,
  }
  #[derive(serde::Deserialize)]
  struct BlendCase {
    amount: u32,
    shape: [usize; 3],
    source_sha256: String,
    reference_sha256: String,
    simd_sha256: String,
  }
  fn tensor_digest(tensor: &Tensor) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"PBDT0001");
    for d in tensor.shape() {
      hash.update((d as u32).to_le_bytes());
    }
    for v in tensor.data() {
      hash.update(v.to_le_bytes());
    }
    format!("{:x}", hash.finalize())
  }

  #[test]
  fn synthetic_blends_match_committed_native_digests() {
    let fixture: BlendFixture =
      serde_json::from_str(include_str!("strength-blend-fixtures.json")).unwrap();
    assert_eq!(fixture.cases.len(), 5);
    for case in fixture.cases {
      let [channels, height, width] = case.shape;
      let mut data = Vec::new();
      for c in 0..channels {
        for y in 0..height {
          for x in 0..width {
            let mut v = (((x * 17 + y * 29 + c * 43) % 113) as f64 - 11.0) / 96.0;
            if c >= 3 {
              v = 0.25 + 0.45 * v;
            }
            data.push(v as f32);
          }
        }
      }
      let input = Tensor::new(case.shape, data).unwrap();
      assert_eq!(tensor_digest(&input), case.source_sha256);
      let n = 3 * height * width;
      let a = Tensor::new([3, height, width], input.data()[..n].to_vec()).unwrap();
      let b = Tensor::new([3, height, width], input.data()[n..].to_vec()).unwrap();
      let weights = BlendWeights::from_amount(case.amount);
      let reference = blend_reference_tile(&a, &b, weights, &Cancel::never()).unwrap();
      let simd = blend_tile(&a, &b, weights, &Cancel::never()).unwrap();
      assert_eq!(tensor_digest(&reference), case.reference_sha256);
      assert_eq!(tensor_digest(&simd), case.simd_sha256);
    }
  }

  #[test]
  fn blend_rejects_missing_halo_bad_weights_and_cancellation() {
    let too_small = Tensor::new([3, 6, 7], vec![0.0; 126]).unwrap();
    let valid = Tensor::new([3, 7, 7], vec![0.0; 147]).unwrap();
    let weights = BlendWeights::from_amount(50);
    assert!(blend_tile(&too_small, &too_small, weights, &Cancel::never()).is_err());
    assert!(blend_tile(&valid, &too_small, weights, &Cancel::never()).is_err());
    let bad = BlendWeights {
      luminance: [f64::NAN, 0.5],
      chroma: [1.0; 2],
    };
    assert!(blend_tile(&valid, &valid, bad, &Cancel::never()).is_err());
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
      blend_tile(&valid, &valid, weights, &cancel),
      Err(crate::Error::Cancelled)
    ));
    assert_eq!(
      blend_tile(&valid, &valid, weights, &Cancel::never())
        .unwrap()
        .shape(),
      [3, 1, 1]
    );
  }

  #[test]
  fn native_blend_captures_match_both_dispatches() {
    let Ok(root) = std::env::var("RAW_DENOISE_CAPTURE_FIXTURES") else {
      return;
    };
    for (directory, reference) in [("strength-oracle", true), ("strength-simd-oracle", false)] {
      let root = std::path::Path::new(&root).join(directory);
      for (index, amount) in [1, 25, 50, 75, 100].into_iter().enumerate() {
        let input = Tensor::read(root.join(format!("blend-{index}.input.f32"))).unwrap();
        let expected = Tensor::read(root.join(format!("blend-{index}.output.f32"))).unwrap();
        let [_, h, w] = input.shape();
        let n = 3 * h * w;
        let a = Tensor::new([3, h, w], input.data()[..n].to_vec()).unwrap();
        let b = Tensor::new([3, h, w], input.data()[n..].to_vec()).unwrap();
        let actual = blend_dispatch(
          &a,
          &b,
          BlendWeights::from_amount(amount),
          &Cancel::never(),
          reference,
        )
        .unwrap();
        assert_eq!(actual.shape(), expected.shape());
        for (i, (a, b)) in actual.data().iter().zip(expected.data()).enumerate() {
          assert_eq!(
            a.to_bits(),
            b.to_bits(),
            "case={index}, index={i}, actual={a}, expected={b}"
          );
        }
      }
    }
  }

  #[test]
  fn native_strength_oracle_matches_all_amounts_and_fractional_parameters() {
    let fixture: Fixture = serde_json::from_str(include_str!("strength-fixtures.json")).unwrap();
    assert_eq!(fixture.cases.len(), 106);
    assert_eq!(fixture.normalized_cases.len(), 5);
    for case in fixture.cases {
      let params = [
        if case.enabled {
          case.amount.clamp(1, 100) as f64 / 100.0
        } else {
          1.0
        },
        1.0,
      ];
      assert_bits(params, &case.parameter_bits);
      let weights = BlendWeights::from_options(case.enabled, case.amount);
      assert_bits(weights.luminance, &case.luminance_bits);
      assert_bits(weights.chroma, &case.chroma_bits);
    }
    for case in fixture.normalized_cases {
      let weights = BlendWeights::from_normalized(case.parameters[0], case.parameters[1]).unwrap();
      assert_bits(weights.luminance, &case.luminance_bits);
      assert_bits(weights.chroma, &case.chroma_bits);
    }
  }

  #[test]
  fn normalization_validates_domain_and_keeps_observed_clamping() {
    for value in [f64::NAN, f64::INFINITY, -0.1, 1.1] {
      assert!(BlendWeights::from_normalized(value, 1.0).is_err());
      assert!(BlendWeights::from_normalized(0.5, value).is_err());
    }
    assert_eq!(BlendWeights::from_amount(0), BlendWeights::from_amount(1));
    assert_eq!(
      BlendWeights::from_amount(u32::MAX),
      BlendWeights::from_amount(100)
    );
    assert_eq!(
      BlendWeights::from_options(false, 50),
      BlendWeights::from_amount(100)
    );
    assert_eq!(
      BlendWeights::from_normalized(0.0, 0.0).unwrap(),
      BlendWeights {
        luminance: [0.0; 2],
        chroma: [0.0; 2]
      }
    );
  }
}
