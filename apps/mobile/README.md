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

- Photos are sorted newest-first in a continuous five-column phone grid, with optional year or month grouping and up to eight columns on wide layouts.
- The fixed Library header keeps Options and selection available while photos scroll beneath a live blur and soft fade. Its subtitle changes from item count to the visible photo date. Years/Months/All Photos are directly accessible in a floating bottom control above the native tabs. Options contains captured/recently-added sorting, filters, scan initiation, and Settings.
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

The app uses tRPC for metadata, filters, search, scan, durable scan status, and Realtime tokens. REST is used for image and thumbnail URLs. Active scan IDs survive restarts in AsyncStorage and are cleared on terminal or missing durable status.

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

Jest uses `jest-expo` and mocks native modules, tRPC, Realtime, AsyncStorage, images, zoom, and haptics. CI runs `bun run test:ci`. Tests cover the active tab routes, dashboard, debounced search, filters, loupe, library state, durable progress, Liquid Glass fallback, and theme propagation. They do not perform real API calls, native builds, or end-to-end Preferences, Collections, About, and OTA checks.

The `typecheck` script runs `tsc --noEmit` across active route and source files.

## EAS and OTA

`eas.json` defines `development`, `development-simulator`, `preview`, and `production` build profiles with matching EAS channels. `app.json` configures `expo-updates` with a fingerprint runtime policy and on-load checks.

The current native stack uses Expo SDK 57 and an iOS deployment target of 26.0. Use EAS for device, simulator, preview, and TestFlight builds when a local Mac toolchain is unavailable.

The Library header uses the native `expo-blur` and `@react-native-masked-view/masked-view` modules. Rebuild the development client after native dependency changes; a Metro reload or OTA update cannot install missing native modules.

After API/web/mobile tests, pushes to `main` automatically ensure an installable iOS preview with the current Expo fingerprint runtime: reuse a compatible finished build, wait for a matching build already running, or build a new binary. Only then are preview OTA updates published for iOS and Android. Native Android builds remain separate. The GitHub job summary includes the iOS install link and whether the binary was reused or built. Install a new binary when the native runtime changes; OTA cannot upgrade the native runtime.

The preview gate runs in the EAS `preview` environment. Its environment values, including `EXPO_PUBLIC_API_URL`, must match `preview.env` in `eas.json`; a mismatch fails the release rather than publishing a differently configured update. Run the manual `EAS Preview iOS Build` workflow to force a fresh internal iOS build, for example after adding a registered device. Automatic and manual builds share a concurrency group.

Version tags still wait for a production iOS EAS build before publishing production iOS updates. The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout; there is no active custom alert/restart flow.

The Docker `mobile` target runs the Expo development server on port 8081. It is not a static Expo web-export image.
