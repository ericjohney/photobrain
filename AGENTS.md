# AGENTS.md - PhotoBrain Agent Guide

This is the current implementation guide for agents working in PhotoBrain. Prefer the source tree and the scoped guides linked below over older roadmap notes or generated artifacts.

## Read First

- This repository is a Bun/Turbo monorepo with four applications and four shared packages.
- There is no `apps/worker` directory, BullMQ consumer, or Redis requirement in the current implementation.
- Background scan and embedding functions are Inngest functions registered by the API at `/api/inngest`.
- Image processing is a native Rust N-API addon. It is not an active WASM implementation.
- EXIF extraction and RAW preview extraction invoke the external `exiftool` executable.
- The shared database schema is authoritative. `apps/api/src/db/schema.ts` re-exports it and defines the public photo projection used by tRPC and `/api/v1`; private source/artifact identities must not cross either client boundary.
- `README.md` is for user/developer setup. `ROADMAP.md` is forward-looking and may contain historical session notes. The scoped `AGENTS.md` files below are the detailed agent guides.

## Documentation Map

Read the guide for the area being changed:

- [API and background jobs](apps/api/AGENTS.md)
- [Web application](apps/web/AGENTS.md)
- [Native iOS application source and XCTest](apps/ios); [TestFlight distribution, signing, and secrets](docs/ios-distribution.md)
- [Expo Android/web application](apps/mobile/AGENTS.md)
- [Rust image processing](packages/image-processing/AGENTS.md)
- [Database and migrations](packages/db/AGENTS.md)
- [Shared utilities](packages/utils/AGENTS.md)
- [Shared TypeScript configuration](packages/config/AGENTS.md)
- [Import performance and architectural options](docs/import-performance.md)

Historical implementation plans live under `docs/superpowers/`. They document past decisions and are not a substitute for checking the current source.

## Repository Map

```text
apps/
  api/                    Hono server, tRPC router, REST file routes, Inngest functions
  web/                    React/Vite browser application
  ios/                    Native SwiftUI/UIKit iOS application (iOS 17+)
  mobile/                 Expo/React Native Android/web app
packages/
  config/                 Shared TypeScript configuration package
  db/                     Drizzle schema and migration files
  image-processing/       Rust N-API addon and browser/Metro stubs
  utils/                  Shared TypeScript helpers and thumbnail configuration
docs/
  superpowers/            Historical design specifications and implementation plans
.github/workflows/        CI, Android EAS updates, native iOS CI/releases, and ArgoCD tag updates
Dockerfile                Five targets: builder, api, web-builder, web, mobile
```

## Runtime Architecture

### API and jobs

The API entrypoint is `apps/api/src/index.ts`:

1. Hono serves `/api/health`.
2. tRPC handles `/api/trpc/*` using the router in `apps/api/src/trpc/router.ts`.
3. The compatibility JSON API is mounted at `/api/v1` for the native Swift client.
4. REST routes under `/api/photos/*` stream original files and generated thumbnails.
5. Inngest serves `GET`, `PUT`, and `POST /api/inngest` and registers the scan, embedding, tag-backfill, and quality-backfill functions.

The tRPC and `/api/v1` metadata, search, and scan contracts share the catalog/search/scan-job service layer rather than maintaining separate domain implementations. `/api/v1` explicitly serializes public DTOs and strips `sourceRoot`, `sourceFingerprint`, `mediaVersion`, `thumbnailKey`, `thumbnailRoot`, and `thumbnailFingerprint`. Its scan-start mutation is disabled by default and returns `503 NATIVE_SCAN_DISABLED` unless `V1_NATIVE_SCAN_MUTATIONS_ENABLED=true` (or `1`); read-only catalog, search, and scan-status routes remain available.

The scan flow is:

1. `trpc.scan()` defaults to incremental processing; `{ force: true }` explicitly reprocesses every discovered file. It creates a durable queued `scan_jobs` row, then sends an idempotently keyed `photos/scan.requested` event.
2. `scan-photos-v5` freezes discovery and media/embedding/skip classification in SQLite `scan_manifests`/`scan_items`, stably ordering new paths before existing paths while preserving absolute/relative pairing.
3. Unchanged, complete media retains its ID, artifacts, and cache timestamp. New, changed, or incomplete media enters a persistent Rust `startPhotoProcessing` stream feeding the available-CPU-sized pool without input-batch barriers. Each attempt writes to its own collision-free thumbnail key.
4. Each completion checks the frozen source fingerprint, current attempt, and previous committed generation before atomically saving photo/EXIF/pHash data, artifact identity, receipt, counters, and progress. The API acknowledges persistence before pulling the next result. Inngest checkpoints every 20 completions; retries load only pending receipts. Native processing and network publication stay outside SQLite transactions.
5. Only current-generation photos requiring embeddings enter the final `photos/embeddings.requested` event: regenerated media and otherwise unchanged photos with missing, failed, outdated, or malformed vectors. Fully indexed unchanged scans complete without that event. The parent performs no progress writes after dispatch.
6. `generate-embeddings-v3` reads committed `large` thumbnail roots/keys in batches of 16. Inference, generation-checked vector/status saves, and progress publication share one checkpoint per batch; stale results cannot overwrite a newer photo generation.
7. Automatic tags: `saveEmbeddingBatch` scores each saved current-generation vector against the lazily embedded, memoized vocabulary in `tag-vocabulary.ts` (softmax over 100×cosine, ≥ `TAG_MIN_PROBABILITY` 0.15, at most 3) and replaces its `photo_tags` in the same transaction. A final appended step of `generate-embeddings-v3`, or of `scan-photos-v5` when no embeddings are dispatched, sends `photos/tags.requested` and `photos/quality.requested` together; `tag-photos-v1` (concurrency 1) backfills vectors whose `tags_version` is null or outdated, 1,000 per generation-checked step. Bump `TAG_VOCABULARY_VERSION` when labels or scoring change.
8. Image quality: `analyze-quality-v1` (concurrency 1) measures the committed `medium` thumbnail of photos whose `photo_quality` row is missing, from another thumbnail generation, or from an older `QUALITY_VERSION`, 200 per step through the native executor's `analyzeImageQuality` (Laplacian-variance sharpness and mean luma on a ≤512 px luma downscale), with a generation-checked write.
9. Place names: `place-photos-v1` (concurrency 1, on `photos/places.requested`, sent in the same trigger step as tags and quality) reverse-geocodes valid GPS offline against the committed GeoNames artifact `apps/api/src/data/places.tsv.gz` (cities ≥ 5,000 people, CC BY 4.0; regenerate with `cd apps/api && bun run build:places`): nearest city within 100 km through an in-memory 1° grid. Batches of 1,000 upsert or delete `photo_places`. A place is shown only while its `places_version` equals `PLACE_DATASET_VERSION` and its stored coordinate texts equal the photo's current EXIF texts, so changed or removed GPS never shows a stale place.
10. Events: `detect-events-v1` (concurrency 1, on `photos/events.requested`, sent in the same trigger step) recomputes `events`/`event_photos` in one transaction from one streamed candidate query (valid EXIF wall-clock capture time, rejects excluded, RAW+JPEG stacked). Consecutive photos split at a gap ≥ 6 h, or ≥ 1 h when both have differing current places or current-model CLIP vectors with cosine < 0.6; runs of ≥ 6 photos are kept. An event's ID is its smallest member photo ID; cover is highest rating, then newest capture, then highest ID; place is the majority city (≥ 50% of located members), else majority country, else null. Bump `EVENTS_VERSION` when rules change.
11. Faces: `detect-faces-v1` (concurrency 1, on `photos/faces.requested`, sent by a separate appended `trigger-photo-faces-v1` step) detects faces in the committed `large` thumbnails of stack-representative stills with native YuNet, embeds them with SFace (128-d), and writes `photo_faces` plus a `photo_face_scan` receipt per photo in generation-fenced batches of 32; rescanned faces inherit manual decisions by IoU ≥ 0.5. A final `cluster-faces-v1` step assigns unassigned `auto` faces to the nearest person centroid (cosine ≥ 0.50), groups the rest into new unnamed people (mutual-neighbour average linkage, cosine ≥ 0.48, ≥ 3 faces), and deletes faceless unnamed people. `manual`/`rejected` faces are never changed by automation. Models download lazily to `FACE_MODEL_DIR` (else `$FASTEMBED_CACHE_DIR/faces`, else `./.face_models`) with size/SHA-256 checks. Bump `FACE_MODEL_VERSION` when detection or embedding output changes.
12. Uploads: `POST /api/v1/uploads` (off unless `UPLOADS_ENABLED`) streams an original into `{PHOTO_DIRECTORY}/Uploads/{device}/{YYYY}/{MM}/`, deduplicating by SHA-256 and by (`deviceId`, `assetId`, `resource`) in `uploads`/`upload_assets`. Each created file sends `photos/uploaded`; `scan-after-upload-v1` debounces 60 s, then starts an ordinary incremental scan. There is no second ingest pipeline.
13. The scan and embedding functions persist progress to `scan_jobs` and publish it to the Inngest Realtime channel `job:{jobId}`. Exhausted failures become terminal failed rows.

Incremental identity uses the canonical source root, byte size, nanosecond mtime/ctime, `MEDIA_VERSION`, and stat fingerprints of all four thumbnail files. Legacy rows receive one-time conservative adoption: matching size/whole-second mtime, completed media metadata, unambiguous stems, source ctime older than every thumbnail, full WebP/dimension validation, and post-validation stat checks. Valid artifacts are not re-encoded. These checks are metadata-based, not content hashes or proof of historical source provenance. `MEDIA_VERSION` and `EMBEDDING_MODEL_VERSION` in `processing-versions.ts` must change when their respective output contracts change.

Web and Expo clients obtain Realtime tokens through `trpc.realtimeToken`, subscribe with `@inngest/realtime`, and use `trpc.scanStatus` as a durable fallback; web polls every 1,500 ms while active, and Expo retains its recovery polling. Processing advances refresh the library immediately on the first advance and then coalesce trailing refreshes to at most once per second. Scan completion/first embedding progress and terminal progress also refresh the library; embedding remains nonterminal, and terminal progress refreshes search. Native iOS uses the durable `/api/v1/scans/active` and `/api/v1/scans/:jobId` compatibility routes rather than the tRPC/Realtime client.

There is no repository-local worker process. Running the API alone exposes the Inngest handler, but an Inngest development/runtime service must deliver events to that handler for asynchronous jobs to execute. This repository has no `dev:worker` script.

Import discovery, legacy thumbnail validation, streaming media work, HEIC maintenance, and CLIP image batches run through one persistent in-process worker thread via `apps/api/src/services/native-executor.ts`. It admits at most eight running/queued requests and owns one native photo stream, retained across completion checkpoints. Switching jobs or running another native operation cancels/drains that stream before replacement; a resumed job reloads pending receipts with fresh attempt keys. Completion callbacks preserve the caller's async context for Inngest Realtime. SQLite persistence and checkpoints remain on the API thread. Direct text search is synchronous. Generation checks protect publication, but there is no native process-crash isolation or distributed ownership lease.

The 7,961-file corpus needs at most 399 media completion windows and 498 embedding batch steps, plus fixed checkpoints in each function. Workflow step limits still bound library size; native path lists and the final embedding event grow with the library. Before this replay-sensitive cutover, drain old scan and embedding runs, rebuild the native addon, and apply migration `0006_incremental_scan.sql` before serving `scan-photos-v5` and `generate-embeddings-v3`. Local verification is documented in [import performance](docs/import-performance.md).

### Image processing

`packages/image-processing` is a Rust `cdylib` built with N-API. The normal scan pipeline is:

1. Walk the photo directory, skip hidden entries, and retain supported extensions.
2. Read filesystem metadata.
3. Extract EXIF with `exiftool`, amortizing metadata startup across at most 20 paths/32 KiB of path arguments per command. The streaming producer prefetches independently of media workers. Match by absolute `SourceFile`, preserve symlink filenames, retain valid records from mixed failures, and retry unresolved inputs individually. RAW binary preview commands remain separate.
4. Detect HEIF by extension or magic bytes and decode it with `libheif-rs`.
5. For RAW files, extract an embedded JPEG preview with `exiftool -b -PreviewImage`, falling back to `-JpgFromRaw`.
6. Decode standard images with the Rust `image` crate.
6a. For videos (`.mp4`, `.mov`, `.m4v`), probe the first non-cover video stream with `ffprobe` (duration, codec, rotation-corrected display dimensions) and decode one poster frame at `min(1 s, duration/2)` with `ffmpeg` (retrying at 0 s when no frame decodes); both run under a 30 s timeout with bounded output. `FFPROBE_BIN`/`FFMPEG_BIN` override the executables. The poster then follows the normal pHash/thumbnail path without EXIF orientation. Video `dateTaken` prefers QuickTime `CreationDate` wall clock, then `CreateDate`.
7. Apply EXIF orientation except for HEIF, whose decoder applies container transforms.
8. Generate a double-gradient perceptual hash from the oriented source, then resize once to a `large` preview bounded at 1,600 pixels and derive smaller thumbnails from that preview using original-derived target dimensions. Bundled libwebp now applies lossy color quality 80/85/85/90 for tiny/small/medium/large, with lossless alpha encoding. Derived pixels are not lossless; originals, orientation handling, pHash input, and EXIF extraction are unchanged. Thumbnail errors fail the photo result rather than marking it ready.
9. Defer CLIP image embeddings to the Inngest embedding function.

RAW files are not demosaiced with LibRaw or `rsraw` in this checkout. There is no current histogram-matching implementation.

### Database and vectors

SQLite is opened with Bun and `sqlite-vec` in `apps/api/src/db/setup.ts`. Drizzle uses the schema from `packages/db/src/schema.ts`.

The tables are:

- `photos`: file identity, dimensions, timestamps, RAW metadata, processing statuses, user curation (`rating` 0-5, `flag` `pick`/`reject`/null, `junk_dismissed`; scans never write these), and private committed source/artifact roots, fingerprints, version, and thumbnail key.
- `photo_exif`: one-to-one camera, lens, exposure, date, and GPS metadata.
- `photo_embedding`: one CLIP embedding blob per photo, with model version, thumbnail generation, and `tags_version` (vocabulary version used to tag that vector; null = untagged).
- `photo_phash`: one perceptual hash per photo.
- `photo_tags`: automatic CLIP zero-shot tags (`tag` slug, softmax `score`), at most 3 per photo; `(tag, photo_id)` index; cascades with the photo.
- `photo_places`: offline reverse-geocoded city/region/country (`geoname_id`, ISO2 `country_code`) plus the exact GPS texts and `places_version` it was computed from; `(country_code, photo_id)` and `(geoname_id, photo_id)` indexes; cascades with the photo.
- `events`/`event_photos`: materialized auto events (start/end wall-clock, count, cover, majority place, `events_version`) and membership (`event_id` index, unique `photo_id`); replaced wholesale by detection.
- `photo_quality`: sharpness, brightness, the thumbnail key measured, and `quality_version`; cascades with the photo.
- `collections`: manual albums; name unique case-insensitively (`COLLATE NOCASE` index).
- `collection_photos`: collection membership with `added_at`; both foreign keys cascade, so deleting a collection never deletes photos.
- `smart_albums`: saved filter sets (`filters` canonical JSON, `dateMonth` as `YYYY-MM`) plus an optional CLIP `query`, evaluated live; name unique case-insensitively among smart albums.
- `duplicate_dismissals`: duplicate/burst group keys (`kind:sortedIds`) marked "not duplicates"; a key stops matching once membership changes.
- `people`: automatic or user-created people (`name` nullable, `hidden`).
- `photo_faces`: normalized face box, detector score, SFace embedding blob, thumbnail generation, `person_id` (set null when a person is deleted), and `assignment` (`auto`/`manual`/`rejected`); `(person_id, photo_id)` index; cascades with the photo.
- `photo_face_scan`: per-photo detection receipt (thumbnail key, `FACE_MODEL_VERSION`, face count or error); cascades with the photo.
- `scan_jobs`: durable scan/embedding phase, status, counts, errors, and timestamps.
- `scan_manifests`: immutable per-job discovery boundary, roots, and processed/successful/unchanged/media/embedding counters.
- `scan_items`: priority-ordered paths, work classification, frozen source/prior generation, current attempt key, and durable receipts; retained until final dispatch is checkpointed, then removed with the manifest.

Semantic search creates a CLIP text embedding and queries `photo_embedding` with `vec_distance_L2`, including only completed vectors with the current model and matching thumbnail generation. The embedding model is `ClipVitB32`; the database does not enforce a vector dimension.

## Commands

Run commands from the repository root unless a command includes a directory change.

### Install and native build

```bash
bun install
cd packages/image-processing && bun run build
```

Native development also requires Rust/Cargo, a C toolchain, `pkg-config`, OpenSSL development headers, `libheif-dev`, `libclang-dev`, and the `exiftool`, `ffmpeg`, and `ffprobe` executables. Debian/Ubuntu runtime images need `libheif1`, `libimage-exiftool-perl`, and `ffmpeg`.

The first CLIP operation may download the FastEmbed model. Set `FASTEMBED_CACHE_DIR` to control the cache location. The first face detection downloads the YuNet (MIT) and SFace (Apache-2.0) ONNX models; set `FACE_MODEL_DIR` to control their location.

### Development servers

```bash
bun run dev              # Turbo starts packages/apps that define a dev script; currently API and web
bun run dev:api          # API on port 3000
bun run dev:web          # Web on port 3001
bun run dev:mobile       # Expo development server
```

The root `dev` command does not start mobile because mobile defines `start`, not `dev`. There is no worker command. Configure an Inngest development/runtime service separately when testing scan execution locally.

### Native iOS simulator

Native iOS requires Xcode 26.6. The app targets iOS 17+ and has separate Debug, Preview, and Production configurations. With Xcode 26.6 selected, run the same unsigned Preview simulator build/test used by CI:

```bash
xcodebuild \
  -project apps/ios/PhotoBrain.xcodeproj \
  -scheme PhotoBrain-Preview \
  -configuration Preview \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  CODE_SIGNING_ALLOWED=NO \
  test
```

### Quality and tests

```bash
bun run check            # Biome check with --write; modifies files
bun run ci:check         # Read-only Biome CI check
bun run format           # Biome format with --write; modifies files
bun run lint             # Turbo lint tasks where package scripts exist
bun run typecheck        # Turbo TypeScript tasks, including API and active mobile routes
cd apps/api && bun test
cd apps/api && bun run bench:import # File-backed persistence benchmark, no native processing
cd apps/api && bun run bench:exif /path/to/photo1.jpg /path/to/photo2.heic # Read-only EXIF comparison; requires exiftool
cd apps/web && bun run test:e2e
cd apps/web && bun run test:e2e:ui
cd apps/mobile && bun run test
xcodebuild -project apps/ios/PhotoBrain.xcodeproj -scheme PhotoBrain-Preview -configuration Preview -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' CODE_SIGNING_ALLOWED=NO test # Xcode 26.6
apps/ios/scripts/run-ui-tests.sh # XCUITest flows (Debug, PhotoBrain-UITests scheme) against the seeded fixture API; needs bun install + Homebrew sqlite
cd packages/image-processing && cargo test
```

Web E2E tests use Playwright with mocked tRPC, image, and Inngest requests. Expo tests use Jest with heavily mocked native/API dependencies. Native iOS unit tests run in the iOS Simulator. Native iOS UI tests (`apps/ios/PhotoBrainUITests`) drive the Debug app through `apps/ios/scripts/run-ui-tests.sh`, which starts `apps/api/scripts/ui-test-server.ts` (the real `/api/v1` and `/api/photos` routes over a throwaway SQLite library seeded through the shared migrations, plus `POST /__fixture/reset`) and passes its origin to the app through the Debug-only `PHOTOBRAIN_API_URL` launch-environment override. API tests use an in-memory SQLite database and the shared migrations.

## Environment

### API

The schema and defaults are in `apps/api/src/config.ts`:

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Bun server host |
| `PORT` | `3000` | API port |
| `DATABASE_URL` | `./photobrain.db` | Relative to the API process working directory |
| `PHOTO_DIRECTORY` | `../../temp-photos` | Directory scanned by Inngest |
| `THUMBNAILS_DIRECTORY` | `./thumbnails` | Generated WebP root |
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `RUN_DB_INIT` | `false` | `true` or `1` runs shared migrations on API startup |
| `V1_NATIVE_SCAN_MUTATIONS_ENABLED` | `false` | Enables `POST /api/v1/scans`; catalog/search/status compatibility routes remain readable while disabled |
| `FASTEMBED_CACHE_DIR` | unset | Optional Rust/FastEmbed model cache |
| `FACE_MODEL_DIR` | `$FASTEMBED_CACHE_DIR/faces`, else `./.face_models` | Optional YuNet/SFace ONNX cache read by Rust; files are size/SHA-256 verified |
| `UPLOADS_ENABLED` | `false` | `true` or `1` enables `POST /api/v1/uploads` and `/known`; `GET /api/v1/uploads/config` is always readable |
| `UPLOAD_MAX_BYTES` | `10737418240` | Per-upload byte limit, also used as `Bun.serve` `maxRequestBodySize` |
| `PHOTO_PROCESSING_THREADS` | available CPU capacity | Positive integer read by Rust at pool initialization; lower it to reduce concurrent decoded-image memory |
| `INNGEST_REALTIME_BASE_URL` | unset | Client-reachable Inngest HTTP(S) origin returned alongside subscription tokens |
| `INNGEST_SERVE_ORIGIN` | unset | API callback origin parsed and passed to the Inngest Hono handler as `serveHost` |

`DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are still parsed as legacy configuration but are not used by the current Rust preview pipeline. Do not document them as active RAW dependencies.

The Inngest SDK reads `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY` directly. PhotoBrain parses `INNGEST_SERVE_ORIGIN` and passes it to the Hono handler as `serveHost`; set it to an API origin reachable from the runtime so registration cannot infer `localhost` from an internal request. Production/self-hosting requires `INNGEST_DEV=0`, matching runtime/API keys, and a reachable runtime. Keep `INNGEST_BASE_URL` server-internal if desired; `INNGEST_REALTIME_BASE_URL` must be reachable by web/Expo and expose `/v1/realtime/connect`. Those clients attach a keyless SDK client to initial/refreshed tokens. Never ship server keys in public client variables. The homelab runtime is managed in the external ArgoCD repository; it stores orchestration state separately from PhotoBrain's database/photos. See [self-hosted setup](README.md#self-hosted-inngest).

The tracked `.envrc` sets `PHOTO_DIRECTORY=/photos`, `PORT=3000`, and `VITE_API_URL=http://localhost:3000` when direnv loads it. Check the shell environment before diagnosing path behavior.

### Web

Development reads `VITE_API_URL`, defaulting to `http://localhost:3000`.

The production Bun server in `apps/web/serve.ts` reads:

- `API_URL`, default `http://localhost:3000`
- `HOST`, default `0.0.0.0`
- `PORT`, default `3001`
- `MAP_STYLE_URL`, optional MapLibre style URL injected into `window.__CONFIG__`; otherwise `VITE_MAP_STYLE_URL`, then the OpenFreeMap `liberty` style

It injects `window.__CONFIG__` into `index.html`, allowing the API URL to change without rebuilding the Vite bundle.

### Mobile clients

The native Swift app reads `PhotoBrainAPIURL` from the selected configuration under `apps/ios/Config`: Debug uses local HTTP, while Preview and Production require a non-local HTTPS origin. The Expo app reads `EXPO_PUBLIC_API_URL` from `apps/mobile/src/config.ts`, with a fallback to `http://localhost:3000`; EAS profiles set `https://photobrain-api.ericj5.com`. Expo is the Android/web implementation.

## API Contract Summary

The tRPC and `/api/v1` procedures are public; there is no authentication or authorization middleware.

| Procedure | Type | Purpose |
|---|---|---|
| `folders` | query | Builds a sorted folder tree and counts direct-child photos |
| `filterOptions` | query | Distinct camera, lens, ISO, stored date-month prefixes, and tag counts (count desc, then tag), optionally folder-scoped |
| `photos` | query | Lists photos with optional raw/type, folder, camera, lens, ISO, month, `minRating`, `flag` (`pick`/`reject`/`unflagged`), `collectionId`, and `tag` filters |
| `photoTags` | query | A photo's automatic tags, score descending; `NOT_FOUND` for unknown IDs |
| `photo` | query | Returns one photo with EXIF by numeric ID |
| `searchPhotos` | query | CLIP text search, limit 1-100, optionally scoped by the same filters as `photos` (applied inside the KNN query) |
| `similarPhotos` | query | Nearest CLIP neighbours of a photo's committed vector, limit 1-100, optionally filtered like `photos`; `{ photos, total, sourcePhotoId, indexed }`, `NOT_FOUND` for unknown IDs |
| `setPhotoCuration` | mutation | Sets `rating` (0-5) and/or `flag` (`pick`/`reject`/null) on 1-500 photo IDs in one statement; returns only existing IDs |
| `collections` / `collectionsForPhoto` | query | All collections (name, count, most-recently-added cover) in one statement / collection IDs containing a photo |
| `createCollection` / `renameCollection` / `deleteCollection` | mutation | Trimmed 1-100 char names, case-insensitive uniqueness (`CONFLICT`); delete leaves photos intact |
| `addToCollection` / `removeFromCollection` | mutation | 1-500 photo IDs; duplicates and unknown IDs ignored; returns counts |
| `smartAlbums` | query | Smart albums by name with live `photoCount` and cover for filter-only albums (null for query albums); `dateMonth` emitted as `YYYY:MM` |
| `createSmartAlbum` / `updateSmartAlbum` / `deleteSmartAlbum` | mutation | Name, `filters` (photo filters without `collectionId`), optional `query` (≤ 200 chars); at least one filter or a query (`BAD_REQUEST`), case-insensitive name uniqueness (`CONFLICT`) |
| `junkReview` | query | Review candidates (not dismissed, not picked/rejected, unrated) with `junkReasons` in order `screenshot`, `document` (tags ≥ 0.5), `blurry` (sharpness < 40), `dark` (brightness < 40); optional `reason`; id-desc keyset `cursor`, limit 1-500; library-wide `counts` |
| `resolveJunk` | mutation | 1-500 IDs; `reject` sets `flag = 'reject'`, `keep` sets `junk_dismissed`; returns existing IDs |
| `duplicateGroups` | query | Near-duplicate groups (connected pHash components within 1 of 40 bits) and EXIF bursts (same camera, 3+ shots chained ≤ 2 s); undismissed, rejected photos excluded; suggested keeper; offset `cursor`, limit 1-200; `counts` per kind |
| `resolveDuplicateGroup` | mutation | Key must still match current membership (`CONFLICT`). `keep` rejects every non-kept member and dismisses the kept set when 2+; `dismiss` records the key. Files are never touched |
| `people` / `person` | query | People (named first, then photo count) with `photoCount`, `faceCount`, `coverFaceId`; hidden people only with `includeHidden` / one person, `NOT_FOUND` for unknown IDs |
| `updatePerson` / `mergePeople` | mutation | Rename (1-80 chars, `null` clears) and hide; merge 1-50 sources into a target as `manual` faces, deleting the sources |
| `photoFaces` / `assignFace` | query / mutation | A photo's faces left to right with box, person, and assignment / assign a face to a person, a new named person, or `null` (reject) |
| `scan` | mutation | Defaults to incremental scanning; optional `{ force: true }` reprocesses all discovered files. Creates a durable job and returns `{ success, jobId? }` |
| `scanStatus` | query | Returns durable progress for a scan UUID or `null` |
| `realtimeToken` | query | Returns `{ token, baseUrl? }` for a job ID; optional client-reachable self-hosted origin |

The native compatibility surface under `/api/v1` uses the same catalog, search, and scan-job services:

- `GET /api/v1/folders`
- `GET /api/v1/filter-options`
- `GET /api/v1/photos`
- `GET /api/v1/photos/:id`
- `GET /api/v1/locations` (same filters as `/photos`; `{ points: [{ id, latitude, longitude }], total }` for photos with a valid location)
- `PATCH /api/v1/photos/:id` (`{ rating?, flag? }`; returns the Photo DTO; not gated by the scan flag)
- `GET /api/v1/photos/:id/similar`
- `GET /api/v1/photos/:id/tags` (404 `PHOTO_NOT_FOUND`)
- `GET /api/v1/photos/:id/place` (`{ place: { id, city, region, country, countryCode } | null }`; 404 `PHOTO_NOT_FOUND`). `country` (ISO2) and `place` (geoname ID) filter `/photos`, `/locations`, search, similar, and smart albums; `filter-options` adds folder-scoped `countries` and `places` with counts.
- `GET /api/v1/on-this-day?date=YYYY-MM-DD` (required client-local date; `{ date, years: [{ year, yearsAgo, capturedDate, count, cover }] }`, earlier years newest first, at most 20; rejects excluded, RAW+JPEG stacked; on a non-leap Feb 28, earlier Feb 29 photos join their year). `capturedDate` (`YYYY-MM-DD`, wall-clock EXIF date, no time-zone conversion) filters `/photos`, `/locations`, search, and similar; it is a view scope and smart albums reject it. Expression indexes `idx_exif_month_day`/`idx_exif_captured_date` (migration 0015) back both.
- `GET /api/v1/events?folder=` (`{ events: [{ id, startAt, endAt, photoCount, cover, place }] }`, newest first; folder-scoped to events with any member in the subtree, `photoCount` stays the full count). `event` (event ID) filters `/photos`, `/locations`, search, and similar; unknown IDs return empty; it is a view scope and smart albums reject it.
- `GET /api/v1/gear-stats` (same query as `/photos`; `{ total, withExif, cameras, lenses, focalLengths, apertures, shutterSpeeds, isos, cameraYears }` over exactly the listing's photo set with RAW+JPEG stacking). Cameras/lenses are all entries, count desc then label; the four histograms always return every fixed bucket (`FOCAL_LENGTH_BUCKETS`, `APERTURE_BUCKETS`, `SHUTTER_SPEED_BUCKETS`, `ISO_BUCKETS` in `services/gear-stats.ts`), excluding unparseable values per dimension. The camera label SQL (`cameraLabelSql`) is shared with the `camera` filter and `filterOptions`.
- `GET|POST /api/v1/collections`, `PATCH|DELETE /api/v1/collections/:id`, `POST /api/v1/collections/:id/photos`, `POST /api/v1/collections/:id/photos/remove`, `GET /api/v1/photos/:id/collections` (409 `COLLECTION_NAME_TAKEN`, 404 `COLLECTION_NOT_FOUND`)
- `GET|POST /api/v1/smart-albums`, `PATCH|DELETE /api/v1/smart-albums/:id` (`dateMonth` emitted as `YYYY-MM`; 409 `SMART_ALBUM_NAME_TAKEN`, 404 `SMART_ALBUM_NOT_FOUND`); clients open an album through `photos` or, with a query, `search` (limit 100)
- `GET /api/v1/people`, `GET|PATCH /api/v1/people/:id`, `POST /api/v1/people/:id/merge`, `GET /api/v1/photos/:id/faces`, `PUT /api/v1/faces/:id/person` (404 `PERSON_NOT_FOUND`/`FACE_NOT_FOUND`). `personId` filters `/photos`, `/locations`, search, similar, gear stats, and smart albums.
- `GET /api/v1/review/junk`, `POST /api/v1/review/junk/resolve` (same shapes as `junkReview`/`resolveJunk`; 400 `INVALID_REQUEST`)
- `POST /api/v1/search`
- `POST /api/v1/scans` (disabled by default through `V1_NATIVE_SCAN_MUTATIONS_ENABLED`)
- `GET /api/v1/scans/active`
- `GET /api/v1/scans/:jobId`
- `GET /api/v1/uploads/config`, `POST /api/v1/uploads` (raw body; 201 created / 200 duplicate; 503 `UPLOADS_DISABLED`), `POST /api/v1/uploads/known` (asset keys a device already uploaded); mounted from `src/routes/uploads.ts` before the generic v1 router

It emits explicit ISO JSON DTOs, normalizes Rust EXIF month prefixes from `YYYY:MM` to `YYYY-MM`, and never exposes the six private source/artifact identity fields. The shared catalog service keeps this as a `/api/v1` representation option so tRPC wire behavior does not change. The OpenAPI contract is checked in at `apps/api/src/routes/openapi-v1.json`.

RAW+JPEG pairs are derived at query time, with no scan changes: two photos pair when their case-insensitive relative path minus extension (`idx_photos_pair_stem`, migration `0013`) matches exactly two rows, one RAW and one not, and both `date_taken` values agree when both are present. Every public photo payload carries `pairedPhotoId`/`pairedFormat`. In any filtered set, a RAW row is omitted when its partner also matches, so `all` shows one cell per pair (the standard file) and `raw`/`standard` show their own file type. Curation updates apply to partners in the same UPDATE, and duplicate `keep` rejects partners of the rejected members. A RAW that has a partner is excluded from junk and duplicate candidates. Collection membership is never expanded. Clients badge pairs as e.g. `ARW+JPG`.

REST routes under `/api/photos`:

- `GET /api/photos/:id/file`: streams the original standard image or video (stored MIME type); serves the `large` WebP for converted RAW files. Always sends `Accept-Ranges: bytes`; one satisfiable `Range` returns 206 with `Content-Range`, an unsatisfiable one 416 (`bytes */size`), and multi-range or malformed headers the full 200. HEAD is supported.
- `GET /api/photos/:id/thumbnail/:size`: serves `tiny`, `small`, `medium`, or `large` WebP and falls back to the file route when missing.
- `GET /api/faces/:id/crop?size=128|256`: square WebP face crop rendered from the face's own thumbnail generation, immutable with an ETag; used for people avatars.
- `POST /api/photos/reprocess-heic`: one-off maintenance route; still present and should be removed after its operational use.
- `POST /api/photos/backfill-thumbnail-timestamps`: one-off maintenance route for missing `thumbnailUpdatedAt` values.

Export routes (`apps/api/src/routes/exports.ts`, mounted at `/api`; binary, not in the OpenAPI contract):

- `GET /api/photos/:id/export?size=original|2048|1024` (default `2048`): `original` streams the source bytes unchanged; `2048`/`1024` render a metadata-free (no EXIF/GPS) sRGB JPEG at quality 90 through native `renderExportJpeg` (shared HEIF/RAW-preview decode, orientation applied, long edge fit, never upscaled) on the native executor. Filename `{stem}_{size}.jpg`; RFC 6266 `Content-Disposition` with an ASCII fallback; `Cache-Control: private, no-store`. Errors: 400 `INVALID_REQUEST`, 404 `PHOTO_NOT_FOUND`/`SOURCE_MISSING`, 422 `EXPORT_FAILED`, 503 `EXPORT_BUSY` with `Retry-After` when executor admission is full.
- `GET /api/collections/:id/export?size=original|2048|1024` (default `original`): streaming STORE ZIP (UTF-8 names, CRC-32, ZIP64 when needed) of every member, unstacked, in captured order (`listCollectionMembers`); duplicate names become `stem (2).ext` case-insensitively; missing/failed members are skipped and listed in a final `export-errors.txt`. Pull-based with at most two renders in flight; ZIP renders wait for executor capacity, and client abort stops further reads/renders. 404 `COLLECTION_NOT_FOUND` before any bytes.
- Videos export as their unchanged original file for every `size`, including inside collection ZIPs.

Videos and Live Photos: photos carry `mediaType` (`photo`|`video`), `durationMs`, `videoCodec`, and `motionVideoId`. `filterRaw` accepts `all|raw|standard|video` (`standard` = non-RAW stills; `video` excludes motion clips). A video ≤4,000 ms that is the only video on a pair stem holding one still or a RAW pair is a motion clip (`livePhotoSql`): it is hidden from listings, counts, search, similar, map, events, gear stats, on-this-day, and smart albums, and exposed as the still's `motionVideoId`, but remains fetchable by ID. Videos are excluded from junk, quality backfill, and duplicate/burst candidates.

Managed scans write `{thumbnailRoot}/{size}/.versions/{uuid}/photo.webp` and publish the committed root/key with the photo. Legacy adopted files retain mirrored paths such as `large/2024/trip/photo.webp`; direct native helpers retain that default layout. REST resolves the committed root/key, with configured-root/path fallbacks for legacy rows. Immutable responses include generation/mtime/size ETags; `thumbnailUpdatedAt` advances monotonically even for same-second commits or backwards clocks. Clients use it for thumbnail cache busting, and web full-image URLs also include it. Old and abandoned generations are retained; garbage collection is not implemented.

## Frontend Behavior

### Web

The active route tree is in `apps/web/src/App.tsx`:

- `/` -> `Dashboard`
- `/preferences` -> placeholder page
- `/about` -> informational page

The dashboard combines folder and collection navigation, EXIF filters, semantic search, similar-photo search, grid/loupe views, metadata, curation, scan progress, and a loupe filmstrip. The web uses single active-photo state, not multi-selection. Type, Rating, Flag, folder, and EXIF filters stay visible during search and scope it; a results header names the query and scope. Selecting a collection in the left panel scopes the grid and search (exclusive with folder selection); the panel creates, renames, and deletes collections, and the metadata panel's **Add to collection** popover toggles membership for the active photo. **Find similar** in the metadata panel (or `S`) replaces the grid with the active photo's nearest neighbours until dismissed, searched, or navigated away. The metadata panel's Rating stars and Pick/Reject toggles update every cached result optimistically and roll back on failure; grid cells show a ★/flag badge and rejected photos are dimmed in grid and filmstrip.

Filter By has a Tags section (top 12 by count, then **Show all**; single-select, click again to clear) that scopes the grid and search (`#tag` in the search header). The metadata panel lists the active photo's tags as chips in score order ("No tags yet" when untagged); clicking a chip applies that tag filter and returns to the grid.

Timeline on web: the library grid (not search, similar, review, or duplicates) sorts by capture date (EXIF wall clock, else modified/created local time; oldest first, ID tiebreak) or by added (ID), grouped by Years/Months/All with sticky section headers and counts and a final "Unknown date" section. Grouping/sort persist in `photobrain-library-state`; loupe, filmstrip, and arrow keys follow the displayed order. A year rail jumps between years. The toolbar Calendar popover counts EXIF capture days in the loaded, filtered list; clicking a day applies `capturedDate`.

Events on web: a Filter By **Events** section (newest first, first 12 then **Show all**, folder-scoped) shows cover, title (place "City, Country"/country, else the date range), and subtitle (wall-clock date range, "N photos"). Clicking applies the `event` filter (chip shows the title) to the grid, map, search, and similar; smart-album saves omit it.

Gear stats on web: a toolbar **Gear stats** toggle (library grid only) replaces the grid with stats for the current filters: header "N photos · M with camera data", camera/lens bars (top 10, **Show all**; clicking applies that filter and returns to the grid), focal/aperture/shutter/ISO histograms, and shots per year segmented by the top 5 cameras plus Other.

Uploads on web: the toolbar **Upload photos** button (disabled with a tooltip when the server has uploads off) and drag-and-drop onto the center content send originals two at a time with a per-browser device ID; a panel lists created, duplicate, and rejected files, and the library refreshes when the debounced import scan runs.

Export on web: the metadata panel's **Export** menu (grid or loupe with an active photo) downloads Original / JPEG 2048 / JPEG 1024 through `download` anchors (streamed by the browser, no blob); `Shift+D` downloads the active photo as JPEG 2048. A collection's actions menu has **Download as ZIP** (Originals / JPEG 2048 / JPEG 1024).

Videos on web: grid and filmstrip tiles show a duration badge (floored `m:ss`/`h:mm:ss`, label "Video, 1 minute 5 seconds"); stills with a motion clip show **LIVE**. The loupe renders a paused `<video controls preload=metadata>` with the large thumbnail as poster; `Space` toggles playback (`Shift+Space` still toggles the filmstrip). The LIVE button plays the clip muted once over the still. The Type filter has a Video option; videos export as Original only, including `Shift+D`.

Catalog **Review** (badge = candidate count) replaces the grid with junk candidates, each badged with its first reason; a reason radiogroup with counts, **Reject all (N)** (confirmation above 50) and **Keep all (N)** act on the shown photos. In Review, `X` rejects and `K` keeps the active photo and advance; the metadata panel shows "Why it's here" with Reject/Keep. Resolutions remove photos optimistically and roll back on error. Choosing a folder, collection, tag, search, or Find similar leaves Review and restores the library filters.

**Smart Albums** sit under Collections in the library panel (count badge, or a search icon for query albums) with rename/delete. **Save as Smart Album…** appears when a folder, filter, or search is active and saves them (never the collection). Opening an album replaces folder, filters, and search, leaves collection/similar/Review modes, and shows the album name in the grid header; any later change deselects it.

The normal scan control is incremental. The separate **Reprocess all photos…** control requires confirmation before regenerating thumbnails and embeddings; originals remain untouched.

Implemented keyboard shortcuts:

- `G`: grid view
- `M`: map view
- `E`: loupe view when a photo is active
- `Tab`: toggle all panels
- `Shift+Space`: toggle filmstrip
- Left/right arrows: navigate in loupe or with an active photo
- `S`: find photos similar to the active photo
- `0`-`5`: rate the active photo; `P` pick, `X` reject, `U` unflag (ignored while typing); in Review, `X` rejects and `K` keeps, then advance
- `B`: toggle the active photo in the most recently used collection
- `Escape`: return from loupe to grid; in grid, exit similar-photo mode

Modifier-click range selection and `Ctrl/Cmd+A` are not implemented. Panel width/height values are persisted by `usePanelState`, but `PanelLayout` currently renders fixed dimensions.

### Native iOS

`apps/ios/PhotoBrain/App/PhotoBrainApp.swift` is the current iOS entrypoint. The iOS 17+ SwiftUI/UIKit application has Library, Collections, and Search tabs; a grid and loupe; filtering (media type, EXIF, minimum rating, flag), semantic search scoped by the shared Library filter sheet, loupe **Find Similar** results, loupe star/Pick/Reject curation (`PhotoCurationCenter` coalesces in-flight PATCHes per photo and rolls back on failure across Library, Search, and Similar), collections (cover-card grid with create/rename/delete, collection-scoped grid/loupe detail, loupe **Add to Collection** sheet), theme state, and durable scan recovery through `/api/v1`. Debug, Preview, and Production have separate schemes/configurations and API-origin validation. `PreferencesStore` (`apps/ios/PhotoBrain/App/AppEnvironment.swift`) persists theme and the active scan ID in `UserDefaults.standard` under `com.photobrain.theme` and `com.photobrain.activeScanId`.

Automatic tags on iOS: the shared filter sheet has a Tag picker with counts (summary `#tag`) feeding Library and Search, and the loupe info sheet shows the photo's tag chips; tapping a chip closes the loupe, switches to Library, and adds that tag to the existing Library filters.

Junk review on iOS: the Library header's **Review** button (candidate count) pushes a review screen with a reason picker and counts, first-reason badges, select mode with Reject/Keep, confirmed **Reject All**/**Keep All** for loaded photos, and a review loupe whose Reject/Keep buttons advance. Resolutions remove photos optimistically, roll back on failure, and propagate confirmed rejects to Library and Search through `PhotoCurationCenter`.

Duplicates on iOS: the Library header's **Duplicates** button (combined count) pushes a screen with All/Duplicates/Bursts, group cards with the suggested keeper preselected, keep toggles (one photo always stays kept), a Compare loupe, **Keep N, reject M** and **Not duplicates**. Resolutions remove groups optimistically, roll back on failure, reload on a changed group, and propagate rejects through `PhotoCurationCenter`.

Map on iOS: the Library header's **Map** button pushes an `MKMapView` with clustered markers for the Library's current filters. It opens fitted to every point, or, when MapKit's zoom-out limit cannot show them all (photos on distant continents), to the largest group that fits (`MapFit.densestSpan`). Tapping a marker opens the loupe and tapping a cluster zooms in. **Show N Photos** opens a grid scoped to the visible region (`LibraryScope.mapArea`), computed from the exact `visibleMapRect` rather than the approximate `MKCoordinateRegion` span. The loupe info sheet shows a mini-map when the photo's GPS is valid.

Places on iOS: the Library filter sheet's Places category lists countries with counts and, under the selected country, its cities. The loupe info sheet shows a tappable Place row ("Kyoto, Japan") that applies the place filter. Smart albums save `country`/`place`.

On this day on iOS: over the unfiltered Library grid, a horizontal "On this day" row shows one card per earlier year (cover, "N years ago", date, count) for the device's local date, reloading when the app becomes active on a new day. Tapping a card applies the `capturedDate` filter (date chip); smart-album saves omit it.

Calendar on iOS: the Library header's Calendar button opens a month sheet counting EXIF capture days (raw `dateTaken` day, no time-zone conversion) from the loaded, filtered records; prev/next skip empty months; tapping a day applies `capturedDate`.

Events on iOS: an Events section in the Collections tab (cover cards with the same title/subtitle rules as web) loads with collections and reloads on pull-to-refresh; tapping opens a detail grid/loupe through `LibraryStore` scope `.event`.

Gear stats on iOS: the Library header's **Gear Stats** button opens a sheet with the same sections for the current filters; tapping a camera or lens applies that filter and dismisses.

Export on iOS: the loupe's Share menu (**Share Photo** = JPEG 2048, **Share Original**) and a collection detail **Export** menu (Originals or JPEGs 2048 px as ZIP) download to a per-export temp directory with progress/cancel, then present the share sheet; temp files are deleted after sharing, on cancel, or on failure. `EXPORT_BUSY` offers a manual retry.

Videos on iOS: library, search, and similar grids show the same floored duration and LIVE badges. The loupe hosts an AVKit player (prepared paused; poster until ready; released on page change or dismissal); LIVE plays the motion clip muted once and returns to the still. The info sheet adds duration and codec; the Media Type picker has Video; videos offer only **Share Video** (original).

Smart albums on iOS: a Smart Albums section in the Collections tab (cards with count or a magnifier for query albums, rename/delete with rollback); **Save as Smart Album…** in the Library filter sheet and Search. Detail screens reuse the collection grid/loupe through `LibraryStore` scope `.smartAlbum(filters, query)`.

Backup on iOS: Settings → Backup turns on camera-roll backup (asking for Photos access first; limited access backs up only the selected photos) with Include Videos, Allow Cellular, and a device name that becomes the server folder. `BackupCoordinator` asks for `/uploads/config`, reconciles a fresh install against `/uploads/known`, exports originals with PhotoKit (RAW+JPEG and Live Photo clips upload as separate resources), and hands files to a background `URLSession` (`<bundle id>.backup-uploads`, 2 at a time); `BackupLedger` (`Application Support/Backup/ledger.jsonl`) records done/skipped/retry state and survives relaunches. Runs start on launch, foreground, camera-roll changes (3 s debounce), **Back Up Now**, and a `BGProcessingTask` (`<bundle id>.backup`). The device ID lives in the Keychain. Background upload sessions need a signed app: on the simulator, build with `CODE_SIGN_IDENTITY=-` (unsigned builds have no bundle ID, and `nsurlsessiond` rejects them).

### Expo Android/web

The Expo entrypoint is `expo-router/entry`; routes live in `apps/mobile/app/`. `apps/mobile/App.tsx` is a legacy React Navigation entrypoint and is not the configured route tree or the target of active navigation tests. The Expo implementation targets Android and web; it has no iOS release path. Theme and active scan persist in AsyncStorage through `apps/mobile/src/lib/preferences.ts`.

The Expo route tree retains Library, Collections, and an isolated Search tab. Library has a persistent header with live scrolling-grid blur and a visible-photo date, a continuous five-column phone grid ordered oldest-to-newest and opened at its newest edge, basic selection, EXIF filters, durable scan progress, and metadata. Scrolling back in time replaces the native tabs with a collapsed Collections + Years/Months/All + Search browsing bar. The modal loupe combines paged swipes, platform-native pinch zoom, a synchronized thumbnail filmstrip, and compact date/time and info controls. Search uses a 350 ms cancellable debounce. Its Liquid Glass and iOS-specific search bar code paths are inactive on Android/web, which use their existing fallbacks.

Library Options offers incremental **Scan Library** and a separately confirmed **Reprocess all photos** action. Both are disabled during saved-scan recovery, dispatch, or an active scan.

## Deployment

The current `Dockerfile` has five stages:

1. `builder`: installs Bun/Rust/native dependencies and builds the N-API addon.
2. `api`: applies shared migrations, then runs the Hono/Bun API on port 3000.
3. `web-builder`: builds the Vite web app.
4. `web`: runs the Bun static server on port 3001 with runtime API configuration.
5. `mobile`: installs the workspace and runs the Expo development server on port 8081.

There is no worker image and the mobile Docker target is not a static Expo web-export image. `apps/mobile/package.json` does provide `bun run build:web` for manual Expo web export.

`.github/workflows/build.yml` currently:

- Runs API tests/typecheck, web Playwright tests, and Expo Jest tests.
- Builds Android preview receivers and publishes Android preview EAS updates on `main`.
- Builds Android production receivers and publishes Android production EAS updates on version tags.
- Builds and pushes API, web, and mobile Docker targets.
- Updates API/web/mobile image tags in the external ArgoCD repository on pushes to `main`.

Native iOS has independent CI and release lanes. `.github/workflows/native-ios.yml` pins Xcode 26.6, runs the unsigned Preview configuration on an iOS 26.5 simulator, then runs the Debug XCUITest flows against the fixture API. The manual `.github/workflows/native-ios-release.yml` validates Production inputs/signing assets, allocates a build number, archives and strictly inspects the signed native IPA, retains the archive/IPA/dSYMs, and uploads the inspected IPA to TestFlight. Apple identities, GitHub secrets, tester setup, and certificate renewal are recorded in [iOS distribution](docs/ios-distribution.md).

The permanent `.github/workflows/build.yml` never publishes iOS OTA updates. Its EAS release work is explicitly Android-only for preview on `main` and production on version tags. `native-ios-release.yml` serializes on the `ios-production-release` concurrency group and uses `apps/ios/scripts/allocate-app-store-build.mjs`, which chooses a build number above both App Store Connect history and the run reservation floor; it enforces the production bundle/API contract and iOS 17.0 minimum.

The API and worker must not be described as separate services unless a future change actually introduces a worker. Production still requires a reachable Inngest runtime for asynchronous processing and shared access to the SQLite database, photo directory, and thumbnail directory.

## Change Recipes

### Add or change an API capability

1. Put reusable metadata, query, search, and scan-job behavior in the shared services consumed by both `apps/api/src/trpc/router.ts` and `apps/api/src/routes/v1.ts`; keep their transport validation/serialization separate.
2. Update `apps/api/src/routes/openapi-v1.json` when the native compatibility contract changes.
3. Add binary streaming behavior to `apps/api/src/routes/photos.ts` only when tRPC or `/api/v1` JSON is unsuitable.
4. Keep web/Expo client types inferred from `@photobrain/api`; do not hand-maintain duplicate tRPC DTOs.
5. Add or update API tests using the in-memory database setup when behavior is query/filter related.

### Change the schema

1. Update `packages/db/src/schema.ts`.
2. Generate a migration from `packages/db` with `bun run db:generate`.
3. Review the generated SQL and migration journal.
4. Run `bun run db:migrate` or start the API with `RUN_DB_INIT=true`.
5. Update the API, worker-related wording, and client behavior together. There is no current worker package.

### Change image processing

1. Update the relevant Rust module under `packages/image-processing/src/`.
2. Re-export public N-API functions from `src/lib.rs`.
3. Rebuild with `cd packages/image-processing && bun run build`.
4. Update `browser.js` if a client-side package import needs a matching browser/Metro stub.
5. Include or update Rust tests where the behavior can be tested without real camera files.

### Change web or mobile behavior

1. Use the current app entrypoint and route tree, not legacy components or `App.tsx` on mobile.
2. Use the generated tRPC types and existing thumbnail URL helpers.
3. Add/update the appropriate mocked E2E or Jest test.
4. Test both a normal image and a RAW/HEIF fixture when changing media display or URL logic.

## Invariants and Known Gaps

- `discoverPhotos` returns index-aligned `filePaths` and `relativePaths`; preserve that pairing.
- Native media calls share one Rayon pool sized by `available_parallelism()` or `PHOTO_PROCESSING_THREADS`. Streaming ready/results queues each hold at most twice the worker count, plus one EXIF chunk in the producer. At most one result awaits API persistence ACK. `close()` cancels dispatch and waits for active metadata/writers; callbacks run in their checkpoint's async context.
- Thumbnail generation errors fail the photo result; completed thumbnail status requires all required outputs. Managed scan and HEIC-maintenance attempts use unique output keys and generation-checked publication.
- Scans do not delete database rows for files removed from disk.
- Unchanged media keeps its cache token and completed vectors. Only regenerated media or incomplete/outdated embeddings become pending; absent EXIF alone does not force repeated processing.
- `scan_jobs` terminal states are monotonic, but a process crash after inserting a queued row and before sending its Inngest event can still leave that row queued; there is no outbox reconciler.
- Streaming scan commits atomically upsert photo/EXIF/pHash/status data, durable item receipts, manifest counters, and scan progress. Embedding batches atomically upsert vectors and embedding statuses. Native media generation and network publishing remain outside transactions. Receipt cleanup explicitly deletes items and headers transactionally, including on SQLite connections without foreign-key enforcement.
- Missing later EXIF or pHash data does not currently remove an old sidecar row.
- Legacy/direct-helper thumbnail paths remain extension-stripped. Legacy adoption rejects possible same-stem collisions, conservatively normalizing case and Unicode; managed generations avoid collisions. Retired and abandoned generations consume disk until an explicit safe cleanup facility exists.
- The pHash is the Rust `DoubleGradient` output serialized as base64, not a guaranteed 64-character hexadecimal value.
- Embedding blobs and pHash strings have no database dimension/format constraints.
- `packages/utils/src/queues.ts` and `tasks.ts` describe an older BullMQ-style task model and are not consumed by the current API/Inngest flow. Treat them as legacy until deliberately migrated or removed.
- All API and file-serving routes are unauthenticated.
- The API's `src/db/migrate.ts`, old app READMEs, and historical roadmap sections contain stale assumptions; verify them against the current scoped guides before copying instructions.

## Documentation Maintenance

When changing architecture, update these locations in the same change:

- The relevant scoped `AGENTS.md`.
- Root `AGENTS.md` if commands, boundaries, or cross-package invariants change.
- `README.md` or an app README if setup, deployment, or user-visible behavior changes.
- `ROADMAP.md` only for roadmap status; do not use it as the implementation source of truth.

Before finishing documentation work, check links, run `git diff --check`, and search for stale terms such as `apps/worker`, `BullMQ`, `REDIS_URL`, and `onTaskProgress` in current (non-historical) documentation.
