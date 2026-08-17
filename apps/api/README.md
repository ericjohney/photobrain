# PhotoBrain API

The API is a Hono/Bun server exposing typed tRPC procedures, REST image streaming routes, and Inngest functions for scanning and CLIP embedding generation.

Read [`AGENTS.md`](AGENTS.md) for implementation details and [`../../CLAUDE.md`](../../CLAUDE.md) for repository-wide rules.

## Development

From the repository root:

```bash
bun install
cd packages/image-processing && bun run build
```

Then, from the repository root in a new terminal:

```bash
bun run dev:api
```

The server listens on `http://localhost:3000` by default. The API package scripts are:

```bash
bun run dev
bun test
```

There is no API-local worker process. An Inngest development/runtime service must invoke `/api/inngest` for scan and embedding events to execute.

## Configuration

Variables are parsed in `src/config.ts`:

| Variable | Default |
|---|---|
| `HOST` | `0.0.0.0` |
| `PORT` | `3000` |
| `DATABASE_URL` | `./photobrain.db` |
| `PHOTO_DIRECTORY` | `../../temp-photos` |
| `THUMBNAILS_DIRECTORY` | `./thumbnails` |
| `NODE_ENV` | `development` |
| `RUN_DB_INIT` | `false` |

`DATABASE_URL`, `PHOTO_DIRECTORY`, and `THUMBNAILS_DIRECTORY` are relative to the API process working directory. Set `RUN_DB_INIT=true` to apply migrations from `packages/db/drizzle` on startup, or use the database package scripts directly.

`FASTEMBED_CACHE_DIR` is consumed by the native image-processing package. `DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are legacy parsed values and are not active RAW dependencies.

## HTTP API

Registered routes:

- `GET /api/health`
- `GET|POST /api/trpc/*`
- `GET /api/photos/:id/file`
- `GET /api/photos/:id/thumbnail/:size`
- `POST /api/photos/reprocess-heic` (one-off maintenance)
- `POST /api/photos/backfill-thumbnail-timestamps` (one-off maintenance)
- `GET|PUT|POST /api/inngest`

Photo metadata, folders, filters, search, scans, and Realtime token creation are tRPC procedures in `src/trpc/router.ts`:

- `folders`
- `filterOptions`
- `photos`
- `photo`
- `searchPhotos`
- `scan`
- `realtimeToken`

There are no REST `GET /api/photos`, `GET /api/photos/:id`, `POST /api/scan`, or `GET /api/image/:filename` endpoints.

All procedures and file routes are currently public and unauthenticated.

## Background Processing

`scan` sends `photos/scan.requested` with absolute photo and thumbnail directories plus a job ID. The registered Inngest scan function:

1. Discovers supported files with the Rust addon.
2. Processes files in batches of 20.
3. Persists successful photo, EXIF, and pHash results.
4. Publishes progress on `job:{jobId}`.
5. Sends pending photo IDs to `photos/embeddings.requested`.

The embedding function reads `large` WebP thumbnails in batches of 16, stores CLIP vectors in `photo_embedding`, and publishes `embedding`/`completed` progress. Clients obtain subscription tokens through `realtimeToken`.

## Database

The authoritative schema is `packages/db/src/schema.ts`; `src/db/schema.ts` only re-exports it. Migrations and Drizzle Kit commands are in `packages/db`:

```bash
cd packages/db
bun run db:generate
DATABASE_URL=../../apps/api/photobrain.db bun run db:migrate
DATABASE_URL=../../apps/api/photobrain.db bun run db:studio
```

The API loads `sqlite-vec` at runtime for `vec_distance_L2` semantic search. See [`../../packages/db/AGENTS.md`](../../packages/db/AGENTS.md) for migration and lifecycle caveats.

## Tests

```bash
bun test
```

The current API tests use an in-memory SQLite database with the shared migrations and cover folder-scoped filter options and EXIF/raw/camera/lens/ISO/date filtering. REST, Inngest function, vector-search, and migration-startup coverage is not currently present.
