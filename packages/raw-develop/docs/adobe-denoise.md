# Recovered Adobe denoise networks

The optional `adobe-denoise` Cargo feature implements four recovered ACR 18.7
denoise networks and the separate Fuji Enhance Details baseline in native Rust.
It evaluates the original learned parameters with
Rust convolution, activation, residual, upsampling and crop operations. Inference
uses neither Core ML nor Python; Python/Core ML is used only to export local model
assets and generate independent reference outputs.

This is an **experimental model/tile API, RAW-tile exporter and explicit renderer bridge**. `develop`, saved
edit recipes, the server renderer and iOS remain unchanged. Decoded RAW input is
supported only for the explicitly validated layouts below. Partial-strength
RAW tile export is supported for those layouts. The separate experimental display
bridge requires conventional post-denoise NR to be explicitly disabled; native
end-to-end display parity remains unverified.

## Architecture and provenance

The specifications and FP16 parameters were recovered locally from ACR 18.7
(2743). The model loader was traced in the symbol-rich companion DNG Converter;
its decoded specifications were then parsed and run independently through Core ML.
The original Camera Raw arm64 artifact has SHA-256
`317782680193094170d3c25f192fb1256df08111b6c28fb3c2ac0bf9c76f6980`.
Retained REA artifact evidence:
`ev_b9c1ac1090f6a9c8765f4f681c6e5628c99fba1d7e8aa0ddeda5f1fe0fde5a3b`.
Per-model specification and parameter digests are recorded in each exported
bundle and in [the validation record](adobe-denoise-validation.json).

All four models are residual encoder/decoder CNNs. Input is planar `[3,1024,1024]`.
Bayer has 84 convolutions, including 18 four-group convolutions; X-Trans has 70
ordinary convolutions. Both have four downsampling and upsampling levels,
leaky-ReLU with slope 0.2, additive skips, and a global residual. Stage3 and
panorama have the same graph as Bayer with different learned parameters.

| Variant | Export argument | Parameters | Output CHW |
|---|---|---:|---|
| Bayer | `bayer` | 14,956,675 | `[3,800,800]` |
| X-Trans | `xtrans` | 21,952,771 | `[3,864,864]` |
| Stage3 / linear RAW | `linear_raw` | 14,956,675 | `[3,800,800]` |
| Panorama RAW | `panorama_raw` | 14,956,675 | `[3,800,800]` |

The learned parameters remain external runtime assets, as Adobe DCP profiles do.
They are not copied into the repository, fetched automatically, compiled into the
library or shipped with the app. The exporter consumes an already recovered local
`.mlmodel`; it does not decrypt the installed Adobe containers.

The [weight-space programming article](https://rikiyat.github.io/blog/weight-space-programming/)
is relevant to inspecting learned behavior and targeted weight edits. This port
preserves the learned weights: it does not replace them with a smaller hand-written
denoising rule, retrain them, or claim that weight inspection recovers training data.

## Build and run

From the repository root:

```sh
cargo build --release --manifest-path packages/raw-develop/Cargo.toml \
  --features adobe-denoise --bin raw-denoise

# An isolated Python environment needs coremltools and numpy for export/reference work.
python packages/raw-develop/tools/adobe-denoise/export.py \
  /external/dn_bayer.mlmodel /external/dn_bayer.pbdn --variant bayer

packages/raw-develop/target/release/raw-denoise info /external/dn_bayer.pbdn
packages/raw-develop/target/release/raw-denoise predict /external/dn_bayer.pbdn \
  /external/input.f32 /external/output.f32
```

`predict` consumes/produces the `PBDT0001` tensor format: eight-byte magic, three
little-endian u32 dimensions `(channels,height,width)`, then planar little-endian
f32 values. It is distinct from the existing interleaved `RDF32` image format.
`--trace /external/layers` explicitly writes every intermediate in this format;
full-resolution traces can occupy many GiB. Layer filenames use their one-based
node index from the exported graph.

The model format `PBDN0001` contains the versioned JSON graph and original FP16
weight bytes. Loading checks payload SHA-256, parameter ranges, topology, channel
and spatial dimensions, and allocation limits before inference. Unsupported Core
ML operations or attributes cause export failure rather than an approximate
fallback. Payload checksums detect corruption relative to the supplied manifest;
they do not authenticate an arbitrary caller-provided model.

## Rust API

```rust,no_run
use raw_develop::{Cancel, adobe::denoise::{Model, Tensor}};

let model = Model::load("/external/dn_bayer.pbdn")?;
let input = Tensor::read("/external/input.f32")?;
let output = model.predict(&input, &Cancel::never())?;
output.write("/external/output.f32")?;
# Ok::<(), raw_develop::Error>(())
```

`Model` is immutable and can be retained/shared. Each prediction owns its scratch.
Graph reference counts release activations after their last consumer. Internally,
HWC storage lets GEMM write independent spatial blocks directly. Convolution
uses bounded 128-pixel im2col blocks, a direct 1×1 path, and Rayon parallelism;
`RAYON_NUM_THREADS` controls the shared pool. Float sums within each block do not
depend on which worker runs it. Cancellation is checked between graph nodes,
convolution blocks/groups and upsample/crop rows.

`predict_observed` supports selected layer captures for numerical debugging.
The callback receives planar tensors only for the selected nodes; ordinary
`predict` does not materialize those additional copies.

`pack_mosaic_tile` provides the statically recovered sparse-plane packing with
explicit per-channel offsets. Its input must already be normalized and aligned
to the model-local CFA phase. Bayer uses `GR/BG`; X-Trans uses:

```text
G B G G R G
R G R B G B
G B G G R G
G R G G B G
B G B R G R
G R G G B G
```

Missing colors remain zero; supplied offsets are added only at sampled sites.
This helper does not infer sensor orientation, normalization, phase shifts or
histogram-dependent offsets. Linear/panorama variants take dense tensors through
`Tensor::new`. Their direct synthetic response has a brightness shift: caller
normalization and output transfer functions must be traced before treating them
as complete linear-RAW denoisers.

## Numerical validation

Twelve full-size cases cover all four networks with zero input, seeded noise,
and structured color ramps/edges. References use the original `.mlmodel` through
Core ML `CPU_ONLY`; the Rust executor consumes exactly the same input bytes.
Reference manifests bind input/output files to SHA-256 and model digests.

On Apple M4 Pro, macOS 26.5.1, Rust 1.98.1, coremltools 9.0:

- Worst maximum absolute output error: **7.3015689849853516e-6**.
- Worst output RMSE: **2.4034824896567077e-7**.
- All outputs are finite with the declared shape.
- **Not bit-exact against Core ML.** FP16 parameter decoding is exact; f32
  convolution accumulation order differs. This is measured numerical agreement,
  not a full ACR image-equivalence or photographic-quality result.

The regression gates are explicitly `max_abs <= 1e-5` and `RMSE <= 5e-7`, for
these fixed tests. They are not an error bound for arbitrary images. GPU/ANE,
other CPU architectures, and other reduction implementations require their own
validation. Synthetic kernel tests separately exercise exact indexing, groups,
padding, stride, residual lifetimes, crop/upsample semantics, input validation,
CFA phases, cancellation and worker-count repeatability.

Generate references on macOS for each exported variant:

```sh
python packages/raw-develop/tools/adobe-denoise/reference.py generate \
  /external/dn_bayer.mlmodel /external/references --variant bayer --repeat
```

For the four-model regression test, place bundles `dn_bayer.pbdn`,
`dn_xtrans.pbdn`, `dn_s3_raw.pbdn`, `dn_pano_raw.pbdn` in one external directory,
with all variant references/manifests in its `references/` subdirectory:

```sh
RAW_DENOISE_FIXTURES=/external RAYON_NUM_THREADS=8 \
  cargo test --release --manifest-path packages/raw-develop/Cargo.toml \
  --features adobe-denoise --test denoise_fixtures -- --nocapture

cargo test --release --manifest-path packages/raw-develop/Cargo.toml \
  --features adobe-denoise --lib adobe::denoise
python -m unittest discover -s packages/raw-develop/tools/adobe-denoise -v
```

Without `RAW_DENOISE_FIXTURES`, the learned-model test explicitly reports a skip;
synthetic tests always run. See [tool instructions](../tools/adobe-denoise/README.md)
for individual comparisons and the `--require-bit-exact` gate.

## Captured RAW wrapper stages

Controlled replay of the local DNG Converter 18.7 arm64 executable now captures
real Sony A1 II (`12766.ARW`) and Fujifilm X100VI (`DSCF0008.RAF`) denoise tiles.
The capture harness enables denoise at amount 100 in the launched process's
`cr_host` memory; this is not an untouched Camera Raw UI run. Originals and the
installed binary are unchanged. Executable SHA-256:
`4001cc9abfa1e5352aa88c99c84833cf73c0282ad469ace6d8d196adb7d6aacc`.

The `tiles` module reproduces signed source/output rectangle placement and offers
`TileGeometry::crop_model_output`. All **39 native calculator oracle cases**
match exactly, including negative origins and each alignment phase. Maximum
requested tile edges are 799 for Bayer, 859 for X-Trans and 796 for dense RAW.
The `border` module separately implements row-major `TileTraversal`, checked
against 15 native iterator cases. Each requested destination rectangle is copied
once; model output halos do not require overlap averaging.

Real captures verify zero-offset sparse packing and the output crop bit-for-bit:
3,145,728 packed values per camera, plus 1,915,203 Bayer and 2,213,643 X-Trans
cropped values. Conditional histogram offsets are disabled on these denoise
paths. The X-Trans capture also confirms a model output starting at (-4,-4),
with the requested image tile starting at (0,0).

The `transfer` module provides `AffineTable::{remove_black,restore_black,apply}`
and `apply_signed_gamma`. The affine stage uses a 4096-interval float table,
fused interpolation, reflection for negative values and slope-one headroom
extension. Replacing it with a direct affine expression changes rounding.
On the captured Sony tile, black is `2048/65535`, and the input signed gamma is
0.25. All 4,098 table entries, 1,048,576 black-removal samples and 1,048,576 gamma
samples match Adobe **bit-for-bit** on this Mac. New captures also verify gamma 4
and black restoration bit-for-bit for both cameras: 1,915,203 Bayer and 2,213,643
X-Trans values per stage, including all 4,098 restoration-table entries per
camera. Platform `powf` may differ.

`MosaicTilePlan` composes extraction, input transfer/packing and output
crop/inverse transfer for the captured no-gain path. Its composed preprocessing
and postprocessing match the captured real tiles exactly. `extract_source`
samples a calibrated canonical mosaic without allocating a full padded image.
`Model::predict_mosaic_tiles` streams disjoint RGB results through a callback,
using one inference scratch allocation at a time. A crop-only synthetic model
checks four-tile stitching, CFA phase, trailing partial tiles and cancellation.
Network inference inside this wrapper remains numerical, not bit-exact.

Border handling has two distinct steps: mirror complete CFA blocks (period 2
for Bayer, 6 for X-Trans), then clamp requests beyond that padded allocation to
its nearest pixel. The mirror matches 114,688 Bayer and 164,976 X-Trans captured
halo samples. Additional real bottom-right captures now check right/bottom mirroring and outer
edge repetition, including Sony's final 45-pixel-wide tile and Fuji's final
two-pixel-wide tile. The
outer clamp matches 16 native `Get32` oracle cases across all edges/corners,
shifted origins and one/three-plane buffers. Images smaller than the required
mirror padding are explicitly rejected; repeated tiny-image reflection is not
implemented.

The `strength` module includes exact amount normalization and two-band blend
coefficients, verified against 111 native cases. `blend_tile` implements the
RGB/YCC transforms, quantized seven-tap Gaussian and low/high-frequency
recombination with Adobe's ARM SIMD operation order; `blend_reference_tile`
keeps the separate reference arithmetic. Both match native synthetic stage
captures bit-for-bit: 10,854 output values across five cases per dispatch.
Normal Converter execution confirms the selected matrix and blur pointers are
the same SIMD functions used by the oracle. These tests validate the blend
stage, not a complete photographed scene at arbitrary strength.

Blend inputs require a three-pixel halo and the correct undenoised RGB baseline;
the returned result excludes that halo. At full strength, Adobe's surrounding
caller bypasses baseline generation and blending. `predict_mosaic_tiles` returns
the unblended neural result and does not manufacture a baseline or apply that
caller policy.

For the captured real network inputs, Rust vs Core ML CPU_ONLY maximum error is
3.13e-7 (Bayer) and 7.75e-7 (X-Trans), within the existing numerical gates. Against
the model outputs captured from Adobe's default backend, maximum error is instead
6.69e-4 and 1.17e-3 respectively. Adobe requests Core ML All and these captured
outputs are exactly representable in FP16; the actual compute device was not
identified. **CPU numerical agreement is not default Adobe backend parity.**
The validation JSON records both comparisons separately, with tensor digests.

To rerun the optional capture checks, preserve canonical PBDT tensors and capture
metadata in `bayer-output/`, `xtrans-output/`, `bayer-transfer/`,
`{bayer,xtrans}-inverse/`, `{bayer,xtrans}-full-tile/`, `{bayer,xtrans}-corner/`
and `{bayer,xtrans}-whole-source/` under an external wrapper directory. RAW images and learned weights are not committed:

```sh
RAW_DENOISE_CAPTURE_FIXTURES=/external/wrapper \
RAW_DENOISE_FIXTURES=/external/rust RAYON_NUM_THREADS=8 \
  cargo test --release --manifest-path packages/raw-develop/Cargo.toml \
  --features adobe-denoise -- --nocapture
```

Without these variables, capture/model tests report skips. Numeric rectangle
oracle fixtures and synthetic tests always run. Capture regressions distinguish
exact wrapper stages from numerical network comparisons.

## Baselines required for partial strength

Amount-50 controlled replays confirm that the two mosaic variants use different
baselines. The harness changes only the outer denoise options; it does not
re-enable denoise in nested calls. Captures and recovered assets remain outside
the repository under `denoise-2026-11-03/baseline/` in the local analysis tree.

- **Bayer:** after `MakeCNNBayerDenoiseModel_Apple`, the normal callback enters a
  pipe named `standard bayer demosaic`. Static analysis of callback
  `0x100833020` shows CFA extraction, Bayer gain, log encoding,
  `cr_stage_bayer_core3`, inverse log transfer, then `BlendNoise`. It does not
  select the Bayer Enhance Details network for this baseline. The existing
  `adobe::bayer` developer is not a drop-in baseline: its complete path also
  applies hot/cold-pixel suppression, green balancing, inverse gains and u16
  boundaries. The baseline reuses the core kernel with this particular stage's
  captured parameters, transfer precision, image coordinates and boundaries.
- **X-Trans:** `NNInterpolateFuji6x6` recursively calls itself with Enhance
  Details enabled, denoise disabled and the baseline flag set. Runtime then
  selects `MakeCNNFuji6x6Model_Apple` (`0x10075a848`), a distinct embedded model,
  not any of the four denoise models. Its graph has 22 convolutions, one crop
  and one concatenation, mapping `3×512×512` to `3×470×470`. It contains
  186,819 FP32 weight/bias values; the compiled weights file is 756,864 bytes
  including container metadata (339,396 bytes bzip2-compressed). The factory
  loads `kXTransHiddenModelsEmbedded` (`0x1084f4430`), a five-file compiled Core
  ML bundle embedded in the converter. The recovered graph, shapes and weights
  are external investigation artifacts and are not bundled with PhotoBrain.

`baseline_bayer::BayerBaseline` now provides the narrowly validated Sony
baseline using the already calibrated mosaic, reference gains, u16 log tables,
classical core and inverse log. The first and opposite corner captures match
**158,472 RGB values bit for bit**, including odd/even subrectangle checks.
Output retains the gain-balanced space expected by `BlendNoise`; applying the
inverse gains here would change the partial-strength result. The composed path
applies neural balance before blending and inverse balance afterward.

The baseline network now runs through the FP32 `PBDN0002` interchange, with
explicit channel concatenation and two spatial slices for the input skip.
The strict `export_details.py` exporter consumes locally recovered Espresso
graph, shape and weight files and can reconstruct a Core ML reference model.
Compiled bias padding and unused slots are validated and excluded from the
parameter count; the earlier 188,844 count included padding. Four cases (zero,
noise, structured CFA input and a captured real tile) agree with Core ML CPU
within max absolute error **7.75e-6** and RMSE **3.60e-7**, passing the existing
1e-5/5e-7 numerical gates. The captured Adobe default backend still differs
from the CPU reference (real-tile max **0.00168**, RMSE **0.000312**).
Neither comparison establishes bit-exact neural inference.

Set `RAW_DENOISE_DETAILS_FIXTURES` to the external model directory containing
`xtrans_details.pbdn` and `details-references/manifest.json` to run the four-case
Rust regression. The model and reference hashes are checked before inference.

The X-Trans baseline also has a distinct wrapper: normalized reference gains,
log encoding/decoding and 512-pixel model tiling. The recursive baseline flag
suppresses the final inverse-gain matrix before blending.
`baseline_xtrans::BaselineTile` implements the verified geometry, histogram
offsets, sparse packing, crop and offset removal. It accepts an **already
gain-adjusted, log-encoded source**. Thirteen native geometry cases pass; the
first captured tile matches all **786,432 packed input values** and **648,675
cropped output values** exactly. A synthetic test also preserves the native
no-clipping behavior when offsets are zero. `XtransBaseline` now composes
decoded source gain/log, nearest-pixel source halos and u16 inverse log with
these stages. Four captured tiles check 1,048,576 source values, 3,145,728 packed
values and 1,980,306 postprocessed values exactly. Both complete 65,536-entry log
tables and 165,330 inverse-log RGB values also match. Learned inference remains
numerical: the two fully decoded baseline comparisons against Adobe default
reach max 2.75e-4 and RMSE 6.57e-5. Classical X-Trans interpolation is not used.

`RAW_DENOISE_BASELINE_FIXTURES` enables both baseline capture regressions;
decoded-source cases additionally require `RAW_DENOISE_RAW_FIXTURES`. Ordinary
tests include a generated Bayer source with an exact native output digest
(81,672 RGB values); no RAW capture or learned weight is committed.

## Direct RAW input and tile export

`DecodedMosaic::new_with_cancel` connects `Negative` decoding to the neural tile
input. It currently accepts the captured Fujifilm X100VI 7872×5196 readout/crop
and Sony A1 II lossless M 6144×4096 readout/crop with a known exposure below two
seconds. Black/white levels, CFA layout and crop geometry are checked explicitly;
other layouts and long/unknown Sony exposures return `Unsupported`.

The stored readout, canonical model extent and final active crop are distinct.
Fuji maps canonical coordinates to sensor coordinates with offset (19,7), then
repeats CFA periods against its true active sensor bounds. Its final crop begins
at canonical (2,5). Sony also preserves its u16 log encode/decode boundary and
applies the native short-exposure hot/cold-pixel repair between those tables.
The repair uses two-pixel CFA padding and bounded row strips, retaining about
42 MB of calibrated u16 source for this Sony layout. Fuji remains sampled lazily.

Full captured canonical source comparisons cover **21,243,984 Sony samples** and
**39,855,882 Fuji samples**, all bit-exact. Four real top/trailing tile captures
also check decoded source and packed network inputs exactly. The native Sony
repair oracle includes injected hot/cold defects; synthetic strip-seam and
cancellation tests ensure the adapter does not silently omit repairs.

The CLI can now run full-strength inference directly from either validated RAW:

```sh
raw-denoise raw-tiles /external/dn_xtrans.pbdn photo.RAF /external/new-run

# Or inspect one canonical destination tile, saving its exact model input too:
raw-denoise raw-tiles /external/dn_bayer.pbdn photo.ARW /external/new-corner \
  --rect 3196,5593,3768,5638 --dump-input
```

The output directory must be new. Each PBDT tile has an exact destination
rectangle in `manifest.json`, along with canonical bounds, final active crop,
model/source digests and completion status. The manifest remains incomplete if
an error interrupts the export. Output is **preserved-black camera RGB at full
denoise strength**, before lens correction, profile color, tone or orientation;
it is not a display-ready image. Network inference retains the documented
numerical difference from Core ML and is not claimed bit-exact with Adobe.

Complete CLI exports have also run for both fixtures: 40 Sony tiles and 60 Fuji
tiles, with every canonical pixel covered exactly once and all 183,299,598 RGB
samples finite. Their final tiles match independent single-tile exports bit for
bit. This checks complete export/placement behavior; the neural outputs are
still numerically different from Adobe's default backend. Recorded durations
include concurrent work and are not isolated performance benchmarks.

Set `RAW_DENOISE_RAW_FIXTURES` to the fixture root containing `a1m2/12766.ARW` and
`x100vi/DSCF0008.RAF`, together with `RAW_DENOISE_CAPTURE_FIXTURES`, to run decoded
RAW calibration checks. Whole-source references are headerless little-endian f32
with bounds and SHA-256 in their `geometry.json`; all large assets remain external.

## Remaining work before enabling full-RAW denoise

Broaden camera/readout/exposure calibration with independent captures, including
Sony's long-exposure paired-pixel path. Extend independent partial-strength
validation beyond the two current RAW fixtures and tested strengths. Trace dense-model wrappers. Validate complete rendered
images through the color/lens/tone pipeline and resolve the neural backend
precision difference if exact Adobe output is required. No pipeline-version bump
is needed for these opt-in APIs: existing `(input,settings)` rendering is unchanged.

## Partial-strength RAW export

The experimental `partial::predict_partial_raw_tiles` API and CLI now compose
amounts 1–99 for the same calibrated Bayer/X-Trans layouts. Amount 100 keeps the
existing baseline/blend bypass and existing float export. Fuji requires the
separate Enhance Details bundle:

```sh
raw-denoise raw-tiles /external/dn_bayer.pbdn photo.ARW /external/new-partial \
  --amount 50 --rect 790,790,810,810
raw-denoise raw-tiles /external/dn_xtrans.pbdn photo.RAF /external/new-partial-fuji \
  --amount 50 --details /external/xtrans_details.pbdn
```

Partial output preserves the native u16 image boundaries. Bayer applies float
affine gains; Fuji uses signed-16 quantized matrices, including a u16 commit
before forward gain. Both blend gain-balanced RGB, commit the blend, then apply
inverse gains. A native 68-sample conversion oracle covers clipping and
ties-to-even rounding. Four real Bayer blend corners match 128,952 float output
values exactly; all 15,588 observed outside-image halo values use nearest-pixel
repetition. This differs from denoise input's wider CFA-block mirror.

Inference and baseline caches retain bounded tiles on their original image
grids (799 Bayer, 859 X-Trans denoise, 465 Fuji baseline). Cropping an export does
not shift histogram-dependent baseline tiles. Partial `--rect` may span several
model tiles; every returned tile has its actual clipped rectangle in the manifest.
`--dump-input` currently remains an amount-100 diagnostic. The output still
requires lens, profile color, tone and orientation before display.

Set `RAW_DENOISE_PARTIAL_FIXTURES` to the external investigation root (containing
`rust/`), plus `RAW_DENOISE_RAW_FIXTURES`, to run crop consistency checks across
a Bayer model seam and a Fuji baseline seam. These compare overlapping pixels
bit for bit within the same Rust execution backend; they do not claim bit-exact
neural agreement with Adobe.

## Complete-export validation and experimental display rendering

`tools/adobe-denoise/validate_export.py` verifies a completed export without
rerunning inference. It checks rectangular coverage with no gaps or overlaps,
geometry and active crop, tensor dimensions, finite values, exact u16
normalization for partial strength, source identity where available, and tile
hashes. Independent cropped exports must match overlapping pixels bit for bit:

```sh
python packages/raw-develop/tools/adobe-denoise/validate_export.py validate /external/full-run \
  --full-image --compare-region /external/corner-run --json /external/check.json
```

The feature-gated `denoise::render::prepare_camera_rgb` accepts complete canonical
interleaved RGB plus its matching `Negative`. `denoise::render::prepare` runs
inference first. Both return an ordinary `Prepared`, so exposure, tone, color,
orientation and crop reuse the existing renderer. They require full-quality
Adobe options and an explicit `adobe_noise_reduction` object with color and
luminance both zero. Native default-control captures now support this policy:
Adobe resets both conventional NR amounts after AI denoising (see below).
Explicit user overrides and other processing hosts remain outside this check.

The bridge commits the camera RGB to u16, crops Fuji to its calibrated active
image before mandatory embedded CA, retains Sony's canonical area through CA
and scene preparation, then takes Sony's DefaultCrop. It does not apply a second
demosaic, classical cleanup, white balance, black subtraction or early exposure.
The ordinary `develop`/`prepare` APIs and app defaults are unchanged.

To render a completed export without repeating neural inference:

```sh
raw-denoise render-tiles /external/full-run photo.ARW /external/result.png \
  --no-post-nr --adobe-profiles /path/to/CameraProfiles
```

The command requires a new `.png` destination and a complete full-image export
whose source SHA-256, calibration, ordered tile grid and tensor shapes match the
RAW. It writes a 16-bit PNG with the renderer's Display P3 profile. Optional
`--settings settings.json` retains supported edits but must explicitly set the
Adobe color/luminance NR controls to zero; it does not silently override them.
Neural numerical differences and composed native CA/color/tone reference
validation remain limitations. This does not enable
denoise in the API, saved edit recipes or iOS.

Complete amount-50 exports now pass for both fixtures: 40 Sony tiles and 60 Fuji
tiles cover **61,099,866 canonical pixels** exactly once. All **183,299,598 RGB
samples** are finite, in range and exactly normalized u16. Independent origin,
seam and trailing-edge exports match bit for bit. These are full-frame coverage
and crop-consistency checks, not native neural bit-parity claims.

Fresh native captures at amounts 1 and 99 validate all four Bayer/Fuji cases.
Blend arithmetic, the u16 boundary and composed inverse-gain output each match
147,186 samples exactly. Set `RAW_DENOISE_AMOUNT_FIXTURES` to the external
`baseline/` directory, alongside `RAW_DENOISE_RAW_FIXTURES`, to rerun those
checks. Full RAW-to-output comparisons remain numerical because of the neural
backend difference; detailed measurements and hashes are in the validation JSON.

Experimental amount-50 display exports were checked at 5616×3744 (Sony) and
5152×7728 after orientation (Fuji), both 16-bit PNG with embedded Display P3.
Framing, orientation and obvious artifacts were visually inspected. These are
smoke tests of the explicit no-post-NR renderer bridge; complete native
denoise-to-display parity remains open.

### Native post-AI noise reduction defaults

Six controlled Converter 18.7 captures compared ordinary and amount-50 AI paths
for the calibrated Sony and Fuji fixtures. Both ordinary paths passed luminance
0 / color 25 to conventional CR6 NR; both AI paths passed 0 / 0. Effective
normalized amounts changed from 0 / 0.25 to 0 / 0. The denoise CNN was observed
before interpolation returned, and preview NR construction happened afterward.
Sony full-size preview captures also confirmed that the conventional color-NR
enable flag changed from enabled to disabled. Fuji captures checked the amounts
at thumbnail scale; its full-preview enable flag was not measured.

Static analysis agrees: `cr_negative::BaseDefaultAdjustParams` at `0x100b7c8f8`
checks cumulative denoise enhancement version metadata and zeros both default
controls when it is nonzero. `RecordDirectEnhanceVersionInfo` at `0x100e62834`
records the denoise version and amount. These are default-setting rules, not
proof that explicit user edits or presets cannot request conventional NR.

The evidence and capture hashes are retained under `post_ai_noise_reduction`
in the validation JSON. This verifies the existing explicit zero-NR policy;
it does not change ordinary rendering, app defaults, or permit nonzero post-NR
in the experimental bridge. It is Converter runtime evidence, not a direct
Lightroom UI test.

### Isolated post-AI lens and color checks

At amount 50, existing Rust stage regressions replay native denoised pixels
without rerunning our CNN. Embedded lateral CA matches **601,704 channels**
exactly across origin/interior tiles on both cameras. Fuji CA receives the
7728×5152 crop-sized image; Sony receives its 5638×3768 canonical area. This
supports the bridge's crop ordering. The replay uses native warp parameters;
it does not newly establish metadata-to-warp fitting or crop pixel offsets.

Camera-to-RIMM conversion matches another **828,147 channels** exactly:
421,875 Sony and 406,272 Fuji. Quantized gains, channel ordering and matrix
coefficients also match. These captures explicitly select **Adobe Standard**
and ProcessVersion 15.4 in an external XMP sidecar. Native default-profile
captures are not interchangeable with this oracle. Both checks reuse existing
Rust implementations; no processing changes were required.

External replay commands, run in `packages/raw-develop`:

```sh
RAW_DEVELOP_ADOBE_WARP_TRACE=/external/baseline/ca-bayer-ai \
  cargo test --release --features adobe-denoise --lib captured_u16_warp_matches_exactly
RAW_DEVELOP_ADOBE_RAW=/external/12766.ARW \
  ADOBE_PROFILE_DIR=/external/CameraProfiles \
  RAW_DEVELOP_ADOBE_INPUT_TRACE=/external/baseline/render-input-ai-bayer-standard/000 \
  cargo test --release --features adobe-denoise --lib captured_modern_color_input
```

Repeat with `ca-xtrans-ai`, `render-input-ai-xtrans-standard` and the Fuji RAW
for the second camera. Capture hashes and precise boundaries are recorded under
`post_ai_lateral_ca` and `post_ai_color_input` in the validation JSON. Further scene and output checks are recorded below. These isolated exact
stages do not make the complete neural pipeline bit-exact.

### Separate statistics and display profiles

Native amount-50 scene captures exposed a Sony A1 II profile distinction:
Adobe's default D50 statistics calibration is **Adobe Standard v2**, even when
the selected display profile is **Adobe Standard**. Using the selected profile
for both produced a different gray statistics image. The experimental denoise
bridge now loads both external profiles: default calibration for scene gray and
mask preparation, selected Standard for display color and post-tone statistics.
Fuji retains its existing Standard profile for both roles. The A1 II bridge
returns an explicit error if the adjacent `Sony ILCE-1M2 Adobe Standard v2.dcp`
is missing. No profiles are bundled. Ordinary preparation still passes its
existing profile to both roles, so app and production rendering are unchanged.

The new optional scene regression assembles each complete captured small camera
image, then runs `Scene::new` with the two profile roles. Across both cameras,
**297,770 gray/RGB/post-tone distribution samples match bit-for-bit**. Of the
statistics fields, **260 match exactly**; 20 accumulated means meet the existing
32-epsilon bound used for native accumulation-order differences. These mean
fields are not claimed bit-exact. Selected-Standard post-tone profile/crop/log
checks also pass. Exposure initialization verifies 25 native fields per camera,
plus the measured contrast key and epsilon. Its test now derives the expected
key from native capture fields instead of assuming the old fixture's key.

```sh
RAW_DENOISE_SCENE_CAPTURE=/external/baseline/stats-ai-bayer-standard \
  RAW_DEVELOP_ADOBE_RAW=/external/12766.ARW \
  ADOBE_PROFILE_DIR=/external/CameraProfiles \
  cargo test --release --features adobe-denoise --lib \
    captured_ai_camera_image_to_scene_measurements
```

Repeat with `stats-ai-xtrans-standard` and its Fuji RAW. Exact source/capture
hashes, profile comparison and test boundaries are in `post_ai_scene_statistics`
in the validation JSON. One incomplete Fuji pyramid-return capture is excluded
from the separate reduction-only fixture view; the new Scene replay has complete
small-image coverage.

Independent native exposure-input replays through DCP look, profile tone, u16
commit, sRGB matrix and gamma match **828,147 channels** exactly (Sony 421,875;
Fuji 406,272). These use captured exposure metadata and inputs, so they establish
that part of the chain rather than complete denoiser-to-display parity. The
`post_ai_exposure_to_output` records retain this distinction.

### Same-run camera-image to output regression

`RAW_DENOISE_RENDER_CAPTURE` enables the stronger composed check. It reads a
complete native unsigned-u16 camera image from the interpolation return, then
runs the **same bridge code** used by `prepare_camera_rgb`: commit/crop,
metadata-derived embedded CA, camera pyramid, separate statistics/display
profiles, lens stages, scene-derived exposure and tone, and output conversion.
It does not inject native exposure metadata, warp coefficients or tone tables.
The original RAW metadata, external DCPs and settings are the only parameters.

Both same-run oracles pass: **297,770 scene-distribution samples**, binary
scene flare and **828,147 captured final sRGB channels** match exactly. The
comparison uses sRGB because that is the native preview's output space; the
normal CLI continues to export Display P3. The final comparison covers one
output tile per camera after measuring the complete scene, not every final
pixel. Amount 50 and default global tone controls were tested.

The native image dump itself is independently checked against 631,539 samples
from same-run downstream CA input tiles, including boundary halos. Fuji's
write-only interpolation destination discards the leading canonical rows and
columns, so its complete backing crop is placed at canonical origin `[2,5]`;
the bridge discards the synthetic prefix before any downstream work. Sony's
complete canonical image is captured directly. Earlier invalid interleaved
Get32 diagnostic dumps are explicitly excluded; the regression accepts only
verified unsigned-u16 captures.

```sh
RAW_DENOISE_RENDER_CAPTURE=/external/baseline/composed-native-bayer \
  RAW_DEVELOP_ADOBE_RAW=/external/12766.ARW \
  ADOBE_PROFILE_DIR=/external/CameraProfiles \
  cargo test --release --features adobe-denoise --lib \
    captured_camera_to_scene_and_output
```

Repeat with `composed-native-xtrans` and its RAW. Source/camera/capture hashes
and boundaries are retained under `post_ai_composed_render`. This establishes
exact downstream composition on the tested tiles with native neural output;
Rust CNN inference still has the documented numerical differences.

## Experimental app integration

The iOS **Edit RAW** editor now has an opt-in Denoise amount (0/off through 100),
**Apply Denoise**, tile progress and cancellation. Inference runs on the server;
iOS receives portable prepared pixels and renders Basic controls locally. Apply
changes the local draft; only **Save** updates the server recipe. Reset resets
Basic controls while retaining the applied denoise preparation. Set Denoise to
Off and Apply to remove it. Save is disabled while processing or while the
selected amount has not been applied. Drafts retain their matching preparation
across reopening, and developed export replays the saved amount.

Server configuration (all assets remain external):

```sh
RAW_DEVELOP_ENGINE=adobe
ADOBE_PROFILE_DIR=/external/CameraProfiles
DENOISE_MODEL_DIR=/external/denoise-models
DENOISE_CACHE_DIR=/var/cache/photobrain/denoise
```

The model directory must contain `dn_bayer.pbdn`, `dn_xtrans.pbdn` and
`xtrans_details.pbdn`. Sony also requires the adjacent Adobe Standard v2 DCP used
for scene statistics. No model directory means the feature is off. Rebuild the
N-API addon/server and the iOS app; existing installed iOS builds do not expose
this control. No database migration is required: version 2 recipe JSON adds an
integer `denoise` field. Version 1 recipes remain supported, but a version 1 save
cannot overwrite an existing version 2 recipe.

The editor offers the control for X100VI and ILCE-1M2 metadata; the native
adapter still rejects every unvalidated readout, CFA, crop, black/white level or
Sony exposure. This is not general support for every RAW from those cameras.
Neural inference remains numerical rather than bit-exact with Adobe's backend.
The existing exact wrapper/render validations continue to apply.

`POST /api/v1/photos/:id/denoise` accepts `{amount, revision}`. Poll
`GET .../denoise/:job`, cancel with `DELETE`, and download a completed preview
from `GET .../denoise/:job/preview`. Jobs never mutate recipes. Source identity
and recipe revision are checked before completion and download. One job is
admitted at a time, with two retained previews and a 30-minute lifetime/timeout.
Jobs are process-local; restart/expiry returns 404 and the client can Apply again.
This is intended for the existing single API process, not distributed job ownership.

The native cache keeps at most two completed canonical RGB images, stored with
exact f32 bits, checksum verification and atomic publication. Its key includes
source/profile/model file identities, amount, cache format and pipeline version;
Basic controls are excluded. Full exports and new smart previews reuse it.
Eviction can require inference again. Reserve approximately 1 GB for completed
Fuji cache entries plus temporary-write space. Active inference also needs
several GB of RAM. Cancelled jobs never publish partial pixels or recipes.

Validation includes API admission/cancellation/source fencing and compatibility
checks, native cache bit roundtrip/corruption tests, and simulator draft, Save,
reopen and cancellation tests. The opt-in real smart-preview simulator test can
consume the denoised `.pbsp` using `TEST_RUNNER_PHOTOBRAIN_SMART_PREVIEW`.
The opt-in XCUITest flow accepts `UI_TEST_DENOISE_PREVIEW` and
`UI_TEST_DENOISE_BEFORE` external `.pbsp` paths, plus
`TEST_RUNNER_PHOTOBRAIN_DENOISE_UI_TEST=1`; its fixture server simulates job timing
and uses real prepared bytes. It tests the UI/HTTP contract, not neural inference.
