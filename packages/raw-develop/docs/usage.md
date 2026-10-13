# Using the library

## Rust

```rust
use raw_develop::{develop, encode, DevelopSettings, Negative, Options, Quality};

let neg = Negative::open("DSCF0970.RAF")?;                 // RAF, ARW or DNG; 0.03–0.2 s; cache between edits
let out = develop(&neg, &DevelopSettings::default(), &Options::default())?;
encode::write(&out.image, "out.png".as_ref(), encode::Format::Png16)?;

// Fast preview: one third of the resolution for X-Trans, one half for Bayer.
let preview = develop(&neg, &DevelopSettings::default(), &Options { quality: Quality::Preview, keep_linear: false })?;
let jpeg_bytes = encode::encode(&preview.image, encode::Format::Jpeg(90))?;
```

`Developed` contains:

- **`image`**: display-oriented, encoded Display P3, values 0–1.
- **`linear`**: scene-linear P3 before the look, when `keep_linear` is set. It is in sensor
  orientation, not rotated.
- **`info`**: the neutral used, its CCT, the total exposure in EV, and the luma NR amount
  actually used.

`Negative::read_metadata(&bytes)` parses metadata without decoding the sensor data, which
is cheap. Use it for dimensions, orientation and white balance. The container (RAF, ARW or
DNG) is detected from the bytes; unsupported files and models without a profile return
`Error::Unsupported`. JPEG XL DNGs (iPhone 17 Pro Max) need the default cargo feature `jxl`.

## Edit settings

`DevelopSettings` is the unit to store per photo. It serialises to JSON; every field is
optional on input and defaults to the as-shot (Apple-like) rendering:

```json
{
  "settings_version": 1,
  "white_balance": { "mode": "temperature", "kelvin": 5200, "tint": 8 },
  "exposure": 0.3,
  "highlight_recovery": true,
  "luma_noise_reduction": null,
  "chroma_noise_reduction": 0.5,
  "sharpening": 1.0,
  "tone_amount": 1.0,
  "lens": { "distortion": true, "chromatic_aberration": false, "vignetting": false },
  "crop": { "x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9 },
  "quarter_turns": 1
}
```

- `white_balance`: `{"mode": "as-shot"}` or `{"mode": "temperature", "kelvin", "tint"}`.
  Temperature/tint is not implemented for DNG yet and returns `Error::Unsupported`.
- `luma_noise_reduction: null` means RawCamera's default for the ISO (0 to about 0.13 on the
  X-E5); `chroma_noise_reduction` 0.5 is RawCamera's default and scales the chroma
  thresholds linearly; `sharpening` multiplies the luma pyramid's sharpening (see
  [noise-reduction.md](noise-reduction.md)).
- `lens` defaults to distortion only, like Apple's render (Fuji and Sony; DNG has no lens
  stage).
- `crop` is normalised to the display-oriented image after `quarter_turns`.
- Unknown fields are rejected and ranges are validated (`DevelopSettings::validate`), so
  stored settings fail loudly rather than being silently reinterpreted.
- Bump `SETTINGS_VERSION` and add a migration when fields change meaning.

## Caching and versions

- `PIPELINE_VERSION`: bump when output for the same file and settings changes (profile
  refits, algorithm changes). Cache keys for rendered output should include it, the same
  way the API uses `MEDIA_VERSION`.
- A `Negative` depends only on the file bytes, so it can be cached by content hash.
- For interactive editing, keep the `Negative` in memory, render `Quality::Preview` on every
  change (about 0.12 s for X-Trans 40 MP), and render `Full` (about 2.8 s for X-Trans 40 MP,
  about 5 s for Sony 61 MP, 0.4–0.6 s for iPhone 12 MP) once the user stops changing
  settings. Preview uses the generic NR/sharpening filters, so its fine texture
  differs slightly from the full render.

## CLI

```bash
raw-develop info F.RAF|F.ARW|F.DNG                     # parsed metadata
raw-develop cfa F.RAF out.u16                           # decoded mosaic, LE u16
raw-develop develop F.RAF out.png|out.jpg [--preview] [--settings s.json] \
                    [--dump-linear l.f32] [--dump-final f.f32]
raw-compare final|linear ours.f32 apple.f32             # ΔE00 report
```

## Integrating with the app

Done today: `image-processing` path-depends on `raw_develop` and exposes
`renderDevelopedRaw(path, quality)`, which the API serves as `GET /api/photos/:id/developed`
for the loupe's opt-in "Developed" view (web toggle / `R`, iOS ⋯ menu). Renders are full
resolution, default settings, and not cached.

Planned shape, for when this replaces the embedded-preview path in `image-processing`:

1. `image-processing` adds a path dependency on `raw_develop`, then in `decode.rs` tries
   `Negative::from_bytes` + `develop(Quality::Preview or Full)` for supported RAWs. It falls
   back to the exiftool embedded preview on `Error::Unsupported`.
2. Convert P3 to the thumbnail pipeline's expectations. Either tag WebP thumbnails and
   exports with the P3 ICC profile (preferred: browsers and iOS colour-manage it), or convert
   to sRGB with gamut compression.
3. Bump `MEDIA_VERSION` so existing RAW thumbnails regenerate.
4. Add an N-API surface for edits, for example
   `developRaw(path, settingsJson, { maxEdge, format }) → Buffer`, run on the native
   executor like `renderExportJpeg`.
5. Store `DevelopSettings` JSON per photo in the database, and include `PIPELINE_VERSION`
   plus a settings hash in thumbnail and export cache keys.

The whole pipeline is CPU-only today and runs fine in the Linux Docker image. A GPU (wgpu)
backend can replace individual stages later, because each stage is a bounded-neighbourhood
image operation.
