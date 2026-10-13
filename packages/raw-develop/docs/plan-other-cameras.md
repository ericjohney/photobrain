# Handoff plan: the other cameras in the production library

Status: phases 0–3 (X100VI, format-neutral core, Sony ARW including lossy cRAW) are done; phase 4 (iPhone ProRAW) is open. The plan was written on 2026-10-12 after
surveying the production library and running the Apple reference tool on samples of
every camera. Read [adding-a-camera.md](adding-a-camera.md),
[pipeline.md](pipeline.md) and [noise-reduction.md](noise-reduction.md) first.

## 1. What is in the library

RAW files by camera, from `GET /api/v1/gear-stats?filterRaw=raw` and
`/api/v1/photos?filterRaw=raw&camera=…`. Formats come from a sweep of 108 file headers
(range requests on `/api/photos/:id/export?size=original`). The sweep is saved at
`~/raw-develop-refs/_library-sweep.txt`.

| Camera | RAW files | Format observed | Done today |
|---|---|---|---|
| Sony ILCE-1M2 (A1 II) | 3,142 | ARW, mostly "Lossless Compressed RAW 2" (tiled lossless JPEG, Compression 7). Full frame is 8664×5784; APS-C crop mode is 5640×3768 (about a quarter of the sampled files). A few files are uncompressed 14-bit. | no |
| Sony ILCE-7CR (A7C R) | 1,646 | ARW, mostly lossless compressed (9568×6376). About 15% are "Sony Compressed RAW" (lossy cRAW, Compression 32767). | no |
| Fujifilm X-E5 | 1,231 | RAF, X-Trans, lossless | **yes** |
| Apple iPhone 17 Pro Max | 699 | DNG 1.7 LinearRaw (Photometric 34892) with **JPEG XL** tiles (Compression 52546), 10-bit, with a LinearizationTable, ProfileGainTableMap, ProfileToneCurve and semantic mattes. 12 MP and 48 MP. | no |
| Apple iPhone 16 Pro Max | 241 | DNG 1.6 LinearRaw, **lossless JPEG** (Compression 7), 10-bit, LinearizationTable. Newer files also have a ProfileGainTableMap. 12 MP and 48 MP. | no |
| Sony ILCE-7RM5 (A7R V) | 6 | ARW, uncompressed 14-bit | no |
| Fujifilm X100VI | 1 | RAF, X-Trans, lossless: same sensor and readout as the X-E5 (7872×5196, crop 21/12) | parses and decodes; no profile |

All Sony bodies are Bayer RGGB (`CFAPattern2 0 1 1 2`, 2×2), 14-bit, black 512,
white 15360. Sony ARWs carry `DistortionCorrParams` / `ChromaticAberrationCorrParams` /
`VignettingCorrParams` (16 knots) in the MakerNote.

## 2. What Apple does for each format (evidence)

`target/apple-reference` runs unchanged on ARW and DNG. References for one or two
files per camera are saved under `~/raw-develop-refs/<camera>/<id>/`, with the source
files under `~/raw-develop-fixtures/<camera>/`.

| Camera dir | Files |
|---|---|
| `x100vi/` | DSCF0008 (ISO 500) |
| `a1m2/` | 12766 (APS-C crop, ISO 125, 70-200 GM II), 4309 (uncompressed, 35 GM) |
| `a7cr/` | 6453 (lossy cRAW, ISO 100), 13567 (ISO 12800) |
| `a7rm5/` | 13937 (uncompressed, ISO 2000) |
| `iphone17pm/` | 116 (JPEG XL) |
| `iphone16pm/` | 12686 (lossless JPEG) |

Kernel sources for every format were captured with the `ksrc` swizzle tool. There are
136 kernels in total, kept outside the repo in `~/raw-develop-refs/_kernel-src/` (`all.txt`
plus the X-Trans session copy). Extract a kernel by name from there.

### Sony ARW: the same RawCamera "8" path as Fuji, with a Bayer demosaic

```
CRawImage L16 → despeckle_v8 → deBayer_v8 → extractY/gaborToYAndVF → luma pyramid
  (expandPlusDThruG / ThruG3, smoothDSharpen[AntiBloom], DIRToC, annealGAndC)
  + chroma NR (extractHRGB[HF] → powerBlur* → expandHRGB) → YAndRGBGather
  → radialLens (when lensCorrectionSupported) → RAWRecoverHighlightsV2
  → color_matrix → exposure color_matrix → RAWHueMagnetMR → gmKernel_v7 → boost_v7
```

- Only the demosaic stage is new: `despeckle_v8` + `deBayer_v8`. Everything after the
  demosaic is a kernel we already ported.
- The look stages are identical to Fuji: hue-magnet `amt=0.03`, and the same `gmKernel_v7`
  and `boost_v7` coefficients.
- New noise-reduction pass variants appear in Sony graphs:
  - `powerBlurLFS`, `powerBlurLHF`, `powerBlurEarlyOutLHFi`, `powerBlurDespeckleL`
  - `extractHRGBHF`
  - `smoothDSharpenAntiBloom`
  - `FGN` / `addFGN` (fine-grain noise added back, seen at A7CR ISO 100)
- `despeckle_v8` takes `amount` and `neighborPrevention`. Both are per ISO: 1.25/0 at
  low ISO, 8.09/1 at ISO 12800.
- `deBayer_v8` takes `black`, `range`, `phase`, `rn`, `exposureFactor` and `factors`,
  the same set as `deXtrans_v8`.
- Lens correction is per lens:
  - `lensCorrectionSupported` was true for the 70-200 GM II, 24-50 G, 35 F2.8 ZA and 35 GM
    on the A7R V, and false for the 35 GM on the A1 II.
  - `radialLens parms=[cx cy 1/r 50]` with a radial map. Where Apple gets that map is
    **not yet known**: it could be the ARW's `DistortionCorrParams` or a lens database
    inside RawCamera. This is the main open question for Sony; resolve it with REA, as
    was done for Fuji (see 4.4).
- Black levels are normalised as `black=0.0078 = 512/65536`; `range=4.129` matches
  `65536/(15360-512)·…`. Check this the same way as the Fuji `Params`.

### iPhone ProRAW DNG: a different path ("8.dng")

```
CRawImage RGBAh (already-demosaiced linear RGB) → extractY → gaborFiltersToSmoothedLuminanceAndGradient
  → blurGradient → reduce×3 / expandAndMakeDetails / expandAndAddDetailsWithOverdrive
  → expandAndAddDetailsThroughGradientMask2 (luma) + powerBlurFS (chroma) → YAndRGBGather
  → RAWRecoverHighlightsV2 (thresh 1/0.9/1, no WB) → DNG colour matrix (via Adobe RGB linear)
  → exposure gain 2^BaselineExposure (37.8× = 2^5.24 on file 116)
  → profileGainTableMap (DNG 1.7 local tone map, mapCounts e.g. 12×12×257)
  → gmKernel_v7 → boost_lut (ProfileToneCurve as a 256-entry LUT, RAWAdjustColorTRC)
```

- There is no demosaic and no hue magnet. `boost_v7` is replaced by `boost_lut` driven by
  the file's `ProfileToneCurve`. Colour, tone and exposure come from **tags in the file**,
  so no per-camera TOML is needed for colour.
- Apple's CIRAWFilter defaults differ for DNG:
  - `localToneMapAmount=1` (this is the gain table map)
  - `contrastAmount=0.1`, `detailAmount=0.5`
  - `luminanceNoiseReductionAmount=0`, `boostShadowAmount=0`
- `apple-reference` captured `cfa.u16` from an **RGBAh** provider as a single u16
  plane. The capture hook must be extended to dump 4×f16 for DNG.

### X100VI

The graph matches the X-E5 kernel for kernel: `deXtrans_v8` (`phase=[3 -3]`),
`extractHRGB`, `powerBlurEarlyOutL`/`powerBlurL`×2, and the same look. RawCamera
reports `lensCorrectionSupported=false` and does not run `radialLens` for this fixed lens.
Only the X-E5's colour data differs. So the X100VI needs only "case A" from
adding-a-camera.

### Tip: noise tables without shooting an ISO sweep

RawCamera picks its noise parameters from the file's ISO tag. Patching a copy with
`exiftool -ISO=N -PhotographicSensitivity=N` and running `apple-reference` gives that ISO's
parameters. Checked against a real X-E5 ISO 800 file (`~/raw-develop-refs/_iso-patch-check/`):

- `params2`, the chroma thresholds, match exactly.
- `rn`, `DIRToC` and `annealGAndC` match within 0.5–1.5%; something else, probably exposure
  bias, enters those values.
- `params[0..2]` are the white-balance factors, so they naturally follow the source file.

Use real files where the library has them (A1 II and A7CR cover ISO 80–12800). Use patching
to fill gaps and for the X100VI. Record which method was used in each profile's provenance
comment.

## 3. Order of work

Ordered by photos covered per unit of effort:

| Phase | Scope | Photos | Size |
|---|---|---|---|
| 0 | X100VI profile (**done**: ΔE00 0.43, `noise_table.py`, `smoothDSharpenAntiBloom`) | 1 | small, and it proves out the "case A" checklist |
| 1 | Format-neutral core and Bayer support (**done**: `metadata::RawMetadata`, `tiff.rs`, `unpack/ljpeg.rs` + tile assembly, 2×2 binning) | — | medium (refactor) |
| 2 | Sony ARW: uncompressed and lossless (**done**: ΔE00 0.05–0.40; see below) | ≈ 4,550 | large |
| 3 | Sony lossy cRAW (**done**: bit-exact, `unpack/sony_craw.rs`) | ≈ 250 | small–medium |
| 4 | iPhone ProRAW DNG | 940 | large (a new pipeline variant) |
| 5 | Integration into `image-processing` | all | separate change; out of scope here |

Each phase ends with:

- `cargo test` green
- fixture tests green for every camera that has references
- `PIPELINE_VERSION` bumped only if X-E5 output changed
- docs updated (`docs/README.md` status list, `AGENTS.md` accuracy table)

## 4. Phase details

### Phase 0: X100VI

1. Get the DNG matrices with Adobe DNG Converter (adding-a-camera step 5), and write
   `profiles/fujifilm-x100vi.toml`. Register it under the key `X100VI`.
2. Distortion: there is no `GeometricDistortionParams` in the file and Apple does no lens
   correction, so leave lens correction off. Confirm the pipeline tolerates a missing lens array.
3. Noise table: build it with the ISO-patch tip on `DSCF0008.RAF`, for every 1/3 stop from
   ISO 125 to 12800 plus the extended 64/80/100/25600/51200 settings. Reuse the X-E5
   transcription parser (adding-a-camera step 8); consider committing it now as
   `tools/calibrate/noise_table.py`, so every later camera uses it.
4. Fit colour (`fit_color.py`). With one real file, also patch the WB/ISO, or ask for a few
   more X100VI shots.

### Phase 1: format-neutral core and Bayer

1. `RafMetadata` → `RawMetadata { make, model, geometry, crop, black (pattern-sized), white,
   wb, cfa, orientation, iso, exposure_bias, lens: Option<LensSource>, container: Raf|Arw|Dng }`.
   `Negative::from_bytes` sniffs the magic: `FUJIFILMCCD-RAW` → raf; TIFF+`SONY` → arw;
   TIFF+`DNGVersion` → dng.
2. The `Negative` payload becomes an enum: `Mosaic { data: Vec<u16>, cfa }` or
   `LinearRgb { data: Vec<f32>/f16, channels }`. The latter is for DNG LinearRaw.
3. `pipeline.rs` indexes black levels with `(row % 6) * 6 + col % 6`. Generalise this to
   the pattern's width and height. `CfaPattern` already has `width`/`height`.
4. Preview demosaic: 2×2 binning for Bayer (half resolution), alongside the 3×3 X-Trans path.
5. Shared TIFF reader: move `raf/tiff.rs` to `src/tiff.rs`. It needs SubIFDs, MakerNote
   offsets, both byte orders and ≥ 4 GB-safe offsets.
6. **Lossless JPEG (LJ92) decoder** in `unpack/ljpeg.rs`, written ourselves. It serves both
   Sony lossless compressed ARW (tiled, 512×512 tiles with 2 or 4 components interleaved)
   and iPhone 16 DNG.
   - Validate it bit-exactly against Apple's `cfa.u16`.
   - Keep the bitreader shared with `fuji_compressed`.

### Phase 2: Sony ARW (uncompressed and lossless)

1. **Container** (`arw/`): IFD0 → SubIFD raw image. Read `SonyRawFileType`, `Compression`,
   `BitsPerSample`, `SonyRawImageSize`/`DefaultCropOrigin`/`DefaultCropSize` and
   `BlackLevel`/`WhiteLevel`.
   - Crop: Apple's native size is 8640×5760 for 8672×5784 full frame and 5616×3744 for
     the APS-C files. Compare against `params.json` `nativeWidth/Height` and the graph's
     `affine [1 0 0 1 -12 -340]` + `crop`.
   - **White balance** is in the encrypted SR2 private block (`SR2Private` → `SR2SubIFD`
     → `WB_RGGBLevels`). Implement Sony's SR2 decryption: a documented key-stream cipher.
     Compare against `exiftool -WB_RGGBLevels` and against the graph's `factors=`.
2. **Unpack**:
   - uncompressed: 14-bit little-endian in u16
   - lossless: tiled LJ92 (Phase 1)
   - Gated test: bit-exact against `cfa.u16` for all Sony fixtures.
3. **Demosaic**: port `despeckle_v8` and `deBayer_v8` into `stages/debayer.rs`, the same
   way `dextrans.rs` was done (`/tmp/rawtrace/gen/glsl2rs.py`-style mechanical
   translation; the generator may need to be rewritten if `/tmp` was cleared).
   - The profile gets per-ISO `despeckle_amount` and `neighbor_prevention`.
   - Unit test: flat grey → flat grey.
   - Fixture: compare the demosaiced linear output against `nonr.lin.*`.
4. **Noise reduction**:
   - Extend `PassKind` with the new kinds: `LFS`, `LHF`, `LHFi`, `DespeckleL`, the
     `EarlyOut`/`EarlyOut2` HF variants, and `FS` for DNG later. Port each kernel from
     `_kernel-src`.
   - Add `smoothDSharpenAntiBloom` to `luma.rs`.
   - Add `FGN`/`addFGN` as an optional profile field. Check whether Apple adds grain at the
     default amounts or only at low NR (it appeared in the A7CR ISO 100 graph, whose
     `luminanceNoiseReductionAmount` was 0.001).
   - Transcribe `[[noise]]` tables per body from real library files at each ISO, and fill
     gaps with the ISO-patch tip.
5. **Colour**: one profile per body (`sony-ilce-1m2.toml`, `sony-ilce-7cr.toml`,
   `sony-ilce-7rm5.toml`). Matrices come from DNG Converter. Fit the look matrices and
   exposure with `fit_color.py`, which needs Bayer-aware reading of geometry/WB. Apple's
   `baselineExposure` is 0.35 for the A1 II and 0.40 for the A7CR/A7R V, against 0.22 for
   the X100VI.
6. **Lens** (open question):
   - Use REA to find where RawCamera builds the `radialLens` map for Sony (search
     `DistortionCorrParams` / `0x7032`-area tags and the lens-ID tables). Also find what
     sets `lensCorrectionSupported`.
   - Then add an `arw::lens` parser that yields the existing `LensCorrection`.
   - Until it is solved, run without lens correction and keep `nolens.lin.*` as the
     comparison point.
7. **Validation targets**: same as the X-E5 (mean ΔE00 ≤ 0.5 per fixture). Fixture set per
   body: base ISO, 800–1600, 6400+, clipped highlights, tungsten, each lens, and the A1 II
   APS-C crop and 2× teleconverter files.

#### Phase 2 results and answers to the open questions

- **White balance** is plain `WB_RGGBLevels` (0x7313) in the raw SubIFD; no SR2
  decryption needed. RawCamera's highlight factors equal R/G and B/G exactly.
- **Lens**: RawCamera uses `DistortionCorrParams` (0x7037) only when
  `DistortionCorrection` (0x7036) is 1, as `(1 + d/16384)` at n evenly spaced radii
  normalised to 1 at the half-diagonal (checked against `RAWRadialLensCorrection`'s
  `inputScales`, max error 2e-4). CA and vignetting arrays are ignored.
- **Colour and exposure** are read exactly from the graph's two `color_matrix` nodes
  (`tools/calibrate/graph_color.py`); a second colour temperature comes from patching
  `WB_RGGBLevels` in a copy.
- **Noise tables**: the ISO-patch method needs ISO, SOS and REI patched together on Sony.
- **New kernels**: `despeckle_v8`, `deBayer_v8`, `powerBlurLFS` (fused chroma NR),
  `FGN`/`addFGN` (fine-grain noise), `smoothDSharpenAntiBloom`.
- Results (quarter-scale final, mean ΔE00): A1 II 0.07 / 0.05 (and 0.07 at a patched
  ISO 3200), A7C R ISO 12800 0.40, A7R V 0.21. Decoders bit-exact.

### Phase 3: Sony lossy cRAW (Compression 32767)

Each 32-pixel block of a row stores a max, a min, two 4-bit indices and fourteen 7-bit
deltas, followed by a tone-curve expansion from `SonyToneCurve`. Write our own decoder,
validate it bit-exactly against `~/raw-develop-refs/a7cr/6453/cfa.u16`, and use REA on
RawCamera if it doesn't match. Everything else reuses Phase 2.

### Phase 4: iPhone ProRAW DNG

1. **Decode**:
   - Read the DNG raw IFD: tiles, `LinearizationTable`, `BlackLevel`/`WhiteLevel`,
     `DefaultCrop*`, `ActiveArea`.
   - Lossless JPEG via the Phase 1 decoder.
   - **JPEG XL**: use `jxl-oxide` (MIT/Apache) behind a cargo feature, or write our own if
     a dependency is unwanted. Validate it against a 4×f16 `CRawImage RGBAh` dump; first
     extend `apple-reference`'s provider hook to write RGBA half floats.
   - Skip the semantic-matte and depth SubIFDs (`SubfileType 65540`).
2. **DNG colour from tags** (`dng/color.rs`):
   - `ColorMatrix1/2`, `ForwardMatrix1/2`, `CalibrationIlluminant1/2`, `AsShotNeutral`,
     `BaselineExposure` (plus `BaselineExposureOffset`) and `DefaultBlackRender`.
   - Apple routes through "Adobe RGB (1998) Linearized"; our existing XYZ→P3 maths is the
     equivalent. No per-camera profile: the profile becomes optional and the camera
     `DngProfile` is built from tags.
3. **Kernels to port** (all in `_kernel-src`):
   - `gaborFiltersToSmoothedLuminanceAndGradient`, `blurGradient`
   - `expandAndMakeDetails`, `expandAndAddDetailsWithOverdrive`,
     `expandAndAddDetailsThroughGradientMask2`
   - `powerBlurFS`
   - `profileGainTableMap`: the DNG 1.7 GainTableMap. Parse the binary tag and implement it
     per the DNG 1.7 specification as well as the kernel.
   - `boost_lut`, with the LUT built from `ProfileToneCurve`. Look at `RAWAdjustColorTRC`
     to see how the 256-entry curve is made.
   - Parameters such as `thresh`, `neutralFactors`, `lumfactors` and `lothreshold/factor`
     appear to be derived from `NoiseProfile`, ISO and `BaselineExposure`. Collect graphs
     across 10+ iPhone files (12 MP and 48 MP, ISO 16–6400, both phones) and fit or derive
     the formulas, the same way `exposureFactor` was fitted for Fuji.
4. **Pipeline variant**: `pipeline::develop` branches on the payload type. The LinearRgb
   path skips linearise/WB/demosaic/lens and swaps the look (no hue magnet;
   `boost_lut` + gain map). Keep it a separate function, not flags.
5. **Settings defaults**: DNG defaults differ (local tone map 1, contrast 0.1, detail 0.5,
   luma NR 0). Make `DevelopSettings::default_for(&neg)`.
6. **Validation**: as for Sony, plus visual checks of the local tone map on high-dynamic-range
   scenes.

## 5. Fixture collection

```bash
API=https://photobrain-api.ericj5.com
# ids and metadata for one camera
curl -s -G "$API/api/v1/photos" --data-urlencode filterRaw=raw \
  --data-urlencode "camera=SONY ILCE-1M2" --data-urlencode limit=5000 > a1m2.json
# originals (the file route serves a WebP for RAWs; export=original gives the bytes)
curl -sf "$API/api/photos/<id>/export?size=original" -o ~/raw-develop-fixtures/a1m2/<id>.ARW
# headers only (cheap format survey)
curl -s -r 0-262143 "$API/api/photos/<id>/export?size=original" -o hdr.bin && exiftool -n hdr.bin
```

Pick 8–12 files per body spanning ISO, lens, light, clipping and compression type (sort
by `exif.iso`, `exif.lensModel` and `size`). Files are 25–135 MB for Sony and 3–95 MB for
iPhone, so budget about 3 GB of fixtures and about 300 MB of references per Sony file.
Keep everything outside the repository.

## 6. Risks and open questions

- **Sony lens map source** (Phase 2.6) is unknown. Without it, Sony renders will differ at
  the edges on the zooms. The 70-200 GM II's `DistortionCorrParams` show up to about 2%
  barrel distortion.
- **Sony WB encryption**: implementing it is required unless the WB is also stored in
  plain text somewhere. Check with REA what RawCamera reads.
- **DNG parameter derivation**: if the noise and gain-map parameters cannot be derived from
  tags, the DNG path needs per-phone tables, like Fuji. Find out early in Phase 4.
- **Memory and time**: the A7CR/A7R V are 61 MP, about 1.5× the X-E5. The current full
  develop takes 2.5 s for 40 MP, so expect about 4 s. GPU work stays out of scope.
- **RawCamera version drift**: all references were taken on macOS 26.5.1 (RawCamera
  decoder "8"). Record the version in every profile's provenance comment.
