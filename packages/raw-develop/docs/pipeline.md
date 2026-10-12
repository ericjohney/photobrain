# Pipeline

`pipeline::develop` (in `src/pipeline.rs`) runs these stages in order. Each one names the
Apple RawCamera node it corresponds to (see [apple-reference.md](apple-reference.md)).
Stages marked *port* are translations of RawCamera's Core Image kernels; their module docs
name the kernels.

| # | Stage | Code | RawCamera node |
|---|---|---|---|
| 1 | linearise + white-balance inputs | `pipeline.rs` | `deXtrans_v8` inputs |
| 2 | demosaic + crop | `stages/dextrans.rs` (*port*), `stages/demosaic.rs` | `deXtrans_v8`, `crop` |
| 3 | chroma NR + luma pyramid, gathered | `stages/chroma_nr.rs`, `stages/luma.rs` (*ports*) | `powerBlur*`, luma pyramid, `YAndRGBGather` |
| 4 | lens (distortion, bicubic) | `stages/lens.rs` | `radialLens` |
| 5 | highlight recovery | `stages/highlights.rs` (*port*) | `RAWRecoverHighlightsV2` |
| 6 | camera → linear Display P3 + exposure | `pipeline.rs`, `profile.rs` | `color_matrix` nodes |
| 7 | hue magnet, gamut map, boost | `stages/look.rs` (*port*) | `RAWHueMagnetMR`, `gmKernel_v7`, `boost_v7` |
| 8 | sRGB transfer | `math::srgb_encode` | `tagcolorspace DisplayP3` |
| 9 | orientation / rotate / crop | `image.rs` | `affine` |

Data layout between stages: an interleaved `f32` RGB image (`image::RgbImage`), top row
first, in sensor orientation until the last stage. Values are linear and unclamped until the
look, so highlights above 1.0 and small negative values survive the intermediate stages.

## 0. Decode (once per file)

`Negative::open` parses the RAF (`raf::parse`) and unpacks the sensor data
(`unpack::unpack`) into a `u16` mosaic covering the full sensor readout. On the X-E5
that is 7872×5196, including masked borders. This is the expensive, settings-independent
part (about 0.1 s). Keep the `Negative` and call `develop` again for each edit.

See [raf-format.md](raf-format.md).

## 1. Linearise and white balance (`deXtrans_v8` inputs)

```text
value = (raw - black[row % 6][col % 6]) / (white_level - black) × wb[channel]
```

- `black` comes from FujiIFD tag `0xf00a`: 36 values, one per position in the 6×6 X-Trans
  repeat (all 1023 on the X-E5).
- `white_level` comes from the camera profile. It is not the 14-bit maximum (16383): the
  X-E5 renders treat 16220 as clipping.
- `wb` is `[G/R, 1, G/B]` from `WB_GRBLevels` (FujiIFD `0xf00e`) when shooting as-shot, or
  is derived from a temperature/tint setting through the profile's colour matrices (see
  [color.md](color.md#white-balance)).

After this step, a white object has value 1.0 in all three channels, and each channel clips
at a different level (`wb[c]`). Highlight recovery uses that.

This balanced float mosaic feeds the Preview and fallback demosaics. The full-quality
`deXtrans_v8` port reads the raw `u16` mosaic instead and takes the same black level,
`range = 65535 / (white − black)` and WB factors as kernel parameters, exactly as
RawCamera does.

## 2. Demosaic and crop (`deXtrans_v8`)

X-Trans uses a 6×6 pattern. Every row and column contains all three colours, and every 3×3
cell contains 5 green, 2 red and 2 blue photosites.

- **`Quality::Full`, profile with `[[noise]]`**: `stages/dextrans.rs`, a port of
  `deXtrans_v8`. For each output pixel it reads a 7×7 neighbourhood of the raw mosaic,
  scores four interpolation directions and blends the best two, computes a sharp
  direction-aware estimate and a smooth isotropic one, and mixes them by local
  signal-to-noise against the camera noise model `rn` (the profile's per-ISO
  `demosaic_noise`). Red and blue come from a soft colour estimate plus the green
  Laplacian. It runs on the full readout with the kernel's periodic (one-tile) edge
  extension, outputs unbalanced camera RGB with white at 1.0, and the pipeline then applies
  WB. `exposureFactor`, which only gates the noise mixer in deep shadows, is
  `2^(1.0146 + 0.452·(−RawExposureBias − 0.5))`, a fit to the values in Apple's graphs.
  See [noise-reduction.md](noise-reduction.md#demosaic-noise-model).
- **`Quality::Preview`**: `demosaic::binned` averages each aligned 3×3 cell into one
  pixel. This gives exact colour at one third of the resolution. The crop origin is snapped
  to a multiple of 3 so that every cell keeps the 5/2/2 composition.
- **Fallback** (`Full` with no noise table for the camera): `demosaic::full` (edge-directed
  green, colour-difference R/B) plus `refine_luma_chroma`.

Only the active area (`RawImageCropTopLeft` / `RawImageCroppedSize`, 7728×5152 at (21, 12)
on the X-E5) is output.

## 3. Noise reduction and sharpening (`powerBlur*`, luma pyramid, `YAndRGBGather`)

In white-balanced camera space. With `Quality::Full` and a `[[noise]]` table, this is
RawCamera's own scheme (details in [noise-reduction.md](noise-reduction.md)):

- **Chroma** (`stages/chroma_nr.rs`): `extractHRGB` (or `extractHRGBHF` with moiré
  detection at low ISO) to half resolution, a chain of selective-average `powerBlur`
  passes at tap spacings 1, 3, 7 and 14, then `expandHRGB` back to full resolution.
- **Luma** (`stages/luma.rs`): a 5-level Laplacian pyramid of luminance, rebuilt coarse to
  fine with noise coring under a structure mask. The full-resolution level also adds
  directional sharpening (`thru_g3`), or at ISO 64/160 a simpler sharpened level
  (`thru_g2`). Sharpening therefore happens here.
- **Gather** (`YAndRGBGather`): each pixel keeps the filtered chromaticity and takes the
  processed luminance, except near sensor clipping where the original luminance is kept.

The amounts come from the settings: `chroma_noise_reduction` (default 0.5) scales the chroma
thresholds linearly by `amount / 0.5`; `luma_noise_reduction` defaults to RawCamera's value
for the ISO; `sharpening` multiplies the pyramid's sharpening gains.

With `Quality::Preview`, or for a profile without a noise table, `stages/detail.rs` is used
instead: an ISO-scaled luma NR (`default_luma_nr`) and, after stage 6, an unsharp mask on
luma. Preview still runs the chroma pass chain when the profile has one.

## 4. Lens correction (`radialLens`)

`stages/lens.rs`. Corrections come from the RAF's own FujiIFD arrays:

| Array | Tag | Use |
|---|---|---|
| `GeometricDistortionParams` | `0xf00b` | radial distortion, % displacement at 9 radii |
| `ChromaticAberrationParams` | `0xf00f` | red and blue radial scale offsets |
| `VignettingParams` | `0xf010` | relative illumination (%) at 9 radii |

Each array has the form `[norm, r₁…r₉, v₁…v₉ (…v for blue)]`. The radii are fractions of the
half-diagonal. An output pixel at radius r samples the source at:

```text
r × (1 + distortion(max(r, r₁))/100) × distortion_fill_scale × (1 + ca(r) for red/blue)
```

- **Distortion only by default.** Apple's graph has `radialLens`, never the per-channel
  `radialLensRB`, so `lens.chromatic_aberration` and `lens.vignetting` default to false.
  Both remain available as edits. Turning vignetting on makes corners 40–50% brighter than
  Apple's.
- **Resampling** is `radialLens`'s separable Catmull-Rom bicubic (a = −0.5), clamped at the
  edges. Apple evaluates it with nine bilinear taps; the code uses the direct form.
- The distortion scale is held constant inside the first knot, like Apple's 51-entry radial
  table.
- `distortion_fill_scale` (1.0101 on the X-E5) is a fitted zoom factor. It equals the ratio
  in Apple's own table (1.01014).
- Lenses that report all-zero distortion (for example the XF 15 mm on these files) skip the
  stage, which matches Apple: its graph has no `radialLens` node for those files.

## 5. Highlight recovery (`RAWRecoverHighlightsV2`)

`stages/highlights.rs`, a port of the kernel. It works in balanced units with thresholds
`[wb.r, 0.9, wb.b]` (green counts as clipped from 0.9 so that demosaic-softened clip edges
are included). Per pixel:

1. Clamp each channel to its threshold.
2. As red or green approach clipping (from 80% of the threshold), blend towards a
   reconstruction from the other channels, so a clipped channel rises consistently instead
   of turning magenta.
3. As the minimum channel climbs from the green threshold to the lower of the red/blue
   thresholds, desaturate towards the channel mean, so blown areas render white.

## 6. Camera RGB to scene-linear Display P3, and exposure (Apple's `color_matrix` nodes)

```text
p3 = (look_matrix(T) · XYZ_D50→P3 · forward_matrix(T) · balanced_camera_rgb − black_render)
     × 2^(baseline_exposure − RawExposureBias + user_exposure)
```

See [color.md](color.md) for each term. `T` is the colour temperature of the white
balance, used to interpolate the two-illuminant matrices.

If `Options::keep_linear` is set, a copy of the image is saved here as `Developed::linear`
(after the `detail.rs` sharpening, when that path is used). It corresponds to the image at
Apple's `linearSpaceFilter` hook, which makes it useful for validation and as the input to
future scene-referred edits.

## 7. Look (`RAWHueMagnetMR`, `gmKernel_v7`, `boost_v7`)

`stages/look.rs`, ports of the three kernels, in order:

1. **Hue magnet** (`amt` 0.03): nudges orange hues (r > b > g) towards red.
2. **Gamut map**: compresses colours towards a luminance anchor so every component lands in
   0–1, with extra desaturation for saturated blues/magentas and a push that keeps bright
   yellows yellow.
3. **Boost**: a piecewise-cubic tone curve per channel, partly re-mixed to the input's hue.
   Its coefficients are fixed (`look::Boost::default`); they were identical on every
   observed file.

The output is still linear. `tone_amount < 1` blends it with the clamped linear input.

## 8. Transfer

The sRGB transfer function encodes the result to Display P3 values, clamped to 0–1.

## 9. Geometry

The EXIF orientation is combined with the user's extra quarter turns
(`rotate_orientation`), applied, and then the optional normalised crop is taken in display
coordinates.

## Output

`encode::write` / `encode::encode` writes:

- PNG (16- or 8-bit) with an `iCCP` chunk, or
- JPEG with an `ICC_PROFILE` APP2 segment.

The profile is a compact ICC v4 Display P3 profile generated in code
(`encode::display_p3_icc`: D50-adapted primaries, parametric sRGB curve).

## Performance notes

- Every stage runs in parallel over rows with rayon. A full develop takes about 2.5 s at
  40 MP on Apple Silicon; most of it is the ported demosaic and the noise-reduction
  pyramid. Preview takes about 0.12 s.
- Peak memory is roughly the u16 mosaic plus several full-size f32 buffers (RGB image,
  luma pyramid planes and direction fields).
- Each stage reads a bounded neighbourhood, which leaves room for a tiled/GPU backend
  later. Today the stages run whole-image on the CPU, without a tile scheduler.
