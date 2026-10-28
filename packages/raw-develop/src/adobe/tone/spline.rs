//! Natural cubic spline used for `ProfileToneCurve` by Converter 18.7.
//!
//! Reconstructed from `dng_spline_solver::Solve` (0x1013415c4) and Evaluate
//! (0x101341aec), including the ARM64 fused operation order. The public DNG SDK
//! describes the same tridiagonal slope solve; knots are never image-fitted.

#[derive(Clone, Debug)]
pub struct Spline {
  x: Vec<f64>,
  y: Vec<f64>,
  slopes: Vec<f64>,
}

impl Spline {
  pub fn new(points: &[(f64, f64)]) -> Self {
    assert!(points.len() >= 2, "spline requires at least two knots");
    assert!(points.windows(2).all(|p| p[0].0 < p[1].0));
    let (x, y): (Vec<_>, Vec<_>) = points.iter().copied().unzip();
    let n = x.len();
    let mut slopes = vec![0.0; n];
    let mut width = x[1] - x[0];
    let mut slope = (y[1] - y[0]) / width;
    slopes[0] = slope;
    for j in 2..n {
      let next_width = x[j] - x[j - 1];
      let next_slope = (y[j] - y[j - 1]) / next_width;
      slopes[j - 1] = slope.mul_add(next_width, width * next_slope) / (width + next_width);
      width = next_width;
      slope = next_slope;
    }
    slopes[n - 1] = slope.mul_add(2.0, -slopes[n - 2]);
    slopes[0] = slopes[0].mul_add(2.0, -slopes[1]);
    if n > 2 {
      let mut e = vec![0.0; n];
      let mut f = vec![0.0; n];
      let mut g = vec![0.0; n];
      f[0] = 0.5;
      e[n - 1] = 0.5;
      g[0] = (slopes[0] + slopes[1]) * 0.75;
      g[n - 1] = (slopes[n - 2] + slopes[n - 1]) * 0.75;
      for j in 1..n - 1 {
        let span = x[j + 1] - x[j - 1];
        let a = span + span;
        e[j] = (x[j + 1] - x[j]) / a;
        f[j] = (x[j] - x[j - 1]) / a;
        g[j] = slopes[j] * 1.5;
      }
      for j in 1..n {
        let a = (-f[j - 1]).mul_add(e[j], 1.0);
        if j != n - 1 {
          f[j] /= a;
        }
        g[j] = (-g[j - 1]).mul_add(e[j], g[j]) / a;
      }
      for j in (0..n - 1).rev() {
        g[j] = (-f[j]).mul_add(g[j + 1], g[j]);
      }
      slopes = g;
    }
    Self { x, y, slopes }
  }

  pub fn from_dcp(points: &[(f32, f32)]) -> Self {
    Self::new(
      &points
        .iter()
        .map(|&(x, y)| (x as f64, y as f64))
        .collect::<Vec<_>>(),
    )
  }

  pub fn eval(&self, value: f64) -> f64 {
    if value <= self.x[0] {
      return self.y[0];
    }
    let mut hi = self.x.len() - 1;
    if value >= self.x[hi] {
      return self.y[hi];
    }
    let mut lo = 1;
    while hi > lo {
      let mid = (hi + lo) >> 1;
      if value == self.x[mid] {
        return self.y[mid];
      }
      if self.x[mid] < value {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let hi = lo;
    let lo = hi - 1;
    let span = self.x[hi] - self.x[lo];
    let t = (value - self.x[lo]) / span;
    let u = (self.x[hi] - value) / span;
    let left = self.y[lo].mul_add(t + (2.0 - u), t * (span * self.slopes[lo]));
    let right = self.y[hi].mul_add(u + (2.0 - t), -(u * (span * self.slopes[hi])));
    left.mul_add(u * u, (t * t) * right)
  }
}

#[cfg(test)]
mod tests {
  use super::Spline;

  #[test]
  fn spline_matches_native_f64_payloads() {
    // Four synthetic knot sets; each hash covers 4,097 native f64 samples.
    let fixtures: &[(&[(f64, f64)], u64)] = &[
      (&[(0.0, 0.0), (1.0, 1.0)], 0x1b96b773474e5bfd),
      (&[(0.0, 0.0), (0.2, 0.1), (1.0, 1.0)], 0x92f15d2e0794766d),
      (
        &[
          (0.0, 0.0),
          (0.01, 0.02),
          (0.25, 0.4),
          (0.6, 0.8),
          (1.0, 1.0),
        ],
        0xd2911b8034f25338,
      ),
      (
        &[
          (0.0, 0.0),
          (0.05, 0.01),
          (0.3, 0.22),
          (0.5, 0.7),
          (0.77, 0.98),
          (1.0, 1.0),
        ],
        0x9360de10d06bb4bf,
      ),
    ];
    for &(points, expected) in fixtures {
      let spline = Spline::new(points);
      let actual = (0..=4096)
        .map(|i| spline.eval(i as f64 * (1.0 / 4096.0)))
        .flat_map(f64::to_le_bytes)
        .fold(0xcbf29ce484222325u64, |h, b| {
          (h ^ b as u64).wrapping_mul(0x100000001b3)
        });
      assert_eq!(actual, expected);
    }
  }
}
