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

## Scan Processing Pipeline

`src/batch.rs` handles standard, RAW, and HEIF files:

1. Read filesystem metadata and timestamps.
2. Detect RAW by extension.
3. Detect HEIF by extension or magic bytes.
4. Extract EXIF through a child `exiftool` process.
5. Decode HEIF with `libheif-rs`.
6. Decode RAW through an embedded JPEG preview from `exiftool`.
7. Decode standard formats with `image::ImageReader`.
8. Apply EXIF orientation except for HEIF, because libheif applies container transforms.
9. Generate a double-gradient pHash.
10. Generate four WebP thumbnails.

The Rayon pool is capped at four threads. Thumbnail generation errors are logged as warnings by the batch path, but the result may still have `success: true`; callers must not treat that flag as proof that all thumbnail files exist.

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

`generate_thumbnails_from_file` has a different edge path from `process_photo_internal`: it checks HEIF by extension only and always applies the optional orientation. Preserve the unified batch path's magic-byte and no-double-rotation behavior when making scan changes.

## CLIP Model

`src/clip.rs` lazily initializes and globally caches separate FastEmbed image and text models using `OnceCell<Mutex<_>>`. The model is `ClipVitB32`. `FASTEMBED_CACHE_DIR` is optional; without a populated cache the first call may download model files. Rust returns JavaScript-compatible `f64` arrays, while the API converts image vectors to `Float32Array` bytes before database storage.

## Native and Browser Boundaries

`browser.js` is a throwing stub used by Metro and browser builds. `apps/mobile/metro.config.js` redirects `@photobrain/image-processing` to this stub unconditionally. Keep the stub's exported names aligned with imports when adding client-facing native functions.

`wasi-worker-browser.mjs` is scaffolding, not an active WASM build. There is no current WASM output or build script.

## Native Dependencies and Tests

Local builds require Bun, Rust/Cargo, C build tools, `pkg-config`, OpenSSL headers, `libheif-dev`, and usually `libclang-dev`. Runtime execution also requires `libheif` and `exiftool` (`libimage-exiftool-perl` on Debian/Ubuntu). Docker installs these in the builder/runtime stages.

The committed Rust tests are currently focused on HEIF extension and magic-byte detection. Real RAW/EXIF/CLIP coverage requires external camera files, `exiftool`, and potentially model downloads, so avoid making those implicit test prerequisites.
