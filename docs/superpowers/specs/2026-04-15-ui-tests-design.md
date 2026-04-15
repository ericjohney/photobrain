# UI Tests for PhotoBrain — Design

**Date:** 2026-04-15
**Scope:** Golden-path UI tests for web (`apps/web`) and mobile (`apps/mobile`).

## Goals

- Catch regressions in the core user flows: scan, browse, select, loupe, search, panels.
- Fast, deterministic tests — no Redis, no API server, no real photo files.
- Reuse existing mobile test infrastructure; add a new Playwright suite for web.
- First-pass coverage of ~15–20 tests per platform.

## Non-Goals

- Visual regression snapshot testing.
- Cross-browser coverage (Chromium only).
- Real-backend integration tests for the scan pipeline.
- Native-device Detox tests (React Native Testing Library is sufficient).
- Unit tests for pure logic (separate effort).

## Architecture

### Web — Playwright E2E with mocked network

- Location: `apps/web/e2e/`
- Runner: `@playwright/test`, Chromium-only, headless.
- Dev server: Playwright `webServer` config starts `bun run dev:web` on port 3001.
- All backend traffic is mocked via `page.route()`:
  - tRPC HTTP batch endpoint (`/trpc/*`) → routed by procedure name, returns fixture payloads.
  - REST file streams (`/api/photos/:id/file`, `/api/photos/:id/thumbnail/:size`) → serve fixture WebP bytes.
  - tRPC SSE subscription (`onTaskProgress`) → fulfilled with an `event-stream` body that emits a scripted progress sequence.
- A Playwright base fixture (`e2e/fixtures/test.ts`) auto-installs all mocks on each test's `page`, so specs only need to override handlers when asserting specific behavior.

### Mobile — extend existing jest-expo + RNTL

- Location: `apps/mobile/__tests__/`
- Existing setup: `jest.config.js` (jest-expo preset), `setup.ts`, `globalSetup.js`, `test-utils.tsx`, `fixtures.ts`.
- Existing specs: `DashboardScreen.test.tsx`, `LoupeView.test.tsx`, `SearchScreen.test.tsx`, `useLibraryState.test.ts`.
- Approach: audit existing files for golden-path gaps and add missing cases; do not rewrite.
- No new infrastructure.

## Fixtures

Shared shape across platforms (defined per-platform, same data):

```ts
// 12 photos covering: JPEG landscape, JPEG portrait, RAW (ARW), HEIC,
// one with GPS, one without EXIF, mixed thumbnail statuses.
photos: Photo[]
exif: Record<photoId, PhotoExif>
thumbnailBytes: Uint8Array  // one tiny valid WebP reused for all IDs
fullImageBytes: Uint8Array  // one small JPEG reused for all IDs
searchResults: (query: string) => Photo[]  // simple keyword matcher
taskProgressEvents: TaskProgressEvent[]     // scripted scan → phash → embedding sequence
```

Web fixtures live in `apps/web/e2e/fixtures/`; mobile reuses `apps/mobile/__tests__/fixtures.ts`.

## Web Test Plan (~18 tests)

Organized into spec files under `apps/web/e2e/`:

| File | Tests |
|---|---|
| `load.spec.ts` | App boots, grid renders 12 photos, empty-state when zero photos |
| `selection.spec.ts` | Single click selects, shift+click range, ctrl/cmd+click toggle, Cmd+A select all, Escape clears |
| `loupe.spec.ts` | Double-click opens loupe, `E` key opens, `G`/Escape returns to grid, arrow keys advance, filmstrip click jumps |
| `panels.spec.ts` | Left/right panel toggles, Tab toggles all, Shift+Space filmstrip, localStorage persistence across reload |
| `search.spec.ts` | Query input calls `searchPhotos` with text, results render, empty query clears results |
| `scan.spec.ts` | Scan button triggers mutation, SSE progress events update activity UI, completion state shown |
| `metadata.spec.ts` | Selecting a photo populates EXIF sections; collapsible sections expand/collapse |
| `thumbnail-size.spec.ts` | Slider changes grid density (CSS var or class changes on grid container) |

Selectors prefer existing text/role; `data-testid` added only where DOM is ambiguous (activity bar progress, thumbnail-size slider).

## Mobile Test Plan (~16 tests)

Extend existing files:

| File | Add/verify |
|---|---|
| `DashboardScreen.test.tsx` | Grid renders fixtures, tap → navigates to loupe, pull-to-refresh triggers refetch, ActivityBar shows progress from mocked subscription |
| `LoupeView.test.tsx` | Swipe next/prev advances, metadata bottom sheet opens, back gesture returns to grid |
| `SearchScreen.test.tsx` | Query input triggers search, results render, empty-results state, error state |
| `useLibraryState.test.ts` | Existing coverage — verify no gaps |
| `Navigation.test.tsx` *(new)* | Tab switching between screens, state preserved across tabs |

Pinch zoom is deferred (gesture-handler interactions in jsdom are unreliable; reserve for manual QA).

## Mocking Details

### tRPC HTTP (web)

```ts
await page.route("**/trpc/photos*", (route) => {
  const url = new URL(route.request().url());
  if (url.searchParams.has("input")) { /* query */ }
  return route.fulfill({ json: { result: { data: photos } } });
});
```

A helper `installTrpcHandlers(page, overrides?)` wires every procedure used by the web app. Per-test overrides replace specific handlers.

### tRPC SSE subscription (web)

The trickiest piece. `onTaskProgress` uses Server-Sent Events. Approach:

```ts
await page.route("**/trpc/onTaskProgress*", async (route) => {
  const body = taskProgressEvents
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body,
  });
});
```

Events are sent as a batched body rather than a true stream; this is sufficient because the tRPC SSE client parses chunks as they arrive and the response is fulfilled synchronously from the test's perspective. If this proves insufficient (e.g., tests need to assert intermediate states), the fallback is to use Playwright's `page.exposeFunction` and dispatch events from test code via `window.postMessage`.

### REST file streams (web)

```ts
await page.route("**/api/photos/*/thumbnail/*", (route) =>
  route.fulfill({ contentType: "image/webp", body: thumbnailBytes }),
);
```

### Mobile

Mobile mocks tRPC client at the module level via `jest.mock("@/lib/trpc", ...)`. Existing `test-utils.tsx` already does this — extend fixtures and mocked return values as new tests require.

## Deliverables

### New files
- `apps/web/playwright.config.ts`
- `apps/web/e2e/fixtures/photos.ts`
- `apps/web/e2e/fixtures/handlers.ts`
- `apps/web/e2e/fixtures/test.ts` (base fixture)
- `apps/web/e2e/fixtures/images/tiny.webp`, `fixtures/images/sample.jpg`
- `apps/web/e2e/load.spec.ts`
- `apps/web/e2e/selection.spec.ts`
- `apps/web/e2e/loupe.spec.ts`
- `apps/web/e2e/panels.spec.ts`
- `apps/web/e2e/search.spec.ts`
- `apps/web/e2e/scan.spec.ts`
- `apps/web/e2e/metadata.spec.ts`
- `apps/web/e2e/thumbnail-size.spec.ts`
- `apps/mobile/__tests__/Navigation.test.tsx`

### Modified files
- `apps/web/package.json` — add `@playwright/test` devDep, `test:e2e` script
- `apps/web/.gitignore` — ignore `playwright-report/`, `test-results/`
- Existing mobile test files — extend with missing cases
- Web components — add `data-testid` attributes only where selectors are ambiguous (target: ≤5 additions)

### CI
- CI workflow changes are out of scope for this spec. A follow-up can wire `bun run test:e2e` and mobile `bun run test` into `.github/workflows/`.

## Risks

- **SSE mocking**: the batched-body approach may not behave like a true stream under all tRPC client configurations. Mitigation: the fallback path with `exposeFunction` is documented; swap in if needed.
- **Selector stability**: adding `data-testid` in a few places is expected; avoid spraying them across the codebase. If a test needs more than a handful, revisit the component.
- **Mobile gesture tests**: gesture-handler + Reanimated are partially stubbed under jest-expo. Pinch/complex gestures are deferred.

## Success Criteria

- `bun run test:e2e` (web) passes locally against the Vite dev server with all mocks in place.
- `bun run test` (mobile) passes with the expanded golden-path coverage.
- Each suite finishes in under 60 seconds locally.
- No changes to app behavior; only new test files and minimal `data-testid` additions.
