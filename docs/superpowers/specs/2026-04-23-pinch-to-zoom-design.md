# Pinch-to-Zoom in Mobile Loupe View — Design

**Date:** 2026-04-23

## Goal

Add pinch-to-zoom and double-tap-to-zoom to the mobile loupe photo viewer, matching the behavior of iOS Photos and Google Photos.

## Architecture

Use `react-native-gesture-handler`'s Gesture API (`Gesture.Pinch`, `Gesture.Pan`, `Gesture.Tap`) composed together, with `react-native-reanimated` shared values and animated transforms for 60fps UI-thread-driven zoom.

Extract zoom logic into a standalone `ZoomablePhoto` component (`apps/mobile/src/components/ZoomablePhoto.tsx`) that wraps `expo-image`'s `<Image>`. LoupeView's `renderPhoto` uses `<ZoomablePhoto>` instead of the bare `<Image>`.

## Dependencies

- `react-native-gesture-handler` v2.30+ — already in `apps/mobile/package.json`
- `react-native-reanimated` v4.2.1 — already installed (hoisted in root `node_modules`); add explicit dep to `apps/mobile/package.json`
- Adding reanimated to `package.json` doesn't change the native binary if it's already bundled via Expo SDK 54 (which includes reanimated). OTA-safe.

## ZoomablePhoto Component

### Props

```ts
interface ZoomablePhotoProps {
  uri: string;
  placeholderUri?: string;
  width: number;   // container width (SCREEN_WIDTH)
  height: number;  // container height (SCREEN_HEIGHT)
}
```

### Gesture Composition

Three gestures composed simultaneously:

1. **Pinch** — scales image between 1x and 5x
   - `onUpdate`: multiply `scale` shared value by event's `scale` (relative to last frame)
   - `onEnd`: if scale < 1, animate back to 1x; if scale > 5, clamp to 5x

2. **Pan** (two-finger when zoomed) — translates image within the zoomed viewport
   - Activated only when `scale > 1` (via `activeOffsetX`/`activeOffsetY` or `simultaneousWithExternalGesture`)
   - `onUpdate`: set `translateX`/`translateY` from event offsets
   - `onEnd`: clamp translation so the image doesn't pan past its edges
   - When `scale === 1`, pan is ignored so the FlatList's horizontal paging works normally

3. **Double-tap** — toggles between 1x and 2.5x zoom
   - `numberOfTaps(2)`
   - Animates `scale` to 2.5x (and centers on tap point) or back to 1x
   - Resets `translateX`/`translateY` when zooming out

### Animated Transform

```ts
const animatedStyle = useAnimatedStyle(() => ({
  transform: [
    { translateX: translateX.value },
    { translateY: translateY.value },
    { scale: scale.value },
  ],
}));
```

Applied to an `Animated.View` wrapping the `<Image>`.

### FlatList Interaction

- The FlatList has `pagingEnabled` and `horizontal`. When a photo is zoomed in (`scale > 1`), the pan gesture consumes horizontal movement, preventing the FlatList from paging.
- When zoomed out (`scale === 1`), gestures don't intercept horizontal scrolls, so the FlatList pages normally.
- On page change (via `onMomentumScrollEnd` in LoupeView), the parent should reset zoom. This is achieved by keying `ZoomablePhoto` with the photo ID — React unmounts/remounts it on page change, resetting all animated values.

### Edge Clamping

When zoomed, translation is clamped so the image edge can't move past the viewport center:

```
maxTranslateX = (width * (scale - 1)) / 2
maxTranslateY = (height * (scale - 1)) / 2
```

## Changes to LoupeView

Minimal changes:
- `renderPhoto` replaces `<View><Image .../></View>` with `<ZoomablePhoto uri={...} placeholderUri={...} width={SCREEN_WIDTH} height={SCREEN_HEIGHT} />`
- No other LoupeView changes needed

## Changes to LoupeView Tests

- Existing `LoupeView.test.tsx` tests don't test gesture interactions (jsdom can't)
- Add one test: `ZoomablePhoto renders without crashing` — verifies it mounts with props
- Gesture behavior (pinch, double-tap, pan) is manual QA only

## Files

### New
- `apps/mobile/src/components/ZoomablePhoto.tsx` — the zoom component

### Modified
- `apps/mobile/package.json` — add `react-native-reanimated` to dependencies
- `apps/mobile/src/components/LoupeView.tsx` — use `ZoomablePhoto` in `renderPhoto`
- `apps/mobile/__tests__/LoupeView.test.tsx` — add render smoke test for ZoomablePhoto
- `apps/mobile/__tests__/setup.ts` — add mock for `react-native-reanimated` if needed

## Out of Scope

- Zoom indicator UI (e.g., "2.5x" badge)
- Zoom-dependent overlay hiding (top/bottom bars stay visible at all zoom levels)
- Sharing the zoom component with web (web has its own zoom via CSS transforms)

## Success Criteria

- Pinch-to-zoom scales the current photo smoothly (UI thread, no jank)
- Double-tap toggles between 1x and 2.5x
- Panning works when zoomed in to explore the image
- Horizontal swiping to next/prev photo works normally when at 1x
- Zoom resets when swiping to a different photo
- Existing tests pass; new smoke test for ZoomablePhoto passes
