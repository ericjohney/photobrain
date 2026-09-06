# Mobile Agent Guide

Scope: `apps/mobile`.

## Active Entrypoint

`package.json` sets `main` to `expo-router/entry`. The active route tree is:

- `app/_layout.tsx`: tRPC/React Query providers, theme providers, and the root stack.
- `app/(tabs)/_layout.tsx`: native Library, Collections, and isolated Search tabs using `unstable-native-tabs`.
- `app/(tabs)/index.tsx`: Library tab.
- `app/(tabs)/collections.tsx`: Collections placeholder tab.
- `app/(tabs)/search/_layout.tsx`: native search stack.
- `app/(tabs)/search/index.tsx`: Search tab.
- `app/preferences.tsx`: Settings stack route.
- `app/about.tsx`: About stack route.

`App.tsx` is a legacy React Navigation application and contains the manual `useOTAUpdates()` call, but it is not the configured Expo Router production entrypoint or the target of current navigation tests. Do not add active app behavior only to `App.tsx`.

## Source Map

- `src/screens/DashboardScreen.tsx`: date-grouped photo grid, filters, scan, progress, and loupe modal.
- `src/screens/SearchScreen.tsx`: natural-language CLIP search and loupe results.
- `src/screens/PreferencesScreen.tsx`: theme selector and current display/behavior settings.
- `src/screens/CollectionsScreen.tsx`: placeholder.
- `src/screens/AboutScreen.tsx`: app/about content.
- `src/components/GlassSurface.tsx`: native Liquid Glass with platform and Reduce Transparency fallbacks.
- `src/components/LoupeView.tsx`: core paged swipe viewer, native iOS zoom, haptics, and the implemented metadata action.
- `src/components/MetadataPanel.tsx`: EXIF/RAW metadata modal.
- `src/components/FilterSheet.tsx`: camera/lens/ISO/month filters.
- `src/components/ActivityBar.tsx`: Inngest progress display.
- `src/hooks/use-library-state.ts`: in-memory grid/loupe and active-photo navigation.
- `src/hooks/use-job-progress.ts`: Inngest Realtime subscription with durable `scanStatus` polling fallback.
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
cd apps/mobile && bun run test:ci
cd apps/mobile && bun run typecheck
```

`typecheck` runs `tsc --noEmit`. `tsconfig.json` includes both active `app/**` routes and `src/**`; tests are validated by Jest/Babel rather than this TypeScript project.

## Data and UI Flow

The active layout creates one tRPC/React Query client and a `ThemeProvider`. Dashboard queries `photos` and `filterOptions`, sends `scan`, restores the active job ID from AsyncStorage, and combines `scanStatus` polling with Inngest Realtime. Search debounces trimmed input by 350 ms before calling `searchPhotos({ query, limit: 50 })`; abandoned query observers request cancellation.

Do not use React Navigation focus or navigation hooks inside `SearchScreen`. The unstable native tab host can mount the search route before a React Navigation context exists. Search queries are enabled from the debounced input alone and use `abortOnUnmount` for cancellation.

Dashboard behavior:

- Photos are sorted newest-first using EXIF date, modified date, or created date.
- All Photos is a continuous edge-to-edge grid; year and month grouping remain available from Library Options.
- The responsive grid uses five columns on phones and up to eight on wide layouts.
- Library and Search grids use `small` thumbnails for Retina sharpness; the Library backdrop uses one blurred `medium` thumbnail.
- Pull-to-refresh refetches photos and filter options.
- The filter sheet supports camera, lens, ISO, and month. It does not expose the API's raw/standard filter.
- The photo-backed Library header exposes Library Options and a basic selection mode. Library Options also contains grouping, scan, and Settings actions.
- Selection has a persistent Done control outside the scrolling grid; bulk actions are not implemented. Library Options distinguishes filter loading, failure with retry, and empty metadata.
- Tapping a photo opens a full-screen modal loupe. The loupe uses the `large` thumbnail, not the original file route.
- Successful scan IDs are persisted until durable status reports `completed`, `failed`, or missing. Terminal jobs invalidate library, folder, filter, and search queries.
- Unknown scan progress is labeled as checking status, with an automatic-retry explanation when recovery requests fail instead of claiming processing has started.

The loupe intentionally exposes only implemented controls: close, navigation/zoom gestures, and metadata. Collections is an active native tab but remains a placeholder. Preferences persists theme selection and propagates it through React Native `Appearance`; grid-column and haptic controls remain disabled/hardcoded.

Loupe chrome respects horizontal safe areas in landscape, and image failures offer per-photo retry. Metadata values wrap and are selectable, with stacked labels at larger text sizes. Search empty/loading/error states scroll with automatic native-header insets. Glass fallbacks remain opaque while Reduce Transparency is enabled or its initial value is unknown.

On iOS, tab chrome, header search, and library chrome use native controls. `GlassSurface` renders `expo-glass-effect` only when the iOS APIs are available and Reduce Transparency is disabled; other environments receive an opaque semantic-color fallback. The modal loupe deliberately uses React Native's paged `FlatList`, opaque controls, and native iOS `ScrollView` zoom instead of a third-party Reanimated gallery; keep its thumbnail-tap tests on the real implementation rather than mocking the viewer.

## Runtime Configuration

`src/config.ts` resolves the API URL in this order:

1. `Constants.expoConfig.extra.apiUrl` if present.
2. `EXPO_PUBLIC_API_URL`.
3. `http://localhost:3000`.

EAS build profiles in `eas.json` currently set `EXPO_PUBLIC_API_URL=https://photobrain-api.ericj5.com` and channels `development`, `preview`, or `production`.

Metro watches the monorepo and redirects `@photobrain/image-processing` to `packages/image-processing/browser.js`. Native Rust processing must not be imported into the mobile bundle.

## OTA and Deployment

`app.json` configures `expo-updates` with `ON_LOAD` checks and a fingerprint runtime policy. The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout. Automatic Expo update configuration remains active; do not promise a native alert/restart flow without wiring the hook into the active layout.

The CI workflow publishes preview OTA updates with EAS on pushes to `main` and production iOS updates on version tags after API/web/mobile tests. A version tag first waits for a production iOS EAS build so native dependency changes have a matching binary. It does not run an Expo web export. The Docker `mobile` target copies source and starts Expo on port 8081; it is not a static exported web image.

The manual `EAS Preview iOS Build` GitHub Actions workflow creates an internal-distribution build from the `preview` profile and waits for EAS to return an installable artifact. Use it when a native fingerprint change prevents an existing preview binary from receiving OTA updates.

## Tests

Jest uses the `jest-expo` preset, `__tests__/setup.ts`, and mocks for Expo, native modules, tRPC, AsyncStorage, zoom, haptics, and Realtime. Current suites cover the active native tab routes, dashboard behavior, debounced search, filters, loupe, library state, durable progress, Liquid Glass fallback, and theme propagation.

CI runs:

```bash
cd apps/mobile && bun run test:ci
```

Tests do not perform real API calls, native EAS builds, or end-to-end checks of Preferences, Collections, About, and OTA behavior. Update mocks when changing request shapes, native route primitives, or thumbnail URL behavior.
