# Validation and calibration

Correctness has two levels:

1. **Decoder**: must match Apple's decoded data exactly. This is a hard pass/fail. For RAF
   and ARW that is the `u16` mosaic; for LinearRaw DNG, RawCamera's provider holds half
   floats, so our RGB must equal it after rounding to half float.
2. **Rendering**: should be close to Apple's render, measured in CIEDE2000 (ΔE00). Roughly,
   below 1 is invisible, below 2 is hard to see side by side, and above 3–5 is noticeable.

## The Apple reference tool (macOS only)

`tools/apple-reference/apple-reference.m` runs CIRAWFilter (the public front end of
RawCamera) on one RAF, ARW or DNG file and writes everything we compare against:

| File | Content |
|---|---|
| `params.json` | CIRAWFilter properties: neutral temp/tint, baselineExposure, NR and sharpness defaults, lens support, orientation, size |
| `graph.txt` | the Core Image render graph (`CI_PRINT_TREE=1`), with every kernel's parameters; the source of the profile's `[[noise]]` tables |
| `cfa.u16`, `cfa.json` | RawCamera's decoded mosaic, full readout, little-endian `u16` |
| `cfa.rgb.f32` | DNG LinearRaw only: RawCamera's decoded RGB provider (half floats, written in the `.f32` layout) |
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

`apple-reference FILE --graph OUT.txt` writes only the render graph, which is all a noise
table or `graph_color.py` needs.

Build and run:

```bash
bun run apple-reference
for f in ~/raw-develop-fixtures/*.RAF; do target/apple-reference "$f" ~/raw-develop-refs/$(basename "$f" .RAF); done
for f in ~/raw-develop-fixtures/a7cr/*.ARW; do target/apple-reference "$f" ~/raw-develop-refs/a7cr/$(basename "$f" .ARW); done
```

Fixture directories: X-E5 files at the top level of `~/raw-develop-fixtures`, the others in
`~/raw-develop-fixtures/{x100vi,a1m2,a7cr,a7rm5,iphone16pm,iphone17pm,iphone-more}`, with
references in `~/raw-develop-refs/<same>`.

It never runs in CI. It executes Apple's code locally; nothing from it is committed.

## Tests

```bash
cargo test                                          # unit tests; no RAW files needed
RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures RAW_DEVELOP_REFS=~/raw-develop-refs \
  cargo test --release --test fixtures -- --nocapture
```

The fixture tests accept `*.RAF`, `*.ARW` and `*.DNG`; run them once per fixture directory.

- `decoder_is_bit_exact_with_rawcamera`: our mosaic equals `cfa.u16` for every RAF and ARW
  fixture; for DNG, our RGB equals `cfa.rgb.f32` after rounding to half float.
- `final_render_close_to_apple`: mean absolute encoded difference against `final.q.f32` is
  below 0.006 on every fixture (observed maximum 0.0036). Use `raw-compare` for ΔE00.

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
fixture metadata with exiftool and the profile from `RAW_DEVELOP_PROFILE`.

For Sony, the colour needs no fit: `graph_color.py` derives `look_matrix_1/2`,
`baseline_exposure` and `black_render` exactly from the graph's two `color_matrix` nodes
(graphs at two colour temperatures; the second can come from a copy with `WB_RGGBLevels`
patched). `noise_table.py` transcribes `[[noise]]` tables from graphs (see
[adding a camera](adding-a-camera.md#another-sony-body)). DNG needs no profile.

For Fuji, in order:

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

Sony, `raw-compare final` (quarter scale). Lens correction from `DistortionCorrParams`;
noise tables from ISO-patched graphs; colour from `graph_color.py`:

| Camera | Fixture | ISO | Notes | ΔE00 mean |
|---|---|---|---|---|
| A1 II | 12766 | 125 | APS-C crop, lossless, 70-200 GM II | 0.07 |
| A1 II | 4309 | 100 | uncompressed, 35 GM | 0.05 |
| A1 II | 4309, ISO tags patched | 3200 | | 0.07 |
| A7C R | 6453 | 100 | lossy cRAW | 0.19 |
| A7C R | 13567 | 12800 | | 0.40 |
| A7R V | 13937 | 2000 | uncompressed | 0.21 |

Every decoder (uncompressed, lossless JPEG, cRAW) is bit-exact on every Sony fixture.

Apple ProRAW DNG, `raw-compare final` (quarter scale): mean ΔE00 0.05–0.09 on 16 files from
the iPhone 16 Pro Max (lossless JPEG) and iPhone 17 Pro Max (JPEG XL), ISO 16–6400, wide,
ultra-wide, telephoto and front cameras. The full-resolution centre crop of file 116 is 0.08.
Decode is exact after rounding to half float on every file.

Timings on Apple Silicon: decode 0.03–0.2 s; full develop about 2.0 s for X-Trans 40 MP,
2.4–2.7 s for Sony 61 MP and 0.4 s for iPhone 12 MP. `raw-develop develop … --digest`
prints an FNV-1a fingerprint of the exact output floats for bit-exactness checks across
performance changes.
