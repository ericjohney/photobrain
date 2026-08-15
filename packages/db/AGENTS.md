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

`photo_exif` is one-to-one with `photos` and cascades on photo deletion. It stores camera make/model, lens make/model, focal length, ISO, aperture, shutter speed, exposure bias, date string, and GPS values. GPS values are text for precision. Indexes support camera, lens, ISO, and date filtering.

`photo_embedding` is one-to-one with `photos`, stores a BLOB and model version, and cascades on photo deletion. The schema does not enforce vector dimensions.

`photo_phash` is one-to-one with `photos`, stores an unconstrained hash string and algorithm name, and cascades on photo deletion.

Status strings, hash format, embedding dimensions, and RAW status values are conventions rather than database check constraints.

## Migrations

Current migrations:

1. `0000_thankful_miek.sql`: creates the four tables and base indexes/foreign keys.
2. `0001_busy_mockingbird.sql`: adds EXIF filter indexes.
3. `0002_minor_giant_girl.sql`: adds `photos.thumbnail_updated_at`.

Use the package scripts:

```bash
cd packages/db && bun run db:generate
cd packages/db && bun run db:migrate
cd packages/db && bun run db:studio
```

The API runs migrations only when `RUN_DB_INIT=true` or `1`, using `../../packages/db/drizzle` relative to the API process. The normal API startup defaults to no migration. There is no committed application SQLite database.

## Runtime Vector Search

No vector virtual table is defined in migrations. `apps/api/src/db/setup.ts` loads the `sqlite-vec` extension at runtime, and `apps/api/src/services/vector-search.ts` calls `vec_distance_L2` against BLOB values in `photo_embedding`.

Any change to embedding serialization must be coordinated across `apps/api/src/inngest/functions/embeddings.ts`, vector search, and existing stored rows. The current model label is `clip-vit-b32`.

## Data Lifecycle Caveats

- Scan upserts by unique relative path but does not remove rows for files missing from disk.
- Scan resets embeddings to pending for successfully processed rows, including unchanged files.
- Photo, EXIF, pHash, and status writes are not one transaction.
- A later result with no EXIF or pHash does not delete an existing sidecar row.
- `thumbnailUpdatedAt` is updated on each successful scan and is used by clients for URL cache busting.
- Foreign-key cascade behavior is defined in Drizzle relations/schema and should be preserved in migrations.

## Tests

API tests use `apps/api/src/__tests__/setup.ts` to create an in-memory SQLite database and apply the shared migrations. If a schema change breaks test setup, update the schema/migration and seed data together. There is no standalone package test script.
