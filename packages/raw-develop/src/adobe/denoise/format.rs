//! Versioned interchange for caller-owned models, not a Core ML runtime binding.
use super::{Result, invalid};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;

pub(super) const MODEL_MAGIC: &[u8; 8] = b"PBDN0001";
pub(super) const MODEL_MAGIC_F32: &[u8; 8] = b"PBDN0002";
const TENSOR_MAGIC: &[u8; 8] = b"PBDT0001";
pub(super) const MAX_HEADER: usize = 1 << 20;
pub(super) const MAX_WEIGHTS: usize = 32_000_000;
pub(super) const MAX_ELEMENTS: usize = 512 * 1024 * 1024;

/// Recovered ACR networks. Enhance Details is a separate baseline model.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
  Bayer,
  Xtrans,
  LinearRaw,
  PanoramaRaw,
  XtransDetails,
}

/// A contiguous planar f32 tensor in CHW order. No color transfer is implied.
#[derive(Clone, Debug)]
pub struct Tensor {
  shape: [usize; 3],
  data: Vec<f32>,
}

impl Tensor {
  pub fn new(shape: [usize; 3], data: Vec<f32>) -> Result<Self> {
    if elements(shape)? != data.len() || data.iter().any(|v| !v.is_finite()) {
      return Err(invalid("tensor length mismatch or non-finite samples"));
    }
    Ok(Self { shape, data })
  }

  pub fn shape(&self) -> [usize; 3] {
    self.shape
  }
  pub fn data(&self) -> &[f32] {
    &self.data
  }
  pub fn into_data(self) -> Vec<f32> {
    self.data
  }

  /// Read PBDT0001, three little-endian u32 CHW dimensions, then planar f32.
  pub fn read(path: impl AsRef<Path>) -> Result<Self> {
    let mut file = std::fs::File::open(path)?;
    let mut header = [0u8; 20];
    file.read_exact(&mut header)?;
    if &header[..8] != TENSOR_MAGIC {
      return Err(invalid("unknown tensor format"));
    }
    let shape = std::array::from_fn(|i| {
      u32::from_le_bytes(header[8 + i * 4..12 + i * 4].try_into().unwrap()) as usize
    });
    let n = elements(shape)?;
    if file.metadata()?.len() != 20 + n as u64 * 4 {
      return Err(invalid("tensor file length mismatch"));
    }
    let mut bytes = vec![0; n * 4];
    file.read_exact(&mut bytes)?;
    Self::new(
      shape,
      bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|v| f32::from_le_bytes(*v))
        .collect(),
    )
  }

  pub fn write(&self, path: impl AsRef<Path>) -> Result<()> {
    let mut file = std::io::BufWriter::new(std::fs::File::create(path)?);
    file.write_all(TENSOR_MAGIC)?;
    for d in self.shape {
      file.write_all(&(d as u32).to_le_bytes())?;
    }
    for &v in &self.data {
      file.write_all(&v.to_le_bytes())?;
    }
    file.flush()?;
    Ok(())
  }
}

pub(super) fn elements(shape: [usize; 3]) -> Result<usize> {
  let n = shape
    .into_iter()
    .try_fold(1usize, |a, b| a.checked_mul(b))
    .ok_or_else(|| invalid("tensor size overflow"))?;
  if shape.contains(&0) || n > MAX_ELEMENTS || shape.iter().any(|&d| d > 4096) {
    return Err(invalid("tensor shape exceeds denoise limits"));
  }
  Ok(n)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
  pub format_version: u32,
  pub variant: Variant,
  pub source_sha256: String,
  pub weights_sha256: String,
  pub input_shape: [usize; 3],
  pub output_shape: [usize; 3],
  pub output: usize,
  pub layers: Vec<Layer>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct Layer {
  pub name: String,
  pub inputs: Vec<usize>,
  #[serde(flatten)]
  pub op: Op,
}

/// Offsets/counts are scalar units, relative to the binary payload.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WeightRange {
  pub offset: usize,
  pub count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Op {
  Identity {},
  Conv2d {
    in_channels: usize,
    out_channels: usize,
    groups: usize,
    kernel: [usize; 2],
    stride: [usize; 2],
    padding: [usize; 4],
    weights: WeightRange,
    bias: WeightRange,
  },
  LeakyRelu {
    alpha: f32,
  },
  Add {},
  /// Concatenate two tensors along the channel dimension, in input order.
  Concat {},
  Upsample {
    scale: [usize; 2],
  },
  Slice {
    axis: usize,
    start: usize,
    end: usize,
  },
}
