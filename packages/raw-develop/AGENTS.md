# RAW Develop Agent Guide

Scope: `packages/raw-develop`. Detailed documentation lives in [`docs/`](docs/README.md): [pipeline](docs/pipeline.md), [RAF format and decoder](docs/raf-format.md), [colour](docs/color.md), [camera profiles](docs/camera-profiles.md), [noise reduction](docs/noise-reduction.md), [adding a camera](docs/adding-a-camera.md), [validation](docs/validation.md), [usage](docs/usage.md), [Apple reference](docs/apple-reference.md), [plan: other cameras](docs/plan-other-cameras.md).

## Package Boundary

A standalone Rust library and CLI that develops RAW files into Display P3 images, following Apple's RawCamera (Preview/Photos) pipeline: several stages are ports of RawCamera's Core Image kernels, and the rest are calibrated against its renders. Supported:

- Fujifilm X-Trans RAF (X-E5, X100VI): lossless compressed and uncompressed.
- Sony Bayer ARW (ILCE-1M2 / A1 II, ILCE-7CR / A7C R, ILCE-7RM5 / A7R V): uncompressed 14-bit, lossless compressed (tiled lossless JPEG, Compression 7) and lossy "Compressed RAW" / cRAW (Compression 32767).
- Apple ProRAW DNG (iPhone 16 Pro Max lossless JPEG tiles, iPhone 17 Pro Max JPEG XL tiles; DNG 1.6/1.7 LinearRaw). No camera profile: colour, exposure and tone come from DNG tags.

The server integration is the loupe's on-demand **Developed** view: `image-processing` path-depends on it and exposes `renderDevelopedRaw(path, quality, cancel?)` (`src/develop.rs`; `cancel` is an `Int32Array` over a `SharedArrayBuffer` that stops the develop when element 0 becomes non-zero), served by `GET /api/photos/:id/developed`. The addon's turbo `build` task lists this crate's sources as inputs, so `bun run dev:api` rebuilds the addon after any change here. Scans, thumbnails, and export still use the embedded JPEG preview. The Docker builder copies this package for that path dependency.

```bash
cd packages/raw-develop && cargo test               # unit tests, no RAW files needed
cd packages/raw-develop && cargo build --release
target/release/raw-develop info <file.RAF|ARW|DNG>
target/release/raw-develop develop <file> out.png [--preview] [--settings s.json] [--dump-linear f.f32] [--dump-final f.f32]
target/release/raw-compare final|linear <ours.f32> <apple.f32>   # ΔE00 against a reference
```

`turbo run build` picks up the `build` script (`cargo build --release`). JPEG XL decoding uses the `jxl-oxide` crate (MIT/Apache-2.0) behind the default cargo feature `jxl`; without it, JPEG XL DNGs return `Error::Unsupported`.

Native iOS also links `ffi/` through `apps/ios/scripts/build-raw-develop.sh` for the loupe’s session-only **Edit RAW** exposure editor. An owned opaque C session caches 2048/1024-edge prepared images; Swift serialises it on an actor, coalesces slider requests and presents RGBA8 Display P3. The script builds the selected Xcode destination or packages an XCFramework with `--xcframework`. Rust 1.98.0/iOS targets are pinned separately in `ffi/rust-toolchain.toml`; `ffi/Cargo.lock` is independent of the engine CLI lock. Header ownership/cancellation rules are in `ffi/include/RawDevelop.h`. See [interactive editing](docs/interactive-editing.md).

## Public API

```rust
let neg = Negative::open(path)?;                          // parse + decode once; cache this
let out = develop(&neg, &DevelopSettings::default(), &Options::default())?;
encode::write(&out.image, path, encode::Format::Png16)?;  // PNG/JPEG with embedded Display P3 ICC
```

- `Negative` is immutable: make-neutral metadata (`metadata::RawMetadata`: container, geometry, crop, black levels per CFA position, `white_level`, as-shot WB multipliers, CFA, `RawStorage`, orientation, ISO, `raw_exposure_bias`, `LensSource` Fuji/Sony/None) plus the full-readout `u16` mosaic, or for LinearRaw DNG the decoded RGB and `dng::DngInfo`. `Negative::from_bytes` detects the container by magic: `FUJIFILMCCD-RAW ` → `raf::parse`; TIFF with Make `SONY` and no `DNGVersion` → `arw::parse`; TIFF with `DNGVersion` → `dng::parse`.
- `develop` is a pure function of `(Negative, DevelopSettings, Options)`, built for edit features: `DevelopSettings` is serde JSON with `settings_version` (white balance as-shot or kelvin/tint, exposure EV, highlight recovery, luma/chroma NR, sharpening, tone amount, lens toggles, normalised crop, quarter turns). Unknown fields are rejected; omitted fields take as-shot defaults. Kelvin/tint white balance is not yet implemented for DNG (`Error::Unsupported`).
- `Options { quality: Full | Preview, keep_linear, cancel }`. `cancel` (`Cancel`, default never) is checked between stages and between streamed luma steps; once set, `develop` returns `Error::Cancelled` within about 0.1 s. Checks never touch pixel values, so output is unchanged. `Full` runs the ported demosaic (`deXtrans_v8`, or `despeckle_v8` + `deBayer_v8` for Bayer) and RawCamera's chroma NR and luma pyramid. `Preview` bins each 3x3 X-Trans cell (exact 5G/2R/2B, one-third resolution) or 2x2 Bayer cell (half resolution), and uses the generic `stages/detail.rs` filters for luma NR and sharpening.
- `PIPELINE_VERSION` must be bumped when output changes for the same input and settings (mirror of the API's `MEDIA_VERSION` contract, for future caching).
- `prepare(negative, settings, options)` returns an owned immutable `Prepared` working image. `Prepared::render` reuses it for exposure, tone amount, crop and quarter turns; other setting/quality changes return `Error::Settings` and require preparing again. RAF/ARW cache after highlight recovery; DNG caches before its exposure-dependent detail graph (which reruns on every exposure edit). Preview/fallback sharpening also stays after exposure. `with_max_edge` optionally area-resamples the working pixels without clipping linear headroom; it is an approximate screen preview, not bit-exact downsampled output. Unresized one-shot and prepared renders are bit-identical; the one-shot path transfers its buffer to avoid another full-size clone. See [usage](docs/usage.md#repeated-editing).

## Adobe engine (experimental)

`Options::engine = Engine::Adobe` (CLI `--adobe --adobe-profiles DIR`) selects the secondary RAF/ARW engine (`src/adobe/`). Full X-E5/X100VI demosaic and mandatory cleanup follow Adobe 18.7, exact against six complete no-CA linear DNGs. Full Sony Bayer processing matches five no-CA linear DNG crops, including per-body SR2 calibration, high-ISO green balance and long-exposure paired-hot-pixel repair. Mandatory embedded lateral CA matches all 11 complete linear references and runs independently of the optional CA setting. Full rendering integrates camera→preserved-black RIMM, metadata-derived chroma/four-level luma NR, Fuji distortion/vignetting, profile colour, scene-derived statistics and modern global/spatial tone/output. `adobe_noise_reduction` exposes six 0–100 controls; `adobe_tone` exposes integer -100..100 Basic controls, including spatial Highlights/Shadows. Exposure uses the shared EV field. Tone edits reuse the prepared image, original scene summaries and a lazily computed spatial mask. Composed RAW-to-tone/sRGB checks match 4,569,327 Fuji/Sony channels exactly across 11 captured tile/settings cases: six global controls cases, four mixed Highlights/Shadows cases covering both signs, and one Fuji spatial case with distortion/vignetting. Sony DefaultCrop follows NR to preserve its eight-pixel lattice. External LCP and user sharpening are unimplemented. Preview uses generic demosaic and the SDK renderer. Adobe Standard DCP profiles are read at runtime from `Options::adobe_profile_dir` or `ADOBE_PROFILE_DIR` (never bundled). `Engine::Apple` stays the default. Accuracy, provenance and reference instructions: [docs/adobe-engine.md](docs/adobe-engine.md).

Performance paths retain exact arithmetic: Gaussian spatial-mask rows share the
Rayon pool above a size threshold; luma NR uses 384-pixel lattice-aligned tiles
(chroma-only: 192); primary tone and exposure batch four independent pixels with
AArch64 NEON for both global and spatial edits. The output gamma table is shared,
and identity orientation skips a copy. See the paired measurements and rejected
trials in [Adobe engine performance](docs/adobe-engine.md#performance-and-exact-output-optimization).
Mandatory X-Trans cleanup and default chroma NR use an exact median-selection
network (fractional NR ranks keep their full sort). X-Trans directional cleanup
also batches four independent pixels with AArch64 NEON, preserving all 68 tap
contributions and scalar rounding/FMA order; other targets retain scalar code.
Profile colour also batches four independent pixels on AArch64: HSV conversion
and encoded-value arithmetic use exact division/FMA, while coefficient gathers
retain checked indexing and the original hue/value/saturation interpolation.
The black-removal and u16 boundaries remain intact, including fused spatial edits.
Tone/exposure table lookups also batch four positions, retaining checked scalar
coefficient gathers and the original separate multiply/add interpolation.
Preparation owns its RGB buffer. Mandatory active-image CA retains packed
u16 samples and exact float identity planes, releasing demosaic RGB before
allocating its output; two identity planes retain the direct path. Optional
Fuji distortion and NR reuse the RGB buffer after retaining their immutable
u16 source. NR encodes each source pixel once, including neighbouring halos;
CA/NR scratch uses anonymous mappings whose pages are released at stage return.
Sony's final DefaultCrop compacts rows in the owned allocation after NR. Failed
or cancelled preparation returns no image. Camera-pyramid reductions parallelize
independent rows above a size threshold without changing per-pixel integer sums.
Chroma NR's low-pass intermediate retains only the horizontal columns sampled
by its vertical reduction. Active CA uses bounded four-pixel row slices for
interior footprints and retains the generic clamped sampler at image edges.
Output conversion batches four pixels on AArch64, preserving ties-to-even u16
quantization, the signed fixed matrix and checked scalar gamma gathers.

## Code Layout

- `src/metadata.rs`: `RawMetadata`; `src/negative.rs`: container detection and decode.
- `src/prepared.rs`: reusable working image, render-setting validation, format-specific late stages and output geometry. `src/bin/raw-edit-bench.rs`: JSON benchmark of decode/preparation/resize and warmed repeated exposure renders (`--max-edge`, `--iterations`, `--threads`, `--full`, `--settings`). No encoding, network or UI latency is included.
- `src/tiff.rs`: shared bounded TIFF reader (`read_ifd0_exif`), used by RAF, ARW and DNG.
- `src/raf/`, `src/arw.rs`, `src/dng.rs`: containers. ARW reads the raw SubIFD (Photometric 32803): `DefaultCropOrigin`/`DefaultCropSize` (RawCamera crops to exactly this), `BlackLevel` 0x7310, `WhiteLevel` 0x787f, `WB_RGGBLevels` 0x7313 (plain as-shot WB), plus bounded encrypted SR2 `WB_RGBLevelsDaylight` for Adobe per-body calibration, `SonyToneCurve` 0x7010, `DistortionCorrection` 0x7036 + `DistortionCorrParams` 0x7037. DNG reads LinearRaw tiles, `LinearizationTable`, colour/exposure tags, `ProfileToneCurve` and the DNG 1.7 `ProfileGainTableMap`.
- `src/unpack/`: `fuji_compressed.rs`, `ljpeg.rs` (ITU-T T.81 lossless JPEG, all seven predictors, restart intervals, point transform; tile assembly in `mod.rs`), `sony_craw.rs` (cRAW), JPEG XL through `jxl-oxide`.
- `src/stages/`: `dextrans.rs`, `debayer.rs` (`despeckle_v8`, `deBayer_v8`), `chroma_nr.rs`, `luma.rs`, `lens.rs`, `highlights.rs`, `look.rs`, and the DNG-only `dng_detail.rs` (the "8.dng" detail graph) and `dng_look.rs` (`profileGainTableMap`, `boost_lut`).

## Default Apple pipeline (`src/pipeline.rs`, `PIPELINE_VERSION` 5)

RAF and ARW (mosaic):

1. Linearise and white-balance inputs per CFA position (`black_levels`, profile `white_level`, as-shot WB from `WB_GRBLevels`/`WB_RGGBLevels`, or kelvin/tint through the DNG colour matrices).
2. Demosaic and crop to the file's crop. `Full` with a noise table: `stages/dextrans.rs` (`deXtrans_v8`) for X-Trans, or `stages/debayer.rs` (`despeckle_v8` with the per-ISO `despeckle` amount, then `deBayer_v8` with the profile's `demosaic_exposure_factor`) for Bayer, on the raw `u16` full readout; output is unbalanced camera RGB, then WB is applied. `Preview`: 3x3 (X-Trans) or 2x2 (Bayer) binning (`stages/demosaic.rs`). A profile without a `[[noise]]` table falls back to the older `demosaic::full`.
3. Noise reduction (`Full` with a noise table): `stages/chroma_nr.rs` (`extractHRGB(HF)` → `powerBlur*` chain at half resolution → `expandHRGB`, or one fused `powerBlurLFS` pass) and `stages/luma.rs` (5-level Laplacian luma pyramid with `thru_g`/`thru_g2`/`thru_g3` levels, `smoothDSharpen[AntiBloom]`, optional `FGN`/`addFGN` fine grain), recombined by `YAndRGBGather`. Otherwise `stages/detail.rs` (ISO-based luma NR, unsharp mask after stage 6).
4. Lens correction (`stages/lens.rs`, `radialLens`): distortion only by default, Catmull-Rom bicubic resampling. Fuji: FujiIFD `GeometricDistortionParams`. Sony: `(1 + d/16384)` at n evenly spaced radii normalised to 1 at the half-diagonal, only when `DistortionCorrection` is 1; Sony CA and vignetting arrays are ignored, like RawCamera.
5. Highlight recovery (`stages/highlights.rs`, port of `RAWRecoverHighlightsV2`).
6. Camera to scene-linear Display P3: `look_matrix(T) · XYZ_D50→P3 · ForwardMatrix(T)`, then `(x − black_render) · 2^(baseline_exposure − RawExposureBias + exposure)`.
7. Look (`stages/look.rs`): `RAWHueMagnetMR` → `gmKernel_v7` → `boost_v7` (linear), then the sRGB transfer to encoded Display P3.
8. Orientation, user rotation and crop.

LinearRaw DNG (`prepare_dng` + prepared renderer): detail (`stages/dng_detail.rs`) → highlight recovery with thresholds `[1, 0.9, 1]` → camera to XYZ D50 → linear Display P3 → exposure `2^BaselineExposure` → `profileGainTableMap` → `gmKernel_v7` → `boost_lut` from `ProfileToneCurve` → sRGB transfer → orientation. Colour follows RawCamera's `RAWConvert`: the white xy is found from `AsShotNeutral` by iterating CCT → interpolated XYZ-to-camera (`AnalogBalance` × `ColorMatrix`, mired weighting); a forward matrix is synthesised per calibration illuminant (Bradford adaptation to D50, ratios clamped to [0.1, 10]) and interpolated with the same weight. Every detail parameter is a constant or a multiple of the exposure gain, so there are no per-phone tables.

## Invariants

- The decoders (`unpack/fuji_compressed.rs`, `unpack/ljpeg.rs`, `unpack/sony_craw.rs`, uncompressed paths) are **bit-exact** with Apple's RawCamera decode on every fixture; DNG decode is exact after rounding to half float (RawCamera's provider format). Any change must keep `cargo test --release --test fixtures` passing.
- RAF CFA-header record `0x131` (X-Trans layout) is stored in reverse raster order; `CfaPattern::from_raf_xtrans_layout` handles this. Patterns are addressed in absolute sensor coordinates; use `shifted` after cropping.
- `RawExposureBias` comes from RAF CFA-header record `0x9650` (int16 value / int16 divisor).
- Camera profiles live in `profiles/<make>-<model>.toml` and are compiled in (`profile::BUILTIN`): `fujifilm-x-e5`, `fujifilm-x100vi`, `sony-ilce-1m2`, `sony-ilce-7cr`, `sony-ilce-7rm5`. Every profile documents its provenance. ColorMatrix/ForwardMatrix come from Adobe DNG Converter output. The per-ISO `[[noise]]` parameters are read from RawCamera render graphs (`CI_PRINT_TREE`) for that camera (`tools/calibrate/noise_table.py`). Fuji look matrices, exposure offset, black render and distortion fill scale are our own least-squares fits; Sony ones are derived exactly from the graph's `color_matrix` nodes (`tools/calibrate/graph_color.py`). DNGs need no profile.
- Reimplementing RawCamera's methodology is allowed: stages may be ports of RawCamera Core Image kernels, and each such module names its kernels in its module doc. Kernel source was captured locally at runtime (swizzling `+[CIKernel kernelsWithString:messageLog:]` while CIRAWFilter rendered; a scratch tool, not in the repository). Do not commit raw kernel source dumps or Apple plists wholesale.
- Planes inside `stages/luma.rs` use Core Image orientation (row 0 at the bottom) so kernel direction vectors and asymmetric stencils match.
- Unsupported inputs (Bayer or lossy RAF, other makes, non-LinearRaw DNG, models without a profile) return `Error::Unsupported`.

## Validating Against Apple (macOS only)

`tools/apple-reference/apple-reference.m` runs CIRAWFilter on a RAF, ARW or DNG and writes `params.json`, `graph.txt` (CI_PRINT_TREE), `cfa.u16` (RawCamera's decoded mosaic, captured by hooking the `CRawImage` CIImage provider; `cfa.rgb.f32` of half floats for DNG LinearRaw), scene-linear captures at the `linearSpaceFilter` hook (`default`/`nonr`/`nolens`), and the final render (`.q.f32` is 4x downsampled, `.crop.f32` is a full-resolution 1024px centre crop). `apple-reference FILE --graph OUT` writes only the render graph.

```bash
bun run apple-reference                                    # builds target/apple-reference
for f in ~/raw-develop-fixtures/a1m2/*.ARW; do target/apple-reference "$f" ~/raw-develop-refs/a1m2/$(basename "$f" .ARW); done
RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures/a1m2 RAW_DEVELOP_REFS=~/raw-develop-refs/a1m2 cargo test --release --test fixtures -- --nocapture
```

Fixture directories are `~/raw-develop-fixtures/{x100vi,a1m2,a7cr,a7rm5,iphone16pm,iphone17pm,iphone-more}` (X-E5 files at the top level) with references in `~/raw-develop-refs/<same>`. Fixture tests accept RAF, ARW and DNG and skip (with a message) when the variables are unset; RAW files are never required by `cargo test`. Calibration scripts are in `tools/calibrate/` (see its README).

## Current Accuracy

Quarter-scale final render vs Apple, mean CIEDE2000; decoders bit-exact on every fixture. The fixture test requires mean absolute encoded difference below 0.006 (observed maximum 0.0036). See [validation](docs/validation.md#current-results).

| Camera | Fixtures | ΔE00 mean |
|---|---|---|
| X-E5 | 11, ISO 64–12800 | 0.00–0.41 |
| X100VI | ISO 500 / patched 12800 | 0.43 / 0.46 |
| Sony A1 II | 12766 (APS-C crop, ISO 125), 4309 (uncompressed, ISO 100; patched ISO 3200) | 0.07, 0.05, 0.07 |
| Sony A7C R | 6453 (cRAW, ISO 100), 13567 (ISO 12800) | 0.19, 0.40 |
| Sony A7R V | 13937 (ISO 2000) | 0.21 |
| iPhone 16/17 Pro Max ProRAW | 16 files, ISO 16–6400, all lenses | 0.05–0.09 |

Timings on Apple Silicon (M4 Pro, 12 threads): decode 0.03–0.2 s; full develop about 2.0 s for X-Trans 40 MP, 2.4–2.7 s for Sony 61 MP, 0.4 s for iPhone 12 MP; peak RSS about 2 GB (X-Trans) and 2.4–2.8 GB (Sony): the full-resolution luma level streams through rolling row windows instead of allocating whole-image intermediates. `raw-develop develop … --digest` prints an FNV-1a fingerprint of the exact output floats; performance work must keep it unchanged for every fixture (the hot kernels have interior fast paths and fused passes that are documented as bit-identical to the direct form).
