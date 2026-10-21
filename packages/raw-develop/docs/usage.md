# Using the library

## Rust

```rust
use raw_develop::{develop, encode, DevelopSettings, Negative, Options, Quality};

let neg = Negative::open("DSCF0970.RAF")?;                 // RAF, ARW or DNG; 0.03–0.2 s; cache between edits
let out = develop(&neg, &DevelopSettings::default(), &Options::default())?;
encode::write(&out.image, "out.png".as_ref(), encode::Format::Png16)?;

// Fast preview: one third of the resolution for X-Trans, one half for Bayer.
let preview = develop(&neg, &DevelopSettings::default(), &Options { quality: Quality::Preview, ..Options::default() })?;
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

## Repeated editing

```rust
use raw_develop::{prepare, DevelopSettings, Negative, Options, Quality};

let negative = Negative::open("DSCF0970.RAF")?;
let mut settings = DevelopSettings::default();
let options = Options { quality: Quality::Preview, ..Options::default() };
let working = prepare(&negative, &settings, &options)?.with_max_edge(2048)?;
drop(negative); // the working image owns all its render inputs

settings.exposure = 0.5;
let brighter = working.render(&settings, &options)?;
settings.exposure = -0.5;
let darker = working.render(&settings, &options)?; // no accumulated gain
```

`Prepared` is immutable and owns a linear, unclamped RGB float image plus render metadata.
Exposure, tone amount, crop and quarter turns can change between renders. Changing white
balance, highlight recovery, luma/chroma NR, sharpening, lens settings or quality returns
`Error::Settings`: prepare a new working image for those controls. The cancellation token
and `keep_linear` can change per render. A cancelled request does not invalidate the cache.

The boundaries differ by format:

- **RAF/ARW:** preparation includes demosaic, white balance, camera-space NR, lens
  correction and highlight recovery. Rendering runs colour/exposure, any generic
  preview sharpening, the look and geometry. Preview sharpening remains after exposure
  and is not a per-pixel operation.
- **ProRAW DNG:** preparation crops the decoded camera RGB and bins it for preview.
  Rendering reruns the detail graph because its thresholds depend on exposure, followed
  by highlight recovery, colour/exposure, the gain map, look and geometry. DNG exposure
  edits therefore do more work than RAF/ARW; no stale detail result is reused.

Without `with_max_edge`, prepared renders are bit-identical to `develop` at the same
settings and quality. `develop` uses this same split internally, transferring the working
image instead of cloning another full-size buffer.

`with_max_edge` consumes the larger working image and area-resamples it to fit the positive
limit, preserving aspect ratio (to whole pixels), without upscaling. It preserves negative
values and highlights above 1.0. This is an **approximate preview**: downsampling before
nonlinear look/detail stages does not equal downsampling a completed render. It is not a
replacement for full-resolution export or pixel-level detail inspection. `dimensions()`
reports working dimensions before orientation/crop; `pixel_bytes()` counts its RGB pixels,
not total process memory. Preparing a screen proxy still incurs the original preparation
and decode peak; this API does not yet implement an on-disk working-negative format.

## Caching and versions

- `PIPELINE_VERSION`: bump when output for the same file and settings changes (profile
  refits, algorithm changes). Cache keys for rendered output should include it, the same
  way the API uses `MEDIA_VERSION`.
- A `Negative` depends only on the file bytes, so it can be cached by content hash.
- For repeated exposure/tone edits, keep a `Prepared` image rather than rerunning the
  entire preview pipeline. Retain a `Negative` separately only if re-preparing earlier
  stages without decoding again is worth its memory cost. Cache identity must include the
  source identity, pipeline version, preparation settings, quality and any resize limit.
- Preview uses different demosaic/NR/sharpening from Full. Full rendering is still about
  2.0 s for X-Trans 40 MP, 2.4–2.7 s for Sony 61 MP and 0.4 s for iPhone 12 MP on the
  documented desktop hardware. Benchmark repeat rendering separately; desktop results
  do not establish iPhone performance.

## CLI

```bash
raw-develop info F.RAF|F.ARW|F.DNG                     # parsed metadata
raw-develop cfa F.RAF out.u16                           # decoded mosaic, LE u16
raw-develop develop F.RAF out.png|out.jpg [--preview] [--settings s.json] \
                    [--dump-linear l.f32] [--dump-final f.f32]
raw-compare final|linear ours.f32 apple.f32             # ΔE00 report
raw-edit-bench --max-edge 2048 --iterations 30 --threads 4 F.RAF F.ARW F.DNG
```

`raw-edit-bench` outputs one JSON record per input: decode, preparation and resize times,
working dimensions/pixel bytes, and repeated exposure-render p50/p95/max latency. Three
warm-up renders are excluded. The timed interval includes cloning the immutable working
pixels, all remaining stages, and output allocations, but excludes encoding, file/network
I/O, UI presentation, destruction of the returned output and the final output digest. It sweeps exposure
around the requested baseline, clipped to the supported range. `--settings s.json` changes
the baseline; `--full` prepares full-quality pixels before resizing. The Rayon pool size is
explicit and reported; use `--threads` to test constrained CPU budgets.

See [interactive editing](interactive-editing.md) for measured repeat-render timings and
the remaining native iOS work.

## Integrating with the app

Done today: `image-processing` path-depends on `raw_develop` and exposes
`renderDevelopedRaw(path, quality)`, which the API serves as `GET /api/photos/:id/developed`
for the loupe's opt-in "Developed" view (web toggle / `R`, iOS ⋯ menu). Renders are full
resolution, default settings, and not cached.

Native iOS **Edit RAW** uses the C bridge in `ffi/`, a serial Swift actor, Display P3
presentation and a session-only exposure slider. The build script can also package an
XCFramework. See [interactive editing](interactive-editing.md) for build setup and behavior.
Persisted editing also needs per-photo `DevelopSettings` in the database and cache keys
containing the source identity, `PIPELINE_VERSION` and settings hash. Neither app currently
saves these adjustments.

The whole pipeline is CPU-only today and runs fine in the Linux Docker image. A GPU (wgpu)
backend can replace individual stages later, because each stage is a bounded-neighbourhood
image operation.
