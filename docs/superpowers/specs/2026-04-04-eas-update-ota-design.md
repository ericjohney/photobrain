# EAS Update: Over-The-Air Updates for PhotoBrain iOS

**Date:** 2026-04-04
**Status:** Draft

## Goal

Enable pushing JavaScript/TypeScript code updates to installed PhotoBrain iOS apps without requiring a full native rebuild or App Store submission. Users see a native prompt when an update is available and choose when to restart.

## Requirements

- OTA updates via EAS Update on all build profiles (development, development-simulator, preview, production)
- Check for updates on app launch (non-blocking)
- Native alert prompt: "Update Available — Restart now?" with Restart / Later options
- Safe on web (Expo web export) and in dev mode (no crashes)
- Always offer the latest update (no version pinning or rollback UI)
- Document the update workflow in CLAUDE.md

## What Can Be Updated OTA

- All React Native JS/TS code (components, screens, hooks, styles)
- Static assets bundled with the app (images, fonts)
- Config changes in the JS layer

## What Requires a New Native Build

- Native module changes (new Expo SDK version, new native dependencies)
- Changes to `app.json` that affect native config (bundle ID, permissions, etc.)
- Rust NAPI module changes (not used in mobile)

## Design

### 1. Configuration: `app.json`

Add `updates` and `runtimeVersion` to the `expo` object:

```json
{
  "expo": {
    "updates": {
      "url": "https://u.expo.dev/5fcc4958-f697-46c6-9cfc-cd2ce0ac695c",
      "checkAutomatically": "ON_LOAD",
      "fallbackToCacheTimeout": 0
    },
    "runtimeVersion": {
      "policy": "appVersion"
    }
  }
}
```

- `checkAutomatically: "ON_LOAD"` — checks on every app launch
- `fallbackToCacheTimeout: 0` — never blocks app launch waiting for a download
- `runtimeVersion` with `appVersion` policy — runtime compatibility is tied to the `version` field in app.json. Bumping the version means old OTA updates won't apply to new native builds.

### 2. Configuration: `eas.json`

Add `channel` to each build profile:

| Profile | Channel |
|---------|---------|
| `development` | `"development"` |
| `development-simulator` | `"development"` |
| `preview` | `"preview"` |
| `production` | `"production"` |

Channels allow targeting updates to specific audiences. An update pushed to `preview` won't affect `production` builds.

### 3. New Hook: `useOTAUpdates`

**File:** `apps/mobile/src/hooks/useOTAUpdates.ts`

Behavior:
1. Skip entirely if `__DEV__` is true (dev client loads from bundler, not OTA)
2. On mount, call `Updates.checkForUpdateAsync()`
3. If an update is available, call `Updates.fetchUpdateAsync()` to download it
4. Show `Alert.alert()` with title "Update Available", message "A new version of PhotoBrain is ready. Restart now?", buttons: "Later" (dismiss) and "Restart" (`Updates.reloadAsync()`)
5. All errors are silently caught — OTA should never crash the app

### 4. Integration Point: Root Layout

**File:** `apps/mobile/src/app/_layout.tsx`

Call `useOTAUpdates()` at the top level of the root layout component. This ensures the check runs once on every app launch.

### 5. Web/Dev Safety

- `__DEV__` guard prevents execution in development builds
- `expo-updates` already provides no-op stubs for web via Metro's browser field resolution (existing `metro.config.js` pattern handles this)
- The hook wraps all calls in try/catch for additional safety

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `apps/mobile/package.json` | Modify | Add `expo-updates` dependency |
| `apps/mobile/app.json` | Modify | Add `updates` config and `runtimeVersion` |
| `apps/mobile/eas.json` | Modify | Add `channel` to all 4 build profiles |
| `apps/mobile/src/hooks/useOTAUpdates.ts` | Create | New hook (~30 lines) |
| `apps/mobile/src/app/_layout.tsx` | Modify | Call `useOTAUpdates()` |
| `CLAUDE.md` | Modify | Document OTA update workflow |

## Pushing Updates (Workflow)

```bash
# Push update to a specific channel
cd apps/mobile
eas update --branch preview --message "Fix search bar styling"
eas update --branch production --message "v0.1.1 hotfix"

# List published updates
eas update:list

# After native changes, rebuild first
eas build --platform ios --profile preview
```

## Important Notes

- The first build after adding `expo-updates` MUST be a full native build (so the updates runtime is included in the binary)
- Subsequent JS-only changes can be pushed via `eas update`
- If you add a new native dependency, you need a new native build before OTA updates will work again
