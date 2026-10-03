# API Agent Guide

Scope: `apps/api`.

## Source Map

- `src/index.ts`: Hono/Bun entrypoint and route registration.
- `src/config.ts`: environment parsing and defaults.
- `src/trpc/router.ts`: public tRPC transport contract for web and Expo clients.
- `src/routes/v1.ts`, `v1-schemas.ts`, and `openapi-v1.json`: versioned JSON compatibility API, runtime DTO validation/serialization, and checked-in native-client contract.
- `src/routes/photos.ts`: binary file and thumbnail routes plus one-off maintenance routes.
- `src/inngest/client.ts`: typed event definitions and Realtime middleware.
- `src/inngest/functions/scan.ts`: durable incremental planning, continuous Rust processing, and completed-result checkpoints.
- `src/inngest/functions/embeddings.ts`: deferred CLIP embedding batches; tags each saved vector in the same transaction and finally requests the tag backfill.
- `src/inngest/functions/tags.ts`: `tag-photos-v1` backfill of vectors lacking current-vocabulary tags.
- `src/services/tag-vocabulary.ts`: `TAG_VOCABULARY_VERSION`, the 80-label `{ tag, prompt }` vocabulary, and the tag slug pattern.
- `src/services/photo-tagging.ts`: pure zero-shot scoring (`scoreTags`), tag persistence, backfill batches, and `getPhotoTags`; imports no native code.
- `src/services/tag-labels.ts`: lazy, per-process memoized label vectors from `clipTextEmbedding` (`loadTagLabelMatrix`).
- `src/services/vector-search.ts`: sqlite-vec text search and photo-to-photo similarity (`findSimilarToPhoto`), shared by both transports; every query takes an injectable `ApiDatabase`.
- `src/services/photo-catalog.ts`: shared folder/filter/photo reads used by tRPC and `/api/v1`.
- `src/services/photo-curation.ts`: shared single-statement star rating/flag updates used by tRPC `setPhotoCuration` and `PATCH /api/v1/photos/:id`.
- `src/services/collections.ts`: shared manual-album operations (list/create/rename/delete, add/remove membership, collections for a photo) and the `CollectionError` (`NAME_TAKEN`/`NOT_FOUND`) used by tRPC and `/api/v1`.
- `src/services/photo-search.ts`: shared search response orchestration used by both transports.
- `src/services/scan-jobs.ts`: shared durable scan creation/status/recovery operations used by both transports.
- `src/services/import-persistence.ts`: synchronous transactional scan and embedding batch writes.
- `src/services/scan-planner.ts`: source/artifact freshness checks and conservative legacy adoption.
- `src/services/processing-versions.ts`: manual media and embedding-model invalidation constants.
- `src/services/native-executor.ts` and `native-worker.ts`: bounded persistent worker with a native photo stream surviving checkpoint windows; no database or Inngest state in the worker.
- `src/services/scan-work.ts`: frozen classifications, priority-ordered pending media, attempt/generation fences, atomic per-photo receipts/progress, and terminal cleanup.
- `src/db/index.ts`: SQLite/Drizzle connection and optional startup migration.
- `src/db/setup.ts`: Bun SQLite and sqlite-vec loading.
- `src/db/schema.ts`: re-export of `@photobrain/db/schema` plus the public photo projection; do not add the authoritative schema here.
- `src/__tests__/`: in-memory SQLite API tests.

## Commands

```bash
cd apps/api && bun run dev
cd apps/api && bun test
cd apps/api && bun run typecheck
cd apps/api && bun run bench:import
cd apps/api && bun run bench:exif /path/to/photo1.jpg /path/to/photo2.heic
```

The API package has no separately deployed worker or build script. Inngest functions are registered in this API process at `/api/inngest`; a separate Inngest runtime invokes that endpoint. A lazy `node:worker_threads` worker offloads discovery, streaming media, thumbnail validation, HEIC maintenance, and CLIP image batches. It admits at most eight running/queued requests and owns one native photo stream. A completion window returns after 20 finished results, not 20 particular inputs; the stream remains alive and bounded between windows. Job/destination switches and other native operations cancel/drain an existing stream before replacement. Worker failures reject outstanding requests; resumed scans reload pending SQLite receipts. The worker is not a native process-crash boundary or a distributed lease; source/attempt/committed-generation checks fence publication separately. Direct text search remains synchronous.

## HTTP Surface

The Hono server registers:

- `GET /api/health`
- `GET|POST /api/trpc/*` through the fetch adapter
- `GET /api/v1/folders`
- `GET /api/v1/filter-options`
- `GET /api/v1/photos`
- `GET /api/v1/photos/:id`
- `PATCH /api/v1/photos/:id`
- `GET /api/v1/photos/:id/similar`
- `GET /api/v1/photos/:id/collections`
- `GET|POST /api/v1/collections`
- `PATCH|DELETE /api/v1/collections/:id`
- `POST /api/v1/collections/:id/photos`
- `POST /api/v1/collections/:id/photos/remove`
- `POST /api/v1/search`
- `POST /api/v1/scans`
- `GET /api/v1/scans/active`
- `GET /api/v1/scans/:jobId`
- `GET /api/photos/:id/file`
- `GET /api/photos/:id/thumbnail/:size`
- `POST /api/photos/reprocess-heic` (one-off maintenance)
- `POST /api/photos/backfill-thumbnail-timestamps` (one-off maintenance)
- `GET|PUT|POST /api/inngest`

There are no unversioned REST `GET /api/photos`, `GET /api/photos/:id`, `POST /api/scan`, or `GET /api/image/:filename` metadata routes. Web and Expo metadata/scan operations use tRPC; native Swift uses the `/api/v1` compatibility surface. Binary media remains under `/api/photos`.

## `/api/v1` Compatibility API

`/api/v1` is the explicit JSON contract for `apps/ios`. It shares `photo-catalog`, `photo-curation`, `photo-search`, `vector-search`, and `scan-jobs` domain services with tRPC; do not fork query, curation, search, similarity, scan creation, or scan-status behavior into a second implementation. Transport-specific Zod schemas validate requests, serialize dates as ISO strings, bound search and similarity limits to 1-100, and return stable error envelopes. The shared catalog's representation option normalizes Rust EXIF `YYYY:MM` month prefixes to `YYYY-MM` only for `/api/v1`, preserving the existing tRPC wire representation. Keep `src/routes/openapi-v1.json` synchronized with these routes and schemas.

`GET /folders`, `GET /filter-options`, `GET /photos`, `GET /photos/:id`, `GET /photos/:id/similar`, `POST /search`, `GET /scans/active`, and `GET /scans/:jobId` are readable regardless of the mutation flag. `GET /photos`, `POST /search`, and `GET /photos/:id/similar` accept `minRating` (integer 1-5) and `flag` (`pick`, `reject`, `unflagged`) with the shared catalog semantics. `POST /search` accepts `{ query, limit?, filterRaw?, folder?, camera?, lens?, iso?, dateMonth?, minRating?, flag? }` with the same filter semantics as `GET /photos`; `dateMonth` is the v1 `YYYY-MM` form, and unknown fields, an unknown `filterRaw`, or a non-integer `iso` return `400 INVALID_REQUEST`. `GET /photos/:id/similar?limit=` (1-100, default 30) returns `{ photos, total, sourcePhotoId, indexed }`, `400 INVALID_REQUEST` for a bad id/limit, and `404 PHOTO_NOT_FOUND`. `PATCH /photos/:id` accepts `{ rating?: 0-5, flag?: "pick" | "reject" | null }` (at least one key; unknown keys rejected), updates through the shared curation service, and returns `200` with the re-read Photo DTO, `400 INVALID_REQUEST`, or `404 PHOTO_NOT_FOUND`; it is user curation, not a scan mutation, so the scan flag does not gate it. Photo DTOs carry `rating` (0-5) and `flag` (`pick`/`reject`/`null`). `POST /scans` accepts optional `{ force }`, but defaults to `503` with `NATIVE_SCAN_DISABLED` until `V1_NATIVE_SCAN_MUTATIONS_ENABLED=true` or `1`.

Collections: `GET /collections` returns `{ collections }` sorted case-insensitively by name; `POST /collections` (`{ name, photoIds? }`) returns 201 with a Collection; `PATCH /collections/:id` (`{ name }`) returns 200; `DELETE /collections/:id` returns 204 with no body; `POST /collections/:id/photos` and `POST /collections/:id/photos/remove` (`{ photoIds }`, 1-500 positive integers) return `{ added, photoCount }` / `{ removed, photoCount }`; `GET /photos/:id/collections` returns `{ collectionIds }` or 404 `PHOTO_NOT_FOUND`. A Collection is `{ id, name, photoCount, cover: { photoId, thumbnailUpdatedAt } | null, createdAt, updatedAt }` with ISO timestamps. Bodies are strict; names are trimmed and must be 1-100 characters. Errors are 400 `INVALID_REQUEST`, 404 `COLLECTION_NOT_FOUND`, and 409 `COLLECTION_NAME_TAKEN`. `GET /photos`, `POST /search`, and `GET /photos/:id/similar` accept `collectionId` (positive integer).

Tags: `GET /photos/:id/tags` returns `{ tags: [{ tag, score }] }` (score descending, ties by tag) or 404 `PHOTO_NOT_FOUND`. `GET /filter-options` includes `tags: [{ tag, count }]`. `tag` (slug matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64 characters) is accepted on `GET /photos`, `POST /search`, and `GET /photos/:id/similar`; an invalid slug is 400 `INVALID_REQUEST`.

Every photo emitted by list, detail, search, or similarity must pass through the public projection and explicit serializer. Never expose `sourceRoot`, `sourceFingerprint`, `mediaVersion`, `thumbnailKey`, `thumbnailRoot`, or `thumbnailFingerprint`; those fields reveal private source/artifact identity. `/api/v1` is unauthenticated like the existing tRPC and media routes, so the projection is a privacy boundary, not an authorization substitute.

## tRPC Procedures

All procedures use `publicProcedure`; authentication is not implemented.

- `folders`: reads every photo path, builds a sorted slash-delimited folder tree, and counts photos directly in each folder.
- `filterOptions({ folder? })`: returns distinct combined camera names, lens models, ISO values, and date-month prefixes.
- `photos({ filterRaw?, folder?, camera?, lens?, iso?, dateMonth?, minRating?, flag?, collectionId? })`: returns `{ photos, total, rawCount }` with EXIF relations. Filters come from `photoFilterConditions` in `photo-catalog.ts`, shared with vector search so meanings cannot drift. A folder matches direct children only, in SQL (escaped `LIKE` prefix plus no further `/`), so `_`/`%` in folder names match literally. `minRating` (integer 1-5) keeps `rating >= n` and `flag` is `pick`, `reject`, or `unflagged` (NULL flag); both use the `photos` rating/flag indexes. `collectionId` keeps members via `photos.id IN (SELECT photo_id FROM collection_photos WHERE collection_id = ?)`, resolved through the membership primary key.
- `photo({ id })`: returns one photo with EXIF or throws `Photo not found`.
- `searchPhotos({ query, limit?, filterRaw?, folder?, camera?, lens?, iso?, dateMonth?, minRating?, flag?, collectionId? })`: generates a CLIP text embedding and returns `{ photos, total, query }`, nearest first. `limit` is 1-100 and defaults to 20. Filters use the same `photoFilterConditions` as `photos` and are applied inside the single KNN statement before `ORDER BY distance LIMIT`, so filtered-out photos never consume result slots.
- `similarPhotos({ photoId, limit?, minRating?, flag?, collectionId? })`: returns `{ photos, total, sourcePhotoId, indexed }` ranked by `vec_distance_L2` to the photo's committed vector, nearest first with ties by ascending ID, excluding the source. One SQL statement resolves the source vector and ranks candidates under the same validity filters as text search (completed status, current model, matching thumbnail key, equal vector length) plus any catalog filters, applied to candidates before the limit and never to the source; results are hydrated in one batched query. A source without a usable vector yields `indexed: false, photos: []`; an unknown ID throws `NOT_FOUND`. `limit` is 1-100 and defaults to 30.
- `setPhotoCuration({ photoIds, rating?, flag? })`: mutation applying a star rating (integer 0-5) and/or flag (`pick`, `reject`, or `null` to clear) to 1-500 positive photo IDs. At least one of `rating`/`flag` is required. `updatePhotoCuration` in `photo-curation.ts` deduplicates IDs and issues one `UPDATE ... WHERE id IN (...) RETURNING` inside a transaction, returning `{ updated: [{ id, rating, flag }] }` sorted by ID for existing photos only; unknown IDs are silently absent. Scan saves never write `rating`/`flag`, so rescans preserve curation.
- `collections`: returns `{ collections }` (Collection DTOs with `Date` timestamps) sorted by name `COLLATE NOCASE`, in one SQL statement; counts and the cover (most recently added existing member, ties by insertion order) are correlated primary-key lookups, so there is no N+1.
- `collectionsForPhoto({ photoId })`: returns `{ collectionIds }` sorted by ID, or `NOT_FOUND` for an unknown photo.
- `createCollection({ name, photoIds? })`, `renameCollection({ id, name })`, `deleteCollection({ id })` (returns `{ id }`), `addToCollection({ collectionId, photoIds })` (returns `{ added, photoCount }`), `removeFromCollection({ collectionId, photoIds })` (returns `{ removed, photoCount }`): names are trimmed and 1-100 characters, unique case-insensitively (renaming to a case variant of the collection's own name is allowed). `NAME_TAKEN` maps to `CONFLICT`, an unknown collection to `NOT_FOUND`, invalid input to `BAD_REQUEST`. Adds/removes take 1-500 IDs, ignore duplicates and unknown photos, run one existence SELECT plus one multi-row INSERT/DELETE in a transaction, and bump `updatedAt` only when membership changes. Deleting a collection never touches photos.
- `photoTags({ photoId })`: returns `{ tags: [{ tag, score }] }`, score descending then tag ascending, in one `LEFT JOIN` statement; `NOT_FOUND` for an unknown photo. `photos`, `searchPhotos`, and `similarPhotos` accept an optional `tag` slug, applied by `photoFilterConditions` as `photos.id IN (SELECT photo_id FROM photo_tags WHERE tag = ?)` (served by `idx_photo_tags_tag_photo_id`). `filterOptions` also returns `tags: [{ tag, count }]` under the same folder scope, count descending then tag ascending, only counts above zero.
- `scan()` or `scan({})`: incrementally reuses current media and vectors. `scan({ force: true })` reprocesses every discovered file. Both create a durable queued `scan_jobs` row, send an idempotently keyed `photos/scan.requested` event, and return `{ success, jobId }` or `{ success: false, error, jobId? }`. Dispatch is attempted twice; a final failure marks only a still-queued row failed. A delayed event for a job already marked terminal exits before photo processing. The web toolbar and Expo Library Options expose a confirmed **Reprocess all photos** action for force mode; native iOS reaches the same shared scan service through gated `POST /api/v1/scans`.
- `scanStatus({ jobId })`: returns the durable scan row or `null` when the UUID is unknown.
- `realtimeToken({ jobId })`: returns `{ token, baseUrl? }` for channel `job:{jobId}`, topic `progress`. `baseUrl` is the client-reachable `INNGEST_REALTIME_BASE_URL`; it must not be inferred from an internal service hostname.

Keep the tRPC router as the source of TypeScript client types for web/Expo; `src/types.ts` exports `AppRouter` for workspace consumers. Keep reusable behavior in the shared services and the native contract in `v1-schemas.ts`/`openapi-v1.json`. Both transports use `publicPhotoColumns` to omit six internal identity fields: `sourceRoot`, `sourceFingerprint`, `mediaVersion`, `thumbnailKey`, `thumbnailRoot`, and `thumbnailFingerprint`.

## Inngest Flow

Typed events in `src/inngest/client.ts`:

```text
photos/scan.requested
  { directory, thumbnailsDir, jobId, force? }

photos/embeddings.requested
  { photoIds, thumbnailsDir, jobId }

photos/tags.requested
  {}
```

Scan function details:

- Concurrency limit is 1 for executing steps, not an exclusive whole-job library lock.
- Function ID is `scan-photos-v5`. `initialize-scan-work-v5` freezes discovery and classification, including empty discovery, in SQLite rather than storing a library-sized path plan in Inngest checkpoints. The manifest records canonical source root, resolved thumbnail root, and unchanged/media/embedding counts.
- `createScanPlan` fingerprints sources as `size:mtimeNs:ctimeNs` under `realpath(directory)`. This is filesystem metadata, not a content hash. `MEDIA_VERSION` and `EMBEDDING_MODEL_VERSION` in `processing-versions.ts` are manually bumped invalidation constants, not automatically derived pipeline hashes.
- Tracked media is reusable only with completed thumbnail/pHash statuses, a pHash row, dimensions, converted RAW status when applicable, matching source root/fingerprint/media version/thumbnail root, and matching stat fingerprints for all four nonempty thumbnail files. Missing EXIF alone does not cause endless media retries.
- Legacy adoption requires all six identity fields to be null, matching size and stored whole-second mtime, a thumbnail timestamp, and no extension-stripped stem collision across known/discovered paths after NFC normalization and case folding. The source ctime must be strictly older than every thumbnail mtime; all four WebPs must decode at expected dimensions, and source/artifact stats are rechecked after validation. This is conservative heuristic provenance, not proof of historical content or root. Valid adoption preserves photo ID, artifacts, and cache timestamp while recording identity.
- `initializeScanWork` durably classifies reusable items as `skip` or `embed`, media work as `media`, and source-stat failures as `failed`. Completed, current-model, matching-generation 2,048-byte vectors can be reused; missing, failed, wrong-model, wrong-generation, or truncated vectors recover without regenerating valid media. Reused and failed items count as processed at initialization; unchanged counts include embedding-only recovery. New media paths dispatch before existing media paths, without imposing a completion barrier.
- Each pending media attempt receives a fresh `.versions/<UUID>/photo.image` key, producing `<thumbnailRoot>/<size>/.versions/<UUID>/photo.webp`. Restarts rotate attempt keys, so an abandoned native writer cannot overwrite current artifacts; different source extensions sharing a stem no longer collide.
- Native ready/results queues each hold at most twice the CPU-sized worker count; metadata prefetch is separate from media completion. The API pulls one result and acknowledges it after its commit. `consumePhotos` binds loaders/consumers to their calling async context so Inngest Realtime works from worker event callbacks.
- Each `consume-photo-results-v5-*` step consumes up to 20 completions while retaining the live stream. Before publication, the source must still match its frozen fingerprint and all four artifacts must have valid nonempty file stats. The transaction checks the current attempt key and the previous committed photo ID/key/source fingerprint; stale results cannot overwrite a newer generation.
- Every accepted result transaction includes photo/EXIF/pHash saves, its success/failure receipt, manifest counters, and scan progress. A rollback leaves that item pending; an acknowledged receipt is not redone after a lost checkpoint or process restart. Checkpoints return compact counters, not paths/native results/EXIF. First completion publishes immediately, with at most one in-flight Realtime publication and one coalesced latest snapshot inside the step.
- Photo rows are matched/upserted by unique relative `photos.path`, preserving IDs and original creation dates. New sidecar data is upserted without changing sidecar IDs; absent EXIF or pHash does not delete an old sidecar.
- Successfully committed media stores its source identity and thumbnail root/key/fingerprint, marks thumbnails completed, sets pHash status from the result, and sets embeddings pending. `thumbnailUpdatedAt` advances by at least one stored second over its previous value, even for same-second commits or a backwards clock. Unchanged media and embedding-only recovery preserve the cache token.
- Final embedding selection includes successful media and embedding-only items whose committed generation still matches the ledger and whose vector still needs recovery. One final event carries those IDs; fully unchanged scans complete without an embedding child.
- Durable and Realtime progress phases are `queued`, `discovering`, `processing`, `scan-complete`, `embedding`, `completed`, and `failed`.
- Terminal database states are monotonic. Each function's initial progress update acts as a durable claim and missing or terminal jobs exit before media work. Both functions mark exhausted retries failed and attempt to publish terminal Realtime progress; a nonempty all-failed scan is also failed.
- `scan-complete` is persisted before dispatching the embedding child; the parent performs no progress writes after dispatch, preventing it from overwriting a fast child completion.
- A full-media scan of the 7,961-file library needs 399 completed-result windows; embedding all files needs 498 batch steps. Each function remains below the documented 1,000-step ceiling including fixed overhead. Incremental scans reduce media windows. Discovery/planning arrays and the final embedding ID list still grow with the library.
- Before deploying `scan-photos-v5` and `generate-embeddings-v3`, drain old **scan and embedding** runs, rebuild the native addon, and apply `0006_incremental_scan.sql` (after prior migrations). New function IDs alone do not fence old code.
- Receipts remain until final IDs/dispatch are checkpointed; success and terminal failure clean them up. Cancellation failure cannot leave an exhausted job running. Retired and abandoned artifact generations are retained: there is no artifact GC, deletion reconciliation, content hashing, outbox/reconciler, distributed lease, or native process-crash isolation.

Web and Expo refresh library queries as committed processing counts advance: first advance immediately, then coalesced trailing refreshes at most once per second. They also refresh on `scan-complete`/first embedding progress and terminal progress; embedding remains nonterminal, and terminal progress refreshes search. Web polls durable `scanStatus` every 1,500 ms while active; Expo retains its fallback/recovery polling. Native iOS uses `/api/v1` durable scan polling. Progress payloads retain their existing shape; the scan event adds optional `force`.

Embedding function details:

- Function ID is `generate-embeddings-v3`, with concurrency limit 1.
- Freezes photo IDs and committed thumbnail keys/roots before inference, then reads `large` WebPs in batches of 16. It uses each photo's committed `thumbnailRoot`, not a stale event root; only untracked legacy rows fall back to event `thumbnailsDir` and photo path.
- Upserts `photo_embedding` with `EMBEDDING_MODEL_VERSION` and the inferred thumbnail key, together with photo statuses, in one synchronous transaction per batch after inference. Both successful and failed saves compare the target key against the current photo generation; stale saves leave it untouched. Current-generation inference failure retains any old vector and marks the photo failed. A database failure rolls back the batch; inference and saving share one checkpointed step, so retry repeats inference.
- Converts the Rust number array to a `Float32Array` buffer before storage.
- Marks current-generation photos `completed` or `failed` and publishes progress. Search excludes noncompleted, wrong-model, and wrong-generation vectors.
- Marks the scan job failed if no requested embedding can be generated; partial success still completes the job.
- After its final progress publication it appends one `trigger-photo-tags-v1` `step.sendEvent` for `photos/tags.requested`; existing step IDs are unchanged for replay safety. `scan-photos-v5` likewise appends the same send only when a scan finishes without dispatching embeddings (for example after a vocabulary bump), after its existing cleanup step.

## Automatic Tags

Every indexed photo receives up to three zero-shot CLIP tags computed from its existing stored vector; no extra image inference runs.

- Scoring (`scoreTags`): cosine similarity to each L2-normalized label vector (FastEmbed vectors are unit length, so a dot product), probabilities `softmax(100 * s)`, keep labels with `p >= TAG_MIN_PROBABILITY`, highest first with ties by slug, at most three, scores rounded to 4 decimal places. A vector of another dimension or zero length yields no tags.
- Label vectors are computed lazily once per process by `loadTagLabelMatrix()` (never at import, never inside a SQLite transaction) and only on tagging paths: `generate-embeddings-v3` before its save transaction and `tag-photos-v1`. List, search, filter-option, and tag-read endpoints never need them. A failed load is not memoized.
- `saveEmbeddingBatch` replaces a photo's `photo_tags` and sets `photo_embedding.tags_version = TAG_VOCABULARY_VERSION` in the same transaction as each current-generation vector save. Stale and failed results leave tags untouched; re-embedding replaces old tags.
- `tag-photos-v1` (concurrency 1) selects vectors that are completed, current-model, keyed to the photo's committed thumbnail key, and whose `tags_version` is null or another version. Each `tag-photos-batch-v1-N` step reads at most 1,000 BLOBs past a photo-ID keyset cursor, scores them in JS, and writes them in one transaction that re-checks every row's generation/status/version, so a vector replaced between read and write is skipped. Repeated events are no-ops once every row is current.
- Bump `TAG_VOCABULARY_VERSION` whenever labels, prompts, or `TAG_MIN_PROBABILITY` change; the next `photos/tags.requested` retags every vector.

### Calibration (`TAG_MIN_PROBABILITY = 0.15`)

Measured on Apple M4 Pro/macOS 26.5.1 with the darwin-arm64 addon and `FASTEMBED_CACHE_DIR=apps/api/.fastembed_cache`: text model load plus first embedding 221 ms; warm `clipTextEmbedding` 4.15 ms per label, 332 ms for all 80 labels (well under 3 s; still lazy). `batchGenerateClipEmbeddings` over 16 Wikimedia Commons photos plus one rendered screenshot took 571 ms including vision model load. Top probabilities:

|Image|Top 3 (p)|Tags at 0.15|
|---|---|---|
|beach|beach .917, landscape .035, sky .017|beach|
|dog|dog .515, pet .458, rain .008|dog, pet|
|kitten|cat .794, pet .136, baby .024|cat|
|food plate|food .406, drink .081, fish .052|food|
|city at night|city-night .845, city .099, park .021|city-night|
|mountain snow|mountain .586, landscape .195, river .059|mountain, landscape|
|forest trail|hiking .678, forest .277, snow .016|hiking, forest|
|document page|document .987, receipt .007|document|
|receipt|document .775, receipt .214|document, receipt|
|rendered screenshot|screenshot .972, document .018|screenshot|
|sunset|sunset .852, city .070, landscape .015|sunset|
|street cyclists|cycling .608, street .157, bicycle .073|cycling, street|
|flower close-up|macro .355, flowers .190, insect .166|macro, flowers, insect|
|B/W vintage car fender|car .585, motorcycle .259, black-and-white .085|car, motorcycle|
|cat nursing kitten|baby .357, pet .209, dog .112|baby, pet|
|watercolor seascape|ocean .249, art .244, beach .182|ocean, art, beach|

At 0.10 clearly wrong labels appear (dog .112 on the cats); at 0.20 correct secondary subjects are lost (street .157, flowers .190, insect .166). Wrong tags at 0.15 (motorcycle, baby) are top-2 confusions that no threshold removes without dropping correct primary tags. Diffuse vectors with more than six comparable labels tag nothing.

## Configuration

Active API variables are parsed in `src/config.ts`:

- `HOST=0.0.0.0`
- `PORT=3000`
- `DATABASE_URL=./photobrain.db`
- `PHOTO_DIRECTORY=../../temp-photos`
- `THUMBNAILS_DIRECTORY=./thumbnails`
- `NODE_ENV=development`
- `RUN_DB_INIT=false`
- `V1_NATIVE_SCAN_MUTATIONS_ENABLED=false` (`true` or `1` enables `POST /api/v1/scans`; reads remain available)
- `INNGEST_SERVE_ORIGIN` (optional validated URL, passed to the Hono handler as `serveHost`)
- `INNGEST_REALTIME_BASE_URL` (optional validated URL, returned to clients)

`DATABASE_URL`, `PHOTO_DIRECTORY`, and `THUMBNAILS_DIRECTORY` are relative to the process working directory. The normal `bun run dev:api` script runs from `apps/api`.

`FASTEMBED_CACHE_DIR` and `PHOTO_PROCESSING_THREADS` are read by Rust, not parsed here. The media pool defaults to `available_parallelism()`; the override must be a positive integer and is read once when the pool initializes. Larger pools increase decoded-image memory; lower the override when needed. `DARKTABLE_CLI_PATH` and `RAW_CONVERSION_TIMEOUT` are legacy parsed values and do not control the current pipeline.

The Inngest SDK reads `INNGEST_DEV`, `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY` directly. PhotoBrain parses `INNGEST_SERVE_ORIGIN` and passes it to the Hono handler as `serveHost`; set it to an API origin reachable from the runtime so internal registration requests cannot publish a `localhost` callback. For self-hosting, use production mode (`INNGEST_DEV=0`), matching server-only keys on the runtime/API, and an internal base URL. Set `INNGEST_REALTIME_BASE_URL` separately to the client-reachable HTTP(S) origin exposing `/v1/realtime/connect`. Never return either server key to clients. Register `/api/inngest` with the runtime and enable periodic app sync. SDK v3.54.2 is compatible with the self-hosted v1.45.1 server, which rejects vulnerable SDK releases below v3.54.0. The Hono handler must continue to allow only GET/PUT/POST.

## Database Rules

- Use `@photobrain/db/schema` for schema changes.
- Migrations live at `packages/db/drizzle`.
- `scan_jobs` is the durable source for web/Expo tRPC polling and native `/api/v1` recovery; preserve terminal-state monotonicity when changing job code.
- Startup migration is opt-in with `RUN_DB_INIT=true` for direct API runs. The API Docker image enables it so deployed schema changes are applied before serving traffic.
- The standalone `src/db/migrate.ts` is not the normal migration path and currently points at an API-local `./drizzle` directory that does not exist.
- Do not assume scan removes rows for files deleted from disk.
- Streaming scan transactions include photo/EXIF/pHash/status saves, item receipts, manifest counters, and scan progress. Embedding transactions include vectors and embedding statuses. Native work/network publication remain outside transactions; never put async callbacks inside Bun SQLite transactions. `clearScanWork` explicitly deletes items and manifests in one transaction because foreign-key enforcement is not guaranteed on every connection.

## REST File Rules

- Standard files are served from `join(photo.sourceRoot ?? PHOTO_DIRECTORY, photo.path)`.
- Converted RAW files serve the committed generation's `large` WebP because browsers cannot display the original RAW.
- Thumbnail paths use `photo.thumbnailRoot ?? THUMBNAILS_DIRECTORY` and `photo.thumbnailKey ?? photo.path`. New media uses UUID generation paths; adopted legacy media retains its old path-shaped key, and unadopted rows retain the configured-root/path fallback.
- Valid thumbnail sizes are `tiny`, `small`, `medium`, and `large`.
- Missing thumbnails redirect to the file route.
- Thumbnail responses use one-year immutable caching and ETags containing generation key, file mtime, and size. Clients use the monotonic `thumbnailUpdatedAt` token for URL cache busting. Original/RAW file responses retain their one-hour cache policy.
- Validate numeric IDs and thumbnail sizes before filesystem work.
- Preserve path normalization and do not expose arbitrary filesystem paths.

The two POST maintenance routes are operational leftovers. HEIC reprocessing force-plans existing HEIC/HEIF rows from the configured source root and uses the same generation-aware ledger, commit fence, and embedding dispatch; it does not overwrite committed artifacts in place. Timestamp backfill only fills null timestamps on completed-thumbnail rows; it does not establish source/artifact provenance or adopt legacy rows. Do not add new callers to these routes; remove them after confirming their one-off migration work is complete.

## Tests

`src/__tests__/filters.test.ts` uses `createTestDb()` from `src/__tests__/setup.ts`, an in-memory SQLite database with shared migrations and seeded EXIF data. It covers folder-scoped filter options, raw/camera/lens/ISO/date filters, durable scan creation/status, dispatch failures, and missing job IDs.

`src/__tests__/v1.test.ts` differentially checks `/api/v1` against tRPC/shared services, validates ISO DTOs and stable errors, proves the native scan mutation defaults off, verifies active-scan recovery ordering, and asserts that private source/artifact identities are absent from list/detail/search responses. OpenAPI parity tests keep the checked-in route contract synchronized.

`src/__tests__/similar.test.ts` runs in an isolated child with real sqlite-vec vectors: nearest-first ordering, source exclusion, ID tie-breaking, limits, stale source/candidate exclusion, unknown IDs across service/tRPC/v1, v1 validation and privacy, and an 8,000 x 512-dimension KNN latency bound (< 250 ms) cross-checked against a brute-force ranking.

`src/__tests__/search-filters.test.ts` uses the same isolated sqlite-vec child harness for filtered text search: each filter and AND-combinations narrow results in distance order, folder is direct-children only with LIMIT applied after filtering, `_`/`%` folder names match literally, search selects exactly the `listPhotos` set per filter, v1 `YYYY-MM` months match Rust `YYYY:MM` data, tRPC/v1 reject invalid `filterRaw`/`iso`, and an 8,000 x 512-dimension folder+camera search stays under 250 ms against a brute-force reference.

`src/__tests__/curation.test.ts` covers `updatePhotoCuration`: one captured `UPDATE` statement touches only listed IDs and returns only existing ones, partial patches, `null` flag clearing, and bounds (0/5 accepted; -1, 6, 1.5, empty patches, bad flags, 0 and 501 IDs rejected without writes) at the service, tRPC, and `PATCH /api/v1/photos/:id` layers (200 public DTO, 404, 400 for unknown keys). It also covers `minRating`/`flag` on tRPC and v1 photos, applies migration `0007` to a database that already holds rows (rating 0, flag NULL, sidecars intact, CHECK enforced), checks that `minRating`/`flag` use their indexes via `EXPLAIN QUERY PLAN`, and requires a 500-ID update and a `minRating` listing over 8,000 photos to finish under 50 ms. Search and similarity curation filters are tested in the sqlite-vec harnesses, and rescan preservation of rating/flag in `import-persistence.test.ts`.

`src/__tests__/collections.test.ts` covers the collections service, tRPC, and `/api/v1` layers: name trimming/bounds and case-insensitive uniqueness (409/`CONFLICT`), own-name case renames, add/remove counts with duplicate and unknown IDs, cover selection and fallback after removal, single-statement `listCollections` with NOCASE ordering, delete cascades that leave photos/EXIF intact, photo deletion cascading out of collections, the `collectionId` photo filter, every v1 route's status codes (201/204/400/404/409), and migration `0008` applied to a `0007` database with rows. Perf tests over 8,000 photos bound `listCollections` (200 collections, 40,000 memberships) and a 500-ID add to 50 ms and assert the `collectionId` listing plan uses the membership primary key. `similar.test.ts` and `search-filters.test.ts` cover `collectionId` against real sqlite-vec KNN.

`src/__tests__/tags.test.ts` runs in an isolated child process with injected label vectors (mocked `clipTextEmbedding`, real sqlite-vec). It covers the vocabulary minimum, `scoreTags` label selection, max three, the inclusive threshold, deterministic tie order, and degenerate vectors; atomic tag/`tags_version` writes in `saveEmbeddingBatch`, untouched tags for stale/failed results, and replacement on re-embedding; backfill eligibility (wrong model, mismatched key, current version), idempotency, more than 1,000 rows across steps, and stale generations between read and write; the `tag` filter on photos/search/similar, folder-scoped `filterOptions` tags, `photoTags`/v1 404s and invalid slugs; migration `0009` over a database at `0008`; and perf over 8,000 photos (scoring 8,000 x 80 x 512 in about 0.4 s, tag-filtered `listPhotos` using `idx_photo_tags_tag_photo_id` per `EXPLAIN QUERY PLAN`, full backfill about 0.4 s).

`src/__tests__/scan.test.ts` exercises real SQLite manifests/receipts with controlled native/Inngest dependencies: new-first dispatch with free completion order, early visibility, partial ACK restart, lost checkpoints, atomic rollback, publication failure, final dispatch/fast-child ordering, empty and terminal jobs, cleanup, and the 7,961-input checkpoint budget. These are not actual Inngest delivery or native integration tests.

`src/__tests__/scan-planner.test.ts` uses temporary source/artifact files and SQLite with controlled native validation to cover unchanged reuse, embedding-only recovery, conservative legacy adoption, stat changes, artifact repair, root changes, and stale source/attempt/generation rejection. Rust tests exercise actual WebP decoding and output-key behavior.

`src/__tests__/import-persistence.test.ts` covers stable IDs, generation invalidation, monotonic cache tokens, stale embedding saves, retry behavior, missing sidecars/vectors, and transaction rollback using SQLite failure triggers. It does not execute native image processing or Inngest delivery.

`bun run bench:import` compares legacy per-photo writes with the shared transactional batch helper using 200 synthetic results, three repeats, and isolated file-backed databases. It checks persisted-data equivalence and reports fresh-import, rescan, and embedding-write medians with SQLite pragmas. It does not exercise streaming receipts, native work, or end-to-end import latency; use the real-photo/runtime measurements for those boundaries.

`src/__tests__/native-executor.test.ts` uses real worker threads with a controlled TypeScript fixture. It covers persistent completion windows, persistence ACK backpressure, per-checkpoint async context, session switching, early stream termination/invalid indices, restart, bounded admission, and shutdown. The release addon and actual local Inngest/API/web flow were also exercised on Apple M4 Pro/macOS 26.5.1, including interrupted-import receipt recovery and real HEIC maintenance; see [measurement boundaries and results](../../docs/import-performance.md). Revalidate the deployed Bun/native environment during rollout.

`bun run bench:exif <1-20 distinct photo paths>` requires ExifTool but not the addon, reads the Rust metadata flags, and compares batched versus four-concurrent per-file metadata extraction with exact JSON equivalence checks. `EXIFTOOL_BIN` selects an executable for this benchmark only. See [import architecture and measurements](../../docs/import-performance.md) for historical measurements, locally verified incremental behavior, and remaining architectural options.
