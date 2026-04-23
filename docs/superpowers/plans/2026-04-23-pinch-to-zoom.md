# Pinch-to-Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pinch-to-zoom, pan-when-zoomed, and double-tap-to-zoom to the mobile loupe photo viewer.

**Architecture:** New `ZoomablePhoto` component using `react-native-gesture-handler` Gesture API + `react-native-reanimated` animated transforms. Composed Pinch + Pan + DoubleTap gestures run on the UI thread. LoupeView's `renderPhoto` swaps bare `<Image>` for `<ZoomablePhoto>`. FlatList paging works normally at 1x; at >1x, pan consumes horizontal movement.

**Tech Stack:** `react-native-gesture-handler` v2.30+, `react-native-reanimated` v4.2, `expo-image`

**Spec reference:** `docs/superpowers/specs/2026-04-23-pinch-to-zoom-design.md`

---

## File Structure

### New
- `apps/mobile/src/components/ZoomablePhoto.tsx` — pinch/pan/double-tap zoom wrapper

### Modified
- `apps/mobile/package.json` — add `react-native-reanimated` dep
- `apps/mobile/babel.config.js` — add reanimated babel plugin (required for worklets)
- `apps/mobile/jest.config.js` — add reanimated to transformIgnorePatterns
- `apps/mobile/__tests__/setup.ts` — add reanimated jest mock
- `apps/mobile/src/components/LoupeView.tsx` — use `ZoomablePhoto` in `renderPhoto`
- `apps/mobile/__tests__/LoupeView.test.tsx` — add smoke test for ZoomablePhoto

---

## Task 1: Add react-native-reanimated dependency and config

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/babel.config.js`
- Modify: `apps/mobile/jest.config.js`
- Modify: `apps/mobile/__tests__/setup.ts`

- [ ] **Step 1: Add reanimated to mobile package.json**

Run:
```bash
cd /root/photobrain && bun add react-native-reanimated --filter @photobrain/mobile
```

If that doesn't work (monorepo filter issues), edit `apps/mobile/package.json` directly — add `"react-native-reanimated": "^4.2.1"` to `dependencies`, then run `bun install`.

- [ ] **Step 2: Add reanimated babel plugin**

Edit `apps/mobile/babel.config.js`. The reanimated plugin MUST be last:

```js
module.exports = (api) => {
	api.cache(true);
	return {
		presets: ["babel-preset-expo"],
		plugins: [
			[
				"module-resolver",
				{
					root: ["./src"],
					alias: {
						"@": "./src",
					},
				},
			],
			"react-native-reanimated/plugin",
		],
	};
};
```

- [ ] **Step 3: Add reanimated to jest transformIgnorePatterns**

Edit `apps/mobile/jest.config.js`. Add `react-native-reanimated` to the regex so Jest transforms it:

```js
module.exports = {
	preset: "jest-expo",
	setupFiles: [
		"<rootDir>/__tests__/globalSetup.js",
		"<rootDir>/node_modules/react-native-reanimated/src/jestUtils.ts",
	],
	setupFilesAfterEnv: ["<rootDir>/__tests__/setup.ts"],
	transformIgnorePatterns: [
		"node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|@trpc/.*|superjson|@tanstack/.*|react-native-reanimated|react-native-gesture-handler)",
	],
	moduleNameMapper: {
		"^@/(.*)$": "<rootDir>/src/$1",
	},
	testMatch: ["<rootDir>/__tests__/**/*.test.{ts,tsx}"],
};
```

Note the changes: added `react-native-reanimated|react-native-gesture-handler` to the transform allowlist, and added `react-native-reanimated/src/jestUtils.ts` to `setupFiles` (provides `setUpTests()` which mocks reanimated internals for Jest).

If `jestUtils.ts` path doesn't resolve (hoisted to root node_modules), use `../../node_modules/react-native-reanimated/src/jestUtils.ts` instead.

- [ ] **Step 4: Add reanimated mock to test setup**

Edit `apps/mobile/__tests__/setup.ts`. Add at the top (before other mocks):

```ts
// Mock react-native-reanimated
jest.mock("react-native-reanimated", () => {
	const Reanimated = require("react-native-reanimated/mock");
	Reanimated.default.call = () => {};
	return Reanimated;
});
```

- [ ] **Step 5: Verify existing tests still pass**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all 41 tests pass. If reanimated mock causes issues, check the `setupFiles` path and the mock ordering in `setup.ts`.

- [ ] **Step 6: Commit**

```bash
cd /root/photobrain && git add apps/mobile/package.json apps/mobile/babel.config.js apps/mobile/jest.config.js apps/mobile/__tests__/setup.ts bun.lock
git commit -m "chore(mobile): add react-native-reanimated dep and jest config"
```

---

## Task 2: Create ZoomablePhoto component

**Files:**
- Create: `apps/mobile/src/components/ZoomablePhoto.tsx`

- [ ] **Step 1: Create the component**

Create `apps/mobile/src/components/ZoomablePhoto.tsx`:

```tsx
import { Image } from "expo-image";
import React from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

interface ZoomablePhotoProps {
	uri: string;
	placeholderUri?: string;
	width: number;
	height: number;
}

export default function ZoomablePhoto({
	uri,
	placeholderUri,
	width,
	height,
}: ZoomablePhotoProps) {
	const scale = useSharedValue(1);
	const savedScale = useSharedValue(1);
	const translateX = useSharedValue(0);
	const translateY = useSharedValue(0);
	const savedTranslateX = useSharedValue(0);
	const savedTranslateY = useSharedValue(0);

	const clampTranslation = (
		value: number,
		dimension: number,
		currentScale: number,
	) => {
		"worklet";
		const maxTranslate = (dimension * (currentScale - 1)) / 2;
		return Math.min(Math.max(value, -maxTranslate), maxTranslate);
	};

	const pinchGesture = Gesture.Pinch()
		.onUpdate((e) => {
			"worklet";
			const newScale = savedScale.value * e.scale;
			scale.value = Math.min(Math.max(newScale, MIN_SCALE * 0.5), MAX_SCALE);
		})
		.onEnd(() => {
			"worklet";
			if (scale.value < MIN_SCALE) {
				scale.value = withTiming(MIN_SCALE);
				translateX.value = withTiming(0);
				translateY.value = withTiming(0);
				savedTranslateX.value = 0;
				savedTranslateY.value = 0;
			} else if (scale.value > MAX_SCALE) {
				scale.value = withTiming(MAX_SCALE);
			}
			savedScale.value = scale.value;
			// Clamp translation after pinch
			translateX.value = clampTranslation(
				translateX.value,
				width,
				scale.value,
			);
			translateY.value = clampTranslation(
				translateY.value,
				height,
				scale.value,
			);
			savedTranslateX.value = translateX.value;
			savedTranslateY.value = translateY.value;
		});

	const panGesture = Gesture.Pan()
		.minPointers(1)
		.onUpdate((e) => {
			"worklet";
			if (scale.value <= 1) return;
			const newX = savedTranslateX.value + e.translationX;
			const newY = savedTranslateY.value + e.translationY;
			translateX.value = clampTranslation(newX, width, scale.value);
			translateY.value = clampTranslation(newY, height, scale.value);
		})
		.onEnd(() => {
			"worklet";
			savedTranslateX.value = translateX.value;
			savedTranslateY.value = translateY.value;
		});

	const doubleTapGesture = Gesture.Tap()
		.numberOfTaps(2)
		.onEnd(() => {
			"worklet";
			if (scale.value > 1) {
				// Zoom out to 1x
				scale.value = withTiming(MIN_SCALE);
				translateX.value = withTiming(0);
				translateY.value = withTiming(0);
				savedScale.value = MIN_SCALE;
				savedTranslateX.value = 0;
				savedTranslateY.value = 0;
			} else {
				// Zoom in to 2.5x
				scale.value = withTiming(DOUBLE_TAP_SCALE);
				savedScale.value = DOUBLE_TAP_SCALE;
			}
		});

	const composedGesture = Gesture.Simultaneous(
		doubleTapGesture,
		Gesture.Simultaneous(pinchGesture, panGesture),
	);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: translateX.value },
			{ translateY: translateY.value },
			{ scale: scale.value },
		],
	}));

	return (
		<GestureDetector gesture={composedGesture}>
			<Animated.View style={[styles.container, { width, height }, animatedStyle]}>
				<Image
					source={{ uri }}
					placeholder={placeholderUri ? { uri: placeholderUri } : undefined}
					style={styles.image}
					contentFit="contain"
					priority="high"
					cachePolicy="memory-disk"
				/>
			</Animated.View>
		</GestureDetector>
	);
}

const styles = StyleSheet.create({
	container: {
		justifyContent: "center",
		alignItems: "center",
	},
	image: {
		width: "100%",
		height: "100%",
	},
});
```

- [ ] **Step 2: Commit**

```bash
cd /root/photobrain && git add apps/mobile/src/components/ZoomablePhoto.tsx
git commit -m "feat(mobile): add ZoomablePhoto component with pinch/pan/double-tap"
```

---

## Task 3: Integrate ZoomablePhoto into LoupeView

**Files:**
- Modify: `apps/mobile/src/components/LoupeView.tsx`

- [ ] **Step 1: Update LoupeView to use ZoomablePhoto**

In `apps/mobile/src/components/LoupeView.tsx`, replace the `renderPhoto` callback.

Add import at top:
```tsx
import ZoomablePhoto from "@/components/ZoomablePhoto";
```

Replace the existing `renderPhoto` (lines 60-76):

```tsx
const renderPhoto = useCallback(
	({ item }: { item: PhotoMetadata }) => (
		<View style={styles.photoContainer}>
			<ZoomablePhoto
				uri={`${apiUrl}/api/photos/${item.id}/thumbnail/large`}
				placeholderUri={`${apiUrl}/api/photos/${item.id}/thumbnail/small`}
				width={SCREEN_WIDTH}
				height={SCREEN_HEIGHT}
			/>
		</View>
	),
	[apiUrl],
);
```

Remove the `Image` import from `expo-image` at the top of the file IF it's no longer used elsewhere (it should not be — `renderPhoto` was the only usage).

- [ ] **Step 2: Run tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass. The LoupeView tests render with the mocked reanimated, so ZoomablePhoto's animated views render as plain Views.

- [ ] **Step 3: Commit**

```bash
cd /root/photobrain && git add apps/mobile/src/components/LoupeView.tsx
git commit -m "feat(mobile): integrate ZoomablePhoto into LoupeView"
```

---

## Task 4: Add ZoomablePhoto smoke test

**Files:**
- Modify: `apps/mobile/__tests__/LoupeView.test.tsx`

- [ ] **Step 1: Add smoke test**

Add to the existing `describe("LoupeView")` block in `apps/mobile/__tests__/LoupeView.test.tsx`:

```tsx
it("renders ZoomablePhoto inside the loupe", async () => {
	const { getAllByTestId } = renderWithProviders(
		<LoupeView {...defaultProps} />,
	);

	await waitFor(() => {
		const images = getAllByTestId("expo-image");
		expect(images.length).toBeGreaterThan(0);
	});

	// Verify the image renders with the correct large thumbnail URI
	const images = getAllByTestId("expo-image");
	const hasLargeThumbnail = images.some((img) =>
		img.props.accessibilityLabel?.includes("/thumbnail/large"),
	);
	expect(hasLargeThumbnail).toBe(true);
});
```

Note: this test already exists as `"renders large thumbnail URIs"` in the file. If so, this step is a no-op — the existing test already covers ZoomablePhoto rendering. Verify by reading the test file and checking.

- [ ] **Step 2: Run tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass.

- [ ] **Step 3: Commit (only if test was added)**

```bash
cd /root/photobrain && git add apps/mobile/__tests__/LoupeView.test.tsx
git commit -m "test(mobile): verify ZoomablePhoto renders in loupe"
```

---

## Task 5: Final verification and push

- [ ] **Step 1: Run all mobile tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass.

- [ ] **Step 2: Run web E2E to check for regressions**

Run: `cd /root/photobrain/apps/web && bunx playwright test --reporter=line`

Expected: all 18 tests pass (mobile changes don't affect web).

- [ ] **Step 3: Push and publish OTA**

```bash
cd /root/photobrain && git push origin main
cd apps/mobile && EXPO_PUBLIC_API_URL=https://photobrain-api.ericj5.com bunx eas-cli update --branch preview --message "Pinch-to-zoom @ $(git rev-parse --short HEAD)" --non-interactive
```

Note: adding `react-native-reanimated` to `package.json` is technically a dependency change. However, reanimated is already part of the Expo SDK 54 runtime and included in the native binary. The OTA should work without a native rebuild. If the app crashes after the OTA, a native rebuild via `eas build` is needed.
