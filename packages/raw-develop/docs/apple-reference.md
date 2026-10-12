# Reference: Apple's RawCamera pipeline

What we observed in Preview and CIRAWFilter on macOS 26.5.1 (RawCamera 9.42.0,
decoder version 8) for Fujifilm X-E5 RAFs, and how each part maps onto this crate. It is
recorded so future work can tell what is measured from what is guessed.

Apple's code and data were executed and inspected locally. None of it is copied into the
repository. Our implementation is written independently and validated against outputs.

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
| `deXtrans_v8(black, range, phase, rn, exposureFactor, factors)` | black 0.01561 = 1023/65535, range 4.31236 = 65535/(16220−1023) | linearise + WB + demosaic |
| `affine [-12 -23]` + `crop 7728×5152` | crop origin and size | crop |
| `extractY`, `gaborToYAndVF`, `reduce`/`expand…`, `smoothDSharpen`, `annealGAndC`, `YAndRGBGather`, `powerBlur*` | pyramid luma/chroma detail reconstruction and chroma NR | `refine_luma_chroma`, `stages/detail.rs` |
| `radialLens(image, map, parms=[3864 2576 0.000215 50])` | centre = half the crop; 1/4644 = 1/half-diagonal | `stages/lens.rs` |
| `RAWRecoverHighlightsV2(factors, thresh, invfactors)` | factors = WB multipliers (608/302, 1, 549/302) | `stages/highlights.rs` |
| `color_matrix` (3×3, rows) to Adobe RGB (linear) | camera → linear Adobe RGB at the scene CCT | forward matrix · XYZ→P3 · look matrix |
| `color_matrix` scale k, bias −0.003·k | exposure, k = 2^(−0.5 − RawExposureBias + …) | `black_render`, `baseline_exposure` |
| *`linearSpaceFilter` hook* | scene-linear, extended linear Display P3 | `Developed::linear` |
| `RAWHueMagnetMR(amt=0.03)` | per-camera hue tweak (magenta–red) | absorbed into the look matrix and tone fit |
| `gmKernel_v7(…)` | gamut mapping | `look::compress_gamut` |
| `boost_v7(breaks, coeffs…)` | contrast/tone curve (identical on all fixtures) | profile `tone_curve` |
| `tagcolorspace DisplayP3`, `affine [0 1 −1 0 …]` | output space, EXIF orientation | encode + orientation |

The CIRAWFilter defaults observed:

- `colorNoiseReductionAmount` 0.5 on every file.
- `luminanceNoiseReductionAmount`: 0 or 0.001 up to ISO 640, 0.03 at 1600, 0.075 at 3200,
  0.12 at 10000, 0.13 at 12800.
- `sharpnessAmount` 1.0, or about 0.94 at the highest ISOs.
- `lensCorrectionEnabled` true.
- `baselineExposure = −0.5 − RawExposureBias` on every fixture.

## Facts established by measurement

- **Decoder**: our mosaic equals the `CRawImage` provider output exactly (11/11 files).
- **Vignetting**: Apple's default render has the same radial brightness profile as its
  `lensCorrectionEnabled = NO` render (within about 1–3%), even though `VignettingParams`
  would brighten corners by 40–50%. Vignetting is therefore not applied in the default render.
- **Distortion**: the `nolens` → `default` warp equals the Fuji `GeometricDistortionParams`
  curve times a global scale of 1.0100–1.0101 (fitted on two files, residual close to free-fit
  quality).
- **Exposure node**: `bias / scale = −0.003` exactly on all files.
- **Colour**: a DNG ForwardMatrix model plus a white-preserving, 1/T-interpolated 3×3 in
  linear P3 reproduces Apple's linear output to a median relative error of 0.3–2% (4% at ISO
  10000).
- **Tone**: a single per-channel curve from linear P3 to the final render fits all fixtures
  with a mean encoded error of 0.003.

## Tools used

- REA MCP (Ghidra provider) on `RawCamera` extracted from the dyld shared cache with
  `/usr/lib/dsc_extractor.bundle`: strings, xrefs, decompilation of the Fuji decoder
  functions and the six-pass line decoder.
- `sample`, `vmmap`, `lsof` and `log stream` on a running Preview.
- Swizzling `CIImage` provider initialisation to capture the decoded mosaic.
- `CI_PRINT_TREE=1` for the graph. Note that `dump-inputs` and the other dump options write
  nothing on release builds of macOS.
