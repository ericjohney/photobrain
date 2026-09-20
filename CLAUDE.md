# CLAUDE.md - PhotoBrain Agent Guide

This is the current implementation guide for agents working in PhotoBrain. Prefer the source tree and the scoped guides linked below over older roadmap notes or generated artifacts.

## Read First

- This repository is a Bun/Turbo monorepo with three applications and four shared packages.
- There is no `apps/worker` directory, BullMQ consumer, or Redis requirement in the current implementation.
- Background scan and embedding functions are Inngest functions registered by the API at `/api/inngest`.
- Image processing is a native Rust N-API addon. It is not an active WASM implementation.
- EXIF extraction and RAW preview extraction invoke the external `exiftool` executable.
- The shared database schema is authoritative. `apps/api/src/db/schema.ts` re-exports it and defines an API-only projection that excludes private photo processing identities.
- `README.md` is for user/developer setup. `ROADMAP.md` is forward-looking and may contain historical session notes. The scoped `AGENTS.md` files below are the detailed agent guides.

## Documentation Map

Read the guide for the area being changed:

- [API and background jobs](apps/api/AGENTS.md)
- [Web application](apps/web/AGENTS.md)
- [Mobile application](apps/mobile/AGENTS.md)
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
  mobile/                 Expo/React Native application using Expo Router
packages/
  config/                 Shared TypeScript configuration package
  db/                     Drizzle schema and migration files
  image-processing/       Rust N-API addon and browser/Metro stubs
  utils/                  Shared TypeScript helpers and thumbnail configuration
docs/
  superpowers/            Historical design specifications and implementation plans
.github/workflows/        CI tests, Docker builds, EAS updates, and ArgoCD tag updates
Dockerfile                Five targets: builder, api, web-builder, web, mobile
```

## Runtime Architecture

### API and jobs

The API entrypoint is `apps/api/src/index.ts`:

1. Hono serves `/api/health`.
2. tRPC handles `/api/trpc/*` using the router in `apps/api/src/trpc/router.ts`.
3. REST routes under `/api/photos/*` stream original files and generated thumbnails.
4. Inngest serves `GET`, `PUT`, and `POST /api/inngest` and registers the scan and embedding functions.

The scan flow is:

1. `trpc.scan()` defaults to incremental processing; `{ force: true }` explicitly reprocesses every discovered file. It creates a durable queued `scan_jobs` row, then sends an idempotently keyed `photos/scan.requested` event.
2. `scan-photos-v5` freezes discovery and media/embedding/skip classification in SQLite `scan_manifests`/`scan_items`, stably ordering new paths before existing paths while preserving absolute/relative pairing.
3. Unchanged, complete media retains its ID, artifacts, and cache timestamp. New, changed, or incomplete media enters a persistent Rust `startPhotoProcessing` stream feeding the available-CPU-sized pool without input-batch barriers. Each attempt writes to its own collision-free thumbnail key.
4. Each completion checks the frozen source fingerprint, current attempt, and previous committed generation before atomically saving photo/EXIF/pHash data, artifact identity, receipt, counters, and progress. The API acknowledges persistence before pulling the next result. Inngest checkpoints every 20 completions; retries load only pending receipts. Native processing and network publication stay outside SQLite transactions.
5. Only current-generation photos requiring embeddings enter the final `photos/embeddings.requested` event: regenerated media and otherwise unchanged photos with missing, failed, outdated, or malformed vectors. Fully indexed unchanged scans complete without that event. The parent performs no progress writes after dispatch.
6. `generate-embeddings-v3` reads committed `large` thumbnail roots/keys in batches of 16. Inference, generation-checked vector/status saves, and progress publication share one checkpoint per batch; stale results cannot overwrite a newer photo generation.
7. Both functions persist progress to `scan_jobs` and publish it to the Inngest Realtime channel `job:{jobId}`. Exhausted failures become terminal failed rows.

Incremental identity uses the canonical source root, byte size, nanosecond mtime/ctime, `MEDIA_VERSION`, and stat fingerprints of all four thumbnail files. Legacy rows receive one-time conservative adoption: matching size/whole-second mtime, completed media metadata, unambiguous stems, source ctime older than every thumbnail, full WebP/dimension validation, and post-validation stat checks. Valid artifacts are not re-encoded. These checks are metadata-based, not content hashes or proof of historical source provenance. `MEDIA_VERSION` and `EMBEDDING_MODEL_VERSION` in `processing-versions.ts` must change when their respective output contracts change.

Both clients obtain Realtime tokens through `trpc.realtimeToken`, subscribe with `@inngest/realtime`, and use `trpc.scanStatus` as a durable fallback; web polls every 1,500 ms while active, and mobile retains its recovery polling. Processing advances refresh the library immediately on the first advance and then coalesce trailing refreshes to at most once per second. Scan completion/first embedding progress and terminal progress also refresh the library; embedding remains nonterminal, and terminal progress refreshes search.

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
7. Apply EXIF orientation except for HEIF, whose decoder applies container transforms.
8. Generate a double-gradient perceptual hash from the oriented source, then resize once to a `large` preview bounded at 1,600 pixels and derive smaller thumbnails from that preview using original-derived target dimensions. Bundled libwebp now applies lossy color quality 80/85/85/90 for tiny/small/medium/large, with lossless alpha encoding. Derived pixels are not lossless; originals, orientation handling, pHash input, and EXIF extraction are unchanged. Thumbnail errors fail the photo result rather than marking it ready.
9. Defer CLIP image embeddings to the Inngest embedding function.

RAW files are not demosaiced with LibRaw or `rsraw` in this checkout. There is no current histogram-matching implementation.

### Database and vectors

SQLite is opened with Bun and `sqlite-vec` in `apps/api/src/db/setup.ts`. Drizzle uses the schema from `packages/db/src/schema.ts`.

The tables are:

- `photos`: file identity, dimensions, timestamps, RAW metadata, processing statuses, and private committed source/artifact roots, fingerprints, version, and thumbnail key.
- `photo_exif`: one-to-one camera, lens, exposure, date, and GPS metadata.
- `photo_embedding`: one CLIP embedding blob per photo, with model version and thumbnail generation.
- `photo_phash`: one perceptual hash per photo.
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

Native development also requires Rust/Cargo, a C toolchain, `pkg-config`, OpenSSL development headers, `libheif-dev`, `libclang-dev`, and the `exiftool` executable. Debian/Ubuntu runtime images need `libheif1` and `libimage-exiftool-perl`.

The first CLIP operation may download the FastEmbed model. Set `FASTEMBED_CACHE_DIR` to control the cache location.

### Development servers

```bash
bun run dev              # Turbo starts packages/apps that define a dev script; currently API and web
bun run dev:api          # API on port 3000
bun run dev:web          # Web on port 3001
bun run dev:mobile       # Expo development server
```

The root `dev` command does not start mobile because mobile defines `start`, not `dev`. There is no worker command. Configure an Inngest development/runtime service separately when testing scan execution locally.

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
cd packages/image-processing && cargo test
```

Web E2E tests use Playwright with mocked tRPC, image, and Inngest requests. Mobile tests use Jest Expo and heavily mocked native/API dependencies. API tests use an in-memory SQLite database and the shared migrations.

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
| `FASTEMBED_CACHE_DIR` | unset | Optional Rust/FastEmbed model cache |
| `PHOTO_PROCESSING_THREADS` | available CPU capacity | Positive integer read by Rust at pool initialization; lower it to reduce concurrent decoded-image memory |
| `INNGEST_REALTIME_BASE_URL` | unset | Client-reachable Inngest HTTP(S) origin returned alongside subscription tokens |
| `INNGEST_SERVE_ORIGIN` | unset | API callback origin parsed and passed to the Inngest Hono handler as `serveHost` |

`DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are still parsed as legacy configuration but are not used by the current Rust preview pipeline. Do not document them as active RAW dependencies.

The Inngest SDK reads `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY` directly. PhotoBrain parses `INNGEST_SERVE_ORIGIN` and passes it to the Hono handler as `serveHost`; set it to an API origin reachable from the runtime so registration cannot infer `localhost` from an internal request. Production/self-hosting requires `INNGEST_DEV=0`, matching runtime/API keys, and a reachable runtime. Keep `INNGEST_BASE_URL` server-internal if desired; `INNGEST_REALTIME_BASE_URL` must be reachable by web/mobile and expose `/v1/realtime/connect`. Both clients attach a keyless SDK client to initial/refreshed tokens. Never ship server keys in public client variables. The homelab runtime is managed in the external ArgoCD repository; it stores orchestration state separately from PhotoBrain's database/photos. See [self-hosted setup](README.md#self-hosted-inngest).

The tracked `.envrc` sets `PHOTO_DIRECTORY=/photos`, `PORT=3000`, and `VITE_API_URL=http://localhost:3000` when direnv loads it. Check the shell environment before diagnosing path behavior.

### Web

Development reads `VITE_API_URL`, defaulting to `http://localhost:3000`.

The production Bun server in `apps/web/serve.ts` reads:

- `API_URL`, default `http://localhost:3000`
- `HOST`, default `0.0.0.0`
- `PORT`, default `3001`

It injects `window.__CONFIG__` into `index.html`, allowing the API URL to change without rebuilding the Vite bundle.

### Mobile

`EXPO_PUBLIC_API_URL` is read by `apps/mobile/src/config.ts`, with a fallback to `http://localhost:3000`. EAS profiles currently set `https://photobrain-api.ericj5.com` in `apps/mobile/eas.json`.

## API Contract Summary

All tRPC procedures are public; there is no authentication or authorization middleware.

| Procedure | Type | Purpose |
|---|---|---|
| `folders` | query | Builds a sorted folder tree and counts direct-child photos |
| `filterOptions` | query | Distinct camera, lens, ISO, and `YYYY-MM` values, optionally folder-scoped |
| `photos` | query | Lists photos with optional raw/type, folder, camera, lens, ISO, and month filters |
| `photo` | query | Returns one photo with EXIF by numeric ID |
| `searchPhotos` | query | CLIP text search, limit 1-100 |
| `scan` | mutation | Defaults to incremental scanning; optional `{ force: true }` reprocesses all discovered files. Creates a durable job and returns `{ success, jobId? }` |
| `scanStatus` | query | Returns durable progress for a scan UUID or `null` |
| `realtimeToken` | query | Returns `{ token, baseUrl? }` for a job ID; optional client-reachable self-hosted origin |

REST routes under `/api/photos`:

- `GET /api/photos/:id/file`: streams the original standard image; serves the `large` WebP for converted RAW files.
- `GET /api/photos/:id/thumbnail/:size`: serves `tiny`, `small`, `medium`, or `large` WebP and falls back to the file route when missing.
- `POST /api/photos/reprocess-heic`: one-off maintenance route; still present and should be removed after its operational use.
- `POST /api/photos/backfill-thumbnail-timestamps`: one-off maintenance route for missing `thumbnailUpdatedAt` values.

Managed scans write `{thumbnailRoot}/{size}/.versions/{uuid}/photo.webp` and publish the committed root/key with the photo. Legacy adopted files retain mirrored paths such as `large/2024/trip/photo.webp`; direct native helpers retain that default layout. REST resolves the committed root/key, with configured-root/path fallbacks for legacy rows. Immutable responses include generation/mtime/size ETags; `thumbnailUpdatedAt` advances monotonically even for same-second commits or backwards clocks. Clients use it for thumbnail cache busting, and web full-image URLs also include it. Old and abandoned generations are retained; garbage collection is not implemented.

## Frontend Behavior

### Web

The active route tree is in `apps/web/src/App.tsx`:

- `/` -> `Dashboard`
- `/collections` -> placeholder page
- `/preferences` -> placeholder page
- `/about` -> informational page

The dashboard combines folder navigation, EXIF filters, semantic search, grid/loupe views, metadata, scan progress, and a loupe filmstrip. The web uses single active-photo state, not multi-selection.

The normal scan control is incremental. The separate **Reprocess all photos…** control requires confirmation before regenerating thumbnails and embeddings; originals remain untouched.

Implemented keyboard shortcuts:

- `G`: grid view
- `E`: loupe view when a photo is active
- `Tab`: toggle all panels
- `Shift+Space`: toggle filmstrip
- Left/right arrows: navigate in loupe or with an active photo
- `Escape`: return from loupe to grid

Modifier-click range selection and `Ctrl/Cmd+A` are not implemented. Panel width/height values are persisted by `usePanelState`, but `PanelLayout` currently renders fixed dimensions.

### Mobile

The active entrypoint is `expo-router/entry`; routes live in `apps/mobile/app/`. `apps/mobile/App.tsx` is a legacy React Navigation entrypoint and is not the configured production entrypoint or the target of active navigation tests.

The active native tabs are Library, Collections, and an isolated Search tab. Library has a persistent header with live scrolling-grid blur and a visible-photo date, a continuous five-column phone grid ordered oldest-to-newest and opened at its newest edge, basic selection, EXIF filters, durable scan progress, and metadata. Scrolling back in time replaces the native tabs with a collapsed Collections + Years/Months/All + Search browsing bar. The modal loupe combines paged swipes, native iOS pinch zoom, a synchronized thumbnail filmstrip, and compact date/time and info controls. Library and Search create separate full-screen modal safe-area providers. Search uses a native iOS search bar and a 350 ms cancellable debounce. Library and loupe chrome use `expo-glass-effect` with opaque platform/Reduce Transparency fallbacks; Library also uses a masked `expo-blur` backdrop.

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

- Runs API tests and typecheck.
- Runs web Playwright E2E tests.
- Runs mobile Jest tests and preview-build decision regressions.
- Before main's iOS/Android preview OTA publication, resolves the iOS Expo fingerprint runtime and reuses, waits for, or creates a compatible internal iOS preview. Failed or incompatible builds block publication. Version tags still wait for a production iOS EAS build before the iOS production update.
- Provides a manual forced iOS preview rebuild sharing the automatic release's concurrency group. Both report install links; preview environment values must match the build profile.
- Builds and pushes API, web, and mobile Docker targets.
- Updates API/web/mobile image tags in the external ArgoCD repository on pushes to `main`.

The API and worker must not be described as separate services unless a future change actually introduces a worker. Production still requires a reachable Inngest runtime for asynchronous processing and shared access to the SQLite database, photo directory, and thumbnail directory.

## Change Recipes

### Add or change an API capability

1. Add typed procedures to `apps/api/src/trpc/router.ts` for metadata/query/mutation behavior.
2. Add binary streaming behavior to `apps/api/src/routes/photos.ts` only when tRPC is unsuitable.
3. Keep client types inferred from `@photobrain/api`; do not hand-maintain duplicate DTOs.
4. Add or update API tests using the in-memory database setup when behavior is query/filter related.

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
- Root `CLAUDE.md` if commands, boundaries, or cross-package invariants change.
- `README.md` or an app README if setup, deployment, or user-visible behavior changes.
- `ROADMAP.md` only for roadmap status; do not use it as the implementation source of truth.

Before finishing documentation work, check links, run `git diff --check`, and search for stale terms such as `apps/worker`, `BullMQ`, `REDIS_URL`, and `onTaskProgress` in current (non-historical) documentation.
