# Image Processing Agent Guide

Scope: `packages/image-processing`.

## Package Boundary

This private workspace package is a Rust `cdylib` exposed to JavaScript through N-API. The native artifact is generated under `dist/` and is ignored by Git. It is not published independently; build it before running API code that imports native functions.

```bash
cd packages/image-processing && bun run build
cd packages/image-processing && bun run build:debug
cd packages/image-processing && cargo test
```

The package contains template metadata and scripts from the N-API starter (`packageManager: yarn`, template repository metadata, and an unused WASI helper). The actual monorepo uses Bun and the active build is `napi build --platform --release --output-dir dist`.

## Public N-API Surface

Exports are re-exported from `src/lib.rs` and consumed by the API:

- `discoverPhotos(directory)`: returns `{ filePaths, relativePaths, totalCount }`.
- `isSupportedImage(path)`: case-insensitive suffix check.
- `getSupportedExtensions()`: extensions include the leading dot.
- `processPhoto(path, relativePath, thumbnailsDir)`: synchronous single-file processing.
- `processPhotosBatch(paths, relativePaths, thumbnailsDir)`: parallel processing with result order matching input paths.
- `startPhotoProcessing(paths, relativePaths, thumbnailsDir)`: returns a single-consumer `PhotoProcessingStream`; `next(): Promise<{ index, result } | null>` yields completion order with original input indices, and `close(): Promise<void>` cancels dispatch and waits for active metadata/writers.
- `extractExif(path)`: returns `ExifData` or `null`.
- `generatePhash(path)`: direct decodable-image pHash helper.
- `perceptualHash(path)`: legacy alias for the same direct-file pHash helper.
- `generateThumbnailsFromFile(path, relativePath, baseDir, orientation)`: single-file thumbnail helper.
- `clipTextEmbedding(text)`: CLIP text vector.
- `batchGenerateClipEmbeddings(paths)`: aligned result array with `null` for failed inputs.

The streaming API rejects mismatched path arrays and permits one pending `next()` call. `processPhotosBatch` remains a synchronous, input-aligned helper; callers must preserve paired arrays (the API executor validates them). Stream cancellation discards buffered results, not acknowledged SQLite receipts.

The API uses a persistent worker thread for discovery, streaming media, HEIC maintenance, and image embeddings. It retains one stream across completion windows and acknowledges each result after API-thread persistence. Other native work or another job cancels/drains that stream before replacement. Public stream pulls/close are asynchronous N-API tasks; synchronous helper exports remain available. The executor is not a global library lock or native process-crash boundary.

## Scan Processing Pipeline

`src/batch.rs` handles standard, RAW, and HEIF files:

1. Read filesystem metadata and timestamps.
2. Detect RAW by extension.
3. Detect HEIF by extension or magic bytes.
4. Use prefetched EXIF in batch/stream processing, or extract EXIF through one child `exiftool` process for single-photo processing.
5. Decode HEIF with `libheif-rs`.
6. Decode RAW through an embedded JPEG preview from `exiftool`.
7. Decode standard formats with `image::ImageReader`.
8. Apply EXIF orientation except for HEIF, because libheif applies container transforms.
9. Generate a double-gradient pHash from the full decoded, orientation-corrected image, not a thumbnail.
10. Generate four WebP thumbnails; thumbnail failure makes the photo result unsuccessful.

Media calls reuse one lazily initialized Rayon pool sized by `std::thread::available_parallelism()` or a positive `PHOTO_PROCESSING_THREADS` override. Initialization/configuration errors become JavaScript exceptions. Single-photo processing also enters this pool; nested thumbnail work shares it. A successful photo requires all four thumbnail writes; failures return `success: false`, and partial files may remain.

`src/stream.rs` has an independent EXIF producer and CPU-count dispatch threads feeding that Rayon pool. Ready and result channels each hold at most twice the worker count; the producer additionally holds one metadata chunk of at most 20. At most worker-count photos are in media processing. Dispatch/result-channel waits do not occupy Rayon workers, avoiding nested thumbnail starvation. Workers take the next ready photo without waiting for a metadata chunk's other photos to finish. The synchronous batch helper retains chunk barriers and is not the normal scan path.

`close()` broadcasts cancellation before scheduling its N-API async join, wakes blocked queues, and waits for active metadata and writers. This avoids libuv starvation when `next()` is blocked. GC cancellation is nonblocking; explicit close is the writer-drain boundary. Startup, I/O/ExifTool, persistence backpressure, and the last stragglers can still prevent 100% CPU utilization.

Metadata commands retain the selected tags and `-json -n` numeric output, explicitly request `-Error` for per-file failure detection, use direct process arguments (no shell), and terminate options with `--`. Each command has at most 20 unique absolute paths and 32 KiB of path-argument bytes, including NUL separators. Long paths split commands earlier; an individual argument exceeding that budget yields no metadata without launching an oversized command. This is a conservative argv bound, not a guarantee against OS/environment limits; spawn failures follow the same bounded recovery path.

JSON records are associated by absolute `SourceFile`, never array position or basename. Paths are not canonicalized: differently named symlinks must retain their suffix because RAW metadata interpretation can depend on it. Repeated absolute paths within a metadata chunk share extraction and receive aligned copies. Valid records, including empty-metadata records without errors, survive mixed nonzero exits; error records cannot replace valid metadata. Only unresolved unique inputs receive one individual retry after a multi-file command. A singleton command is already the individual attempt and is not retried. Malformed JSON cannot be partially recovered and therefore takes the unresolved-input path. RAW binary `PreviewImage`/`JpgFromRaw` extraction remains separate and unchanged; there is no persistent `stay_open` process.

Healthy typical-path imports use one metadata launch per 20 inputs (45 files: 20/20/5, three launches instead of 45). A failed multi-file command can cost one launch plus one retry per unresolved unique input. RAW preview launches are additional and are not reduced by metadata batching. These are command-count expectations covered by injected-runner tests, not measured throughput claims.

The synchronous batch helper logs aggregate EXIF and processing wall time. Streaming phases overlap, so its sequential batch timings must not be interpreted as streaming-stage CPU utilization. See the real-photo benchmark for process CPU, elapsed time, and peak RSS.

CLIP embeddings are intentionally not generated in this pipeline. The API's Inngest embedding function later reads generated `large` thumbnails and calls `batchGenerateClipEmbeddings` in groups of 16.

## Supported Files

Standard extensions:

```text
.jpg .jpeg .png .gif .webp .bmp .tiff .tif
```

RAW extensions:

```text
.cr2 .cr3 .nef .arw .dng .raf .orf .rw2 .pef .srw .x3f .3fr .iiq .rwl
```

HEIF extensions:

```text
.heic .heif
```

Magic-byte detection recognizes common HEIF/AVIF brands, including `heic`, `heix`, `hevc`, `mif1`, `msf1`, and `avif`. Discovery still filters by supported filename extension, so a file with an arbitrary unsupported extension is not discovered even if its bytes are HEIF.

RAW support here means preview extraction, not RAW demosaicing. `exiftool` must be installed and the file must contain a usable `PreviewImage` or `JpgFromRaw`. `rawStatus` is normally `converted` or `failed`; the documented `no_converter` value is not emitted by this code.

EXIF extraction returns camera, lens, exposure, date, GPS, and orientation fields. Date strings come from `DateTimeOriginal` and are not normalized by Rust despite the type comment.

## Thumbnails

The four configured sizes are:

- `tiny`: 150px
- `small`: 400px
- `medium`: 800px
- `large`: 1600px

Thumbnails are WebP files under a mirrored, extension-stripped relative path:

```text
source:    2024/trip/photo.jpg
thumbnail: thumbnails/large/2024/trip/photo.webp
```

The original decoded image is resized with Lanczos3 at most once to create the bounded `large` preview (maximum dimension 1600px). `tiny`, `small`, and `medium` resize from that preview rather than repeatedly filtering the full-resolution source. Each output's target dimensions are still calculated from the original dimensions, preserving fit rounding without cumulative aspect-ratio drift. Images are never upscaled; when dimensions already match, `Cow::Borrowed` reuses the pixels instead of cloning them. Saving `large` likewise reuses the preview.

The `webp` crate's bundled libwebp encoder now applies the configured lossy color qualities: `tiny` 80, `small` 85, `medium` 85, and `large` 90. Alpha is encoded losslessly after resizing/conversion; this does not make resized pixels or lossy RGB output identical to the source or previous lossless thumbnails. RGB8/RGBA8 images are passed to the encoder without an extra pixel conversion; other formats convert to RGB8 or RGBA8 as appropriate. No separately installed codec binary is required.

`generate_thumbnails_from_file` has a different edge path from `process_photo_internal`: it checks HEIF by extension only and always applies the optional orientation. Preserve the unified batch path's magic-byte and no-double-rotation behavior when making scan changes.

This thumbnail optimization does not modify original files, EXIF extraction, orientation handling, or the full decoded-image pHash input. Thumbnail paths and the public N-API payloads are unchanged. Extension-stripped relative paths can still collide when different sources share a stem. See [import performance](../../docs/import-performance.md) for the production-photo sample measurements and their limits.

## CLIP Model

`src/clip.rs` lazily initializes and globally caches separate FastEmbed image and text models using `OnceCell<Mutex<_>>`. The model is `ClipVitB32`. `FASTEMBED_CACHE_DIR` is optional; without a populated cache the first call may download model files. Rust returns JavaScript-compatible `f64` arrays, while the API converts image vectors to `Float32Array` bytes before database storage.

## Native and Browser Boundaries

`browser.js` is a throwing stub used by Metro and browser builds. `apps/mobile/metro.config.js` redirects `@photobrain/image-processing` to this stub unconditionally. Keep the stub's exported names aligned with imports when adding client-facing native functions.

`wasi-worker-browser.mjs` is scaffolding, not an active WASM build. There is no current WASM output or build script.

## Native Dependencies and Tests

Local builds require Bun, Rust/Cargo, C build tools, `pkg-config`, OpenSSL headers, `libheif-dev`, and usually `libclang-dev`. Runtime execution also requires `libheif` and `exiftool` (`libimage-exiftool-perl` on Debian/Ubuntu). Docker installs these in the builder/runtime stages. The thumbnail encoder builds bundled libwebp through the Rust dependency; it adds no external codec executable to the runtime setup.

Rust tests cover HEIF extension/magic-byte detection, pure EXIF parsing and formatting (including orientations 1-8), command-level metadata batching through an injected runner, full-path alignment, reordered/duplicate/error records, argv bounds, fallback launch counts, and shared pool reuse/cap. Thumbnail tests now check decoded dimensions and fit rounding, no upscaling, constant/varying alpha and grayscale-alpha conversion, image structure within lossy tolerances, and unwritable destinations rather than byte identity with the old encoder. Batch tests check that success requires readable thumbnails at every size and that pHash still comes from the original decoded image. Fake metadata tests inspect the actual `Command` program/arguments and supply stdout/status without requiring ExifTool. Real RAW/EXIF/CLIP coverage still requires external camera files, `exiftool`, and potentially model downloads, so avoid making those implicit test prerequisites.

Stream regressions exercise the actual scheduler with controlled media work: a blocked early input while later-than-20 inputs complete, aligned failures, full-queue backpressure/cancellation with nested Rayon work, active-writer drain, panic cleanup, and empty/mismatched inputs. Real N-API smoke also paused result consumption and verified that thumbnail writes stopped after awaited close.

For focused verification, run `cargo test exif::tests`, `cargo test batch::tests`, `cargo test stream::tests`, and `cargo test thumbnails::tests`; these still compile the native crate and need its native build dependencies. Format only changed Rust files; use `rustfmt --edition 2024 --config skip_children=true src/lib.rs` when formatting the module root to avoid unrelated recursive formatting.
