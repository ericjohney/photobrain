# Web Agent Guide

Scope: `apps/web`.

## Source Map

- `src/main.tsx`: React, React Query, and tRPC providers.
- `src/App.tsx`: browser routes and initial dark-mode class setup.
- `src/pages/Dashboard.tsx`: primary data/state composition.
- `src/components/panels/PanelLayout.tsx`: fixed three-region layout.
- `src/components/panels/LibraryPanel.tsx`: folders and EXIF filters.
- `src/components/panels/ActivityPanel.tsx`: scan/embedding progress.
- `src/components/panels/MetadataPanel.tsx`: active-photo metadata.
- `src/components/PhotoGrid.tsx`: grid thumbnails and active-photo selection.
- `src/components/LoupeView.tsx`: single-photo view and navigation.
- `src/components/Filmstrip.tsx`: loupe filmstrip.
- `src/components/Toolbar.tsx`: view, panel, search, refresh, and thumbnail controls.
- `src/hooks/use-library-state.ts`: grid/loupe state, active photo, localStorage persistence.
- `src/hooks/use-panel-state.ts`: panel visibility and persisted dimensions.
- `src/hooks/use-keyboard-shortcuts.ts`: Lightroom-style keyboard behavior.
- `src/hooks/use-job-progress.ts`: Inngest Realtime subscription, durable status polling, and incremental query invalidation.
- `src/lib/trpc-client.ts`: HTTP batch link plus HTTP subscription link.
- `src/lib/config.ts`: runtime-injected/API URL resolution.
- `src/lib/thumbnails.ts`: thumbnail and full-image URL helpers.
- `e2e/`: Playwright tests and network fixtures.

## Commands

```bash
cd apps/web && bun run dev
cd apps/web && bun run build
cd apps/web && bun run test:e2e
cd apps/web && bun run test:e2e:ui
```

The Playwright config starts the Vite server on `http://localhost:3001`, runs Chromium, and retries once in CI.

## Routes and Data Flow

Active browser routes:

- `/` -> `Dashboard`
- `/collections` -> placeholder `Collections`
- `/preferences` -> placeholder `Preferences`
- `/about` -> `About`

`Dashboard` owns search text, selected folder, camera/lens/ISO/month filters, and the active scan job ID. It queries `folders`, `filterOptions`, `photos`, and `searchPhotos` through tRPC. Search is reactive: a non-empty query enables `searchPhotos`, while ordinary photo/filter queries are disabled.

The dashboard scan mutation receives an Inngest `jobId`; `useJobProgress` obtains a Realtime token through `realtimeToken` and subscribes to `job:{jobId}`. An advancing `processing.current` invalidates photos, folders, and filter options: the first advance refreshes immediately, and subsequent advances coalesce into a trailing refresh at most once per second. Duplicate or stale progress does not trigger another processing refresh. Entering `scan-complete` or the first `embedding` phase refreshes the library immediately, without waiting for embeddings to finish.

The token query is enabled when a job starts; the subscription waits for its result. For self-hosting, the API's optional `realtimeToken.baseUrl` supplies a client-reachable origin, attached through a keyless SDK client on initial and refreshed tokens. Progress is decoded from the Realtime message's `data` envelope. Server event/signing keys must never be bundled.

The hook also polls durable `scanStatus` every 1500 ms, including while Realtime is connected, so token failures, disconnects, or missed messages do not prevent progress and library refreshes. Polling stops when durable status is terminal or the job is missing; token queries and subscriptions are disabled in those states. Failed token queries retry periodically, and subscription token refresh preserves the self-hosted origin.

Progress is accepted monotonically by phase and count for the active job; delayed processing messages cannot move an embedding or terminal job backward, and durable terminal status takes precedence. `scan-complete` is the handoff to indexing, not a terminal state, and `embedding` remains active. Only `completed` and `failed` are terminal; a missing durable job is surfaced as failed. Terminal progress cancels pending coalesced refreshes and invalidates library, folder, filter, and search queries once per job. Changing jobs or unmounting cancels old refresh timers.

See [import performance](../../docs/import-performance.md) for measured native/persistence timings and the separate real API/Inngest/web smoke; these are not interchangeable with mocked E2E results.

The tRPC client uses `httpBatchLink` for queries/mutations and `unstable_httpSubscriptionLink` for subscriptions. Both use `superjson` and `${API_URL}/api/trpc`.

## Current UI Behavior

- The layout has a left library panel, center content, right metadata panel, toolbar, and optional loupe filmstrip.
- The toolbar's primary scan action is incremental: it processes new/changed photos and repairs incomplete processing. The secondary **Reprocess all photos…** action opens a confirmation sheet explaining that thumbnails and embeddings will be regenerated, originals remain untouched, and the operation takes longer. Only confirming sends `scan({ force: true })`; cancelling sends nothing. Both actions are disabled while the mutation or scan/indexing job is active.
- Panel widths are currently fixed at 256px left, 288px right, and 96px filmstrip height in `PanelLayout`. Persisted width/height state is not applied to those classes.
- Grid click sets one active photo; double-click opens loupe. There is no multi-photo selection state.
- Loupe supports fit, fill, 100% zoom modes, keyboard navigation, and metadata display.
- The filmstrip is rendered when loupe mode is active and its visibility is enabled.
- Folders and camera/lens/ISO/date filters combine as query filters. Search hides the filter options and folder browsing content.
- Implemented shortcuts are `G`, `E`, `Tab`, `Shift+Space`, left/right arrows, and `Escape`.
- Modifier-click range selection and `Ctrl/Cmd+A` are not implemented. Do not document or test them as supported behavior.
- `src/components/Lightbox.tsx` and `src/components/SearchBar.tsx` are legacy/unreferenced by the active dashboard. Check imports before extending them.

## Runtime Configuration

Development uses `VITE_API_URL`, defaulting to `http://localhost:3000`.

Production runs `serve.ts`, which reads:

- `API_URL`, default `http://localhost:3000`
- `HOST`, default `0.0.0.0`
- `PORT`, default `3001`

`serve.ts` serves `dist`, falls back to `index.html` for SPA routes, and injects `window.__CONFIG__` into HTML. `src/lib/config.ts` prefers that runtime value, then `import.meta.env.VITE_API_URL`, then the local default.

## Styling and Components

The UI uses Tailwind CSS, CSS variables in `src/index.css`, Radix/shadcn primitives under `src/components/ui`, and Lucide icons. Preserve the existing Lightroom-inspired dark/light visual language when adding controls.

`src/components/ui/sidebar.tsx` defines a separate sidebar system. `src/components/Layout.tsx` renders `SidebarTrigger`, but `App.tsx` does not provide `SidebarProvider`; verify non-dashboard routes before relying on `Layout`.

## Thumbnail Rules

Always use `src/lib/thumbnails.ts` rather than constructing image URLs manually:

- `getThumbnailUrl(photoId, size, thumbnailUpdatedAt?)`
- `getThumbnailSrcSet(photoId, thumbnailUpdatedAt?)`
- `getFullImageUrl(photoId)`

The API resolves the photo's path and serves mirrored WebP files. The optional `thumbnailUpdatedAt` becomes a `?v=` cache-busting query parameter. RAW full-image URLs are served by the API as the `large` thumbnail.

## Tests

Playwright specs cover loading, search, filters, incremental scan initiation and refresh, confirmed full reprocessing and cancellation, panels, loupe navigation, metadata, and thumbnail sizing. Fixtures in `e2e/fixtures/handlers.ts` mock tRPC batch responses, image endpoints, and Inngest requests. These are deterministic UI tests, not API/realtime integration tests.

When adding a test:

1. Extend the fixture data in `e2e/fixtures/photos.ts` only when the scenario needs new metadata.
2. Add procedure behavior to `e2e/fixtures/handlers.ts` if the browser makes a new request.
3. Mock binary/image or Realtime routes as needed; do not start the real API for E2E.
4. Run `bun run test:e2e` from this directory.

## Known Gaps

- No web unit-test or real API integration-test script exists.
- Search executes on every input change; debounce behavior is not part of the current web contract.
- The non-dashboard pages are mostly placeholders and their shared `Layout`/sidebar context should be verified before use.
