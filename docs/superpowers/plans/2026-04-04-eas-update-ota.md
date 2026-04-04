# EAS Update OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable over-the-air JavaScript updates for the PhotoBrain iOS app via EAS Update, with a native prompt for users to restart when an update is available.

**Architecture:** Install `expo-updates`, configure `app.json` and `eas.json` for update channels, add a `useOTAUpdates` hook that checks for updates on launch and shows a native Alert, call the hook from the root `App` component.

**Tech Stack:** expo-updates, EAS Update, React Native Alert API

**Spec:** `docs/superpowers/specs/2026-04-04-eas-update-ota-design.md`

---

### Task 1: Install `expo-updates` dependency

**Files:**
- Modify: `apps/mobile/package.json`

- [ ] **Step 1: Install expo-updates**

Run from the mobile app directory:

```bash
cd apps/mobile && npx expo install expo-updates
```

This uses `expo install` to pick the SDK-compatible version for Expo 54.

- [ ] **Step 2: Verify installation**

```bash
grep "expo-updates" apps/mobile/package.json
```

Expected: A line showing `"expo-updates"` in dependencies.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/package.json ../../bun.lock
git commit -m "feat(mobile): install expo-updates dependency"
```

---

### Task 2: Configure `app.json` for OTA updates

**Files:**
- Modify: `apps/mobile/app.json`

- [ ] **Step 1: Add `updates` and `runtimeVersion` config**

Add these two keys to the `expo` object in `apps/mobile/app.json`:

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

Add `"expo-updates"` to the `plugins` array (alongside existing `"expo-router"`):

```json
"plugins": [
  "expo-router",
  "expo-updates"
]
```

- [ ] **Step 2: Verify JSON is valid**

```bash
cat apps/mobile/app.json | python3 -m json.tool > /dev/null && echo "Valid JSON"
```

Expected: `Valid JSON`

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app.json
git commit -m "feat(mobile): configure app.json for EAS Update OTA"
```

---

### Task 3: Add update channels to `eas.json`

**Files:**
- Modify: `apps/mobile/eas.json`

- [ ] **Step 1: Add `channel` to each build profile**

Add a `"channel"` field to each profile in `eas.json`. The full `build` section should look like:

```json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "channel": "development",
      "env": {
        "EXPO_PUBLIC_API_URL": "https://photobrain-api.ericj5.com"
      },
      "ios": {
        "simulator": false
      }
    },
    "development-simulator": {
      "developmentClient": true,
      "distribution": "internal",
      "channel": "development",
      "env": {
        "EXPO_PUBLIC_API_URL": "https://photobrain-api.ericj5.com"
      },
      "ios": {
        "simulator": true
      }
    },
    "preview": {
      "distribution": "internal",
      "channel": "preview",
      "env": {
        "EXPO_PUBLIC_API_URL": "https://photobrain-api.ericj5.com"
      },
      "ios": {
        "resourceClass": "m-medium"
      }
    },
    "production": {
      "autoIncrement": true,
      "channel": "production",
      "env": {
        "EXPO_PUBLIC_API_URL": "https://photobrain-api.ericj5.com"
      },
      "ios": {
        "resourceClass": "m-medium"
      }
    }
  }
}
```

Note: `development` and `development-simulator` share the `"development"` channel since they target the same dev audience.

- [ ] **Step 2: Verify JSON is valid**

```bash
cat apps/mobile/eas.json | python3 -m json.tool > /dev/null && echo "Valid JSON"
```

Expected: `Valid JSON`

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/eas.json
git commit -m "feat(mobile): add update channels to all EAS build profiles"
```

---

### Task 4: Create `useOTAUpdates` hook

**Files:**
- Create: `apps/mobile/src/hooks/use-ota-updates.ts`
- Modify: `apps/mobile/src/hooks/index.ts`

- [ ] **Step 1: Create the hook file**

Create `apps/mobile/src/hooks/use-ota-updates.ts` with this content:

```typescript
import { useEffect } from "react";
import { Alert, Platform } from "react-native";
import * as Updates from "expo-updates";

export function useOTAUpdates() {
	useEffect(() => {
		if (__DEV__) return;
		if (Platform.OS === "web") return;

		async function checkForUpdate() {
			try {
				const update = await Updates.checkForUpdateAsync();
				if (!update.isAvailable) return;

				const { isNew } = await Updates.fetchUpdateAsync();
				if (!isNew) return;

				Alert.alert(
					"Update Available",
					"A new version of PhotoBrain is ready. Restart now?",
					[
						{ text: "Later", style: "cancel" },
						{
							text: "Restart",
							onPress: () => Updates.reloadAsync(),
						},
					],
				);
			} catch {
				// Silently ignore — OTA should never crash the app
			}
		}

		checkForUpdate();
	}, []);
}
```

- [ ] **Step 2: Export from hooks index**

Add this line to `apps/mobile/src/hooks/index.ts`:

```typescript
export { useOTAUpdates } from "./use-ota-updates";
```

The full file should be:

```typescript
export { useLibraryState, type ViewMode } from "./use-library-state";
export { useJobProgress } from "./use-job-progress";
export { useOTAUpdates } from "./use-ota-updates";
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/hooks/use-ota-updates.ts apps/mobile/src/hooks/index.ts
git commit -m "feat(mobile): add useOTAUpdates hook for OTA update prompts"
```

---

### Task 5: Integrate hook into root App component

**Files:**
- Modify: `apps/mobile/App.tsx:71-83`

- [ ] **Step 1: Add the hook call to the `App` component**

In `apps/mobile/App.tsx`, add the import at the top:

```typescript
import { useOTAUpdates } from "@/hooks";
```

Then call the hook inside the `App()` function, before the return statement. The updated `App` function should be:

```typescript
export default function App() {
	useOTAUpdates();

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<trpc.Provider client={trpcClient} queryClient={queryClient}>
				<QueryClientProvider client={queryClient}>
					<ThemeProvider>
						<AppContent />
					</ThemeProvider>
				</QueryClientProvider>
			</trpc.Provider>
		</GestureHandlerRootView>
	);
}
```

- [ ] **Step 2: Verify the app still type-checks**

```bash
cd apps/mobile && npx tsc --noEmit 2>&1 | head -20
```

Note: The mobile app uses Metro for type checking so this may not have a tsconfig. If `tsc` fails, verify there are no red squiggles by checking the import resolves:

```bash
grep -r "useOTAUpdates" apps/mobile/src/
```

Expected: Two matches — the hook definition and the App.tsx import.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat(mobile): call useOTAUpdates from root App component"
```

---

### Task 6: Document OTA updates in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (after the "iOS App (EAS Build)" section, around line 509)

- [ ] **Step 1: Add OTA Updates documentation**

Insert a new subsection after the iOS App (EAS Build) section (after line 509, before "### Production Dependencies"). Add:

```markdown
### OTA Updates (EAS Update)
The mobile app supports over-the-air JavaScript updates via [EAS Update](https://docs.expo.dev/eas-update/introduction/).
- **Update check:** On every app launch, checks for available updates (non-blocking)
- **User prompt:** Native alert asks user to restart when an update is downloaded
- **Runtime version:** Tied to `version` in `app.json` via `appVersion` policy
- **Channels:** `development`, `preview`, `production` (maps to EAS build profiles)

```bash
# Push a JS-only update (no native rebuild needed)
cd apps/mobile && eas update --branch preview --message "Fix search bar"
cd apps/mobile && eas update --branch production --message "v0.1.1 hotfix"

# List published updates
cd apps/mobile && eas update:list
```

**When you need a native rebuild instead of OTA:**
- Adding/removing native dependencies
- Bumping Expo SDK version
- Changing `app.json` native config (bundle ID, permissions)
- Bumping `version` in `app.json` (creates new runtime version)
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add OTA update workflow to CLAUDE.md"
```

---

### Task 7: Format and verify

**Files:**
- All modified files

- [ ] **Step 1: Run Biome check**

```bash
bun run check
```

Fix any formatting issues that Biome reports.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

Expected: No errors (mobile typecheck echoes a message about Metro bundler).

- [ ] **Step 3: Final commit if formatting changed anything**

```bash
git diff --name-only
```

If any files were changed by Biome:

```bash
git add -A && git commit -m "style: format after EAS Update changes"
```
