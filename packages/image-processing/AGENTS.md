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
- `isSupportedMedia(path)`: case-insensitive suffix check for stills and videos (renamed from `isSupportedImage`).
- `getSupportedExtensions()`: extensions include the leading dot.
- `processPhoto(path, relativePath, thumbnailsDir)`: synchronous single-file processing. Every `PhotoProcessingResult` carries `mediaType: "photo" | "video"`, `durationMs: number | null`, and `videoCodec: string | null` (always present, `null` rather than absent); photos report `"photo"` with both nulls and are otherwise unchanged.
- `processPhotosBatch(paths, relativePaths, thumbnailsDir)`: parallel processing with result order matching input paths.
- `startPhotoProcessing(paths, relativePaths, thumbnailsDir, thumbnailPaths?)`: returns a single-consumer `PhotoProcessingStream`; `next(): Promise<{ index, result } | null>` yields completion order with original input indices, and `close(): Promise<void>` cancels dispatch and waits for active metadata/writers. Optional aligned thumbnail-relative output keys affect only thumbnail writes; results retain the original source path and name.
- `extractExif(path)`: returns `ExifData` or `null`.
- `generatePhash(path)`: direct decodable-image pHash helper.
- `perceptualHash(path)`: legacy alias for the same direct-file pHash helper.
- `generateThumbnailsFromFile(path, relativePath, baseDir, orientation)`: single-file thumbnail helper.
- `validateThumbnails(items, baseDir)`: synchronous, input-aligned `boolean[]` for `{ path, width, height }` items. `path` is a thumbnail-relative key (the original relative path for legacy thumbnails); dimensions describe the orientation-corrected decoded source. Uses the shared bounded Rayon pool to fully decode all four WebPs and check the generation helper's exact no-upscale fit dimensions. Missing, corrupt, wrong-format, wrong-size, or zero-dimension items return `false`; pool initialization errors still throw.
- `clipTextEmbedding(text)`: CLIP text vector.
- `batchGenerateClipEmbeddings(paths)`: aligned result array with `null` for failed inputs.
- `analyzeImageQuality(paths)`: input-aligned `{ sharpness, brightness } | null` per path (`src/quality.rs`). Decodes each image (the API passes `medium` WebP thumbnails), converts to luma, downscales with a triangle filter so the long edge is at most 512, and reports `sharpness` = the highest variance of the 4-neighbour 3x3 Laplacian among a grid of up to 4x4 tiles over the interior (fewer tiles on an axis shorter than 8 Laplacian samples per tile, down to one whole-frame tile), so a sharp subject surrounded by flat sky or fog is not averaged into a blur score; `brightness` = mean luma 0-255. Runs on the shared bounded Rayon pool; unreadable or undecodable paths yield `null` and never panic. Images under 3 pixels on a side have sharpness 0. The API's blur/dark thresholds are calibrated against this exact metric; changing it requires bumping the API's `QUALITY_VERSION`.
- `groupNearDuplicates(ids, hashes, maxDistance)`: synchronous, pure; index-aligned IDs and base64 pHashes (the unpadded `to_base64` form stored in `photo_phash.hash`) → `[{ ids, maxDistance }]` connected components of size >= 2, IDs ascending, groups ordered by first ID (`src/duplicates.rs`). Hashes are decoded with `ImageHash::from_base64` and packed into `u64`; undecodable, empty, or over-64-bit hashes are skipped, and hashes are compared only with hashes of the same width. Grouping is transitive; `maxDistance` is the component's largest pairwise distance. Candidates come from multi-index hashing: identical hashes are collapsed, each hash is split into `maxDistance + 1` disjoint bit ranges, and only hashes agreeing exactly on some range (pigeonhole) are compared and unioned. A threshold at or above the hash width groups everything. Mismatched array lengths throw. The scan pipeline's DoubleGradient 8x8 hash is 40 bits (5 bytes).
- `renderExportJpeg(path, maxEdge, quality)`: synchronous `Buffer` of a baseline JPEG (`src/export.rs`). Decodes through the shared `src/decode.rs` path that `batch.rs` also uses (`decode_source`: HEIF via libheif with container transforms, RAW embedded preview, standard formats; EXIF orientation applied to the pixels, never re-applied to HEIF). Resizes with Lanczos3 only when the long edge exceeds `maxEdge` (aspect preserved, never upscaled), converts alpha/16-bit to RGB8, and encodes with the `image` crate JPEG encoder: no EXIF/XMP/ICC/GPS segments. Rejects `maxEdge` 0 and quality outside 1-100. It does not use the Rayon processing pool, so the API runs it on its worker beside an open scan stream (`cargo test export`).
- `detectFaces(paths)`: input-aligned `{ path, success, faces: [{ box: {x,y,width,height} (0-1 of the oriented input), score, embedding (128 f64, L2-normalized) }], error }` (`src/faces/`). Runs on the shared Rayon pool; a failing path yields `success: false` only for itself; model download/load failures throw. See [Faces](#faces).
- `clusterFaceEmbeddings(embeddings: Float32Array, dimension, threshold, minClusterSize)`: deterministic groups (members ascending, groups by smallest member) of size >= `minClusterSize` (`src/faces/cluster.rs`).
- `renderFaceCrop(path, box, size)`: synchronous square WebP (q85) `Buffer`, `size` 64-512, centred on the box with side 1.6x its longer pixel side, shrunk/shifted to fit inside the image; alpha composited over white.

The streaming API rejects mismatched file, relative, and optional thumbnail path arrays and permits one pending `next()` call. Omitting thumbnail paths preserves mirrored source-path output. `processPhoto` and `processPhotosBatch` retain their existing signatures and output layout. The batch helper remains synchronous and input-aligned; callers must preserve paired arrays (the API executor validates them). Stream cancellation discards buffered results, not acknowledged SQLite receipts.

The API uses a persistent worker thread for discovery, thumbnail validation, streaming media, HEIC maintenance, and image embeddings. It retains one stream across completion windows and acknowledges each result after API-thread persistence. Other native work or another job cancels/drains that stream before replacement. Public stream pulls/close are asynchronous N-API tasks; synchronous helper exports remain available. The executor is not a global library lock or native process-crash boundary.

## Scan Processing Pipeline

`src/batch.rs` handles standard, RAW, HEIF, and video files. `process_photo_internal` routes `.mp4`/`.mov`/`.m4v` to `src/video.rs` by extension after reading filesystem metadata and the (prefetched) EXIF, so streaming, cancellation, and the result envelope are shared. Stills:

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

Videos (`src/video.rs`):

1. `ffprobe -v error -print_format json -show_format -show_streams file:<path>` selects the first video stream that is not an attached picture. Duration comes from `format.duration`, falling back to the stream duration; non-positive or missing durations are `null`. Width/height are display dimensions: swapped when the rotation (`side_data_list` Display Matrix `rotation`, else `tags.rotate`, normalized to 0-359) is 90 or 270. `videoCodec` is the stream's `codec_name` (`h264`, `hevc`, ...). No video stream or no dimensions fails the result.
2. `ffmpeg -nostdin -v error [-ss t] -i file:<path> -map 0:<stream> -frames:v 1 -pix_fmt rgb24 -compression_level 1 -f image2pipe -vcodec png -` decodes one poster frame with ffmpeg's default autorotation at `t = min(1 s, duration / 2)` (first frame for unknown duration). If the seek yields no decodable frame (for example a corrupt tail), it retries once at 0; a missing binary, timeout, or overflow is not retried. A complete PNG is accepted even when ffmpeg exits nonzero after it.
3. The poster goes through the same pHash and four-WebP thumbnail path as a decoded still; EXIF orientation is never applied to it. `mimeType` is `video/mp4`, `video/quicktime`, or `video/x-m4v`; `isRaw` is false.

Both executables are spawned directly (no shell; paths are passed as `file:` URLs so names with `:` are not protocols) through `run_with_timeout(command, timeout, stdout_cap)`: stdout/stderr are read on helper threads, the child is polled, and on the 30 s timeout or when stdout exceeds its cap (8 MiB probe JSON, 64 MiB poster PNG) it is killed and reaped. Stderr keeps 64 KiB of diagnostics. Failures return `success: false` with an error naming the tool (e.g. "ffprobe executable `…` not found; install ffmpeg or set FFPROBE_BIN", "ffmpeg timed out after 30 s", "File has no video stream") while preserving identity, size, timestamps, EXIF, and `mediaType: "video"`; the scan records a failed receipt as for any decode failure.

Media calls reuse one lazily initialized Rayon pool sized by `std::thread::available_parallelism()` or a positive `PHOTO_PROCESSING_THREADS` override. Initialization/configuration errors become JavaScript exceptions. Single-photo processing also enters this pool; nested thumbnail work shares it. A successful photo requires all four thumbnail writes; failures return `success: false`, and partial files may remain.

`src/stream.rs` has an independent EXIF producer and CPU-count dispatch threads feeding that Rayon pool. Ready and result channels each hold at most twice the worker count; the producer additionally holds one metadata chunk of at most 20. At most worker-count photos are in media processing. Dispatch/result-channel waits do not occupy Rayon workers, avoiding nested thumbnail starvation. Workers take the next ready photo without waiting for a metadata chunk's other photos to finish. The synchronous batch helper retains chunk barriers and is not the normal scan path.

`close()` broadcasts cancellation before scheduling its N-API async join, wakes blocked queues, and waits for active metadata and writers. This avoids libuv starvation when `next()` is blocked. GC cancellation is nonblocking; explicit close is the writer-drain boundary. Startup, I/O/ExifTool, persistence backpressure, and the last stragglers can still prevent 100% CPU utilization.

Metadata commands retain the selected tags and `-json -n` numeric output, explicitly request `-Error` for per-file failure detection, use direct process arguments (no shell), and terminate options with `--`. Each command has at most 20 unique absolute paths and 32 KiB of path-argument bytes, including NUL separators. Long paths split commands earlier; an individual argument exceeding that budget yields no metadata without launching an oversized command. This is a conservative argv bound, not a guarantee against OS/environment limits; spawn failures follow the same bounded recovery path.

JSON records are associated by absolute `SourceFile`, never array position or basename. Paths are not canonicalized: differently named symlinks must retain their suffix because RAW metadata interpretation can depend on it. Repeated absolute paths within a metadata chunk share extraction and receive aligned copies. Valid records, including empty-metadata records without errors, survive mixed nonzero exits; error records cannot replace valid metadata. Only unresolved unique inputs receive one individual retry after a multi-file command. A singleton command is already the individual attempt and is not retried. Malformed JSON cannot be partially recovered and therefore takes the unresolved-input path. RAW binary `PreviewImage`/`JpgFromRaw` extraction remains separate and unchanged; there is no persistent `stay_open` process.

Healthy typical-path imports use one metadata launch per 20 inputs (45 files: 20/20/5, three launches instead of 45). A failed multi-file command can cost one launch plus one retry per unresolved unique input. RAW preview launches are additional and are not reduced by metadata batching. These are command-count expectations covered by injected-runner tests, not measured throughput claims.

The synchronous batch helper logs aggregate EXIF and processing wall time. Streaming phases overlap, so its sequential batch timings must not be interpreted as streaming-stage CPU utilization. See the real-photo benchmark for process CPU, elapsed time, and peak RSS.

CLIP embeddings are intentionally not generated in this pipeline. The API's Inngest embedding function later reads generated `large` thumbnails and calls `batchGenerateClipEmbeddings` in groups of 16.

## Supported Files

Video extensions (posters via ffmpeg):

```text
.mp4 .mov .m4v
```

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

EXIF extraction returns camera, lens, exposure, date, GPS, and orientation fields. The batched command also requests `CreationDate` and `CreateDate`. Still-image `dateTaken` is the raw `DateTimeOriginal` string (not normalized by Rust despite the type comment); `CreationDate`/`CreateDate` never override it. For videos (by extension of `SourceFile`), `dateTaken` is the QuickTime `CreationDate` wall clock with subseconds and any offset stripped (Apple devices write local time + offset), else `CreateDate` as stored, which by the QuickTime spec is UTC (a documented limitation for clips without `CreationDate`). All-zero placeholder dates count as absent. Make/model and composite GPS parse as for stills.

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

This thumbnail optimization does not modify original files, EXIF extraction, orientation handling, or the full decoded-image pHash input. Default extension-stripped relative paths can collide when different sources share a stem. Incremental scans supply collision-free per-attempt output keys such as `.versions/<uuid>/photo.ext`, producing `{size}/.versions/<uuid>/photo.webp` while keeping result identity tied to the original file. Thumbnail validation also accepts these keys; for one-time legacy adoption, callers must separately establish unambiguous source identity because decoded dimensions cannot detect same-stem content collisions. No encoding or quality settings change. See [import performance](../../docs/import-performance.md) for the production-photo sample measurements and their limits.

## CLIP Model

`src/clip.rs` lazily initializes and globally caches separate FastEmbed image and text models using `OnceCell<Mutex<_>>`. The model is `ClipVitB32`. `FASTEMBED_CACHE_DIR` is optional; without a populated cache the first call may download model files. Rust returns JavaScript-compatible `f64` arrays, while the API converts image vectors to `Float32Array` bytes before database storage.

## Faces

`src/faces/` implements F19 face grouping. `mod.rs` holds the N-API surface; `models.rs` model files; `detect.rs` YuNet pre/post-processing; `align.rs` the similarity transform and warp; `pixels.rs` the borrowed decode (WebP through bundled libwebp without a copy, other formats through `image`; no EXIF orientation, thumbnails are already oriented); `cluster.rs` clustering.

Models (both download lazily on first `detectFaces`, never at load or build time):

|Model|Source|License|Size / sha256|
|---|---|---|---|
|YuNet `face_detection_yunet_2023mar.onnx`|`huggingface.co/opencv/face_detection_yunet`|MIT|232,589 B / `8f2383e4…52fa4`|
|SFace `face_recognition_sface_2021dec.onnx`|`huggingface.co/opencv/face_recognition_sface`|Apache-2.0|38,696,353 B / `0ba9fbfa…34e79`|

Cache directory: `FACE_MODEL_DIR`, else `$FASTEMBED_CACHE_DIR/faces`, else `.face_models` in the working directory (empty variables count as unset; `.face_models/` is gitignored). A cached file is used only if its size and SHA-256 match; otherwise it is re-downloaded with `ureq` into a temp file in the same directory, verified, and atomically renamed. A mismatch is an error and leaves no file. Sessions use the `ort` version fastembed already pins (`=2.0.0-rc.9`, one ONNX Runtime), are built once per process (`OnceLock` + loading mutex, so a failed download retries on the next call), and run with one intra/inter-op thread because callers parallelize across images.

Pipeline per path: decode; area-resample to a long edge <= 640 (never upscaled) as planar BGR 0-255, zero-padded right/bottom to a multiple of 32. YuNet 2023mar declares a fixed 1x3x640x640 input; `models::make_dims_symbolic` rewrites the in-memory ONNX shape protos of `input` and the 12 heads to symbolic dims so any padded size runs (the file on disk keeps its digest). Heads `cls_/obj_/bbox_/kps_{8,16,32}` are decoded per grid cell as in OpenCV `FaceDetectorYN`: score `sqrt(clamp(cls)*clamp(obj))`, centre `(col + dx) * stride`, size `exp(dw) * stride`, landmarks `(col + kx) * stride`; then NMS at IoU 0.3 (stable, score-descending). Boxes and landmarks scale back to input pixels; faces below `FACE_MIN_SCORE` or with a short side below `FACE_MIN_PIXELS` are dropped. Each kept face's 5 landmarks are fitted by least squares (Umeyama, closed form in complex arithmetic) onto the ArcFace 112x112 template; the crop is bilinearly sampled from the full-resolution pixels (black outside), fed to SFace as RGB 0-255 planar (no mean/scale), and the 128-d output is L2-normalized. SFace runs one crop per call: the model has a fixed batch of 1 and relaxing it measured slower than per-crop runs (batch 2: 25 ms vs 2 x 5.7 ms).

Clustering (`cluster.rs`): unit-normalize; each vector ranks its `CANDIDATE_NEIGHBORS` (32) most similar others with cosine >= threshold (ties by lower index; similarity rows computed in parallel fixed blocks); an edge exists only between mutual neighbours. Average-linkage agglomeration then merges, along those edges only, the adjacent pair of groups with the highest average cross-pair cosine while it is >= threshold (for unit vectors the average is `sum(A)·sum(B) / (|A||B|)`, so each group keeps only its vector sum; merges follow a total order: higher average, then lower ids). A chain of pairwise-similar faces cannot fuse two people because a merge needs similarity on average across both groups. Output is identical across pool sizes.

Calibration (2026-10, not committed; fixtures under `/tmp/pb-f19-faces`): LFW (703 images, 75 identities, 250x250), WIDER FACE val (60 images with box annotations), Food-101 (45 face-free images).

- Detection (WIDER boxes IoU >= 0.4, recall over annotated faces with short side >= the pixel floor): score 0.70/40 px precision 1.000, recall 0.846, 1 face-free false positive; **0.75/40 px precision 1.000 (113/113), recall 0.831, 0 false positives on face-free images**; 0.80/40 px recall 0.785. Lower pixel floors cut recall/precision and embedding quality.
- Embedding vs face size (LFW downscaled, same-person median cosine / pair recall at 0.48): 24 px 0.58/0.78, 32 px 0.63/0.90, 40 px 0.67/0.95, 64 px 0.70/0.97. Different-person p99.9 stays ~0.38.
- LFW full size: same-person cosine p1/p5/p50 0.41/0.52/0.70; different-person p99/p99.9/max 0.31/0.38/0.49. Pair threshold 0.48: precision 0.9999, recall 0.974.
- Clustering LFW (threshold, min size → groups, purity, pair precision/recall, coverage): 0.42/3 → 75, 1.000, 1.000/0.968, 98.3%; **0.48/3 → 74 (one 8-image identity left unclustered), 1.000, 1.000/0.962, 97.0%, no identity split**; 0.55/3 → 76, 1.000, 1.000/0.930, 93.3%, 2 split.
- Centroid assignment (leave-one-out): closed-set precision 1.000 at every threshold 0.42-0.55. Open-set false assignment (the face's person has no centroid): 0.42 5.4%, 0.45 1.7%, 0.48 0.7%, **0.50 0.0%** with 99.1% recall.

Constants: `FACE_MIN_SCORE = 0.75`, `FACE_MIN_PIXELS = 40` (Rust, `faces/mod.rs`); recommended API values `FACE_ASSIGN_THRESHOLD = 0.50`, `FACE_CLUSTER_THRESHOLD = 0.48`, `FACE_MIN_CLUSTER_SIZE = 3`.

Performance (Apple M4 Pro, release addon): `detectFaces([path])` on 1600 px WebP thumbnails with 0-3 faces, single path per call after warmup: median 39.4 ms, p90 56.9 ms (120 calls); a 40-path call on the pool: 226 ms. `clusterFaceEmbeddings` on 20,000 x 128 (200 planted clusters of 40 at pairwise cosine ~0.64 plus 12,000 random): median 189 ms, all 200 planted clusters recovered exactly, no noise merged.

## Native and Browser Boundaries

`browser.js` is a throwing stub used by Metro and browser builds. `apps/mobile/metro.config.js` redirects `@photobrain/image-processing` to this stub unconditionally. Keep the stub's exported names aligned with imports when adding client-facing native functions.

`wasi-worker-browser.mjs` is scaffolding, not an active WASM build. There is no current WASM output or build script.

## Native Dependencies and Tests

Local builds require Bun, Rust/Cargo, C build tools, `pkg-config`, OpenSSL headers, `libheif-dev`, and usually `libclang-dev`. Runtime execution also requires `libheif`, `exiftool` (`libimage-exiftool-perl` on Debian/Ubuntu), and `ffmpeg`/`ffprobe` for videos (the Debian `ffmpeg` package; the API Docker stage installs it). `FFPROBE_BIN` and `FFMPEG_BIN` override the executable names/paths (default `ffprobe`/`ffmpeg` on `PATH`); empty values fall back to the defaults. Without them, stills still process and videos fail with a clear error. The thumbnail encoder builds bundled libwebp through the Rust dependency; it adds no external codec executable to the runtime setup.

Video tests (`cargo test video`, plus the video cases in `batch::tests`, `stream::tests`, and `exif::tests`) generate clips at test time with `ffmpeg` (`testsrc2`/`color` sources, libx264, libx265, AAC) and fail loudly, never skip, when ffmpeg/ffprobe/exiftool are missing; CI does not run cargo tests. They cover h264 MP4 and hevc MOV duration/dims/codec, 90° rotation swapping dims with a portrait poster, rotation sources/angles in probe JSON, poster time `min(1 s, duration/2)` verified by frame luma (a 0.5 s clip's poster is the 0.25 s frame), corrupt-tail fallback to the first frame, frameless and audio-only failures, missing binaries including a `FFPROBE_BIN=/nonexistent` child process, `run_with_timeout` killing `sleep 5` within a 200 ms timeout, the inclusive stdout cap, bounded stderr, video date precedence (CreationDate with offset over CreateDate; DateTimeOriginal still wins for photos), and a discovered mixed JPEG/PNG/MP4/MOV streaming run with media types and four poster WebPs per video.

Rust tests cover HEIF extension/magic-byte detection, pure EXIF parsing and formatting (including orientations 1-8), command-level metadata batching through an injected runner, full-path alignment, reordered/duplicate/error records, argv bounds, fallback launch counts, and shared pool reuse/cap. Thumbnail tests now check decoded dimensions and fit rounding, no upscaling, constant/varying alpha and grayscale-alpha conversion, image structure within lossy tolerances, and unwritable destinations rather than byte identity with the old encoder. Batch tests check that success requires readable thumbnails at every size and that pHash still comes from the original decoded image. Fake metadata tests inspect the actual `Command` program/arguments and supply stdout/status without requiring ExifTool. Real RAW/EXIF/CLIP coverage still requires external camera files, `exiftool`, and potentially model downloads, so avoid making those implicit test prerequisites.

Stream regressions exercise the actual scheduler with controlled media work: a blocked early input while later-than-20 inputs complete, aligned failures, full-queue backpressure/cancellation with nested Rayon work, active-writer drain, panic cleanup, and empty/mismatched inputs. Output-key regressions process generated standard-image fixtures through the public stream, checking same-stem isolation, unchanged source identity on success/failure, and the default mirrored output layout. Those public-stream tests invoke the normal ExifTool metadata path (absent metadata remains supported). Validation regressions cover fit rounding, no upscaling, versioned keys, aligned mixed results, missing/corrupt/wrong-format/wrong-size WebPs, and invalid dimensions. Real N-API smoke previously paused result consumption and verified that thumbnail writes stopped after awaited close.

For focused verification, run `cargo test exif::tests`, `cargo test batch::tests`, `cargo test stream::tests`, `cargo test thumbnails::tests`, and `cargo test quality::tests`; these still compile the native crate and need its native build dependencies. Format only changed Rust files; use `rustfmt --edition 2024 --config skip_children=true src/lib.rs` when formatting the module root to avoid unrelated recursive formatting.

`src/duplicates.rs` tests cover the distance boundary (threshold grouped, +1 not), transitive grouping with the reported diameter, identical hashes, skipping undecodable and over-64-bit hashes, never comparing different widths, the full-width threshold, rejection of misaligned inputs, that real pipeline hashes are 40 bits, and multi-index components matching brute force over random hashes at several thresholds (`cargo test duplicates`).

`src/faces/` tests (`cargo test faces`, no network) cover: Umeyama recovering a known similarity and mapping landmarks onto the template, least-squares fits of noisy landmarks, degenerate landmarks, bilinear warp sampling with black borders; YuNet multi-stride decoding on synthetic tensors (score formula, threshold, grid offsets, landmark order), mismatched head sizes, NMS overlap/tie determinism, area-resampled padded BGR blobs; clustering chain resistance (two tight clusters bridged by a chain stay separate), inclusive thresholds, min cluster size, invalid shapes, planted-cluster recovery, and identical output across pool sizes; crop geometry centring/clamping at every edge and WebP crop rendering; model cache precedence, a loopback HTTP download installed atomically and then served from cache, SHA-256 and size mismatches (including oversized bodies) rejected with no file left, corrupt cache replacement, and unreachable servers. `cargo test faces -- --ignored` runs the real models over `/tmp/pb-f19-faces/library` (set `FACE_MODEL_DIR` to a populated cache to avoid the download).
