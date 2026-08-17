# PhotoBrain

PhotoBrain is a self-hosted photo library with a Lightroom-inspired web interface, an Expo mobile app, CLIP semantic search, EXIF metadata, RAW preview support, and Rust-powered thumbnail processing.

## Current Features

- Web grid and loupe views with keyboard navigation, metadata, folders, and EXIF filters.
- Expo mobile app with native Library/Search tabs, adaptive timelines, debounced search, filters, Liquid Glass chrome on supported iOS versions, pinch/pan/zoom loupe viewing, and theme preferences.
- Four WebP thumbnail sizes: `tiny`, `small`, `medium`, and `large`.
- CLIP semantic search with embeddings generated after a scan.
- EXIF extraction through `exiftool`, including camera, lens, exposure, date, GPS, and orientation data.
- Standard image, HEIF/HEIC, and common RAW file discovery.
- RAW display through embedded JPEG previews extracted with `exiftool`; this checkout does not demosaic RAW files.
- Perceptual hashes stored for future duplicate-detection features.
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

Configure an Inngest development/runtime service to invoke `http://localhost:3000/api/inngest` before testing scans end to end. Running the API by itself does not execute queued events.

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

`DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are parsed legacy values and are not used by the current image pipeline.

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

Scanning is requested through `trpc.scan`, which creates a durable `scan_jobs` row before sending an Inngest event. The scan function discovers supported files, processes Rust batches of 20, writes photo/EXIF/pHash data, and persists/publishes progress. It sends the IDs saved by that scan to the embedding function, which reads `large` WebP thumbnails in batches of 16 and stores CLIP vectors. Mobile combines Realtime updates with `scanStatus` polling so active work can recover after an app restart or connection loss.

The native pipeline uses `exiftool` for EXIF and embedded RAW previews, `libheif-rs` for HEIF decoding, the Rust `image` crate for standard formats, and a four-thread-capped Rayon pool. See [`packages/image-processing/AGENTS.md`](packages/image-processing/AGENTS.md) for format and processing caveats.

## Production Builds

The Dockerfile has five targets:

```bash
docker build --target api -t photobrain-api .
docker build --target web -t photobrain-web .
docker build --target mobile -t photobrain-mobile .
```

The API image applies shared migrations on startup and runs on port 3000. The web image serves the Vite SPA on port 3001. The mobile image runs the Expo development server on port 8081; it is not a static Expo web-export image.

The GitHub Actions workflow runs API tests/typecheck, web Playwright tests, and mobile Jest tests; publishes preview EAS OTA updates for pushes to `main`; builds production iOS artifacts and publishes matching updates for tags; builds API/web/mobile images; and updates image tags in the external ArgoCD repository on pushes to `main`.

For native mobile builds and OTA updates, see `apps/mobile/eas.json` and [`apps/mobile/AGENTS.md`](apps/mobile/AGENTS.md).

## Roadmap and Historical Notes

`ROADMAP.md` contains future work and historical implementation notes. Some older session sections describe BullMQ, a worker process, LibRaw/`rsraw`, or `kamadak-exif`; those are not the current implementation. Check the source and the scoped agent guides before using a roadmap detail.

## License

The repository currently tracks an MIT license for the native image-processing package at `packages/image-processing/LICENSE`; no root `LICENSE` file is currently tracked.
