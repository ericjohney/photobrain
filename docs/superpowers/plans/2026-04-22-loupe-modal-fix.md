# Loupe Modal Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the loupe view rendering so only one set of bottom buttons is visible — the loupe's action bar (Share, Like, Info, Delete) — with the navigator tab bar (Dashboard, Collections, etc.) fully hidden behind the native modal.

**Architecture:** Wrap LoupeView in React Native's `<Modal>` component. `<Modal>` renders above the entire native view hierarchy (including navigation tab bars) without any `zIndex` hacks. DashboardScreen controls modal visibility via existing `library.viewMode === "loupe"` state. Remove the broken `position: absolute` overlay approach and all `loupeOverlay` styling.

**Tech Stack:** React Native `<Modal>` (built-in), jest-expo + @testing-library/react-native (testing)

---

## File Structure

### Modified
- `apps/mobile/src/screens/DashboardScreen.tsx` — replace overlay with `<Modal>`; remove `loupeOverlay` style, `SCREEN_HEIGHT` constant
- `apps/mobile/__tests__/DashboardScreen.test.tsx` — add test asserting Modal renders in loupe mode, tab bar not visible

### Unchanged
- `apps/mobile/src/components/LoupeView.tsx` — no changes needed; it already fills its container with `flex: 1`
- `apps/mobile/App.tsx` — no changes; tab bar config stays as-is

---

## Task 1: Add test for loupe rendering in a Modal

**Files:**
- Modify: `apps/mobile/__tests__/DashboardScreen.test.tsx`

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("DashboardScreen")` block:

```tsx
it("renders loupe in a Modal when photo is tapped", async () => {
	const { getAllByTestId, UNSAFE_queryByType } = renderWithProviders(
		<DashboardScreen />,
	);
	await waitFor(() => {
		expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
	});

	// Modal should not be visible initially
	const { Modal } = require("react-native");
	const modalBefore = UNSAFE_queryByType(Modal);
	expect(
		!modalBefore || modalBefore.props.visible === false,
	).toBe(true);

	// Tap a photo to open loupe
	const images = getAllByTestId("expo-image");
	const photoImage = images.find((img) => {
		const label = img.props.accessibilityLabel || "";
		return label.includes("/api/photos/") && label.includes("/thumbnail/tiny");
	});
	expect(photoImage).toBeTruthy();
	fireEvent.press(photoImage!);

	// Modal should now be visible with loupe action buttons
	await waitFor(() => {
		const modal = UNSAFE_queryByType(Modal);
		expect(modal).toBeTruthy();
		expect(modal!.props.visible).toBe(true);
	});

	// Loupe action buttons should be present
	await waitFor(() => {
		expect(getByText("Share")).toBeTruthy();
		expect(getByText("Info")).toBeTruthy();
	});
});
```

Note: also destructure `getByText` from `renderWithProviders` at the top of the test. The full destructure should be:
```tsx
const { getAllByTestId, getByText, UNSAFE_queryByType } = renderWithProviders(
	<DashboardScreen />,
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/photobrain/apps/mobile && bun run test -- DashboardScreen --testNamePattern="renders loupe in a Modal"`

Expected: FAIL — `Modal` not found or `visible` is not `true` (because current code uses a `View` overlay, not `Modal`).

- [ ] **Step 3: Commit the failing test**

```bash
cd /root/photobrain && git add apps/mobile/__tests__/DashboardScreen.test.tsx
git commit -m "test(mobile): add failing test for loupe Modal rendering"
```

---

## Task 2: Replace overlay with Modal in DashboardScreen

**Files:**
- Modify: `apps/mobile/src/screens/DashboardScreen.tsx`

- [ ] **Step 1: Add Modal to imports**

In `apps/mobile/src/screens/DashboardScreen.tsx`, add `Modal` to the react-native import:

```tsx
import {
	ActivityIndicator,
	Dimensions,
	FlatList,
	Modal,
	Pressable,
	RefreshControl,
	StyleSheet,
	Text,
	View,
} from "react-native";
```

- [ ] **Step 2: Replace the overlay View with Modal**

Find this block (around line 449-464):

```tsx
{/* Loupe overlay — positioned over entire window including tab bar */}
{showLoupe && (
	<View style={styles.loupeOverlay}>
		<LoupeView
			photos={photos}
			initialIndex={
				library.activePhotoIndex >= 0 ? library.activePhotoIndex : 0
			}
			apiUrl={API_URL}
			onClose={handleLoupeClose}
			onIndexChange={handleLoupeIndexChange}
			onShowMetadata={handleShowMetadata}
		/>
	</View>
)}
```

Replace with:

```tsx
{/* Loupe renders in a Modal to cover the entire screen including tab bar.
    Modal sits above the native view hierarchy — no zIndex needed. */}
<Modal
	visible={showLoupe}
	animationType="fade"
	statusBarTranslucent
	onRequestClose={handleLoupeClose}
>
	<LoupeView
		photos={photos}
		initialIndex={
			library.activePhotoIndex >= 0 ? library.activePhotoIndex : 0
		}
		apiUrl={API_URL}
		onClose={handleLoupeClose}
		onIndexChange={handleLoupeIndexChange}
		onShowMetadata={handleShowMetadata}
	/>
	<MetadataPanel
		visible={metadataPhoto !== null}
		photo={metadataPhoto}
		apiUrl={API_URL}
		onClose={handleCloseMetadata}
	/>
</Modal>
```

Note: `MetadataPanel` moves INSIDE the Modal so it also renders above the tab bar. Remove the separate `MetadataPanel` block that currently sits outside the overlay (around line 467-472).

- [ ] **Step 3: Remove the duplicate MetadataPanel outside the Modal**

Delete this block (previously around line 467-472, after the overlay):

```tsx
{/* Metadata panel */}
<MetadataPanel
	visible={metadataPhoto !== null}
	photo={metadataPhoto}
	apiUrl={API_URL}
	onClose={handleCloseMetadata}
/>
```

- [ ] **Step 4: Remove the loupeOverlay style and unused SCREEN_HEIGHT**

In the `StyleSheet.create` block, remove:

```tsx
loupeOverlay: {
	position: "absolute",
	top: 0,
	left: 0,
	width: SCREEN_WIDTH,
	height: SCREEN_HEIGHT,
	zIndex: 1000,
	elevation: 1000,
},
```

Then change the Dimensions destructure at the top of the file from:

```tsx
const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } =
	Dimensions.get("window");
```

Back to:

```tsx
const { width: SCREEN_WIDTH } = Dimensions.get("window");
```

(`SCREEN_HEIGHT` is no longer used.)

- [ ] **Step 5: Run all tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all 45 tests pass (44 existing + 1 new Modal test).

- [ ] **Step 6: Commit**

```bash
cd /root/photobrain && git add apps/mobile/src/screens/DashboardScreen.tsx apps/mobile/__tests__/DashboardScreen.test.tsx
git commit -m "fix(mobile): render loupe in Modal to cover tab bar

Modal renders above the entire native view hierarchy including
the navigation tab bar. Replaces position:absolute overlay which
could not stack above the tab bar (zIndex only works among
siblings in the RN view tree).

MetadataPanel also moves inside the Modal so it renders above
the tab bar when viewing photo metadata in loupe mode."
```

---

## Task 3: Add test for loupe close returning to grid (no Modal)

**Files:**
- Modify: `apps/mobile/__tests__/DashboardScreen.test.tsx`

- [ ] **Step 1: Write the test**

Add after the previous test:

```tsx
it("closes the Modal when back button is pressed in loupe", async () => {
	const { getAllByTestId, getByTestId, UNSAFE_queryByType } =
		renderWithProviders(<DashboardScreen />);
	await waitFor(() => {
		expect(getAllByTestId("expo-image").length).toBeGreaterThan(0);
	});

	// Open loupe
	const images = getAllByTestId("expo-image");
	const photoImage = images.find((img) => {
		const label = img.props.accessibilityLabel || "";
		return label.includes("/api/photos/") && label.includes("/thumbnail/tiny");
	});
	fireEvent.press(photoImage!);

	const { Modal } = require("react-native");
	await waitFor(() => {
		const modal = UNSAFE_queryByType(Modal);
		expect(modal?.props.visible).toBe(true);
	});

	// Press back button to close
	fireEvent.press(getByTestId("icon-chevron-back"));

	// Modal should be hidden
	await waitFor(() => {
		const modal = UNSAFE_queryByType(Modal);
		expect(!modal || modal.props.visible === false).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /root/photobrain/apps/mobile && bun run test -- DashboardScreen --testNamePattern="closes the Modal"`

Expected: PASS (the close handler already works via `handleLoupeClose` → `library.closeLoupe()` → `viewMode: "grid"` → `showLoupe: false` → `Modal visible={false}`).

- [ ] **Step 3: Run full suite**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all 46 tests pass.

- [ ] **Step 4: Commit**

```bash
cd /root/photobrain && git add apps/mobile/__tests__/DashboardScreen.test.tsx
git commit -m "test(mobile): add test for loupe Modal close behavior"
```

---

## Task 4: Clean up leftover tab bar hiding code

**Files:**
- Modify: `apps/mobile/src/theme/ThemeContext.tsx` (if `tabBarHidden`/`setTabBarHidden` still present)
- Modify: `apps/mobile/App.tsx` (if custom `tabBar` prop or `BottomTabBar` import still present)

- [ ] **Step 1: Verify there's nothing left to clean**

Run:
```bash
cd /root/photobrain && grep -rn "tabBarHidden\|setTabBarHidden\|useTabBarStyle\|BottomTabBar\|tabBar.*props" apps/mobile/src/ apps/mobile/App.tsx
```

If any matches are found, remove them. If no matches, this task is a no-op — skip to Step 3.

- [ ] **Step 2: Remove any remaining references**

Delete any code found in Step 1. Ensure `ThemeContext` has no `tabBarHidden` state, `App.tsx` has no custom `tabBar` prop, and no file imports `BottomTabBar` or `useTabBarStyle`.

- [ ] **Step 3: Run full test suite**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass.

- [ ] **Step 4: Commit (only if changes were made)**

```bash
cd /root/photobrain && git add -A apps/mobile/ && git commit -m "chore(mobile): remove leftover tab bar hiding code"
```

---

## Task 5: Final verification and push

- [ ] **Step 1: Run full mobile test suite**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass, including the 2 new Modal tests.

- [ ] **Step 2: Run web E2E to ensure no regressions**

Run: `cd /root/photobrain/apps/web && bunx playwright test --reporter=line`

Expected: all 23 tests pass (no mobile changes affect web).

- [ ] **Step 3: Push to main**

```bash
cd /root/photobrain && git push origin main
```

CI will run tests and publish OTA to preview channel.
