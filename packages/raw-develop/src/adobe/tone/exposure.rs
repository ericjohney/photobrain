//! Process Version 2012 exposure state and the global SDR pointwise CPU stage.
//!
//! State transitions: AdjustForBaselineExposureAndHighlightRecovery 0x100e531dc,
//! CalculateExposure2012 0x1009886e8. Kernel: RefExposure32_2012_Global_Full
//! 0x101448324. Statistics come from the separate upstream statistics render.

use super::curves::{Brightness, Table, Whites};

#[derive(Clone, Copy, Debug, Default)]
pub struct Statistics {
  /// `cr_exposure_info + 0x658`, used to split linear and curved black removal.
  pub black_reference: f64,
  /// `+0x670` and `+0x678`, used to choose the plus-Whites clipping point.
  pub whites_low: f64,
  pub whites_high: f64,
  /// `+0x690`, used to split linear exposure from highlight rolloff.
  pub highlight_reference: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Info {
  pub exposure: f64,              // +0x08
  pub tone_exposure: f64,         // +0x18
  pub baseline_adjustment: f64,   // +0x28
  pub channel_flare: [f64; 3],    // +0x30,+0x38,+0x40
  pub baseline: f64,              // +0x50
  pub ai_amount: f64,             // +0x58 (zero for ordinary DCP rendering)
  pub input_scale: f64,           // +0x60
  pub whites: f64,                // +0x80 (Whites2012 slider * 0.02)
  pub highlight_headroom: f64,    // +0x88
  pub input_exposure: f64,        // +0x90
  pub linear_exposure: f64,       // +0x98
  pub rolloff_exposure: f64,      // +0xa0
  pub total_exposure: f64,        // +0xa8
  pub whites_amount: f64,         // +0xb0
  pub highlight_luma_offset: f64, // +0xb8
  pub statistics: Statistics,
  pub hdr: bool,
}

impl Info {
  /// Run after the camera-input stage has supplied the two exposure adjustments.
  /// The first argument is recorded; the second enters the camera-gain algebra.
  pub fn adjust(&mut self, baseline_adjustment: f64, input_exposure: f64) {
    self.baseline_adjustment = baseline_adjustment;
    let total = (input_exposure + self.exposure) + self.baseline;
    self.input_scale = (input_exposure + self.baseline).exp2();
    let (mut linear, mut rolloff) = (0.0, 0.0);
    if total > 0.0 {
      linear = if self.hdr {
        total
      } else {
        input_exposure + self.highlight_headroom
      }
      .min(total)
        + 0.0;
      rolloff = total - linear;
    }
    let mut whites_amount = if self.whites < 0.0 { -self.whites } else { 0.0 };
    if self.whites > 0.0 {
      let moved = rolloff.min(self.whites);
      linear += moved;
      rolloff -= moved;
      whites_amount = -self.whites;
    }
    if total < 0.0 {
      let mut negative = if self.hdr { 0.0 } else { total };
      if self.hdr {
        linear += total;
      }
      if self.ai_amount == 0.0 {
        let moved = negative.max(-1.0);
        self.tone_exposure += moved;
        negative -= moved;
      }
      linear += negative;
    }
    self.input_exposure = input_exposure;
    self.linear_exposure = linear;
    self.rolloff_exposure = rolloff;
    self.total_exposure = (rolloff + linear) - input_exposure;
    self.whites_amount = whites_amount;
    self.baseline = 0.0;
  }

  /// Refine the exposure split once image statistics are available. The stage's
  /// private model copies Info before applying this transition.
  pub fn calculate(&mut self) {
    let total = self.linear_exposure + self.rolloff_exposure;
    if total > 0.0 {
      let linear = if self.hdr {
        total
      } else {
        ((-self.statistics.highlight_reference + self.highlight_luma_offset)
          + self.ai_amount.clamp(0.0, 1.0)
          - 1.0)
          .max(0.0)
          .min(total)
      };
      self.linear_exposure = linear;
      self.rolloff_exposure = (total - linear).max(0.0);
    }
    if !self.hdr {
      if self.whites < 0.0 {
        let moved = self.linear_exposure.min(-self.whites).max(0.0);
        self.linear_exposure -= moved;
        self.rolloff_exposure += moved;
      } else if self.whites > 0.0 {
        let moved = self.rolloff_exposure.min(self.whites);
        self.linear_exposure += moved;
        self.rolloff_exposure -= moved;
      } else {
        return;
      }
    }
    self.whites_amount = -self.whites;
  }

  pub fn upstream_exposure(&self, x: f64) -> f64 {
    Brightness::new(self.rolloff_exposure)
      .linear_eval((x * self.linear_exposure.exp2()).clamp(0.0, 1.0))
  }

  pub fn whites_clip_point(&self) -> f64 {
    let s = self.statistics;
    let delta = s.whites_high - s.whites_low;
    let x = (s.whites_high - (delta / 5.0).clamp(0.0, 1.0))
      .max(delta.mul_add(0.75, s.whites_low))
      .exp2();
    let x = self.upstream_exposure(x).clamp(0.0, 1.0).min(0.5);
    ((x.ln() / std::f64::consts::LN_2)
      * (self.whites.max(0.0) * 0.5).powf(std::f64::consts::SQRT_2)
      + 0.0)
      .exp2()
  }

  pub fn upstream_exposure_and_whites(&self, x: f64) -> f64 {
    Whites::new(self.whites_amount, self.whites_clip_point()).eval(self.upstream_exposure(x))
  }
}

/// All inputs of the global SDR kernel. Tables are constructed separately so
/// each can be compared against the exact Converter table payload.
#[derive(Clone, Debug)]
pub struct Stage {
  pub gain: f32,
  pub rolloff_gain: f32,
  pub rolloff: Option<Table>,
  pub overrange_squared_gain: f32,
  pub whites_clip_squared: f32,
  pub whites_reduce: Option<Table>,
  pub blacks_subtract: Option<[Table; 3]>,
  pub blacks_lift: Option<Table>,
  pub epsilon: f32,
}

impl Stage {
  pub fn from_info(info: &Info, epsilon: f32) -> Self {
    assert!(!info.hdr, "HDR exposure uses a different CPU kernel");
    let rolloff_ev = info.rolloff_exposure.min(8.0);
    let overrange_ev = (info.rolloff_exposure - rolloff_ev).max(0.0);
    let clip = info.whites_clip_point() as f32;
    Self {
      gain: if info.linear_exposure == 0.0 {
        1.0
      } else {
        info.linear_exposure.exp2() as f32
      },
      rolloff_gain: info.rolloff_exposure.exp2().max(1.0) as f32,
      rolloff: (rolloff_ev > 0.0)
        .then(|| Table::new(4096, |x| Brightness::new(rolloff_ev).linear_eval(x))),
      overrange_squared_gain: if overrange_ev > 0.0 {
        overrange_ev.exp2().powi(2) as f32
      } else {
        1.0
      },
      whites_clip_squared: clip * clip,
      whites_reduce: (info.whites_amount > 0.0)
        .then(|| Table::new(4096, |x| Whites::new(info.whites_amount, 1.0).eval(x))),
      blacks_subtract: None,
      blacks_lift: None,
      epsilon,
    }
  }

  /// Scalar transcription of SIMDExposure32_2012_Global_Full's ARM64 lanes
  /// (0x10083f610). Endpoint transforms share one middle-channel interpolation.
  pub fn pixel(&self, px: [f32; 3]) -> [f32; 3] {
    let px = px.map(|x| x * self.gain);
    let lo = px[0].min(px[1]).min(px[2]);
    let hi = px[0].max(px[1]).max(px[2]);
    let mid = px[0].min(px[1]).max(px[2]).min(px[0].max(px[1]));
    let transform = |mut x: f32| {
      if self.whites_clip_squared < 1.0 {
        let v = x * self.rolloff_gain;
        let a = v * reciprocal(v + 1.0);
        let b = v.mul_add(reciprocal(self.whites_clip_squared), 1.0);
        x = (b * a) * reciprocal(self.rolloff_gain);
      }
      x = x.min(1.0);
      if self.rolloff_gain > 1.0 {
        if let Some(table) = &self.rolloff {
          x = table.eval_simd(x);
        }
      }
      if self.overrange_squared_gain > 1.0 {
        let squared = x * x;
        let num = squared * self.overrange_squared_gain;
        let den = squared.mul_add(self.overrange_squared_gain - 1.0, 1.0);
        x = (num * reciprocal(den)).sqrt();
      }
      x
    };
    let a = transform(lo);
    let b = transform(hi);
    let position = (mid - lo) * reciprocal((hi - lo).max(self.epsilon));
    let middle = a + (b - a) * position;
    let mut px = px.map(|x| {
      if x == lo {
        a
      } else if x == hi {
        b
      } else {
        middle
      }
    });
    if let Some(table) = &self.whites_reduce {
      self.apply_ratio(&mut px, table);
    }
    if let Some(tables) = &self.blacks_subtract {
      px = std::array::from_fn(|i| tables[i].eval_simd(px[i]));
    }
    if let Some(table) = &self.blacks_lift {
      self.apply_ratio(&mut px, table);
      px = px.map(|x| x.min(1.0));
    }
    px
  }

  fn apply_ratio(&self, px: &mut [f32; 3], table: &Table) {
    // Green contributes twice, with the source routine's addition order.
    let luma = ((px[1] + px[2]) + px[1] + px[0]) * 0.25;
    let gain = reciprocal(luma.max(self.epsilon)) * table.eval_simd(luma);
    *px = px.map(|x| x * gain);
  }
}

#[inline]
fn reciprocal(x: f32) -> f32 {
  if x == 0.0 { 0.0 } else { 1.0 / x }
}
