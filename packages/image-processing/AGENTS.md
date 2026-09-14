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
- `processPhotosWithCallback(paths, relativePaths, thumbnailsDir, callback)`: parallel processing with blocking callbacks; completion order can differ from input order, and the return value is the number of input paths.
- `extractExif(path)`: returns `ExifData` or `null`.
- `generatePhash(path)`: direct decodable-image pHash helper.
- `perceptualHash(path)`: legacy alias for the same direct-file pHash helper.
- `generateThumbnailsFromFile(path, relativePath, baseDir, orientation)`: single-file thumbnail helper.
- `clipTextEmbedding(text)`: CLIP text vector.
- `batchGenerateClipEmbeddings(paths)`: aligned result array with `null` for failed inputs.

`processPhotosBatch` and the callback variant do not validate that `paths` and `relativePaths` have equal lengths. Missing relative entries become an empty string. Preserve index alignment at every caller.

The API awaits discovery, batch processing, and image embeddings through a persistent, single-operation worker thread (`apps/api/src/services/native-executor.ts`), validating batch path alignment before dispatch. The exports themselves remain synchronous. Database writes and Inngest state are not moved into the worker. Text-search and maintenance calls retain their direct native entrypoints; the import executor is not a global library lock or native crash-isolation boundary.

## Scan Processing Pipeline

`src/batch.rs` handles standard, RAW, and HEIF files:

1. Read filesystem metadata and timestamps.
2. Detect RAW by extension.
3. Detect HEIF by extension or magic bytes.
4. Use prefetched EXIF in batch/callback processing, or extract EXIF through one child `exiftool` process for single-photo processing.
5. Decode HEIF with `libheif-rs`.
6. Decode RAW through an embedded JPEG preview from `exiftool`.
7. Decode standard formats with `image::ImageReader`.
8. Apply EXIF orientation except for HEIF, because libheif applies container transforms.
9. Generate a double-gradient pHash.
10. Generate four WebP thumbnails.

Batch and callback calls share one lazily initialized `OnceLock` Rayon pool with `min(max(cpu_count, 1), 4)` threads, including nested thumbnail work. Pool creation failure is explicit; there is no fallback to an uncapped pool. Single-photo and standalone thumbnail helpers retain their existing execution paths. Thumbnail generation errors are logged as warnings by the batch path, but the result may still have `success: true`; callers must not treat that flag as proof that all thumbnail files exist.

Batch and callback processing prefetch metadata for at most 20 input files, process that chunk, then advance to the next chunk. This bounds metadata buffering and allows callback queueing without waiting for metadata for the entire import. Array results remain input-aligned; callbacks are queued in completion order within each chunk. Thread-safe-function blocking mode waits for queue capacity, not for JavaScript callback completion or database persistence.

Metadata commands retain the selected tags and `-json -n` numeric output, explicitly request `-Error` for per-file failure detection, use direct process arguments (no shell), and terminate options with `--`. Each command has at most 20 unique absolute paths and 32 KiB of path-argument bytes, including NUL separators. Long paths split commands earlier; an individual argument exceeding that budget yields no metadata without launching an oversized command. This is a conservative argv bound, not a guarantee against OS/environment limits; spawn failures follow the same bounded recovery path.

JSON records are associated by absolute `SourceFile`, never array position or basename. Paths are not canonicalized: differently named symlinks must retain their suffix because RAW metadata interpretation can depend on it. Repeated absolute paths within a metadata chunk share extraction and receive aligned copies. Valid records, including empty-metadata records without errors, survive mixed nonzero exits; error records cannot replace valid metadata. Only unresolved unique inputs receive one individual retry after a multi-file command. A singleton command is already the individual attempt and is not retried. Malformed JSON cannot be partially recovered and therefore takes the unresolved-input path. RAW binary `PreviewImage`/`JpgFromRaw` extraction remains separate and unchanged; there is no persistent `stay_open` process.

Healthy typical-path imports use one metadata launch per 20 inputs (45 files: 20/20/5, three launches instead of 45). A failed multi-file command can cost one launch plus one retry per unresolved unique input. RAW preview launches are additional and are not reduced by metadata batching. These are command-count expectations covered by injected-runner tests, not measured throughput claims.

Each batch/callback invocation emits one aggregate timing line containing file count, EXIF wall milliseconds (including retries), and processing wall milliseconds. Callback processing time includes callback queueing. Timings exclude pool initialization, do not sum per-image CPU times, and do not log paths or metadata; existing thumbnail failure warnings remain unchanged.

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

The `quality` values in `ThumbnailSizes` are currently not passed to the image crate encoder. The current save path uses the default WebP behavior, documented in source as lossless. Do not claim quality tuning is active without changing the encoder implementation.

The no-resize path borrows the decoded image rather than cloning its pixels. Resize dimensions, Lanczos3 filtering, WebP encoding, and thumbnail paths are unchanged; a regression test compares output bytes against the previous clone/resize implementation for RGB and RGBA images.

`generate_thumbnails_from_file` has a different edge path from `process_photo_internal`: it checks HEIF by extension only and always applies the optional orientation. Preserve the unified batch path's magic-byte and no-double-rotation behavior when making scan changes.

## CLIP Model

`src/clip.rs` lazily initializes and globally caches separate FastEmbed image and text models using `OnceCell<Mutex<_>>`. The model is `ClipVitB32`. `FASTEMBED_CACHE_DIR` is optional; without a populated cache the first call may download model files. Rust returns JavaScript-compatible `f64` arrays, while the API converts image vectors to `Float32Array` bytes before database storage.

## Native and Browser Boundaries

`browser.js` is a throwing stub used by Metro and browser builds. `apps/mobile/metro.config.js` redirects `@photobrain/image-processing` to this stub unconditionally. Keep the stub's exported names aligned with imports when adding client-facing native functions.

`wasi-worker-browser.mjs` is scaffolding, not an active WASM build. There is no current WASM output or build script.

## Native Dependencies and Tests

Local builds require Bun, Rust/Cargo, C build tools, `pkg-config`, OpenSSL headers, `libheif-dev`, and usually `libclang-dev`. Runtime execution also requires `libheif` and `exiftool` (`libimage-exiftool-perl` on Debian/Ubuntu). Docker installs these in the builder/runtime stages.

Rust tests cover HEIF extension/magic-byte detection, pure EXIF parsing and formatting (including orientations 1-8), command-level metadata batching through an injected runner, full-path alignment, reordered/duplicate/error records, argv bounds, fallback launch counts, shared pool reuse/cap, and thumbnail byte equivalence. Fake metadata tests inspect the actual `Command` program/arguments and supply stdout/status without requiring ExifTool. Real RAW/EXIF/CLIP coverage still requires external camera files, `exiftool`, and potentially model downloads, so avoid making those implicit test prerequisites.

For focused verification, run `cargo test exif::tests`, `cargo test batch::tests`, and `cargo test thumbnails::tests`; these still compile the native crate and need its native build dependencies. Format changed Rust files with `rustfmt --edition 2024 src/exif.rs src/batch.rs src/thumbnails.rs` (add `--check` for read-only validation).
