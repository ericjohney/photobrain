//! Reference-camera balance and native u16 image boundaries for partial denoise.
use super::{MosaicTilePlan, Tensor, Variant, invalid};
use crate::{
  Cancel, Negative, Result,
  adobe::{bayer, xtrans},
};

pub struct DenoiseGains {
  variant: Variant,
  gains: [f64; 3],
  black: f64,
}

impl DenoiseGains {
  pub fn from_negative(negative: &Negative) -> Result<Self> {
    let m = &negative.meta;
    let (variant, gains) = match m.model.as_str() {
      "ILCE-1M2" => (Variant::Bayer, bayer::denoise_reference_gains(negative)?),
      "X100VI" => {
        if m.as_shot_wb.iter().any(|v| !v.is_finite() || *v <= 0.0) {
          return Err(invalid("invalid reference white balance"));
        }
        let neutral = xtrans::rounded_neutral(m.as_shot_wb.map(|v| 1.0 / v));
        let gains = neutral.map(|v| 1.0 / v);
        let max = gains.into_iter().fold(0.0f64, f64::max);
        (Variant::Xtrans, gains.map(|v| v * (1.0 / max)))
      }
      _ => return Err(invalid("unvalidated denoise reference gains")),
    };
    if m.bits_per_sample > 16 || m.black_levels.is_empty() {
      return Err(invalid("invalid denoise black level"));
    }
    let black = (u32::from(m.black_levels[0]) << (16 - m.bits_per_sample)) as f64 / 65535.0;
    if !(0.0..1.0).contains(&black) || gains.iter().any(|v| !v.is_finite() || *v <= 0.0) {
      return Err(invalid("invalid denoise balance"));
    }
    Ok(Self {
      variant,
      gains,
      black,
    })
  }

  pub fn reference_gains(&self) -> [f64; 3] {
    self.gains
  }

  pub fn finish_balanced(
    &self,
    plan: &MosaicTilePlan,
    network_output: &Tensor,
    cancel: &Cancel,
  ) -> Result<Tensor> {
    let output = plan.finish_output(network_output, cancel)?;
    self
      .apply(&output, false, cancel)
      .and_then(|v| commit(&v, cancel))
  }

  pub fn finish_after_blend(&self, blended: &Tensor, cancel: &Cancel) -> Result<Tensor> {
    let blended = commit(blended, cancel)?;
    self
      .apply(&blended, true, cancel)
      .and_then(|v| commit(&v, cancel))
  }

  fn apply(&self, input: &Tensor, inverse: bool, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    let [channels, h, w] = input.shape();
    if channels != 3 {
      return Err(invalid("reference gains require RGB"));
    }
    let gains = if inverse {
      self.gains.map(|g| 1.0 / g)
    } else {
      self.gains
    };
    let mut data = input.data().to_vec();
    let n = h * w;
    if self.variant == Variant::Bayer {
      for c in 0..3 {
        if gains[c] == 1.0 {
          continue;
        }
        let (gain, add) = bayer_affine(gains[c], self.black);
        for row in data[c * n..(c + 1) * n].chunks_mut(w) {
          cancel.check()?;
          for v in row {
            *v = v.mul_add(gain, add);
            if inverse {
              *v = v.clamp(0.0, 1.0);
            }
          }
        }
      }
    } else {
      // The native Fuji pipe selects signed-16 matrix stages on both sides
      // of BlendNoise, committing the restored neural floats before this gain.
      let (matrix, shift) = matrix16(gains, self.black)?;
      for y in 0..h {
        cancel.check()?;
        for x in 0..w {
          let i = y * w + x;
          let rgb = std::array::from_fn::<_, 3, _>(|c| {
            i64::from(bayer::tables::code(input.data()[c * n + i])) - 32768
          });
          for c in 0..3 {
            let m = matrix[c];
            let value = (m[3] + rgb[0] * m[0] + rgb[1] * m[1] + rgb[2] * m[2]) >> shift;
            data[c * n + i] =
              bayer::tables::normalized((value.clamp(-32768, 32767) + 32768) as u16);
          }
        }
      }
    }
    Tensor::new(input.shape(), data)
  }
}

fn bayer_affine(gain: f64, black: f64) -> (f32, f32) {
  let b = black as f32;
  let s = -1.0 / (b - 1.0);
  let a = (0.0 - b * s) / s;
  let z = (s * b) / s;
  let g = gain as f32;
  (g, g.mul_add(a, z))
}

fn matrix16(gains: [f64; 3], black: f64) -> Result<([[i64; 4]; 3], u32)> {
  let scale = -1.0 / (black - 1.0);
  let offset = 0.0 - black * scale;
  let restore = -(black - 1.0);
  let matrix: [[f64; 4]; 3] = std::array::from_fn(|c| {
    let m: [f64; 3] = std::array::from_fn(|i| if i == c { gains[c] } else { 0.0 });
    [
      m[0] * scale * restore,
      m[1] * scale * restore,
      m[2] * scale * restore,
      (offset.mul_add(m[2], m[0].mul_add(offset, offset * m[1])) + 0.0).mul_add(restore, black),
    ]
  });
  for shift in (8..=14).rev() {
    let scale = f64::from(1u32 << shift);
    let mut result = [[0; 4]; 3];
    let mut valid = true;
    for c in 0..3 {
      let m = matrix[c];
      let positive = m[..3].iter().map(|v| (v * scale).max(0.0)).sum::<f64>();
      let negative = m[..3].iter().map(|v| (v * scale).min(0.0)).sum::<f64>();
      if positive.max(-negative) > 30000.0 {
        valid = false;
        break;
      }
      let q = m.map(|v| (v * scale).round() as i64);
      let bias = q[3] * 65535 + (q[0] + q[1] + q[2]) * 32768 - (1i64 << shift) * 32768
        + (1i64 << (shift - 1));
      let radius = (q[0].abs() + q[1].abs() + q[2].abs()) * 32768;
      valid &= bias - radius >= i64::from(i32::MIN) && bias + radius <= i64::from(i32::MAX);
      result[c] = [q[0], q[1], q[2], bias];
    }
    if valid {
      return Ok((result, shift));
    }
  }
  Err(invalid(
    "reference matrix does not support native integer dispatch",
  ))
}

/// The native pipe commits float stage output to u16, then normalizes for its next stage.
pub fn commit(input: &Tensor, cancel: &Cancel) -> Result<Tensor> {
  cancel.check()?;
  let mut data = input.data().to_vec();
  for row in data.chunks_mut(input.shape()[2]) {
    cancel.check()?;
    for v in row {
      *v = bayer::tables::normalized(bayer::tables::code(*v));
    }
  }
  Tensor::new(input.shape(), data)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  #[test]
  fn native_u16_commit_thresholds() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../tests/fixtures/adobe-denoise-commit.json"
    ))
    .unwrap();
    let input: Vec<f32> = fixture["input_bits"]
      .as_array()
      .unwrap()
      .iter()
      .map(|v| f32::from_bits(v.as_u64().unwrap() as u32))
      .collect();
    let tensor = Tensor::new([1, 1, input.len()], input).unwrap();
    let result = commit(&tensor, &Cancel::never()).unwrap();
    let expected = fixture["normalized_bits"].as_array().unwrap();
    for (i, (v, bits)) in result.data().iter().zip(expected).enumerate() {
      assert_eq!(v.to_bits(), bits.as_u64().unwrap() as u32, "sample {i}");
    }
  }

  #[test]
  fn native_integer_matrix_coefficients_and_invalid_work() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../tests/fixtures/adobe-denoise-gains.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
      let gains = std::array::from_fn(|c| case["gains"][c].as_f64().unwrap());
      let (matrix, shift) = matrix16(gains, case["black"].as_f64().unwrap()).unwrap();
      assert_eq!(u64::from(shift), case["shift"].as_u64().unwrap());
      for c in 0..3 {
        for i in 0..4 {
          assert_eq!(matrix[c][i], case["matrix"][c][i].as_i64().unwrap());
        }
      }
    }
    assert!(matrix16([1.0, 1e100, 1.0], 0.06).is_err());
    let gains = DenoiseGains {
      variant: Variant::Xtrans,
      gains: [1.0, 0.5, 0.9],
      black: 0.06,
    };
    let mono = Tensor::new([1, 1, 1], vec![0.1]).unwrap();
    assert!(gains.apply(&mono, false, &Cancel::never()).is_err());
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
      commit(&mono, &cancel),
      Err(crate::Error::Cancelled)
    ));
    assert!(matches!(
      gains.apply(&mono, false, &cancel),
      Err(crate::Error::Cancelled)
    ));
  }

  fn capture(root: &Path, stem: &str) -> Tensor {
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap()).unwrap();
    let get = |k: &str| meta[k].as_i64().unwrap();
    let h = (get("b") - get("t")) as usize;
    let w = (get("r") - get("l")) as usize;
    let bytes = std::fs::read(root.join(format!("{stem}.bin"))).unwrap();
    let mut data = Vec::new();
    for c in 0..get("planes") as usize {
      for y in 0..h {
        for x in 0..w {
          let i = (c * get("plane_step") as usize
            + y * get("row_step") as usize
            + x * get("col_step") as usize)
            * get("psize") as usize;
          data.push(if get("ptype") == 8 {
            bayer::tables::normalized(
              (i32::from(i16::from_le_bytes(bytes[i..i + 2].try_into().unwrap())) + 32768) as u16,
            )
          } else {
            f32::from_le_bytes(bytes[i..i + 4].try_into().unwrap())
          });
        }
      }
    }
    Tensor::new([get("planes") as usize, h, w], data).unwrap()
  }

  #[test]
  fn native_external_gain_stages() {
    let (Some(root), Some(raw_root)) = (
      std::env::var_os("RAW_DENOISE_BASELINE_FIXTURES"),
      std::env::var_os("RAW_DENOISE_RAW_FIXTURES"),
    ) else {
      return;
    };
    let root = Path::new(&root);
    for (directory, raw) in [
      ("gains-bayer", "a1m2/12766.ARW"),
      ("gains-fuji16", "x100vi/DSCF0008.RAF"),
    ] {
      let root = root.join(directory);
      let negative = Negative::open(std::path::Path::new(&raw_root).join(raw)).unwrap();
      let gains = DenoiseGains::from_negative(&negative).unwrap();
      let ctx = std::fs::read(root.join("context.bin")).unwrap();
      for c in 0..3 {
        let offset = 0x260 + c * 8;
        assert_eq!(
          gains.gains[c].to_bits(),
          f64::from_le_bytes(ctx[offset..offset + 8].try_into().unwrap()).to_bits(),
          "gain {c}"
        );
      }
      for (stem, inverse) in [("neural-gain", false), ("final-gain", true)] {
        let input = capture(&root, &format!("{stem}-input"));
        let expected = capture(&root, &format!("{stem}-output"));
        let actual = gains.apply(&input, inverse, &Cancel::never()).unwrap();
        exact(&actual, &expected, stem);
        if inverse {
          let final_output = gains.finish_after_blend(&input, &Cancel::never()).unwrap();
          exact(
            &final_output,
            &commit(&expected, &Cancel::never()).unwrap(),
            "final u16 commit",
          );
        }
      }
      if gains.variant == Variant::Bayer {
        let blend = Tensor::read(
          root
            .parent()
            .unwrap()
            .join("bayer-blend-edges/tl-output.f32"),
        )
        .unwrap();
        let expected_input = crop_origin(&capture(&root, "final-gain-input"), blend.shape());
        exact(
          &commit(&blend, &Cancel::never()).unwrap(),
          &expected_input,
          "blend commit to inverse input",
        );
        let expected_output = crop_origin(&capture(&root, "final-gain-output"), blend.shape());
        let actual = gains.finish_after_blend(&blend, &Cancel::never()).unwrap();
        exact(
          &actual,
          &commit(&expected_output, &Cancel::never()).unwrap(),
          "composed blend commit/inverse/final commit",
        );
      }
      let restored = capture(&root, "restore-output");
      let forward_input = capture(&root, "neural-gain-input");
      let boundary = if gains.variant == Variant::Xtrans {
        commit(&restored, &Cancel::never()).unwrap()
      } else {
        restored
      };
      exact(&boundary, &forward_input, "restore to gain boundary");
      // Reconstruct the model output's retained rectangle from the captured
      // postprocess output. Discarded model margins are immaterial to finish.
      let cropped = capture(&root, "inverse-gamma-input");
      let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("inverse-gamma-input.json")).unwrap())
          .unwrap();
      let coord = |k: &str| meta[k].as_i64().unwrap() as i32;
      let requested =
        super::super::tiles::Rect::new(coord("t"), coord("l"), coord("b"), coord("r")).unwrap();
      let plan = MosaicTilePlan::new(gains.variant, requested, gains.black).unwrap();
      let output = plan.geometry().output;
      let [h, w] = output.size();
      let [_, ch, cw] = cropped.shape();
      let mut expanded = vec![0.0; 3 * h * w];
      for c in 0..3 {
        for y in 0..ch {
          let dest = c * h * w
            + (y + (requested.top() - output.top()) as usize) * w
            + (requested.left() - output.left()) as usize;
          expanded[dest..dest + cw]
            .copy_from_slice(&cropped.data()[c * ch * cw + y * cw..c * ch * cw + (y + 1) * cw]);
        }
      }
      let model = Tensor::new([3, h, w], expanded).unwrap();
      let actual = gains
        .finish_balanced(&plan, &model, &Cancel::never())
        .unwrap();
      let expected = commit(&capture(&root, "neural-gain-output"), &Cancel::never()).unwrap();
      exact(&actual, &expected, "composed crop/gamma/black/gain/commit");
    }
  }

  #[test]
  fn native_external_strength_extremes() {
    let (Some(root), Some(raw_root)) = (
      std::env::var_os("RAW_DENOISE_AMOUNT_FIXTURES"),
      std::env::var_os("RAW_DENOISE_RAW_FIXTURES"),
    ) else {
      return;
    };
    let root = Path::new(&root);
    for (camera, raw) in [("bayer", "a1m2/12766.ARW"), ("fuji", "x100vi/DSCF0008.RAF")] {
      let negative = Negative::open(Path::new(&raw_root).join(raw)).unwrap();
      let gains = DenoiseGains::from_negative(&negative).unwrap();
      for amount in [1, 99] {
        let dir = root.join(format!("amount-{camera}-{amount}"));
        let meta: serde_json::Value =
          serde_json::from_slice(&std::fs::read(dir.join("capture.json")).unwrap()).unwrap();
        assert_eq!(meta["verified_amount"].as_u64().unwrap(), u64::from(amount));
        let input = capture(&dir, "blend-input");
        let [channels, h, w] = input.shape();
        assert_eq!(channels, 6);
        let n = 3 * h * w;
        let original = Tensor::new([3, h, w], input.data()[..n].to_vec()).unwrap();
        let denoised = Tensor::new([3, h, w], input.data()[n..].to_vec()).unwrap();
        let weights = super::super::strength::BlendWeights::from_amount(amount);
        let blended =
          super::super::strength::blend_tile(&original, &denoised, weights, &Cancel::never())
            .unwrap();
        let native_blend = capture(&dir, "blend-output");
        exact(
          &blended,
          &native_blend,
          &format!("{camera} amount{amount} blend"),
        );
        let native_gain_input = crop_origin(&capture(&dir, "final-gain-input"), blended.shape());
        exact(
          &commit(&blended, &Cancel::never()).unwrap(),
          &native_gain_input,
          "blend commit boundary",
        );
        let final_output = gains
          .finish_after_blend(&blended, &Cancel::never())
          .unwrap();
        let native_final = crop_origin(&capture(&dir, "final-gain-output"), blended.shape());
        exact(
          &final_output,
          &commit(&native_final, &Cancel::never()).unwrap(),
          &format!("{camera} amount{amount} blend/gain/commit"),
        );
      }
    }
  }

  fn crop_origin(input: &Tensor, shape: [usize; 3]) -> Tensor {
    let [_, height, width] = input.shape();
    let [_, h, w] = shape;
    let mut out = Vec::new();
    for c in 0..3 {
      for y in 0..h {
        out.extend_from_slice(
          &input.data()[c * height * width + y * width..c * height * width + y * width + w],
        );
      }
    }
    Tensor::new(shape, out).unwrap()
  }

  fn exact(actual: &Tensor, expected: &Tensor, label: &str) {
    assert_eq!(actual.shape(), expected.shape(), "{label}");
    let mismatch = actual
      .data()
      .iter()
      .zip(expected.data())
      .filter(|(a, b)| a.to_bits() != b.to_bits())
      .count();
    assert_eq!(mismatch, 0, "{label}: {} samples", actual.data().len());
    eprintln!("{label}: {} exact samples", actual.data().len());
  }
}
