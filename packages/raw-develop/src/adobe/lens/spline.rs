//! Adobe's monotone illumination spline. The slope construction follows
//! Converter 18.7's `dng_monotone_spline_solver::Solve`; evaluation follows the
//! public DNG SDK's cubic segment, with the observed ARM64 FMA grouping.

use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub(super) struct MonotoneSpline {
  pub(super) x: Vec<f64>,
  pub(super) y: Vec<f64>,
  pub(super) slopes: Vec<f64>,
}

impl MonotoneSpline {
  pub(super) fn illumination(mut points: Vec<[f64; 2]>) -> Result<Self> {
    if points.len() < 2
      || points
        .iter()
        .any(|p| !p[0].is_finite() || !p[1].is_finite() || p[0] < 0.0 || p[1] > 1.0)
      || points
        .windows(2)
        .any(|p| p[0][0] >= p[1][0] || p[0][1] < p[1][1])
    {
      return Err(Error::Malformed(
        "Adobe vignette: invalid illumination knots".into(),
      ));
    }
    if points[0][0] != 0.0 {
      points.insert(0, [0.0, 1.0]);
    }
    // A constant segment is made very slightly decreasing before solving. This
    // is part of MakePiecewiseVignetteFunction, not the monotone solver itself.
    for i in 1..points.len() {
      if points[i - 1][1] <= points[i][1] {
        points[i][1] = points[i - 1][1] * 0.999999;
      }
    }
    let x: Vec<f64> = points.iter().map(|p| p[0]).collect();
    let y: Vec<f64> = points.iter().map(|p| p[1]).collect();
    let secants: Vec<f64> = points
      .windows(2)
      .map(|p| (p[1][1] - p[0][1]) / (p[1][0] - p[0][0]))
      .collect();
    let n = x.len();
    let mut slopes = vec![0.0; n];
    slopes[0] = secants[0];
    slopes[n - 1] = secants[n - 2];
    for i in 1..n - 1 {
      slopes[i] = (secants[i - 1] + secants[i]) * 0.5;
    }
    for i in 0..n - 1 {
      let d = secants[i];
      let a = slopes[i] / d;
      let b = slopes[i + 1] / d;
      if d == 0.0 || a == 0.0 || b == 0.0 {
        slopes[i] = 0.0;
        slopes[i + 1] = 0.0;
      } else {
        let norm = a.mul_add(a, b * b);
        if norm > 9.0 {
          let scale = 3.0 / norm.sqrt();
          slopes[i] *= scale;
          slopes[i + 1] *= scale;
        }
      }
    }
    Ok(Self { x, y, slopes })
  }

  pub(super) fn evaluate(&self, value: f64) -> f64 {
    let n = self.x.len();
    if value <= self.x[0] {
      return self.y[0];
    }
    if value >= self.x[n - 1] {
      return self.y[n - 1];
    }
    let mut lo = 1;
    let mut hi = n - 1;
    while hi > lo {
      let mid = (lo + hi) >> 1;
      if value == self.x[mid] {
        return self.y[mid];
      }
      if value > self.x[mid] {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let i = lo;
    let a = self.x[i] - self.x[i - 1];
    let b = (value - self.x[i - 1]) / a;
    let c = (self.x[i] - value) / a;
    let left = self.y[i - 1].mul_add(b + (2.0 - c), b * (a * self.slopes[i - 1]));
    let right = self.y[i].mul_add(c + (2.0 - b), -(c * (a * self.slopes[i])));
    left.mul_add(c * c, (b * b) * right)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn captured_illumination_slopes_match() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_LENS_TRACE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let doubles = |p: &std::path::Path| -> Vec<f64> {
      std::fs::read(p)
        .unwrap()
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect()
    };
    let mut checked = 0;
    for item in std::fs::read_dir(root).unwrap() {
      let item = item.unwrap();
      let name = item.file_name().to_string_lossy().into_owned();
      let Some(stem) = name.strip_suffix("_solver.bin") else {
        continue;
      };
      let x = doubles(&root.join(format!("{stem}_x.bin")));
      let y = doubles(&root.join(format!("{stem}_y.bin")));
      let s = doubles(&root.join(format!("{stem}_s.bin")));
      let actual =
        MonotoneSpline::illumination(x.iter().zip(&y).map(|(&x, &y)| [x, y]).collect()).unwrap();
      assert_eq!(actual.x, x);
      assert_eq!(actual.y, y);
      assert_eq!(actual.slopes, s);
      checked += 1;
    }
    assert!(checked > 0, "capture must contain an illumination spline");
  }
}
