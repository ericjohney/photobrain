//! Face detection (YuNet), alignment and embedding (SFace), clustering, and face crops.
//!
//! `detect_faces` runs on the shared processing pool: each path is decoded once, the
//! detector sees a copy whose long edge is at most 640 px (padded to a multiple of 32),
//! and every kept face is aligned from the full-resolution pixels onto the ArcFace
//! 112x112 template and embedded. Models download lazily and load once per process.

mod align;
mod cluster;
mod detect;
mod models;
mod pixels;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Mutex, OnceLock};

use image::imageops::{self, FilterType};
use image::{Rgb, RgbImage};
use napi::bindgen_prelude::{Buffer, Float32Array};
use napi_derive::napi;
use ort::session::Session;
use ort::value::Tensor;
use rayon::prelude::*;

use crate::batch::processing_pool;
use detect::{Candidate, StrideOutputs};
use pixels::Pixels;

/// Minimum detector score `sqrt(cls * obj)` for a kept face. Calibrated on WIDER FACE
/// val + Food-101: precision 1.0 and no face-free false positives (0.70 admits one).
pub(crate) const FACE_MIN_SCORE: f32 = 0.75;
/// Minimum short side of a kept face box, in pixels of the input image. Below ~40 px
/// same-person SFace similarity drops (LFW median 0.67 at 40 px, 0.58 at 24 px).
pub(crate) const FACE_MIN_PIXELS: f32 = 40.0;
/// NMS drops a candidate whose IoU with a better one exceeds this (OpenCV default).
const NMS_MAX_IOU: f32 = 0.3;
/// Long-edge bound of the detector input.
const DETECTOR_MAX_EDGE: u32 = 640;
/// Detector input sides are padded up to a multiple of the coarsest stride.
const DETECTOR_DIVISOR: u32 = 32;
const STRIDES: [usize; 3] = [8, 16, 32];
const EMBEDDING_DIMENSION: usize = 128;
const CROP_SCALE: f64 = 1.6;
const CROP_QUALITY: f32 = 85.0;

/// YuNet 2023mar declares a fixed 1x3x640x640 input; these graph values have their
/// spatial dimensions relaxed so any multiple-of-32 input runs without upscaling.
const YUNET_DYNAMIC: &[(&str, &[usize])] = &[
  ("input", &[2, 3]),
  ("cls_8", &[1]),
  ("cls_16", &[1]),
  ("cls_32", &[1]),
  ("obj_8", &[1]),
  ("obj_16", &[1]),
  ("obj_32", &[1]),
  ("bbox_8", &[1]),
  ("bbox_16", &[1]),
  ("bbox_32", &[1]),
  ("kps_8", &[1]),
  ("kps_16", &[1]),
  ("kps_32", &[1]),
];

/// Normalized (0..1) box in the oriented input image.
#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceBox {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedFace {
  pub r#box: FaceBox,
  /// Detector confidence `sqrt(cls * obj)`, 0-1.
  pub score: f64,
  /// 128 L2-normalized SFace components.
  pub embedding: Vec<f64>,
}

#[napi(object)]
#[derive(Debug, Clone, PartialEq)]
pub struct FaceDetectionResult {
  pub path: String,
  pub success: bool,
  pub faces: Vec<DetectedFace>,
  pub error: Option<String>,
}

struct Models {
  yunet: Session,
  sface: Session,
}

/// Set once both models load. A `LazyLock` would cache a failed download for the whole
/// process; this retries on the next call instead, and `MODELS_LOADING` keeps
/// concurrent first calls from downloading twice.
static MODELS: OnceLock<Models> = OnceLock::new();
static MODELS_LOADING: Mutex<()> = Mutex::new(());

/// Download (when missing), verify, and load both models once per process.
fn face_models() -> Result<&'static Models, String> {
  if let Some(models) = MODELS.get() {
    return Ok(models);
  }
  let _loading = MODELS_LOADING
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  if let Some(models) = MODELS.get() {
    return Ok(models);
  }
  let dir = models::model_dir();
  let mut yunet = models::load_model(&models::YUNET, &dir, models::YUNET.url)?;
  models::make_dims_symbolic(&mut yunet, YUNET_DYNAMIC)?;
  let sface = models::load_model(&models::SFACE, &dir, models::SFACE.url)?;
  let loaded = Models {
    yunet: models::session(&yunet, "YuNet")?,
    sface: models::session(&sface, "SFace")?,
  };
  Ok(MODELS.get_or_init(|| loaded))
}

/// Detect, align, and embed faces in each image (normally `large` WebP thumbnails,
/// already oriented). Faces with score >= FACE_MIN_SCORE and a short box side >=
/// FACE_MIN_PIXELS are returned in descending score order. An undecodable or failing
/// path yields `success: false` for that path only; model download or load failures
/// reject the call.
#[napi]
pub fn detect_faces(paths: Vec<String>) -> napi::Result<Vec<FaceDetectionResult>> {
  let models = face_models().map_err(napi::Error::from_reason)?;
  Ok(processing_pool()?.install(|| {
    paths
      .into_par_iter()
      .map(|path| detect_path(models, path))
      .collect()
  }))
}

fn detect_path(models: &Models, path: String) -> FaceDetectionResult {
  let outcome = catch_unwind(AssertUnwindSafe(|| {
    let pixels = Pixels::open(&path)?;
    detect_pixels(models, &pixels, FACE_MIN_SCORE, FACE_MIN_PIXELS)
  }))
  .unwrap_or_else(|_| Err("Face detection panicked".to_string()));
  match outcome {
    Ok(faces) => FaceDetectionResult {
      path,
      success: true,
      faces,
      error: None,
    },
    Err(error) => FaceDetectionResult {
      path,
      success: false,
      faces: Vec::new(),
      error: Some(error),
    },
  }
}

/// Detector input size: the long edge fitted to `DETECTOR_MAX_EDGE` (never upscaled).
fn detector_size(width: u32, height: u32) -> (u32, u32) {
  let long = width.max(height);
  if long <= DETECTOR_MAX_EDGE {
    return (width, height);
  }
  let scale = f64::from(DETECTOR_MAX_EDGE) / f64::from(long);
  let fit = |side: u32| ((f64::from(side) * scale).round() as u32).clamp(1, DETECTOR_MAX_EDGE);
  (fit(width), fit(height))
}

fn detect_pixels(
  models: &Models,
  pixels: &Pixels,
  min_score: f32,
  min_pixels: f32,
) -> Result<Vec<DetectedFace>, String> {
  let (width, height) = (pixels.width(), pixels.height());
  let (dst_w, dst_h) = detector_size(width, height);
  let (in_w, in_h) = (
    dst_w.next_multiple_of(DETECTOR_DIVISOR) as usize,
    dst_h.next_multiple_of(DETECTOR_DIVISOR) as usize,
  );
  let blob = detect::blob(pixels, dst_w as usize, dst_h as usize, in_w, in_h);
  let input = Tensor::from_array(([1usize, 3, in_h, in_w], blob))
    .map_err(|error| format!("YuNet input: {error}"))?;
  let inputs = ort::inputs![input].map_err(|error| format!("YuNet input: {error}"))?;
  let outputs = models
    .yunet
    .run(inputs)
    .map_err(|error| format!("YuNet inference failed: {error}"))?;
  let head = |name: String| -> Result<&[f32], String> {
    let value = outputs
      .get(name.as_str())
      .ok_or_else(|| format!("YuNet has no output {name}"))?;
    value
      .try_extract_raw_tensor::<f32>()
      .map(|(_, data)| data)
      .map_err(|error| format!("YuNet output {name}: {error}"))
  };
  let levels = STRIDES
    .iter()
    .map(|&stride| {
      Ok(StrideOutputs {
        stride,
        cls: head(format!("cls_{stride}"))?,
        obj: head(format!("obj_{stride}"))?,
        bbox: head(format!("bbox_{stride}"))?,
        kps: head(format!("kps_{stride}"))?,
      })
    })
    .collect::<Result<Vec<_>, String>>()?;
  let candidates = detect::nms(detect::decode(&levels, in_w, in_h, min_score)?, NMS_MAX_IOU);

  let (sx, sy) = (width as f32 / dst_w as f32, height as f32 / dst_h as f32);
  let mut faces = Vec::new();
  for face in candidates.iter().map(|candidate| candidate.scaled(sx, sy)) {
    if face.width.min(face.height) < min_pixels {
      continue;
    }
    // Collinear (degenerate) landmarks cannot be aligned; such a face is skipped.
    let Some(transform) = align::umeyama(&face.landmarks, &align::ARCFACE_TEMPLATE) else {
      continue;
    };
    faces.push(DetectedFace {
      r#box: normalized_box(&face, width, height),
      score: f64::from(face.score),
      embedding: embed(models, pixels, &transform)?,
    });
  }
  Ok(faces)
}

fn embed(
  models: &Models,
  pixels: &Pixels,
  transform: &align::Similarity,
) -> Result<Vec<f64>, String> {
  let size = align::ALIGNED_SIZE;
  let mut crop = vec![0f32; 3 * size * size];
  if !align::warp_rgb_planar(pixels, transform, &mut crop) {
    return Err("Face alignment transform is not invertible".to_string());
  }
  let input = Tensor::from_array(([1usize, 3, size, size], crop))
    .map_err(|error| format!("SFace input: {error}"))?;
  let inputs = ort::inputs![input].map_err(|error| format!("SFace input: {error}"))?;
  let outputs = models
    .sface
    .run(inputs)
    .map_err(|error| format!("SFace inference failed: {error}"))?;
  let (_, feature) = outputs[0]
    .try_extract_raw_tensor::<f32>()
    .map_err(|error| format!("SFace output: {error}"))?;
  if feature.len() != EMBEDDING_DIMENSION {
    return Err(format!(
      "SFace returned {} values, expected {EMBEDDING_DIMENSION}",
      feature.len()
    ));
  }
  let norm = feature
    .iter()
    .map(|&v| f64::from(v).powi(2))
    .sum::<f64>()
    .sqrt();
  if !(norm.is_finite() && norm > 0.0) {
    return Err("SFace returned a zero or non-finite embedding".to_string());
  }
  Ok(feature.iter().map(|&v| f64::from(v) / norm).collect())
}

/// The face box clipped to the image, as fractions of its width and height.
fn normalized_box(face: &Candidate, width: u32, height: u32) -> FaceBox {
  let (w, h) = (f64::from(width), f64::from(height));
  let x0 = f64::from(face.x).clamp(0.0, w);
  let y0 = f64::from(face.y).clamp(0.0, h);
  let x1 = f64::from(face.x + face.width).clamp(x0, w);
  let y1 = f64::from(face.y + face.height).clamp(y0, h);
  FaceBox {
    x: x0 / w,
    y: y0 / h,
    width: (x1 - x0) / w,
    height: (y1 - y0) / h,
  }
}

/// Group face embeddings (`embeddings.length / dimension` index-aligned vectors) with
/// mutual-kNN-restricted average linkage at cosine >= `threshold` (see
/// `faces/cluster.rs`). Returns groups of at least `minClusterSize` members, members
/// ascending, groups ordered by their smallest member. Deterministic.
#[napi]
pub fn cluster_face_embeddings(
  embeddings: Float32Array,
  dimension: u32,
  threshold: f64,
  min_cluster_size: u32,
) -> napi::Result<Vec<Vec<u32>>> {
  let data: &[f32] = &embeddings;
  processing_pool()?
    .install(|| {
      cluster::cluster(
        data,
        dimension as usize,
        threshold as f32,
        min_cluster_size as usize,
      )
    })
    .map_err(napi::Error::from_reason)
}

/// The square crop `(left, top, side)` in pixels: centred on the box, side 1.6x the
/// box's longer pixel side, shrunk to fit the image and shifted inside it.
fn crop_square(width: u32, height: u32, face: &FaceBox) -> Result<(u32, u32, u32), String> {
  let FaceBox {
    x,
    y,
    width: box_w,
    height: box_h,
  } = *face;
  if ![x, y, box_w, box_h].iter().all(|v| v.is_finite()) || box_w < 0.0 || box_h < 0.0 {
    return Err("box must have finite coordinates and a non-negative size".to_string());
  }
  let (w, h) = (f64::from(width), f64::from(height));
  let side = (CROP_SCALE * (box_w * w).max(box_h * h))
    .round()
    .clamp(1.0, w.min(h));
  let left = ((x + box_w / 2.0) * w - side / 2.0)
    .round()
    .clamp(0.0, w - side);
  let top = ((y + box_h / 2.0) * h - side / 2.0)
    .round()
    .clamp(0.0, h - side);
  Ok((left as u32, top as u32, side as u32))
}

/// Render a square `size` x `size` WebP (quality 85) around a face box of an image
/// (normally its `large` thumbnail). The crop is centred on the box with a side of
/// 1.6x the box's longer pixel side, clamped to the image. Alpha is composited over
/// white. `size` is 64-512.
#[napi(ts_args_type = "path: string, box: FaceBox, size: number")]
pub fn render_face_crop(path: String, face_box: FaceBox, size: u32) -> napi::Result<Buffer> {
  if !(64..=512).contains(&size) {
    return Err(napi::Error::from_reason("size must be between 64 and 512"));
  }
  render_face_crop_internal(&path, &face_box, size)
    .map(Buffer::from)
    .map_err(napi::Error::from_reason)
}

fn render_face_crop_internal(path: &str, face_box: &FaceBox, size: u32) -> Result<Vec<u8>, String> {
  let pixels = Pixels::open(path)?;
  let (left, top, side) = crop_square(pixels.width(), pixels.height(), face_box)?;
  let channels = pixels.channels();
  let crop = RgbImage::from_fn(side, side, |x, y| {
    let px = &pixels.row(top + y)[(left + x) as usize * channels..];
    if channels == 4 {
      let alpha = u32::from(px[3]);
      let blend = |c: u8| ((u32::from(c) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
      Rgb([blend(px[0]), blend(px[1]), blend(px[2])])
    } else {
      Rgb([px[0], px[1], px[2]])
    }
  });
  let resized = imageops::resize(&crop, size, size, FilterType::Lanczos3);
  Ok(
    webp::Encoder::from_rgb(resized.as_raw(), size, size)
      .encode(CROP_QUALITY)
      .to_vec(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn face_box(x: f64, y: f64, width: f64, height: f64) -> FaceBox {
    FaceBox {
      x,
      y,
      width,
      height,
    }
  }

  #[test]
  fn crop_is_centred_and_scaled_inside_the_image() {
    // 100x50 px box centred at (500, 400) in 1000x800.
    let crop = crop_square(1000, 800, &face_box(0.45, 0.46875, 0.1, 0.0625)).unwrap();
    assert_eq!(crop, (420, 320, 160));
  }

  #[test]
  fn crop_shifts_inside_at_every_edge() {
    let (w, h) = (1000, 800);
    // Top-left corner face: shifted to the origin.
    assert_eq!(
      crop_square(w, h, &face_box(0.0, 0.0, 0.1, 0.1)).unwrap(),
      (0, 0, 160)
    );
    // Bottom-right face partially outside: the crop ends at the image edge.
    assert_eq!(
      crop_square(w, h, &face_box(0.95, 0.95, 0.1, 0.1)).unwrap(),
      (840, 640, 160)
    );
    // Box larger than the image: side clamps to the short edge, centred then clamped.
    assert_eq!(
      crop_square(w, h, &face_box(0.1, 0.0, 0.8, 1.0)).unwrap(),
      (100, 0, 800)
    );
    // Degenerate box still yields a 1px crop inside the image.
    assert_eq!(
      crop_square(w, h, &face_box(1.0, 1.0, 0.0, 0.0)).unwrap(),
      (999, 799, 1)
    );
    assert!(crop_square(w, h, &face_box(f64::NAN, 0.0, 0.1, 0.1)).is_err());
    assert!(crop_square(w, h, &face_box(0.0, 0.0, -0.1, 0.1)).is_err());
  }

  #[test]
  fn renders_square_webp_of_requested_size_and_rejects_bad_sizes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("thumb.webp");
    let image = RgbImage::from_fn(300, 200, |x, y| Rgb([x as u8, y as u8, 128]));
    let encoded = webp::Encoder::from_rgb(image.as_raw(), 300, 200).encode(90.0);
    std::fs::write(&path, &*encoded).unwrap();
    let path = path.to_string_lossy().into_owned();

    let bytes = render_face_crop_internal(&path, &face_box(0.9, 0.9, 0.2, 0.2), 128).unwrap();
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (128, 128));
    assert!(render_face_crop(path.clone(), face_box(0.4, 0.4, 0.2, 0.2), 63).is_err());
    assert!(render_face_crop(path.clone(), face_box(0.4, 0.4, 0.2, 0.2), 513).is_err());
    assert!(
      render_face_crop_internal("/nonexistent.webp", &face_box(0.0, 0.0, 0.1, 0.1), 64).is_err()
    );
  }

  #[test]
  fn detector_input_fits_long_edge_without_upscaling() {
    assert_eq!(detector_size(1600, 1067), (640, 427));
    assert_eq!(detector_size(1067, 1600), (427, 640));
    assert_eq!(detector_size(250, 250), (250, 250));
    assert_eq!(detector_size(6400, 3), (640, 1));
  }

  #[test]
  fn boxes_are_clipped_to_the_image_and_normalized() {
    let face = Candidate {
      score: 0.9,
      x: -10.0,
      y: 50.0,
      width: 60.0,
      height: 200.0,
      landmarks: [[0.0; 2]; 5],
    };
    let normalized = normalized_box(&face, 200, 100);
    assert_eq!(normalized, face_box(0.0, 0.5, 0.25, 0.5));
  }

  /// Real models over the calibration fixtures (network on first run unless the models
  /// are cached in FACE_MODEL_DIR): `cargo test faces -- --ignored`.
  #[test]
  #[ignore]
  fn real_models_on_fixture_library() {
    let root = std::path::Path::new("/tmp/pb-f19-faces/library");
    let mut names: Vec<String> = std::fs::read_dir(root)
      .expect("calibration fixtures under /tmp/pb-f19-faces/library")
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .filter(|name| name.ends_with(".jpg"))
      .collect();
    names.sort();
    let paths: Vec<String> = names
      .iter()
      .map(|name| root.join(name).to_string_lossy().into_owned())
      .collect();
    let results = detect_faces(paths).unwrap();
    let identity = |name: &str| name.rsplit_once('_').map(|(person, _)| person.to_string());
    let mut people: Vec<(String, Vec<f64>)> = Vec::new();
    for (name, result) in names.iter().zip(&results) {
      assert!(result.success, "{name}: {:?}", result.error);
      for face in &result.faces {
        assert_eq!(face.embedding.len(), EMBEDDING_DIMENSION);
        let norm: f64 = face.embedding.iter().map(|v| v * v).sum();
        assert!((norm - 1.0).abs() < 1e-6);
        let b = face.r#box;
        assert!(
          b.x >= 0.0 && b.y >= 0.0 && b.x + b.width <= 1.0 + 1e-9 && b.y + b.height <= 1.0 + 1e-9
        );
      }
      if name.starts_with("noface_") {
        assert!(
          result.faces.is_empty(),
          "{name}: {} faces",
          result.faces.len()
        );
      } else if name.starts_with("group_") {
        assert!(
          result.faces.len() >= 5,
          "{name}: {} faces",
          result.faces.len()
        );
      } else {
        // LFW: the labelled person is the face nearest the image centre.
        let face = result
          .faces
          .iter()
          .min_by(|a, b| {
            let d = |f: &DetectedFace| {
              (f.r#box.x + f.r#box.width / 2.0 - 0.5).abs()
                + (f.r#box.y + f.r#box.height / 2.0 - 0.5).abs()
            };
            d(a).total_cmp(&d(b))
          })
          .unwrap_or_else(|| panic!("{name}: no face"));
        people.push((identity(name).unwrap(), face.embedding.clone()));
      }
    }
    let cosine = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>();
    let (mut same, mut different) = (Vec::new(), Vec::new());
    for i in 0..people.len() {
      for j in i + 1..people.len() {
        let value = cosine(&people[i].1, &people[j].1);
        if people[i].0 == people[j].0 {
          same.push(value)
        } else {
          different.push(value)
        }
      }
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    assert!(
      mean(&same) > 0.45 && mean(&different) < 0.15,
      "same {} different {}",
      mean(&same),
      mean(&different)
    );

    // Clustering the identity faces recovers each person as one pure group.
    let flat: Vec<f32> = people
      .iter()
      .flat_map(|(_, e)| e.iter().map(|&v| v as f32))
      .collect();
    let groups = cluster::cluster(&flat, EMBEDDING_DIMENSION, 0.48, 3).unwrap();
    let mut identities: Vec<&String> = people.iter().map(|(person, _)| person).collect();
    identities.sort();
    identities.dedup();
    assert_eq!(groups.len(), identities.len(), "{groups:?}");
    for group in &groups {
      let first = &people[group[0] as usize].0;
      assert!(
        group.iter().all(|&i| &people[i as usize].0 == first),
        "impure group {group:?}"
      );
    }
  }
}
