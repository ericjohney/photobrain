# Adobe engine (experimental)

`Options { engine: Engine::Adobe, adobe_profile_dir, .. }` (CLI: `--adobe
--adobe-profiles DIR`) selects the secondary Adobe pipeline for RAF and ARW.
Its full-resolution stages follow Adobe DNG Converter 18.7 CPU captures,
including image-derived statistics, global and spatial tone controls, and final output.
Binned previews use the public DNG SDK renderer.
The default engine is
still `Engine::Apple`, and its output is unchanged. LinearRaw DNGs return
`Error::Unsupported` on the Adobe engine.

The goal is parity with Adobe Camera Raw (ACR), including its adjustment controls.
It is not there yet;
see [Current accuracy](#current-accuracy).

## What runs

Shared with the Apple engine: decode (bit-exact) and output geometry.
Full Adobe uses its own embedded lens corrections and highlight
shoulder; binned previews retain the shared highlight helper. Adobe-specific:

1. **Linearise** with the file's white level (`adobe::white_level`: the file's value,
   else `2^bits - 1`, i.e. 16383 for 14-bit RAF/ARW, matching DNG Converter's
   `WhiteLevel`), not RawCamera's calibrated level.
2. **Full X-Trans demosaic and mandatory cleanup** use `src/adobe/xtrans/`,
   reconstructed from Adobe DNG Converter 18.7's CPU pipeline. **Full Sony Bayer**
   uses `src/adobe/bayer/`: D50 pre-gain, logarithmic encoding, hot/cold-pixel
   suppression, green-split correction, optional high-ISO noise flattening,
   directional interpolation and inverse transforms. Preview still uses the
   generic `stages/demosaic.rs`. RawCamera's NR-integrated demosaics are bypassed.
3. **Embedded lateral chromatic aberration** uses the Adobe radial warp on the
   preserved-black image, before white balance and Sony DefaultCrop. All 11 complete
   linear-CA references match exactly. Preview remains approximate. See
   [`lens/README.md`](../src/adobe/lens/README.md) for geometry and validation limits.
   This opcode is mandatory even when Adobe's optional automatic CA control is
   zero; Full Adobe applies it independently of `lens.chromatic_aberration`.
   Optional Fuji distortion runs before the camera transform; warp-aware Fuji
   vignetting runs after black removal and the first profile map.
4. **Modern camera input** (`src/adobe/input.rs`) converts preserved-black camera
   RGB to RIMM/linear ProPhoto through quantized gains, the highlight shoulder,
   fixed-point matrix and the u16 stage boundary. The working image retains its
   black pedestal and the input's exposure normalization.
5. **Full user noise reduction** (`src/adobe/nr/`) flattens the metadata-derived
   sensor noise, converts to an optimized YCC basis, filters chroma and four
   luminance levels independently, recombines the channels, then reverses both
   transforms. The six integer Adobe controls are integrated; see below.
   X-Trans's mandatory false-colour cleanup still runs with both user amounts zero.
   Sony DefaultCrop is applied after this stage: cropping earlier changes the
   eight-pixel luminance lattice and loses border neighbours.
6. **Colour and tone** (`color.rs`, `color_table.rs`, `tone/`, `output.rs`):
   - white xy from the as-shot neutral by iterating the interpolated `ColorMatrix`;
     per-body Sony/Fuji calibration with a matching profile signature, as-shot
     temperature/tint grid rounding, interpolated `ForwardMatrix` to XYZ D50,
     then the modern input transform for full quality (the SDK camera transform
     remains in binned previews);
   - full quality removes black through the expanded u16 lookup, then applies
     the modern SIMD HueSatMap/LookTable arithmetic, including sorted-channel HSV,
     reciprocal multiplication and observed FMA associations. Binned previews
     retain the SDK tables;
   - a separate small camera pyramid, before optional distortion and user NR,
     supplies D50 gray, camera-channel and profile-coloured log statistics.
     Its black-subtracted mean determines the flare used in logarithms;
   - Highlights2012/Shadows2012 use a remapped Laplacian mask, expanded with an
     As Shot luminance guide from the original camera image. Fuji distortion
     also warps this float mask. The active controls update the separate
     post-tone statistics used by the exposure stage;
   - modern Exposure2012/Whites2012/Blacks2012, including camera-gain exposure,
     scene-dependent headroom, highlight rolloff and black curves;
   - the DCP `ProfileToneCurve`, or ACR3 default, combined with negative exposure,
     then modern late Contrast2012 using the initial D50 scene key;
   - the signed fixed-point ProPhoto-to-Display-P3 matrix and expanded sRGB
     transfer LUT. Quantization is retained after exposure, after LookTable,
     and before the output matrix.

Full modern rendering does not use the fitted SDK black point or exposure ramp.
Those remain only in the approximate binned-preview renderer.

`src/adobe/acr3.rs` holds the ACR3 default tone curve table copied from the DNG SDK
(Adobe's DNG SDK licence permits redistribution).

## Noise-reduction controls

Full quality accepts Adobe's integer slider units, each within 0–100:

```json
{
  "adobe_noise_reduction": {
    "color": 25,
    "detail": 50,
    "smoothness": 50,
    "luminance": 0,
    "luminance_detail": 50,
    "luminance_contrast": 0
  }
}
```

When this block is absent, shared chroma and explicit luma amounts are rounded
to integer percentages; absent luma means zero. Detail and Smoothness default
to 50, and Luminance Contrast to zero. Apple and binned previews ignore the
block. Changing it requires preparation again; exposure and geometry edits
continue to reuse the prepared image.

The production tiler uses 192-pixel chroma-only outputs and 384-pixel outputs
with luminance NR. Chroma-only filtering preserves the two-pixel lattice;
luminance enables a 160-pixel halo and an eight-pixel lattice.
Chroma and luminance filter the same encoded source independently. Luminance-only
filtering bypasses the chroma kernel, including its zero-strength singularities.
Cancellation is checked per tile and before publishing the output.

Exact photographic capture checks cover NR100 and mixed settings on X-E5 and
A7R V: constructor arrays, every luminance level and 555,074 luminance samples.
The actual RAW→prepared chroma+luminance chain matches 1,665,222 channel values
with zero differences. Synthetic tests cover joins, odd dimensions and
luminance-only filtering. These are stage-boundary checks on the captured
regions, not proof of full final-render parity.

## Tone controls

Exposure uses the shared `exposure` field in EV. Full Adobe rounds it to
hundredths and clamps to its native -5..5 EV range. The other Basic controls
use integer Adobe units from -100 to 100:

```json
{
  "exposure": 0.7,
  "adobe_tone": {
    "contrast": 30,
    "highlights": -50,
    "shadows": 40,
    "whites": 20,
    "blacks": -25
  }
}
```

Omitting the block sets all five controls to zero. All six Basic controls reuse
a `Prepared` image and its original scene summaries; changing them does not
measure a resized or already adjusted image. The first nonzero Highlights or
Shadows edit computes and caches the spatial mask. Cancelled computations can
be retried on the same prepared image. Resized prepared proxies sample the original
mask in scene coordinates and remain approximate screen previews. Binned
previews reject nonzero Adobe tone controls. The Apple engine ignores the
Adobe-specific block.

## Profiles

Colour comes from the camera's **Adobe Standard** DCP (`src/adobe/dcp.rs`). DCPs are
Adobe's data and are never bundled: they are read at runtime from
`Options::adobe_profile_dir`, else the `ADOBE_PROFILE_DIR` environment variable. The
directory uses Adobe's layout, `Adobe Standard/<Make> <Model> Adobe Standard.dcp`
(make spelled `Fujifilm`, `Sony`), or holds the files directly. On a Mac with Camera Raw
installed they are under
`/Library/Application Support/Adobe/CameraRaw/CameraProfiles/`; on a server, copy the
five files into a configured directory.

## Baseline exposure

DNG Converter writes a per-file `BaselineExposure`; we derive it without Adobe software
(`adobe::baseline_exposure`), measured on the fixture set with DNG Converter 18.7:

- Fujifilm: `-RawExposureBias - 0.70` (0.02 at a bias of -0.72, 0.07 at -0.77).
- Sony: ILCE-1M2 0.15, ILCE-7CR 0.35, ILCE-7RM5 0.35. Other Sony models return
  `Error::Unsupported`.

The DCP's `BaselineExposureOffset` is added when present.

## Current accuracy

The full X-Trans base pipeline matches every 16-bit channel value in six complete
7728×5152 linear DNGs: X-E5 DSCF0229 (ISO 10000), DSCF0604 (ISO 125), DSCF0672,
DSCF0711 (saturated), DSCF0970, and X100VI DSCF0008 (ISO 500). This includes crop
borders. Optional lateral CA was removed from a separate mosaic-DNG input before
conversion, so these references isolate the demosaic and mandatory cleanup.
Four intermediate CPU capture sets also match bit-for-bit: two X-E5 ISO settings,
X100VI, and an X-E5 saturated highlight. These checks establish base-processing
parity for those files, not complete final-render parity or untested cameras.

Historical final-render measurements **before the X-Trans port**, vs ACR's
default render (the full-size JPEG DNG Converter embeds, with a
sidecar setting NR, sharpening and lens corrections off on both sides), quarter scale,
CIEDE2000 mean / 95th percentile:

| Fuji | ΔE00 | Sony | ΔE00 |
|---|---|---|---|
| DSCF0008 (X100VI) | 1.15 / 2.52 | 12766 (A1 II) | 0.58 / 1.27 |
| DSCF0229 (ISO 10000) | 1.84 / 4.10 | 13567 (A7C R, ISO 12800) | 2.16 / 3.90 |
| DSCF0604 | 1.75 / 4.59 | 13937 (A7R V) | 0.90 / 1.94 |
| DSCF0672 | 1.43 / 3.01 | 4309 (A1 II) | 0.83 / 1.97 |
| DSCF0970 | 1.24 / 3.00 | 6453 (A7C R) | 0.98 / 1.74 |

The 8-bit JPEG reference limits measurable agreement to roughly 0.2-0.3 ΔE00.

The decode matches DNG Converter's CFA plane on 100% of values checked (RAF and ARW).
The Sony Bayer base pipeline also matches every cropped 16-bit channel in five
complete no-CA linear DNG references: A1 II 12766 (APS-C, ISO 125) and 4309
(uncompressed, ISO 100), A7C R 6453 (cRAW, ISO 100) and 13567 (lossless, ISO
12800), and A7R V 13937 (uncompressed, ISO 2000). Crop borders and tile joins are
included. Five composed intermediate chains also match, starting from our RAW
decode and normalization rather than feeding captured intermediate pixels.
The full global exposure/tone path now uses the modern scene-dependent stages.

Colour-specification checks on all 11 files match captured white xy, CameraWhite and
CameraToPCS within 1e-10 (observed matrix differences below 1e-14). The separate
modern `input.rs` stage now matches every f32 output in selected X-E5, A7R V and
saturated X-E5 captures, including its quantized gains/matrix and preserved black.
It is integrated into full rendering, including both user NR branches. The
black-removal LUT and both profile colour tables match all captured Fuji
entries and pixels exactly; the RAW→prepared→first profile table composition
also matches exactly. Encoded/overrange table branches have static evidence but
the current exact photographic validation covers linear, non-overrange tables.

`src/adobe/tone/` is integrated into full rendering. Its photographic exposure,
profile-tone and late-contrast kernels match 2,031,360 captured float channels;
50 synthetic sweeps cover 204,850 f64 values. The camera pyramids, D50 gray and
profile-coloured log images, scene-derived flare, and the 28 represented
statistics fields have captured Fuji/Sony checks. Retained sorted test inputs
allow rounding tolerance only for the two means originally summed in raster
order; distribution fields, including the separate sRGB mean, compare exactly.

The composed **RAW → scene measurements → global tone → sRGB output**
test has zero differences in all six controlled cases: defaults, Exposure -2 EV,
and mixed controls on both X-E5 and A7R V. Each X-E5 case checks 406,272 channels;
each A7R V case checks 426,339, for 2,497,833 exact channel comparisons. These
checks start with our decoded RAW, load only the user's DCP, and exercise the
production tone renderer. The mixed controls are Exposure +0.70, Contrast +30,
Whites +20 and Blacks -25. All six use zero user NR/sharpening and optional lens
corrections off; mandatory embedded CA stays on. This establishes exactness on
those captured tiles and settings; it does not establish whole-image parity.

Five further composed spatial cases match all 2,071,494 final sRGB channels
exactly. X-E5 and A7R V each cover Exposure +0.70, Contrast +30, Highlights -50,
Shadows +40, Whites +20, Blacks -25, and the reverse settings Exposure -1,
Contrast -20, Highlights +50, Shadows -40, Whites -15, Blacks +30. A fifth
X-E5 case enables embedded distortion and vignetting with the first control
set. These use zero user NR/sharpening and mandatory embedded CA. Together
with the six global cases, that is 4,569,327 exact channel comparisons across
11 captured tiles/settings. Intermediate checks also cover the complete
Fuji/Sony low-resolution masks, As Shot guide/flare, expanded mask, active
post-tone statistics and the float Fuji mask warp. This remains validation
of the captured images, settings and regions.

`output.rs` independently checks the complete matrix/gamma boundary and the
composed global tone chain on both captured tiles. sRGB output is validated
against runtime captures; production Display P3 uses the observed native
constructor's PCS matrix, normalized as specified by the public DNG SDK.

```bash
ADOBE_PROFILE_DIR=/path/to/CameraProfiles \
RAW_DEVELOP_ADOBE_COMPOSED_RAW=/path/to/original.RAF \
RAW_DEVELOP_ADOBE_COMPOSED_TRACE=/path/to/output-xe5-mixed \
cargo test --release --lib adobe::integration_tests -- --nocapture
```

Set `RAW_DEVELOP_ADOBE_COMPOSED_SETTINGS` to a settings JSON file for another
controlled global or spatial tone capture. No reference files are needed by ordinary tests.

## X-Trans implementation and validation

The implementation uses bounded tiles (288-pixel output, 32-pixel halo) and Rayon
tasks for disjoint two-dimensional tiles. It has no Adobe runtime dependency and
uses portable Rust `f32::mul_add`
to preserve the observed CPU arithmetic. Cancellation is checked per tile.

The recovered chain is:

1. DNG fixed-point normalisation with preserved black. The lookup and per-CFA
   black term are rounded separately to 24.8, then differenced and rounded to
   u16. The black for the checked 14-bit RAFs is 1023, preserved as 4092/65535.
2. White-balance affine, eight directional activity estimates, EVDD spreading,
   direction selection, green and red/blue reconstruction.
3. Highlight-aware WB, scale by minimum neutral, u16 boundary, signed fixed-point
   matrix, Fuji logarithmic LUT and opponent transform.
4. u16 boundary, 3×3 chroma median, radius-8 star bilateral on chroma and
   separable radius-4 luma cleanup. Clip the cleanup buffer to [0,1].
5. Inverse opponent transform, u16 boundary, inverse log LUT and fixed matrix,
   inverse scale and inverse highlight-aware WB, then the output u16 boundary.

`AsShotNeutral` is normalised and rounded to six decimal places. X-E5 and X100VI
use the same measured ISO noise table: scale interpolates linearly; read-noise
amplitude (square root of offset) interpolates linearly. The kernel preserves
FMA association. Float-to-u16 uses ties-to-even. At borders, repeat six crop
rows/columns to preserve the CFA phase, matching `dng_image::Get(edge_repeat,6,6)`.

Provenance: locally installed, symbolised Adobe DNG Converter 18.7, with LLDB
input/output captures and Ghidra/ARM64 instruction inspection. Relevant routines
are `InterpolateFuji6x6`, `cr_stage_new_fuji6x6::Process_32_32`,
`InterpolateEVDD`, `cr_stage_white_balance_3::ProcessOverrangeImpl`,
`cr_stage_matrix3by3`, `cr_smooth_color` and `cr_stage_cleanup_ycc`.
Adobe executables, RAW files, profiles and full capture dumps are not bundled.

Optional external checks (`cargo test` needs none of these files):

```bash
RAW_DEVELOP_ADOBE_RAW=/path/to/DSCF0604.RAF \
RAW_DEVELOP_ADOBE_LINEAR=/path/to/no-ca-linear/DSCF0604.dng \
cargo test --release --lib adobe::xtrans -- --nocapture
```

The reference must be an uncompressed linear DNG (`-u -l -p0`). DNG Converter
bakes optional lateral CA into linear output even when sidecars disable it.
Create the reference from a **separate copy** of a mosaic DNG with its optional
CA `OpcodeList3` disabled; do not compare a no-CA port against baked-CA output.
Linear DNG output does not include user NR or tone-slider settings. Tests compare
every channel without a tolerance, including borders. `RAW_DEVELOP_ADOBE_TRACE`
additionally enables exact intermediate capture checks. A small saturated-highlight
capture regression runs without external files.

`PIPELINE_VERSION` is 5 for modern global/spatial tone/output and mandatory embedded CA in full
Adobe rendering. Apple remains the default; its decode and final-render fixture
tests passed across all eight fixture groups after the global-tone integration.


## Sony Bayer implementation and validation

The full Bayer path uses 192-pixel tiles with a 32-pixel halo and checks
cancellation per tile. Its stages are independent of user NR and sharpening:

1. Separately rounded 24.8 fixed-point normalization, preserving the sensor black
   (512 in 14-bit input becomes 2048/65535).
2. D50 camera gain about preserved black, u16 boundary, signed log encoding via a
   4097-sample float table expanded to all 65536 u16 codes.
3. Hot/cold-pixel suppression (8000/6000 thresholds), then green-split balancing
   (ratio bounds 1/1.02–1.02 for A1 II, 1/1.03–1.03 for A7C R/A7R V).
4. When the calibrated noise normalization exceeds 1000/65535, a composed
   log-to-noise table, second green-balance pass and inverse composed table.
5. Direction and standard-deviation estimates, green interpolation, red/blue
   colour differences and noise-dependent refinement, then a u16 boundary.
6. Inverse log table, inverse D50 gain, clipping and the output u16 boundary.

The pre-gain uses Adobe's default D50 colour specification, independently of the
requested rendering WB. A1 II's default specification is **Adobe Standard v2**;
its matrices differ from the older Adobe Standard DCP. Per-body calibration
comes from `WB_RGBLevelsDaylight` in Sony's encrypted SR2 metadata. The parser
owns only that bounded metadata block, validates offsets, reads the four-byte
cipher key and rounds calibration to four decimal places using the reference
multiply order. No per-file gains are hardcoded. Camera-white normalization,
FMA boundaries and float-to-u16 ties-to-even are retained.

The active sensor rectangle follows `ReadSony3x0`'s model/format rules. It is
neither the padded lossless-JPEG readout nor `SonyRawImageSize`; repeat two
active sensor rows/columns at boundaries to preserve CFA phase, then return the
file's DefaultCrop. Unknown readout modes return `Error::Unsupported`.
Exposures of two seconds or longer additionally use the paired-hot-pixel repair,
with the longer-than-60-second threshold change. Synthetic validation exercises
1,765 repairs across 158,400 samples; complete patched 4-second and 90-second
linear references also match exactly. This is fixture-bounded validation, not a
survey of long exposures from every supported body.

Provenance: the installed symbolised Adobe DNG Converter 18.7, intermediate
LLDB captures, targeted ARM64/Ghidra inspection, and the public DNG SDK colour
and table arithmetic. The small per-model noise/default-colour calibrations
are in Rust; full profiles and Adobe binaries are not bundled. The hot-pixel
kernel additionally matches a runtime-injected synthetic capture containing
396 actual repairs (2000 output samples), so its check exercises corrections.

```bash
RAW_DEVELOP_ADOBE_RAW=/path/to/13567.ARW \
RAW_DEVELOP_ADOBE_LINEAR=/path/to/no-ca-linear/13567.dng \
cargo test --release --lib adobe::bayer -- --nocapture
```

The linear DNG requirements are the same as for X-Trans: make a derived mosaic
DNG copy, disable only its optional `OpcodeList3`, and convert with `-u -l -p0`.
Sony linear DNGs retain the active sensor area; the test compares every pixel
of DefaultCrop. `RAW_DEVELOP_ADOBE_BAYER_TRACE` additionally enables exact core
and composed-chain checks. Normal `cargo test` needs no external files.

## Performance and exact-output optimization

Measured 2026-10-28 on an M4 Pro, 12 Rayon threads, 48 GiB RAM, release build.
Inputs are the validated 40 MP X-E5 and 60 MP A7R V RAWs. Settings use colour
NR 25, luminance NR 0, sharpening 0, embedded Fuji distortion on, and vignetting
off. Global tone uses default Basic controls and exposure 0; spatial tone uses
exposure +0.7, Contrast 30, Highlights -50, Shadows 40, Whites 20 and Blacks -25.

The comparison uses the archived pre-optimization executable from `6641db1`
(with the same benchmark instrumentation) and the optimized executable. Each
case ran twice in fresh processes, alternating before/after order and reversing
that order in the second round. Values below are the median of the two run
medians, each containing seven full-image or 30 proxy exposure edits after
three warm-up renders. These are local timing samples, not confidence bounds.

| Cached edit | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Full image, global tone | 680 → 546 ms | 20% | 1,038 → 897 ms | 14% |
| Full image, spatial tone | 1,481 → 1,214 ms | 18% | 2,260 → 1,857 ms | 18% |
| 2048-edge proxy, global tone | 48.4 → 37.8 ms | 22% | 46.5 → 38.7 ms | 17% |
| 2048-edge proxy, spatial tone | 113.0 → 87.8 ms | 22% | 117.6 → 83.8 ms | 29% |

The older standalone baseline reported 820/1,222 ms for global full images and
1,638/2,342 ms for spatial full images (Fuji/Sony). The fresh paired baseline
above is faster, so the percentages use it rather than overstating the gain
against the earlier sample.

| First full image / process memory | X-E5 | A7R V |
| --- | ---: | ---: |
| Global, before → after | 5.17 → 4.89 s | 4.05 → 3.52 s |
| Spatial, before → after | 6.50 → 6.03 s | 5.89 → 5.43 s |
| Optimized peak RSS, global / spatial | 2.06 / 2.26 GiB | 2.65 / 2.97 GiB |

First-image times include file read/decode, preparation and the first render;
the OS file cache was not flushed. Preparation and initial spatial-mask work
remain substantial. Peak RSS is essentially unchanged. The proxy cases use
Full preparation followed by `with_max_edge(2048)`, not the binned Preview
engine. The benchmark excludes encoding, output writes, network and UI latency.
Measurements cover the Rust Adobe engine.

### Retained changes and exactness gates

Profiling identified profile-table interpolation as a large render hotspot.
The retained changes are:

- Resolve hue wrapping and four/eight table addresses once per pixel instead
  of repeating modulo and address calculations for each coefficient.
- Store three profile coefficients in padded four-float entries and interpolate
  independent lanes with AArch64 NEON multiply/FMA. The rounded product and
  hue → value → saturation FMA order are unchanged. No horizontal sums,
  approximate reciprocals/transcendentals or fast-math reassociation are used.
  Other architectures retain the exact portable `f32::mul_add` implementation;
  only AArch64 performance was measured.
- Feed profile input directly into spatial tone when vignetting is off,
  preserving every integer/float quantization boundary. A trial of global
  fusion regressed timing and was removed; global edits retain their simpler
  separate colour pass. Vignette and Preview paths retain their stages.
- Retain one post-tone statistics result per immutable prepared scene, keyed by
  Highlights/Shadows. That measurement resets Exposure/Contrast/Whites/Blacks,
  so edits to those controls reuse identical statistics. Changing H/S replaces
  the entry; resized proxies share it. Cancellation/errors are not cached.

Every optimization step passed all 11 composed native-capture cases: 4,569,327
final channels with identical float bits, including both H/S directions and
Fuji distortion/vignetting. The SIMD interpolation also matches the original
scalar kernel in 100,000 cases (300,000 coefficient comparisons) covering five
2D/3D table shapes, hue wrap and interpolation endpoints. Native 2D/3D colour
captures remain exact. All ten full-image/proxy/NR25 benchmark cases retain the
original full-output float digest, including all 32 paired timing runs for the
eight global/spatial cases. Prepared-render tests check changed controls,
cache reuse/replacement, cancellation/retry and shared versus fresh proxies.
The full release test suite passes with real DCP profiles available.

These checks cover the tested inputs/settings and captured boundaries, rather
than proving every possible camera/profile/settings combination. Output
contracts and `PIPELINE_VERSION` 5 are unchanged; Apple remains the default.
RAWs, profiles, captures, timing logs and archived executables remain external
to the repository.

Reproduce with caller-owned RAWs, profiles and the settings described above:

```bash
cargo build --release --bin raw-edit-bench
ADOBE_PROFILE_DIR=/path/to/CameraProfiles \
target/release/raw-edit-bench --adobe --full --threads 12 \
  --max-edge 2048 --iterations 30 --settings settings.json original.RAF
```

Use a maximum edge larger than the original and seven iterations for the
full-image sample. JSON reports engine, decode, preparation, resize,
first-render and warmed-render times plus the final exact-float digest.
`/usr/bin/time -l` supplies process peak RSS on macOS. Encoding and UI latency
need separate measurements.

### Second performance pass: concurrency, tiling and tone SIMD

The follow-up pass compares against `d27f129`, the optimized executable from
the first pass above. It uses the same machine, RAWs, profiles, settings and
benchmark procedure. Luminance-NR cases additionally set luminance NR to 25.
These measurements describe incremental gains over the first pass.

| Cached edit | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Full image, global tone | 603 → 474 ms | 21% | 875 → 760 ms | 13% |
| Full image, spatial tone | 1,198 → 896 ms | 25% | 1,863 → 1,389 ms | 25% |
| 2048-edge proxy, global tone | 40.7 → 33.9 ms | 17% | 45.2 → 35.9 ms | 20% |
| 2048-edge proxy, spatial tone | 85.0 → 65.2 ms | 23% | 89.2 → 63.7 ms | 29% |

| Preparation / first render | X-E5 before → after | A7R V before → after |
| --- | ---: | ---: |
| Luminance NR 25 preparation | 6.25 → 5.78 s (7%) | 5.41 → 4.31 s (20%) |
| First spatial proxy render, including lazy mask | 575 → 397 ms (31%) | 834 → 463 ms (44%) |
| First usable full spatial image, including decode/preparation | 6.17 → 5.70 s (8%) | 5.42 → 4.68 s (14%) |
| Peak process RSS, luminance NR 25 | 1.89 → 1.92 GiB | 2.53 → 2.58 GiB |

All ten Adobe cases ran twice before and twice after, in 40 fresh-process runs;
every run retained the original complete final-output float digest. Values use
the median of two run medians, with seven full-image or 30 proxy timed edits
per run. These remain local samples rather than confidence bounds. The fresh
paired baseline differs from the first-pass timings above, so comparisons use
this pass's baseline. First-image latency does not improve uniformly: Fuji's
global first usable image was effectively flat (4.87 → 4.92 s), and its global
proxy preparation varied enough to offset the cheaper render.

Larger luma tiles use more scratch memory. Final NR25 process peaks increased
by approximately 26 MiB (Fuji) and 58 MiB (Sony); an earlier isolated trial
showed roughly 70–75 MiB increases. Peak RSS also reflects allocator/process
variation, so these are measured costs rather than fixed memory guarantees.
Other stages and working-image buffers still dominate total process memory.

The retained changes are:

- Run independent Gaussian mask reduce/expand/resize rows through the existing
  Rayon pool. Buffers below 65,536 floats remain serial, and larger jobs keep
  at least approximately 8,192 floats per task. Each pixel's tap order, the
  outer remap-sample accumulation and scene-statistics reductions are unchanged.
- Use 384-pixel tiles for four-level luma NR, retaining 192-pixel tiles for
  chroma-only NR. Both sizes preserve the eight-pixel lattice and the existing
  160-pixel rounded halo; larger tiles reduce repeated halo work.
- Apply the primary tone arithmetic to four independent pixels in AArch64
  NEON for spatial edits. Table lookups retain the scalar evaluator; exact
  division, rounded products and explicit FMA boundaries follow the scalar
  stage. Comparisons/selects preserve the scalar clamp's NaNs and signed zero.
  Global edits and non-AArch64 targets retain their scalar tone path.
- Share the immutable 65,536-entry output gamma table through `OnceLock`.
- Skip the final full-image orientation copy when the combined EXIF orientation
  and user rotation are identity. The shared finish path also benefits the
  Apple engine, with no pixel arithmetic change.

Trials removed after measurement: reusing demosaic/NR tile scratch buffers
produced no material improvement; batching global tone and vectorizing the
fixed integer output matrix regressed timing; rendering directly from borrowed
prepared pixels slowed global edits without a useful spatial gain. The initial
working-image clone remains. Exactness alone was insufficient to retain a trial.

All retained steps passed the 11 composed native-capture cases (4,569,327 final
channels, identical float bits). Native Gaussian pyramid/remap/resampler checks
on both cameras additionally matched 307,677,734 captured values; incomplete
capture pairs were excluded by the existing capture tests. A differential
test compares one versus four threads on odd, skinny and small images. The
four-pixel tone test compares 600,000 RGB pixels (1.8 million channels) across
six smooth/exposure combinations, including endpoints, channel ties, signed
zero and subnormals. A luma-NR test compares the original and larger tiles across
horizontal/vertical joins, their intersections and odd edges. The complete
release suite passes with real DCP profiles: 202 library tests, six prepared
integration tests and the compile doctest, including linear output,
rotation/crop and cancellation. Full-image Apple-engine digest checks on the
same Fuji and Sony RAWs also remain unchanged. External Apple-reference fixture
tests still require their documented fixture variables.

Output contracts and `PIPELINE_VERSION` 5 are unchanged. These gates cover the
tested cases and captured boundaries; they do not prove all cameras, profiles,
settings or architectures. External inputs and measurement artifacts remain
outside the repository.

### Third performance pass: preparation

The validated second pass was committed as `d1ce916`. A fresh two-round engine
comparison then ran both Rust engines on the same RAWs with the same global
settings, alternating engine order and reversing it in round two. Before the
preparation changes below, cached full-image Adobe edits took 485 ms versus
295 ms for Apple on Fuji, and 809 ms versus 426 ms on Sony. First usable full
images took 5.28 versus 2.86 s (Fuji), and 4.03 versus 3.91 s (Sony). These fresh
samples supersede the earlier historical engine comparison; the Apple numbers
describe this Rust implementation, not a native RawCamera benchmark.

Temporary stage timers measured approximately 2.50 s for Fuji demosaic/mandatory
cleanup and CA, 1.22 s for default chroma NR, 0.22 s for optional distortion,
0.15 s for the camera pyramid and 0.10 s for guide preparation. Within mandatory
cleanup, median selection and directional filtering each accounted for roughly
42–43% of summed tile time. OS sampling confirmed the cleanup/NR hotspots.
Instrumentation and sampled stacks remain external; production has no timers.

The focused preparation comparison uses `d1ce916` and the final executable,
with four cases (two cameras × default/luminance-NR25), two rounds reversing
before/after order, and seven timed full-image edits after three warmups in each
fresh process. All 16 runs retain their original complete output digest.

| Preparation / first image | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Default preparation | 4.38 → 2.78 s | 37% | 2.91 → 2.36 s | 19% |
| Luminance NR 25 preparation | 5.63 → 3.75 s | 33% | 4.41 → 4.11 s | 7% |
| Default first usable full image | 4.97 → 3.40 s | 32% | 3.73 → 3.21 s | 14% |
| Luminance NR 25 first usable full image | 6.23 → 4.40 s | 29% | 5.16 → 4.86 s | 6% |

These are the medians of the two process samples, not confidence bounds. Cached
edit times varied by 1–6% in this comparison; this pass targets preparation,
without changing the repeated render algorithm. Peak RSS was effectively flat:
2.06/2.65 GiB (Fuji/Sony) for default settings and approximately 2.15/2.72 GiB
with luminance NR 25. No additional full-image scratch allocation is required.

The final Apple/Adobe comparison repeats all eight camera/engine/size cases in
two fresh-process rounds, again alternating engine order and reversing it in
round two. Both engines use full quality and the same global settings; the
2048-edge proxy is resized after preparation. Cached times are medians of the
two run medians (seven full-image or 30 proxy edits per run).

| Camera / output | Apple cached edit | Adobe cached edit | Apple first usable | Adobe first usable |
| --- | ---: | ---: | ---: | ---: |
| X-E5 full image | 310 ms | 450 ms | 2.50 s | 3.22 s |
| X-E5 2048-edge proxy | 20.4 ms | 35.1 ms | 2.13 s | 2.92 s |
| A7R V full image | 414 ms | 725 ms | 3.36 s | 3.17 s |
| A7R V 2048-edge proxy | 20.9 ms | 33.4 ms | 3.01 s | 2.56 s |

Adobe's first full Sony image is approximately 6% faster in this sample;
Fuji's remains approximately 29% slower. Apple retains faster cached editing
on both cameras. These are independent paired samples, so the focused
before/after table above is the measure of this pass's gains. All 16 final
engine runs preserve their respective baseline digests, including both Apple
proxy sizes. This establishes unchanged output within each engine, not equal
output between engines, and does not measure native RawCamera.

Two changes were retained:

- Replace full nine-value sorts with a 19-comparator median-selection network.
  Cleanup maps finite float bit patterns to the same signed order as
  `f32::total_cmp`, preserving signed zero, and retains canonical NaN for any
  nonfinite neighbourhood. Default chroma NR uses the same network on signed
  integer residuals when its rank is exactly 1024. Fractional ranks retain the
  original full sort and interpolation.
- Run mandatory X-Trans directional cleanup on four independent pixels using
  AArch64 NEON. Each lane retains all 68 neighbour contributions in the original
  direction/tap order, the original rounded distance products, FMA boundaries,
  epsilon and exact division. Comparison/select clamps preserve NaNs and signed
  zero. A checked source extent and the eight-pixel stencil bound every SIMD
  load; the final one to three pixels and other architectures use the scalar
  form. No whole-image scratch buffer was added.

The median network is checked against all 362,880 permutations of distinct
ranks, all 512 binary neighbourhoods, and 20,000 additional float/integer
neighbourhoods. Float comparisons include signed zero, subnormals, arbitrary
bit patterns and nonfinite rejection. Directional cleanup compares every float
bit against its scalar form across six widths covering all batch remainders,
with random quantized values, signed zero, subnormals and canonical NaNs.

Each arithmetic step passed all 11 composed captures (4,569,327 final channels).
The final implementation additionally matches all six complete no-CA Fuji
linear DNGs (X-E5 and X100VI) and the complete captured demosaic/cleanup chain.
The release suite passes with real DCP profiles: 205 library tests, six prepared
integration tests and the compile doctest. Apple remains the default, its
output is unchanged, and `PIPELINE_VERSION` remains 5. The reference and
differential checks cover the tested inputs rather than proving all settings
or architectures.

### Fourth performance pass: cached profile colour

This pass starts at `00cc672`. OS sampling of repeated full-size global Fuji
edits, after preparation, identified profile-colour evaluation as the largest
named CPU hotspot, followed by primary tone and exposure. The sampling run is
separate from the paired timing runs and is not used as a timing baseline.

Profile colour now processes four independent pixels with AArch64 NEON. HSV
conversion, rational/polynomial encoded-value arithmetic and HSV reconstruction
share pixel lanes, including exact hardware division and the original explicit
FMA boundaries. Profile coefficient gathers retain checked scalar indexing and
the existing hue, then value, then saturation interpolation. Black removal and
every intervening u16 normalization remain unchanged. The path covers both the
input profile map and the later LookTable, including fused spatial input colour.
Scalar code handles row tails and other architectures; global primary tone
remains scalar. No full-image buffer or cached image was added.

The differential test compares 384,000 RGB pixels (1,152,000 channels) against
the scalar path across four table geometries, linear/encoded value axes,
ordinary/overrange tables and three amounts. Inputs cover signed zero,
subnormals, endpoints, channel ties, canonical NaNs and values outside [0,1].
Both the colour batching step and its fused spatial integration pass all 11
composed native-capture cases (4,569,327 final channels, exact float bits).
The complete release suite passes with real DCP profiles: 206 library tests,
six prepared integration tests and the compile doctest. Ten additional
before/after digest comparisons cover five RAWs from X100VI, A1 II and A7C R
(full global images and 2048-edge spatial proxies), including the Sony APS-C
crop and high-ISO/lossy-compressed samples. All retain their pre-change output.
These extend the two benchmark cameras' coverage without establishing all-camera
parity. Apple remains the default and `PIPELINE_VERSION` remains 5.

The paired comparison uses the same machine, RAWs, profiles and global/spatial
settings as the previous passes. Each of ten camera/settings/size cases runs
twice before and twice after (40 fresh processes), reversing order in round two.
Values are medians of two run medians, with seven full-image or 30 proxy edits
after three warmup renders. Every run preserves its original final-output float
digest. The two samples per version are local measurements, not confidence bounds.

| Cached edit | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Full image, global tone | 475 → 360 ms | 24% | 755 → 564 ms | 25% |
| Full image, spatial tone | 900 → 660 ms | 27% | 1,345 → 1,032 ms | 23% |
| Full image, luminance NR 25 | 495 → 339 ms | 32% | 758 → 557 ms | 26% |
| 2048-edge proxy, global tone | 33.6 → 24.5 ms | 27% | 37.7 → 27.7 ms | 27% |
| 2048-edge proxy, spatial tone | 61.8 → 50.8 ms | 18% | 65.5 → 44.8 ms | 32% |

Peak RSS is effectively flat: median process peaks differ by at most 12 MiB
per case, with default full-image peaks around 2.06/2.65 GiB (Fuji/Sony) and
spatial full-image peaks around 2.27/2.98 GiB. This pass targets cached edits;
preparation still dominates first-image latency. First usable full images
improve modestly in these samples, while first proxy images are 25–164 ms
slower as preparation varies. The cached gains do not imply uniformly faster
first-image delivery.

A separate six-second sample of the final cached global render now places
scalar primary tone first among named CPU functions, followed by exposure and
batched profile colour. Tone/exposure are the next measured targets; the earlier
rejected global-tone SIMD trial remains excluded from this implementation.

### Fifth performance pass: tone, exposure and table evaluation

The profile-colour pass was committed as `1ea3698`. This pass addresses the
primary-tone and exposure hotspots identified in its final cached-render sample.
The existing four-pixel primary-tone path now also handles global edits: the
four-pixel colour layout introduced by the previous pass makes this worthwhile,
where the earlier standalone global-tone trial had regressed.

Exposure now batches four independent pixels with AArch64 NEON, retaining its
endpoint transforms, exact division/square root, explicit FMA boundaries,
separate middle-channel multiply/add, and the original green-twice luma sum.
Rolloff, Whites and both Blacks branches use the same clipping/table boundaries.
Tone and exposure also share a four-position table evaluator: it preserves
checked scalar coefficient gathers, the padded endpoint and the original
separate multiply/add interpolation, with no FMA contraction or approximate
indices. Row tails and other architectures retain the scalar stages.

Isolated exposure batching with scalar table evaluation was flat or slower.
With batched table evaluation, the combined path was 4–19% faster than scalar
exposure in the four full-image cases of an isolated paired trial. This coupling
is why both changes are retained. The final measurements below compare the
complete pass with `1ea3698`, rather than adding isolated percentages together.

| Cached edit | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Full image, global tone | 339 → 315 ms | 7% | 547 → 445 ms | 19% |
| Full image, spatial tone | 677 → 639 ms | 6% | 1,021 → 953 ms | 7% |
| Full image, luminance NR 25 | 351 → 293 ms | 16% | 528 → 474 ms | 10% |
| 2048-edge proxy, global tone | 26.1 → 23.3 ms | 11% | 26.4 → 21.2 ms | 20% |
| 2048-edge proxy, spatial tone | 50.4 → 44.5 ms | 12% | 53.5 → 47.2 ms | 12% |

The same ten camera/settings/size cases ran twice before and twice after,
reversing order in round two: 40 fresh processes, seven full-image or 30 proxy
edits after three warmups per run. Every run preserves its original final-output
float digest. Values are medians of the two run medians, not confidence bounds.
Fuji global timing varied substantially: after medians were 282 and 347 ms,
versus 346 and 331 ms before. One paired round regressed, so its 7% aggregate
should not be treated as a reliable improvement bound. Sony global and both
cameras' spatial runs improved in both rounds.

Peak RSS remains effectively flat: median process peaks differ by at most
10 MiB per case. Default full-image peaks are approximately 2.06/2.65 GiB
(Fuji/Sony); spatial peaks remain approximately 2.27/2.97 GiB. No full-image
scratch buffer or additional prepared-image cache is introduced. Preparation
still dominates first-image delivery, which does not improve uniformly.

Each arithmetic step passed all 11 composed native-capture cases (4,569,327
final channels, exact float bits). The new exposure differential test checks
1,048,576 RGB pixels across 128 combinations of optional stages and gains,
including channel ties, signed zero, subnormals, canonical NaNs, infinities,
headroom and a zero epsilon. Table evaluation compares 240,000 values across
three table sizes, including arbitrary float bit patterns and endpoints.
The existing primary-tone differential test also passes. Final validation
includes 208 library tests, six prepared integration tests and the compile
doctest with real DCP profiles, plus unchanged before/after digests in ten
additional full-global/spatial-proxy cases on five X100VI, A1 II and A7C R RAWs.
Apple remains the default and `PIPELINE_VERSION` remains 5. The checks cover
these inputs and captured boundaries rather than proving every setting or CPU.

### Sixth performance pass: preparation buffers and shared NR encoding

This pass starts at `15eaa46` and targets preparation and memory. Separate
instrumented runs put the camera-statistics pyramid at approximately 0.16/0.24 s
(Fuji/Sony), default NR at 0.91/1.17 s and luminance NR 25 at 1.77/2.54 s.
These samples locate work; they are not the paired benchmark baseline. Temporary
timers were removed before validation and final measurements.

The paired comparison uses the same M4 Pro, 12 threads, RAWs, DCPs and settings
as the earlier passes. Ten cases run twice before and twice after, reversing
order in round two: 40 fresh processes, each with three initial/warmup renders
and seven full-image or 30 proxy edits. Values below are medians of two process
samples, not confidence bounds. All 40 output digests match their baseline.
Filesystem caches are not cleared; encoding, network and UI latency are excluded.

| Full-resolution preparation | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Default global | 2.69 → 2.45 s | 9% | 2.39 → 2.07 s | 13% |
| Spatial tone | 2.76 → 2.69 s | 3% | 2.35 → 2.11 s | 10% |
| Luminance NR 25 | 3.81 → 3.60 s | 6% | 3.90 → 3.59 s | 8% |

| Peak process RSS, 2048-edge proxy | X-E5 before → after | A7R V before → after |
| --- | ---: | ---: |
| Default global | 1.65 → 1.40 GiB | 2.06 → 1.63 GiB |
| Spatial tone | 1.85 → 1.40 GiB | 2.40 → 1.72 GiB |

Proxy peak RSS falls by 15–29%. Full-resolution peaks remain effectively flat,
within 16 MiB per case: approximately 2.06/2.64 GiB (Fuji/Sony) for default
settings and 2.27/2.97 GiB for spatial tone. Default first usable full images
improve from 3.26 to 2.91 s (Fuji) and 2.87 to 2.64 s (Sony). First-image gains
are not uniform: Fuji spatial full is essentially unchanged, while Sony spatial
proxy preparation/first usable image regress by approximately 1%/26 ms.

Cached editing uses the same algorithm but its timings are mixed. Fuji proxies
regress in both rounds: global 20.5 → 23.9 ms (+16.5%) and spatial 47.7 → 50.8 ms
(+6.5%). Fuji global full is 290 → 299 ms (+3.2%); Sony spatial full is
972 → 1,005 ms (+3.5%). Other cached medians improve by 1–7%. These measured
tradeoffs accompany the preparation/memory gains; this pass does not establish
uniformly faster cached editing or isolate the cause of its timing shifts.

Preparation now takes ownership of its RGB image, allowing stages to reuse
pixels after retaining the exact input samples their filters require:

- Mandatory active-image lateral CA encodes immutable taps once as u16. Identity
  channels retain exact float planes, including signed zero and nonfinite bits.
  The demosaic RGB allocation is released before allocating the warped output.
  Three identity channels return the input; two retain the direct float-source
  path, since two float planes plus packed RGB would exceed the original source.
- Optional Fuji distortion retains its encoded u16 taps and writes into the
  transferred RGB allocation, with unchanged transport/resampling arithmetic.
- NR encodes the entire source once as packed u16 YCC (six bytes per pixel).
  Every tile copies clamped halo samples from it and decodes its result into
  the owned RGB image. Previously each tile re-encoded overlapping halos and
  held a separate full RGB output. Chroma/luma filters, 192/384-pixel tiles and
  two/eight-pixel lattice alignment are unchanged. Failed or cancelled work
  drops the partial owned image; no incomplete `Prepared` is published.
- Sony DefaultCrop compacts rows toward the beginning of the owned allocation
  after NR, retaining capacity and the existing NR lattice. It performs no float
  arithmetic and requires no second RGB allocation.
- Camera-statistics pyramid reductions parallelize independent rows above
  16,384 output pixels. Each pixel retains the original four integer samples,
  addition order and rounding; smaller reductions stay serial.

CA packed/identity scratch and NR packed scratch use page-aligned anonymous
`memmap2` mappings, with safe typed views through `bytemuck`. They are unmapped
at stage return, releasing the pages before cached rendering. No file is mapped
and no unsafe code was added to the engine. The CLI, FFI and native addon's
lockfiles include the new dependencies.

Several bit-exact trials were rejected after measuring process memory. Packing
filtered NR output alone left peak RSS flat. Reusing the demosaic RGB allocation
through CA increased Sony full-image RSS despite fewer logically live pixels;
restoring the old NR alone did not remove that increase. Releasing demosaic RGB
before allocating CA output improved proxy memory, but heap-backed CA/NR scratch
still raised Sony's default full-image peak by approximately 0.3 GiB. Mapping NR
scratch alone also failed to remove it. Explicitly unmapping both CA and NR
scratch removed the regression in the final paired measurements. Allocation
lifetimes therefore matter beyond the sum of currently live pixel buffers.

The final release suite passes 211 library tests, six prepared integration tests
and the compile doctest; the external-profile prepared test also runs with real
DCPs. The host FFI crate passes `cargo check --locked`. All 11 composed
native-output captures remain exact (4,569,327 channels).
Seventeen NR capture invocations cover four RAW-to-chroma+luma cases (1,665,222
channels), four luminance stage/constructor cases (555,074 Y samples), two
default-chroma RAW-to-prepared cases (832,611 channels), and seven chroma-stage
captures including fractional ranks. Ten full-output digest comparisons on five
additional X100VI, A1 II and A7C R RAWs retain their baseline output for full
global images and 2048-edge spatial proxies. The CA algorithm also matches six
complete Fuji linear references and five Sony DefaultCrop regions.

Differential tests retain the original per-tile NR encoder and separate output,
covering odd sizes, tile joins, chroma+luma and luma-only settings. CA compares
against its original float source at one/four threads, across all identity-channel
counts, signed zero, subnormals, NaNs, infinities and overrange values. Pyramid
tests cover odd edges and linear/nonlinear encoding at one/four threads. Every
nonempty rectangle of a 7×5 image verifies crop float bits and allocation reuse.
Apple remains the default and `PIPELINE_VERSION` remains 5.

No physical iPhone was available: the device inventory contained simulators only,
and `xcrun devicectl list devices --timeout 5` returned no devices. Desktop
measurements do not establish phone latency, memory limits or thermal behaviour.

### Seventh performance pass: neighbourhood work and batched output

This pass starts at `7afda3c`. Its first measurement repeats the sixth pass's
suspected cached-edit regressions against `15eaa46` with four fresh-process
rounds, alternating and reversing execution order. Fuji proxies use 90 edits
per process; Sony full-size spatial renders use nine. All paired digests match.

| Cached render, predecessor → sixth pass | Median of four run medians |
| --- | ---: |
| X-E5 2048 global | 22.46 → 22.01 ms |
| X-E5 2048 spatial | 46.69 → 46.88 ms |
| A7R V full spatial | 940 → 954 ms |

The earlier 16.5% Fuji global proxy regression does not repeat in this sample.
Sony's aggregate spatial difference is 1.4%, with overlapping run ranges.
These local observations do not identify a particular buffer change as the
cause of a stable slowdown, so the sixth pass's preparation/memory improvements
are retained. They also do not prove that cached timing regressions cannot occur.

Separate OS samples of the current implementation identify chroma NR and active
CA as substantial preparation work. Cached rendering still spends most named
CPU work in pointwise output, profile colour, tone and exposure. This pass
retains two preparation changes and a batched output path:

- The chroma low-pass horizontal stage computes only source positions `2*x+2`,
  which are the only columns its vertical stage reads. Its intermediate uses
  `(width-3)/2 * height` RGB u16 pixels instead of `width * height`. Both five-tap
  integer sums, their separate rounding boundaries, output dimensions and phase
  are unchanged. This removes approximately half the horizontal work and scratch.
- Active CA determines whether its 4×4 footprint is wholly inside the source.
  Interior footprints use four bounded row slices instead of clamping each tap;
  edge footprints use the original generic clamped sampler. Radial coordinates,
  table phase, all 16 signed integer contributions, rounding and float
  normalization remain the same. Identity float planes retain their prior path.
- AArch64 output conversion batches four independent pixels: separate float
  multiplication and ties-to-even saturating conversion commit working RIMM to
  u16, followed by the signed fixed matrix and its original shift/clip. Checked
  scalar gamma gathers and normalization follow. The matrix constructor bounds
  absolute products plus the affine offset to i32, so NEON's narrower integer
  accumulations match the scalar i64 result. Other targets and scalar tails
  retain the original pixel path. No image buffers are added.

Standalone kernel measurements support these changes independently of noisy
full preparation. With six alternating-order pairs, omitting the first pair,
the compact chroma low pass is approximately 3% faster at 224×224 and 12% faster
at 704×704 (60 calls per timed block). A synthetic 1024×768 two-channel CA
sampler is approximately 31% faster (19.4 → 13.3 ms). These are isolated kernel
measurements using copied source, not whole-engine speedups or phone estimates.
Early full preparation and cached-render trials varied substantially, so their
individual gains or regressions are not used as improvement bounds.

The final paired comparison uses `7afda3c` as its baseline and the same M4 Pro,
12 threads, RAWs, DCPs and settings as the sixth pass. Ten cases run twice per
version in fresh processes, reversing execution order in round two. Each
process performs three initial/warmup renders and seven full-size or 30 proxy
edits. Values below are medians of two process samples, not confidence bounds.
Filesystem caches are not cleared; encoding, network and UI time are excluded.
All 40 process output digests retain the original baseline values.

| Cached edit | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Global full | 276.7 → 264.4 ms | 4.4% | 430.8 → 411.3 ms | 4.5% |
| Spatial full | 633.4 → 597.4 ms | 5.7% | 937.1 → 892.1 ms | 4.8% |
| Luminance NR 25 full | 289.6 → 265.4 ms | 8.4% | 421.7 → 397.7 ms | 5.7% |
| Global 2048 proxy | 22.49 → 22.17 ms | 1.4% | 23.85 → 19.95 ms | 16.4% |
| Spatial 2048 proxy | 44.24 → 44.83 ms | -1.3% | 45.29 → 42.45 ms | 6.3% |

All six full-size cached aggregates improve. Proxy spatial results reverse
direction between rounds for both cameras, so their aggregate differences do
not establish a stable gain or regression. Fuji global proxy also reverses
direction. The output-only step trial against compact-NR/interior-CA code
improves Fuji spatial proxy medians in both rounds (46.04 → 42.71 ms aggregate),
while global proxy results are approximately flat (20.44 → 20.24 ms). This
supports retaining the newly batched output path despite an earlier, separate
fixed-matrix SIMD trial being slower before the later batching work.

| Full-resolution preparation | X-E5 before → after | Time saved | A7R V before → after | Time saved |
| --- | ---: | ---: | ---: | ---: |
| Global | 2.46 → 2.56 s | -4.4% | 2.08 → 2.13 s | -2.1% |
| Spatial | 2.51 → 2.48 s | 1.2% | 2.11 → 1.90 s | 9.6% |
| Luminance NR 25 | 3.56 → 3.68 s | -3.2% | 3.70 → 3.23 s | 12.8% |

Preparation is not uniformly faster. Fuji global/NR25 are slower in both rounds;
Sony NR25 improves in both. Other full-size preparation comparisons reverse
direction between rounds. First usable full images are 2.88 → 2.98 s for Fuji
global and 3.97 → 4.22 s for Fuji NR25; Sony spatial improves 3.61 → 3.24 s and
Sony NR25 improves 4.23 → 3.74 s. The retained changes therefore trade some
Fuji first-image latency for faster full-size cached editing and less low-pass
work; the isolated kernel gains must not be presented as uniform engine gains.

Peak process RSS stays within 22 MiB of baseline in every case. Full global
peaks are approximately 2.06/2.64 GiB (Fuji/Sony), spatial 2.27/2.97 GiB, and
NR25 2.15/2.69 GiB. Proxy peaks remain approximately 1.39–1.41 GiB for Fuji
and 1.63–1.71 GiB for Sony. This pass retains the sixth pass's proxy memory
improvement but does not establish another substantial process-memory gain.

The compact low pass is compared with its original full-width intermediate
across 210 size/pattern combinations, including odd/even and minimum five-tap
dimensions, full-range codes, constants and alternating extrema. The CA sampler
is compared against its generic form on tiny/odd images, every pixel/channel,
two warp centres including an off-image centre, and several radial strengths.
Existing one/four-thread identity-plane tests retain signed-zero/nonfinite checks.
The batched output is compared bit-for-bit with scalar output on 1,048,576 RGB
pixels across Display P3 and sRGB, including arbitrary float bits, quantized
values, half-step boundaries, signed overrange, signed zero, subnormals, NaNs
and infinities. Its unsafe NEON loads/stores address complete four-pixel or
four-element arrays. No dependencies are added. Apple remains the default and
`PIPELINE_VERSION` remains 5.

The release suite passes 214 library tests, six prepared integration tests and
the compile doctest with real DCPs. The NR change passes all 17 capture
invocations from the sixth pass. The combined implementation retains all 11
composed native-output captures (4,569,327 channels) and all six complete Fuji
linear-CA references/five Sony DefaultCrop references exactly.
Ten additional full-output comparisons on five X100VI, A1 II and A7C R RAWs
also retain baseline digests for full global images and spatial 2048 proxies.

A fresh physical-device check again reports no connected iPhone. Desktop
timings and memory results do not establish on-device performance.

### Eighth performance pass: Fuji tile scheduling and scratch lifetime

This pass starts at `8d5823a` and targets Fuji first-image preparation and peak
memory. Temporary stage probes on the X-E5 benchmark RAW put demosaic plus
mandatory cleanup at approximately 1.21–1.51 s. Default user NR takes
approximately 0.64–1.03 s, rising to 1.73–2.09 s with luminance NR 25. Embedded
CA, guide construction and distortion each take approximately 0.12–0.27 s.
Cleanup accounts for most of the summed per-tile elapsed time within demosaic.
These instrumented observations locate work; they are not final paired timings.
All temporary timers are removed before the final build.

X-Trans output tiles grow from 192 to 288 pixels, retaining the 32-pixel halo
and the original sensor-relative CFA phase, edge-repeat rules, demosaic,
cleanup, float association and integer boundaries. Both tile sizes are
divisible by six. For interior tiles, padded area per output pixel falls from
approximately 1.78 to 1.49, reducing padded work per output pixel by 16%. This is a
geometric work reduction, not a measured whole-engine speedup.

Simply enlarging strip tasks would leave too few tasks for the thread pool.
Each output strip is instead partitioned into vectors of disjoint mutable row
slices, one vector per tile. Rayon can schedule the two-dimensional tiles
independently. The vectors retain only slice metadata; they do not allocate a
second RGB image. Workers retain one tile's existing activity/cleanup scratch,
then copy its output rows into the borrowed destination. Cancellation remains
checked per tile, and errors return no completed image. No unsafe code is added.

The initial 384-pixel trial improves Fuji global preparation in three paired
runs, but raises proxy peak RSS by approximately 90–140 MiB. It is not retained
alone. Fuji distortion still used a heap-backed full-image u16 snapshot, whose
released pages could remain resident while NR allocated another packed source.
That snapshot now uses the same anonymous `memmap2`/safe `bytemuck` views as CA
and NR; its pages unmap at distortion's return. No files are mapped, and all
transport tables, sample values, warp arithmetic and output writes are unchanged.
An isolated two-round comparison against the larger-tile prototype reduces
peak RSS by approximately 220–234 MiB, with identical whole-output digests.

The 384-pixel design still raises spatial-case peak RSS by approximately
64–68 MiB in the first full sweep. Cleanup originally retains two successive
RGB snapshots: the median input and then the directional-pass input. It now
copies the directional input into the existing snapshot and drops it before
allocating luma reconstruction scratch. No samples or operations change.
Three paired proxy trials reduce peak RSS by approximately 12–30 MiB, with
preparation differences within approximately 2% in either direction. The
retained tile size is reduced to 288 to limit concurrent tile scratch further.

Three focused pairs against `8d5823a` then improve preparation by approximately
8–11% across Fuji global, spatial and NR25 proxies. Peak RSS falls by
approximately 35 MiB for spatial, 182 MiB for global and 219 MiB for NR25.
These short trials select the retained implementation; the broader comparison
below measures the final build independently.

The final sweep uses three fresh-process rounds for each version and all ten
Fuji/Sony full-size/proxy cases, alternating execution order. Each process runs
three initial/warmup renders, then seven full-size or 30 proxy edits. Values
are medians of three process samples, not confidence bounds. The same M4 Pro,
12 threads, RAWs, DCPs and settings are used for both versions. Filesystem
caches are not cleared; encoding, network and UI latency are excluded. Builds,
reference checks and stage probes do not run during these measurements.

| Case | Preparation (s), before → after | Peak RSS (GiB), before → after | Cached edit (ms), before → after |
| --- | ---: | ---: | ---: |
| X-E5 global full | 2.54 → 2.35 | 2.064 → 1.879 | 272.65 → 255.24 |
| X-E5 spatial full | 2.41 → 2.05 | 2.258 → 2.231 | 599.06 → 576.75 |
| X-E5 NR25 full | 3.72 → 3.53 | 2.141 → 1.924 | 290.27 → 252.41 |
| X-E5 global 2048 | 2.76 → 2.36 | 1.396 → 1.221 | 21.52 → 21.15 |
| X-E5 spatial 2048 | 2.51 → 2.15 | 1.403 → 1.376 | 47.75 → 42.69 |
| A7R V global full | 2.23 → 1.86 | 2.642 → 2.638 | 405.16 → 419.41 |
| A7R V spatial full | 1.88 → 1.82 | 2.968 → 2.962 | 901.42 → 896.77 |
| A7R V NR25 full | 3.35 → 3.53 | 2.694 → 2.696 | 416.64 → 407.72 |
| A7R V global 2048 | 1.94 → 2.10 | 1.639 → 1.633 | 19.61 → 23.85 |
| A7R V spatial 2048 | 2.40 → 1.98 | 1.717 → 1.712 | 48.95 → 46.82 |

All 60 process output digests match the original baseline. Fuji peak RSS falls
by approximately 27–223 MiB across the five cases. Full-size preparation
medians fall by 5–15%, but only spatial preparation improves in all three
rounds. Global preparation reverses direction; NR25 preparation is slower
in two rounds despite its lower aggregate. First usable full-image medians
fall from 3.08 to 2.81 s (global), 3.47 to 3.24 s (spatial), and 4.35 to
3.94 s (NR25), including decode, preparation and the first render.

Fuji cached NR25 improves in all three rounds. Other Fuji cached cases reverse
direction between rounds. Sony full global cached edits and global proxies
are slower in all three rounds of this sweep. Sony NR25 preparation is
approximately 5.5% slower in aggregate, and its global-proxy preparation is
approximately 8.3% slower; these preparation comparisons reverse direction
between rounds. Sony peak RSS differs by at most approximately 7 MiB in the
sweep. This pass changes no Sony-specific kernels; the measured differences
on that path have no established cause. The results do not establish uniform
engine gains.

A separate four-round recheck uses 180 proxy edits and 15 full-size edits per
process to investigate Sony global timing. The proxy slowdown does not
reproduce: process-median aggregates are 20.78 → 19.88 ms. Full-size global
edits remain slower, 406.88 → 432.00 ms (6.2%), with three of four pairs slower.
Full-size peak RSS is approximately 63 MiB higher in this longer recheck;
the pass establishes no Sony memory improvement. All 16 recheck digests match.
Disassembly comparisons of the profile-colour, exposure and output batches,
the prepared/Adobe render entrypoints and 72 render-related functions find
matching instruction counts and operation/register sequences after normalizing
addresses and immediates. This rules out an obvious extra-instruction change
in the inspected functions, but does not establish the regression's cause.
The Fuji preparation/memory gains are retained with this Sony cached-edit
regression explicitly recorded as a remaining tradeoff.

The differential tile test compares the former 192-pixel lattice at one thread
with 288-pixel tiles at four threads. Eight synthetic RAW cases cover tiny and
odd dimensions, both sides of tile joins, shifted CFA phases, nonzero crop
origins, both Fuji model names, ISO 64/12800, full-range codes and extrema.
Every float bit matches, and all produced pixels are finite. The release suite
passes 215 library tests, six prepared integration tests with real DCPs and the
compile doctest. All 11 composed native-output captures remain exact
(4,569,327 channels), as do six complete Fuji linear-CA references and five
Sony DefaultCrop references. All 17 NR capture invocations and ten additional
whole-output comparisons on five X100VI, A1 II and A7C R RAWs retain exact
results for full global images and spatial 2048 proxies. Apple remains the
default and `PIPELINE_VERSION` remains 5. No dependencies or unsafe code are added.

A fresh `devicectl` check reports no connected physical iPhone. Desktop timing
and memory measurements do not establish phone latency or thermal behaviour.

## Remaining work

Full Fuji distortion/vignetting are integrated and composed RAW-to-vignette checks match
both X-E5 and X100VI captures. Sony's optional profile-enabled route selects an
external LCP; LCP discovery/interpolation is not implemented, and embedded Sony
distortion is not substituted for it. User sharpening and other ACR controls
outside the documented NR/tone controls are not implemented. Broader
full-image, camera/settings and Display P3 runtime captures remain useful;
exact captured boundaries do not establish complete ACR parity.
