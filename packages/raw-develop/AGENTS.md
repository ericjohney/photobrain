# RAW Develop Agent Guide

Scope: `packages/raw-develop`. Detailed documentation lives in [`docs/`](docs/README.md): [pipeline](docs/pipeline.md), [RAF format and decoder](docs/raf-format.md), [colour](docs/color.md), [camera profiles](docs/camera-profiles.md), [noise reduction](docs/noise-reduction.md), [adding a camera](docs/adding-a-camera.md), [validation](docs/validation.md), [usage](docs/usage.md), [Apple reference](docs/apple-reference.md).

## Package Boundary

A standalone Rust library and CLI that develops Fujifilm X-Trans RAF files (X-E5, X100VI) into Display P3 images, following Apple's RawCamera (Preview/Photos) pipeline: several stages are ports of RawCamera's Core Image kernels, and the rest are calibrated against its renders. It is **not** wired into `image-processing`, scans, thumbnails, or export yet; those still use the embedded JPEG preview. It has no N-API surface and is not part of the Docker image.

```bash
cd packages/raw-develop && cargo test               # unit tests, no RAW files needed
cd packages/raw-develop && cargo build --release
target/release/raw-develop info <file.RAF>
target/release/raw-develop develop <file.RAF> out.png [--preview] [--settings s.json] [--dump-linear f.f32] [--dump-final f.f32]
target/release/raw-compare final|linear <ours.f32> <apple.f32>   # ΔE00 against a reference
```

`turbo run build` picks up the `build` script (`cargo build --release`); Docker and CI do not copy this package.

## Public API

```rust
let neg = Negative::open(path)?;                          // parse + decode once; cache this
let out = develop(&neg, &DevelopSettings::default(), &Options::default())?;
encode::write(&out.image, path, encode::Format::Png16)?;  // PNG/JPEG with embedded Display P3 ICC
```

- `Negative` is immutable: make-neutral metadata (`metadata::RawMetadata`, filled by `raf::parse`; the container is detected by magic bytes) plus the full-readout `u16` mosaic.
- `develop` is a pure function of `(Negative, DevelopSettings, Options)`, built for edit features: `DevelopSettings` is serde JSON with `settings_version` (white balance as-shot or kelvin/tint, exposure EV, highlight recovery, luma/chroma NR, sharpening, tone amount, lens toggles, normalised crop, quarter turns). Unknown fields are rejected; omitted fields take as-shot defaults.
- `Options { quality: Full | Preview, keep_linear }`. `Full` runs the ported `deXtrans_v8` demosaic and RawCamera's chroma NR and luma pyramid. `Preview` bins each 3x3 X-Trans cell (exact 5G/2R/2B) for one-third resolution, about 20x faster, and uses the generic `stages/detail.rs` filters for luma NR and sharpening.
- `PIPELINE_VERSION` must be bumped when output changes for the same input and settings (mirror of the API's `MEDIA_VERSION` contract, for future caching).

## Pipeline (`src/pipeline.rs`, `PIPELINE_VERSION` 2)

1. Linearise and white-balance inputs per CFA position (`black_levels`, profile `white_level`, `WB_GRBLevels` or kelvin/tint through the DNG colour matrices).
2. Demosaic and crop to `RawImageCropTopLeft`/`CroppedSize`. `Full`: `stages/dextrans.rs`, a port of `deXtrans_v8` on the raw `u16` full readout (periodic edge extension), noise mixer driven by the profile's per-ISO `rn`; output is unbalanced camera RGB, then WB is applied. `Preview`: 3x3 binning (`stages/demosaic.rs`). A profile without a `[[noise]]` table falls back to the older `demosaic::full`.
3. Noise reduction (`Full` with a noise table): `stages/chroma_nr.rs` (`extractHRGB(HF)` → `powerBlur*` chain at half resolution → `expandHRGB`) and `stages/luma.rs` (5-level Laplacian luma pyramid with `thru_g`/`thru_g2`/`thru_g3` levels), recombined by `YAndRGBGather`. Sharpening happens inside the luma pyramid. Otherwise `stages/detail.rs` (ISO-based luma NR, unsharp mask after stage 6).
4. Lens correction (`stages/lens.rs`, `radialLens`): distortion only by default, from the file's FujiIFD `GeometricDistortionParams`, Catmull-Rom bicubic resampling. CA and vignetting are available as edits but off, because Apple applies neither.
5. Highlight recovery (`stages/highlights.rs`, port of `RAWRecoverHighlightsV2`).
6. Camera to scene-linear Display P3: `look_matrix(T) · XYZ_D50→P3 · ForwardMatrix(T)`, then `(x − black_render) · 2^(baseline_exposure − RawExposureBias + exposure)`.
7. Look (`stages/look.rs`): `RAWHueMagnetMR` → `gmKernel_v7` → `boost_v7` (linear), then the sRGB transfer to encoded Display P3.
8. Orientation, user rotation and crop.

## Invariants

- The Fuji lossless decoder (`unpack/fuji_compressed.rs`) is **bit-exact** with Apple's RawCamera decode on every fixture. Any change must keep `cargo test --release --test fixtures` passing.
- RAF CFA-header record `0x131` (X-Trans layout) is stored in reverse raster order; `CfaPattern::from_raf_xtrans_layout` handles this. Patterns are addressed in absolute sensor coordinates; use `shifted` after cropping.
- `RawExposureBias` comes from CFA-header record `0x9650` (int16 value / int16 divisor).
- Camera profiles live in `profiles/<make>-<model>.toml` and are compiled in (`profile::BUILTIN`). Every profile documents its provenance. ColorMatrix/ForwardMatrix come from Adobe DNG Converter output. The per-ISO `[[noise]]` parameters are read from RawCamera render graphs (`CI_PRINT_TREE`) for that camera. Look matrices, exposure offset, black render, and distortion fill scale are our own least-squares fits.
- Reimplementing RawCamera's methodology is allowed: stages may be ports of RawCamera Core Image kernels, and each such module names its kernels in its module doc. Kernel source was captured locally at runtime (swizzling `+[CIKernel kernelsWithString:messageLog:]` while CIRAWFilter rendered; a scratch tool, not in the repository). Do not commit raw kernel source dumps or Apple plists wholesale.
- Planes inside `stages/luma.rs` use Core Image orientation (row 0 at the bottom) so kernel direction vectors and asymmetric stencils match.
- Only X-Trans RAF is supported. Bayer RAFs and other makes return `Error::Unsupported`.

## Validating Against Apple (macOS only)

`tools/apple-reference/apple-reference.m` runs CIRAWFilter on a RAF and writes `params.json`, `graph.txt` (CI_PRINT_TREE), `cfa.u16` (RawCamera's decoded mosaic, captured by hooking the `CRawImage` CIImage provider), scene-linear captures at the `linearSpaceFilter` hook (`default`/`nonr`/`nolens`), and the final render (`.q.f32` is 4x downsampled, `.crop.f32` is a full-resolution 1024px centre crop).

```bash
bun run apple-reference                                    # builds target/apple-reference
for f in ~/raw-develop-fixtures/*.RAF; do target/apple-reference "$f" ~/raw-develop-refs/$(basename "$f" .RAF); done
RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures RAW_DEVELOP_REFS=~/raw-develop-refs cargo test --release --test fixtures -- --nocapture
```

Fixture tests skip (with a message) when the variables are unset; RAW files are never required by `cargo test`. Calibration scripts are in `tools/calibrate/` (see its README).

## Current Accuracy (11 X-E5 fixtures, ISO 64–12800; X100VI)

Decoder: bit-exact on all 11. Final render vs Apple at quarter scale, CIEDE2000 mean 0.00–0.41 (p95 ≤ 1.47) on every fixture, including ISO 10000–12800; see [validation](docs/validation.md#current-results). The fixture test requires mean absolute encoded difference below 0.006 (observed maximum 0.0032). Timings on Apple Silicon for 40 MP: decode about 0.1 s, full develop about 2.5 s, preview about 0.12 s.

X100VI (one fixture; ISO 500 and an ISO-patched 12800 copy): decoder bit-exact, CIEDE2000 mean 0.43 / 0.46. Other cameras in the production library are planned in [docs/plan-other-cameras.md](docs/plan-other-cameras.md).
