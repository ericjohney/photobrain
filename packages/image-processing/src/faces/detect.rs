//! YuNet (OpenCV Zoo `face_detection_yunet_2023mar`) preprocessing, multi-stride output
//! decoding, and non-maximum suppression, following OpenCV's `FaceDetectorYN`.

use super::pixels::Pixels;

/// One raw detection in detector-input pixel coordinates. Landmarks are, in image
/// order, the eye with the smaller x, the other eye, the nose tip, and the two mouth
/// corners (smaller x first), matching the ArcFace template.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Candidate {
  pub score: f32,
  pub x: f32,
  pub y: f32,
  pub width: f32,
  pub height: f32,
  pub landmarks: [[f32; 2]; 5],
}

impl Candidate {
  pub fn scaled(&self, sx: f32, sy: f32) -> Self {
    Self {
      score: self.score,
      x: self.x * sx,
      y: self.y * sy,
      width: self.width * sx,
      height: self.height * sy,
      landmarks: self.landmarks.map(|[x, y]| [x * sx, y * sy]),
    }
  }
}

/// The four heads of one feature stride, each flattened row-major over a
/// `(input_h / stride) x (input_w / stride)` grid: `cls` and `obj` have one value per
/// cell, `bbox` four (`dx, dy, log w, log h`), and `kps` ten (five `dx, dy` pairs).
pub(crate) struct StrideOutputs<'a> {
  pub stride: usize,
  pub cls: &'a [f32],
  pub obj: &'a [f32],
  pub bbox: &'a [f32],
  pub kps: &'a [f32],
}

/// Decode every grid cell whose score `sqrt(clamp(cls) * clamp(obj))` is at least
/// `min_score`. Boxes and landmarks are offsets from the cell's top-left corner in
/// stride units; widths and heights are log-encoded.
pub(crate) fn decode(
  levels: &[StrideOutputs],
  input_w: usize,
  input_h: usize,
  min_score: f32,
) -> Result<Vec<Candidate>, String> {
  let mut candidates = Vec::new();
  for level in levels {
    let stride = level.stride;
    let (cols, rows) = (input_w / stride, input_h / stride);
    let cells = cols * rows;
    if level.cls.len() != cells
      || level.obj.len() != cells
      || level.bbox.len() != cells * 4
      || level.kps.len() != cells * 10
    {
      return Err(format!(
        "YuNet stride {stride} outputs do not match a {cols}x{rows} grid"
      ));
    }
    let s = stride as f32;
    for row in 0..rows {
      for col in 0..cols {
        let idx = row * cols + col;
        let score = (level.cls[idx].clamp(0.0, 1.0) * level.obj[idx].clamp(0.0, 1.0)).sqrt();
        if score < min_score {
          continue;
        }
        let (c, r) = (col as f32, row as f32);
        let bbox = &level.bbox[idx * 4..idx * 4 + 4];
        let (cx, cy) = ((c + bbox[0]) * s, (r + bbox[1]) * s);
        let (width, height) = (bbox[2].exp() * s, bbox[3].exp() * s);
        let kps = &level.kps[idx * 10..idx * 10 + 10];
        let landmarks = std::array::from_fn(|n| [(kps[2 * n] + c) * s, (kps[2 * n + 1] + r) * s]);
        candidates.push(Candidate {
          score,
          x: cx - width / 2.0,
          y: cy - height / 2.0,
          width,
          height,
          landmarks,
        });
      }
    }
  }
  Ok(candidates)
}

fn iou(a: &Candidate, b: &Candidate) -> f32 {
  let left = a.x.max(b.x);
  let top = a.y.max(b.y);
  let right = (a.x + a.width).min(b.x + b.width);
  let bottom = (a.y + a.height).min(b.y + b.height);
  let intersection = (right - left).max(0.0) * (bottom - top).max(0.0);
  let union = a.width * a.height + b.width * b.height - intersection;
  if union > 0.0 {
    intersection / union
  } else {
    0.0
  }
}

/// Greedy NMS: highest score first (ties by decode order), dropping any candidate whose
/// IoU with an already kept one exceeds `max_iou`. Output is score-descending.
pub(crate) fn nms(mut candidates: Vec<Candidate>, max_iou: f32) -> Vec<Candidate> {
  // Stable sort keeps decode order among equal scores, so output is deterministic.
  candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
  let mut kept: Vec<Candidate> = Vec::new();
  for candidate in candidates {
    if kept.iter().all(|other| iou(&candidate, other) <= max_iou) {
      kept.push(candidate);
    }
  }
  kept
}

/// Separable area-average taps from `src` samples onto `dst <= src` samples.
fn area_taps(src: usize, dst: usize) -> Vec<(usize, Vec<f32>)> {
  let ratio = src as f64 / dst as f64;
  (0..dst)
    .map(|o| {
      let (lo, hi) = (o as f64 * ratio, ((o + 1) as f64 * ratio).min(src as f64));
      let start = lo.floor() as usize;
      let end = (hi.ceil() as usize).min(src);
      let weights = (start..end)
        .map(|s| {
          let overlap = (hi.min(s as f64 + 1.0) - lo.max(s as f64)).max(0.0);
          (overlap / (hi - lo)) as f32
        })
        .collect();
      (start, weights)
    })
    .collect()
}

/// Area-resample `pixels` to `dst_w x dst_h` and write it as planar BGR `0..255`
/// floats into the top-left of an `input_w x input_h` zero canvas (OpenCV
/// `blobFromImage` of a BGR image without scaling or mean, bottom/right padded).
pub(crate) fn blob(
  pixels: &Pixels,
  dst_w: usize,
  dst_h: usize,
  input_w: usize,
  input_h: usize,
) -> Vec<f32> {
  let channels = pixels.channels();
  let x_taps = area_taps(pixels.width() as usize, dst_w);
  let y_taps = area_taps(pixels.height() as usize, dst_h);

  // Horizontal pass over every source row into interleaved RGB floats.
  let src_h = pixels.height() as usize;
  let mut rows = vec![0f32; src_h * dst_w * 3];
  for (sy, out) in rows.chunks_exact_mut(dst_w * 3).enumerate() {
    let row = pixels.row(sy as u32);
    for ((start, weights), out) in x_taps.iter().zip(out.as_chunks_mut::<3>().0) {
      let mut acc = [0f32; 3];
      for (k, &weight) in weights.iter().enumerate() {
        let px = &row[(start + k) * channels..];
        acc[0] += f32::from(px[0]) * weight;
        acc[1] += f32::from(px[1]) * weight;
        acc[2] += f32::from(px[2]) * weight;
      }
      *out = acc;
    }
  }

  // Vertical pass straight into the planar BGR canvas.
  let plane = input_w * input_h;
  let mut blob = vec![0f32; 3 * plane];
  for (oy, (start, weights)) in y_taps.iter().enumerate() {
    let offset = oy * input_w;
    for (k, &weight) in weights.iter().enumerate() {
      let src = &rows[(start + k) * dst_w * 3..(start + k + 1) * dst_w * 3];
      for (ox, rgb) in src.as_chunks::<3>().0.iter().enumerate() {
        blob[offset + ox] += rgb[2] * weight;
        blob[plane + offset + ox] += rgb[1] * weight;
        blob[2 * plane + offset + ox] += rgb[0] * weight;
      }
    }
  }
  blob
}

#[cfg(test)]
mod tests {
  use super::*;
  use image::{Rgb, RgbImage};

  /// Build zeroed heads for a `w x h` input at stride `stride`.
  fn heads(w: usize, h: usize, stride: usize) -> [Vec<f32>; 4] {
    let cells = (w / stride) * (h / stride);
    [
      vec![0.0; cells],
      vec![0.0; cells],
      vec![0.0; cells * 4],
      vec![0.0; cells * 10],
    ]
  }

  fn levels<'a>(all: &'a [(usize, [Vec<f32>; 4])]) -> Vec<StrideOutputs<'a>> {
    all
      .iter()
      .map(|(stride, [cls, obj, bbox, kps])| StrideOutputs {
        stride: *stride,
        cls,
        obj,
        bbox,
        kps,
      })
      .collect()
  }

  #[test]
  fn decodes_cells_across_strides() {
    let (w, h) = (64, 32);
    let mut all: Vec<(usize, [Vec<f32>; 4])> =
      [8, 16, 32].iter().map(|&s| (s, heads(w, h, s))).collect();
    // Stride 8 grid is 8x4; cell (row 2, col 5) = idx 21.
    {
      let [cls, obj, bbox, kps] = &mut all[0].1;
      cls[21] = 0.81;
      obj[21] = 1.0;
      bbox[84..88].copy_from_slice(&[0.5, 0.25, 2f32.ln(), 3f32.ln()]);
      for n in 0..5 {
        kps[210 + 2 * n] = n as f32 * 0.1;
        kps[210 + 2 * n + 1] = -(n as f32) * 0.1;
      }
    }
    // Stride 32 grid is 2x1; cell idx 1, clamped inputs (cls > 1, obj < 0 → 0).
    {
      let [cls, obj, ..] = &mut all[2].1;
      cls[1] = 1.7;
      obj[1] = -0.2;
    }
    // Stride 16 grid is 4x2; cell idx 6 (row 1, col 2) below threshold.
    {
      let [cls, obj, ..] = &mut all[1].1;
      cls[6] = 0.25;
      obj[6] = 0.25;
    }
    let found = decode(&levels(&all), w, h, 0.5).unwrap();
    assert_eq!(found.len(), 1);
    let face = found[0];
    assert!((face.score - 0.9).abs() < 1e-6);
    // cx = (5 + 0.5) * 8 = 44, cy = (2 + 0.25) * 8 = 18, w = 16, h = 24.
    assert!((face.width - 16.0).abs() < 1e-4 && (face.height - 24.0).abs() < 1e-4);
    assert!((face.x - 36.0).abs() < 1e-4 && (face.y - 6.0).abs() < 1e-4);
    for n in 0..5 {
      let expected = [(n as f32 * 0.1 + 5.0) * 8.0, (2.0 - n as f32 * 0.1) * 8.0];
      assert!((face.landmarks[n][0] - expected[0]).abs() < 1e-4);
      assert!((face.landmarks[n][1] - expected[1]).abs() < 1e-4);
    }
    // Lowering the threshold admits the stride-16 cell at sqrt(0.25 * 0.25) = 0.25.
    let found = decode(&levels(&all), w, h, 0.2).unwrap();
    assert_eq!(found.len(), 2);
    assert!((found[1].score - 0.25).abs() < 1e-6);
    assert!((found[1].x - (2.0 * 16.0 - 8.0)).abs() < 1e-4);
  }

  #[test]
  fn decode_rejects_mismatched_grids() {
    let all = vec![(8, heads(64, 64, 8))];
    assert!(decode(&levels(&all), 64, 32, 0.5).is_err());
  }

  fn candidate(score: f32, x: f32, y: f32, size: f32) -> Candidate {
    Candidate {
      score,
      x,
      y,
      width: size,
      height: size,
      landmarks: [[0.0; 2]; 5],
    }
  }

  #[test]
  fn nms_keeps_best_of_overlaps_and_separate_faces() {
    let kept = nms(
      vec![
        candidate(0.80, 0.0, 0.0, 10.0),
        candidate(0.95, 1.0, 1.0, 10.0), // IoU 81/119 = 0.68 with the first
        candidate(0.70, 100.0, 0.0, 10.0), // disjoint
        candidate(0.90, 7.0, 0.0, 10.0), // IoU with best = 36/164 = 0.22 → kept
        candidate(0.60, 101.0, 0.0, 10.0), // IoU 90/110 with the 0.70 box → dropped
      ],
      0.3,
    );
    let scores: Vec<f32> = kept.iter().map(|c| c.score).collect();
    assert_eq!(scores, [0.95, 0.90, 0.70]);
  }

  #[test]
  fn nms_is_deterministic_for_ties() {
    let a = candidate(0.9, 0.0, 0.0, 10.0);
    let b = candidate(0.9, 2.0, 0.0, 10.0);
    assert_eq!(nms(vec![a, b], 0.3), [a]);
    assert_eq!(nms(vec![b, a], 0.3), [b]);
  }

  #[test]
  fn blob_area_averages_into_padded_bgr_planes() {
    // 4x2 RGB image → 2x1: each output averages a 2x2 block.
    let image = RgbImage::from_fn(4, 2, |x, y| {
      let v = (x + 4 * y) as u8 * 10;
      Rgb([v, v + 1, v + 2])
    });
    let pixels = Pixels::from_rgb(image);
    let blob = blob(&pixels, 2, 1, 4, 2);
    let plane = 8;
    // Block (0..2, 0..2): R values 0,10,40,50 → 25.
    assert!((blob[2 * plane] - 25.0).abs() < 1e-4, "R into plane 2");
    assert!((blob[plane] - 26.0).abs() < 1e-4, "G into plane 1");
    assert!((blob[0] - 27.0).abs() < 1e-4, "B into plane 0");
    assert!((blob[1] - 47.0).abs() < 1e-4, "second column B");
    // Padding stays zero.
    assert_eq!(blob[2], 0.0);
    assert_eq!(blob[4], 0.0);
  }

  #[test]
  fn area_taps_cover_fractional_ratios() {
    for (src, dst) in [(1600, 640), (1067, 427), (250, 250), (7, 3)] {
      let taps = area_taps(src, dst);
      assert_eq!(taps.len(), dst);
      for (_, weights) in &taps {
        let sum: f32 = weights.iter().sum();
        assert!((sum - 1.0).abs() < 1e-5, "{src}->{dst}: {sum}");
      }
      let (start, weights) = taps.last().unwrap();
      assert!(start + weights.len() <= src);
    }
  }
}
