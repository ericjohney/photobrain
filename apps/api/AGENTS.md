# API Agent Guide

Scope: `apps/api`.

## Source Map

- `src/index.ts`: Hono/Bun entrypoint and route registration.
- `src/config.ts`: environment parsing and defaults.
- `src/trpc/router.ts`: public tRPC contract.
- `src/routes/photos.ts`: binary file and thumbnail routes plus one-off maintenance routes.
- `src/inngest/client.ts`: typed event definitions and Realtime middleware.
- `src/inngest/functions/scan.ts`: discovery, Rust batch processing, and database persistence.
- `src/inngest/functions/embeddings.ts`: deferred CLIP embedding batches.
- `src/services/vector-search.ts`: sqlite-vec text search.
- `src/services/import-persistence.ts`: synchronous transactional scan and embedding batch writes.
- `src/services/native-executor.ts` and `native-worker.ts`: bounded, persistent in-process worker thread for synchronous native import calls; no database or Inngest state inside the worker.
- `src/db/index.ts`: SQLite/Drizzle connection and optional startup migration.
- `src/db/setup.ts`: Bun SQLite and sqlite-vec loading.
- `src/db/schema.ts`: re-export of `@photobrain/db/schema`; do not add the authoritative schema here.
- `src/__tests__/`: in-memory SQLite API tests.

## Commands

```bash
cd apps/api && bun run dev
cd apps/api && bun test
cd apps/api && bun run typecheck
cd apps/api && bun run bench:import
cd apps/api && bun run bench:exif /path/to/photo1.jpg /path/to/photo2.heic
```

The API package has no separately deployed worker or build script. Inngest functions are registered in this same API process at `/api/inngest`. A separate Inngest development/runtime service must invoke that endpoint. A lazy `node:worker_threads` worker offloads import discovery, native media batches, and CLIP image batches from the API event loop. It executes one call at a time, admits at most eight running/queued calls, and retains native caches between batches. Errors/overload reject the current step for Inngest retry; worker death rejects outstanding requests and a later call recreates it. It is not a durable queue or a native process-crash boundary. Text search and maintenance native calls are not offloaded.

## HTTP Surface

The Hono server registers:

- `GET /api/health`
- `GET|POST /api/trpc/*` through the fetch adapter
- `GET /api/photos/:id/file`
- `GET /api/photos/:id/thumbnail/:size`
- `POST /api/photos/reprocess-heic` (one-off maintenance)
- `POST /api/photos/backfill-thumbnail-timestamps` (one-off maintenance)
- `GET|PUT|POST /api/inngest`

There are no REST `GET /api/photos`, `GET /api/photos/:id`, `POST /api/scan`, or `GET /api/image/:filename` routes. Metadata and scan operations use tRPC.

## tRPC Procedures

All procedures use `publicProcedure`; authentication is not implemented.

- `folders`: reads every photo path, builds a sorted slash-delimited folder tree, and counts photos directly in each folder.
- `filterOptions({ folder? })`: returns distinct combined camera names, lens models, ISO values, and date-month prefixes.
- `photos({ filterRaw?, folder?, camera?, lens?, iso?, dateMonth? })`: returns `{ photos, total, rawCount }` with EXIF relations. A folder query initially matches descendants, then JavaScript removes nested descendants so only direct files are returned.
- `photo({ id })`: returns one photo with EXIF or throws `Photo not found`.
- `searchPhotos({ query, limit? })`: generates a CLIP text embedding and returns nearest photo rows. `limit` is 1-100 and defaults to 20.
- `scan()`: creates a durable queued `scan_jobs` row, sends an idempotently keyed `photos/scan.requested` event, and returns `{ success, jobId }` or `{ success: false, error, jobId? }`. Dispatch is attempted twice; a final failure marks only a still-queued row failed. A delayed event for a job already marked terminal exits before photo processing.
- `scanStatus({ jobId })`: returns the durable scan row or `null` when the UUID is unknown.
- `realtimeToken({ jobId })`: returns `{ token, baseUrl? }` for channel `job:{jobId}`, topic `progress`. `baseUrl` is the client-reachable `INNGEST_REALTIME_BASE_URL`; it must not be inferred from an internal service hostname.

Keep the router as the source of client types. `src/types.ts` exports `AppRouter` for workspace consumers.

## Inngest Flow

Typed events in `src/inngest/client.ts`:

```text
photos/scan.requested
  { directory, thumbnailsDir, jobId }

photos/embeddings.requested
  { photoIds, thumbnailsDir, jobId }
```

Scan function details:

- Concurrency limit is 1 for executing steps, not an exclusive whole-job library lock.
- Discovery is a checkpointed step.
- Processing uses Rust batches of 20.
- Discovery and processing await the shared native executor; checkpoint names and result shapes are unchanged. The API executor rejects mismatched absolute/relative path arrays before native invocation.
- Native processing and database persistence are separate checkpointed steps. Native failures are skipped; each save batch is one synchronous SQLite transaction. Database failures roll back the entire save batch and escape the step so Inngest can retry it without rerunning native processing.
- Existing rows are matched by unique relative `photos.path`.
- Photo rows use a path-keyed upsert that preserves their IDs and original creation dates. EXIF and pHash sidecars are upserted only when new data exists, preserving sidecar IDs.
- Every successfully processed photo is marked `thumbnailStatus: "completed"`, `thumbnailUpdatedAt: new Date()`, and `embeddingStatus: "pending"`.
- A successful scan sends exactly the photo IDs saved by that scan to the embedding function.
- Durable and Realtime progress phases are `queued`, `discovering`, `processing`, `scan-complete`, `embedding`, `completed`, and `failed`.
- Terminal database states are monotonic. Each function's initial progress update acts as a durable claim and missing or terminal jobs exit before media work. Both functions mark exhausted retries failed and attempt to publish terminal Realtime progress; a nonempty all-failed scan is also failed.
- `scan-complete` is persisted before dispatching the embedding child; the parent performs no progress writes after dispatch, preventing it from overwriting a fast child completion.

Embedding function details:

- Concurrency limit is 1.
- Reads `large` thumbnail paths from the database and processes batches of 16.
- Upserts `photo_embedding` and photo embedding statuses in one synchronous transaction per batch, after inference. Failed inference retains any old vector and marks the photo failed. A database failure rolls back the batch; inference and saving still share one checkpointed step, so a retry repeats inference.
- Converts the Rust number array to a `Float32Array` buffer before storage.
- Marks each photo `completed` or `failed` and publishes progress.
- Marks the scan job failed if no requested embedding can be generated; partial success still completes the job.

## Configuration

Active API variables are parsed in `src/config.ts`:

- `HOST=0.0.0.0`
- `PORT=3000`
- `DATABASE_URL=./photobrain.db`
- `PHOTO_DIRECTORY=../../temp-photos`
- `THUMBNAILS_DIRECTORY=./thumbnails`
- `NODE_ENV=development`
- `RUN_DB_INIT=false`
- `INNGEST_REALTIME_BASE_URL` (optional validated URL, returned to clients)

`DATABASE_URL`, `PHOTO_DIRECTORY`, and `THUMBNAILS_DIRECTORY` are relative to the process working directory. The normal `bun run dev:api` script runs from `apps/api`.

`FASTEMBED_CACHE_DIR` is consumed by the Rust package, not parsed here. `DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are legacy parsed values and do not control the current Rust pipeline.

The Inngest SDK reads `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, and `INNGEST_SERVE_ORIGIN` directly. For self-hosting, use production mode (`INNGEST_DEV=0`), matching server-only keys on the runtime/API, and an internal base URL. Set `INNGEST_REALTIME_BASE_URL` separately to the client-reachable HTTP(S) origin exposing `/v1/realtime/connect`. Never return either server key to clients. Register `/api/inngest` with the runtime and enable periodic app sync. SDK v3.54.2 is compatible with the self-hosted v1.45.1 server, which rejects vulnerable SDK releases below v3.54.0. The Hono handler must continue to allow only GET/PUT/POST.

## Database Rules

- Use `@photobrain/db/schema` for schema changes.
- Migrations live at `packages/db/drizzle`.
- `scan_jobs` is the durable source for mobile polling and recovery; preserve terminal-state monotonicity when changing job code.
- Startup migration is opt-in with `RUN_DB_INIT=true` for direct API runs. The API Docker image enables it so deployed schema changes are applied before serving traffic.
- The standalone `src/db/migrate.ts` is not the normal migration path and currently points at an API-local `./drizzle` directory that does not exist.
- Do not assume scan removes rows for files deleted from disk.
- Each scan save batch atomically writes photos, EXIF, pHash, and processing statuses. Each embedding save batch atomically writes vectors and embedding statuses. Native media work and scan-job progress writes are outside these transactions; do not put async callbacks inside Bun SQLite transactions.

## REST File Rules

- Standard files are served from `join(PHOTO_DIRECTORY, photo.path)`.
- Converted RAW files serve the `large` WebP because browsers cannot display the original RAW.
- Thumbnail paths are computed from the database path and mirror its directories under the configured thumbnail root.
- Valid thumbnail sizes are `tiny`, `small`, `medium`, and `large`.
- Missing thumbnails redirect to the file route.
- Thumbnail responses use one-year immutable caching and ETags based on file mtime and size.
- Validate numeric IDs and thumbnail sizes before filesystem work.
- Preserve path normalization and do not expose arbitrary filesystem paths.

The two POST maintenance routes are operational leftovers. Do not add new callers to them; remove them after confirming their one-off migration work is complete.

## Tests

`src/__tests__/filters.test.ts` uses `createTestDb()` from `src/__tests__/setup.ts`, an in-memory SQLite database with shared migrations and seeded EXIF data. It covers folder-scoped filter options, raw/camera/lens/ISO/date filters, durable scan creation/status, dispatch failures, and missing job IDs.

There are no current API tests that execute Inngest functions, REST serving, vector search, startup migrations, or thumbnail generation. Add focused tests when changing those areas.

`src/__tests__/import-persistence.test.ts` covers native-result mapping, stable IDs, retry behavior, missing sidecars/vectors, batch boundaries, and transaction rollback using SQLite failure triggers. It does not execute native image processing or Inngest delivery.

`bun run bench:import` compares legacy per-photo writes with transactional upserts using 200 synthetic results, three repeats, and isolated file-backed databases. It checks persisted-data equivalence and reports median fresh-import, rescan, and embedding-write times with the SQLite pragmas. No native addon, photos, or CLIP downloads are required. These are persistence-only measurements, sensitive to the temporary filesystem, not end-to-end import estimates. Native-processing, inference, and database-save batch timings are also logged during real scans to identify the next bottleneck.

`src/__tests__/native-executor.test.ts` uses real worker threads with a blocking TypeScript fixture, not the native addon. It covers event-loop responsiveness during work, FIFO reuse, bounded admission, failure recovery, startup errors, path alignment, and shutdown. Test the actual addon lifecycle on the deployed Bun version after rebuilding; fixture tests are not native integration coverage.

`bun run bench:exif <1-20 distinct photo paths>` requires ExifTool but not the addon, reads the Rust metadata flags, and compares batched versus four-concurrent per-file metadata extraction with exact JSON equivalence checks. `EXIFTOOL_BIN` selects an executable for this benchmark only. See [import architecture and measurements](../../docs/import-performance.md) for measured scope, incremental-scan prerequisites, and proposed bounded durable work records.
