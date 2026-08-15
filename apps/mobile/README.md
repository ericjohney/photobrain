# PhotoBrain Mobile

The mobile application is an Expo/React Native client for PhotoBrain with native iOS/Android support and an Expo web target.

Read [`AGENTS.md`](AGENTS.md) for implementation details and [`../../CLAUDE.md`](../../CLAUDE.md) for repository-wide rules.

## Active Entrypoint and Routes

`package.json` uses `expo-router/entry`. The active route files are under `app/`:

- `index.tsx`: Photos tab.
- `search.tsx`: Search tab.
- `collections.tsx`: Albums placeholder.
- `preferences.tsx`: Library/preferences tab.
- `about.tsx`: hidden route.
- `_layout.tsx`: providers and tab configuration.

`App.tsx` is a legacy React Navigation entrypoint used by some tests. It is not the configured production entrypoint.

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

- Photos are sorted newest-first, grouped by month/date, and displayed in a four-column grid.
- The Photos tab supports EXIF camera/lens/ISO/month filters, pull-to-refresh, scan initiation, and Inngest progress.
- The Search tab sends non-empty natural-language queries directly to `searchPhotos` with no debounce.
- Tapping a photo opens a modal loupe with pinch/pan/zoom, swipe navigation, haptics, and metadata.
- The loupe uses the `large` thumbnail URL; it does not request the original file route.
- Collections remains a placeholder.
- Preferences persists light/dark/system themes. Grid-column and haptic settings are currently disabled or hardcoded.
- Loupe share/like/delete/star/overflow controls are placeholders unless their implementation is changed.

The app uses tRPC for metadata, filters, search, scan, and Realtime tokens. REST is used for image and thumbnail URLs.

## Scripts and Tests

```bash
bun run start
bun run android
bun run ios
bun run web
bun run build:web
bun run test
```

Jest uses `jest-expo` and mocks native modules, tRPC, Realtime, AsyncStorage, images, zoom, and haptics. CI runs `npx jest --forceExit` from this directory. Tests cover dashboard, search, filters, loupe, library state, and legacy navigation. They do not cover the active Expo Router layout, real API calls, Preferences, Collections, About, or OTA behavior.

The `typecheck` script currently prints an informational message and does not run TypeScript checking.

## EAS and OTA

`eas.json` defines `development`, `development-simulator`, `preview`, and `production` build profiles with matching EAS channels. `app.json` configures `expo-updates` with an `appVersion` runtime policy and on-load checks.

The GitHub Actions workflow publishes OTA updates on pushes to `main` and version tags after web/mobile tests. The manual `useOTAUpdates` hook is used by legacy `App.tsx`, not the active Expo Router layout; do not document an alert/restart flow as active without wiring it into the active layout.

The Docker `mobile` target runs the Expo development server on port 8081. It is not a static Expo web-export image.
