# Validation and calibration

Correctness has two levels:

1. **Decoder**: must match Apple's decoded mosaic exactly. This is a hard pass/fail.
2. **Rendering**: should be close to Apple's render, measured in CIEDE2000 (ΔE00). Roughly,
   below 1 is invisible, below 2 is hard to see side by side, and above 3–5 is noticeable.

## The Apple reference tool (macOS only)

`tools/apple-reference/apple-reference.m` runs CIRAWFilter (the public front end of
RawCamera) on one file and writes everything we compare against:

| File | Content |
|---|---|
| `params.json` | CIRAWFilter properties: neutral temp/tint, baselineExposure, NR and sharpness defaults, lens support, orientation, size |
| `graph.txt` | the Core Image render graph (`CI_PRINT_TREE=1`), with every kernel's parameters; the source of the profile's `[[noise]]` tables |
| `cfa.u16`, `cfa.json` | RawCamera's decoded mosaic, full readout, little-endian `u16` |
| `default.lin.{q,crop}.f32` | scene-linear P3 at the `linearSpaceFilter` hook (after colour and exposure, before the look) |
| `nonr.lin.*.f32` | the same with NR and sharpening off |
| `nolens.lin.*.f32` | the same with lens correction off |
| `final.{q,crop}.f32` | final render, encoded P3, orientation applied |

`.q` is a 4× box downscale of the whole frame; `.crop` is the full-resolution 1024×1024
centre. `.f32` files have a 16-byte header `"RDF32\0\0\0"`, then `u32` width, `u32` height,
then interleaved RGB `f32` little-endian, top row first.

How the captures work:

- **`cfa.u16`**: the tool swizzles `-[CIImage initWithImageProvider:width:height:format:colorSpace:options:]`
  to catch the image whose `kCIImageProviderName` is `CRawImage`, then renders it with
  nearest sampling and no colour management.
- **Linear captures**: `linearSpaceFilter` is a pass-through `CIFilter`. CIRAWFilter clears
  `inputImage` after reading `outputImage`, so the tool records the image inside
  `outputImage`.
- **`graph.txt`**: the tool re-executes itself with `CI_PRINT_TREE=1`, because the graph is
  printed to stderr at render time.

Build and run:

```bash
bun run apple-reference
for f in ~/raw-develop-fixtures/*.RAF; do target/apple-reference "$f" ~/raw-develop-refs/$(basename "$f" .RAF); done
```

It never runs in CI. It executes Apple's code locally; nothing from it is committed.

## Tests

```bash
cargo test                                          # unit tests; no RAW files needed
RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures RAW_DEVELOP_REFS=~/raw-develop-refs \
  cargo test --release --test fixtures -- --nocapture
```

- `decoder_is_bit_exact_with_rawcamera`: our mosaic equals `cfa.u16` for every fixture.
- `final_render_close_to_apple`: mean absolute encoded difference against `final.q.f32` is
  below 0.006 on every fixture (observed maximum 0.0032). Use `raw-compare` for ΔE00.

The fixture tests print `skipped` when the variables are unset, so CI and other machines
pass without RAW files.

## Measuring a render

```bash
target/release/raw-develop develop F.RAF /tmp/o.jpg --dump-linear /tmp/o.lin.f32 --dump-final /tmp/o.final.f32
target/release/raw-compare linear /tmp/o.lin.f32   ~/raw-develop-refs/F/default.lin.q.f32
target/release/raw-compare final  /tmp/o.final.f32 ~/raw-develop-refs/F/final.q.f32
```

`raw-compare` box-downscales the larger image to match the other and skips a 2% border. It
prints mean, median and p95 ΔE00 plus the mean linear difference per channel (a quick check
for exposure or white-balance bias).

Compare `linear` to isolate everything before the look (decode, demosaic, NR, lens,
highlights, colour, exposure). Compare `final` for the whole pipeline. Comparing
`nonr.lin` with `--settings` that disable NR and sharpening
(`{"luma_noise_reduction": 0, "chroma_noise_reduction": 0, "sharpening": 0}`) isolates
demosaic.

### Separating colour from texture

ΔE on a quarter-scale image still includes demosaic and NR texture. Blurring both images
(Gaussian σ = 2 px) before computing ΔE00 measures colour and tone only. If the blurred error
is low but the plain error is high, the difference is detail (demosaic, NR, sharpening), not
colour science.

Other useful diagnostics (one-off Python, see `tools/calibrate/fit.py` for loaders):

- **Ratio by radius** (ours/Apple, by distance from centre): reveals vignetting or
  distortion mismatches. This is how we found that Apple does not apply vignetting.
- **Error by lightness, chroma and hue band**: reveals exposure or look-matrix problems.
- **Luma and chroma power spectra** on the `.crop` images: reveal over- or under-sharpening
  and NR strength.
- **Error heatmaps**: error concentrated on edges means texture/demosaic; error in smooth
  areas means colour or tone.

## Refitting a profile

Scripts in `tools/calibrate/` (Python 3 with numpy and scipy). See its README. They read
fixture metadata with exiftool and the profile from `RAW_DEVELOP_PROFILE`. Order:

1. `fit_color.py`: joint least squares, over smooth unclipped blocks of every fixture, of
   `baseline_exposure` and the two white-preserving look matrices. It maps Apple's decoded
   mosaic (block means), through our DNG forward matrices, to Apple's linear capture. It
   reports the median relative error per fixture; about 0.3–2% is good, and above 4% points
   at a WB or clipping problem in that file.
2. `fit_distortion.py <stem>`: compares the Fuji curve, the Fuji curve × scale, and a free
   curve against the `nolens` → `default` warp. Copy the `fuji*scale` value.

The look after the linear capture is a port, not a fit, so `fit_tone.py` is no longer used.
The `[[noise]]` tables are transcribed from `graph.txt`, not fitted (see
[adding a camera](adding-a-camera.md#8-transcribe-the-noise-tables)).

Fitting against Apple's own data at a stage boundary (mosaic → linear) keeps the stages
independent: an error in our demosaic cannot leak into the colour fit.

After editing a profile: run `cargo test`, run the fixture tests, run `raw-compare` across
all fixtures, and bump `PIPELINE_VERSION`.

## Current results

X-E5, 11 fixtures, `raw-compare final` (quarter scale), `PIPELINE_VERSION` 2:

| Fixture | ISO | Notes | ΔE00 mean | p95 |
|---|---|---|---|---|
| DSCF0686 | 64 | tungsten, DR (+0.28 bias) | 0.11 | 0.21 |
| DSCF0867 | 125 | 15 mm | 0.14 | 0.22 |
| DSCF0945-2 | 125 | 15 mm, highlights | 0.11 | 0.22 |
| DSCF0970 | 125 | 23 mm, portrait orientation | 0.27 | 0.89 |
| DSCF0604 | 125 | foliage/water texture | 0.41 | 1.47 |
| DSCF0711 | 125 | almost fully clipped | 0.00 | 0.00 |
| DSCF0928 | 640 | 15 mm, highlights | 0.10 | 0.20 |
| DSCF0672 | 1600 | tungsten | 0.18 | 0.52 |
| DSCF1073 | 3200 | warm, saturated | 0.10 | 0.24 |
| DSCF0229 | 10000 | | 0.38 | 1.12 |
| DSCF1093 | 12800 | | 0.13 | 0.54 |

Every fixture is at most 0.41 mean, below visibility. The decoder is bit-exact on all of
them.

### Remaining differences

The largest residuals are fine texture in the busiest frames (DSCF0604, DSCF0229). The ported
kernels run in `f32` on the CPU, while Apple renders on the GPU in half-float tiles
(`RGBAh`/`Rh`), and `exposureFactor` and the colour/lens fits are approximations, so small
per-pixel differences remain.

X100VI, `raw-compare final` (quarter scale), profile noise table from ISO-patched graphs:

| Fixture | ISO | Notes | ΔE00 mean | p95 |
|---|---|---|---|---|
| DSCF0008 | 500 | portrait orientation | 0.43 | 0.95 |
| DSCF0008, ISO tag patched | 12800 | exercises `smoothDSharpenAntiBloom` | 0.46 | 0.98 |
