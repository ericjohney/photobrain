# Colour and tone

Code: `src/profile.rs`, `src/math.rs`, `src/pipeline.rs` (stage 6), `src/stages/look.rs`.

## Spaces

| Where | Space |
|---|---|
| after linearise | camera RGB, white-balanced (a white object = 1,1,1) |
| after stage 6 | **scene-linear Display P3** (D65), unbounded |
| output | display-encoded Display P3 (sRGB transfer), 0–1, tagged with a P3 ICC profile |

Display P3 is the output space because that is what Apple's RawCamera produces: its graph
ends in `tagcolorspace DisplayP3`.

## White balance

As shot:

```text
neutral = [R/G, 1, B/G] = [1/(G/R), 1, 1/(G/B)]    from WB_GRBLevels (G, R, B)
wb      = 1 / neutral
```

For a user temperature and tint (`WhiteBalance::Temperature { kelvin, tint }`):

1. Find the chromaticity on the Planckian locus (Kim et al. cubic). Tint moves
   perpendicular to the locus in CIE 1960 uv, at 1/3000 uv per unit (roughly Lightroom's
   scale); positive is magenta.
2. Convert that xy to XYZ and map it to camera RGB with `color_matrix(kelvin)`. The result is
   the camera neutral.

To report or interpolate a temperature for any neutral, `neutral_to_cct` iterates the DNG
way: invert the interpolated `ColorMatrix`, convert XYZ to xy, apply McCamy's CCT formula,
and repeat until stable.

## Camera to scene-linear P3

```text
p3 = look_matrix(T) · XYZ_D50→P3 · forward_matrix(T) · balanced_cam
```

- **`forward_matrix(T)`**: DNG ForwardMatrix1/2 (Adobe DNG Converter data), interpolated by
  `1/T` between the two calibration illuminants (2856 K and 6504 K), exactly as the DNG
  spec does it. It maps white-balanced camera RGB to XYZ D50, so white maps to D50.
- **`XYZ_D50→P3`**: Bradford D50→D65 followed by the inverse of the Display P3 RGB→XYZ
  matrix (`math::XYZ_D50_TO_LINEAR_P3`).
- **`look_matrix(T)`**: a fitted, **white-preserving** 3×3 (each row sums to 1), also
  interpolated by `1/T`. It carries the saturation and hue difference between Adobe
  Standard colour and Apple's rendering. Because white maps to white, white balance is not
  affected.

Two illuminants plus a 1/T blend let the colour response follow the scene illuminant;
tungsten and daylight fixtures fit noticeably better than with one global matrix.

## Exposure

```text
p3_exposed = (p3 − black_render) × 2^(baseline_exposure − RawExposureBias + user_exposure)
```

- **`RawExposureBias`**: the camera's own highlight-protection underexposure, from CFA header
  `0x9650`. Undoing it is what makes DR-mode shots render at normal brightness.
- **`baseline_exposure`** (−0.49 EV on the X-E5): fitted. Every Apple render of every fixture
  is consistent with `baseline − RawExposureBias` being constant. CIRAWFilter's own
  `baselineExposure` property equals `−0.5 − RawExposureBias` on every fixture, which is
  where the observation comes from.
- **`black_render`** (0.003): a small linear offset subtracted before exposure. Apple's
  exposure node has the form `k·(x − 0.003)` on every file. Fitting it halved the colour
  error in shadows.

## Look

1. **Gamut compression** (`look::compress_gamut`): scene-linear P3 can contain negative
   components for very saturated camera colours. They are moved toward the luminance axis
   until the minimum component is 0, keeping luminance and hue direction.
2. **Tone curve** (`ToneCurve::eval`): a per-channel piecewise-linear curve from
   scene-linear values to *encoded* values, with knots every half stop from 2⁻¹⁰ to 1 plus
   a shoulder to 4. It reproduces Apple's `boost` contrast curve composed with the sRGB
   transfer. Middle grey (0.18) maps to about 0.65 encoded. Values above about 1.0 linear
   saturate to 1.

`tone_amount < 1` blends toward a flat `srgb_encode`, which an edit UI can expose as
"contrast/look strength".

## Things to know when changing colour

- Changing `look_matrix_*`, `baseline_exposure`, `black_render` or `tone_curve` changes
  output, so bump `PIPELINE_VERSION`.
- Refit these values together. They are not independent: exposure and the tone curve trade
  off against each other, and the look matrix and gamut compression interact on saturated
  colours. See [validation.md](validation.md#refitting-a-profile).
- `ColorMatrix` and `ForwardMatrix` are measured camera data. Do not tune them; tune the
  look matrices instead.
