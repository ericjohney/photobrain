//! Native Rust execution of recovered ACR denoise and Enhance Details CNNs.
//!
//! This is a model-tensor API, separate from [`crate::develop`]. It does not
//! silently guess RAW normalization, CFA alignment, stitching or strength blend.
//! Models/weights are external `.pbdn` assets exported from locally supplied
//! Core ML specifications. No Adobe code or learned weights are compiled in.
//!
//! FP16 weights are decoded exactly to f32; FP32 weights retain their bits.
//! Both are evaluated using f32 GEMM.
//! Reduction order differs from Core ML: numerical agreement is measured, not
//! assumed bit-exact. See `docs/adobe-denoise.md` for provenance and validation.

pub mod baseline_bayer;
pub mod baseline_xtrans;
pub mod border;
#[cfg(feature = "adobe-denoise-coreml")]
mod coreml;
#[cfg(feature = "adobe-denoise-cuda")]
mod cuda;
mod format;
pub mod gains;
#[cfg(feature = "adobe-denoise-gpu")]
mod gpu;
mod kernels;
#[cfg(feature = "adobe-denoise-cuda")]
mod onnx;
pub mod raw;
pub mod render;
pub use raw::DecodedMosaic;
mod mosaic;
pub mod partial;
mod region;
pub mod strength;
#[cfg(test)]
mod tests;
pub mod tiles;
pub mod transfer;

use crate::{Cancel, Error, Result};
use format::{Manifest, Op, elements};
pub use format::{Tensor, Variant};
pub use mosaic::MosaicTilePlan;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::Arc};

fn invalid(message: impl Into<String>) -> Error {
  Error::Malformed(format!("denoise: {}", message.into()))
}

/// Pack a normalized 1024-square CFA tile into the recovered sparse planes.
///
/// Input must already have the model-local phase: GR/BG for Bayer, or the
/// canonical 6x6 X-Trans phase below. This does not rephase a sensor, normalize
/// raw codes, pad borders, or infer Adobe's conditional per-channel offsets.
/// The supplied offsets are added at sampled positions only; missing colors
/// remain exactly zero. Dense linear/panorama models use `Tensor::new` instead.
pub fn pack_mosaic_tile(
  variant: Variant,
  mosaic: &[f32],
  channel_offsets: [f32; 3],
) -> Result<Tensor> {
  const EDGE: usize = 1024;
  const XTRANS: [[usize; 6]; 6] = [
    [1, 2, 1, 1, 0, 1],
    [0, 1, 0, 2, 1, 2],
    [1, 2, 1, 1, 0, 1],
    [1, 0, 1, 1, 2, 1],
    [2, 1, 2, 0, 1, 0],
    [1, 0, 1, 1, 2, 1],
  ];
  if !matches!(variant, Variant::Bayer | Variant::Xtrans)
    || mosaic.len() != EDGE * EDGE
    || channel_offsets.iter().any(|v| !v.is_finite())
  {
    return Err(invalid(
      "expected a Bayer/X-Trans 1024-square tile and finite offsets",
    ));
  }
  let mut data = vec![0.0; 3 * EDGE * EDGE];
  for (i, &sample) in mosaic.iter().enumerate() {
    let (y, x) = (i / EDGE, i % EDGE);
    let c = match variant {
      Variant::Bayer => [[1, 0], [2, 1]][y % 2][x % 2],
      Variant::Xtrans => XTRANS[y % 6][x % 6],
      _ => unreachable!(),
    };
    data[c * EDGE * EDGE + i] = sample + channel_offsets[c];
  }
  Tensor::new([3, EDGE, EDGE], data)
}

/// Shareable model. CPU predictions own scratch; GPU predictions reuse a
/// process-serialized device arena across tiles.
pub struct Model {
  manifest: Manifest,
  weights: Vec<f32>,
  shapes: Vec<[usize; 3]>,
  uses: Vec<usize>,
  #[cfg(feature = "adobe-denoise-coreml")]
  bundle_sha256: String,
  #[cfg(feature = "adobe-denoise-coreml")]
  coreml: Option<coreml::CoreMlModel>,
  #[cfg(feature = "adobe-denoise-gpu")]
  gpu: Option<gpu::GpuModel>,
  #[cfg(feature = "adobe-denoise-cuda")]
  cuda: Option<cuda::CudaModel>,
}

/// CPU is the reference implementation. Auto falls back only during device
/// initialization; inference failures are returned rather than mixing backends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
  Cpu,
  Auto,
  Gpu,
  Metal,
  Vulkan,
  CoreMl,
  CoreMlGpu,
  Cuda,
}

impl Backend {
  pub fn from_env() -> Result<Self> {
    match std::env::var("DENOISE_BACKEND")
      .as_deref()
      .unwrap_or("auto")
    {
      "cpu" => Ok(Self::Cpu),
      "auto" => Ok(Self::Auto),
      "gpu" => Ok(Self::Gpu),
      "metal" => Ok(Self::Metal),
      "vulkan" => Ok(Self::Vulkan),
      "coreml" => Ok(Self::CoreMl),
      "coreml-gpu" => Ok(Self::CoreMlGpu),
      "cuda" => Ok(Self::Cuda),
      _ => Err(invalid(
        "DENOISE_BACKEND must be auto, cpu, gpu, metal, vulkan, coreml, coreml-gpu or cuda",
      )),
    }
  }

  pub fn is_coreml(self) -> bool {
    matches!(self, Self::CoreMl | Self::CoreMlGpu)
  }

  /// Resolve the actual device before looking up cached pixels. Auto may resolve
  /// to CPU, so using only the requested backend would collide across machines.
  pub fn identity(self) -> Result<String> {
    if self == Self::Cuda {
      #[cfg(feature = "adobe-denoise-cuda")]
      return cuda::identity();
      #[cfg(not(feature = "adobe-denoise-cuda"))]
      return Err(invalid(
        "CUDA requires Linux and the adobe-denoise-cuda Cargo feature",
      ));
    }
    if self.is_coreml() {
      #[cfg(feature = "adobe-denoise-coreml")]
      return coreml::identity(self);
      #[cfg(not(feature = "adobe-denoise-coreml"))]
      return Err(invalid(
        "Core ML requires macOS and the adobe-denoise-coreml Cargo feature",
      ));
    }
    if self == Self::Cpu {
      return Ok("cpu-f32-v1".into());
    }
    #[cfg(feature = "adobe-denoise-gpu")]
    match gpu::context(self) {
      Ok(context) => return Ok(context.identity().into()),
      Err(_) if self == Self::Auto => return Ok("cpu-f32-v1".into()),
      Err(error) => return Err(invalid(error)),
    }
    #[cfg(not(feature = "adobe-denoise-gpu"))]
    if self == Self::Auto {
      Ok("cpu-f32-v1".into())
    } else {
      Err(invalid(
        "GPU backend requires the adobe-denoise-gpu Cargo feature",
      ))
    }
  }
}

/// Public metadata for inspecting a runtime model without executing it.
#[derive(Debug, serde::Serialize)]
pub struct ModelInfo<'a> {
  pub format_version: u32,
  pub weight_dtype: &'static str,
  pub variant: Variant,
  pub source_sha256: &'a str,
  pub weights_sha256: &'a str,
  pub input_shape: [usize; 3],
  pub output_shape: [usize; 3],
  pub layers: usize,
  pub parameters: usize,
  pub backend: &'a str,
}

impl Model {
  /// Explicit opt-in to accelerated inference. `load` remains the CPU oracle.
  pub fn load_with_backend(path: impl AsRef<Path>, backend: Backend) -> Result<Self> {
    if backend.is_coreml() {
      #[cfg(feature = "adobe-denoise-coreml")]
      {
        let mut model = Self::load(&path)?;
        model.coreml = Some(coreml::CoreMlModel::load(path.as_ref(), &model, backend)?);
        return Ok(model);
      }
      #[cfg(not(feature = "adobe-denoise-coreml"))]
      return Err(invalid(
        "Core ML requires macOS and the adobe-denoise-coreml Cargo feature",
      ));
    }
    Self::load(path)?.with_backend(backend)
  }

  pub fn with_backend(self, backend: Backend) -> Result<Self> {
    if backend.is_coreml() {
      return Err(invalid(
        "Core ML requires load_with_backend and checksum-bound companion assets",
      ));
    }
    let model = self;
    #[cfg(feature = "adobe-denoise-coreml")]
    let model = {
      let mut model = model;
      model.coreml = None;
      model
    };
    #[cfg(feature = "adobe-denoise-cuda")]
    let model = {
      let mut model = model;
      model.cuda = None;
      #[cfg(feature = "adobe-denoise-gpu")]
      {
        model.gpu = None;
      }
      if backend == Backend::Cuda {
        model.cuda = Some(cuda::CudaModel::new(&model)?);
        return Ok(model);
      }
      model
    };
    #[cfg(not(feature = "adobe-denoise-cuda"))]
    if backend == Backend::Cuda {
      return Err(invalid(
        "CUDA requires Linux and the adobe-denoise-cuda Cargo feature",
      ));
    }
    #[cfg(feature = "adobe-denoise-gpu")]
    {
      let mut model = model;
      model.gpu = None;
      if backend != Backend::Cpu {
        match gpu::context(backend) {
          Ok(context) => model.gpu = Some(gpu::GpuModel::new(&model, context)?),
          Err(error) if backend == Backend::Auto => {
            eprintln!("denoise: GPU unavailable; using CPU: {error}");
          }
          Err(error) => return Err(invalid(error)),
        }
      }
      Ok(model)
    }
    #[cfg(not(feature = "adobe-denoise-gpu"))]
    {
      if !matches!(backend, Backend::Cpu | Backend::Auto) {
        return Err(invalid(
          "GPU backend requires the adobe-denoise-gpu Cargo feature",
        ));
      }
      Ok(model)
    }
  }

  /// Includes implementation revision, device and driver for cache separation.
  pub fn backend_identity(&self) -> &str {
    #[cfg(feature = "adobe-denoise-cuda")]
    if let Some(cuda) = &self.cuda {
      return cuda.identity();
    }
    #[cfg(feature = "adobe-denoise-coreml")]
    if let Some(coreml) = &self.coreml {
      return coreml.identity();
    }
    #[cfg(feature = "adobe-denoise-gpu")]
    if let Some(gpu) = &self.gpu {
      return gpu.identity();
    }
    "cpu-f32-v1"
  }

  pub fn load(path: impl AsRef<Path>) -> Result<Self> {
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let len = metadata.len();
    let limit = (12 + format::MAX_HEADER + format::MAX_WEIGHTS * 4) as u64;
    if !metadata.is_file() || len > limit {
      return Err(invalid("model file too large"));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
      return Err(invalid("model file grew beyond size limit"));
    }
    Self::from_bytes(&bytes)
  }

  pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
    if bytes.len() < 12 {
      return Err(invalid("unknown model format"));
    }
    let (version, scalar_bytes) = if &bytes[..8] == format::MODEL_MAGIC {
      (1, 2)
    } else if &bytes[..8] == format::MODEL_MAGIC_F32 {
      (2, 4)
    } else {
      return Err(invalid("unknown model format"));
    };
    let header_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if header_len > format::MAX_HEADER || header_len > bytes.len() - 12 {
      return Err(invalid("invalid model header length"));
    }
    let m: Manifest = serde_json::from_slice(&bytes[12..12 + header_len])
      .map_err(|e| invalid(format!("model manifest: {e}")))?;
    let payload = &bytes[12 + header_len..];
    if !payload.len().is_multiple_of(scalar_bytes)
      || payload.len() / scalar_bytes > format::MAX_WEIGHTS
    {
      return Err(invalid("invalid weight payload size"));
    }
    if m.format_version != version || m.layers.is_empty() || m.layers.len() > 256 {
      return Err(invalid("unsupported model version/layer count"));
    }
    if m.source_sha256.len() != 64 || !m.source_sha256.bytes().all(|v| v.is_ascii_hexdigit()) {
      return Err(invalid("invalid source digest"));
    }
    if format!("{:x}", Sha256::digest(payload)) != m.weights_sha256 {
      return Err(invalid("weight checksum mismatch"));
    }
    let weights: Vec<_> = if scalar_bytes == 2 {
      payload
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| half::f16::from_bits(u16::from_le_bytes(*b)).to_f32())
        .collect()
    } else {
      payload
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect()
    };
    if weights.iter().any(|w| !w.is_finite()) {
      return Err(invalid("non-finite weights"));
    }
    let model = Self::validate(m, weights)?;
    #[cfg(feature = "adobe-denoise-coreml")]
    let model = {
      let mut model = model;
      model.bundle_sha256 = format!("{:x}", Sha256::digest(bytes));
      model
    };
    Ok(model)
  }

  fn validate(m: Manifest, weights: Vec<f32>) -> Result<Self> {
    elements(m.input_shape)?;
    elements(m.output_shape)?;
    if m.input_shape[0] != 3 || m.output_shape[0] != 3 || m.output != m.layers.len() {
      return Err(invalid("expected three-channel input and final output"));
    }
    let mut shapes = vec![m.input_shape];
    let mut uses = vec![0usize; m.layers.len() + 1];
    let mut weight_cursor = 0;
    for (i, l) in m.layers.iter().enumerate() {
      let arity = if matches!(l.op, Op::Add { .. } | Op::Concat { .. }) {
        2
      } else {
        1
      };
      if l.inputs.len() != arity || l.inputs.iter().any(|&j| j > i) {
        return Err(invalid(format!("invalid graph inputs at layer {}", l.name)));
      }
      for &j in &l.inputs {
        uses[j] += 1;
      }
      let input = shapes[l.inputs[0]];
      let mut output = input;
      match l.op {
        Op::Identity { .. } => {}
        Op::LeakyRelu { alpha } => {
          if !alpha.is_finite() || !(0.0..=1.0).contains(&alpha) {
            return Err(invalid("invalid leaky ReLU slope"));
          }
        }
        Op::Add { .. } => {
          if input != shapes[l.inputs[1]] {
            return Err(invalid("add shape mismatch"));
          }
        }
        Op::Concat { .. } => {
          let rhs = shapes[l.inputs[1]];
          if input[1..] != rhs[1..] {
            return Err(invalid("concat spatial shape mismatch"));
          }
          output[0] += rhs[0];
        }
        Op::Upsample { scale } => {
          if scale != [2, 2] {
            return Err(invalid("only 2x nearest upsample is supported"));
          }
          output[1] *= 2;
          output[2] *= 2;
        }
        Op::Slice { axis, start, end } => {
          if !(1..=2).contains(&axis) || start >= end || end > input[axis] {
            return Err(invalid("invalid spatial slice"));
          }
          output[axis] = end - start;
        }
        Op::Conv2d {
          in_channels,
          out_channels,
          groups,
          kernel,
          stride,
          padding,
          weights: wr,
          bias,
        } => {
          if in_channels != input[0]
            || out_channels == 0
            || out_channels > 512
            || groups == 0
            || !in_channels.is_multiple_of(groups)
            || !out_channels.is_multiple_of(groups)
          {
            return Err(invalid("invalid convolution channels/groups"));
          }
          if kernel.iter().any(|&k| !(1..=3).contains(&k))
            || stride.iter().any(|&s| !(1..=2).contains(&s))
            || padding.iter().any(|&p| p > 2)
          {
            return Err(invalid("unsupported convolution geometry"));
          }
          let count = out_channels * (in_channels / groups) * kernel[0] * kernel[1];
          for (r, n) in [(wr, count), (bias, out_channels)] {
            if r.offset != weight_cursor
              || r.count != n
              || n > weights.len().saturating_sub(weight_cursor)
            {
              return Err(invalid("invalid weight range or parameter count"));
            }
            weight_cursor += n;
          }
          output[0] = out_channels;
          for d in 0..2 {
            let padded = input[d + 1] + padding[2 * d] + padding[2 * d + 1];
            if padded < kernel[d] {
              return Err(invalid("kernel exceeds padded input"));
            }
            output[d + 1] = (padded - kernel[d]) / stride[d] + 1;
          }
        }
      }
      elements(output)?;
      shapes.push(output);
    }
    if shapes[m.output] != m.output_shape || weight_cursor != weights.len() {
      return Err(invalid("output shape or total weight count mismatch"));
    }
    uses[m.output] += 1;
    if uses.contains(&0) {
      return Err(invalid("unused graph nodes"));
    }
    // Bound total live activations, not just each individual allocation.
    let mut left = uses.clone();
    let mut live = elements(m.input_shape)?;
    for (i, l) in m.layers.iter().enumerate() {
      live += elements(shapes[i + 1])?;
      if live > 805_306_368 {
        return Err(invalid("graph needs over 3 GiB of live activations"));
      }
      for &j in &l.inputs {
        left[j] -= 1;
        if left[j] == 0 {
          live -= elements(shapes[j])?;
        }
      }
    }
    Ok(Self {
      manifest: m,
      weights,
      shapes,
      uses,
      #[cfg(feature = "adobe-denoise-coreml")]
      bundle_sha256: String::new(),
      #[cfg(feature = "adobe-denoise-coreml")]
      coreml: None,
      #[cfg(feature = "adobe-denoise-gpu")]
      gpu: None,
      #[cfg(feature = "adobe-denoise-cuda")]
      cuda: None,
    })
  }

  /// Encode only the already validated graph; no external ONNX is executed.
  #[cfg(feature = "adobe-denoise-cuda")]
  pub fn to_onnx(&self) -> Vec<u8> {
    onnx::encode(self)
  }

  pub fn info(&self) -> ModelInfo<'_> {
    ModelInfo {
      format_version: self.manifest.format_version,
      weight_dtype: if self.manifest.format_version == 1 {
        "float16"
      } else {
        "float32"
      },
      variant: self.manifest.variant,
      source_sha256: &self.manifest.source_sha256,
      weights_sha256: &self.manifest.weights_sha256,
      input_shape: self.manifest.input_shape,
      output_shape: self.manifest.output_shape,
      layers: self.manifest.layers.len(),
      parameters: self.weights.len(),
      backend: self.backend_identity(),
    }
  }

  /// Evaluate one already prepared tile. The caller supplies CHW samples in the
  /// model's input domain. No transfer function, clipping or strength is added.
  pub fn predict(&self, input: &Tensor, cancel: &Cancel) -> Result<Tensor> {
    #[cfg(feature = "adobe-denoise-cuda")]
    if let Some(cuda) = &self.cuda {
      return cuda.predict(input, cancel);
    }
    #[cfg(feature = "adobe-denoise-coreml")]
    if let Some(coreml) = &self.coreml {
      return coreml.predict(input, cancel);
    }
    #[cfg(feature = "adobe-denoise-gpu")]
    if let Some(gpu) = &self.gpu {
      return gpu.predict(input, cancel);
    }
    self.predict_with_observer(input, cancel, |_, _, _| Ok(()))
  }

  /// Observe selected layers in planar CHW order for numerical localization.
  /// Selected intermediates are copied; `predict` skips those copies.
  /// Return true from `observe_layer` to request the copy for a selected node.
  pub fn predict_observed(
    &self,
    input: &Tensor,
    cancel: &Cancel,
    mut observe_layer: impl FnMut(usize, &str) -> bool,
    mut observer: impl FnMut(usize, &str, &Tensor) -> Result<()>,
  ) -> Result<Tensor> {
    #[cfg(feature = "adobe-denoise-cuda")]
    if self.cuda.is_some() {
      return Err(invalid("layer observation requires the CPU backend"));
    }
    #[cfg(feature = "adobe-denoise-coreml")]
    if self.coreml.is_some() {
      return Err(invalid("layer observation requires the CPU backend"));
    }
    #[cfg(feature = "adobe-denoise-gpu")]
    if self.gpu.is_some() {
      return Err(invalid("layer observation requires the CPU backend"));
    }
    self.predict_with_observer(input, cancel, |i, name, b| {
      if observe_layer(i, name) {
        observer(i, name, &b.to_planar()?)?;
      }
      Ok(())
    })
  }

  fn predict_with_observer(
    &self,
    input: &Tensor,
    cancel: &Cancel,
    mut observer: impl FnMut(usize, &str, &Buffer) -> Result<()>,
  ) -> Result<Tensor> {
    cancel.check()?;
    if input.shape() != self.manifest.input_shape {
      return Err(invalid("model input shape mismatch"));
    }
    let mut nodes: Vec<Option<Buffer>> = vec![None; self.shapes.len()];
    nodes[0] = Some(Buffer::from_planar(input));
    let mut uses = self.uses.clone();
    for (i, l) in self.manifest.layers.iter().enumerate() {
      cancel.check()?;
      let mut args: Vec<Buffer> = l
        .inputs
        .iter()
        .map(|&j| {
          uses[j] -= 1;
          if uses[j] == 0 {
            nodes[j].take().expect("validated live graph")
          } else {
            nodes[j].as_ref().expect("validated live graph").clone()
          }
        })
        .collect();
      let a = args.remove(0);
      let b = match l.op {
        Op::Identity { .. } => a,
        Op::LeakyRelu { alpha } => a.map(|v| if v < 0.0 { v * alpha } else { v }),
        Op::Add { .. } => {
          let rhs = args.remove(0);
          let shape = a.shape;
          let mut data = a.into_vec();
          data
            .par_iter_mut()
            .zip(rhs.data.par_iter())
            .for_each(|(x, y)| *x += *y);
          Buffer::new(shape, data)
        }
        Op::Concat { .. } => {
          let rhs = args.remove(0);
          let shape = self.shapes[i + 1];
          let mut data = vec![0.0; elements(shape)?];
          data
            .par_chunks_mut(shape[0])
            .enumerate()
            .for_each(|(pixel, out)| {
              let left = pixel * a.shape[0];
              let right = pixel * rhs.shape[0];
              out[..a.shape[0]].copy_from_slice(&a.data[left..left + a.shape[0]]);
              out[a.shape[0]..].copy_from_slice(&rhs.data[right..right + rhs.shape[0]]);
            });
          Buffer::new(shape, data)
        }
        Op::Upsample { .. } => kernels::upsample(&a, self.shapes[i + 1], cancel)?,
        Op::Slice { axis, start, .. } => {
          kernels::slice(&a, self.shapes[i + 1], axis, start, cancel)?
        }
        Op::Conv2d { .. } => {
          kernels::convolve(&a, self.shapes[i + 1], &l.op, &self.weights, cancel)?
        }
      };
      observer(i + 1, &l.name, &b)?;
      nodes[i + 1] = Some(b);
    }
    cancel.check()?;
    nodes[self.manifest.output]
      .take()
      .expect("validated output")
      .to_planar()
  }
}

/// Internal HWC storage lets GEMM write disjoint spatial blocks directly, and
/// avoids a whole-image im2col allocation. Public/file tensor layout stays CHW.
#[derive(Clone)]
struct Buffer {
  shape: [usize; 3],
  data: Arc<Vec<f32>>,
}
impl Buffer {
  fn new(shape: [usize; 3], data: Vec<f32>) -> Self {
    Self {
      shape,
      data: Arc::new(data),
    }
  }
  fn from_planar(t: &Tensor) -> Self {
    let [c, h, w] = t.shape();
    let mut data = vec![0.0; t.data().len()];
    data.par_chunks_mut(c).enumerate().for_each(|(i, p)| {
      for j in 0..c {
        p[j] = t.data()[j * h * w + i];
      }
    });
    Self::new(t.shape(), data)
  }
  fn to_planar(&self) -> Result<Tensor> {
    let [c, h, w] = self.shape;
    let mut data = vec![0.0; self.data.len()];
    data.par_chunks_mut(h * w).enumerate().for_each(|(j, p)| {
      for (i, v) in p.iter_mut().enumerate() {
        *v = self.data[i * c + j];
      }
    });
    Tensor::new(self.shape, data)
  }
  fn into_vec(self) -> Vec<f32> {
    Arc::try_unwrap(self.data).unwrap_or_else(|v| (*v).clone())
  }
  fn map(self, f: impl Fn(f32) -> f32 + Sync) -> Self {
    let shape = self.shape;
    let mut data = self.into_vec();
    data.par_iter_mut().for_each(|v| *v = f(*v));
    Self::new(shape, data)
  }
}
