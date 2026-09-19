# API Agent Guide

Scope: `apps/api`.

## Source Map

- `src/index.ts`: Hono/Bun entrypoint and route registration.
- `src/config.ts`: environment parsing and defaults.
- `src/trpc/router.ts`: public tRPC contract.
- `src/routes/photos.ts`: binary file and thumbnail routes plus one-off maintenance routes.
- `src/inngest/client.ts`: typed event definitions and Realtime middleware.
- `src/inngest/functions/scan.ts`: durable discovery, continuous Rust processing, and completed-result checkpoints.
- `src/inngest/functions/embeddings.ts`: deferred CLIP embedding batches.
- `src/services/vector-search.ts`: sqlite-vec text search.
- `src/services/import-persistence.ts`: synchronous transactional scan and embedding batch writes.
- `src/services/native-executor.ts` and `native-worker.ts`: bounded persistent worker with a native photo stream surviving checkpoint windows; no database or Inngest state in the worker.
- `src/services/scan-work.ts`: frozen manifests, priority-ordered pending work, atomic per-photo receipts/progress, and terminal cleanup.
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

The API package has no separately deployed worker or build script. Inngest functions are registered in this API process at `/api/inngest`; a separate Inngest runtime invokes that endpoint. A lazy `node:worker_threads` worker offloads discovery, streaming media, HEIC maintenance, and CLIP image batches. It admits at most eight running/queued requests and owns one native photo stream. A completion window returns after 20 finished results, not 20 particular inputs; the stream remains alive and bounded between windows. Job/destination switches and other native operations cancel/drain an existing stream before replacement. Worker failures reject outstanding requests; resumed scans reload pending SQLite receipts. This is not a native process-crash or cross-process artifact-ownership boundary. Direct text search remains synchronous.

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
- Function ID is `scan-photos-v4`. `initialize-scan-work-v4` persists a frozen manifest, including empty discovery, rather than storing a library-sized path plan in Inngest checkpoints.
- `initializeScanWork` stably orders new paths before existing paths. Workers dispatch in that priority order, but fast existing photos may commit while earlier new photos are still running. This does not skip unchanged photos.
- Native ready/results queues each hold at most twice the CPU-sized worker count; metadata prefetch is separate from media completion. The API pulls one result and acknowledges it after its commit. `consumePhotos` binds loaders/consumers to their calling async context so Inngest Realtime works from worker event callbacks.
- Each `consume-photo-results-v4-*` step consumes up to 20 completions while retaining the live stream. Every result transaction includes photo/EXIF/pHash saves, its success/failure receipt, manifest counters, and scan progress. A rollback leaves that item pending; an acknowledged receipt is not redone after a lost checkpoint or process restart. Checkpoints return compact counters, not paths/native results/EXIF. First completion publishes immediately, with at most one in-flight Realtime publication and one coalesced latest snapshot inside the step.
- Existing rows are matched by unique relative `photos.path`.
- Photo rows use a path-keyed upsert that preserves their IDs and original creation dates. EXIF and pHash sidecars are upserted only when new data exists, preserving sidecar IDs.
- Every successfully processed photo is marked `thumbnailStatus: "completed"`, `thumbnailUpdatedAt: new Date()`, and `embeddingStatus: "pending"`.
- A successful scan sends exactly the photo IDs saved by that scan in one final embedding event, not one event per media batch.
- Durable and Realtime progress phases are `queued`, `discovering`, `processing`, `scan-complete`, `embedding`, `completed`, and `failed`.
- Terminal database states are monotonic. Each function's initial progress update acts as a durable claim and missing or terminal jobs exit before media work. Both functions mark exhausted retries failed and attempt to publish terminal Realtime progress; a nonempty all-failed scan is also failed.
- `scan-complete` is persisted before dispatching the embedding child; the parent performs no progress writes after dispatch, preventing it from overwriting a fast child completion.
- The current 7,961-file library needs 399 completed-result windows plus fixed steps, below the documented 1,000-step ceiling. Native path arrays and the final embedding ID list still grow with the library.
- Drain active old runs, rebuild the native addon, and apply migration `0005_continuous_scan_work.sql` before deploying `scan-photos-v4`. Receipts remain until final IDs/dispatch are checkpointed; success and terminal failure clean them up. Cancellation failure cannot leave an exhausted job running. Local verification is not a production deployment.

Both clients refresh library queries as committed processing counts advance: first advance immediately, then coalesced trailing refreshes at most once per second. They also refresh on `scan-complete`/first embedding progress and terminal progress; embedding remains nonterminal, and terminal progress refreshes search. Web polls durable `scanStatus` every 1,500 ms while active; mobile retains its fallback/recovery polling. Public event/progress payloads are unchanged; the internal work-ledger schema is new.

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

`FASTEMBED_CACHE_DIR` and `PHOTO_PROCESSING_THREADS` are read by Rust, not parsed here. The media pool defaults to `available_parallelism()`; the override must be a positive integer and is read once when the pool initializes. Larger pools increase decoded-image memory; lower the override when needed. `DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are legacy parsed values and do not control the current pipeline.

The Inngest SDK reads `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, and `INNGEST_SERVE_ORIGIN` directly. For self-hosting, use production mode (`INNGEST_DEV=0`), matching server-only keys on the runtime/API, and an internal base URL. Set `INNGEST_REALTIME_BASE_URL` separately to the client-reachable HTTP(S) origin exposing `/v1/realtime/connect`. Never return either server key to clients. Register `/api/inngest` with the runtime and enable periodic app sync. SDK v3.54.2 is compatible with the self-hosted v1.45.1 server, which rejects vulnerable SDK releases below v3.54.0. The Hono handler must continue to allow only GET/PUT/POST.

## Database Rules

- Use `@photobrain/db/schema` for schema changes.
- Migrations live at `packages/db/drizzle`.
- `scan_jobs` is the durable source for web/mobile polling and recovery; preserve terminal-state monotonicity when changing job code.
- Startup migration is opt-in with `RUN_DB_INIT=true` for direct API runs. The API Docker image enables it so deployed schema changes are applied before serving traffic.
- The standalone `src/db/migrate.ts` is not the normal migration path and currently points at an API-local `./drizzle` directory that does not exist.
- Do not assume scan removes rows for files deleted from disk.
- Streaming scan transactions include photo/EXIF/pHash/status saves, item receipts, manifest counters, and scan progress. Embedding transactions include vectors and embedding statuses. Native work/network publication remain outside transactions; never put async callbacks inside Bun SQLite transactions. `clearScanWork` explicitly deletes items and manifests in one transaction because foreign-key enforcement is not guaranteed on every connection.

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

`src/__tests__/scan.test.ts` exercises real SQLite manifests/receipts with controlled native/Inngest dependencies: new-first dispatch with free completion order, early visibility, partial ACK restart, lost checkpoints, atomic rollback, publication failure, final dispatch/fast-child ordering, empty and terminal jobs, cleanup, and the 7,961-input checkpoint budget. These are not actual Inngest delivery or native integration tests.

`src/__tests__/import-persistence.test.ts` covers native-result mapping, stable IDs, retry behavior, missing sidecars/vectors, batch boundaries, and transaction rollback using SQLite failure triggers. It does not execute native image processing or Inngest delivery.

`bun run bench:import` compares legacy per-photo writes with the shared transactional batch helper using 200 synthetic results, three repeats, and isolated file-backed databases. It checks persisted-data equivalence and reports fresh-import, rescan, and embedding-write medians with SQLite pragmas. It does not exercise streaming receipts, native work, or end-to-end import latency; use the real-photo/runtime measurements for those boundaries.

`src/__tests__/native-executor.test.ts` uses real worker threads with a controlled TypeScript fixture. It covers persistent completion windows, persistence ACK backpressure, per-checkpoint async context, session switching, early stream termination/invalid indices, restart, bounded admission, and shutdown. The release addon and actual local Inngest/API/web flow were also exercised on Apple M4 Pro/macOS 26.5.1, including interrupted-import receipt recovery and real HEIC maintenance; see [measurement boundaries and results](../../docs/import-performance.md). Revalidate the deployed Bun/native environment during rollout.

`bun run bench:exif <1-20 distinct photo paths>` requires ExifTool but not the addon, reads the Rust metadata flags, and compares batched versus four-concurrent per-file metadata extraction with exact JSON equivalence checks. `EXIFTOOL_BIN` selects an executable for this benchmark only. See [import architecture and measurements](../../docs/import-performance.md) for measured scope, implemented receipts, and remaining incremental/generation-aware work.
