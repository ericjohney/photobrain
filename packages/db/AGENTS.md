# Database Agent Guide

Scope: `packages/db`.

## Source of Truth

- `src/schema.ts`: authoritative Drizzle schema, relations, and inferred types.
- `src/index.ts`: re-exports the schema only; it does not open a database.
- `drizzle.config.ts`: schema/output paths and SQLite URL for Drizzle Kit.
- `drizzle/`: committed SQL migrations, snapshots, and migration journal.

The API's `apps/api/src/db/schema.ts` re-exports this package. Update this package for schema changes; do not create a second API-only schema.

## Tables

`photos` stores the unique normalized relative path, file name, size, filesystem timestamps, dimensions, MIME type, RAW fields, and processing statuses:

- `thumbnailStatus`, `thumbnailUpdatedAt`
- `embeddingStatus`
- `phashStatus`

Six nullable internal identity fields describe committed media:

- `sourceRoot`: canonical `realpath` of the scanned source directory.
- `sourceFingerprint`: source `size:mtimeNs:ctimeNs`; metadata identity, not a content hash.
- `mediaVersion`: the manual `MEDIA_VERSION` invalidation constant.
- `thumbnailKey`: committed artifact key. New attempts use `.versions/<UUID>/photo.image`, resolving to `<thumbnailRoot>/<size>/.versions/<UUID>/photo.webp`; adopted legacy rows retain their relative source path as the key.
- `thumbnailRoot`: resolved absolute thumbnail directory, independent of the source root.
- `thumbnailFingerprint`: resolved thumbnail root plus size/mtimeNs/ctimeNs stat fingerprints for all four thumbnail files.

These fields remain internal: the API's `publicPhotoColumns` projection omits them from photo list, detail, and search DTOs. Original-file routes use the stored source root; thumbnail and converted-RAW routes use the stored thumbnail root/key, with configured-root/path fallbacks for untracked legacy rows.

`photo_exif` is one-to-one with `photos` and cascades on photo deletion. It stores camera make/model, lens make/model, focal length, ISO, aperture, shutter speed, exposure bias, date string, and GPS values. GPS values are text for precision. Indexes support camera, lens, ISO, and date filtering.

`photo_embedding` is one-to-one with `photos`, stores a BLOB, model version, and the `thumbnailKey` used for inference, and cascades on photo deletion. The schema does not enforce vector dimensions; the incremental planner requires a 2,048-byte vector for current CLIP reuse.

`photo_phash` is one-to-one with `photos`, stores an unconstrained hash string and algorithm name, and cascades on photo deletion.

`scan_jobs` stores durable scan phase, status, counts, error text, and timestamps. The API treats `completed` and `failed` as terminal states and both clients use this table as a polling/restart fallback for Realtime.

`scan_manifests` freezes each scan's discovery and classification, including an empty result, with `sourceRoot`, `thumbnailsRoot`, and processed/successful/unchanged/media/embedding counts. `unchanged` includes reusable media needing embedding-only recovery; `media` counts planned media work; `embedding` starts with embedding-only items and increments as new media commits. These are durable execution counters, not a live inventory.

`scan_items` stores stable new-first priority ordinals, absolute/relative paths, action (`media`, `skip`, `embed`, or `failed`), pending/success/failed receipts, photo IDs, and errors. It freezes the source fingerprint and previous committed thumbnail key/source fingerprint, and stores the current attempt's thumbnail key. Reusable `skip`/`embed` items are successful receipts at initialization; source-stat failures are failed receipts; only pending media reaches the native stream. Both reusable and failed items already count as processed.

The compound `(job_id, ordinal)` key makes completion ACKs idempotent; a `(job_id, status, ordinal)` index supports pending-only ordered recovery. Each new native attempt rotates the item's UUID artifact key. A result must match the frozen source, current attempt key, and previous committed photo ID/key/source fingerprint before publishing a new generation. These records are transient durable execution state; committed freshness and generation identity live on `photos` and `photo_embedding` after ledger cleanup.

Status strings, hash format, embedding dimensions, and RAW status values are conventions rather than database check constraints.

## Migrations

Current migrations:

1. `0000_thankful_miek.sql`: creates the four tables and base indexes/foreign keys.
2. `0001_busy_mockingbird.sql`: adds EXIF filter indexes.
3. `0002_minor_giant_girl.sql`: adds `photos.thumbnail_updated_at`.
4. `0003_hot_midnight.sql`: creates `scan_jobs`.
5. `0004_repair-photo-exif-unique.sql`: restores the declared one-to-one unique index on `photo_exif.photo_id` for databases created before the invariant was migrated consistently.
6. `0005_continuous_scan_work.sql`: adds the continuous scan manifests, per-photo receipts, and pending-order index.
7. `0006_incremental_scan.sql`: adds six nullable photo identity fields, nullable embedding thumbnail key, manifest roots and classification counters, and item action/source/attempt/previous-generation fields. Existing item actions default to `media`; new counters default to zero. Existing photo identity fields remain null for conservative legacy adoption rather than receiving fabricated provenance.

Before deploying `scan-photos-v5` and `generate-embeddings-v3`, drain old **scan and embedding** runs, rebuild the native addon, and apply `0006` after preceding migrations. New function IDs do not protect against old code still publishing unfenced writes.

Use the package scripts:

```bash
cd packages/db && bun run db:generate
cd packages/db && bun run db:migrate
cd packages/db && bun run db:studio
```

The API runs migrations only when `RUN_DB_INIT=true` or `1`, using `../../packages/db/drizzle` relative to the API process. The normal API startup defaults to no migration. There is no committed application SQLite database.

Drizzle Kit resolves a relative `DATABASE_URL` from `packages/db`. To migrate the API's default local database explicitly, run `DATABASE_URL=../../apps/api/photobrain.db bun run db:migrate` from this package. The API Docker image instead enables startup migration.

## Runtime Vector Search

No vector virtual table is defined in migrations. `apps/api/src/db/setup.ts` loads the `sqlite-vec` extension at runtime, and `apps/api/src/services/vector-search.ts` calls `vec_distance_L2` against BLOB values in `photo_embedding`.

Any change to embedding serialization must be coordinated across `apps/api/src/inngest/functions/embeddings.ts`, vector search, and existing stored rows. The current model label is `clip-vit-b32`; `EMBEDDING_MODEL_VERSION` and `MEDIA_VERSION` in the API's `processing-versions.ts` are manual invalidation constants. Search requires completed embedding status, the current model, and a vector key matching the photo's committed thumbnail key. It does not impose a database vector-dimension constraint.

## Data Lifecycle Caveats

- `scan()` and `scan({})` are incremental; `scan({ force: true })` reprocesses every discovered file. Upserts use unique relative path, preserving photo IDs and original creation dates. Scans do not remove rows for files missing from disk.
- Tracked media reuse requires completed thumbnails/pHash, a pHash row, dimensions, converted RAW status when applicable, matching source root/fingerprint/media version/thumbnail root, and all four matching nonempty thumbnail stat fingerprints. Missing EXIF is not a reason for endless retries.
- Legacy adoption requires all six photo identity fields to be null, matching source size and stored whole-second mtime, an existing thumbnail timestamp, no NFC-normalized/case-insensitive extension-stripped stem collision, source ctime strictly older than every thumbnail mtime, four decoded WebPs at expected dimensions, and a post-validation source/artifact stat recheck. This is conservative heuristic provenance, not proof of historical content or root. Adoption records identity without changing photo ID, artifact files, or cache timestamp; a valid legacy vector is associated with the adopted key.
- Unchanged media with completed, current-model, matching-generation, 2,048-byte vectors remains untouched. Missing/failed/wrong-model/wrong-generation/truncated vectors recover separately without regenerating valid media. New committed media resets embeddings to pending.
- Each accepted streaming completion atomically saves photo/EXIF/pHash/status/identity data, its receipt, manifest counters, and scan-job progress. The existing save helper composes through a synchronous nested Bun savepoint. Before publishing, source and attempt checks plus a transactional comparison of the previous committed identity reject stale generations. Native work and Realtime publication stay outside transactions.
- Embedding batches freeze committed thumbnail keys/roots before inference and compare keys transactionally before saving either success or failure. A stale result cannot update a newer generation's vector or status. Current-generation failures retain old vectors but mark the photo failed, excluding it from search.
- A later result with no EXIF or pHash does not delete an existing sidecar row; pHash status is failed when the result lacks a hash.
- `thumbnailUpdatedAt` is a whole-second public cache token. Every committed media replacement advances it to at least the previous stored second plus one, even for same-second work or a backwards clock. Reuse and embedding-only recovery preserve it. REST thumbnail ETags also include the generation key, mtime, and size.
- Foreign-key cascade behavior is defined in Drizzle relations/schema and should be preserved in migrations.
- Scan progress updates must not transition a `completed` or `failed` job back to a running phase.
- Keep receipts until final IDs and the embedding event have been checkpointed. Success/terminal cleanup explicitly deletes item rows and their manifest in one transaction, even when SQLite foreign-key enforcement is disabled. Do not depend on an in-memory stream cursor for restart correctness.
- Committed roots prevent configuration changes or a stale embedding event root from silently redirecting artifact reads; untracked legacy rows still use configured/event-root fallbacks. The HEIC maintenance route uses the same force planner and fenced ledger. Timestamp backfill only fills null cache tokens on completed thumbnails; it does not establish provenance.
- Retired and abandoned artifact generations remain on disk; there is no artifact GC, deletion reconciliation, content hashing, distributed lease, native process-crash isolation, or outbox/reconciler. A process crash between queued-job insertion and event dispatch can still leave a queued row.

## Tests

API tests use `apps/api/src/__tests__/setup.ts` to create an in-memory SQLite database and apply the shared migrations. If a schema change breaks test setup, update the schema/migration and seed data together. There is no standalone package test script.
