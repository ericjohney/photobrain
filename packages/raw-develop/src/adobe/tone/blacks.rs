//! Blacks2012 for mosaic RAW files with ordinary non-HDR DCP profiles.
//!
//! BuildBlacksCurves2012 0x100987c28; MapParamToFlare 0x100987914;
//! cr_black_subtract_curve/black_bezier_curve 0x10098bc00/0x10098bc80.
//! The special legacy Camera profiles and AI Look mixing are explicit inputs.

use super::{
  curves::{Table, srgb_decode, srgb_encode},
  exposure::{Info, Stage},
};

#[derive(Clone, Copy, Debug)]
struct Bezier {
  x: [f64; 3],
  y: [f64; 3],
}

fn unit_root(a: f64, b: f64, c: f64) -> f64 {
  if a == 0.0 {
    if b != 0.0 {
      let r = -c / b;
      if (0.0..=1.0).contains(&r) {
        return r;
      }
    }
  } else {
    let d = (a * -4.0).mul_add(c, b * b);
    if d >= 0.0 {
      let q = (b + d.sqrt() * if b < 0.0 { -1.0 } else { 1.0 }) * -0.5;
      for r in [q / a, c / q] {
        if (0.0..=1.0).contains(&r) {
          return r;
        }
      }
    }
  }
  0.0
}

impl Bezier {
  fn eval(self, x: f64) -> f64 {
    if x <= self.x[0] {
      return self.y[0];
    }
    if x >= self.x[2] {
      return self.y[2];
    }
    let t = unit_root(
      self.x[1].mul_add(-2.0, self.x[0]) + self.x[2],
      self.x[0].mul_add(-2.0, self.x[1] + self.x[1]),
      self.x[0] - x,
    );
    let u = 1.0 - t;
    let a = (u * self.y[0]) * u;
    let b = (u * t).mul_add(self.y[1] + self.y[1], a);
    (t * t).mul_add(self.y[2], b)
  }

  fn from_slopes(x0: f64, y0: f64, slope0: f64, y2: f64, slope2: f64) -> Self {
    let (x1, y1) = if (slope0 - slope2).abs() < 1e-8 {
      ((x0 + 1.0) * 0.5, (y0 + y2) * 0.5)
    } else {
      let x1 = (y2 + (slope0.mul_add(x0, -slope2) - y0)) / (slope0 - slope2);
      (x1, slope0.mul_add(x1, y0))
    };
    Self {
      x: [x0, x1, 1.0],
      y: [y0, y1, y2],
    }
  }
}

fn map_param_to_flare(value: f64, start: f64, midpoint: f64, default: f64, max: f64) -> f64 {
  if value <= midpoint {
    return (value - start) * ((0.0 - default) / (start - midpoint)) + 0.0;
  }
  let a = default / (midpoint - start);
  let b = (max - default) / (1.0 - midpoint);
  let curve = if b <= a {
    Bezier::from_slopes(midpoint, default, a, max, if b == a { b } else { 0.0 })
  } else {
    let slope = (b.atan() + (b.atan() - a.atan())).tan();
    let top = ((max - default) + a * midpoint) - slope * 1.5 + 1e-8;
    let bottom = (a - slope * 1.5) + 1e-8;
    let x1 = (top / bottom).min(1.0 - 1e-8).max(midpoint + 1e-8);
    Bezier {
      x: [midpoint, x1, 1.0],
      y: [default, (x1 - midpoint).mul_add(a, default), max],
    }
  };
  curve.eval(value)
}

#[derive(Clone, Copy, Debug)]
pub struct Subtract {
  pub line: f64,
  pub curved: f64,
  pub soften: f64,
}

impl Subtract {
  pub fn eval(self, x: f64) -> f64 {
    let line_slope = if self.line == 1.0 {
      0.0
    } else {
      -1.0 / (self.line - 1.0)
    };
    let x = ((x - self.line) * line_slope + 0.0).clamp(0.0, 1.0);
    let slope = if self.curved == 1.0 {
      0.0
    } else {
      -1.0 / (self.curved - 1.0)
    };
    let start = self.curved * self.soften;
    let middle = self.curved + (1.0 - self.curved) * 0.5;
    if x <= start {
      return 0.0;
    }
    if x >= middle {
      return (x - self.curved).mul_add(slope, 0.0);
    }
    Bezier {
      x: [start, self.curved, middle],
      y: [0.0, 0.0, (middle - self.curved).mul_add(slope, 0.0)],
    }
    .eval(x)
  }
}

#[derive(Clone, Debug)]
pub struct Blacks {
  pub subtract: Option<[Subtract; 3]>,
  pub lift_fraction: Option<f64>,
}

impl Blacks {
  /// `legacy_camera_default` is present only for the explicitly recognised
  /// non-HDR "Camera ..." profile family; ordinary Adobe Standard uses 0.005.
  /// `ai_mix` is None for ordinary DCP rendering, otherwise adjust+0x23c * -0.01.
  pub fn mosaic(
    info: &Info,
    slider: i32,
    legacy_camera_default: Option<f64>,
    ai_mix: Option<f64>,
  ) -> Self {
    let mut amount = (slider as f64 * -0.01).clamp(-1.0, 1.0);
    if let Some(ai) = ai_mix {
      let weight = if amount > 0.0 {
        (1.0 - amount) * 0.25
      } else {
        0.25
      };
      amount = weight.mul_add(ai, amount).clamp(-1.0, 1.0);
    }
    let s = info.statistics;
    let black_anchor = ((s.highlight_reference - s.black_reference)
      .mul_add(0.5, s.black_reference))
    .min(s.black_reference + 2.0)
    .exp2();
    let maximum = info
      .upstream_exposure_and_whites(black_anchor)
      .clamp(0.0, 1.0)
      .clamp(0.0625, 0.9);
    let (lift, flare) = if amount < -0.25 {
      ((amount + 1.0).mul_add(-4.0 / 3.0, 1.0), 0.0)
    } else if amount > -0.25 {
      (
        0.0,
        map_param_to_flare(
          amount,
          -0.25,
          0.0,
          legacy_camera_default.unwrap_or(0.005),
          maximum,
        ),
      )
    } else {
      (0.0, 0.0)
    };
    let gain = info.total_exposure.exp2();
    let total = info.channel_flare.map(|x| {
      let x = gain * x;
      ((flare + x) - x * flare).min(0.99)
    });
    let subtract = if total.iter().any(|&x| x > 0.0) {
      let linear_limit =
        info.upstream_exposure_and_whites(s.black_reference.exp2() / std::f64::consts::SQRT_2);
      let soften = (amount * 2.0 + 0.0).clamp(0.0, 0.5);
      Some(total.map(|x| {
        let line = x.min(linear_limit);
        Subtract {
          line,
          curved: (x - line).max(0.0),
          soften,
        }
      }))
    } else {
      None
    };
    Self {
      subtract,
      lift_fraction: (lift > 0.0).then_some(lift * 0.25),
    }
  }

  pub fn apply(&self, stage: &mut Stage) {
    stage.blacks_subtract = self
      .subtract
      .map(|curves| curves.map(|f| Table::new(4096, |x| f.eval(x))));
    stage.blacks_lift = self
      .lift_fraction
      .map(|f| Table::new(4096, |x| lift_eval(f, x)));
  }
}

/// Black lift's fill-light function uses zero local exposure and zero highlight
/// compression. Keep its sRGB round-trip, as in the actual composed functions.
pub fn lift_eval(fraction: f64, x: f64) -> f64 {
  let shape = fraction.mul_add(-2.0, 4.0).min(3.0);
  let v = srgb_decode(srgb_encode(x));
  let a = (-(shape + fraction * 4.0)).exp2();
  let b = (-shape).exp2();
  let ratio = ((v + b) / (b + 1.0)) / ((v + a) / (a + 1.0));
  let lifted = x * ratio;
  x.mul_add(x - lifted, lifted)
}
