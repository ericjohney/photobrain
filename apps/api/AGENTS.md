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
- `src/db/index.ts`: SQLite/Drizzle connection and optional startup migration.
- `src/db/setup.ts`: Bun SQLite and sqlite-vec loading.
- `src/db/schema.ts`: re-export of `@photobrain/db/schema`; do not add the authoritative schema here.
- `src/__tests__/`: in-memory SQLite API tests.

## Commands

```bash
cd apps/api && bun run dev
cd apps/api && bun test
```

The API package has no local worker script, build script, or typecheck script. Inngest functions are registered in this same API process at `/api/inngest`. A separate Inngest development/runtime service must invoke that endpoint.

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
- `scan()`: generates a UUID, resolves configured directories to absolute paths, sends `photos/scan.requested`, and returns `{ success, jobId }` or `{ success: false, error }`.
- `realtimeToken({ jobId })`: returns a token for channel `job:{jobId}`, topic `progress`.

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

- Concurrency limit is 1.
- Discovery is a checkpointed step.
- Processing uses Rust batches of 20.
- Successful Rust results are persisted; failed results are logged and skipped.
- Existing rows are matched by unique relative `photos.path`.
- EXIF and pHash sidecars are deleted/reinserted only when new data exists.
- Every successfully processed photo is marked `thumbnailStatus: "completed"`, `thumbnailUpdatedAt: new Date()`, and `embeddingStatus: "pending"`.
- Any successful scan result triggers embedding for every currently pending photo, not only files from that scan.
- Progress phases are `discovering`, `processing`, `scan-complete`, `embedding`, and `completed`.

Embedding function details:

- Concurrency limit is 1.
- Reads `large` thumbnail paths from the database and processes batches of 16.
- Deletes and reinserts each `photo_embedding` row.
- Converts the Rust number array to a `Float32Array` buffer before storage.
- Marks each photo `completed` or `failed` and publishes progress.

## Configuration

Active API variables are parsed in `src/config.ts`:

- `HOST=0.0.0.0`
- `PORT=3000`
- `DATABASE_URL=./photobrain.db`
- `PHOTO_DIRECTORY=../../temp-photos`
- `THUMBNAILS_DIRECTORY=./thumbnails`
- `NODE_ENV=development`
- `RUN_DB_INIT=false`

`DATABASE_URL`, `PHOTO_DIRECTORY`, and `THUMBNAILS_DIRECTORY` are relative to the process working directory. The normal `bun run dev:api` script runs from `apps/api`.

`FASTEMBED_CACHE_DIR` is consumed by the Rust package, not parsed here. `DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are legacy parsed values and do not control the current Rust pipeline.

## Database Rules

- Use `@photobrain/db/schema` for schema changes.
- Migrations live at `packages/db/drizzle`.
- Startup migration is opt-in with `RUN_DB_INIT=true`.
- The standalone `src/db/migrate.ts` is not the normal migration path and currently points at an API-local `./drizzle` directory that does not exist.
- Do not assume scan removes rows for files deleted from disk.
- Do not assume scan persistence is transactional across photo, EXIF, pHash, and embedding status updates.

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

`src/__tests__/filters.test.ts` uses `createTestDb()` from `src/__tests__/setup.ts`, an in-memory SQLite database with shared migrations and seeded EXIF data. It covers folder-scoped filter options and raw/camera/lens/ISO/date filters.

There are no current API tests for REST serving, Inngest function execution, vector search, startup migrations, or thumbnail generation. Add focused tests when changing those areas.
