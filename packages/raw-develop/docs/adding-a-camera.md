# Adding a camera

How much work a new camera needs depends on how different it is from the X-E5:

| Case | Examples | Work |
|---|---|---|
| **A. Another X-Trans RAF body** | X-T5, X-H2, X100VI, X-S20 | profile + calibration (≈ half a day) |
| **B. Older X-Trans or a different compression variant** | X-Trans I/II/III bodies, lossy-compressed RAF | case A + verify or extend the decoder |
| **C. Bayer Fuji** | GFX, X-A series | case A + Bayer demosaic + Bayer decode paths |
| **D. Another make** | Sony ARW, Canon CR3, Nikon NEF, DNG | new container parser and unpacker, Bayer demosaic, lens data source |

Always do case A's steps. Cases B–D add work on top.

## Case A: another X-Trans RAF body

### 1. Collect fixtures

Gather 6–12 RAFs from the camera that span:

- base ISO, a mid ISO (800–1600) and the highest ISO you care about,
- daylight and tungsten (or other warm light),
- a scene with clipped highlights,
- DR100/200/400 (or any non-zero `RawExposureBias`),
- strongly saturated colours,
- each lens you use, including one that reports distortion.

From the production library, the export route serves original bytes:

```bash
API=https://photobrain-api.ericj5.com
curl -s "$API/api/v1/photos?filterRaw=raw&camera=FUJIFILM%20X-T5" > list.json   # pick ids
curl -sf "$API/api/photos/<id>/export?size=original" -o DSCFxxxx.RAF
```

(`/api/photos/:id/file` returns the converted WebP for RAW files, not the RAF.)

Keep fixtures **outside the repository**, for example in `~/raw-develop-fixtures/<model>/`.

### 2. Check that the file parses and decodes

```bash
cargo build --release
target/release/raw-develop info DSCFxxxx.RAF          # geometry, crop, black levels, WB, CFA, lens arrays
exiftool -RAFCompression -XTransLayout -RawImageFullSize -RawImageCropTopLeft DSCFxxxx.RAF
```

Look out for:

- `cfa` is not the standard pattern, or the info command fails on `0x131`: see case B.
- `RAFCompression` other than `Lossless`/`Uncompressed`: see case B.

### 3. Capture Apple references (macOS)

```bash
bun run apple-reference      # builds target/apple-reference (once)
for f in ~/raw-develop-fixtures/x-t5/*.RAF; do
  target/apple-reference "$f" ~/raw-develop-refs/x-t5/$(basename "$f" .RAF)
done
```

This only works if this Mac's RawCamera supports the body (it was released before the
installed macOS, or the RawCamera MobileAsset has been downloaded). Check
`params.json`: `decoderVersion` must be non-empty.

### 4. Verify the decoder bit for bit

```bash
RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures/x-t5 RAW_DEVELOP_REFS=~/raw-develop-refs/x-t5 \
  cargo test --release --test fixtures decoder_is_bit_exact -- --nocapture
```

Every file must print `bit-exact`. If not, see case B.

### 5. Get the DNG colour matrices

Convert one RAF with Adobe DNG Converter and read the tags:

```bash
"/Applications/Adobe DNG Converter.app/Contents/MacOS/Adobe DNG Converter" -c -p0 -d /tmp/dng DSCFxxxx.RAF
exiftool -n -ColorMatrix1 -ColorMatrix2 -ForwardMatrix1 -ForwardMatrix2 \
  -CalibrationIlluminant1 -CalibrationIlluminant2 -WhiteLevel /tmp/dng/DSCFxxxx.dng
```

Record the converter version in the provenance comment.

### 6. Write the profile

Copy `profiles/fujifilm-x-e5.toml` to `profiles/fujifilm-<model>.toml`, then:

- set `make` and `model`, and replace the colour and forward matrices and illuminants,
- set `base_iso`,
- **`white_level`**: start from the DNG `WhiteLevel` (often 16383 for 14-bit), then measure.
  Histogram the raw values of a clipped fixture: the clip spike usually sits a little below
  the maximum (about 16200 on the X-E5). Use the level where clipping begins, so blown
  highlights reach 1.0 in every channel after white balance,
- leave the fitted fields (look matrices, exposure, black render, fill scale) as the X-E5
  values to start with,
- remove the X-E5 `[[noise]]` entries until step 8 (without a table, `Full` uses the
  generic demosaic and NR); do not ship another camera's noise tables.

Register it in `src/profile.rs`:

```rust
const BUILTIN: &[(&str, &str)] = &[
  ("X-E5", include_str!("../profiles/fujifilm-x-e5.toml")),
  ("X-T5", include_str!("../profiles/fujifilm-x-t5.toml")),
];
```

The key must equal the `model` string reported by `raw-develop info` (the EXIF IFD0 Model).

### 7. Fit colour and lens

```bash
cd tools/calibrate
export RAW_DEVELOP_FIXTURES=~/raw-develop-fixtures/x-t5 RAW_DEVELOP_REFS=~/raw-develop-refs/x-t5
export RAW_DEVELOP_PROFILE=../../profiles/fujifilm-x-t5.toml RAW_DEVELOP_CALIB_OUT=/tmp/x-t5-calib
python fit_color.py         # → baseline_exposure, look_matrix_1/2  ($RAW_DEVELOP_CALIB_OUT/colorfit3.json)
python fit_distortion.py DSCFxxxx   # with a lens that reports distortion → fuji*scale = distortion_fill_scale
```

The scripts read sensor geometry, black level, CFA layout and WB from each file (with
exiftool) and read the colour matrices and white level from the profile set in
`RAW_DEVELOP_PROFILE`. Copy the printed results into the profile.

The look after exposure (`RAWHueMagnetMR`, `gmKernel_v7`, `boost_v7`) is a port with fixed
parameters. Check the new body's `graph.txt` for the same `amt=0.03` and `boost_v7`
coefficients; if they differ, they must become profile data.

`black_render` has been 0.003 in Apple's graphs for every X-E5 file. Read it from each
reference graph (`bias / scale` of the exposure `color_matrix` node) to confirm before
reusing it.

### 8. Transcribe the noise tables

The `[[noise]]` table is read from RawCamera's render graphs, one entry per 1/3-stop ISO.

1. Shoot (or collect) one RAF at every 1/3-stop ISO the camera offers, including extended
   ISOs. Scene content does not matter; the parameters depend only on the camera and ISO.
2. Run `target/apple-reference` on each. Its `graph.txt` is the `CI_PRINT_TREE` output.
3. For each file, write one `[[noise]]` entry (field mapping in
   [camera-profiles.md](camera-profiles.md#noise)):
   - `iso` from the file, `demosaic_noise` from `deXtrans_v8`'s `rn`,
   - `moire_detect = true` when the graph has `extractHRGBHF` rather than `extractHRGB`,
   - one `[[noise.chroma_passes]]` per `powerBlur*` node, from the one nearest the extract
     upwards (the graph prints bottom-up, innermost last): `kind` from the kernel name,
     `scale = params[3]`, `threshold = params2`, `interpolant`, and `params3`–`params6`
     into `despeckle`,
   - four `[[noise.luma]]` levels, finest first: `expandPlusDThruG3`/`G2` first, then the
     `expandPlusD*` nodes below it. For each `thru_g*` level take `parms`, `roparms`,
     `omparms[0..2]`, and from the mask subgraph feeding its `grad` input the `DIRToC`
     `params[0..3]`, `annealGAndC`/`annealG` `threshmodel[0..3]` and `cfactor`. `sharpen`
     lists that level's `smoothDSharpen` nodes as `parms ++ parms2`, step 1 first. For
     `thru_g2`, `gabor` is `gaborToSYAndG` `[smoothAmt, f1…, f2[0], f2[1]]`.

The X-E5 tables were transcribed with a throwaway parser; any script that follows this
mapping will do. Do not commit the graphs themselves. Record the RawCamera version in the
provenance comment. `cargo test` checks the table's structure; `raw-compare` per ISO checks
the values.

### 9. Validate

```bash
cargo test
RAW_DEVELOP_FIXTURES=… RAW_DEVELOP_REFS=… cargo test --release --test fixtures -- --nocapture
```

Then run `raw-compare` per file (see [validation.md](validation.md)). Target: mean ΔE00
around the X-E5 numbers (≤ 0.5) at every ISO. Look at a few
side-by-side renders as well; the numbers do not catch everything (moiré, halos, colour
fringes).

### 10. Document

- Add the body to the status list in `docs/README.md` and to `AGENTS.md`.
- Bump `PIPELINE_VERSION` only if X-E5 output changed.

## Case B: decoder differences (older X-Trans, other compression)

- **Different X-Trans layout**: the pattern is read from `0x131`, so nothing should be
  needed. `dextrans::phase` must also find the pattern's phase relative to the kernel's
  tile; it returns `None` (and the pipeline falls back) for other layouts. If `from_raf_xtrans_layout` rejects it (it requires 20 greens), dump the 36 bytes
  and check for a different encoding.
- **Different compressed header** (version ≠ 1, unusual block widths): `Header::parse`
  rejects implausible headers. Find the first differing pixel against Apple's `cfa.u16` (see
  [raf-format.md](raf-format.md#debugging-a-decoder-change)).
- **Lossy compressed RAF** (`RAFCompression` = Lossy): not implemented. Lossy RAF uses a
  different coding scheme. Apple's RawCamera decodes it, so the same approach applies:
  find the decoder in RawCamera with REA, reimplement it, and require a bit-exact match.
- **12-bit or 16-bit samples**: `Params::new` already handles 12/14/16-bit constants. Verify
  them bit for bit.
- Older RAF containers can put the FujiIFD or crop data elsewhere. `raf::parse` falls back to
  the CFA-header sizes when FujiIFD tags are missing.

## Case C: Bayer Fuji (GFX, X-A)

Needed:

1. `raf::parse`: build a 2×2 `CfaPattern` from the RAF's Bayer pattern tags (currently it
   returns `Unsupported` without `0x131`).
2. `unpack::fuji_compressed`: the Bayer variant (`raw_type == 0`) uses
   `line_width = block_width / 2` and a different pass table. The header code already
   accepts it, but `decode` rejects it. Implement the Bayer passes and validate bit for bit.
3. `stages/demosaic`: add a Bayer path (2×2 binning for `Preview`; for `Full`, port
   RawCamera's Bayer demosaic kernel the same way `deXtrans_v8` was ported) and dispatch on
   `cfa.is_xtrans()`. The noise tables come from that camera's graphs as in step 8.
4. Black levels: the 36-value array becomes per 2×2 position; `pipeline.rs` indexes it by
   `(row % 6) * 6 + col % 6`, so generalise that to the pattern size.

## Case D: another make

The pipeline from stage 1 onwards is camera-agnostic given:

- a `RafMetadata`-equivalent: geometry, black levels, white balance, CFA, orientation,
  exposure bias, lens data. Rename it to a make-neutral `RawMetadata` when the second format
  arrives, and dispatch in `Negative::from_bytes`,
- a `u16` mosaic,
- a profile.

Lens correction is currently Fuji-specific (FujiIFD arrays). Other makes store it in
different places (Sony and Panasonic MakerNotes, DNG `OpcodeList3` WarpRectilinear), so add a
source-specific parser that produces the same `LensCorrection`.

Validate each new decoder bit-exactly against Apple's `cfa.u16`, as for Fuji. The
`apple-reference` tool is format-independent.
