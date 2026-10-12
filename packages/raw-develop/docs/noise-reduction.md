# Noise reduction

Code: `src/stages/dextrans.rs`, `src/stages/chroma_nr.rs`, `src/stages/luma.rs`, the
`[[noise]]` tables in `profiles/*.toml` (schema in [camera-profiles.md](camera-profiles.md#noise)).

With `Quality::Full` and a profile that has a `[[noise]]` table, noise handling is RawCamera's
own: these three modules are ports (translations) of its Core Image kernels, which were
captured at runtime while CIRAWFilter rendered. Kernel names below are RawCamera's; each
module doc lists the ones it ports. The per-ISO parameters are read from RawCamera's render
graphs for the camera. Sharpening is part of the luma pyramid.

`Quality::Preview` and profiles without a noise table use the generic filters in
`stages/detail.rs` (ISO-scaled luma NR, unsharp mask) instead.

## Choosing the ISO entry

`CameraProfile::noise_for_iso` picks the `[[noise]]` entry nearest in log2(ISO). The X-E5
profile has one entry per 1/3-stop ISO from 64 to 12800 (21 entries), each transcribed from a
file shot at that ISO, so a real file always gets its own ISO's parameters.

## Demosaic noise model

`deXtrans_v8` (`stages/dextrans.rs`) chooses, per pixel, between a sharp direction-aware
interpolation and a smooth isotropic one. The mix depends on the 12-sample neighbourhood
variance against the noise model `rn` (`demosaic_noise`): roughly `16·(rn[1] + mean·rn[2])`
in range-scaled raw units. Flat noisy areas take the smooth estimate and textured areas the
sharp one. `exposureFactor` gates the mixer in deep shadows; it is fitted as
`2^(1.0146 + 0.452·(−RawExposureBias − 0.5))` from the values in Apple's graphs.

## Chroma (`powerBlur` chain)

`stages/chroma_nr.rs`, in white-balanced camera RGB:

1. **Extract** (`extractHRGB`, or `extractHRGBHF` when `moire_detect`): 2×2 average to half
   resolution, scaled so the largest white-balance channel has weight 0.5. The HF variant
   writes an alpha measuring fine green texture, so later passes can average across strong
   but colour-neutral detail (moiré).
2. **Passes** (`[[noise.chroma_passes]]`, in order, tap spacing `scale`): each output pixel
   averages itself with those of its 12 taps whose colour difference, weighted by the
   inverse white balance, is below `(c0 + c1·Y + c2·Y²) × amount / 0.5`.

   | `kind` | Kernel | Difference from `plain` |
   |---|---|---|
   | `plain` | `powerBlurL` | – |
   | `early_out` | `powerBlurEarlyOutL` | keeps the pixel if none of the 4 nearest taps qualifies |
   | `hf` | `powerBlurLHF` | moiré-aware threshold (`threshold[3]`) where the extract alpha is set |
   | `hf_early_out` | `powerBlurEarlyOutLHFi` | both; `interpolant` blends the plain and moiré-aware averages |
   | `early_out2` | `powerBlurEarlyOut2L` | second, stricter threshold preferred for saturated pixels (`despeckle = [t2 factor, range factor]`) |
   | `despeckle` | `powerBlurDespeckleL` | also replaces isolated dark/saturated/red speckles by the average of 4 neighbours (13 detector values) |

   On the X-E5, ISO ≤ 640 uses `hf, hf, hf_early_out` (spacings 1, 3, 7); ISO 800–1000
   `plain, plain, early_out`; ISO 1250 and up adds a fourth pass at spacing 14, and from
   ISO 4000 the second pass is `despeckle` (from 10000 the last is `early_out2`).
3. **Expand** (`expandHRGB`): bilinear (9/3/3/1) upsample to full resolution.

`chroma_noise_reduction` defaults to 0.5, RawCamera's default. Thresholds scale linearly with
`amount / 0.5`, which matches Apple's renders at 0.25, 0.5 and 1.0; 0 disables chroma NR.

## Luma (Laplacian pyramid)

`stages/luma.rs`. Luminance is `k·(0.299 R + 0.587 G + 0.114 B)` (`extractY`) of the
demosaiced image. Planes use Core Image's orientation (row 0 at the bottom) so the kernels'
direction vectors and asymmetric stencils match.

1. `gaborToYAndVF` (or `gaborToSYAndG` for `thru_g2`) gives the base plane and gradients.
2. `reduce` four times gives a 5-level pyramid; `expandAndMakeD` gives the four detail bands.
3. The image is rebuilt from the coarsest level towards full resolution. Each band is added
   back by its `[[noise.luma]]` entry (index 0 = full resolution):
   - `plain` (`expandPlusDWithOverdrive`): detail unchanged (times `1 + overdrive`).
   - `thru_g` (`expandPlusDThruG`): detail is cored (shrunk) except where a structure mask
     says it is real. The mask: `gaborToVF` → `smoothVF` → `VFToGDIR` → `DIRToC`
     (curvature threshold `dir_to_c`) → `annealGAndC` (gradient threshold `anneal`,
     `cfactor`). Optional `sharpen` passes apply to the band.
   - `thru_g3` (`expandPlusDThruG3`, full resolution, most ISOs): the same coring with the
     mask built on the full-resolution plane, plus a directionally sharpened copy of the
     finest band (`smoothDSharpen` ×4 at steps 1, 2, 4, 8) added where structure is found.
   - `thru_g2` (`expandPlusDThruG2`, full resolution, ISO 64 and 160): coring and
     sharpening with a simpler gradient mask (`gaborToSYAndG` → `annealG`).

On the X-E5 the coarser levels are all `plain` up to ISO 640; from ISO 800 the next level is
`thru_g`, and from ISO 1250 most entries use `thru_g` on all three.

Settings:

- `luma_noise_reduction`: `None` means RawCamera's default for the ISO, `1 − parms[2]` of
  the `thru_g3` level (0 for `thru_g2`). This equals CIRAWFilter's
  `luminanceNoiseReductionAmount`. Other values rescale the coring on every level relative to
  that default.
- `sharpening` (default 1.0) multiplies the `smoothDSharpen` high-frequency gain and the
  full-resolution sharpen amount.

## Gather (`YAndRGBGather`)

Each output pixel keeps the filtered chromaticity from the chroma plane and is scaled to the
pyramid's luminance. Near sensor clipping (largest unbalanced channel from 0.9 to 1.0 of
white) it blends back to the original luminance.

## Changing it

- Kernel translations keep the kernels' variable names, so they can be compared line by
  line with the captured source. Keep that when editing.
- Any change to these modules or to the noise tables changes output: bump
  `PIPELINE_VERSION`, and check every fixture with `raw-compare final` (the high-ISO files
  exercise `despeckle`/`early_out2` and `thru_g`; ISO 64 exercises `thru_g2`).
