//! Four-level CR6 luminance filtering in the signed 16-bit noise-flattened space.
//!
//! Independently implemented from the 18.7 CPU stage boundaries: feature
//! classification, marker diffusion, sixteen directional stencils, bilateral
//! smoothing, and low-pass reconstruction. Integer rounding and scalar/vector
//! floating-point association are observable parts of those boundaries.

pub(crate) struct Parameters {
  pub(crate) feature: [f32; 4],
  pub(crate) feature_low: [f32; 4],
  pub(crate) smoothing: [f32; 4],
  pub(crate) blend: [f32; 4],
}

impl Parameters {
  /// Full-resolution mosaic RAW controls, in normalized integer-slider units.
  /// Noise is selected before the CR6 flattening offset floor, as in chroma NR.
  pub(crate) fn new(
    model: &str,
    iso: u32,
    noise_gain: f64,
    amount: f64,
    detail: f64,
    contrast: f64,
  ) -> Option<Self> {
    if [amount, detail, contrast]
      .iter()
      .any(|v| !(0.0..=1.0).contains(v))
    {
      return None;
    }
    let noise = super::noise::selected_sensor_noise(model, iso, noise_gain)?.normalization;
    let detail_factor = if detail <= 0.5 {
      2.0 - (detail + detail).clamp(0.0, 1.0)
    } else {
      ((detail - 0.5) + (detail - 0.5))
        .clamp(0.0, 1.0)
        .mul_add(-0.5, 1.0)
    };
    let sigma = noise * 65535.0 * detail_factor;
    let first_blend = if amount <= 0.25 {
      (amount + amount).clamp(0.0, 0.5)
    } else {
      ((amount - 0.25) / 0.75).clamp(0.0, 1.0).mul_add(0.5, 0.5)
    };
    let last_blend = if contrast <= 0.5 {
      (contrast + contrast).clamp(0.0, 1.0).mul_add(-0.5, 1.0)
    } else {
      ((contrast - 0.5) + (contrast - 0.5))
        .clamp(0.0, 1.0)
        .mul_add(-0.5, 0.5)
    };
    let blend = [
      first_blend,
      (last_blend - first_blend).mul_add(0.33, first_blend),
      (last_blend - first_blend).mul_add(0.66, first_blend),
      last_blend,
    ]
    .map(|v| v as f32);
    let scales = [1.0, 0.43, 0.21, 0.12];
    Some(Self {
      feature: scales.map(|s| ((sigma * s) * 4.0 * 1.414) as f32),
      feature_low: scales.map(|s| ((sigma * s) * 4.0) as f32),
      smoothing: scales.map(|s| {
        let v = (sigma * s) * 5.0;
        (-1.0 / (v * v)) as f32
      }),
      blend,
    })
  }
}

pub(crate) const HALO: usize = 158;
type Rect = [usize; 4];

struct Plane {
  data: Vec<i16>,
  width: usize,
  height: usize,
}

impl Plane {
  fn new(width: usize, height: usize) -> Self {
    Self {
      data: vec![0; width * height],
      width,
      height,
    }
  }
  #[inline]
  fn get(&self, y: usize, x: usize) -> i32 {
    self.data[y * self.width + x] as i32
  }
  #[inline]
  fn offset(&self, y: usize, x: usize, dy: isize, dx: isize) -> i32 {
    self.get(y.wrapping_add_signed(dy), x.wrapping_add_signed(dx))
  }
  fn set(&mut self, y: usize, x: usize, value: i32) {
    self.data[y * self.width + x] = value as i16;
  }
}

fn expand([t, l, b, r]: Rect, n: usize) -> Rect {
  [t - n, l - n, b + n, r + n]
}
fn inset([t, l, b, r]: Rect, n: usize) -> Rect {
  [t + n, l + n, b - n, r - n]
}
fn each([t, l, b, r]: Rect, mut f: impl FnMut(usize, usize)) {
  for y in t..b {
    for x in l..r {
      f(y, x);
    }
  }
}

const DIRECTIONS: [[(isize, isize); 8]; 16] = [
  [
    (-4, 0),
    (-3, 0),
    (-2, 0),
    (-1, 0),
    (1, 0),
    (2, 0),
    (3, 0),
    (4, 0),
  ],
  [
    (0, -4),
    (0, -3),
    (0, -2),
    (0, -1),
    (0, 1),
    (0, 2),
    (0, 3),
    (0, 4),
  ],
  [
    (-4, 4),
    (-3, 3),
    (-2, 2),
    (-1, 1),
    (1, -1),
    (2, -2),
    (3, -3),
    (4, -4),
  ],
  [
    (-4, -4),
    (-3, -3),
    (-2, -2),
    (-1, -1),
    (1, 1),
    (2, 2),
    (3, 3),
    (4, 4),
  ],
  [
    (-4, 2),
    (-3, 2),
    (-2, 1),
    (-1, 1),
    (1, -1),
    (2, -1),
    (3, -2),
    (4, -2),
  ],
  [
    (-4, -2),
    (-3, -2),
    (-2, -1),
    (-1, -1),
    (1, 1),
    (2, 1),
    (3, 2),
    (4, 2),
  ],
  [
    (2, -4),
    (2, -3),
    (1, -2),
    (1, -1),
    (-1, 1),
    (-1, 2),
    (-2, 3),
    (-2, 4),
  ],
  [
    (-2, -4),
    (-2, -3),
    (-1, -2),
    (-1, -1),
    (1, 1),
    (1, 2),
    (2, 3),
    (2, 4),
  ],
  [
    (-4, 1),
    (-3, 1),
    (-2, 1),
    (-1, 0),
    (1, 0),
    (2, -1),
    (3, -1),
    (4, -1),
  ],
  [
    (-4, -1),
    (-3, -1),
    (-2, -1),
    (-1, 0),
    (1, 0),
    (2, 1),
    (3, 1),
    (4, 1),
  ],
  [
    (-4, 3),
    (-3, 2),
    (-2, 2),
    (-1, 1),
    (1, -1),
    (2, -2),
    (3, -2),
    (4, -3),
  ],
  [
    (-4, -3),
    (-3, -2),
    (-2, -2),
    (-1, -1),
    (1, 1),
    (2, 2),
    (3, 2),
    (4, 3),
  ],
  [
    (3, -4),
    (2, -3),
    (2, -2),
    (1, -1),
    (-1, 1),
    (-2, 2),
    (-2, 3),
    (-3, 4),
  ],
  [
    (-3, -4),
    (-2, -3),
    (-2, -2),
    (-1, -1),
    (1, 1),
    (2, 2),
    (2, 3),
    (3, 4),
  ],
  [
    (1, -4),
    (1, -3),
    (1, -2),
    (0, -1),
    (0, 1),
    (-1, 2),
    (-1, 3),
    (-1, 4),
  ],
  [
    (-1, -4),
    (-1, -3),
    (-1, -2),
    (0, -1),
    (0, 1),
    (1, 2),
    (1, 3),
    (1, 4),
  ],
];
const NEIGHBORS: [(isize, isize); 8] = [
  (-1, -1),
  (-1, 0),
  (-1, 1),
  (0, -1),
  (0, 1),
  (1, -1),
  (1, 0),
  (1, 1),
];

fn features(src: &Plane, dst: &mut Plane, area: Rect, high: f32, low: f32) {
  let high = high.round().clamp(-32768.0, 32767.0) as i32;
  let low = low.round().clamp(-32768.0, 32767.0) as i32;
  each(area, |y, x| {
    let center = src.get(y, x);
    let delta = [
      (-3, 0),
      (-2, -2),
      (-2, 2),
      (0, -3),
      (0, 3),
      (2, -2),
      (2, 2),
      (3, 0),
    ]
    .into_iter()
    .map(|(dy, dx)| (center - src.offset(y, x, dy, dx)).abs().min(32767))
    .max()
    .unwrap();
    dst.set(
      y,
      x,
      if delta > high {
        4
      } else if delta > low {
        3
      } else {
        0
      },
    );
  });
}

fn refine_features(src: &Plane, dst: &mut Plane, area: Rect) {
  each(area, |y, x| {
    let count = NEIGHBORS
      .iter()
      .filter(|&&(dy, dx)| src.offset(y, x, dy, dx) > 0)
      .count();
    let center = src.get(y, x);
    dst.set(
      y,
      x,
      if center == 0 {
        if count >= 4 { 3 } else { 0 }
      } else if count >= 2 {
        center
      } else {
        0
      },
    );
  });
}

fn record_borders(src: &Plane, dst: &mut Plane, area: Rect) {
  each(area, |y, x| {
    let mut value = 1;
    for radius in 2_isize..=4 {
      let mut empty = true;
      for dy in -radius..=radius {
        for dx in -radius..=radius {
          if dy.abs().max(dx.abs()) == radius && src.offset(y, x, dy, dx) > 0 {
            empty = false;
          }
        }
      }
      if empty {
        value = radius as i32;
        break;
      }
    }
    dst.set(y, x, value);
  });
}

fn remove_noise(src: &Plane, dst: &mut Plane, area: Rect) {
  each(area, |y, x| {
    for radius in 1_isize..=3 {
      for dy in -radius..=radius {
        for dx in -radius..=radius {
          if src.offset(y, x, dy, dx) > radius as i32 {
            dst.set(y, x, 0);
            return;
          }
        }
      }
    }
  });
}

fn diffuse(src: &Plane, dst: &mut Plane, area: Rect, k: i32) {
  each(area, |y, x| {
    let center = src.get(y, x);
    let value = if center != 0 {
      center
    } else if NEIGHBORS
      .iter()
      .any(|&(dy, dx)| src.offset(y, x, dy, dx) == k)
    {
      k - 1
    } else {
      0
    };
    dst.set(y, x, value);
  });
}

fn preliminary_directions(src: &Plane, markers: &Plane, dst: &mut Plane, area: Rect) {
  each(area, |y, x| {
    if markers.get(y, x) == 0 {
      dst.set(y, x, 0);
      return;
    }
    let center = src.get(y, x);
    let mut best = i32::MAX;
    let mut direction = 0;
    for (i, offsets) in DIRECTIONS.iter().enumerate() {
      let score = offsets
        .iter()
        .map(|&(dx, dy)| (center - src.offset(y, x, dy, dx)).abs().min(32767) >> 3)
        .sum::<i32>();
      if score < best {
        best = score;
        direction = i as i32 + 1;
      }
    }
    dst.set(y, x, direction);
  });
}

fn refine_directions(src: &Plane, dst: &mut Plane, area: Rect) {
  each(area, |y, x| {
    let center = src.get(y, x);
    if center == 0 {
      dst.set(y, x, 0);
      return;
    }
    let mut counts = [0; 17];
    for (dy, dx) in NEIGHBORS {
      counts[src.offset(y, x, dy, dx).clamp(0, 16) as usize] += 1;
    }
    let mut direction = center as usize;
    for i in 1..=16 {
      if counts[i] > counts[direction] {
        direction = i;
      }
    }
    // Among equally popular alternatives the smallest wins, while the original
    // direction is retained whenever its count ties the maximum.
    if counts[center as usize] == counts[direction] {
      direction = center as usize;
    }
    dst.set(y, x, direction as i32);
  });
}

#[inline]
fn weight(center: f32, sample: f32, coefficient: f32, scalar: bool) -> f32 {
  let delta = sample - center;
  let distance = if scalar {
    (coefficient * delta) * delta
  } else {
    (delta * delta) * coefficient
  };
  let q = distance.mul_add(0.2, 1.0);
  ((q * q) * q).clamp(0.0, 1.0)
}
#[inline]
fn round_signed(value: f32) -> i32 {
  (value + if value > 0.0 { 0.5 } else { -0.5 })
    .trunc()
    .clamp(-32768.0, 32767.0) as i32
}

fn smooth_edges(src: &Plane, directions: &Plane, dst: &mut Plane, area: Rect, coefficient: f32) {
  each(area, |y, x| {
    let direction = directions.get(y, x);
    let center = src.get(y, x) as f32;
    if direction == 0 {
      dst.set(y, x, center as i32);
      return;
    }
    let mut total = 1.0;
    let mut sum = center;
    for (dx, dy) in DIRECTIONS[(direction - 1).min(15) as usize] {
      let sample = src.offset(y, x, dy, dx) as f32;
      let w = weight(center, sample, coefficient, false);
      sum = sample.mul_add(w, sum);
      total += w;
    }
    dst.set(y, x, round_signed(sum / total));
  });
}

fn smooth_non_edges(src: &Plane, markers: &Plane, dst: &mut Plane, area: Rect, coefficient: f32) {
  each(area, |y, x| {
    let marker = markers.get(y, x);
    if marker == 4 {
      return;
    }
    let center = src.get(y, x) as f32;
    let mut sum = 0.0;
    let mut total = 0.0;
    for dy in -4..=4 {
      for dx in -4..=4 {
        let sample = src.offset(y, x, dy, dx) as f32;
        let w = weight(center, sample, coefficient, dx == -4);
        sum = sample.mul_add(w, sum);
        total += w;
      }
    }
    let value = round_signed(sum / total);
    let old = dst.get(y, x);
    dst.set(
      y,
      x,
      match marker {
        1 => (3 * value + old + 2) >> 2,
        2 => (value + old + 1) >> 1,
        3 => (value + 3 * old + 2) >> 2,
        _ => value,
      },
    );
  });
}

fn blend_reconstruction(reconstructed: &Plane, markers: &Plane, dst: &mut Plane, area: Rect) {
  each(area, |y, x| {
    let a = reconstructed.get(y, x);
    let b = dst.get(y, x);
    dst.set(
      y,
      x,
      match markers.get(y, x) {
        0 => a,
        1 => (7 * a + b + 4) >> 3,
        2 => (3 * a + b + 2) >> 2,
        3 => (a + b + 1) >> 1,
        4 => (a + 7 * b + 4) >> 3,
        _ => b,
      },
    );
  });
}

fn adaptive_smooth(
  src: &Plane,
  reconstructed: Option<&Plane>,
  area: Rect,
  level: usize,
  params: &Parameters,
) -> Plane {
  let mut a = Plane::new(src.width, src.height);
  let mut b = Plane::new(src.width, src.height);
  let mut directions = Plane::new(src.width, src.height);
  let mut rect = expand(area, 12);
  features(
    src,
    &mut a,
    rect,
    params.feature[level],
    params.feature_low[level],
  );
  rect = inset(rect, 1);
  refine_features(&a, &mut b, rect);
  rect = inset(rect, 4);
  record_borders(&b, &mut a, rect);
  rect = inset(rect, 3);
  remove_noise(&a, &mut b, rect);
  rect = inset(rect, 1);
  diffuse(&b, &mut a, rect, 4);
  rect = inset(rect, 1);
  diffuse(&a, &mut b, rect, 3);
  rect = inset(rect, 1);
  diffuse(&b, &mut a, rect, 2);
  preliminary_directions(src, &a, &mut b, rect);
  rect = inset(rect, 1);
  refine_directions(&b, &mut directions, rect);
  debug_assert_eq!(rect, area);
  let mut out = Plane::new(src.width, src.height);
  smooth_edges(src, &directions, &mut out, area, params.smoothing[level]);
  if reconstructed.is_none() {
    smooth_non_edges(src, &a, &mut out, area, params.smoothing[level]);
  }
  if let Some(reconstructed) = reconstructed {
    blend_reconstruction(reconstructed, &a, &mut out, area);
  }
  let gain = (params.blend[level] * 16384.0).round() as i32;
  if gain < 16384 {
    each(area, |y, x| {
      out.set(
        y,
        x,
        (((16384 - gain) * src.get(y, x) + gain * out.get(y, x) + 8192) >> 14).clamp(-32768, 32767),
      );
    });
  }
  out
}

fn low_pass(src: &Plane, first: bool) -> Plane {
  let anchor = if first { 2 } else { 0 };
  let width = if first {
    (src.width - 4) / 2
  } else {
    src.width.div_ceil(2)
  };
  let height = if first {
    (src.height - 4) / 2
  } else {
    src.height.div_ceil(2)
  };
  let mut across = Plane::new(width, src.height);
  let sample = |y: usize, x: isize| src.get(y, x.clamp(0, src.width as isize - 1) as usize);
  const K: [i32; 5] = [819, 4096, 6554, 4096, 819];
  for y in 0..src.height {
    for x in 0..width {
      let center = (2 * x + anchor) as isize;
      let sum = K
        .iter()
        .enumerate()
        .map(|(i, &w)| sample(y, center + i as isize - 2) * w)
        .sum::<i32>();
      across.set(y, x, (sum + 8192) >> 14);
    }
  }
  let mut out = Plane::new(width, height);
  for y in 0..height {
    for x in 0..width {
      let center = (2 * y + anchor) as isize;
      let sum = K
        .iter()
        .enumerate()
        .map(|(i, &w)| {
          across.get(
            (center + i as isize - 2).clamp(0, src.height as isize - 1) as usize,
            x,
          ) * w
        })
        .sum::<i32>();
      out.set(y, x, (sum + 8192) >> 14);
    }
  }
  out
}

fn reconstruct(lp: &Plane, width: usize, height: usize, area: Rect, first: bool) -> Plane {
  let anchor = if first { 2 } else { 0 };
  let mut out = Plane::new(width, height);
  each(area, |y, x| {
    let (py, px) = (y - anchor, x - anchor);
    let (cy, cx) = (py / 2, px / 2);
    let p = |dy, dx| lp.offset(cy, cx, dy, dx);
    let value = match (py & 1, px & 1) {
      (0, 0) => {
        (p(0, 0) * 10484
          + (p(-1, 0) + p(1, 0) + p(0, -1) + p(0, 1)) * 1311
          + (p(-1, -1) + p(-1, 1) + p(1, -1) + p(1, 1)) * 164
          + 8192)
          >> 14
      }
      (0, 1) => {
        ((p(0, 0) + p(0, 1)) * 6554 + (p(-1, 0) + p(-1, 1) + p(1, 0) + p(1, 1)) * 819 + 8192) >> 14
      }
      (1, 0) => {
        ((p(0, 0) + p(1, 0)) * 6554 + (p(0, -1) + p(1, -1) + p(0, 1) + p(1, 1)) * 819 + 8192) >> 14
      }
      _ => (p(0, 0) + p(0, 1) + p(1, 0) + p(1, 1) + 2) >> 2,
    };
    out.set(y, x, value);
  });
  out
}

/// Source is padded YCC. The first low-pass center is source (2,2); later
/// levels keep that origin. The returned vector contains only the requested Y.
pub(crate) fn filter_tile(
  src: &[[u16; 3]],
  width: usize,
  height: usize,
  area: Rect,
  params: &Parameters,
) -> Vec<u16> {
  assert_eq!(src.len(), width * height);
  assert!(
    area[0] >= HALO
      && area[1] >= HALO
      && height - area[2] >= HALO - 2
      && width - area[3] >= HALO - 2
  );
  let first = Plane {
    data: src.iter().map(|v| (v[0] ^ 32768) as i16).collect(),
    width,
    height,
  };
  let second = low_pass(&first, true);
  let third = low_pass(&second, false);
  let fourth = low_pass(&third, false);
  let levels = [first, second, third, fourth];
  let mut areas = [area; 4];
  for i in 1..4 {
    let anchor = if i == 1 { 2 } else { 0 };
    let [t, l, b, r] = areas[i - 1];
    areas[i] = [
      (t - anchor) / 2 - 1,
      (l - anchor) / 2 - 1,
      (b - 1 - anchor) / 2 + 2,
      (r - 1 - anchor) / 2 + 2,
    ];
  }
  let mut filtered = adaptive_smooth(&levels[3], None, areas[3], 3, params);
  for i in (0..3).rev() {
    let lp = reconstruct(
      &filtered,
      levels[i].width,
      levels[i].height,
      areas[i],
      i == 0,
    );
    filtered = adaptive_smooth(&levels[i], Some(&lp), areas[i], i, params);
  }
  let mut out = Vec::with_capacity((area[2] - area[0]) * (area[3] - area[1]));
  each(area, |y, x| {
    out.push((filtered.get(y, x) as i16 as u16) ^ 32768)
  });
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::{Path, PathBuf};

  struct Capture {
    planes: Vec<Plane>,
    top: usize,
    left: usize,
  }
  fn capture(path: &Path) -> Capture {
    let h: serde_json::Value =
      serde_json::from_slice(&std::fs::read(path.with_extension("json")).unwrap()).unwrap();
    let n = |k: &str| h[k].as_u64().unwrap() as usize;
    let (width, height) = (n("r") - n("l"), n("b") - n("t"));
    let bytes = std::fs::read(path.with_extension("bin")).unwrap();
    let planes = (0..n("planes"))
      .map(|p| {
        let data = (0..width * height)
          .map(|i| {
            let o =
              2 * ((i / width) * n("row_step") + (i % width) * n("col_step") + p * n("plane_step"));
            i16::from_le_bytes(bytes[o..o + 2].try_into().unwrap())
          })
          .collect();
        Plane {
          data,
          width,
          height,
        }
      })
      .collect();
    Capture {
      planes,
      top: n("t"),
      left: n("l"),
    }
  }
  fn path(root: &Path, prefix: &str, suffix: &str) -> PathBuf {
    std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .find(|p| {
        let n = p.file_name().unwrap().to_str().unwrap();
        n.starts_with(prefix) && n.ends_with(suffix)
      })
      .unwrap()
  }
  fn info(path: &Path) -> serde_json::Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
  }
  fn relative(area: &serde_json::Value, c: &Capture) -> Rect {
    [
      area[0].as_u64().unwrap() as usize - c.top,
      area[1].as_u64().unwrap() as usize - c.left,
      area[2].as_u64().unwrap() as usize - c.top,
      area[3].as_u64().unwrap() as usize - c.left,
    ]
  }
  fn compare(a: &Plane, b: &Plane, area: Rect, label: &str) {
    let mut count = 0;
    let mut maximum = 0;
    each(area, |y, x| {
      let d = (a.get(y, x) - b.get(y, x)).abs();
      count += usize::from(d != 0);
      maximum = maximum.max(d);
    });
    eprintln!("{label}: {count} different, max {maximum}");
    assert_eq!((count, maximum), (0, 0), "{label}");
  }
  fn params(root: &Path) -> Parameters {
    let mut out = Parameters {
      feature: [0.0; 4],
      feature_low: [0.0; 4],
      smoothing: [0.0; 4],
      blend: [0.0; 4],
    };
    let mut paths: Vec<_> = std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .filter(|p| {
        p.file_name()
          .unwrap()
          .to_str()
          .unwrap()
          .ends_with("DoAdaptiveEdgeSmoothing_args.json")
      })
      .collect();
    paths.sort();
    assert_eq!(paths.len(), 4);
    for (p, i) in paths.iter().zip((0..4).rev()) {
      let j = info(p);
      let f = |n| j["s"][n].as_f64().unwrap() as f32;
      out.feature[i] = f(0);
      out.feature_low[i] = f(1);
      out.smoothing[i] = f(2);
      out.blend[i] = f(4);
    }
    out
  }

  #[test]
  fn captured_luma_boundaries_and_composition() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_LUMA_TRACE") else {
      eprintln!("RAW_DEVELOP_ADOBE_LUMA_TRACE unset; skipping external luminance NR capture");
      return;
    };
    let root = Path::new(&root);
    let params = params(root);
    let src = capture(&root.join("stage_src"));
    let input = Plane {
      data: src.planes[0].data.clone(),
      width: src.planes[0].width,
      height: src.planes[0].height,
    };
    let mut levels = vec![input];
    for i in 1..4 {
      levels.push(low_pass(&levels[i - 1], i == 1));
    }
    let mut aes: Vec<_> = std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .filter(|p| {
        p.file_name()
          .unwrap()
          .to_str()
          .unwrap()
          .ends_with("DoAdaptiveEdgeSmoothing_args.json")
      })
      .collect();
    aes.sort();
    let first_prefix = &aes[0].file_name().unwrap().to_str().unwrap()[..3];
    let last_prefix = &aes[3].file_name().unwrap().to_str().unwrap()[..3];
    let scratch = capture(&path(root, first_prefix, "_input.json").with_extension(""));
    for i in 1..4 {
      let expected = &scratch.planes[2 + 3 * i];
      let mut count = 0;
      let margin = if i == 1 { 0 } else { 3 };
      for y in margin..levels[i].height - 3 {
        for x in margin..levels[i].width - 3 {
          count += usize::from(levels[i].get(y, x) != expected.get(y + 2, x + 2));
        }
      }
      assert_eq!(count, 0, "lowpass level {i}");
    }
    for (argpath, level) in aes.iter().zip((0..4).rev()) {
      let filename = argpath.file_name().unwrap().to_str().unwrap();
      let prefix = &filename[..3];
      let args = info(argpath);
      let source = capture(&path(root, prefix, "_input.json").with_extension(""));
      let output_path = path(root, last_prefix, "_output.json");
      let own_output = std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| {
          p.file_name().unwrap().to_str().unwrap().starts_with(prefix)
            && p
              .file_name()
              .unwrap()
              .to_str()
              .unwrap()
              .ends_with("_output.json")
        });
      let output = capture(&own_output.clone().unwrap_or(output_path).with_extension(""));
      let area = relative(&args["area"], &source);
      let plane = args["x"][1].as_u64().unwrap() as usize;
      let reconstruction = if level == 3 {
        None
      } else if source.planes.len() > 4 {
        Some(&source.planes[4])
      } else {
        Some(&output.planes[4])
      };
      let actual = adaptive_smooth(&source.planes[plane], reconstruction, area, level, &params);
      let expected_plane = if own_output.is_none() {
        2 + 3 * level
      } else {
        3
      };
      compare(
        &actual,
        &output.planes[expected_plane],
        area,
        &format!("AES level {level}"),
      );
    }
    let area = relative(&info(&root.join("area.json")), &src);
    let ycc: Vec<[u16; 3]> = (0..src.planes[0].data.len())
      .map(|i| std::array::from_fn(|c| src.planes[c].data[i] as u16 ^ 32768))
      .collect();
    let actual = filter_tile(
      &ycc,
      src.planes[0].width,
      src.planes[0].height,
      area,
      &params,
    );
    let expected = capture(&root.join("stage_dst"));
    let mut count = 0;
    let mut maximum = 0;
    each(area, |y, x| {
      let i = (y - area[0]) * (area[3] - area[1]) + x - area[1];
      let a = (actual[i] ^ 32768) as i16 as i32;
      let d = (a - expected.planes[0].get(y, x)).abs();
      count += usize::from(d != 0);
      maximum = maximum.max(d);
    });
    eprintln!(
      "composed luma {} samples: {count} different, max {maximum}",
      actual.len()
    );
    assert_eq!((count, maximum), (0, 0));
  }
  #[test]
  fn captured_luma_coefficients() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_LUMA_TRACE") else {
      return;
    };
    let root = Path::new(&root);
    let raw = std::fs::read(root.join("params_00.bin")).unwrap();
    let sliders = std::fs::read(root.join("cr_params_00.bin")).unwrap();
    let gain = f64::from_le_bytes(raw[0x50..0x58].try_into().unwrap());
    let (model, iso) = if gain > 0.4 {
      ("X-E5", 10000)
    } else {
      ("ILCE-7RM5", 2000)
    };
    let control =
      |offset| i32::from_le_bytes(sliders[offset..offset + 4].try_into().unwrap()) as f64 * 0.01;
    let params = Parameters::new(
      model,
      iso,
      gain,
      control(0x90),
      control(0x94),
      control(0x98),
    )
    .unwrap();
    for (name, actual) in [
      ("c8", params.feature),
      ("e0", params.feature_low),
      ("f8", params.smoothing),
      ("110", params.blend),
    ] {
      let bytes = std::fs::read(root.join(format!("params_00_vec_{name}.bin"))).unwrap();
      let expected = std::array::from_fn::<_, 4, _>(|i| {
        f32::from_le_bytes(bytes[4 * i..4 * i + 4].try_into().unwrap())
      });
      assert_eq!(actual, expected, "luma {name}");
    }
  }

  #[test]
  fn luma_tiles_preserve_constants_and_the_eight_sample_lattice() {
    let params = Parameters::new("X-E5", 10000, 0.4738546968995835, 0.7, 0.11, 0.22).unwrap();
    let (width, height) = (512, 520);
    let constant = vec![[12345, 32768, 32768]; width * height];
    let area = [176, 176, 336, 344];
    let result = filter_tile(&constant, width, height, area, &params);
    assert!(result.iter().all(|&v| v == 12345));
    let input: Vec<[u16; 3]> = (0..width * height)
      .map(|i| {
        let (y, x) = (i / width, i % width);
        let detail =
          ((i as u32).wrapping_mul(1664525).wrapping_add(1013904223) >> 19) as i32 - 4096;
        [
          (8000 + 17 * x as i32 + 11 * y as i32 + detail) as u16,
          32768,
          32768,
        ]
      })
      .collect();
    let whole = filter_tile(&input, width, height, area, &params);
    let shifted: Vec<[u16; 3]> = (8..height)
      .flat_map(|y| input[y * width + 8..(y + 1) * width].iter().copied())
      .collect();
    let actual = filter_tile(
      &shifted,
      width - 8,
      height - 8,
      [168, 168, 328, 336],
      &params,
    );
    assert_eq!(actual, whole);
  }
}
