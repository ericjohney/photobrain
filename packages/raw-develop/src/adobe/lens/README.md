Embedded lens validation
========================

The public DNG SDK specifies WarpRectilinear and weight-table construction.
Converter 18.7 uses a different implementation from the SDK's generic filter:
`cr_opcode_WarpRectilinear` -> `cr_stage_radial_warp` -> `SIMDRadialWarp16`.
The active image contains preserved black, before white balance and DefaultCrop.
Float-to-u16 conversion multiplies by 65535, then rounds to nearest, ties to even.
The 16-bit samples are biased by -32768 while convolving. The kernel is general
Mitchell-Netravali B=.4/C=.9, with 32 phases and sixteen taps per phase.

SIMD radius lookup multiplies the f32 squared radius by its scale and rounds to
nearest, ties to even. The scalar RefRadialWarp16 instead uses fused +.5 and
truncation; this makes rare pixel differences. Source coordinates use FMA.

Sony's 0x7035 header counts both curves; e.g. 22 means eleven red knots followed
by eleven blue knots, with remaining padding ignored. Fuji 0xf00f contains a
normalization scalar, nine radii, nine red deltas, nine blue deltas, and another
normalization scalar. Fuji optical-center shifts are signed SLONG tags 0xf011
(horizontal) and 0xf012 (vertical), in tenths of a pixel. Either invalid axis
invalidates both shifts. Limits are +/-1490 for X100VI and +/-2930 for X-E5.

Local evidence is under `/Users/eric/acr-re/` (not needed at runtime):

- `scripts/fit_ca.py` and `scripts/ca_oracle.json`: original camera arrays and
  emitted OpcodeList3 coefficients/centers for five Sony and six Fuji files.
  The QR fit's f64 coefficients may differ in their last bits from Adobe's
  pseudoinverse. All 180,224 consumed red/blue f32 ratio entries match exactly.
- `trace/radial-inner-{12766,0008,6453,0711,0604,0672}/`: source/destination
  buffers, stage parameters, geometry, ratio tables, float weights and integer
  weights (the first 12766 capture predates integer-table capture).
- `trace/radial-inner-12766-tail/`: regression capture including active pixel
  3689,5606,blue, which exposed the SIMD-versus-scalar radius-rounding difference.
- `scripts/trace_radial_warp.py`: LLDB capture driver. It launches its own
  Converter process and kills that process after two captured regions.

Run local captured checks from the package directory:

```sh
RAW_DEVELOP_ADOBE_CA_ORACLE=/Users/eric/acr-re/scripts/ca_oracle.json \
RAW_DEVELOP_ADOBE_WARP_TRACE=/Users/eric/acr-re/trace/radial-inner-12766-tail \
cargo test --lib adobe::lens -- --nocapture
```

All eleven complete linear-CA reference images match exactly in every channel;
results are recorded in `linear-ca-results.json` and `linear-ca-{stem}.log` under
the evidence root.

Optional Fuji distortion and vignetting
--------------------------------------

The optional profile path is distinct from the mandatory CA opcode. Supported
X-E5/X100VI Fuji arrays become physical-radius profiles using Converter's model
pixel pitch, focal length, six-decimal profile quantization, and q16 runtime
pixels-per-millimetre. The X-E5 distortion fit uses inverse vendor radii followed
by border padding. The X100VI reference's distortion array is an identity.
Distortion's profile center receives the valid IBIS optical offset twice;
illumination receives it once. Both are quantized before conversion to pixels.

`distortion.rs` implements `cr_rectilinear_warp_calculator::BuildBackwardTable`
and the `cr_stage_warp::Process_16_16` transport: preserved-black linear u16 ->
nonlinear u16 -> 32-phase signed convolution -> linear u16. The sampled model
uses ordinary f32 multiply/add for radius/interpolation and FMA for coordinates.
The original 4096/65535 black is encoded around 0.25 during convolution.

`spline.rs` and `vignette.rs` implement the monotone illumination spline and
reciprocal radius-squared table consumed by `RefVignetteRGB32`. The vignette
evaluates the distortion's backward source position, so illumination follows
the original lens ray. The captured full-render stage uses black=0 and clips
to white after the first DCP HueSatMap.

Stage order is demosaic/cleanup -> mandatory CA -> optional distortion ->
ABCtoRGB input transform -> CR6 NR -> black subtraction -> first DCP HueSatMap
-> u16 commit -> warp-aware vignette -> exposure/tone. Black subtraction also
commits u16 before the first map. Vignette output stays float into exposure.
The prewarp image-pyramid cache is not
the CR6 user-NR stage. Static call evidence: `cr_render` calls
`GetWarpedSourcePipe` at 0x100d9189c before `AppendRawConversionStages` at
0x100d91914; the latter appends ABCtoRGB at 0x100d8e258, CR6 at 0x100d8e2dc,
and vignette at 0x100d8e3e4.

Local evidence:

- `scripts/trace_embedded_lens.py`: owned-process LLDB capture driver.
- `trace/lens-xe5-full/`: full 4,098-entry distortion and vignette tables,
  calculator geometry, 368x368 RGB u16 distortion tile, and same-sized float
  warp-aware vignette tile. Metadata-derived tables and all output channels
  match exactly.
- `trace/render-stages-xe5-lens/`: camera transform, u16 black-removal table,
  first profile map, and exposure boundaries with the optional lens profile on.
  The composed RAW-to-vignette regression reproduces the original full tile
  exactly and confirms mandatory CA (CA off differs in 282,150 source channels;
  CA on matches all source channels). Adding `ADOBE_PROFILE_DIR` to the capture
  test environment enables this full RAW preparation check; optionally set
  `RAW_DEVELOP_ADOBE_LENS_COLOR_TRACE` to this directory for intermediate checks.
- `trace/lens-x100vi/`: metadata-derived vignette table/geometry and complete
  captured float vignette tile match exactly, both in isolation and through
  the composed RAW preparation/profile-map pipeline.
- `trace/lens-{a7cr,a1m2}/` and `trace/lens-a7cr-off/`: normal Sony rendering
  uses mandatory embedded CA, but optional distortion/vignetting select an
  external Adobe LCP when LensProfileEnable is on. With the profile disabled,
  neither optional stage is rendered. Sony's embedded maker distortion call
  records EXIF LensDistortInfo; it does not apply that table to normal output.

Run the optional checks with `RAW_DEVELOP_ADOBE_LENS_TRACE` set to a capture
directory and `RAW_DEVELOP_ADOBE_LENS_RAW` set to its source RAF, then
`cargo test --lib adobe::lens -- --nocapture`.

Not implemented here: external Adobe LCP selection/interpolation, tangential
warps, floating-point DNG warps, non-square pixels, older Fuji adjustment rules,
or cropped sensor modes requiring another DefaultCrop-to-active radius scale.
Exactness evidence is bounded to the supported bodies and captured/reference
files; the distortion/vignette captures do not establish whole-image parity.
