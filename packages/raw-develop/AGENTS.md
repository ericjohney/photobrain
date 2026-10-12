# RAW Develop Agent Guide

Scope: `packages/raw-develop`. Detailed documentation lives in [`docs/`](docs/README.md): [pipeline](docs/pipeline.md), [RAF format and decoder](docs/raf-format.md), [colour](docs/color.md), [camera profiles](docs/camera-profiles.md), [adding a camera](docs/adding-a-camera.md), [validation](docs/validation.md), [usage](docs/usage.md), [Apple reference](docs/apple-reference.md).

## Package Boundary

A standalone Rust library and CLI that develops Fujifilm X-Trans RAF files into Display P3 images, following the stage order of Apple's RawCamera (Preview/Photos) pipeline and calibrated against its renders. It is **not** wired into `image-processing`, scans, thumbnails, or export yet; those still use the embedded JPEG preview. It has no N-API surface and is not part of the Docker image.

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

- `Negative` is immutable: RAF metadata (`raf::RafMetadata`) plus the full-readout `u16` mosaic.
- `develop` is a pure function of `(Negative, DevelopSettings, Options)`, built for edit features: `DevelopSettings` is serde JSON with `settings_version` (white balance as-shot or kelvin/tint, exposure EV, highlight recovery, luma/chroma NR, sharpening, tone amount, lens toggles, normalised crop, quarter turns). Unknown fields are rejected; omitted fields take as-shot defaults.
- `Options { quality: Full | Preview, keep_linear }`. `Preview` bins each 3x3 X-Trans cell (exact 5G/2R/2B) for one-third resolution, about 10x faster.
- `PIPELINE_VERSION` must be bumped when output changes for the same input and settings (mirror of the API's `MEDIA_VERSION` contract, for future caching).

## Pipeline (`src/pipeline.rs`)

1. Linearise per CFA position (`black_levels`, profile `white_level`), white balance (`WB_GRBLevels` or kelvin/tint through the DNG colour matrices).
2. Demosaic (`stages/demosaic.rs`): edge-directed green, colour-difference R/B, then luma/chroma refinement. Crop to `RawImageCropTopLeft`/`CroppedSize`.
3. Noise reduction (`stages/detail.rs`): chroma NR strength/radius scale with ISO; luma NR default rises above ISO 640.
4. Lens correction (`stages/lens.rs`) from the file's FujiIFD `GeometricDistortionParams`/`ChromaticAberrationParams`/`VignettingParams`. Vignetting is off by default because Apple's as-shot render does not apply it.
5. Highlight reconstruction (`stages/highlights.rs`).
6. Camera to scene-linear Display P3: `look_matrix(T) · XYZ_D50→P3 · ForwardMatrix(T)`, then `(x − black_render) · 2^(baseline_exposure − RawExposureBias + exposure)`.
7. Sharpening, gamut compression, per-channel tone curve to encoded P3, orientation, user rotation/crop.

## Invariants

- The Fuji lossless decoder (`unpack/fuji_compressed.rs`) is **bit-exact** with Apple's RawCamera decode on every fixture. Any change must keep `cargo test --release --test fixtures` passing.
- RAF CFA-header record `0x131` (X-Trans layout) is stored in reverse raster order; `CfaPattern::from_raf_xtrans_layout` handles this. Patterns are addressed in absolute sensor coordinates; use `shifted` after cropping.
- `RawExposureBias` comes from CFA-header record `0x9650` (int16 value / int16 divisor).
- Camera profiles live in `profiles/<make>-<model>.toml` and are compiled in (`profile::BUILTIN`). Every profile documents its provenance. ColorMatrix/ForwardMatrix come from Adobe DNG Converter output; look matrices, exposure offset, black render, tone curve, and distortion fill scale are our own least-squares fits. Never copy Apple per-camera plist values or kernel code into the repository.
- Only X-Trans RAF is supported. Bayer RAFs and other makes return `Error::Unsupported`.

## Validating Against Apple (macOS only)

`tools/apple-reference/apple-reference.m` runs CIRAWFilter on a RAF and writes `params.json`, `graph.txt` (CI_PRINT_TREE), `cfa.u16` (RawCamera's decoded mosaic, captured by hooking the `CRawImage` CIImage provider), scene-linear captures at the `linearSpaceFilter` hook (`default`/`nonr`/`nolens`), and the final render (`.q.f32` is 4x downsampled, `.crop.f32` is a full-resolution 1024px centre crop).

```bash
bun run apple-reference                                    # builds target/apple-reference
for f in ~/raw-develop-fixtures/*.RAF; do target/apple-reference "$f" ~/raw-develop-refs/$(basename "$f" .RAF); done
RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures RAW_DEVELOP_REFS=~/raw-develop-refs cargo test --release --test fixtures -- --nocapture
```

Fixture tests skip (with a message) when the variables are unset; RAW files are never required by `cargo test`. Calibration scripts are in `tools/calibrate/` (see its README).

## Current Accuracy (11 X-E5 fixtures, ISO 64–12800)

Decoder: bit-exact on all 11. Final render vs Apple at quarter scale, CIEDE2000 mean: 0.5–2.6 at ISO ≤ 3200, 3.0–3.1 at ISO 10000–12800; with fine texture removed (σ = 2 px blur) 0.4–1.9, and 2.6 for ISO 12800. Remaining differences are mostly demosaic/NR texture and high-ISO noise reduction. Timings on Apple Silicon: decode about 0.1 s, full develop about 1 s, preview about 0.08 s for 40 MP.
