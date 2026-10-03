# Native Migration Inventory

## Scope and evidence labels

This inventory separates repository facts from external release facts. It covers the Expo/React Native iOS predecessor, the native Swift feasibility project, Android boundaries, persisted state, caches, identity, permissions, privacy, and version/build ownership.

Labels used below:

- **Observed**: present in the repository or supplied workstation inventory.
- **Target**: an approved migration contract, not evidence that Apple/EAS is configured.
- **Unverified external**: requires a device, signed artifact, server deployment, EAS, or App Store Connect observation.
- **Disposable**: safe to recreate rather than migrate.
- **Bridge**: migrate or deliberately read the predecessor value.
- **Preserve**: keep behavior/identity through the cutover.
- **Remove later**: retain during rollback, then remove in the iOS-only cleanup.

Inventory date: 2026-09-20.

## Platform and repository boundaries

| Item | Classification | Evidence/disposition |
| --- | --- | --- |
| Native Swift application | Implemented source; runtime evidence pending | `apps/ios`, deployment target iOS 17.0; shared `PhotoBrain-Debug`, `PhotoBrain-Preview`, and `PhotoBrain-Production` schemes plus SwiftUI/API/migration source and tests. No physical/signing/TestFlight/performance result is inferred. |
| Expo/React Native application | Preserve for Android; remove iOS portions later | `apps/mobile` remains the Android application and the rollback source for Expo iOS until the rollback window closes. Its current Expo build-properties config and generated iOS app target use iOS 26.0; that does not alter the native target's iOS 17.0 contract. |
| Web application | Preserve | `apps/web`; outside the native iOS cleanup. |
| API and Inngest | Preserve with implemented v1 containment | `apps/api` mounts documented `/api/v1` routes for native reads/search/scans while `/api/inngest` and legacy tRPC remain. Native scan mutation configuration defaults false and returns `NATIVE_SCAN_DISABLED` before the start-scan service runs. Runtime deployment value/effect still needs external evidence. |
| Native Preview identity | Configured source; signing external | `com.photobrain.app.preview`. |
| Native Production identity | Configured source; signing external | `com.photobrain.app`. Same Production identifier is required for an in-place replacement of installed Expo iOS. |
| Native Debug identity | Configured source | `com.photobrain.app.debug`; local/development only. |
| Workstation Xcode | Observed environment inventory | Full Xcode 26.6 at `/Applications/Xcode.app`. This proves tool availability only, not signing or upload. |
| Installed simulator runtime | Observed environment inventory | iOS 26.5 simulators. Simulator behavior is not physical-device evidence. |
| Connected physical iPhone/iPad | Unverified external | No physical device was connected during groundwork. Every physical-device row in the verification document is therefore open. |

### Native implementation scope and evidence boundary

The committed Swift app is wired to the versioned `/api/v1` contract through `APIClient`: library/folder/filter/detail/search data, thumbnail/loupe presentation, settings/theme, durable scan recovery, scan actions, and error/retry states are implemented. Preview and Production build settings explicitly provide the non-local HTTPS API origin; Debug uses localhost. The deterministic 7,961-record in-memory fixture remains test/feasibility input and is not the app's production data source.

The native migration actor consumes the approved `{schemaVersion:1, theme, activeScanId}` envelope, persists native theme/active-scan state, and prevents a terminal migrated scan ID from being imported again. The Expo bridge validates the same exact shape and fails closed on malformed/unsupported data. The image loader keys decoded images by full URL and sets a 128 MiB `NSCache` total-cost limit; on a memory warning, the loupe evicts decoded cache/nonvisible surfaces, preserves the current ID, and reloads its visible pages. These are repository implementation facts, not executed simulator/device, network, performance, signing, or TestFlight evidence.

## State migration classification

### Values that need a bridge

| State | Expo source | Meaning | Native disposition |
| --- | --- | --- | --- |
| Theme preference | Legacy AsyncStorage key `@photobrain/theme`; bridge-envelope key `com.photobrain.migration.v1`; values `light`, `dark`, `system` | Expo reads/writes the exact approved `{schemaVersion:1, theme, activeScanId}` envelope through its iOS bridge, seeding it from legacy AsyncStorage only when absent. Native imports to `com.photobrain.native.theme`. | **Implemented source; runtime upgrade evidence pending.** Existing native value wins, then valid envelope value, else `system`. Production shares the predecessor container; Preview does not. Preserve the envelope through the rollback window. |
| Active scan recovery | Legacy AsyncStorage key `@photobrain/active-scan`; bridge field `activeScanId`; native key `com.photobrain.native.activeScanId` | Expo validates a UUID and updates the exact approved envelope. Native validates/imports it, queries the saved job and active-scan snapshot, polls durable state, and clears/marks the migrated ID consumed at terminal. | **Implemented source; runtime upgrade evidence pending.** Import never starts a replacement scan. A lost mutation response reconciles active scans before offering an explicit duplicate-risk action. Preview cannot read the Production container. |

The approved bridge contract is `{ schemaVersion: 1, theme, activeScanId }` encoded as data in standard `UserDefaults` key `com.photobrain.migration.v1`; the checked-in Expo module, TypeScript validator, Swift actor, and tests agree on this exact shape. Unknown/extra fields, malformed values, unsupported versions, invalid themes, and non-UUID scan IDs fail closed rather than being overwritten. No app-group entitlement is required for the intended in-place Production replacement because both binaries use `com.photobrain.app`.

Cutover prerequisite: users must run an Expo iOS build containing the reconciled approved `{schemaVersion:1, theme, activeScanId}` bridge before the native replacement if legacy theme/active-scan continuity is required. A direct upgrade from a pre-bridge Expo build leaves no shared envelope for native to import; native then safely defaults theme to `system` and discovers active server scans through `/api/v1/scans/active`, but that is fallback behavior rather than proof of legacy-value migration.

### State that intentionally resets

The following state is component memory in the active Expo routes and is not a durable user record:

- current tab/navigation stack and modal presentation;
- Library grouping (`years`, `months`, `all`) and sort (`captured`, `added`);
- EXIF/RAW filter sheet values, visibility, and subpage;
- grid scroll position, visible-date label, history-bar visibility, and column calculation;
- selection mode and selected photo IDs;
- active loupe item, zoom/pan state, chrome visibility, and filmstrip position;
- metadata sheet selection;
- Search query, debounce, results, keyboard state, and error UI;
- in-memory Realtime messages, retry state, and React component refs.

Classification: **Disposable/reset on first native launch**. Do not add persistence solely to imitate an implementation detail. Observable parity should be evaluated from a clean start and from the two bridged states above.

### Server-authoritative state

Photos, EXIF, thumbnails, embeddings, folders, filters, scan rows, and scan progress are server-owned. Classification: **Preserve by refetching**. The client must not copy these records into a migration store. An active scan bridge carries only the job identifier; durable progress is queried from the API.

## Cache inventory

| Cache | Current behavior | Migration decision |
| --- | --- | --- |
| Expo Image thumbnails/loupe | `cachePolicy="memory-disk"` throughout grid, filmstrip, loupe, metadata, and search | **Disposable.** Do not parse or move Expo Image cache files. Native cache keys must include the complete thumbnail URL/cache-busting token. |
| React Query/tRPC | A process-local `QueryClient`; job token query has infinite stale time for the current process | **Disposable.** Native launches refetch server-authoritative data. Do not serialize auth/realtime tokens. |
| Realtime token/message state | Held in hook/query memory | **Disposable and sensitive.** Never persist or place tokens in evidence. |
| Native decoded-image cache | `NSCache` keyed by complete requested URL, with decoded pixel cost and `totalCostLimit = 128 MiB`; on a memory warning, the loupe evicts decoded cache/nonvisible surfaces, preserves the current ID, and reloads visible pages | **Implemented; measurement pending.** Prove the limit and ≤2 s recovery on physical devices, including stable current-photo identity. |
| Native API/HTTP cache | Main API client uses a reusable session with revalidation; image loader uses ephemeral sessions and disables URL cache | **Disposable.** Respect server cache identity/ETags; do not treat cached bodies as durable library state. |
| Synthetic fixture output | Temporary directory, default `os.tmpdir()/photobrain-native-migration-baseline` | **Disposable evidence input.** It may be regenerated from its deterministic command and checksums. |

Cache continuity is not an acceptance criterion. A cold native launch is expected to refill caches, and cold/warm behavior has separate numeric gates.

## Schemes, URL handling, and navigation identity

### Xcode schemes

| Scheme | Configuration/use | Bundle identifier |
| --- | --- | --- |
| `PhotoBrain-Debug` | Local simulator/development | `com.photobrain.app.debug` |
| `PhotoBrain-Preview` | Signed Preview/TestFlight proving lane | `com.photobrain.app.preview` |
| `PhotoBrain-Production` | Signed Production/TestFlight/App Store | `com.photobrain.app` |

The repository schemes are build selections, not proof that matching App IDs, App Store records, profiles, or TestFlight groups exist.

### URL declarations and disposition

The generated Expo iOS `Info.plist` currently declares:

- `photobrain`;
- `com.photobrain.app`;
- `exp+photobrain`;
- an Expo router `NSUserActivityTypes` value based on the product bundle identifier.

`app.json` declares `scheme: "photobrain"`. Source inspection alone does not show a user-facing deep-link contract beyond Expo Router's registration.

Native Swift declarations:

- Production registers `photobrain`;
- Preview registers `photobrain-preview`;
- Debug registers `photobrain-debug`;
- the URL name is the lane's product bundle identifier;
- no associated-domains entitlement or universal-link domain is established.

The predecessor Expo binary also declares `com.photobrain.app` and `exp+photobrain` URL schemes plus an Expo router activity type. Preserve/test `photobrain` for Production and the collision-free native Preview/Debug schemes. Do not copy `com.photobrain.app` or `exp+photobrain` into native URL schemes; they remain predecessor/development concerns removable only after rollback closure.

## Entitlements and capabilities

The generated Expo iOS repository entitlement file contains an empty dictionary. No repository entitlement currently establishes iCloud, push notifications, Sign in with Apple, associated domains, keychain groups, app groups, HealthKit, HomeKit, background modes, or Photos access.

The native project sets automatic signing but does not commit a development team or an entitlement file. Its approved version-1 state bridge uses the same Production app container and standard `UserDefaults`, not an app group. This supports unsigned simulator work but is not distribution-signing evidence.

Classification:

- Native Debug/Preview/Production starts with the minimum entitlement set.
- Distribution signing will add identity-related entitlements; inspect the signed app rather than treating the source file as final.
- A future cross-bundle/app-group or keychain bridge would be a new design/signing change; the implemented same-bundle version-1 bridge needs neither.
- `get-task-allow` must be absent or false in Preview/Production distributed artifacts.
- Apple team ID, application-identifier prefix, certificate, provisioning profile name/UUID/expiry, and App Store capabilities are **Unverified external**.

## Permissions and transport declarations

The active client is a server-backed gallery; it does not import from the device Photos library and the dependency/config inventory does not request Camera, Photos, Location, Contacts, Microphone, or Notifications permission.

The generated Expo iOS `Info.plist` includes:

- local networking allowed under App Transport Security;
- `_expo._tcp` Bonjour service;
- a local-network usage description for Expo Dev Launcher;
- arbitrary loads disabled.

The native `Info.plist` registers the lane-specific custom URL scheme, API origin/environment, arm64, iPhone/iPad orientations, arbitrary-loads false, and local networking allowed. It has no protected-resource usage descriptions or Bonjour services. `AppEnvironment` permits HTTP/local hosts only for Debug and requires a credential-free, pathless, non-local HTTPS origin for Preview/Production. Inspect the signed plist; source settings do not prove the exported artifact.

Disposition:

- Do not add a permission usage description unless shipped native behavior actually invokes the protected API.
- Remove predecessor Expo Dev Launcher Bonjour/local-network declarations during iOS-only cleanup. Separately review native `NSAllowsLocalNetworking`; Preview/Production runtime rejects local API origins, so retain that ATS allowance in distributed configs only with a documented need.
- Keep HTTPS as the production API transport. Any exception domain or cleartext allowance requires explicit security review.
- Simulator permission behavior does not prove physical-device prompts or App Review declarations.

## Privacy inventory

The generated Expo privacy manifest currently declares these required-reason API categories:

- User Defaults, reason `CA92.1`;
- File Timestamp, reason `C617.1`;
- System Boot Time, reason `35F9.1`;
- empty collected-data types;
- tracking false.

These entries reflect the generated Expo/native dependency bundle. They are not automatically the correct manifest for the Swift app, and they do not prove App Store Connect privacy answers.

The native project contains and embeds a first-party privacy manifest declaring User Defaults reason `CA92.1`, no tracking domains, no collected-data types, and tracking false. This matches the implemented migration/theme persistence at source level; the archived app and every embedded framework still need a merged-manifest audit, and the manifest does not prove App Store Connect answers.

Native disposition:

1. Inventory first-party and embedded-framework required-reason API use from the archived binary.
2. Declare only applicable reasons and reconcile merged privacy manifests.
3. Verify that analytics, crash reporting, network logs, and image metadata behavior match App Store privacy answers.
4. Treat App Store Connect privacy labels, export-compliance answers, and tracking declarations as **Unverified external** until recorded from the actual app record.
5. Never infer “no data collected” merely from an empty source manifest; the app communicates with a self-hosted API and may display EXIF/GPS fields supplied by it.

## Identity and environment inventory

| Field | Repository value | Status/disposition |
| --- | --- | --- |
| Expo display name/slug | `PhotoBrain` / `photobrain` | Observed; display-name parity target. |
| Expo EAS project ID | `5fcc4958-f697-46c6-9cfc-cd2ce0ac695c` | Observed public project identity; retained for Android. It does not identify the native Apple app record. |
| Expo Production iOS bundle ID | `com.photobrain.app` | Preserve for native Production and emergency replacement. |
| Android package | `com.photobrain.app` | Preserve; Android remains Expo/React Native. |
| Native Preview bundle ID | `com.photobrain.app.preview` | Target; Apple registration/signing unverified. |
| Native Debug bundle ID | `com.photobrain.app.debug` | Target; development registration/signing unverified. |
| API environment | Expo EAS profiles and native Preview/Production configs point at `https://photobrain-api.ericj5.com`; native Debug points at `http://localhost:3000` | Native runtime rejects credentials/path/query in the origin and rejects local/non-HTTPS Preview/Production origins. Inspect the final artifact and deployed reachability; do not ship server keys. |
| Authentication/authorization | Current project guide states all API/file routes are unauthenticated | Security inventory, not release approval. ACL/network-boundary evidence is required before broader distribution. |
| Server keys | None should be shipped in public client variables | Preserve. `EXPO_PUBLIC_*` and native app configuration are public. |

## Release-lane inventory

| Lane | Observed repository behavior | Evidence/disposition |
| --- | --- | --- |
| Android preview/production | `.github/workflows/build.yml` job `eas-android-release` is the sole automated Android publisher. It builds `android-preview` from `main` or `android-production` from a `v*` tag; each publication runs inside the matching `eas env:exec`, compares every profile `env` value to the effective EAS environment, then calls `eas update --platform android`. | Implemented guard; retain run evidence and preserve one publisher. Never reintroduce an unqualified update. |
| Native iOS CI | `.github/workflows/native-ios.yml`, static `native-ios-ci` concurrency, exact Xcode 26.6, and unsigned `PhotoBrain-Preview` simulator test on iPhone 17 Pro/iOS 26.5. | Simulator build/test evidence only; not a signed distribution lane. |
| Native iOS Production release | `.github/workflows/native-ios-release.yml`, manual dispatch, shared `ios-production-release` concurrency, App Store Connect allocation, manual signing, Production archive/export, strict nine-argument inspection, 30-day archive/dSYM/IPA retention, and `altool` TestFlight upload. | **Implemented, not executed/proven.** Required inputs/secrets and Apple state remain external until a run succeeds. This lane is Production-only. |
| Expo iOS internal emergency check | `.github/workflows/eas-preview-build.yml`, manual dispatch, shared static `ios-production-release` concurrency, forced EAS `preview` internal build. | Build-only/ad hoc continuity check; not a Production/TestFlight replacement and not an iOS/Android publisher. Its source workflow has not established credentials, signing, installation, or device evidence. |
| Expo iOS Production emergency replacement | `.github/workflows/expo-ios-emergency-production.yml`, confirmed manual dispatch, shared `ios-production-release` concurrency, the same App Store allocator/signing identity, frozen local Production prebuild/archive/export, strict twelve-argument Expo inspection, 90-day archive/dSYM/IPA/evidence retention, and `altool` TestFlight upload. | **Implemented, not executed/proven.** It builds a higher Production binary, never an OTA; credentials, Apple acceptance, and physical replacement remain external. |
| App Store allocator | `apps/ios/scripts/allocate-app-store-build.mjs` queries every App Store Connect build for `ASC_APP_ID`; both Production workflows derive a durable floor as `github.run_id * 100 + github.run_attempt` and choose at least `max(remote)+1`. Shared concurrency serializes repository runs. | Implemented defense against cross-workflow/retry reuse and App Store lag; an actual allocation/upload remains unverified. Uploads outside these workflows still must be reconciled. |
| Native Production inspector | `apps/ios/scripts/inspect-signed-artifact.sh` accepts nine arguments: artifact, bundle/application/team IDs, URL scheme, exact API URL, marketing version, build, and minimum iOS version. It validates Production identity/configuration, signature/profile, entitlements, ATS, privacy, and absence of Expo Updates. | **Implemented, Production-only, not artifact-proven.** Both expected and observed minimum iOS versions must be 17.0. |
| Expo Production inspector | `apps/mobile/scripts/inspect-expo-signed-artifact.sh` accepts the native nine values plus expected Expo Updates URL, fingerprint runtime, and channel. It validates the signed Production app, embedded JS/API URL, expected Expo runtime/configuration, profile/privacy/ATS, and minimum iOS 17.0. | **Implemented, not artifact-proven.** Run only through the confirmed Production fallback lane or equivalent controlled evidence flow. |

`apps/mobile/eas.json` still has explicit Android profiles and generic Expo iOS profiles, but the emergency Production workflow does not rely on an EAS cloud build: it resolves the Production EAS environment, performs a frozen local prebuild, manually signs/exports, inspects, retains, and uploads the IPA. Android Preview/Production keep their profile/effective-environment equality guards before Android-only publication.

## Version and build-number inventory

Repository defaults are not Apple release truth; the two manual Production workflows require an explicit common marketing version and override/inspect the final artifact:

| Source | Observed value | Meaning |
| --- | --- | --- |
| `apps/mobile/app.json` | app version `0.2.0` | Expo source default only; the emergency workflow overrides it with the required Production marketing-version input. |
| `apps/mobile/package.json` | package version `0.1.0` | Workspace package metadata; not an Apple version/build. |
| Generated Expo project defaults | potentially stale plist/project values | Regenerated by the emergency workflow and overridden/inspected; never allocation evidence. |
| `apps/mobile/eas.json` | `appVersionSource: remote`; Production auto-increment | Still relevant to other EAS operations, but the checked-in emergency Production workflow uses the shared App Store allocator and local signed archive, not EAS remote build numbering. |
| Native project defaults | marketing version `1.0.0`, current project version `1` | Source defaults only; the Production workflow overrides both from dispatch/allocation. |
| Manual Production workflow input | canonical two- or three-component dotted version | Must be the common marketing-version lineage for native and any emergency Expo replacement of that release. |
| App Store Connect plus durable run floor | current remote maximum and `github.run_id * 100 + github.run_attempt` | The allocator chooses `max(remote + 1, durable floor)` under shared Production concurrency. |
| App Store Connect observed result | unknown until a real run | **Unverified external.** Workflow implementation is not an accepted upload. |

Rules:

- `CFBundleVersion` must increase for every `com.photobrain.app` upload. Both Production workflows use the shared allocator; never supply or reuse an ad hoc build.
- A Production Expo emergency replacement must use the same marketing-version lineage requested for the native release being replaced and receives a newly allocated build strictly above observed/reserved prior builds.
- Marketing version is an explicit manual dispatch input; do not derive it from `package.json`, `app.json`, or generated project defaults.
- `com.photobrain.app.preview` remains a separate identity. The implemented workflow archive/upload and strict inspectors described here are Production-only.

## V1 containment inventory

`V1_NATIVE_SCAN_MUTATIONS_ENABLED` contains the new native mutation surface:

| Flag state | Required behavior |
| --- | --- |
| false (release default) | Native scan mutation returns HTTP 503 with code `NATIVE_SCAN_DISABLED` before scan-row creation or event publication. |
| true | Mutation may proceed only after separately approved ACL, side-effect, rollback, and physical-device evidence. |

The flag is parsed in `apps/api/src/config.ts` with default false and passed into the `/api/v1` router. `POST /api/v1/scans` checks it before parsing or calling the start-scan service and returns HTTP 503 code `NATIVE_SCAN_DISABLED` when false. Reads, image routes, `/api/inngest`, and legacy tRPC remain outside that guard. This is implemented source behavior; deployment value, ACL, observed response, row delta, and event delta remain **Unverified external** until exercised in the release environment.

## Privacy-safe baseline fixtures

Generate baseline inputs with:

```bash
cd apps/mobile
bun run native-migration:baseline
# Optional destination:
bun run native-migration:baseline /absolute/path/to/output
# Validate already-generated artifacts without replacing them:
bun run native-migration:baseline --validate /absolute/path/to/output
```

Default output is Node's `os.tmpdir()/photobrain-native-migration-baseline` and contains:

- `photo-metadata.json`: exactly 7,961 deterministic synthetic/redacted photo records;
- `format-manifest.json`: 80 synthetic entries—12 each for ARW, RAF, DNG, HEIC, JPG, and JPEG, plus 8 PNG—with exactly 3 DNG entries marked as expected failures;
- printed SHA-256 values for both JSON files.

The native Swift feasibility project separately generates exactly 7,961 in-memory `PhotoRecord` values with integer IDs 1…7,961, synthetic filenames/camera/lens strings, reserved `photos.example.invalid` thumbnail URLs, and no filesystem-path or GPS/location field. Record which fixture source a result used; do not merge the CLI JSON and native in-memory generator into one untraceable data set.

Null/status/date fallback summaries produced from these records are **synthetic coverage**, not production measurements. The baseline parity contract has no measurement claim (`measurementClaim: null`) until it is run and evidence is recorded.

Fixture rules for every native, Expo, performance, screenshot, and CI artifact:

1. Use deterministic generated pixels/metadata or content with explicit redistribution approval.
2. Do not include personal photos, real camera filenames, absolute user paths, GPS coordinates, faces, names, email addresses, device IDs, account IDs, tokens, cookies, private hostnames, or production response bodies.
3. Use stable fake IDs and UTC timestamps. Preserve edge-case shapes—null dates, format/status variants, expected failures—without copying real records.
4. Strip EXIF/GPS from visual fixtures unless the case tests synthetic EXIF; synthetic GPS must be unmistakably fictional and never copied from a real library.
5. Keep credentials out of commands, logs, screenshots, Instruments traces, and exported archives.
6. Record generator version/commit, command, counts, checksum, and cleanup location.
7. Delete temporary fixture output and simulator/device test data after evidence retention requirements are met.
8. If a production-only failure needs reproduction, create a minimal redacted synthetic reproduction. Do not attach the original media to repository or CI artifacts.

## Open external evidence

The following facts are intentionally not claimed:

- physical iPhone or iPad install/behavior;
- real-device iOS 17 compatibility;
- successful native Production release-workflow dispatch, allocation, signed archive/inspection, artifact retention, and TestFlight upload;
- successful Expo emergency Production dispatch, higher allocation in the same marketing lineage, signed archive/inspection, 90-day evidence retention, and TestFlight upload;
- bridge-capable Expo predecessor rollout plus same-container predecessor/native round trip;
- Apple Developer team, App IDs, distribution certificate/profile, App Store Connect API secrets/app ID, EAS token, capabilities, or signing success;
- Preview and Production App Store Connect records or TestFlight groups;
- TestFlight processing, install, review, or App Store distribution;
- signed Production native inspector proof that no Expo Updates runtime/configuration remains and signed Expo inspector proof of the expected fingerprint runtime/channel;
- Expo→native, native→higher-native, and native→higher-Expo physical replacement drills;
- current App Store build maximum or observed allocator result;
- production value or enforcement of `V1_NATIVE_SCAN_MUTATIONS_ENABLED`;
- production network ACL denial from an unauthorized client;
- production response size/latency, decode, frame, image, memory, or stability gates;
- current Expo p50/p95 and native ≤1.10× relative gates for every comparable timing cell;
- named Android ownership and independent Android release/feature smoke;
- retained `apps/web` smoke and optional manual `apps/mobile` Expo-web build smoke;
- App Store privacy/export-compliance/age-rating answers;
- correct custom/universal-link dispatch on device;
- safe cleanup of Expo iOS until the rollback-window exit criteria are met.

Use `docs/native-migration-verification.md` to close these rows. Absence of evidence remains `UNVERIFIED`, never “pass by inspection.”
