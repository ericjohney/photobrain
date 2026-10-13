# RAF format and decoder

Code: `src/raf/` (container), `src/unpack/` (sensor data), `src/cfa.rs` (pattern).

## Container

A RAF file is a big-endian header followed by three blocks:

| Offset | Field |
|---|---|
| `0x00` | magic `FUJIFILMCCD-RAW ` (16 bytes) |
| `0x1c` | camera model (32 bytes, NUL-padded) |
| `0x3c` | RAF version (`0112` on the X-E5) |
| `0x54` | JPEG preview offset, length (u32 BE each) |
| `0x5c` | CFA header offset, length |
| `0x64` | CFA block offset, length |

### Embedded JPEG

This is the camera's preview. We only read its EXIF APP1 segment: IFD0 Orientation, Make,
Model, and from the EXIF IFD the ISO, LensModel and FocalLength. A missing or broken EXIF is
not fatal; orientation then defaults to 1.

### CFA header

Big-endian records: a `u32` count, then `(u16 tag, u16 size, data)` repeated. The records
we use:

| Tag | Meaning |
|---|---|
| `0x100` | raw height, width (full readout) |
| `0x110` | crop top, left |
| `0x111` | crop height, width |
| `0x131` | X-Trans layout, 36 bytes (0 = R, 1 = G, 2 = B), **stored in reverse raster order** |
| `0x9650` | RawExposureBias: `i16` value, `i16` divisor (for example −72/100 = −0.72 EV) |

The layout reversal is verified: reversing the 36 bytes and indexing by absolute sensor
`(row % 6, col % 6)` reproduces the 2×2 green blocks seen in the decoded data
(`cfa::tests::parses_reversed_raf_layout`).

`RawExposureBias` is the camera's highlight-protection underexposure (for DR settings and
similar). Apple adds `−RawExposureBias` back during rendering, and so do we.

### CFA block (FujiIFD)

A little-endian TIFF. IFD0 holds a single entry, `0xf000`, pointing to the FujiIFD:

| Tag | Meaning |
|---|---|
| `0xf001` / `0xf002` | raw width / height |
| `0xf003` | bits per sample (14) |
| `0xf007` / `0xf008` | strip offset (within the CFA block) / byte count |
| `0xf00a` | black levels, 36 values (per 6×6 position) |
| `0xf00b` | GeometricDistortionParams (rational) |
| `0xf00e` | WB_GRBLevels (as shot: G, R, B) |
| `0xf00f` | ChromaticAberrationParams |
| `0xf010` | VignettingParams |

If the strip starts with `0x4953` it is Fuji lossless compressed; otherwise it is treated as
uncompressed little-endian `u16`.

`tiff.rs` is a small bounds-checked TIFF reader shared by every container. Every offset is checked, so a truncated
or malicious file returns `Error::Malformed` rather than panicking.

## Fuji lossless compressed decoder

`unpack/fuji_compressed.rs`. It is validated **bit-exactly** against Apple's RawCamera
decode of every fixture (`tests/fixtures.rs`, `decoder_is_bit_exact_with_rawcamera`).

### Header (16 bytes, big-endian)

```text
u16 0x4953 | u8 version (1) | u8 raw type (16 = X-Trans, 0 = Bayer) | u8 bits (12/14/16)
u16 raw height | u16 rounded width | u16 raw width | u16 block (stripe) width
u8 blocks per row | u16 total lines (= height / 6)
```

The header is followed by one `u32` compressed size per block, padded so that the data
starts 16-byte aligned.

### Structure

- The image is split into vertical **stripes** of `block_width` columns (768 on the X-E5,
  11 stripes). Stripes are coded independently and are decoded in parallel with rayon.
- Each stripe is decoded one **line** (six sensor rows) at a time into 18 per-colour line
  buffers: red, green and blue groups. Each group has two history rows plus the rows being
  decoded, and each row has a one-sample border on each side.
- A line is decoded in **six passes** (`XTRANS_PASSES`). Each pass fills one row from two
  colour groups, alternating even and odd positions. Even positions are either coded or
  interpolated (`Even::*` rules), depending on where the X-Trans pattern actually places a
  sample of that colour. Odd positions are always coded.
- **Prediction** uses already-decoded neighbours in the same buffer: above (`b`), above-left
  (`c`), above-right (`d`), two above (`f`), left (`a`) and right (`g`).
  - Even samples average along the smoothest of three directions.
  - Odd samples use left/right, with the row above when it is a local extremum.
- **Residuals** are coded with an adaptive Golomb-Rice-like code:
  - A unary prefix counts zeros.
  - The parameter `k` is chosen from a running (sum, count) for one of 41 gradient
    contexts. A context is `q(diff₁)·9 + q(diff₂)`, quantised by thresholds 0x12, 0x43 and
    0x114.
  - There are three context sets, chosen by pass.
  - Long prefixes escape to a raw `bits`-wide value.
- **Mapping out**: `xtrans_buffer_index(col)` maps an output column to its position in a
  colour buffer, and `route[row][col % 6]` picks the buffer from the CFA colour.

The pass table is the subtle part. The first implementation coded green at even positions
in passes 3 and 6, which desynchronised the bitstream on the very first line. Apple's decoder
(RawCamera, located with the REA tools and Ghidra) interpolates those positions. The comment
on `XTRANS_PASSES` records this.

### Debugging a decoder change

1. Capture Apple's mosaic for the file: `target/apple-reference file.RAF refs/stem`. This
   writes `cfa.u16`, the full readout as little-endian `u16`.
2. Write ours: `target/release/raw-develop cfa file.RAF /tmp/ours.u16`.
3. Compare with `cmp`. To localise a problem, find the first differing (row, col) for each
   768-column stripe (the stripes are independent). A mismatch at the start of every stripe
   points at the pass table or the line buffers; a mismatch partway through a stripe points
   at context adaptation.

### Uncompressed

`unpack/uncompressed.rs`: `width × height` little-endian `u16` values, clamped to
`2^bits − 1`.

## CFA pattern

`cfa::CfaPattern` is addressed in **absolute sensor coordinates**: row 0, col 0 is the first
readout photosite, before cropping. After cropping or snapping the origin, use
`pattern.shifted(top, left)` to get the pattern as seen from the new origin. Bayer
(2×2) patterns fit the same type; nothing produces one yet.
