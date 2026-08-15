# CLAUDE.md - PhotoBrain Agent Guide

This is the current implementation guide for agents working in PhotoBrain. Prefer the source tree and the scoped guides linked below over older roadmap notes or generated artifacts.

## Read First

- This repository is a Bun/Turbo monorepo with three applications and four shared packages.
- There is no `apps/worker` directory, BullMQ consumer, or Redis requirement in the current implementation.
- Background scan and embedding functions are Inngest functions registered by the API at `/api/inngest`.
- Image processing is a native Rust N-API addon. It is not an active WASM implementation.
- EXIF extraction and RAW preview extraction invoke the external `exiftool` executable.
- The shared database schema is authoritative. `apps/api/src/db/schema.ts` only re-exports it.
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

1. `trpc.scan` creates a UUID and sends `photos/scan.requested`.
2. The Inngest scan function discovers supported files with Rust `discoverPhotos`.
3. Files are processed in batches of 20 with Rust `processPhotosBatch`.
4. Successful results update `photos`, `photo_exif`, and `photo_phash`.
5. Pending photo IDs trigger `photos/embeddings.requested`.
6. The embedding function reads `large` WebP thumbnails in batches of 16, generates CLIP embeddings, and updates `photo_embedding` and `embeddingStatus`.
7. Both functions publish progress to the Inngest Realtime channel `job:{jobId}`.

The web and mobile clients obtain a Realtime token through `trpc.realtimeToken` and subscribe directly with `@inngest/realtime`.

There is no repository-local worker process. Running the API alone exposes the Inngest handler, but an Inngest development/runtime service must deliver events to that handler for asynchronous jobs to execute. This repository has no `dev:worker` script.

### Image processing

`packages/image-processing` is a Rust `cdylib` built with N-API. The normal scan pipeline is:

1. Walk the photo directory, skip hidden entries, and retain supported extensions.
2. Read filesystem metadata.
3. Extract EXIF with `exiftool`.
4. Detect HEIF by extension or magic bytes and decode it with `libheif-rs`.
5. For RAW files, extract an embedded JPEG preview with `exiftool -b -PreviewImage`, falling back to `-JpgFromRaw`.
6. Decode standard images with the Rust `image` crate.
7. Apply EXIF orientation except for HEIF, whose decoder applies container transforms.
8. Generate a double-gradient perceptual hash and four WebP thumbnails.
9. Defer CLIP image embeddings to the Inngest embedding function.

RAW files are not demosaiced with LibRaw or `rsraw` in this checkout. There is no current histogram-matching implementation.

### Database and vectors

SQLite is opened with Bun and `sqlite-vec` in `apps/api/src/db/setup.ts`. Drizzle uses the schema from `packages/db/src/schema.ts`.

The tables are:

- `photos`: file identity, dimensions, timestamps, RAW metadata, and processing statuses.
- `photo_exif`: one-to-one camera, lens, exposure, date, and GPS metadata.
- `photo_embedding`: one CLIP embedding blob per photo.
- `photo_phash`: one perceptual hash per photo.

Semantic search creates a CLIP text embedding and queries `photo_embedding` with `vec_distance_L2`. The embedding model is `ClipVitB32`; the database does not enforce a vector dimension.

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
bun run typecheck        # Turbo tasks; mobile's current script is only an informational echo
cd apps/api && bun test
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

`DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are still parsed as legacy configuration but are not used by the current Rust preview pipeline. Do not document them as active RAW dependencies.

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
| `scan` | mutation | Sends an Inngest scan event and returns `{ success, jobId }` |
| `realtimeToken` | query | Returns an Inngest Realtime token for a job ID |

REST routes under `/api/photos`:

- `GET /api/photos/:id/file`: streams the original standard image; serves the `large` WebP for converted RAW files.
- `GET /api/photos/:id/thumbnail/:size`: serves `tiny`, `small`, `medium`, or `large` WebP and falls back to the file route when missing.
- `POST /api/photos/reprocess-heic`: one-off maintenance route; still present and should be removed after its operational use.
- `POST /api/photos/backfill-thumbnail-timestamps`: one-off maintenance route for missing `thumbnailUpdatedAt` values.

Thumbnail files mirror the relative photo path under `{thumbnailsRoot}/{size}`. For example, `2024/trip/photo.jpg` becomes `large/2024/trip/photo.webp`. API responses use long-lived immutable caching and file mtime/size ETags; clients add `?v={thumbnailUpdatedAt}` for cache busting.

## Frontend Behavior

### Web

The active route tree is in `apps/web/src/App.tsx`:

- `/` -> `Dashboard`
- `/collections` -> placeholder page
- `/preferences` -> placeholder page
- `/about` -> informational page

The dashboard combines folder navigation, EXIF filters, semantic search, grid/loupe views, metadata, scan progress, and a loupe filmstrip. The web uses single active-photo state, not multi-selection.

Implemented keyboard shortcuts:

- `G`: grid view
- `E`: loupe view when a photo is active
- `Tab`: toggle all panels
- `Shift+Space`: toggle filmstrip
- Left/right arrows: navigate in loupe or with an active photo
- `Escape`: return from loupe to grid

Modifier-click range selection and `Ctrl/Cmd+A` are not implemented. Panel width/height values are persisted by `usePanelState`, but `PanelLayout` currently renders fixed dimensions.

### Mobile

The active entrypoint is `expo-router/entry`; routes live in `apps/mobile/app/`. `apps/mobile/App.tsx` is a legacy React Navigation entrypoint used by some tests and is not the configured production entrypoint.

The active tabs are Photos, Search, Albums, and Library. The dashboard has a four-column date-grouped grid, EXIF filter sheet, scan progress, metadata, and a modal loupe with pinch/pan/zoom and swipe navigation. Search is a separate tab and queries CLIP on each non-empty input change without a debounce. Collections remains a placeholder. Preferences persist light/dark/system theme selection; some display/behavior controls are currently disabled or hardcoded.

## Deployment

The current `Dockerfile` has five stages:

1. `builder`: installs Bun/Rust/native dependencies and builds the N-API addon.
2. `api`: runs the Hono/Bun API on port 3000.
3. `web-builder`: builds the Vite web app.
4. `web`: runs the Bun static server on port 3001 with runtime API configuration.
5. `mobile`: installs the workspace and runs the Expo development server on port 8081.

There is no worker image and the mobile Docker target is not a static Expo web-export image. `apps/mobile/package.json` does provide `bun run build:web` for manual Expo web export.

`.github/workflows/build.yml` currently:

- Runs web Playwright E2E tests.
- Runs mobile Jest tests.
- Publishes EAS OTA updates on pushes to `main` and version tags.
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
- The Rust batch processor uses a Rayon pool capped at four threads. Callback completion order is not input order.
- Thumbnail generation can log a warning while a photo result remains successful; verify files before treating `thumbnailStatus` as reliable.
- Scans do not delete database rows for files removed from disk.
- A successful scan resets processed photos to `embeddingStatus: "pending"`, even when a source file is unchanged.
- EXIF and pHash sidecar writes are not one transaction with the photo row.
- Missing later EXIF or pHash data does not currently remove an old sidecar row.
- Thumbnail paths are extension-stripped and path-based; different source files with the same relative stem can collide.
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
