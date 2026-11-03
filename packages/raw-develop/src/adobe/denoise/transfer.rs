//! Experimental ACR denoise transfer primitives, separate from RAW rendering.
//!
//! Static provenance (DNG Converter 18.7 arm64 addresses):
//! - `cr_affine_wrapper_function::{ctor,Evaluate}`: 1008ab4bc / 1008ab590.
//! - `dng_1d_table::Initialize`: 1013cb7a4, uniform sampling branch.
//! - `cr_stage_1d_table::Process_32`: 1008ac45c, signed branch.
//! - `cr_stage_apply_gamma_signed_bayer::Process_32`: 100832438.
//!
//! The arithmetic is reconstructed from static evidence. Optional capture tests
//! compare one Bayer black-removal table/stage and one quarter-power stage.
//! These do not choose correct parameters for arbitrary RAW files or establish
//! complete processing parity. Platform `powf` implementations can differ.

use super::{Result, invalid};

const INTERVALS: usize = 4096;

/// Uniform float table for an affine black-level transfer.
///
/// On the nonnegative unit interval the underlying double-precision function is
/// `(x - input_black) / (1 - input_black) * (1 - output_black) + output_black`.
/// Adobe samples that function into f32 and interpolates it, so replacing this
/// table with that expression changes rounding. Negative inputs reflect around
/// the table's value at zero; magnitudes above one extrapolate with slope one.
#[derive(Clone, Debug)]
pub struct AffineTable {
  samples: Box<[f32]>,
}

impl AffineTable {
  /// Construct the observed 4096-interval table, including its repeated endpoint.
  /// Both black parameters must be finite and in `[0, 1)`.
  pub fn new(input_black: f64, output_black: f64) -> Result<Self> {
    if !valid_black(input_black) || !valid_black(output_black) {
      return Err(invalid(
        "affine black parameters must be finite and in [0, 1)",
      ));
    }
    // Preserve the constructor and Evaluate operation ordering, including its
    // f64 fused affine evaluations and the explicit conversion to f32.
    let input_scale = -1.0 / (input_black + -1.0);
    let output_scale = -(output_black + -1.0);
    let step = 1.0 / INTERVALS as f64;
    let mut samples = Vec::with_capacity(INTERVALS + 2);
    for i in 0..=INTERVALS {
      let x = step * i as f64;
      let y = (x - input_black).mul_add(input_scale, 0.0);
      let y = (y - 0.0).mul_add(output_scale, output_black);
      samples.push(y as f32);
    }
    samples.push(samples[INTERVALS]);
    Ok(Self {
      samples: samples.into_boxed_slice(),
    })
  }

  /// The table used by `AddPreprocessRawDenoise`: remove a supplied black level.
  pub fn remove_black(black: f64) -> Result<Self> {
    Self::new(black, 0.0)
  }

  /// The table used by `AddPostprocessRawDenoise`: restore a supplied black level.
  pub fn restore_black(black: f64) -> Result<Self> {
    Self::new(0.0, black)
  }

  /// Transform finite samples without clipping. Invalid input leaves the slice
  /// unchanged. The transfer is independent of tensor channel/storage layout.
  pub fn apply(&self, samples: &mut [f32]) -> Result<()> {
    if samples.iter().any(|v| !v.is_finite()) {
      return Err(invalid("affine transfer requires finite input"));
    }
    for value in samples {
      *value = self.evaluate(*value);
    }
    Ok(())
  }

  fn unit(&self, value: f32) -> f32 {
    let position = value * INTERVALS as f32;
    let index = position as usize;
    let fraction = position - index as f32;
    self.samples[index].mul_add(1.0 - fraction, fraction * self.samples[index + 1])
  }

  fn evaluate(&self, value: f32) -> f32 {
    // Comparison rather than sign-bit testing matches Adobe's treatment of -0.
    let magnitude = if value < 0.0 { -value } else { value };
    let mut result = self.unit(magnitude.min(1.0));
    if magnitude > 1.0 {
      result = (magnitude + -1.0) + result;
    }
    if value < 0.0 {
      let zero = self.unit(0.0);
      (zero + zero) - result
    } else {
      result
    }
  }
}

fn valid_black(value: f64) -> bool {
  value.is_finite() && (0.0..1.0).contains(&value)
}

/// Apply the observed signed `powf` transfer using a supplied f64 exponent,
/// converted once to f32 as in Adobe's stage. Positive/negative samples retain
/// their respective side of zero; values above one are not clipped.
///
/// The exponent must remain positive and finite after f32 conversion. Nonfinite
/// input or output returns an error without modifying the input slice. This
/// function deliberately uses platform `powf`, not an algebraic replacement.
pub fn apply_signed_gamma(samples: &mut [f32], exponent: f64) -> Result<()> {
  let power = exponent as f32;
  if !exponent.is_finite() || !power.is_finite() || power <= 0.0 {
    return Err(invalid(
      "signed gamma exponent must be positive and finite in f32",
    ));
  }
  if samples.iter().any(|v| !v.is_finite()) {
    return Err(invalid("signed gamma requires finite input"));
  }
  let mut transformed = Vec::with_capacity(samples.len());
  for &value in samples.iter() {
    let result = if value < 0.0 {
      -(-value).powf(power)
    } else {
      value.powf(power)
    };
    if !result.is_finite() {
      return Err(invalid("signed gamma produced non-finite output"));
    }
    transformed.push(result);
  }
  samples.copy_from_slice(&transformed);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn captured_adobe_inverse_stages_when_available() {
    let Some(root) = std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES") else {
      eprintln!("set RAW_DENOISE_CAPTURE_FIXTURES for optional inverse stage captures");
      return;
    };
    let root = std::path::PathBuf::from(root);
    for variant in ["bayer", "xtrans"] {
      let directory = root.join(format!("{variant}-inverse"));
      let context = std::fs::read(directory.join("context.bin")).unwrap();
      let black = f64::from_le_bytes(context[0x248..0x250].try_into().unwrap());
      let table = AffineTable::restore_black(black).unwrap();
      let captured = std::fs::read(directory.join("restore-table.bin")).unwrap();
      assert_eq!(captured.len(), table.samples.len() * 4);
      for (&sample, bytes) in table.samples.iter().zip(captured.chunks_exact(4)) {
        assert_eq!(
          sample.to_bits(),
          u32::from_le_bytes(bytes.try_into().unwrap())
        );
      }
      for (input_name, output_name, gamma) in [
        ("inverse-gamma-input.f32", "inverse-gamma-output.f32", true),
        ("restore-input.f32", "restore-output.f32", false),
      ] {
        let input = super::super::Tensor::read(directory.join(input_name)).unwrap();
        let expected = super::super::Tensor::read(directory.join(output_name)).unwrap();
        assert_eq!(input.shape(), expected.shape());
        let mut actual = input.into_data();
        if gamma {
          apply_signed_gamma(&mut actual, 4.0).unwrap();
        } else {
          table.apply(&mut actual).unwrap();
        }
        let mismatches = actual
          .iter()
          .zip(expected.data())
          .filter(|(a, b)| a.to_bits() != b.to_bits())
          .count();
        assert_eq!(mismatches, 0, "{variant}/{output_name}");
      }
    }
  }

  #[test]
  fn black_tables_preserve_knots_and_signed_extrapolation() {
    let remove = AffineTable::remove_black(0.25).unwrap();
    let restore = AffineTable::restore_black(0.25).unwrap();
    assert_eq!(remove.samples.len(), 4098);
    assert_eq!(
      remove.samples[4096].to_bits(),
      remove.samples[4097].to_bits()
    );
    let mut values = [0.0, 0.25, 0.5, 1.0, 2.0, -0.5, -2.0];
    remove.apply(&mut values).unwrap();
    assert_eq!(
      values,
      [-1.0 / 3.0, 0.0, 1.0 / 3.0, 1.0, 2.0, -1.0, -8.0 / 3.0]
    );
    let mut values = [0.0, 0.25, 0.5, 1.0, 2.0, -0.5, -2.0];
    restore.apply(&mut values).unwrap();
    assert_eq!(values, [0.25, 0.4375, 0.625, 1.0, 2.0, -0.125, -1.5]);
  }

  #[test]
  fn zero_black_is_identity_and_gamma_keeps_signed_range() {
    let mut values = [-2.0, -0.125, 0.0, 0.125, 0.5, 1.0, 2.0];
    let original = values;
    AffineTable::remove_black(0.0)
      .unwrap()
      .apply(&mut values)
      .unwrap();
    assert_eq!(values, original);
    let mut values = [-16.0, -1.0, -0.0, 0.0, 1.0, 16.0];
    apply_signed_gamma(&mut values, 0.25).unwrap();
    assert_eq!(values, [-2.0, -1.0, 0.0, 0.0, 1.0, 2.0]);
    assert_eq!(values[2].to_bits(), 0.0f32.to_bits());
    apply_signed_gamma(&mut values, 4.0).unwrap();
    assert_eq!(values, [-16.0, -1.0, 0.0, 0.0, 1.0, 16.0]);
  }

  #[test]
  fn invalid_parameters_or_samples_fail_without_mutation() {
    for black in [-1.0, 1.0, f64::INFINITY, f64::NAN] {
      assert!(AffineTable::remove_black(black).is_err());
      assert!(AffineTable::restore_black(black).is_err());
    }
    for exponent in [
      -1.0,
      0.0,
      f64::INFINITY,
      f64::NAN,
      f64::MAX,
      f64::MIN_POSITIVE,
    ] {
      let mut values = [0.25, 1.0];
      assert!(apply_signed_gamma(&mut values, exponent).is_err());
      assert_eq!(values, [0.25, 1.0]);
    }
    let mut values = [0.25, f32::INFINITY];
    let original = values.map(f32::to_bits);
    assert!(
      AffineTable::remove_black(0.1)
        .unwrap()
        .apply(&mut values)
        .is_err()
    );
    assert_eq!(values.map(f32::to_bits), original);
    assert!(apply_signed_gamma(&mut values, 0.25).is_err());
    assert_eq!(values.map(f32::to_bits), original);
    let mut values = [0.25, f32::MAX];
    assert!(apply_signed_gamma(&mut values, 4.0).is_err());
    assert_eq!(values, [0.25, f32::MAX]);
  }

  #[test]
  fn captured_adobe_bayer_gamma_when_available() {
    let Some(root) = std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES") else {
      eprintln!("set RAW_DENOISE_CAPTURE_FIXTURES for the optional Adobe quarter-power capture");
      return;
    };
    let root = std::path::PathBuf::from(root).join("bayer-output");
    let input = crate::adobe::denoise::Tensor::read(root.join("gamma-input.f32")).unwrap();
    let expected = crate::adobe::denoise::Tensor::read(root.join("gamma-output.f32")).unwrap();
    assert_eq!(input.shape(), expected.shape());
    let mut actual = input.into_data();
    apply_signed_gamma(&mut actual, 0.25).unwrap();
    let mismatches = actual
      .iter()
      .zip(expected.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(mismatches, 0, "captured Adobe signed gamma mismatches");
  }

  #[test]
  fn captured_adobe_bayer_black_removal_when_available() {
    let Some(root) = std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES") else {
      eprintln!("set RAW_DENOISE_CAPTURE_FIXTURES for the optional Adobe affine capture");
      return;
    };
    let root = std::path::PathBuf::from(root).join("bayer-transfer");
    // Supplied by the captured Bayer enhancement context, not inferred from pixels.
    let table = AffineTable::remove_black(2048.0 / 65535.0).unwrap();
    let captured = std::fs::read(root.join("affine-table.bin")).unwrap();
    assert_eq!(captured.len(), table.samples.len() * 4);
    for (i, (&actual, bytes)) in table
      .samples
      .iter()
      .zip(captured.chunks_exact(4))
      .enumerate()
    {
      assert_eq!(
        actual.to_bits(),
        u32::from_le_bytes(bytes.try_into().unwrap()),
        "table entry {i}"
      );
    }
    let input = crate::adobe::denoise::Tensor::read(root.join("affine-input.f32")).unwrap();
    let expected = crate::adobe::denoise::Tensor::read(root.join("affine-output.f32")).unwrap();
    assert_eq!(input.shape(), expected.shape());
    let mut actual = input.into_data();
    table.apply(&mut actual).unwrap();
    let mismatches = actual
      .iter()
      .zip(expected.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(mismatches, 0, "captured Adobe black removal mismatches");
  }
}
