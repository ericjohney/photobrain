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

User curation fields are public and written only by the curation service (`apps/api/src/services/photo-curation.ts`):

- `rating`: integer 0-5, default 0, enforced by the `photos_rating_range` CHECK constraint and indexed by `idx_photos_rating`.
- `flag`: `'pick'`, `'reject'`, or NULL, enforced by the `photos_flag_values` CHECK constraint and indexed by `idx_photos_flag`.

Scan and embedding saves never write these columns, so a rescan or generation upsert of an existing path preserves them.

`junkDismissed` (`junk_dismissed`, integer boolean, NOT NULL default 0) is internal review state written only by the API's junk-review `keep` action (`apps/api/src/services/junk-review.ts`); scans never write it and the public photo projection omits it. `idx_photos_junk_review` on `(junk_dismissed, flag, rating)` serves the junk-review candidate filter.

`idx_photos_pair_stem` is an expression index on the RAW+JPEG pair stem: `lower(substr(path, 1, length(rtrim(path, replace(path, '.', ''))) - 1))`, the lower-cased relative path without its final extension (`2024/DSC_0001.ARW` → `2024/dsc_0001`; the folder is part of the path, so only same-folder files share a stem). There is no stored column; pairing is evaluated at query time by the API (`pairedPhotoIdSql` in `apps/api/src/services/photo-catalog.ts`). Build the expression only with the exported `pairStem(column)` helper from `src/schema.ts` (on any alias of `photos.path`) so SQLite matches the index; a hand-written variant silently falls back to a scan.

`photo_exif` has two expression indexes over the EXIF `date_taken` wall-clock text (normally `YYYY:MM:DD HH:MM:SS`, possibly `YYYY-MM-DD...`): `idx_exif_captured_date` on `replace(substr(date_taken, 1, 10), ':', '-')` (the capture date, `YYYY-MM-DD`) serves the API's exact `capturedDate` filter, and `idx_exif_month_day` on `replace(substr(date_taken, 6, 5), ':', '-')` (`MM-DD`) serves "On this day". Neither validates; the API applies the validity rule (`YYYY-MM-DD` digits, year >= 1900). Build the expressions only with the exported `capturedDateSql(column)` / `capturedMonthDaySql(column)` helpers (on any alias of `photo_exif.date_taken`) so SQLite matches the indexes.

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

`collections` stores user-created manual albums: `name` (trimmed, 1-100 characters, enforced by the API service), `created_at`, and `updated_at`. The unique index `collections_name_nocase_unique` on `name COLLATE NOCASE` makes names case-insensitively unique; the API maps its violation to `NAME_TAKEN`. `collection_photos` is the membership join table with `added_at`, primary key `(collection_id, photo_id)`, and `idx_collection_photos_photo_id`. Both foreign keys cascade on delete: deleting a collection removes only its memberships, and deleting a photo removes it from every collection. The API service (`apps/api/src/services/collections.ts`) also deletes memberships explicitly and joins memberships to `photos`, so connections without foreign-key enforcement neither keep nor count orphans. A collection's cover is derived at read time (most recently added existing member), not stored.

`photo_tags` stores up to three zero-shot CLIP tags per photo: `photo_id`, `tag` (lowercase hyphenated slug), and `score` (softmax probability, 4 dp), with primary key `(photo_id, tag)` and `idx_photo_tags_tag_photo_id` on `(tag, photo_id)` for tag filters and counts. The photo foreign key cascades on delete. `photo_embedding.tags_version` (nullable integer) records the API's `TAG_VOCABULARY_VERSION` used to tag that vector; null means untagged. Only the API tagging paths write either.

`photo_quality` stores one image-quality measurement per photo: `photo_id` (primary key, foreign key to `photos.id`, cascading on delete), `sharpness` and `brightness` (real, NOT NULL), `thumbnail_key` (the committed thumbnail generation it was measured from, NOT NULL), and `quality_version` (the API's `QUALITY_VERSION`, NOT NULL). Only the API's `analyze-quality-v1` backfill writes it; a row whose key or version no longer matches is ignored by junk review and re-measured.

`photo_places` stores one offline place per geotagged photo: `photo_id` (primary key, foreign key to `photos.id`, cascading on delete), `geoname_id` (GeoNames city ID, NOT NULL), `city` (NOT NULL), nullable `region` (admin1 name), `country_code` (ISO2, NOT NULL), `country` (NOT NULL), `latitude_text`/`longitude_text` (the exact `photo_exif.gps_latitude`/`gps_longitude` texts it was computed from, NOT NULL), and `places_version` (the API's `PLACE_DATASET_VERSION`, NOT NULL). `idx_photo_places_country_photo_id` on `(country_code, photo_id)` and `idx_photo_places_geoname_photo_id` on `(geoname_id, photo_id)` serve the `country`/`place` filters and option counts. A row is current only while its version matches and both texts still equal the photo's EXIF texts; the API ignores other rows (`currentPlaceSql`), so changed GPS never shows a stale place. Only the API's `place-photos-v1` backfill writes it.

`smart_albums` stores saved live filter sets: `name` (trimmed, 1-100 characters, enforced by the API service), `filters` (NOT NULL text holding the API's canonical JSON: known filter keys only, no empty values, `dateMonth` as `YYYY-MM`), nullable `query` (the optional CLIP text query), `created_at`, and `updated_at`. The unique index `smart_albums_name_nocase_unique` on `name COLLATE NOCASE` makes names case-insensitively unique among smart albums (independent of `collections`); the API maps its violation to `NAME_TAKEN`. There is no membership table; counts and covers are evaluated live by `apps/api/src/services/smart-albums.ts`, which ignores unknown JSON keys on read.

`duplicate_dismissals` records duplicate/burst groups the user marked "not duplicates": `group_key` (text primary key, the API's `${kind}:${ascending member ids}`) and `dismissed_at` (timestamp, NOT NULL). It has no foreign keys, because a key names a membership rather than a photo. Changed membership produces a new key, so the group reappears; rows for groups that no longer exist are inert and are not cleaned up. Only `apps/api/src/services/duplicates.ts` writes it.

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
8. `0007_photo_curation.sql`: adds `photos.rating` (`integer NOT NULL DEFAULT 0`, CHECK 0-5) and nullable `photos.flag` (CHECK `'pick'`/`'reject'`), plus `idx_photos_rating` and `idx_photos_flag`. Existing rows receive rating 0 and flag NULL. drizzle-kit generated a full `photos` rebuild for the CHECK constraints; it was replaced with in-place `ADD COLUMN` statements because the migrator transaction cannot disable foreign keys, so the rebuild's `DROP TABLE photos` would cascade into the EXIF, embedding, and pHash sidecars. The snapshot still matches the schema (`db:generate` reports no changes).
9. `0008_collections.sql`: pure `CREATE TABLE`/`CREATE INDEX` for `collections` and `collection_photos`; existing tables are not rebuilt, so photos, EXIF, embeddings, and pHashes are untouched. `bun run db:generate` reports no drift afterward.
10. `0009_photo_tags.sql`: pure `CREATE TABLE`/`CREATE INDEX` for `photo_tags` plus `ALTER TABLE photo_embedding ADD tags_version integer`; no table is rebuilt, so existing rows and vectors are untouched and become eligible for the `tag-photos-v1` backfill. `bun run db:generate` reports no drift afterward.
11. `0010_junk_review.sql`: pure `CREATE TABLE photo_quality`, `ALTER TABLE photos ADD junk_dismissed integer DEFAULT false NOT NULL`, and `CREATE INDEX idx_photos_junk_review`; no table is rebuilt, so existing photos, EXIF, tags, collections, and vectors are untouched and every completed thumbnail becomes eligible for the quality backfill. `bun run db:generate` reports no drift afterward.
12. `0011_smart_albums.sql`: pure `CREATE TABLE smart_albums` and `CREATE UNIQUE INDEX smart_albums_name_nocase_unique`; no table is rebuilt or altered. `bun run db:generate` reports no drift afterward.
13. `0012_duplicate_dismissals.sql`: pure `CREATE TABLE duplicate_dismissals`; no table is rebuilt or altered. `bun run db:generate` reports no drift afterward.
14. `0013_pair_stem.sql`: pure `CREATE INDEX idx_photos_pair_stem` on the pair-stem expression; no table is rebuilt or altered, so existing rows are untouched. `bun run db:generate` reports no drift afterward.
15. `0014_photo_places.sql`: pure `CREATE TABLE photo_places` plus its two indexes; no table is rebuilt or altered, so existing photos and EXIF are untouched and every valid location becomes eligible for the `place-photos-v1` backfill. `bun run db:generate` reports no drift afterward.
16. `0015_on_this_day.sql`: pure `CREATE INDEX idx_exif_captured_date` and `CREATE INDEX idx_exif_month_day` on the capture-date and month-day expressions; no table is rebuilt or altered, so existing rows are untouched and indexed immediately. `bun run db:generate` reports no drift afterward.

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
