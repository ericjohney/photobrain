# Mobile Agent Guide

Scope: `apps/mobile`.

## Active Entrypoint

`package.json` sets `main` to `expo-router/entry`. The active route tree is:

- `app/_layout.tsx`: tRPC/React Query providers, theme provider, and tab navigator.
- `app/index.tsx`: Photos tab.
- `app/search.tsx`: Search tab.
- `app/collections.tsx`: Albums placeholder.
- `app/preferences.tsx`: Library/preferences tab.
- `app/about.tsx`: hidden route (`href: null`).

`App.tsx` is a legacy React Navigation application. It is imported by legacy navigation tests and contains the manual `useOTAUpdates()` call, but it is not the configured Expo Router production entrypoint. Do not add active app behavior only to `App.tsx`.

## Source Map

- `src/screens/DashboardScreen.tsx`: date-grouped photo grid, filters, scan, progress, and loupe modal.
- `src/screens/SearchScreen.tsx`: natural-language CLIP search and loupe results.
- `src/screens/PreferencesScreen.tsx`: theme selector and current display/behavior settings.
- `src/screens/CollectionsScreen.tsx`: placeholder.
- `src/screens/AboutScreen.tsx`: app/about content.
- `src/components/LoupeView.tsx`: zoom, pan, swipe, haptics, and loupe actions.
- `src/components/MetadataPanel.tsx`: EXIF/RAW metadata modal.
- `src/components/FilterSheet.tsx`: camera/lens/ISO/month filters.
- `src/components/ActivityBar.tsx`: Inngest progress display.
- `src/hooks/use-library-state.ts`: AsyncStorage-backed view mode and in-memory active-photo navigation.
- `src/hooks/use-job-progress.ts`: Inngest Realtime subscription.
- `src/theme/ThemeContext.tsx`: persisted light/dark/system theme.
- `src/config.ts`: API URL and thumbnail URL construction.
- `src/lib/trpc-client.ts`: HTTP tRPC batch client.
- `__tests__/`: Jest Expo tests and mocks.

The shared `src/components/PhotoGrid.tsx`, `SearchBar.tsx`, and `Filmstrip.tsx` exist, but the active dashboard/search screens render their own specialized layouts. Check imports before changing a shared component.

## Commands

```bash
cd apps/mobile && bun run start
cd apps/mobile && bun run ios
cd apps/mobile && bun run android
cd apps/mobile && bun run web
cd apps/mobile && bun run build:web
cd apps/mobile && bun run test
```

The current `typecheck` script only prints a message and does not run `tsc`. Do not report it as a real typecheck. `tsconfig.json` includes `App.tsx` and `src/**` but does not include the active `app/**` route files.

## Data and UI Flow

The active layout creates one tRPC/React Query client and a `ThemeProvider`. Dashboard queries `photos` and `filterOptions`, sends `scan`, and subscribes to Inngest progress with `realtimeToken`. Search queries `searchPhotos({ query, limit: 50 })` whenever trimmed text is non-empty.

Dashboard behavior:

- Photos are sorted newest-first using EXIF date, modified date, or created date.
- Photos are grouped by month and date.
- The grid uses four columns, not three.
- Pull-to-refresh refetches the photos query.
- The filter sheet supports camera, lens, ISO, and month. It does not expose the API's raw/standard filter.
- Tapping a photo opens a full-screen modal loupe. The loupe uses the `large` thumbnail, not the original file route.
- Scan status is shown in `ActivityBar` and query data is refreshed as configured by the screen.

Loupe share/like/delete/star/overflow controls are visual or haptic placeholders unless their implementation is explicitly changed. Collections is still a placeholder. Preferences persists theme selection; grid-column and haptic controls are currently disabled/hardcoded.

## Runtime Configuration

`src/config.ts` resolves the API URL in this order:

1. `Constants.expoConfig.extra.apiUrl` if present.
2. `EXPO_PUBLIC_API_URL`.
3. `http://localhost:3000`.

EAS build profiles in `eas.json` currently set `EXPO_PUBLIC_API_URL=https://photobrain-api.ericj5.com` and channels `development`, `preview`, or `production`.

Metro watches the monorepo and redirects `@photobrain/image-processing` to `packages/image-processing/browser.js`. Native Rust processing must not be imported into the mobile bundle.

## OTA and Deployment

`app.json` configures `expo-updates` with `ON_LOAD` checks and an `appVersion` runtime policy. The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout. Automatic Expo update configuration remains active; do not promise a native alert/restart flow without wiring the hook into the active layout.

The CI workflow publishes OTA updates with EAS on pushes to `main` and version tags after web/mobile tests. It does not run an Expo web export. The Docker `mobile` target copies source and starts Expo on port 8081; it is not a static exported web image.

## Tests

Jest uses the `jest-expo` preset, `__tests__/setup.ts`, and mocks for Expo, native modules, tRPC, AsyncStorage, zoom, haptics, and Realtime. Current suites cover dashboard behavior, search, filters, loupe, library state, and legacy navigation.

CI runs:

```bash
cd apps/mobile && npx jest --forceExit
```

Tests do not cover the active Expo Router layout, Preferences, Collections, About, OTA behavior, or real API calls. Update mocks when changing request shapes or thumbnail URL behavior.
