# Reference: Apple's RawCamera pipeline

What we observed in Preview and CIRAWFilter on macOS 26.5.1 (RawCamera 9.42.0,
decoder version 8) for Fujifilm X-E5 RAFs, and how each part maps onto this crate. It is
recorded so future work can tell what is measured from what is guessed. Sony ARW and Apple
ProRAW DNG are summarised in [Other formats](#other-formats); the graphs are described in
detail in [plan-other-cameras.md](plan-other-cameras.md#2-what-apple-does-for-each-format-evidence).

Apple's code was executed and inspected locally. Reimplementing RawCamera's methodology is
allowed for this crate: the demosaic, chroma NR, luma pyramid, highlight-recovery and look
stages are ports (translations) of RawCamera's Core Image kernels, and the per-ISO noise
parameters in the profile are read from its render graphs. Colour and forward matrices come
from Adobe DNG Converter; the look/exposure matrices and the distortion fill scale are our
own fits. Raw kernel source dumps and Apple plists are not committed.

## How Preview opens a RAF

1. Preview → ImageIO (`CGImageSourceCreateImageAtIndex`) → `IIOReader_RawCamera` →
   `/System/Library/CoreServices/RawCamera.bundle` (in the dyld shared cache).
2. RawCamera looks up the camera in its built-in plugin archive
   (`RawCameraSupport.bundle/Contents/Resources/PlugIns.assets`, entry `raf.fuji.x-e5.cam`),
   then in a downloadable MobileAsset (`com.apple.MobileAsset.RawCamera.Camera`). A newer
   asset wins: version 5 versus 3 built in on the test machine.
3. The camera plist names the decoder class (`CRawImageFujiBayerBase`, which handles X-Trans
   too) and the per-camera rendering parameters: white level, noise models, colour matrices,
   lens-correction filter, NR curves.
4. Decoding runs on the CPU in Swift (`FujifilmDecoder`, hot functions around
   `0x1b79273f0` / `0x1b7926c98` in the extracted image) on worker threads. The result is a
   `CIImage` from an image provider named `CRawImage` (16-bit, 1024-pixel tiles).
5. Everything after that is a Core Image graph rendered on the GPU (ImageKit →
   `-[CIContext render:toIOSurface:…]`), one requested region at a time.

## The render graph (as printed by `CI_PRINT_TREE`)

Read bottom-up:

| Apple node | Parameters (DSCF0970) | Our stage |
|---|---|---|
| `provider 1:CRawImage L16 tile 1024` | 7872×5196 | `Negative.mosaic` |
| `deXtrans_v8(black, range, phase, size, crop, rn, exposureFactor, factors)` | black 0.01561 = 1023/65535, range 4.31236 = 65535/(16220−1023); `rn` per ISO | `stages/dextrans.rs` (port) |
| `affine [-12 -23]` + `crop 7728×5152` | crop origin and size | crop |
| `extractHRGB`/`extractHRGBHF` → `powerBlur*` ×3–4 → `expandHRGB` | half-resolution chroma NR chain, per-ISO thresholds | `stages/chroma_nr.rs` (port) |
| `extractY`, `gaborToYAndVF`/`gaborToSYAndG`, `reduce`, `expandAndMakeD`, `expandPlusD*`, `gaborToVF`, `smoothVF`, `VFToGDIR`, `DIRToC`, `annealGAndC`/`annealG`, `smoothDSharpen` | luma Laplacian pyramid: NR and sharpening | `stages/luma.rs` (port) |
| `YAndRGBGather` | filtered chroma + processed luma | `chroma_nr::apply` (port) |
| `radialLens(image, map, parms=[3864 2576 0.000215 50])` | centre = half the crop; 1/4644 = 1/half-diagonal; 51-entry radial table; bicubic | `stages/lens.rs` |
| `RAWRecoverHighlightsV2(factors, thresh, invfactors)` | factors = WB multipliers (608/302, 1, 549/302) | `stages/highlights.rs` (port) |
| `color_matrix` (3×3, rows) to Adobe RGB (linear) | camera → linear Adobe RGB at the scene CCT | forward matrix · XYZ→P3 · look matrix |
| `color_matrix` scale k, bias −0.003·k | exposure, k = 2^(−0.5 − RawExposureBias + …) | `black_render`, `baseline_exposure` |
| *`linearSpaceFilter` hook* | scene-linear, extended linear Display P3 | `Developed::linear` |
| `RAWHueMagnetMR(amt=0.03)` | hue tweak (orange towards red) | `look::hue_magnet` (port) |
| `gmKernel_v7(…)` | gamut mapping | `look::gamut_map` (port) |
| `boost_v7(breaks, coeffs…)` | contrast/tone curve (identical on all fixtures) | `look::boost` (port, fixed coefficients) |
| `tagcolorspace DisplayP3`, `affine [0 1 −1 0 …]` | output space, EXIF orientation | encode + orientation |

The CIRAWFilter defaults observed:

- `colorNoiseReductionAmount` 0.5 on every file.
- `luminanceNoiseReductionAmount`: 0 or 0.001 up to ISO 640, 0.03 at 1600, 0.075 at 3200,
  0.12 at 10000, 0.13 at 12800. It equals `1 − parms[2]` of the graph's
  `expandPlusDThruG3` node.
- `sharpnessAmount` 1.0, or about 0.94 at the highest ISOs.
- `lensCorrectionEnabled` true.
- `baselineExposure = −0.5 − RawExposureBias` on every fixture.

## Facts established by measurement

- **Decoder**: our mosaic equals the `CRawImage` provider output exactly (11/11 files).
- **Lens**: Apple applies distortion only. The graph uses `radialLens` and never the
  per-channel `radialLensRB`, and the default render has the same radial brightness profile
  as its `lensCorrectionEnabled = NO` render (within about 1–3%), even though
  `VignettingParams` would brighten corners by 40–50%.
- **Distortion**: the `nolens` → `default` warp equals the Fuji `GeometricDistortionParams`
  curve times a global scale of 1.0101, which equals the ratio in Apple's radial table
  (1.01014). The table is constant inside the first knot, and sampling is Catmull-Rom
  bicubic (a = −0.5).
- **Exposure node**: `bias / scale = −0.003` exactly on all files.
- **Colour**: a DNG ForwardMatrix model plus a white-preserving, 1/T-interpolated 3×3 in
  linear P3 reproduces Apple's linear output to a median relative error of 0.3–2% (4% at ISO
  10000).
- **Look**: `RAWHueMagnetMR` amount, `gmKernel_v7` and `boost_v7` parameters were the same
  on every fixture.
- **Noise**: the `powerBlur*`, pyramid and `deXtrans_v8` `rn` parameters depend only on ISO
  (one set per 1/3 stop). Chroma thresholds scale linearly with
  `colorNoiseReductionAmount / 0.5` (checked at 0.25, 0.5 and 1.0). `exposureFactor` follows
  `2^(1.0146 + 0.452·(−RawExposureBias − 0.5))` (fitted).

## Other formats

**Sony ARW** takes the same "8" path as Fuji with a Bayer demosaic:
`CRawImage L16 → despeckle_v8 → deBayer_v8`, then the same chroma NR, luma pyramid,
`radialLens`, `RAWRecoverHighlightsV2`, `color_matrix` and look nodes. Measured facts:

- **Decoder**: uncompressed, lossless JPEG and cRAW mosaics equal the `CRawImage` provider
  output exactly on every fixture. cRAW codes are expanded through `SonyToneCurve`.
- **White balance** is the plain `WB_RGGBLevels` (0x7313); no SR2 decryption. The highlight
  factors equal R/G and B/G.
- **Crop** is exactly `DefaultCropOrigin`/`DefaultCropSize`.
- **Lens**: `DistortionCorrParams` (0x7037), used only when `DistortionCorrection` (0x7036)
  is 1, as `(1 + d/16384)` at evenly spaced radii normalised to 1 at the half-diagonal
  (matches `RAWRadialLensCorrection`'s `inputScales` to 2e-4). CA and vignetting arrays are
  ignored.
- **Colour and exposure**: the two `color_matrix` nodes give the look matrices,
  `baseline_exposure` and `black_render` exactly (`tools/calibrate/graph_color.py`).
- **Noise**: per ISO, as for Fuji; `deBayer_v8` `exposureFactor` is a constant per body. New
  kernels: `despeckle_v8`, `deBayer_v8`, `powerBlurLFS`, `FGN`/`addFGN`,
  `smoothDSharpenAntiBloom`. ISO-patched graphs need ISO, SOS and REI patched together.

**Apple ProRAW DNG** (LinearRaw) takes the "8.dng" path: an `RGBAh` provider (already
demosaiced), a detail graph (`extractY`, `gaborFiltersToSmoothedLuminanceAndGradient`,
`blurGradient`, `expandAndMakeDetails`, `expandAndAddDetails*`, `powerBlurFS`,
`YAndRGBGather`), `RAWRecoverHighlightsV2` with thresholds `[1, 0.9, 1]`, the DNG colour
matrix, exposure `2^BaselineExposure`, `profileGainTableMap`, `gmKernel_v7` and `boost_lut`.
Measured facts:

- **Decoder**: equal to the provider after rounding to half float.
- **Colour** follows `RAWConvert`, found with REA (`outputMatrix` and the helpers at
  `FUN_1b7829ba4`/`FUN_1b7828be0` in RawCamera) and checked by probing
  `RAWConvert.outputMatrix`: white xy from `AsShotNeutral` by iterating CCT, a forward
  matrix synthesised per calibration illuminant (Bradford to D50, ratios clamped to
  [0.1, 10]), mired-weighted interpolation. Our matrix matches to 2e-3 on 16 files.
- **Detail**: every parameter is a constant or a multiple of the exposure gain (checked on 16
  files, ISO 16–6400), so no per-phone tables are needed.
- **Tone**: `boost_lut` is a 256-entry LUT from `ProfileToneCurve` (end slope continued
  beyond 1, shadow gain 0.9 easing to 1 over 0–0.1).

## Tools used

- REA MCP (Ghidra provider) on `RawCamera` extracted from the dyld shared cache with
  `/usr/lib/dsc_extractor.bundle`: strings, xrefs, decompilation of the Fuji decoder
  functions and the six-pass line decoder.
- `sample`, `vmmap`, `lsof` and `log stream` on a running Preview.
- Swizzling `CIImage` provider initialisation to capture the decoded mosaic.
- Swizzling `+[CIKernel kernelsWithString:messageLog:]` while CIRAWFilter rendered, to
  capture the Core Image kernel source the ported stages translate (a scratch tool, not in
  the repository).
- REA on RawCamera's `RAWConvert` for the DNG colour model.
- `CI_PRINT_TREE=1` for the graph. Note that `dump-inputs` and the other dump options write
  nothing on release builds of macOS.
