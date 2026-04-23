# Remove Selection Functionality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all photo selection/bulk-operation UI and state from both mobile and web — tap/click opens loupe, nothing else.

**Architecture:** Pure deletion across both platforms. Remove `selectedPhotos`, `selectPhoto`, `selectAll`, `clearSelection`, `selectedCount`, `hasSelection`, `lastSelectedIndex` from both `useLibraryState` hooks. Remove selection UI (checkmarks, overlays, "X of Y selected") from components. Remove Cmd+A and Escape-to-clear-selection keyboard shortcuts. Delete the `selection.spec.ts` E2E test file. Keep `activePhoto` and all loupe/navigation functionality intact.

**Tech Stack:** React, React Native, Playwright (test cleanup)

---

## File Structure

### Deleted
- `apps/web/e2e/selection.spec.ts`

### Modified — Mobile
- `apps/mobile/src/hooks/use-library-state.ts` — remove selection state and methods
- `apps/mobile/src/screens/DashboardScreen.tsx` — remove long-press handler, selection circles, checkmark overlay, related styles
- `apps/mobile/__tests__/DashboardScreen.test.tsx` — remove long-press/haptic test

### Modified — Web
- `apps/web/src/hooks/use-library-state.ts` — remove selection state and methods
- `apps/web/src/hooks/use-keyboard-shortcuts.ts` — remove `selectAll`, `clearSelection` params and Cmd+A/Escape-clear handlers
- `apps/web/src/pages/Dashboard.tsx` — stop passing selection props, simplify click handler
- `apps/web/src/components/PhotoGrid.tsx` — remove `selectedPhotos` prop and selection ring styling
- `apps/web/src/components/Filmstrip.tsx` — remove `selectedPhotos` prop and selection ring styling
- `apps/web/src/components/Toolbar.tsx` — remove `selectedCount` prop and "X of Y selected" text

---

## Task 1: Remove selection from mobile useLibraryState

**Files:**
- Modify: `apps/mobile/src/hooks/use-library-state.ts`

- [ ] **Step 1: Remove selection state, methods, and computed values**

Remove from the hook:
- `const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());` (line 52)
- The `selectPhoto` callback (lines 82-102)
- The `selectAll` callback (lines 104-106)
- The `clearSelection` callback (lines 108-111)
- All `setSelectedPhotos(...)` calls inside `navigatePhoto` (line 131) and `openInLoupe` (line 151)
- Remove `selectedPhotos` from the `LibraryState` interface (line 13)
- Remove from return object: `selectedPhotos`, `selectPhoto`, `selectAll`, `clearSelection`, `selectedCount`, `hasSelection`

After edits, the return object should be:

```ts
return {
	isLoaded,
	viewMode,
	setViewMode,
	activePhoto,
	activePhotoIndex,
	setActivePhoto,
	navigatePhoto,
	navigateToIndex,
	openInLoupe,
	closeLoupe,
	hasPrev,
	hasNext,
	totalPhotos: photos.length,
};
```

- [ ] **Step 2: Run mobile tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Some tests may fail due to references to removed APIs — that's expected and will be fixed in Task 2.

- [ ] **Step 3: Commit**

```bash
cd /root/photobrain && git add apps/mobile/src/hooks/use-library-state.ts
git commit -m "refactor(mobile): remove selection state from useLibraryState"
```

---

## Task 2: Remove selection UI from mobile DashboardScreen

**Files:**
- Modify: `apps/mobile/src/screens/DashboardScreen.tsx`
- Modify: `apps/mobile/__tests__/DashboardScreen.test.tsx`

- [ ] **Step 1: Remove selection code from DashboardScreen**

Remove:
- `handlePhotoLongPress` callback (~line 170-176) and its usage in the photo grid `onLongPress` prop
- The date-header select circle button (the `<Pressable>` inside `date-header` rendering with `styles.selectCircle` and `<Ionicons name="checkmark" ...>`)
- The selection overlay on grid items (the `isSelected` check and the `<View style={styles.selectionOverlay}>` + `<View style={styles.checkmark}>` blocks inside photo rendering)
- Related styles from `StyleSheet.create`: `selectCircle`, `selectionOverlay`, `checkmark`
- Any references to `library.selectedPhotos`, `library.selectPhoto`

- [ ] **Step 2: Remove the long-press haptic test**

In `apps/mobile/__tests__/DashboardScreen.test.tsx`, delete the test:
```
it("triggers haptic feedback on long press", ...
```

Also remove or update any test that references `library.selectPhoto` or `library.selectedPhotos`.

- [ ] **Step 3: Run mobile tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /root/photobrain && git add apps/mobile/src/screens/DashboardScreen.tsx apps/mobile/__tests__/DashboardScreen.test.tsx
git commit -m "refactor(mobile): remove selection UI from DashboardScreen"
```

---

## Task 3: Remove selection from web useLibraryState

**Files:**
- Modify: `apps/web/src/hooks/use-library-state.ts`

- [ ] **Step 1: Remove selection state, methods, and computed values**

Remove:
- `selectedPhotos` from `LibraryState` interface (line 12)
- `lastSelectedIndex` from `LibraryState` interface (line 15)
- `const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());` (line 57)
- `const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);` (lines 62-64)
- The entire `selectPhoto` callback (lines 76-110)
- The `selectAll` callback (lines 112-114)
- The `clearSelection` callback (lines 116-120)
- `setSelectedPhotos(new Set([newPhoto.id]));` and `setLastSelectedIndex(newIndex);` inside `navigatePhoto` (lines 136-137)
- `setSelectedPhotos(new Set([photo.id]));` inside `openInLoupe` (line 145)
- The `selectedPhotos` reference in the loupe-entry `useEffect` (line 154) — change to just `setActivePhoto(photos[0])` since there's no selection to check
- Remove from return object: `selectedPhotos`, `selectPhoto`, `selectAll`, `clearSelection`, `selectedCount`, `hasSelection`

After edits, the return object should be:

```ts
return {
	viewMode,
	setViewMode,
	thumbnailSize,
	setThumbnailSize,
	activePhoto,
	setActivePhoto,
	navigatePhoto,
	openInLoupe,
};
```

- [ ] **Step 2: Commit**

```bash
cd /root/photobrain && git add apps/web/src/hooks/use-library-state.ts
git commit -m "refactor(web): remove selection state from useLibraryState"
```

---

## Task 4: Remove selection from web keyboard shortcuts

**Files:**
- Modify: `apps/web/src/hooks/use-keyboard-shortcuts.ts`

- [ ] **Step 1: Remove selectAll and clearSelection**

Remove from interface `KeyboardShortcutsOptions`:
- `clearSelection: () => void;` (line 10)
- `selectAll: () => void;` (line 11)

Remove from function params destructure:
- `clearSelection,` (line 22)
- `selectAll,` (line 23)

Remove from the switch statement:
- The `case "escape":` block's `clearSelection()` call (line 92) — but KEEP the escape handler for returning to grid from loupe. Change to:
```ts
case "escape":
	if (viewMode === "loupe") {
		e.preventDefault();
		setViewMode("grid");
	}
	break;
```

- Remove the entire `case "a":` block (lines 96-101) for Cmd+A

Remove from useEffect dependency array:
- `clearSelection,` (line 114)
- `selectAll,` (line 115)

- [ ] **Step 2: Commit**

```bash
cd /root/photobrain && git add apps/web/src/hooks/use-keyboard-shortcuts.ts
git commit -m "refactor(web): remove selection keyboard shortcuts (Cmd+A, Escape-clear)"
```

---

## Task 5: Remove selection from web Dashboard and components

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/components/PhotoGrid.tsx`
- Modify: `apps/web/src/components/Filmstrip.tsx`
- Modify: `apps/web/src/components/Toolbar.tsx`

- [ ] **Step 1: Update Dashboard.tsx**

Remove:
- `clearSelection: library.clearSelection,` and `selectAll: library.selectAll,` from `useKeyboardShortcuts` call
- The `handlePhotoClick` callback that passes `shift`/`ctrl` modifiers to `selectPhoto` — replace with a simple callback that sets activePhoto:
```ts
const handlePhotoClick = useCallback(
	(photo: PhotoMetadata) => {
		library.setActivePhoto(photo);
	},
	[library.setActivePhoto],
);
```
- Remove `selectedPhotos={library.selectedPhotos}` from `<PhotoGrid>` props
- Remove `selectedCount={library.selectedCount}` from `<Toolbar>` props
- Remove `selectedPhotos={library.selectedPhotos}` from `<Filmstrip>` props

Note: `handlePhotoClick` signature changes from `(photo, event)` to `(photo)` since we no longer need the mouse event for modifier keys.

- [ ] **Step 2: Update PhotoGrid.tsx**

Remove:
- `selectedPhotos?: Set<number>;` from `PhotoGridProps` interface
- `selectedPhotos = new Set(),` from destructure
- `const isSelected = selectedPhotos.has(photo.id);` (line 68)
- All `isSelected` references in className: `isSelected && "ring-2 ring-selection"` and `isSelected && "bg-selection/10"` and the `!isSelected` guard
- Simplify the className to just use `isActive`:
```ts
className={cn(
	"group relative aspect-square cursor-pointer overflow-hidden bg-muted",
	"transition-all duration-75",
	"ring-inset",
	isActive && "ring-2 ring-selection brightness-110",
	!isActive && "hover:ring-1 hover:ring-thumbnail-border",
)}
```
- Update `handleClick` signature: `(photo: PhotoMetadata, event: React.MouseEvent)` → `(photo: PhotoMetadata)` since event is no longer needed. Update the `onPhotoClick` prop type to match: `onPhotoClick?: (photo: PhotoMetadata) => void;`
- Update `onClick` in JSX from `onClick={(e) => handleClick(photo, e)}` to `onClick={() => handleClick(photo)}`

- [ ] **Step 3: Update Filmstrip.tsx**

Remove:
- `selectedPhotos?: Set<number>;` from `FilmstripProps` interface
- `selectedPhotos = new Set(),` from destructure
- `const isSelected = selectedPhotos.has(photo.id);` (line 66)
- All `isSelected` references in className: `isSelected && !isActive && "ring-1 ring-selection/70"` and the `!isSelected` guard in the opacity class

Simplified className:
```ts
className={cn(
	"relative flex-shrink-0 overflow-hidden",
	"h-full aspect-[3/2]",
	"transition-all duration-75",
	"ring-inset focus:outline-none",
	isActive && "ring-2 ring-selection brightness-110",
	!isActive && "opacity-70 hover:opacity-100 hover:ring-1 hover:ring-thumbnail-border",
)}
```

- [ ] **Step 4: Update Toolbar.tsx**

Remove:
- `selectedCount?: number;` from `ToolbarProps` interface
- `selectedCount = 0,` from destructure
- The conditional rendering block (lines 189-193):
```tsx
{selectedCount > 0 ? (
	<span>{selectedCount} of {photoCount} selected</span>
) : (
	<span>{photoCount} photos</span>
)}
```
Replace with just:
```tsx
<span>{photoCount} photos</span>
```

- [ ] **Step 5: Commit**

```bash
cd /root/photobrain && git add apps/web/src/pages/Dashboard.tsx apps/web/src/components/PhotoGrid.tsx apps/web/src/components/Filmstrip.tsx apps/web/src/components/Toolbar.tsx
git commit -m "refactor(web): remove selection UI from Dashboard and components"
```

---

## Task 6: Delete selection E2E test, update remaining tests

**Files:**
- Delete: `apps/web/e2e/selection.spec.ts`
- Modify: `apps/web/e2e/metadata.spec.ts` (if it references selection)
- Modify: `apps/web/e2e/loupe.spec.ts` (if click behavior changed)

- [ ] **Step 1: Delete selection.spec.ts**

```bash
cd /root/photobrain && rm apps/web/e2e/selection.spec.ts
```

- [ ] **Step 2: Update any remaining specs that rely on click-to-select**

Check `metadata.spec.ts` — it clicks a photo to select it before checking the metadata panel. After the removal, single click still sets `activePhoto` (via `handlePhotoClick` → `setActivePhoto`), so the metadata panel should still populate. No change needed IF the `onPhotoClick` prop still fires on click.

Check `loupe.spec.ts` — it uses click, then E key to open loupe. Click now calls `setActivePhoto` instead of `selectPhoto`, which also sets `activePhoto`. The E key shortcut checks `hasActivePhoto` — which now comes from `activePhoto !== null`. This should still work.

Run web E2E to verify:
```bash
cd /root/photobrain/apps/web && bunx playwright test --reporter=line
```

Expected: all tests pass EXCEPT `selection.spec.ts` (which is deleted, so fewer total). Should be 18 tests (23 minus 5 selection tests).

- [ ] **Step 3: Commit**

```bash
cd /root/photobrain && git add -A apps/web/e2e/
git commit -m "test(web): delete selection E2E tests, verify remaining tests pass"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run mobile tests**

Run: `cd /root/photobrain/apps/mobile && bun run test`

Expected: all tests pass (minus the deleted long-press test).

- [ ] **Step 2: Run web E2E tests**

Run: `cd /root/photobrain/apps/web && bunx playwright test --reporter=line`

Expected: 18 tests pass (no selection tests).

- [ ] **Step 3: Run biome check**

Run: `cd /root/photobrain && bun run check`

Expected: no lint errors from unused imports or variables left behind.

- [ ] **Step 4: Push and publish OTA**

```bash
cd /root/photobrain && git push origin main
cd apps/mobile && EXPO_PUBLIC_API_URL=https://photobrain-api.ericj5.com bunx eas-cli update --branch preview --message "Remove selection @ $(git rev-parse --short HEAD)" --non-interactive
```
