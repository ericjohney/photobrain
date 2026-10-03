# Web Agent Guide

Scope: `apps/web`.

## Source Map

- `src/main.tsx`: React, React Query, and tRPC providers.
- `src/App.tsx`: browser routes and initial dark-mode class setup.
- `src/pages/Dashboard.tsx`: primary data/state composition.
- `src/components/panels/PanelLayout.tsx`: fixed three-region layout.
- `src/components/panels/LibraryPanel.tsx`: folders, collections, smart albums, and EXIF filters.
- `src/components/panels/CollectionList.tsx`: library-panel collection rows (select, inline create/rename, delete confirmation).
- `src/components/panels/SmartAlbumList.tsx`: library-panel smart album rows (apply, count or search-icon badge, inline rename, delete confirmation).
- `src/components/SaveSmartAlbumSheet.tsx`: "Save as Smart Album" name dialog.
- `src/components/panels/ActivityPanel.tsx`: scan/embedding progress.
- `src/components/panels/MetadataPanel.tsx`: active-photo metadata.
- `src/components/panels/PhotoCollections.tsx`: active-photo collection chips and "Add to collection" popover.
- `src/components/panels/PhotoTags.tsx`: active-photo auto-tag chips (`photoTags`) that apply the tag filter.
- `src/components/CollectionNameInput.tsx`: shared inline collection-name field (Enter/Escape, inline errors).
- `src/components/PhotoGrid.tsx`: grid thumbnails, active-photo selection, and an optional per-photo badge (`badgeLabel`, used for review reasons).
- `src/components/ReviewHeader.tsx`: junk-review banner (reason segmented control with counts, Reject all/Keep all with a confirmation sheet above 50, resolution error).
- `src/components/DuplicatesHeader.tsx`: duplicates banner (All/Duplicates/Bursts radiogroup with group counts, resolution error, exit).
- `src/components/DuplicateGroupList.tsx`: duplicate/burst group cards (medium thumbnails, keep selection, Keep selected/Not duplicates) and "Load more".
- `src/components/LoupeView.tsx`: single-photo view and navigation.
- `src/components/Filmstrip.tsx`: loupe filmstrip.
- `src/components/Toolbar.tsx`: view, panel, search, refresh, and thumbnail controls.
- `src/hooks/use-library-state.ts`: grid/loupe state, active photo, localStorage persistence.
- `src/hooks/use-panel-state.ts`: panel visibility and persisted dimensions.
- `src/hooks/use-keyboard-shortcuts.ts`: Lightroom-style keyboard behavior.
- `src/hooks/use-collections.ts`: collection list, CRUD/membership mutations, cache invalidation, and the `B` last-used target.
- `src/hooks/use-smart-albums.ts`: smart album list/CRUD, conversion between saved `SmartAlbumFilters` and dashboard folder/filters, and the "still matches" check that keeps an applied album selected.
- `src/hooks/use-junk-review.ts`: `junkReview` badge counts and candidate list, optimistic `resolveJunk` with rollback.
- `src/lib/junk-review.ts`: review reason order/labels, page size, and the Reject-all confirmation threshold.
- `src/hooks/use-duplicate-groups.ts`: `duplicateGroups` badge counts and paged group list, optimistic `resolveDuplicateGroup` with rollback and `CONFLICT` refetch.
- `src/lib/duplicates.ts`: duplicate page size, kind labels, and EXIF capture-time formatting.
- `src/lib/raw-badge.ts`: `rawBadge(photo)`, the RAW / RAW+JPEG pair badge text (`label`, filmstrip `compact`) used by the grid, loupe, filmstrip, duplicate cards, and metadata panel.
- `src/hooks/use-dismiss.ts`: outside-pointer/`Escape` dismissal for lightweight popovers and menus.
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
- `/preferences` -> placeholder `Preferences`
- `/about` -> `About`

`Dashboard` owns search text, the selected folder or collection (mutually exclusive), camera/lens/ISO/month filters, and the active scan job ID. It queries `folders`, `filterOptions`, `photos`, and `searchPhotos` through tRPC. Search is reactive: a non-empty query enables `searchPhotos` (with the selected folder or `collectionId` and camera/lens/ISO/month filters) and disables the `photos` library query; `filterOptions({ folder })` stays active so filters remain selectable during search.

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
- The Type control (All/RAW/Standard; `filterRaw` sent only when not `all`), folders, and camera/lens/ISO/date filters combine as query filters for both the library and search. The library panel stays fully visible during search; changing the folder or a filter re-runs the search with that scope. A results header shows the count, query, and scope (e.g. `12 results for “beach” in photos/2024 · Sony A7III · RAW only`) with a ✕ that clears the search and returns to the library grid with the same folder and filters. RAW photos show their format badge in both grid and loupe.
- **RAW+JPEG pairs**: the API stacks a RAW and its same-folder, same-stem standard partner into one photo (the RAW is omitted whenever its partner matches the same filters) and reports `pairedPhotoId`/`pairedFormat` on every photo DTO. The web never stacks or hides photos itself. `rawBadge` shows `${raw}+${standard}` (e.g. `ARW+JPG`) on paired photos in the grid, loupe, duplicate cards, and the metadata RAW section, and `R+J` (full label as tooltip) in the filmstrip; unpaired RAWs keep `rawFormat || "RAW"`. The metadata panel's RAW section adds a **Pair** row with the partner's filename (fetched with `trpc.photo({ id: pairedPhotoId })`) and format. Curation of a paired photo is applied to both files by the API; the client sends only the shown ID.
- **Find similar** (metadata panel button or `S` with an active photo, ignored while typing) queries `similarPhotos({ photoId, limit: 60 })` and shows a dismissible "Similar to …" grid. ✕, `Escape` in grid view, a non-empty search, folder selection, or starting a scan exits it; `indexed: false` shows a run-a-scan message.
- **Curation** (`src/hooks/use-photo-curation.ts`): with an active photo and focus outside inputs, `0`-`5` set the rating, `P` picks, `X` rejects, and `U` unflags; the metadata panel's Rating stars (clicking the current star clears to 0) and Pick/Reject toggles do the same. `trpc.setPhotoCuration` is applied optimistically to every cached `photos`/`searchPhotos`/`similarPhotos` list and the active photo, rolled back on error, and invalidated on settle. Grid cells show a ★n/flag badge; rejected photos are dimmed in the grid and filmstrip. Filter By's Rating (Any, ★1+…★5) and Flag (Any/Picks/Rejected/Unflagged) controls send `minRating`/`flag` to `photos` and `searchPhotos` and join Filters active, Clear all, and the search header scope.
- **Collections** (`src/hooks/use-collections.ts`): the library panel's Collections section (between Folders and Filter By) lists each collection with its photo count. "+" opens an inline name field (Enter creates, Escape cancels; a case-insensitive duplicate shows the API's `CONFLICT` inline); each row's hover "…" menu offers inline Rename and Delete (confirmation sheet; photos are never touched, and deleting the selected collection returns to All Photos). Selecting a collection sends `collectionId` on `photos`/`searchPhotos`, clears the folder (and vice versa; All Photos clears both), and shows a collection header or `… in <name>` search scope. The metadata panel shows the active photo's collection chips (`collectionsForPhoto`) and an "Add to collection" popover whose checkboxes add/remove immediately, plus "New collection…" which creates the collection containing the photo. `B` (focus outside inputs) toggles the active photo in the last collection added to or created this session; it does nothing before one exists. Membership changes update `collectionsForPhoto` optimistically, then invalidate `collections`, `collectionsForPhoto`, and `photos`/`searchPhotos` queries scoped to that `collectionId`, so a photo removed while viewing the collection leaves the grid. Failures appear inline under the chips.
- **Smart albums** (`src/hooks/use-smart-albums.ts`): the library panel's Smart Albums section (directly under Collections) lists `smartAlbums` by name with a live `photoCount` badge, or a search icon for query albums (`photoCount: null`). Each row's hover "…" menu offers inline Rename (`updateSmartAlbum`; a case-insensitive duplicate shows the API's `CONFLICT` inline) and Delete (confirmation sheet; no photos change, and the current folder/filters/search stay as they are). Whenever any library filter, a folder, or a search query is active, **Save as Smart Album…** appears below the Filters active/Showing indicators. It opens a name dialog that saves the folder and filters (never the collection) as `filters`, plus the trimmed search text as `query`. Clicking an album replaces the folder, filters, and search with its saved ones; clears collection, Find similar, and Review; marks the row `aria-current`; and shows a `smart-album-header` with the name, plus the search header for query albums, which open with `searchPhotos` limit 100. Any later change to folder, filters, search, collection, or mode deselects it for good (the album is a starting point, not a lock), and the header ✕ returns to the unfiltered library. Scan progress, curation, and junk rejections invalidate `smartAlbums` so counts stay live.
- **Auto tags**: Filter By's Tags section (after Flag, before Camera) lists `filterOptions.tags` (folder-scoped, count desc) with counts, top 12 then "Show all (N)"/"Show fewer"; a selected tag outside the visible list stays listed. Selection is single (clicking again clears) and sends `tag` (slug) on `photos` and `searchPhotos`; it joins Filters active, Clear all, and the search header scope (`· #beach`). Slugs display as Title Case with hyphens as spaces (`night-sky` → "Night sky", `formatTagName`). The metadata panel's Tags row shows `photoTags` chips in score order ("No tags yet" when empty); clicking one sets the tag filter, exits similar mode, and returns to the grid. Terminal scan progress also invalidates `photoTags`.
- **Junk review** (`src/hooks/use-junk-review.ts`): the Catalog's **Review** item (below Quick Collection) shows `junkReview` `counts.all`, loaded through a `{ limit: 1 }` request. Selecting it replaces the library with candidates from `junkReview({ reason?, limit: 200 })`, newest first; folder/collection/filters/search are kept but ignored (Filter By is hidden) and are restored when Review is left via the header ✕, a folder, collection, tag chip, search, or Find similar. The header's reason control (All, Screenshots, Documents, Blurry, Too dark) shows library-wide counts; Reject all (N)/Keep all (N) resolve exactly the shown photos, confirming first when N > 50. Grid cells show the first reason; the metadata panel shows "Why it's here" with Reject/Keep. With an active candidate, `X` rejects and `K` keeps through `resolveJunk` (not `setPhotoCuration`) and advance to the next candidate. Resolutions remove photos from every cached review list and decrement counts optimistically, restore both and show an alert on error, then refetch review (plus photo lists after a reject) once no resolution is in flight. Curation and scan completion also invalidate `junkReview`. An empty list shows "Nothing to review".
- **Duplicates** (`src/hooks/use-duplicate-groups.ts`): the Catalog's **Duplicates** item (below Review) shows `counts.duplicate + counts.burst` from a `duplicateGroups({ limit: 1 })` request. Selecting it replaces the library like Review does (Review and Duplicates are one exclusive `catalogView`; folder, collection, smart album, tag chip, search, Find similar, or the header ✕ leave it). The header radiogroup (All / Duplicates (n) / Bursts (n)) sends `kind`. Groups load as an infinite query (`limit: 50`, `cursor` = previous `nextCursor`, "Load more" button) and render as cards of `medium` thumbnails in API order (keeper first) with resolution, file size, RAW badge, rating/pick, and EXIF capture time; the suggested keeper is preselected and badged "Suggested". Clicking a member toggles keep (the last kept member cannot be deselected) and makes it the active photo; double-click opens the loupe, whose navigation and filmstrip walk the shown members. "Keep selected, reject N" sends `resolveDuplicateGroup({ key, action: "keep", keepIds })` and "Not duplicates" sends `{ key, action: "dismiss" }`; both remove the group and decrement its kind count optimistically across cached lists, roll back with an error on failure, and on `CONFLICT` show "This group changed" and let the settle refetch show the current group. Once no resolution is in flight, `duplicateGroups` is refetched; after a keep, photo lists, smart albums, and `junkReview` are too. Curation changes, junk rejections, and terminal scan progress invalidate `duplicateGroups`. Sharpness is not part of the photo DTO, so it is not shown.
- Implemented shortcuts are `G`, `E`, `S`, `B`, `0`-`5`, `P`, `X`, `U`, `K` (Review only), `Tab`, `Shift+Space`, left/right arrows, and `Escape`. In Review, `X`/`K` resolve the active candidate instead of flagging.
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

Playwright specs cover loading, search, filters, incremental scan initiation and refresh, confirmed full reprocessing and cancellation, panels, loupe navigation, metadata, thumbnail sizing, curation, collections, smart albums (`e2e/smart-albums.spec.ts`), tags, junk review (`e2e/review.spec.ts`), duplicates (`e2e/duplicates.spec.ts`), and RAW+JPEG pairs (`e2e/raw-pairs.spec.ts`). Fixtures in `e2e/fixtures/photos.ts` include the forest.jpg (8) + forest.arw (13) pair; `filterFixturePhotos` applies the API's stacking rule, `FIXTURE_LIBRARY` is the stacked unfiltered grid (use it, not `FIXTURE_PHOTOS`, for library counts/IDs), and folder counts stay per file. `e2e/fixtures/handlers.ts` mocks tRPC batch responses (including `photo` by ID, `setPhotoCuration`/`resolveJunk` reject/`resolveDuplicateGroup` keep expanding to pair partners like the API, paired RAWs excluded from junk/duplicate candidates and from their partner's similar results, stateful `junkReview`/`resolveJunk` over `FIXTURE_JUNK_REASONS`, `duplicateGroups`/`resolveDuplicateGroup` over `FIXTURE_DUPLICATE_GROUPS` with dismissals and `CONFLICT` for stale keys, and smart albums evaluated live over the fixture library), image endpoints, and Inngest requests. These are deterministic UI tests, not API/realtime integration tests.

When adding a test:

1. Extend the fixture data in `e2e/fixtures/photos.ts` only when the scenario needs new metadata.
2. Add procedure behavior to `e2e/fixtures/handlers.ts` if the browser makes a new request.
3. Mock binary/image or Realtime routes as needed; do not start the real API for E2E.
4. Run `bun run test:e2e` from this directory.

## Known Gaps

- No web unit-test or real API integration-test script exists.
- Search executes on every input change; debounce behavior is not part of the current web contract.
- The non-dashboard pages (`/preferences`, `/about`) are mostly placeholders and their shared `Layout`/sidebar context should be verified before use. Collections live in the dashboard; there is no `/collections` route.
