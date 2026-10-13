//! Make-neutral RAW metadata: everything the pipeline needs from a file, in sensor
//! (unrotated) coordinates. Each container parser (`raf`, `arw`, `dng`) fills one in.

use crate::cfa::CfaPattern;

/// The container the file came in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Container {
  Raf,
  Arw,
  Dng,
}

/// How the sensor data is stored, as byte ranges of the complete file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RawStorage {
  /// Fuji lossless compressed stream ("FujiCompressed", header signature 0x4953).
  FujiCompressed { offset: usize, length: usize },
  /// Uncompressed little-endian 16-bit samples, `bits` significant.
  Uncompressed { offset: usize, length: usize },
  /// Lossless JPEG (ITU T.81 process 14) tiles, row-major over the image. Each tile
  /// decodes to `tile_width x tile_height` samples per component; components are
  /// interleaved horizontally (`samples_per_pixel` must be 1 for a CFA mosaic).
  LosslessJpegTiles {
    tiles: Vec<(usize, usize)>,
    tile_width: usize,
    tile_height: usize,
  },
  /// Sony lossy "Compressed RAW" (cRAW): 32-pixel blocks with 7-bit deltas.
  SonyCompressed { offset: usize, length: usize },
}

/// Lens-correction parameter arrays as stored by the camera.
#[derive(Clone, Debug, Default)]
pub enum LensSource {
  #[default]
  None,
  /// Fuji FujiIFD 0xf00b / 0xf00f / 0xf010.
  Fuji(LensParams),
  /// Sony SR2/ARW DistortionCorrParams / ChromaticAberrationCorrParams /
  /// VignettingCorrParams (16 knots each).
  Sony(LensParams),
}

/// Lens-correction arrays (format defined by the `LensSource` variant).
#[derive(Clone, Debug, Default)]
pub struct LensParams {
  pub distortion: Option<Vec<f64>>,
  pub chromatic_aberration: Option<Vec<f64>>,
  pub vignetting: Option<Vec<f64>>,
}

#[derive(Clone, Debug)]
pub struct RawMetadata {
  pub container: Container,
  pub make: String,
  pub model: String,
  /// Stored sensor readout size, in pixels.
  pub raw_width: usize,
  pub raw_height: usize,
  /// Active area (crop) within the readout.
  pub crop_top: usize,
  pub crop_left: usize,
  pub crop_width: usize,
  pub crop_height: usize,
  pub bits_per_sample: u32,
  /// Black levels, one per CFA position, row-major over the CFA repeat
  /// (`cfa.width * cfa.height` values).
  pub black_levels: Vec<u16>,
  /// The camera's white level when recorded (the profile's measured value takes
  /// precedence).
  pub white_level: Option<u32>,
  /// As-shot white-balance multipliers (R, G, B), normalised so G = 1.
  pub as_shot_wb: [f64; 3],
  pub cfa: CfaPattern,
  pub storage: RawStorage,
  /// EXIF orientation (1-8).
  pub orientation: u16,
  pub iso: Option<u32>,
  /// Fuji RawExposureBias (CFA header 0x9650) in EV, when present.
  pub raw_exposure_bias: Option<f64>,
  pub lens: LensSource,
  pub lens_model: Option<String>,
  pub focal_length: Option<f64>,
}

impl RawMetadata {
  /// Black level at an absolute sensor position.
  #[inline]
  pub fn black_at(&self, row: usize, col: usize) -> u16 {
    let (w, h) = (self.cfa.width, self.cfa.height);
    self
      .black_levels
      .get((row % h) * w + col % w)
      .copied()
      .unwrap_or(0)
  }

  pub fn mean_black(&self) -> f32 {
    self.black_levels.iter().map(|&b| b as f32).sum::<f32>() / self.black_levels.len().max(1) as f32
  }
}
