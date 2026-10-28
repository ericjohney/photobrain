//! Camera CA knots to the radial polynomial used by Adobe's DNG opcode.
//!
//! Sony's count includes both colour curves; their samples are contiguous before
//! any padding. Fuji stores nine explicit radii and two nine-element curves.
//! Adobe fits source radius against [r, r³, r⁵, r⁷]. Our QR fit can differ from
//! Adobe's pseudoinverse in its last f64 bits, but produces bit-identical f32 ratio
//! tables on all eleven reference files; the radial stage only consumes those.

use super::WarpRectilinear;
use crate::error::{Error, Result};
use crate::metadata::{LensParams, LensSource, RawMetadata};

/// Build the embedded CA-only opcode. `fuji_ibis_shift` is [horizontal, vertical]
/// in tenths of a pixel, from signed FujiIFD tags 0xf011 and 0xf012 respectively.
///
/// The supported Fuji developer returns the DefaultCrop-sized active image, so
/// the vendor fit needs no active-area radius rescaling. Sony's fit uses the full
/// active image (before DefaultCrop) without rescaling and has a centred origin.
pub(crate) fn embedded_ca(
  meta: &RawMetadata,
  fuji_ibis_shift: Option<[i32; 2]>,
) -> Result<Option<WarpRectilinear>> {
  match &meta.lens {
    LensSource::None => Ok(None),
    LensSource::Sony(params) => sony(params),
    LensSource::Fuji(params) => fuji(
      params,
      &meta.model,
      [meta.crop_width, meta.crop_height],
      fuji_ibis_shift,
    ),
  }
}

fn sony(params: &LensParams) -> Result<Option<WarpRectilinear>> {
  let Some(values) = &params.chromatic_aberration else {
    return Ok(None);
  };
  let count = values.first().copied().unwrap_or(0.0);
  if !count.is_finite()
    || count.fract() != 0.0
    || !(8.0..=32.0).contains(&count)
    || count as usize % 2 != 0
  {
    return Err(Error::Malformed("Adobe Sony CA: invalid knot count".into()));
  }
  let n = count as usize / 2;
  if values.len() < 1 + 2 * n || values[1..1 + 2 * n].iter().any(|v| !v.is_finite()) {
    return Err(Error::Malformed(
      "Adobe Sony CA: incomplete or nonfinite knots".into(),
    ));
  }
  let radii: Vec<f64> = (0..n).map(|i| i as f64 / (n - 1) as f64).collect();
  let curve = |offset: usize| -> Result<[f64; 4]> {
    let values = &values[offset..offset + n];
    if values.iter().all(|&v| v == 0.0) {
      return Ok([1.0, 0.0, 0.0, 0.0]);
    }
    let targets: Vec<f64> = values
      .iter()
      .zip(&radii)
      .map(|(&v, &r)| {
        let delta = (v / 16384.0).mul_add(0.01, 1.0) - 1.0;
        r * delta.mul_add(0.8, 1.0)
      })
      .collect();
    fit(&radii, &targets)
  };
  Ok(Some(WarpRectilinear {
    radial: [curve(1)?, [1.0, 0.0, 0.0, 0.0], curve(1 + n)?],
    center: [0.5, 0.5],
  }))
}

fn fuji(
  params: &LensParams,
  model: &str,
  active: [usize; 2],
  ibis_shift: Option<[i32; 2]>,
) -> Result<Option<WarpRectilinear>> {
  let Some(values) = &params.chromatic_aberration else {
    return Ok(None);
  };
  // These are the two X-Trans cameras supported by the Adobe demosaicer. Older
  // Fuji bodies have additional CA adjustment rules, so do not infer support.
  let shift_limit = match model.trim() {
    "X100VI" => 1490,
    "X-E5" => 2930,
    _ => {
      return Err(Error::Unsupported(format!(
        "Adobe embedded CA: unsupported Fuji {model}"
      )));
    }
  };
  if values.len() < 29
    || values[..29].iter().any(|v| !v.is_finite())
    || active.contains(&0)
    || values[1..10].iter().any(|&r| r <= 0.0)
    || values[1..10].windows(2).any(|r| r[0] >= r[1])
  {
    return Err(Error::Malformed(
      "Adobe Fuji CA: invalid nine-knot table or active area".into(),
    ));
  }
  let radii = &values[1..10];
  let curve = |offset: usize| -> Result<[f64; 4]> {
    let values = &values[offset..offset + 9];
    if values.iter().all(|&v| v == 0.0) {
      return Ok([1.0, 0.0, 0.0, 0.0]);
    }
    let targets: Vec<f64> = values
      .iter()
      .zip(radii)
      .map(|(&v, &r)| r * (v + 1.0))
      .collect();
    fit(radii, &targets)
  };
  let mut center = [0.5, 0.5];
  if let Some(shift) =
    ibis_shift.filter(|s| s.iter().all(|&v| (-shift_limit..=shift_limit).contains(&v)))
  {
    for c in 0..2 {
      center[c] += (f64::from(shift[c]) / 10.0) / active[c] as f64;
    }
  }
  Ok(Some(WarpRectilinear {
    radial: [curve(10)?, [1.0, 0.0, 0.0, 0.0], curve(19)?],
    center,
  }))
}

/// Householder QR avoids squaring the condition number of the four-column fit.
pub(super) fn fit(radii: &[f64], targets: &[f64]) -> Result<[f64; 4]> {
  let mut a: Vec<[f64; 4]> = radii
    .iter()
    .map(|&r| [r, r.powf(3.0), r.powf(5.0), r.powf(7.0)])
    .collect();
  let mut b = targets.to_vec();
  for k in 0..4 {
    let norm = a[k..].iter().map(|r| r[k] * r[k]).sum::<f64>().sqrt();
    if norm == 0.0 || !norm.is_finite() {
      return Err(Error::Malformed(
        "Adobe embedded CA: singular knot table".into(),
      ));
    }
    let alpha = -norm.copysign(a[k][k]);
    let mut v: Vec<f64> = a[k..].iter().map(|r| r[k]).collect();
    v[0] -= alpha;
    let beta = 2.0 / v.iter().map(|x| x * x).sum::<f64>();
    for j in k..4 {
      let projection = beta * v.iter().zip(&a[k..]).map(|(&v, r)| v * r[j]).sum::<f64>();
      for (r, &v) in a[k..].iter_mut().zip(&v) {
        r[j] -= projection * v;
      }
    }
    let projection = beta * v.iter().zip(&b[k..]).map(|(&v, &b)| v * b).sum::<f64>();
    for (b, &v) in b[k..].iter_mut().zip(&v) {
      *b -= projection * v;
    }
    a[k][k] = alpha;
  }
  let mut result = [0.0; 4];
  for k in (0..4).rev() {
    let residual = b[k] - (k + 1..4).map(|j| a[k][j] * result[j]).sum::<f64>();
    result[k] = residual / a[k][k];
  }
  Ok(result)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sony_count_is_combined_and_padding_is_ignored() {
    let mut values = vec![8.0];
    values.extend_from_slice(&[0.0; 8]);
    values.extend_from_slice(&[f64::NAN; 24]);
    let params = LensParams {
      chromatic_aberration: Some(values),
      ..LensParams::default()
    };
    let warp = sony(&params).unwrap().unwrap();
    assert_eq!(warp.radial, [[1.0, 0.0, 0.0, 0.0]; 3]);
  }

  #[test]
  fn fuji_out_of_range_shift_discards_both_axes() {
    let mut values = vec![1.0];
    values.extend((1..10).map(|v| v as f64 / 9.0));
    values.extend_from_slice(&[0.0; 19]);
    let params = LensParams {
      chromatic_aberration: Some(values),
      ..LensParams::default()
    };
    let warp = fuji(&params, "X100VI", [7728, 5152], Some([1491, 100]))
      .unwrap()
      .unwrap();
    assert_eq!(warp.center, [0.5, 0.5]);
    let warp = fuji(&params, "X100VI", [7728, 5152], Some([1490, -1490]))
      .unwrap()
      .unwrap();
    assert_eq!(warp.center, [0.5 + 149.0 / 7728.0, 0.5 - 149.0 / 5152.0]);
  }

  #[test]
  fn fixture_ratio_tables_match_exactly() {
    // Local oracle produced from original camera tags plus Converter OpcodeList3.
    let Some(path) = std::env::var_os("RAW_DEVELOP_ADOBE_CA_ORACLE") else {
      return;
    };
    let cases: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for case in cases.as_array().unwrap() {
      let values = case["values_bits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| f64::from_bits(v.as_u64().unwrap()))
        .collect();
      let params = LensParams {
        chromatic_aberration: Some(values),
        ..LensParams::default()
      };
      let warp = if case["kind"] == "sony" {
        sony(&params).unwrap().unwrap()
      } else {
        let active = std::array::from_fn(|c| case["active"][c].as_u64().unwrap() as usize);
        let shift = std::array::from_fn(|c| case["shift"][c].as_i64().unwrap() as i32);
        fuji(
          &params,
          case["model"].as_str().unwrap(),
          active,
          Some(shift),
        )
        .unwrap()
        .unwrap()
      };
      for c in 0..2 {
        assert_eq!(
          warp.center[c],
          f64::from_bits(case["center_bits"][c].as_u64().unwrap()),
          "{} center",
          case["name"]
        );
      }
      for c in [0, 2] {
        let expected: [f64; 4] =
          std::array::from_fn(|i| f64::from_bits(case["radial_bits"][c][i].as_u64().unwrap()));
        let lut = |k: [f64; 4], i: usize| {
          let r2 = i as f64 * (1.0 / 8191.0);
          (r2.mul_add(r2.mul_add(r2.mul_add(k[3], k[2]), k[1]), k[0]) as f32).to_bits()
        };
        for i in 0..8192 {
          assert_eq!(
            lut(warp.radial[c], i),
            lut(expected, i),
            "{} channel {c} index {i}",
            case["name"]
          );
        }
      }
    }
  }
}
