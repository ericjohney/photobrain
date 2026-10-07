# PhotoBrain API

The API is a Hono/Bun server exposing typed tRPC procedures, REST image streaming routes, and Inngest functions for scanning and CLIP embedding generation.

Read [`AGENTS.md`](AGENTS.md) for implementation details and [`../../AGENTS.md`](../../AGENTS.md) for repository-wide rules.

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
| `V1_NATIVE_SCAN_MUTATIONS_ENABLED` | `false`; accepts `true`, `false`, `1`, or `0` |
| `INNGEST_SERVE_ORIGIN` | unset; inferred from the request |
| `INNGEST_REALTIME_BASE_URL` | unset; client SDK default |

`DATABASE_URL`, `PHOTO_DIRECTORY`, and `THUMBNAILS_DIRECTORY` are relative to the API process working directory. Set `RUN_DB_INIT=true` to apply migrations from `packages/db/drizzle` on startup, or use the database package scripts directly.

`FASTEMBED_CACHE_DIR` is consumed by the native image-processing package. `DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are legacy parsed values and are not active RAW dependencies.

The Inngest SDK reads its server variables `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY` directly. PhotoBrain parses `INNGEST_SERVE_ORIGIN` and passes it explicitly to the Hono handler as `serveHost`; set it to an API origin reachable from the runtime so internal registration requests cannot publish a `localhost` callback. Deployed/self-hosted runtimes require `INNGEST_DEV=0` and matching event/signing keys; local Dev Server use requires `INNGEST_DEV=1`. `INNGEST_REALTIME_BASE_URL` is the phone/browser-reachable origin returned alongside the subscription token, not the internal server-to-server URL. See [self-hosted setup](../../README.md#self-hosted-inngest). Neither key belongs in a mobile or web bundle.

## HTTP API

Registered route families:

- `GET /api/health`
- `GET|POST /api/trpc/*`
- `GET|POST /api/v1/*`
- `GET /api/photos/:id/file`
- `GET /api/photos/:id/thumbnail/:size`
- `POST /api/photos/reprocess-heic` (one-off maintenance)
- `POST /api/photos/backfill-thumbnail-timestamps` (one-off maintenance)
- `GET|PUT|POST /api/inngest`

Photo metadata, folders, filters, search, scans, durable scan status, and Realtime token creation remain available to the Expo/web clients as tRPC procedures in `src/trpc/router.ts`:

- `folders`
- `filterOptions`
- `photos`
- `photo`
- `searchPhotos`
- `scan`
- `scanStatus`
- `realtimeToken`

There are no legacy REST `GET /api/photos`, `GET /api/photos/:id`, `POST /api/scan`, or `GET /api/image/:filename` endpoints.

### Native JSON API v1

The additive native Swift transport is ordinary JSON mounted at `/api/v1`; it does not require tRPC batching or SuperJSON. Its checked-in OpenAPI 3.1 contract is `src/routes/openapi-v1.json`.

| Method and path | Contract |
|---|---|
| `GET /api/v1/folders` | Sorted recursive folder tree and total photo count. |
| `GET /api/v1/filter-options?folder=` | Camera, lens, ISO, and normalized `YYYY-MM` options, optionally folder-scoped. |
| `GET /api/v1/photos` | All matching photos with EXIF and `{ total, rawCount }`; accepts `filterRaw`, `folder`, `camera`, `lens`, `iso`, and `dateMonth`. |
| `GET /api/v1/photos/:id` | One positive-integer photo ID or `PHOTO_NOT_FOUND`. |
| `POST /api/v1/search` | Strict `{ query, limit }` JSON; limit defaults to 20 and must be 1–100. |
| `POST /api/v1/scans` | Strict optional `{ force }` JSON; incremental by default and containment-gated as described below. |
| `GET /api/v1/scans/active` | `{ jobs }` containing only active scans in deterministic recovery order. |
| `GET /api/v1/scans/:jobId` | Durable scan status, or JSON `null` for an unknown valid UUID. |

V1 scan responses expose only the approved phases `queued`, `discovering`, `processing`, `generating-embeddings`, `completed`, `failed`, and `cancelled`, and statuses `queued`, `processing`, `completed`, and `failed`. The serializer maps persisted legacy/internal `scan-complete` and `embedding` phases to `generating-embeddings`, and `running` status to `processing`; any other stored value fails closed. Timestamps are ISO 8601 strings. Stored scan failure details are replaced with the public error `The scan could not be completed`; start-dispatch failures use `The scan could not be started`.

All v1, tRPC, and file routes are currently public and unauthenticated.

### V1 scan-mutation containment

`V1_NATIVE_SCAN_MUTATIONS_ENABLED` defaults to `false`. While false, `POST /api/v1/scans` returns HTTP 503 with `{ "error": { "code": "NATIVE_SCAN_DISABLED", "message": "Native scan mutations are disabled" } }` before request parsing or the start-scan service, so it creates no scan row and sends no event. The flag does not disable v1 reads, image routes, `/api/inngest`, or legacy tRPC, including the legacy scan mutation.

Setting the flag true enables only the v1 scan mutation; it is not an authentication or authorization boundary. Deployment value, ACL behavior, and no-side-effect containment remain external release evidence rather than facts established by source inspection.

## Background Processing

The legacy tRPC `scan` mutation and enabled v1 scan mutation share the same scan-start service. A request defaults to incremental work, creates a durable queued job, and dispatches `photos/scan.requested`. The registered `scan-photos-v5` function freezes discovery and work classification in durable manifests/items, streams pending media through the bounded native executor, atomically commits current-generation results and progress, and checkpoints every 20 completions. It dispatches only photos needing current embeddings to `generate-embeddings-v3`.

The embedding function reads committed `large` WebP thumbnails in batches of 16, generation-checks vector writes, and publishes `embedding`/`completed` progress. Both functions persist durable `scan_jobs` state and publish Realtime progress on `job:{jobId}`. Clients obtain subscription tokens through `realtimeToken`; the native v1 client uses durable status and active-scan recovery rather than that tRPC token procedure.

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

The API tests use in-memory SQLite with the shared migrations. They cover catalog filtering, scan creation/failure semantics, v1 validation/serialization/parity/containment, active-scan ordering, scan planning and durable receipts, native-executor coordination, embedding generation checks, and import persistence. Binary REST file streaming, live Inngest delivery, live vector-model inference, and migration startup remain outside this test suite.
