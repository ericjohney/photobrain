# PhotoBrain

PhotoBrain is a self-hosted photo library with a Lightroom-inspired web interface, an Expo mobile app, CLIP semantic search, EXIF metadata, RAW preview support, and Rust-powered thumbnail processing.

## Current Features

- Web grid and loupe views with keyboard navigation, metadata, folders, and EXIF filters.
- Expo mobile app with native Library/Collections/Search tabs, bottom Years/Months/All Photos browsing, captured/recently-added sorting, selection, debounced search, and Photos-inspired filters with searchable camera/lens/ISO/month lists and RAW/standard choices. Liquid Glass chrome on supported iOS versions, a paged loupe with a synchronized thumbnail filmstrip and native iOS pinch zoom, and theme preferences.
- Four derived WebP preview sizes: `tiny`, `small`, `medium`, and `large`. Preview color is lossy; original photo files are untouched.
- CLIP semantic search with embeddings generated after a scan.
- EXIF extraction through `exiftool`, including camera, lens, exposure, date, GPS, and orientation data.
- Standard image, HEIF/HEIC, and common RAW file discovery.
- RAW display through embedded JPEG previews extracted with `exiftool`; this checkout does not demosaic RAW files.
- Perceptual hashes stored for future duplicate-detection features.
- Incremental scans reuse unchanged media and recover embeddings separately. Confirmed **Reprocess all photos** controls in the web toolbar and mobile Library Options deliberately rebuild the library's derived media.
- SQLite/Drizzle persistence with runtime `sqlite-vec` vector search.

## Architecture

PhotoBrain is a Bun/Turbo monorepo:

```text
apps/
  api/                    Hono + tRPC API, REST file routes, Inngest functions
  web/                    React/Vite browser application
  mobile/                 Expo/React Native application using Expo Router
packages/
  config/                 Shared TypeScript configuration
  db/                     Drizzle schema and migrations
  image-processing/       Rust N-API native image processing
  utils/                  Shared TypeScript helpers and thumbnail paths
```

There is no `apps/worker`, BullMQ consumer, or Redis dependency in the current implementation. The API registers scan and embedding functions at `/api/inngest`; an Inngest development/runtime service must deliver events to that endpoint for asynchronous work to execute.

CPU-heavy import work runs behind one persistent worker thread inside the API process, not a separate service. A continuously fed Rust pool uses available CPU capacity and saves photos as they finish; slow photos no longer hold up an input batch. SQLite receipts let interrupted scans resume pending work without repeating acknowledged photos. Database writes and Inngest checkpoints remain on the API thread.

Detailed implementation guidance is in:

- [`CLAUDE.md`](CLAUDE.md): cross-repository architecture, commands, invariants, and documentation map.
- [`apps/api/AGENTS.md`](apps/api/AGENTS.md): API, database orchestration, and Inngest jobs.
- [`apps/web/AGENTS.md`](apps/web/AGENTS.md): browser routes, state, UI, and Playwright.
- [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md): Expo Router, native behavior, EAS, and Jest.
- [`packages/image-processing/AGENTS.md`](packages/image-processing/AGENTS.md): Rust/N-API pipeline and native dependencies.
- [`packages/db/AGENTS.md`](packages/db/AGENTS.md): schema, migrations, and persistence caveats.
- [`packages/utils/AGENTS.md`](packages/utils/AGENTS.md): shared thumbnail and utility contracts.
- [`packages/config/AGENTS.md`](packages/config/AGENTS.md): shared TypeScript configuration.

## Prerequisites

- [Bun](https://bun.sh/)
- Rust and Cargo
- A C toolchain, `pkg-config`, OpenSSL development headers, `libheif-dev`, and `libclang-dev` for the native addon
- The `exiftool` executable for EXIF and RAW preview extraction
- Docker only if you want to run the documented runtime dependencies or build images
- An Inngest development/runtime service for executing scan and embedding events

On Debian/Ubuntu, the native build dependencies are typically:

```bash
apt-get install -y build-essential pkg-config libssl-dev libheif-dev libclang-dev
```

Install `exiftool` separately, for example with the distribution's `libimage-exiftool-perl` package. The API runtime also needs `libheif1`.

## Quick Start

Install the workspace and build the native addon:

```bash
bun install
cd packages/image-processing && bun run build
```

The API defaults to a database at `./photobrain.db`, a photo directory at `../../temp-photos`, and thumbnails at `./thumbnails`, all relative to the API process working directory. Either run migrations explicitly or enable startup migrations:

```bash
cd packages/db && DATABASE_URL=../../apps/api/photobrain.db bun run db:migrate
```

Then, from the repository root in a new terminal:

```bash
RUN_DB_INIT=true bun run dev:api
```

From the repository root in new terminals, start the API and web application:

```bash
bun run dev:api
bun run dev:web
```

The API is available at `http://localhost:3000` and the web app at `http://localhost:3001`. Start Expo separately when needed:

```bash
bun run dev:mobile
```

Start the Inngest Dev Server in another terminal:

```bash
bunx inngest-cli@1.45.1 dev -u http://localhost:3000/api/inngest
```

Run the API with `INNGEST_DEV=1` for local development. For mobile progress, also set `INNGEST_REALTIME_BASE_URL=http://<your-host-LAN-address>:8288` on the API so the phone can reach the Dev Server. Running the API by itself does not execute queued events. Never use development mode in a deployed environment; it disables signature verification.

## Commands

From the repository root:

```bash
bun install
bun run dev
bun run dev:api
bun run dev:web
bun run dev:mobile
bun run build
bun run typecheck
bun run lint
bun run format
bun run check
bun run ci:check
```

`bun run dev` starts the API and web tasks defined for Turbo. Mobile defines `start`, not `dev`, so use `bun run dev:mobile` separately. `check` and `format` modify files; `ci:check` is the read-only Biome validation.

Package/app validation:

```bash
cd apps/api && bun test
cd apps/api && bun run typecheck
cd apps/web && bun run test:e2e
cd apps/web && bun run test:e2e:ui
cd apps/mobile && bun run test
cd apps/mobile && bun run typecheck
cd packages/image-processing && cargo test
```

## Configuration

### API

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bun server host |
| `PORT` | `3000` | API port |
| `DATABASE_URL` | `./photobrain.db` | SQLite path, relative to the API process |
| `PHOTO_DIRECTORY` | `../../temp-photos` | Directory scanned by Inngest |
| `THUMBNAILS_DIRECTORY` | `./thumbnails` | Generated thumbnail root |
| `NODE_ENV` | `development` | Runtime environment |
| `RUN_DB_INIT` | `false` | Set to `true` or `1` to run shared migrations on startup |
| `FASTEMBED_CACHE_DIR` | unset | Optional FastEmbed model cache directory |
| `PHOTO_PROCESSING_THREADS` | available CPU capacity | Optional positive integer limiting concurrent media processing; read once by Rust when its pool initializes |
| `INNGEST_DEV` | SDK default | Use `1` only for local development; `0` for production/self-hosting |
| `INNGEST_BASE_URL` | SDK default | Server-to-server Inngest origin; set for self-hosting |
| `INNGEST_EVENT_KEY` | unset | Server-only key used to submit events |
| `INNGEST_SIGNING_KEY` | unset | Server-only key for authenticated callbacks and Realtime token creation |
| `INNGEST_SERVE_ORIGIN` | inferred | Optional callback origin parsed by the API and passed to Inngest as `serveHost` |
| `INNGEST_REALTIME_BASE_URL` | unset | Client-reachable HTTP(S) Inngest origin for WebSocket subscriptions |

`DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are parsed legacy values and are not used by the current image pipeline.

More photo workers use more decoded-image memory. Reduce `PHOTO_PROCESSING_THREADS` on memory-constrained hosts; storage, ExifTool, startup, and the final few photos can still leave CPUs idle. See [historical measured CPU, memory, and throughput](docs/import-performance.md#continuous-pool--2026-09-19).

For the incremental-scan cutover, drain old **scan and embedding** runs, rebuild the native addon, and apply `0006_incremental_scan.sql` (and any earlier unapplied migrations) before starting `scan-photos-v5` and `generate-embeddings-v3`. Their function/checkpoint graphs are replay-sensitive. `RUN_DB_INIT=true` performs migrations on startup; the API Docker image enables it.

### Self-hosted Inngest

Run `inngest start`, not `inngest dev`, with a persistent data directory and matching event/signing keys on both Inngest and the API. Use `INNGEST_DEV=0` and set the API's `INNGEST_BASE_URL` to the runtime's internal origin. Set `INNGEST_SERVE_ORIGIN` to the API origin reachable from the runtime; PhotoBrain passes it explicitly as the SDK `serveHost` so internal registration requests cannot publish a `localhost` callback. Register the API's `/api/inngest` endpoint with `--sdk-url`; `--poll-interval=60` picks up function changes after API deployments. Inngest v1.45.1 requires TypeScript SDK v3.54.0 or newer; this workspace uses v3.54.2.

The API returns `INNGEST_REALTIME_BASE_URL` alongside the short-lived subscription token. Web and mobile attach a keyless SDK client pointing to that origin. If unset, the existing SDK endpoint defaults apply. For self-hosting, use an origin reachable by the phone/browser, not a Kubernetes service name; expose `/v1/realtime/connect` through the gateway. Event submission, token minting, registration, and the dashboard do not need client-facing routes. Never put the event or signing key in `EXPO_PUBLIC_*` or `VITE_*` variables.

The homelab manifests are maintained in the separate ArgoCD repository under `apps/photobrain-inngest` and `apps/photobrain/values-api.yaml`. They use a single-node runtime with a dedicated iSCSI volume, Vault-backed keys, internal API callbacks, and a subscription-only route on the existing API hostname. Inngest owns orchestration state, not the photo library or PhotoBrain SQLite database. Its embedded queue snapshots are not crash-proof delivery or an off-volume backup.

### Web

For Vite development, set `VITE_API_URL` in `apps/web/.env`:

```env
VITE_API_URL=http://localhost:3000
```

The production Bun server reads `API_URL`, `HOST`, and `PORT`. It injects the API URL into the built HTML at runtime, so changing `API_URL` does not require rebuilding the web bundle.

### Mobile

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env`:

```env
EXPO_PUBLIC_API_URL=http://localhost:3000
```

For an Android emulator use `http://10.0.2.2:3000`; for a physical device use the host machine's LAN address. EAS profiles currently configure `https://photobrain-api.ericj5.com`.

## API Overview

Metadata, filtering, search, scanning, and progress-token operations use tRPC at `/api/trpc`:

- `folders`
- `filterOptions`
- `photos`
- `photo`
- `searchPhotos`
- `scan`
- `scanStatus`
- `realtimeToken`

Binary routes use REST:

- `GET /api/health`
- `GET /api/photos/:id/file`
- `GET /api/photos/:id/thumbnail/:size`
- `GET|PUT|POST /api/inngest`

Two one-off maintenance POST routes remain under `/api/photos`: `reprocess-heic` and `backfill-thumbnail-timestamps`. They should not become part of new client behavior and should be removed after their operational work is complete.

All current API routes are unauthenticated.

## Image and Job Flow

`trpc.scan()` and `trpc.scan({})` request an incremental scan. It creates a durable `scan_jobs` row before sending an Inngest event, then freezes discovery, source identity, and work classification in SQLite. Unchanged photos with valid media and current vectors are left untouched; missing, failed, wrong-model, wrong-generation, or truncated vectors recover in a separate embedding phase without regenerating valid media. New or changed sources, obsolete media versions, and missing or invalid thumbnails require media processing. Missing EXIF alone does not cause endless retries.

Use **Reprocess all photos** in the web toolbar or mobile **Library Options** and confirm the prompt to deliberately regenerate every discovered file, including unchanged files. This submits `trpc.scan({ force: true })`; it preserves photo IDs and original files, but creates new derived-media generations and embeddings.

Media work enters a continuously fed pool with new paths first; workers do not wait for an input batch, and photos appear in web/mobile as they finish and commit. Inngest checkpoints every 20 completed results while native work continues behind bounded queues. After media processing, one embedding job reads committed `large` WebP previews in batches of 16 and stores CLIP vectors. Embedding remains active work, not completion. Both clients combine Realtime with durable polling; mobile also recovers active work after an app restart.

The native pipeline independently prefetches `exiftool` metadata (up to 20 photos per command), uses separate ExifTool commands for embedded RAW previews, `libheif-rs` for HEIF decoding, and the Rust `image` crate for standard formats. A shared Rayon pool defaults to available CPU capacity, with `PHOTO_PROCESSING_THREADS` as a memory/concurrency override. See [`packages/image-processing/AGENTS.md`](packages/image-processing/AGENTS.md) for format and processing caveats.

Generated previews use lossy WebP color encoding (quality 80/85/85/90 for tiny/small/medium/large) and lossless alpha encoding. Original photo files are not modified. A thumbnail generation failure does not mark that photo ready.

Freshness uses the canonical source root (`realpath`) and source size, nanosecond mtime, and nanosecond ctime—not a content hash. Tracked reuse also requires completed thumbnails/pHash, a stored pHash, dimensions, converted RAW state when applicable, matching `MEDIA_VERSION`, and matching stat fingerprints for all four thumbnails. `MEDIA_VERSION` and `EMBEDDING_MODEL_VERSION` are manual invalidation constants: maintainers must advance the relevant version when processing or model semantics change. Metadata fingerprints cannot prove byte identity; force reprocessing is available when metadata-based reuse is not sufficient.

Existing untracked photos get one conservative legacy-adoption opportunity. All six freshness fields must be null, source size and stored whole-second mtime must match, and a thumbnail timestamp must exist. Reuse also requires no NFC-normalized/case-insensitive stem collision, source ctime strictly older than every thumbnail mtime, four decoded WebPs with expected dimensions, and a post-validation stat recheck. This is heuristic provenance, not proof of historical content or root. Successful adoption preserves IDs, artifacts, and thumbnail timestamps; embedding recovery is independent. Rows that cannot qualify are reprocessed.

Every media attempt writes a unique `.versions/<UUID>/photo.image` key, producing `{thumbnailRoot}/{size}/.versions/<UUID>/photo.webp`. The photo row commits its thumbnail root, key, and fingerprint only after source/attempt/previous-generation checks succeed; stale results cannot replace a newer committed generation. Embedding saves check the generation too, inference uses its committed thumbnail root, and semantic search excludes noncompleted, wrong-model, or wrong-generation vectors. Cache-busting timestamps advance monotonically in whole seconds even within one second or after a backwards clock change.

Retired and abandoned artifact generations remain on disk. This avoids overwriting a generation being served or embedded, but repeated repairs and force reprocessing consume additional storage; there is no artifact garbage collector yet. Scans also do not reconcile deleted source files.

Each streamed completion commits photo/EXIF/pHash data, its durable receipt, counters, and scan progress atomically. A failed transaction leaves the photo pending; an acknowledged receipt prevents duplicate work after checkpoint loss or restart. Embedding writes remain transactional batches. `bun run bench:import` from `apps/api` still benchmarks the shared batch-persistence helper against legacy writes; it does not measure the rolling scheduler or end-to-end import speed.

Run `bun run bench:exif <1-20 distinct photo paths>` from `apps/api` to compare batched metadata extraction with per-file extraction without modifying photos. It requires ExifTool, not the native addon. [Import performance and architecture](docs/import-performance.md) records historical continuous-pool measurements and current incremental-scan smoke evidence, and separates implemented identity/classification/generation fencing from future outbox delivery, garbage collection, distributed ownership, and streamed embeddings.

## Production Builds

The Dockerfile has five targets:

```bash
docker build --target api -t photobrain-api .
docker build --target web -t photobrain-web .
docker build --target mobile -t photobrain-mobile .
```

The API image applies shared migrations on startup and runs on port 3000. The web image serves the Vite SPA on port 3001. The mobile image runs the Expo development server on port 8081; it is not a static Expo web-export image.

The GitHub Actions workflow runs API tests/typecheck, web Playwright tests, mobile Jest tests, and preview-build decision tests. Pushes to `main` ensure a compatible installable iOS preview before publishing iOS/Android preview OTA updates: reuse a finished binary, wait for an existing matching build, or build a new one based on the Expo runtime fingerprint. Version tags build production iOS artifacts and publish matching updates. The workflow also builds API/web/mobile images and updates external ArgoCD image tags on pushes to `main`.

The manual `EAS Preview iOS Build` workflow forces a fresh internal iOS preview. It shares the automatic release's concurrency group; both report an install link in the job summary. Keep EAS preview environment values aligned with `preview.env` in `apps/mobile/eas.json`; mismatches stop the release.

For native mobile builds and OTA updates, see `apps/mobile/eas.json` and [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md).

## Roadmap and Historical Notes

`ROADMAP.md` contains future work and historical implementation notes. Some older session sections describe BullMQ, a worker process, LibRaw/`rsraw`, or `kamadak-exif`; those are not the current implementation. Check the source and the scoped agent guides before using a roadmap detail.

## License

The repository currently tracks an MIT license for the native image-processing package at `packages/image-processing/LICENSE`; no root `LICENSE` file is currently tracked.
