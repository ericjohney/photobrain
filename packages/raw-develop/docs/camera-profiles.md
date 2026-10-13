# Camera profiles

A camera profile holds the per-model data the pipeline cannot read from the RAW file
itself. Profiles are TOML files in `profiles/`, compiled into the binary by the `BUILTIN`
table in `src/profile.rs`, and selected by the EXIF model name:

```rust
const BUILTIN: &[(&str, &str)] = &[
  ("X-E5", include_str!("../profiles/fujifilm-x-e5.toml")),
  ("X100VI", include_str!("../profiles/fujifilm-x100vi.toml")),
  ("ILCE-1M2", include_str!("../profiles/sony-ilce-1m2.toml")),
  ("ILCE-7CR", include_str!("../profiles/sony-ilce-7cr.toml")),
  ("ILCE-7RM5", include_str!("../profiles/sony-ilce-7rm5.toml")),
];
```

| Profile | Camera | Sensor |
|---|---|---|
| `fujifilm-x-e5.toml` | Fujifilm X-E5 | X-Trans 5 HR, RAF |
| `fujifilm-x100vi.toml` | Fujifilm X100VI | X-Trans 5 HR, RAF |
| `sony-ilce-1m2.toml` | Sony A1 II | Bayer RGGB, ARW |
| `sony-ilce-7cr.toml` | Sony A7C R | Bayer RGGB, ARW |
| `sony-ilce-7rm5.toml` | Sony A7R V | Bayer RGGB, ARW |

Apple ProRAW DNGs need no profile: colour, exposure and tone come from the DNG tags
(`ColorMatrix1/2`, `CalibrationIlluminant1/2`, `AnalogBalance`, `AsShotNeutral`,
`BaselineExposure`, `ProfileToneCurve`, `ProfileGainTableMap`), and the detail parameters
are derived from the exposure gain.

`CameraProfile::builtin(model)` matches case-insensitively. A model with no profile fails
`develop` with `Error::Unsupported("no camera profile for …")`. Nothing falls back
silently to another camera's colour.

## Fields

| Key | Type | Source | Meaning |
|---|---|---|---|
| `make`, `model` | string | – | for humans; `model` must match the `BUILTIN` key (EXIF model) |
| `white_level` | float | measured (clip level), or from the demosaic node's `range` | raw value treated as white; linearise divides by `white_level − black`. From a graph: `white = 65535 / range + black` |
| `base_iso` | float | spec sheet | lowest native ISO; the generic `detail.rs` NR (Preview, or no noise table) scales with `ISO / base_iso` |
| `calibration_illuminant_1/2` | float K | DNG (`CalibrationIlluminant1/2`; 17 = StdA 2856 K, 21 = D65 6504 K) | interpolation endpoints |
| `color_matrix_1/2` | 9 floats, row-major | DNG `ColorMatrix1/2` | XYZ → camera, for white balance from temperature and CCT estimation |
| `forward_matrix_1/2` | 9 floats | DNG `ForwardMatrix1/2` | white-balanced camera → XYZ D50 |
| `baseline_exposure` | EV | **fitted** (Fuji) or read from the graph (Sony, `graph_color.py`) | exposure offset before the look (plus −RawExposureBias) |
| `black_render` | float | **fitted** or read from the graph (default 0) | linear offset subtracted before exposure |
| `look_matrix_1/2` | 9 floats, rows sum to 1 | **fitted** (Fuji) or derived exactly from the graph's two `color_matrix` nodes (Sony, `graph_color.py`) | rendering colour adjustment in linear P3 |
| `distortion_fill_scale` | float | **fitted** | extra zoom applied with the Fuji distortion curve |
| `demosaic_exposure_factor` | float, Bayer only | `deBayer_v8` `exposureFactor` in RawCamera's graphs | constant per body; gates the demosaic noise mixer in deep shadows. X-Trans derives it from `RawExposureBias` instead |
| `[[noise]]` | array of tables | RawCamera render graphs | per-ISO demosaic noise model, chroma NR passes and luma pyramid recipe (below) |

### `[[noise]]`

One entry per ISO setting (64–12800 on the X-E5, 21 entries; 64–51200 on the X100VI, 26;
the Sony profiles cover their full ranges, for example 50–102400 on the A1 II);
`noise_for_iso` uses the entry nearest in log2(ISO). Values are read from RawCamera's `CI_PRINT_TREE` graphs for
this camera (see [adding a camera](adding-a-camera.md#8-transcribe-the-noise-tables) and
[noise reduction](noise-reduction.md)).

| Key | Kernel argument | Meaning |
|---|---|---|
| `iso` | – | ISO of the source file |
| `demosaic_noise` | `deXtrans_v8` / `deBayer_v8` `rn` | raw variance model `rn[1] + v·rn[2]` (`rn[0]` unused) |
| `despeckle` | `despeckle_v8` `[amount, neighborPrevention]` | Bayer only: speckle removal before the demosaic (1.25/0 at low ISO, 8.09/1 at ISO 12800) |
| `moire_detect` | `extractHRGBHF` instead of `extractHRGB` | moiré-detecting chroma extract |
| `[[noise.chroma_passes]]` | one `powerBlur*` node each, in order | chroma NR chain |
| `[[noise.luma]]` | one pyramid level each, finest first (4 levels) | luma NR and sharpening |

`[[noise.chroma_passes]]`:

| Key | Kernel argument | Meaning |
|---|---|---|
| `kind` | kernel name: `powerBlurL` → `plain`, `powerBlurEarlyOutL` → `early_out`, `powerBlurLHF` → `hf`, `powerBlurEarlyOutLHFi` → `hf_early_out`, `powerBlurEarlyOut2L` → `early_out2`, `powerBlurDespeckleL` → `despeckle`, `powerBlurLFS` → `fs` | pass variant. `fs` is one fused full-resolution pass (extract, 4-neighbour cross average at half resolution, expand) used alone, with `scale = 0` |
| `scale` | `params[3]` | tap spacing in half-resolution pixels (1, 3, 7, 14; 0 for `fs`) |
| `threshold` | `params2` | `[c0, c1, c2, moire]`; colour-difference threshold `c0 + c1·Y + c2·Y²` |
| `interpolant` | `interpolant` | `hf_early_out` only |
| `despeckle` | `params3`, `params4`, `params5` (4 each) and `params6[0]` (13 values) for `despeckle`; `params3[0..2]` (2 values) for `early_out2` | speckle detector / second threshold |

`params[0..3]` of the `powerBlur*` nodes are the neutral factors, which the code derives from
the white balance, so they are not stored.

`[[noise.luma]]`:

| Key | Kernel argument | Used by |
|---|---|---|
| `kind` | `expandPlusDWithOverdrive` → `plain`, `expandPlusDThruG` → `thru_g`, `expandPlusDThruG2` → `thru_g2`, `expandPlusDThruG3` → `thru_g3` | all |
| `overdrive` | `overdrive` | `plain` |
| `parms`, `roparms` | `parms`, `roparms` | `thru_g*` |
| `omparms` | `omparms[0..2]` | `thru_g*` |
| `dir_to_c` | `DIRToC` `params[0..3]` on that level | `thru_g`, `thru_g3` |
| `anneal` | `annealGAndC` (or `annealG`) `threshmodel[0..3]` | `thru_g*` |
| `cfactor` | `annealGAndC` `cfactor` | `thru_g`, `thru_g3` |
| `sharpen` | each `smoothDSharpen` `parms` (4) + `parms2` (3), finest pass first: 7 values per pass. `smoothDSharpenAntiBloom` passes (X100VI ISO ≥ 10000, high-ISO Sony) add `parms2.a` (anti-bloom range) as an 8th value | `thru_g3`, optionally `thru_g` |
| `fine_grain` | `addFGN` factor (default 0 = off) | full-resolution level: fine-grain noise (`FGN`) re-added outside the structure mask |
| `gabor` | `gaborToSYAndG` `smoothAmt`, `f1` (4), `f2[0..2]` | `thru_g2` |

The first level must be `thru_g2` or `thru_g3`. `profile::tests::every_builtin_profile_loads`
checks that, the level count, `gabor` length for `thru_g2`, and the `despeckle` lengths.

Notes:

- Top-level keys must come **before** the first `[[noise]]` table. TOML assigns any key after
  a table header to that table, and the profile then fails to parse.
- Every profile must start with a **provenance** comment saying where each group of numbers
  came from (DNG Converter version and source file; fixtures and script used for the fits;
  RawCamera version the noise tables were read from).
- Do not commit Apple per-camera plists (`raf.fuji.*.camera` in `RawCameraSupport.bundle` or
  the MobileAsset `RawCamera.Camera` assets) wholesale. The noise tables are the
  per-ISO parameters as they appear in the render graphs, transcribed into the schema above.

## What comes from the file, not the profile

Black levels, crop, CFA layout, as-shot white balance, RawExposureBias, ISO, orientation and
all lens-correction curves (FujiIFD arrays, Sony `DistortionCorrParams`) are read from each
file. A new body with the same sensor and
container therefore often needs only a profile.

## Tests every profile gets

`profile::tests::every_builtin_profile_loads` parses every entry in `BUILTIN` and checks
that the `model` field matches its key, that `white_level` and `base_iso` are sane, and that
the look matrices preserve white, plus the `[[noise]]` structure checks above (including
that an `fs` pass is used alone). The X-E5-specific tests also check that a white-balanced
neutral maps to achromatic P3 and that temperature → neutral → CCT round-trips within 3%.
Add the same two checks for a new camera if its matrices differ much.
