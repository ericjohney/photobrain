# Pipeline

`pipeline::develop` (in `src/pipeline.rs`) runs these stages in order. Each one names the
Apple RawCamera node it corresponds to (see [apple-reference.md](apple-reference.md)).

Data layout between stages: an interleaved `f32` RGB image (`image::RgbImage`), top row
first, in sensor orientation until the last stage. Values are linear and unclamped until the
tone curve, so highlights above 1.0 and small negative values survive the intermediate
stages.

## 0. Decode (once per file)

`Negative::open` parses the RAF (`raf::parse`) and unpacks the sensor data
(`unpack::unpack`) into a `u16` mosaic covering the full sensor readout. On the X-E5
that is 7872×5196, including masked borders. This is the expensive, settings-independent
part (about 0.1 s). Keep the `Negative` and call `develop` again for each edit.

See [raf-format.md](raf-format.md).

## 1. Linearise and white balance (`deXtrans_v8` inputs)

For each photosite in the active area:

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

## 2. Demosaic (`deXtrans_v8` plus Apple's pyramid detail nodes)

`stages/demosaic.rs`. X-Trans uses a 6×6 pattern. Every row and column contains all three
colours, and every 3×3 cell contains 5 green, 2 red and 2 blue photosites.

- **`full`**:
  1. Green is interpolated at red/blue sites along whichever of the four axes (horizontal,
     vertical, two diagonals) have green on both sides. Each estimate is weighted by the
     inverse squared gradient, so interpolation follows edges.
  2. Red and blue are filled by colour-difference interpolation: (R−G) and (B−G) are smooth,
     so they are averaged over a 5×5 window weighted by distance and by green similarity.
- **`refine_luma_chroma`**: smooths chroma (each channel minus luma) and rebuilds luma at
  every photosite from that site's own measurement. Luma detail then comes from all
  photosites, and false colour is suppressed.
- **`binned`** (`Quality::Preview`): averages each aligned 3×3 cell into one pixel. This
  gives exact colour at one third of the resolution, roughly 10× faster. The crop origin is
  snapped to a multiple of 3 so that every cell keeps the 5/2/2 composition.

Crop to the active area (`RawImageCropTopLeft` / `RawImageCroppedSize`, 7728×5152 at
(21, 12) on the X-E5) happens here: only the active area is linearised and demosaiced.

## 3. Noise reduction (Apple's `powerBlur` / `YAndRGBGather` family)

`stages/detail.rs`, applied in white-balanced camera space. The image is split into
`sqrt`-encoded luma and two chroma differences (R−Y, B−Y), so filter strength is roughly
perceptually uniform.

- **Chroma NR**: a box-approximated Gaussian blur of the chroma planes. Strength and radius
  grow with `noise = ISO / base_iso`; the default amount of 0.5 reaches full smoothing at
  about ISO 3200.
- **Luma NR**: an edge-preserving blend toward a small blur. The default comes from
  `default_luma_nr`, which is zero up to ISO 640 and about 0.12 at ISO 10000 and above. This
  matches the shape of Apple's per-ISO defaults.

Radii are scaled by the output scale (1/3 in preview mode), so previews and full renders
look alike.

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
r × (1 + distortion(r)/100) × distortion_fill_scale × (1 + ca(r) for red/blue)
```

using bilinear sampling. Vignetting divides by `vignetting(r)/100` when enabled.

- `distortion_fill_scale` (1.0101 on the X-E5) is a fitted zoom factor: Apple's corrected
  frame is about 1% tighter than the raw curve alone. Without it the distortion matches
  noticeably worse (see [validation](validation.md)).
- **Vignetting is off by default.** Apple's as-shot render does not apply the camera's
  vignetting curve, so turning it on makes corners 40–50% brighter than Apple's. It remains
  available as an edit (`lens.vignetting = true`).
- Lenses that report all-zero distortion (for example the XF 15 mm on these files) skip the
  stage, which matches Apple: its graph has no `radialLens` node for those files.

## 5. Highlight recovery (`RAWRecoverHighlightsV2`)

`stages/highlights.rs`. After white balance, channel c clips at `wb[c]`. For each pixel:

- **Some channels clipped**: green is estimated from the unclipped channels using the R/G
  and B/G ratios of nearby unclipped pixels (16×16 block averages, propagated into fully
  clipped regions). The clipped channels are then rebuilt from that estimate, never lower
  than their clipped value.
- **All channels clipped**: the pixel becomes neutral at the highest level, so blown areas
  render white instead of magenta or cyan.

## 6. Camera RGB to scene-linear Display P3, and exposure (Apple's `color_matrix` nodes)

```text
p3 = (look_matrix(T) · XYZ_D50→P3 · forward_matrix(T) · balanced_camera_rgb − black_render)
     × 2^(baseline_exposure − RawExposureBias + user_exposure)
```

See [color.md](color.md) for each term. `T` is the colour temperature of the white
balance, used to interpolate the two-illuminant matrices.

## 7. Sharpening

An unsharp mask on luma in scene-linear P3 (`stages/detail.rs`). Differences below a small
threshold are ignored (to avoid amplifying noise) and the result is clamped (to limit
halos). The default amount is 1.0, like CIRAWFilter's `sharpnessAmount`.

If `Options::keep_linear` is set, a copy of the image is saved here as `Developed::linear`.
It corresponds to the image at Apple's `linearSpaceFilter` hook, which makes it useful for
validation and as the input to future scene-referred edits.

## 8. Look: gamut compression and tone curve (`gmKernel_v7`, `boost_v7`)

`stages/look.rs`:

1. **Gamut compression**: any negative component is pulled toward the neutral axis at
   constant luminance, so out-of-gamut colours desaturate instead of clipping.
2. **Tone curve**: the profile's per-channel piecewise-linear curve maps scene-linear values
   to display-encoded P3 values (it includes the sRGB transfer function). Applying it per
   channel also desaturates highlights naturally. `tone_amount` blends between the curve and
   a flat transfer encode.

The result is clamped to 0–1.

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

- Every stage runs in parallel over rows with rayon. Peak memory is roughly the u16 mosaic
  plus two to three full-size f32 RGB buffers (about 0.5 GB at 40 MP).
- The design is ready for a tiled/GPU backend later, because each stage reads a bounded
  neighbourhood. Today the stages run whole-image on the CPU, without a tile scheduler.
