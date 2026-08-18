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
- The photo-backed Library header exposes selection and Library Options; grouping, EXIF camera/lens/ISO/month filters, scan initiation, and Settings remain available in the options sheet.
- The Search tab uses the native iOS search bar and debounces natural-language queries by 350 ms.
- Tapping a photo opens a modal loupe with pinch/pan/zoom, swipe navigation, haptics, and metadata.
- The loupe uses the `large` thumbnail URL; it does not request the original file route.
- Liquid Glass is native on supported iOS versions and falls back when unavailable or Reduce Transparency is enabled.
- Collections is an active native tab but remains a placeholder.
- Settings persists light/dark/system themes. Grid-column and haptic settings are currently disabled or hardcoded.
- The loupe does not display unimplemented share/like/delete controls.

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

The GitHub Actions workflow publishes preview OTA updates on pushes to `main` and production iOS updates on version tags after API/web/mobile tests. Tagged releases first wait for a production iOS EAS build so native dependency changes have a matching binary. The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout; do not document an alert/restart flow as active without wiring it into the active layout.

Run the manual `EAS Preview iOS Build` GitHub Actions workflow to create an internal iOS installation after native dependency or runtime fingerprint changes.

The Docker `mobile` target runs the Expo development server on port 8081. It is not a static Expo web-export image.
