# PhotoBrain Mobile

The mobile application is an Expo/React Native client for PhotoBrain with native iOS/Android support and an Expo web target.

Read [`AGENTS.md`](AGENTS.md) for implementation details and [`../../CLAUDE.md`](../../CLAUDE.md) for repository-wide rules.

## Active Entrypoint and Routes

`package.json` uses `expo-router/entry`. The active route files are under `app/`:

- `(tabs)/index.tsx`: Library tab.
- `(tabs)/collections.tsx`: Collections placeholder tab.
- `(tabs)/search/index.tsx`: Search tab inside a native stack.
- `(tabs)/_layout.tsx`: native tab configuration.
- `preferences.tsx`: Settings stack route.
- `about.tsx`: About stack route.
- `_layout.tsx`: providers and root stack configuration.

`App.tsx` is a legacy React Navigation entrypoint. It is not the configured production entrypoint or the target of active navigation tests.

## Setup and Development

From the repository root:

```bash
bun install
bun run dev:mobile
```

From this directory:

```bash
bun run start
bun run ios
bun run android
bun run web
bun run build:web
```

Set the API URL in `.env`:

```env
EXPO_PUBLIC_API_URL=http://localhost:3000
```

Use `http://10.0.2.2:3000` for an Android emulator or the host machine's LAN address for a physical device. EAS profiles set `https://photobrain-api.ericj5.com` by default.

## Current Behavior

- Photos run oldest-to-newest in a continuous five-column phone grid, open at the newest edge, and support optional year or month grouping with up to eight columns on wide layouts.
- The fixed Library header keeps Options and selection available while photos scroll beneath a live blur and soft fade. Its subtitle changes from item count at the newest edge to the visible photo date while browsing history. The normal Library/Collections/Search tabs collapse while browsing history into one Collections button, Years/Months/All segments, and one Search button. Options contains captured/recently-added sorting, filters, scan initiation, and Settings.
- Filter combines RAW/standard choices with searchable camera/lens/ISO/month lists. Changes apply immediately; Done dismisses. All Items resets filters, and the library's active-filter summary offers direct editing and a one-tap reset.
- The Search tab uses the native iOS search bar and debounces natural-language queries by 350 ms.
- Tapping a photo opens a modal loupe with pinch/pan/zoom, swipe navigation, a tappable thumbnail filmstrip, haptics, and metadata. Compact glass controls show date/time, position, close, and info; tapping the photo hides or restores them.
- The loupe uses the `large` thumbnail URL; it does not request the original file route.
- Liquid Glass and the live header blur use opaque fallbacks when unavailable or Reduce Transparency is enabled. Larger text stacks the header controls without hiding them.
- Collections is an active native tab but remains a placeholder.
- Settings persists light/dark/system themes. Grid-column and haptic settings are currently disabled or hardcoded.
- The loupe does not display unimplemented share/like/delete controls.
- Photo grids use sharper previews, and failed loupe images offer Retry. Library and Search loupe controls use full-screen safe areas, including in landscape, rather than inheriting tab-bar padding.
- Photo Info supports wrapping, selectable values and larger text. Search messages remain scrollable below the native header.
- Filter shows metadata loading and retry states without blocking media-type choices or clearing filters. Selection can be exited without scrolling back to the header; bulk actions are not implemented.

The app uses tRPC for metadata, filters, search, scan, durable scan status, and Realtime tokens. REST is used for image and thumbnail URLs. On iOS, theme and active-scan recovery use the exact schema-1 `UserDefaults.standard` migration envelope `{schemaVersion, theme, activeScanId}`; the bridge seeds it from valid legacy AsyncStorage values only when the envelope is absent. Android and web continue to use AsyncStorage. Terminal or missing durable scan status clears the saved active scan. A compact floating Liquid Glass card above the bottom navigation reports background work as Discover, Prepare, and Search stages with phase-specific details, counts, and percentage.

## Scripts and Tests

```bash
bun run start
bun run android
bun run ios
bun run web
bun run build:web
bun run test
bun run test:ci
bun run typecheck
```

Jest uses `jest-expo` and mocks native modules, tRPC, Realtime, AsyncStorage, images, zoom, and haptics. CI runs `bun run test:ci` plus the Preview-build decision helper tests. Tests cover the active tab routes, dashboard, debounced search, filters, loupe, library state, durable progress, the iOS migration envelope, cross-platform storage behavior, Liquid Glass fallback, and theme propagation. They do not perform real API calls, native builds, signed-artifact inspection, or end-to-end Preferences, Collections, About, and OTA checks.

The `typecheck` script runs `tsc --noEmit` across active route and source files.

## EAS, Android OTA, and iOS Recovery

`eas.json` defines generic Expo `development`, `development-simulator`, `preview`, and `production` profiles plus the explicit `android-preview` and `android-production` release profiles. `app.json` configures `expo-updates` with a fingerprint runtime policy and on-load checks.

The current Expo native stack uses Expo SDK 57 and an iOS deployment target of 26.0. The Library header uses the native `expo-blur` and `@react-native-masked-view/masked-view` modules. Rebuild a receiving binary after native dependency changes; a Metro reload or OTA update cannot install missing native modules.

The normal automated publisher is Android-only. After API/web/mobile tests, pushes to `main` build an `android-preview` receiver and publish an Android-only update to `preview`; version tags build `android-production` and publish an Android-only update to `production`. Both publications run inside the matching EAS environment, compare the profile environment with the effective environment, and invoke `eas update --platform android`. There is no automatic iOS build or iOS OTA publication in the main/tag workflow.

`.github/workflows/eas-preview-build.yml` is a manual, forced Expo iOS internal Preview continuity check. It uses the EAS `preview` environment and shares the static `ios-production-release` concurrency group with both manual Production lanes. It is build-only: it does not publish an OTA, upload a Production replacement, or prove Preview signing/install behavior.

During the native migration rollback window, `.github/workflows/expo-ios-emergency-production.yml` is the separately confirmed Expo iOS Production replacement lane. It resolves the Production EAS environment, performs a frozen local prebuild/archive/export with manual signing, obtains its build number from the shared local App Store Connect allocator plus durable run reservation, applies the twelve-argument Production Expo inspector, retains the archive/IPA/dSYMs/evidence, and uploads to TestFlight. It never publishes an OTA and does not use EAS remote version synchronization or an EAS cloud build.

The iOS Preview and Production workflows are repository implementation only. They have not been credentialed or executed here, and they do not establish signing, App Store Connect acceptance, TestFlight processing/install, physical-device replacement, or native cutover evidence. Those external gates remain `UNVERIFIED`; see [`../../docs/native-migration-release.md`](../../docs/native-migration-release.md) and [`../../docs/native-migration-verification.md`](../../docs/native-migration-verification.md).

The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout; there is no active custom alert/restart flow.

The Docker `mobile` target runs the Expo development server on port 8081. It is not a static Expo web-export image.
