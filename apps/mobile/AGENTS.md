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
- `src/components/LibraryHeader.tsx`: persistent Library overlay, live masked blur, adaptive title/date, and selection controls.
- `src/components/LibraryTimeScope.tsx`: iOS-style collapsed browsing bar with Collections, Years/Months/All, and Search controls.
- `src/components/Filmstrip.tsx`: virtualized loupe thumbnails synchronized with the active photo.
- `src/components/LoupeView.tsx`: core paged swipe viewer, native iOS zoom, glass date/time controls, filmstrip navigation, and metadata.
- `src/components/MetadataPanel.tsx`: EXIF/RAW metadata modal.
- `src/components/FilterSheet.tsx`: Library Options, sorting, and searchable RAW/standard/camera/lens/ISO/month filters.
- `src/components/ActivityBar.tsx`: durable scan status presented as Discover, Prepare, and Search stages with phase-specific details, counts, and percentage.
- `src/hooks/use-library-state.ts`: in-memory grid/loupe and active-photo navigation.
- `src/hooks/use-job-progress.ts`: Inngest Realtime subscription with durable `scanStatus` polling fallback.
- `src/theme/ThemeContext.tsx`: persisted light/dark/system theme.
- `src/config.ts`: API URL and thumbnail URL construction.
- `src/lib/trpc-client.ts`: HTTP tRPC batch client.
- `__tests__/`: Jest Expo tests and mocks.

The shared `src/components/PhotoGrid.tsx` and `SearchBar.tsx` exist, but the active dashboard/search screens render their own specialized layouts. `Filmstrip.tsx` is used by the active loupe. Check imports before changing a shared component.

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

- Photos default to oldest-to-newest using EXIF date, modified date, or created date, and the grid opens at its newest edge. Recently Added uses ascending photo IDs (insertion order), not filesystem creation dates.
- All Photos is a continuous edge-to-edge grid. At the newest edge, the native Library/Collections/Search tabs remain visible. Scrolling back in time replaces them with one Collections button, Years/Months/All segments, and one Search button. The collapsed bar hides during selection and when there are no photos; its measured height and safe area reserve space for the last row. Date grouping selects captured-date sorting; Recently Added returns to All.
- The responsive grid uses five columns on phones and up to eight on wide layouts.
- Library and Search grids use `small` thumbnails for Retina sharpness. The Library header blurs the actual scrolling grid with `expo-blur` and a fading mask, not a copied photo.
- Pull-to-refresh refetches photos and filter options.
- Library Options separates sorting, a Filter destination, and scan/Settings actions. Filter has RAW/Standard choices and camera/lens/ISO/month summaries that open searchable, virtualized checkmarked lists; browsing scopes live in the bottom control, not this sheet.
- Filters combine across categories with one value per category, apply immediately, and remain in memory. Done dismisses without an apply transaction. All Items/Clear All resets filters, not sorting/grouping; each category's All clears only that category. Active values remain removable even if metadata disappears or fails to load.
- The fixed Library header exposes Library Options and selection. It shows the item count at the newest edge, the visible photo date while browsing back in time, and the selection count in selection mode. Measured header height determines grid and refresh insets; larger text stacks its controls. Filter, grouping, sorting, and layout changes reset scroll/date context.
- Selection exits through the header's persistent close control; bulk actions are not implemented. An active-filter summary opens Filter directly; its close button restores all items. Library Options distinguishes filter loading, failure with retry, and empty metadata.
- Tapping a photo opens a full-screen modal loupe. The loupe uses the `large` thumbnail, not the original file route.
- Successful scan IDs are persisted until durable status reports `completed`, `failed`, or missing. Terminal jobs invalidate library, folder, filter, and search queries.
- Unknown scan progress is labeled as checking status, with an automatic-retry explanation when recovery requests fail instead of claiming processing has started.
- Active progress distinguishes photo discovery, metadata/thumbnail preparation, the handoff to search indexing, and CLIP embedding generation instead of presenting every running state as generic processing.

`useJobProgress` invalidates photos, folders, and filter options as `processing.current` advances. The first advance refreshes immediately; further advances coalesce into a trailing refresh at most once per second. Duplicate counts do not repeatedly refresh, and delayed processing updates after the indexing handoff do not restart processing refreshes. Entering `scan-complete` or the first `embedding` phase immediately refreshes the library, but neither phase is terminal: the job stays active while search indexing runs. Terminal progress cancels any queued refresh and invalidates library, folder, filter, and search queries once per job. Job changes and unmounts cancel stale refresh timers.

The existing durable `scanStatus` fallback continues polling every 1500 ms until durable completion, failure, or a missing job. It remains enabled alongside Realtime, allowing advances missed during disconnects to refresh the library. Progress from the two sources is compared by phase/count, with timestamp/connection-state tie-breaking; durable terminal status wins over stale Realtime data. Tokens are refreshed for reconnection and failed token queries retry periodically without disabling durable polling. A reconnect that reports already-observed processing counts does not cause duplicate processing invalidations.

See [import performance](../../docs/import-performance.md) for measurements and verification scope. Incremental mobile refresh was verified through hook/Jest coverage; no native simulator/device visual verification is claimed for this change.

The loupe intentionally exposes only implemented controls: close, navigation/zoom gestures, thumbnail navigation, and metadata. Thumbnail taps and swipes update the active photo, counter, metadata target, and selected thumbnail together. Tap the photo to hide or restore chrome. Native zoom resets when changing photos or orientation; paging pauses while zoomed. Collections remains a placeholder; Preferences persists theme selection, while grid-column and haptic controls remain disabled/hardcoded.

Design references: [Photos library browsing](https://support.apple.com/guide/iphone/browse-your-photo-library-iph7d24753a5/26/ios/26), [photo viewing](https://support.apple.com/guide/iphone/view-photos-and-videos-iph3d267610/26/ios/26), and [sorting/filtering](https://support.apple.com/guide/iphone/sort-and-filter-the-photo-library-iph2e66e2f2c/26/ios/26). Apple uses Years/Months/All, not Days, in the current iOS 26 Library. PhotoBrain follows its expanded Library/Collections/Search navigation at the newest edge and its collapsed Collections + time scope + Search bar while browsing history. PhotoBrain groups the complete grid rather than creating curated cover collections. Unsupported Favorites, Edited, and video categories are not exposed.

Library and Search loupe modals each create a `SafeAreaProvider`, so full-screen chrome uses device insets rather than the underlying tab bar's inset. Controls respect landscape safe areas; image failures offer per-photo retry. Metadata values wrap and are selectable, with stacked labels at larger text sizes. Search messages scroll with automatic native-header insets. Glass fallbacks remain opaque while Reduce Transparency is enabled or its initial value is unknown.

On iOS, tab chrome, header search, and library chrome use native controls. `GlassSurface` renders `expo-glass-effect` only when available and Reduce Transparency is disabled; unsupported environments receive an opaque fallback. The loupe uses dark glass controls with an opaque dark fallback, React Native's paged `FlatList`, and native iOS `ScrollView` zoom rather than a third-party gallery. Keep thumbnail-tap tests on the real viewer.

`LibraryHeader` shares the glass-availability policy through `useGlassAvailability`. Its live blur and dark fading scrim appear only over photos; the resting header uses the semantic background. Unsupported platforms and Reduce Transparency use an opaque background. `expo-blur` and `@react-native-masked-view/masked-view` are native dependencies: rebuild the development client when adding or changing them; Metro reload alone is insufficient.

## Runtime Configuration

`src/config.ts` resolves the API URL in this order:

1. `Constants.expoConfig.extra.apiUrl` if present.
2. `EXPO_PUBLIC_API_URL`.
3. `http://localhost:3000`.

EAS build profiles in `eas.json` currently set `EXPO_PUBLIC_API_URL=https://photobrain-api.ericj5.com` and channels `development`, `preview`, or `production`.

Self-hosted Realtime routing comes from `realtimeToken.baseUrl`, configured on the API with `INNGEST_REALTIME_BASE_URL`. `useJobProgress` attaches a keyless Inngest client to both initial and refreshed tokens; durable polling remains the fallback. The URL must be reachable by the phone and expose `/v1/realtime/connect`. Event/signing keys stay on the API/runtime and must never be added to `EXPO_PUBLIC_*`. Existing installed clients need the updated JavaScript bundle to use this routing; their durable polling still works without it.

Metro watches the monorepo and redirects `@photobrain/image-processing` to `packages/image-processing/browser.js`. Native Rust processing must not be imported into the mobile bundle.

## OTA and Deployment

`app.json` configures `expo-updates` with `ON_LOAD` checks and a fingerprint runtime policy. The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout. Automatic Expo update configuration remains active; do not promise a native alert/restart flow without wiring the hook into the active layout.

After API/web/mobile tests, main releases run `scripts/ensure-preview-build.mjs` before publishing preview OTA updates for iOS and Android. The script resolves the iOS fingerprint runtime with Expo Updates, reuses a finished unexpired physical-device internal preview artifact with that runtime, awaits a matching pending build, or creates and waits for a new one. Compatibility uses `runtime.version`, not EAS's separate source `fingerprint.hash`. Errors, malformed records, failed builds, and incompatible results stop publication. Android native builds are not automated by this gate.

Both preview workflows use the `eas-preview-ios` concurrency group and pinned EAS CLI 24.7.0. The manual `EAS Preview iOS Build` workflow passes `--force` to create a fresh binary even when one is compatible. Each successful gate writes an install link and reuse/build outcome to the GitHub job summary. Both run under `eas env:exec preview`; the resolved environment must match `preview.env` in `eas.json`, including `EXPO_PUBLIC_API_URL`, because OTA publication does not consume build-profile environment overrides.

Version tags still wait for a production iOS EAS build before publishing an iOS production update. The workflows do not export Expo web. The Docker `mobile` target starts Expo on port 8081, not a static web image.

## Tests

Jest uses the `jest-expo` preset, `__tests__/setup.ts`, and mocks for Expo, native modules, tRPC, AsyncStorage, zoom, haptics, and Realtime. Current suites cover the active native tab routes, dashboard behavior, debounced search, filters, loupe, library state, durable progress, Liquid Glass fallback, and theme propagation.

CI runs:

```bash
cd apps/mobile
bun run test:ci
node --test scripts/ensure-preview-build.test.mjs
```

Tests do not perform real API calls, native EAS builds, or end-to-end checks of Preferences, Collections, About, and OTA behavior. Update mocks when changing request shapes, native route primitives, or thumbnail URL behavior.
