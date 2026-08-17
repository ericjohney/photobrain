# Shared Utilities Agent Guide

Scope: `packages/utils`.

## Exports

- `src/index.ts`: `formatFileSize`, `parseDate`, `formatDate`, and `debounce`.
- `src/thumbnails.ts`: thumbnail size/type configuration and deterministic path helper.
- `src/tasks.ts`: Zod task/progress schemas from an older workflow model.
- `src/queues.ts`: BullMQ queue names and job types from an older architecture.

The package has no build, test, or typecheck script. It is consumed as TypeScript source through the workspace.

## Thumbnail Contract

`THUMBNAIL_CONFIG` defines WebP sizes:

- `tiny`: 150px, nominal quality 80
- `small`: 400px, nominal quality 85
- `medium`: 800px, nominal quality 85
- `large`: 1600px, nominal quality 90

`getThumbnailPath(relativePath, size)` strips the source extension and returns `{size}/{path}.webp`. The Rust generator and API use the same mirrored-path convention. It is not a hash or photo-ID path.

The nominal quality values are shared configuration but the current Rust WebP save path does not apply them. Do not change path generation without coordinating API routes, embeddings, clients, and cache behavior.

## Date and General Helpers

`parseDate` accepts a `Date` or string, converts EXIF `YYYY:MM:DD` prefixes, and falls back to the Unix epoch for missing or invalid input so malformed metadata does not sort as newest.

`debounce` has no cancel or flush API.

## Legacy Queue Types

`queues.ts` documents and exports `scan`, `phash`, and `embedding` BullMQ names, but there is no `apps/worker` and no current consumer. `tasks.ts` similarly defines an older item-level workflow event shape. Current progress uses Inngest Realtime data `{ phase, current, total }`.

Do not use these legacy exports for new API/job work unless the architecture is intentionally migrated and the root/scoped guides are updated at the same time.
