//! Five-point similarity alignment onto the ArcFace 112x112 template and the bilinear
//! warp that produces SFace input (OpenCV `FaceRecognizerSF::alignCrop` + `feature`).

use super::pixels::Pixels;

pub(crate) const ALIGNED_SIZE: usize = 112;

/// Standard ArcFace landmark template for a 112x112 crop: eye at image-left, the
/// other eye, nose tip, mouth corner at image-left, the other mouth corner.
pub(crate) const ARCFACE_TEMPLATE: [[f32; 2]; 5] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/// Similarity transform `[a -b tx; b a ty]` mapping source to destination points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Similarity {
  pub a: f64,
  pub b: f64,
  pub tx: f64,
  pub ty: f64,
}

impl Similarity {
  pub fn apply(&self, [x, y]: [f64; 2]) -> [f64; 2] {
    [
      self.a * x - self.b * y + self.tx,
      self.b * x + self.a * y + self.ty,
    ]
  }

  pub fn inverse(&self) -> Option<Self> {
    let det = self.a * self.a + self.b * self.b;
    if det <= f64::EPSILON || !det.is_finite() {
      return None;
    }
    let (a, b) = (self.a / det, -self.b / det);
    Some(Self {
      a,
      b,
      tx: -(a * self.tx - b * self.ty),
      ty: -(b * self.tx + a * self.ty),
    })
  }
}

/// Least-squares similarity (rotation, uniform scale, translation; no reflection) from
/// `src` to `dst`: Umeyama's estimator, which in 2-D has this closed form. With centred
/// points it minimises `sum |dst - (s R src + t)|^2`; the complex-number solution
/// `(a + ib) = sum(conj(src) * dst) / sum |src|^2` is exactly Umeyama's `s R`.
pub(crate) fn umeyama(src: &[[f32; 2]; 5], dst: &[[f32; 2]; 5]) -> Option<Similarity> {
  let n = src.len() as f64;
  let mean = |points: &[[f32; 2]; 5]| {
    let (sx, sy) = points.iter().fold((0.0, 0.0), |(x, y), p| {
      (x + f64::from(p[0]), y + f64::from(p[1]))
    });
    [sx / n, sy / n]
  };
  let (ms, md) = (mean(src), mean(dst));
  let (mut dot, mut cross, mut norm) = (0.0, 0.0, 0.0);
  for (s, d) in src.iter().zip(dst) {
    let (sx, sy) = (f64::from(s[0]) - ms[0], f64::from(s[1]) - ms[1]);
    let (dx, dy) = (f64::from(d[0]) - md[0], f64::from(d[1]) - md[1]);
    dot += sx * dx + sy * dy;
    cross += sx * dy - sy * dx;
    norm += sx * sx + sy * sy;
  }
  if norm <= f64::EPSILON || !norm.is_finite() {
    return None;
  }
  let (a, b) = (dot / norm, cross / norm);
  Some(Similarity {
    a,
    b,
    tx: md[0] - (a * ms[0] - b * ms[1]),
    ty: md[1] - (b * ms[0] + a * ms[1]),
  })
}

/// Warp `pixels` through `to_template` into a 112x112 crop, written as planar RGB
/// `0..255` floats into `out` (`3 * 112 * 112`). Output pixel `(u, v)` samples the
/// source at `to_template^-1 (u, v)` with bilinear filtering; samples outside the image
/// read as black (OpenCV `warpAffine` with `INTER_LINEAR`, constant border).
pub(crate) fn warp_rgb_planar(pixels: &Pixels, to_template: &Similarity, out: &mut [f32]) -> bool {
  let Some(inverse) = to_template.inverse() else {
    return false;
  };
  let plane = ALIGNED_SIZE * ALIGNED_SIZE;
  debug_assert_eq!(out.len(), 3 * plane);
  let (width, height) = (pixels.width() as i64, pixels.height() as i64);
  let channels = pixels.channels();
  let data = pixels.data();
  let stride = width as usize * channels;
  let texel = |x: i64, y: i64| -> [f32; 3] {
    if x < 0 || y < 0 || x >= width || y >= height {
      return [0.0; 3];
    }
    let i = y as usize * stride + x as usize * channels;
    [
      f32::from(data[i]),
      f32::from(data[i + 1]),
      f32::from(data[i + 2]),
    ]
  };
  for v in 0..ALIGNED_SIZE {
    for u in 0..ALIGNED_SIZE {
      let [sx, sy] = inverse.apply([u as f64, v as f64]);
      let (x0, y0) = (sx.floor(), sy.floor());
      let (fx, fy) = ((sx - x0) as f32, (sy - y0) as f32);
      let (x0, y0) = (x0 as i64, y0 as i64);
      let (p00, p10, p01, p11) = (
        texel(x0, y0),
        texel(x0 + 1, y0),
        texel(x0, y0 + 1),
        texel(x0 + 1, y0 + 1),
      );
      let o = v * ALIGNED_SIZE + u;
      for c in 0..3 {
        let top = p00[c] + (p10[c] - p00[c]) * fx;
        let bottom = p01[c] + (p11[c] - p01[c]) * fx;
        out[c * plane + o] = top + (bottom - top) * fy;
      }
    }
  }
  true
}

#[cfg(test)]
mod tests {
  use super::*;
  use image::{Rgb, RgbImage};

  fn transform(points: &[[f32; 2]; 5], t: &Similarity) -> [[f32; 2]; 5] {
    points.map(|[x, y]| {
      let [x, y] = t.apply([f64::from(x), f64::from(y)]);
      [x as f32, y as f32]
    })
  }

  #[test]
  fn recovers_known_similarity_and_maps_landmarks_onto_template() {
    // Landmarks = template under a known rotation/scale/translation.
    let (scale, angle) = (2.7f64, 0.4f64);
    let known = Similarity {
      a: scale * angle.cos(),
      b: scale * angle.sin(),
      tx: 312.5,
      ty: -41.0,
    };
    let landmarks = transform(&ARCFACE_TEMPLATE, &known);
    let fitted = umeyama(&landmarks, &ARCFACE_TEMPLATE).unwrap();
    let back = known.inverse().unwrap();
    for (got, want) in [
      (fitted.a, back.a),
      (fitted.b, back.b),
      (fitted.tx, back.tx),
      (fitted.ty, back.ty),
    ] {
      assert!((got - want).abs() < 1e-4, "{fitted:?} vs {back:?}");
    }
    for (p, t) in transform(&landmarks, &fitted).iter().zip(&ARCFACE_TEMPLATE) {
      assert!((p[0] - t[0]).abs() < 1e-3 && (p[1] - t[1]).abs() < 1e-3);
    }
  }

  #[test]
  fn least_squares_fit_of_noisy_landmarks_is_unbiased() {
    let noisy = [
      [38.2946 + 1.0, 51.6963],
      [73.5318 - 1.0, 51.5014],
      [56.0252, 71.7366 + 1.0],
      [41.5493, 92.3655 - 1.0],
      [70.7299, 92.2041],
    ];
    let fitted = umeyama(&noisy, &ARCFACE_TEMPLATE).unwrap();
    // Symmetric noise: near-identity, never a reflection (a > 0, det > 0).
    assert!(fitted.a > 0.9 && fitted.a < 1.1, "{fitted:?}");
    assert!(fitted.b.abs() < 0.05, "{fitted:?}");
  }

  #[test]
  fn degenerate_landmarks_have_no_transform() {
    assert!(umeyama(&[[5.0, 5.0]; 5], &ARCFACE_TEMPLATE).is_none());
  }

  #[test]
  fn warp_samples_bilinearly_and_blacks_out_off_image() {
    // Horizontal ramp: R = 2x, G = y, B = 7.
    let image = RgbImage::from_fn(100, 100, |x, y| Rgb([(2 * x) as u8, y as u8, 7]));
    let pixels = Pixels::from_rgb(image);
    // Template point (u, v) samples source (u + 10.5, v + 20.25).
    let shift = Similarity {
      a: 1.0,
      b: 0.0,
      tx: -10.5,
      ty: -20.25,
    };
    let mut out = vec![0f32; 3 * ALIGNED_SIZE * ALIGNED_SIZE];
    assert!(warp_rgb_planar(&pixels, &shift, &mut out));
    let plane = ALIGNED_SIZE * ALIGNED_SIZE;
    let at = |c: usize, u: usize, v: usize| out[c * plane + v * ALIGNED_SIZE + u];
    assert!((at(0, 0, 0) - 21.0).abs() < 1e-4);
    assert!((at(1, 0, 0) - 20.25).abs() < 1e-4);
    assert!((at(2, 5, 5) - 7.0).abs() < 1e-4);
    // Source x = 99.5 is half off the right edge: blends 198 with black.
    assert!((at(0, 89, 0) - 99.0).abs() < 1e-3);
    // Fully outside.
    assert_eq!(at(0, 111, 111), 0.0);
    assert_eq!(at(2, 100, 0), 0.0);
  }
}
