# PhotoBrain Web

The web application is a React/Vite browser client for the PhotoBrain API. It provides the primary grid/loupe library interface, folders, EXIF filters, CLIP search, metadata, scan progress, and keyboard navigation.

Read [`AGENTS.md`](AGENTS.md) for implementation details and [`../../CLAUDE.md`](../../CLAUDE.md) for repository-wide rules.

## Development

From the repository root:

```bash
bun install
bun run dev:web
```

The Vite server listens on `http://localhost:3001`. From this directory, the equivalent command is `bun run dev`.

## Configuration

Development reads `VITE_API_URL`:

```env
VITE_API_URL=http://localhost:3000
```

The production server is `serve.ts`. It reads `API_URL`, `HOST`, and `PORT`, serves `dist`, provides SPA fallback routing, and injects the API URL into HTML at runtime. The production defaults are `http://localhost:3000`, `0.0.0.0`, and `3001`.

## Application Structure

- `src/main.tsx`: React Query and tRPC providers.
- `src/App.tsx`: routes `/`, `/collections`, `/preferences`, and `/about`.
- `src/pages/Dashboard.tsx`: primary data and state composition.
- `src/components/`: toolbar, grid, loupe, filmstrip, metadata, panels, and UI primitives.
- `src/hooks/`: library, panels, shortcuts, and Inngest Realtime progress state.
- `src/lib/`: tRPC client, runtime configuration, thumbnail URLs, and shared types.
- `e2e/`: Playwright specs and mocked network fixtures.

The dashboard uses tRPC at `/api/trpc` for metadata, folders, filters, search, scan, and Realtime tokens. REST is used for original files and thumbnails.

## Current Behavior

- Grid and loupe views use one active photo; multi-selection is not implemented.
- `G` switches to grid, `E` opens loupe when a photo is active, `Tab` toggles panels, `Shift+Space` toggles the filmstrip, arrows navigate, and `Escape` returns to grid.
- The dashboard uses fixed left/right panel dimensions even though panel dimensions are persisted in localStorage.
- Search runs reactively on each non-empty input change; it is not debounced.
- `Lightbox.tsx` and `SearchBar.tsx` are legacy/unreferenced by the active dashboard. Verify imports before extending them.

## Scripts

```bash
bun run dev
bun run build
bun run test:e2e
bun run test:e2e:ui
```

The Playwright suite runs Chromium against a Vite server at `http://localhost:3001`. Fixtures mock tRPC responses, image routes, and Inngest requests, so the suite does not require a running API or Inngest service.

## Thumbnails

Use `src/lib/thumbnails.ts` for image URLs:

- `getThumbnailUrl(id, size, thumbnailUpdatedAt?)`
- `getThumbnailSrcSet(id, thumbnailUpdatedAt?)`
- `getFullImageUrl(id)`

Thumbnail URLs are `/api/photos/:id/thumbnail/:size` with optional `?v=` cache busting from `thumbnailUpdatedAt`. The API resolves mirrored WebP paths from the photo row.

## Production

Build the Vite app with `bun run build`; output is `dist/`. The Docker `web` target runs the Bun static server on port 3001 and supports runtime API configuration without rebuilding.
