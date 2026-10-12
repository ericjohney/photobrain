# Camera profiles

A camera profile holds the per-model data the pipeline cannot read from the RAF itself.
Profiles are TOML files in `profiles/`, compiled into the binary by the `BUILTIN` table in
`src/profile.rs`, and selected by the EXIF/RAF model name:

```rust
const BUILTIN: &[(&str, &str)] = &[("X-E5", include_str!("../profiles/fujifilm-x-e5.toml"))];
```

`CameraProfile::builtin(model)` matches case-insensitively. A model with no profile fails
`develop` with `Error::Unsupported("no camera profile for …")`. Nothing falls back
silently to another camera's colour.

## Fields

| Key | Type | Source | Meaning |
|---|---|---|---|
| `make`, `model` | string | – | for humans; `model` should match the RAF model |
| `white_level` | float | measured (clip level) | raw value treated as white; linearise divides by `white_level − black` |
| `base_iso` | float | spec sheet | lowest native ISO; noise reduction scales with `ISO / base_iso` (default 100) |
| `calibration_illuminant_1/2` | float K | DNG (`CalibrationIlluminant1/2`; 17 = StdA 2856 K, 21 = D65 6504 K) | interpolation endpoints |
| `color_matrix_1/2` | 9 floats, row-major | DNG `ColorMatrix1/2` | XYZ → camera, for white balance from temperature and CCT estimation |
| `forward_matrix_1/2` | 9 floats | DNG `ForwardMatrix1/2` | white-balanced camera → XYZ D50 |
| `baseline_exposure` | EV | **fitted** | exposure offset before the look (plus −RawExposureBias) |
| `black_render` | float | **fitted** (default 0) | linear offset subtracted before exposure |
| `look_matrix_1/2` | 9 floats, rows sum to 1 | **fitted** | rendering colour adjustment in linear P3 |
| `distortion_fill_scale` | float | **fitted** | extra zoom applied with the Fuji distortion curve |
| `[tone_curve] input/output` | float arrays | **fitted** | scene-linear → encoded per-channel curve; strictly increasing input, non-decreasing output |

Notes:

- Top-level keys must come **before** the `[tone_curve]` table. TOML assigns any key after a
  table header to that table, and the profile then fails to parse with "missing field".
- Every profile must start with a **provenance** comment saying where each group of numbers
  came from (DNG Converter version and source file; fixtures and script used for the fits).
- Never commit values copied from Apple's per-camera plists (`raf.fuji.*.camera` in
  `RawCameraSupport.bundle` or the MobileAsset `RawCamera.Camera` assets). They may be read
  locally to sanity-check a fit, nothing more.

## What comes from the RAF, not the profile

Black levels, crop, CFA layout, as-shot white balance, RawExposureBias, ISO, orientation and
all lens-correction curves are read from each file. A new body with the same sensor and
container therefore often needs only a profile.

## Tests every profile gets

`profile::tests::every_builtin_profile_loads` parses every entry in `BUILTIN` and checks
that the `model` field matches its key, that `white_level` and `base_iso` are sane, and that
the look matrices preserve white. The X-E5-specific tests also check that a white-balanced
neutral maps to achromatic P3 and that temperature → neutral → CCT round-trips within 3%.
Add the same two checks for a new camera if its matrices differ much.
