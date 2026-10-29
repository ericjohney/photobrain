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

The production tiler uses 192-pixel outputs. Chroma-only filtering preserves the
two-pixel lattice; luminance enables a 160-pixel halo and an eight-pixel lattice.
Chroma and luminance filter the same encoded source independently. Luminance-only
filtering bypasses the chroma kernel, including its zero-strength singularities.
Cancellation is checked per tile and before publishing the output.

Exact photographic capture checks cover NR100 and mixed settings on X-E5 and
A7R V: constructor arrays, every luminance level and 555,074 luminance samples.
The actual RAW→prepared chroma+luminance chain matches 832,611 channel values
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

The implementation uses bounded tiles (192-pixel output, 32-pixel halo) and Rayon
strips. It has no Adobe runtime dependency and uses portable Rust `f32::mul_add`
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

## Remaining work

Full Fuji distortion/vignetting are integrated and composed RAW-to-vignette checks match
both X-E5 and X100VI captures. Sony's optional profile-enabled route selects an
external LCP; LCP discovery/interpolation is not implemented, and embedded Sony
distortion is not substituted for it. User sharpening and other ACR controls
outside the documented NR/tone controls are not implemented. Broader
full-image, camera/settings and Display P3 runtime captures remain useful;
exact captured boundaries do not establish complete ACR parity.
