# Native Migration Verification and Evidence Ledger

## Evidence rule

Use one of four statuses for every check:

- **PASS** — the exact artifact/scenario was exercised and its evidence is linked.
- **FAIL** — it was exercised and did not meet the stated contract.
- **BLOCKED** — it could not run; record the exact missing prerequisite.
- **UNVERIFIED** — it has not been exercised.

Source inspection, simulator success, a successful upload, and a TestFlight install prove different things. Never promote one into another. Every record must identify source commit, configuration/scheme, bundle identifier, marketing version, build number, environment, device/runtime, timestamp, operator, and raw artifact location.

The groundwork environment has Xcode 26.6 at `/Applications/Xcode.app` and iOS 26.5 simulator runtimes. No physical iPhone or iPad was connected. Accordingly, physical-device, signing, TestFlight, App Store, production-network, and on-device performance rows start **UNVERIFIED**.

## Evidence bundle layout

Keep evidence outside the repository unless an approved artifact store is configured. A useful layout is:

```text
native-migration-evidence/<release-id>/
  release-record.txt
  provenance/
  baseline/
  simulator/
  physical/iphone/
  physical/ipad/
  signing/preview/
  signing/production/
  acl/
  containment/
  performance/network/
  performance/model/
  performance/ui/
  performance/images/
  performance/memory/
  testflight/
  decisions/
```

Each directory should contain a short index pointing to raw logs, `.xcresult`, Instruments traces, screenshots/video, checksums, and the operator conclusion. Redact secrets and PII. Do not redact bundle IDs, versions, build numbers, performance values, status codes, entitlement names, or failure messages needed to evaluate the result.

## Provenance and privacy-safe fixture check

Before any parity/performance work:

```bash
cd apps/mobile
bun run native-migration:baseline
# or choose an evidence-local output directory
bun run native-migration:baseline /absolute/path/to/synthetic-fixtures
# Validate already-generated artifacts without replacing them:
bun run native-migration:baseline --validate /absolute/path/to/synthetic-fixtures
```

Record:

```text
Generator commit:
Command:
Output directory:
photo-metadata.json SHA-256 printed by generator:
format-manifest.json SHA-256 printed by generator:
photo-metadata.json count: expected 7,961
format-manifest.json count: expected 80
Photo metadata format counts: ARW 4,796, RAF 1,232, DNG 1,181, HEIC 454, JPG 277, JPEG 13, PNG 8
Format-manifest counts: ARW 12, RAF 12, DNG 12, HEIC 12, JPG 12, JPEG 12, PNG 8
Expected failures: exactly 3 DNG
Validation exit status:
Reviewer:
```

The generated metadata, format outcomes, null/status/date fallbacks, and checksums are synthetic test coverage. They are not a production-library sample or a measured Expo baseline. The parity artifact's `measurementClaim` remains null unless a separate, reproducible measurement actually populates it.

Reject an evidence bundle if it includes personal photos, real filenames/paths, real GPS, faces, names, email addresses, account/device identifiers, tokens, cookies, production payloads, private hostnames, or embedded credentials. Synthetic EXIF/GPS must be obviously fictional. Record cleanup of temporary files and device/simulator content.

## Repository and simulator feasibility

Select the full Xcode installation explicitly. The approved feasibility destination is iPhone 17 Pro on iOS 26.5:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -version
test "$(xcodebuild -version | sed -n '1p')" = "Xcode 26.6"
xcrun swift --version
xcrun simctl list devices available

xcodebuild \
  -project apps/ios/PhotoBrain.xcodeproj \
  -scheme PhotoBrain-Preview \
  -configuration Preview \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -resultBundlePath /absolute/path/to/simulator-build.xcresult \
  build
```

When the committed scheme includes the test target, exercise it with a distinct result bundle:

```bash
xcodebuild \
  -project apps/ios/PhotoBrain.xcodeproj \
  -scheme PhotoBrain-Preview \
  -configuration Preview \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  -resultBundlePath /absolute/path/to/simulator-tests.xcresult \
  CODE_SIGNING_ALLOWED=NO \
  test
```

Record rather than hide destination or signing errors. Simulator acceptance covers only:

- project/scheme/configuration resolution;
- iOS 17.0 deployment setting and Preview identity in resolved build settings;
- deterministic 7,961-record fixture loading;
- adaptive 5/6/7/8-column diffable grid behavior;
- date fallback/grouping and stable identity;
- format-manifest outcomes, including the 3 expected DNG failures;
- loupe paging/zoom, filmstrip anchoring, and cache eviction without identity drift;
- signpost availability and guarded redirect behavior;
- native XCTest contracts included in the feasibility project.

It does **not** prove device memory, touch latency, signing, TestFlight, local-network prompts, Production identity, or App Store behavior.

## Functional parity matrix

For each row capture predecessor expectation, native result, status, and artifact. Use privacy-safe fixtures.

| Area | Required observation |
| --- | --- |
| Cold launch | No blank theme flash; library reaches a stable loading/content/error state. |
| Theme bridge | Installed predecessor values `light`, `dark`, and `system` import correctly in the same Production container; invalid/missing values fall back to system. Preview does not claim Production-container migration. |
| Active-scan bridge | Existing nonterminal job resumes durable progress; completed/failed/missing job clears the marker; import never creates a new scan. |
| Other state reset | Selection, filters, search, loupe, scroll, and navigation reset safely without corrupting server state. |
| 7,961-item library | All stable IDs represented once; sorting/grouping/date fallback match the declared parity artifact. |
| Adaptive grid | 5/6/7/8-column states have no gaps, duplicates, unstable moves, or wrong selection. |
| Thumbnail identity | Cache-busting URL changes refresh only the affected photo; reused cells never show another photo. |
| RAW/HEIC/JPEG/PNG outcomes | Match the synthetic format manifest; the 3 expected DNG failures are surfaced as expected, not counted as success. |
| Loupe | Open selected ID, adjacent paging, pinch zoom/pan, filmstrip selection, close/reopen, and cache eviction preserve identity. |
| Metadata | Date fallback, null EXIF, RAW badge/status, and failure states are represented without leaking paths/GPS. |
| Network loss/recovery | Offline/timeout is bounded and visible; recovery does not duplicate items or trigger a mutation. |
| V1 mutation containment | With flag false, native mutation gets 503/`NATIVE_SCAN_DISABLED`; database scan rows and sent events do not change. |
| Legacy compatibility | Reads, image routes, `/api/inngest`, and legacy tRPC remain available while the new native mutation is disabled. |
| Accessibility | VoiceOver order/labels, Dynamic Type, contrast, Reduce Motion, and Reduce Transparency are observed on supported physical devices. |
| Orientation/device family | Supported iPhone and iPad orientations preserve current item and layout. |
| Background/foreground | Resume refreshes safely, does not repeat mutations, and preserves/clears active scan according to durable status. |
| Memory warning | Caches shed memory and UI recovers within the numeric gate without losing current identity. |

## Numeric performance gates

### Measurement protocol

All gates below are required; “looks fast” is not evidence.

1. Use an optimized Release/Preview-equivalent build with instrumentation signposts enabled but no debugger overhead unless the tool requires attachment.
2. Record device model, RAM class, OS, thermal state, power state, build, server revision, fixture checksum, network conditioning, and cache state.
3. Run **5 warmups followed by at least 30 measured runs** per scenario/device/cache/network class. Exclude a run only for a documented external interruption; retain the raw run.
4. Calculate percentiles from the measured runs, not warmups. Preserve raw values and the calculation command/tool version.
5. Mark work “off-main” only when trace/signpost/thread evidence shows it did not execute on the main thread.
6. Cold image tests clear the relevant app URL/image cache without resetting unrelated server data. Warm tests prefill through the same user-visible path.
7. Network time is request start through complete response body. Record DNS/TLS reuse policy and do not mix LAN and conditioned samples.
8. Memory is resident memory for the same scripted interaction. Compare native and Expo on the same device, data, network, and release configuration.
9. Run compact-iPhone and iPad memory cases separately. Simulator memory/frame results are diagnostic only.
10. Record the current Expo p50/p95 beside every comparable native timing gate. Native must meet the absolute cap **and** be no more than 10% worse than Expo p95. If Expo already misses an absolute cap, only a named, preapproved baseline exception may alter that cell; never silently relax the native gate.

### Gate table

| Domain | Gate |
| --- | --- |
| Full-list payload | DTO+EXIF response p95 **≤ 16 MiB on wire**; record both compressed and uncompressed sizes. |
| Full-list LAN transfer | p95 complete body **≤ 2.0 s**. |
| Full-list conditioned transfer | At **20 Mbps and 100 ms RTT**, p95 complete body **≤ 5.0 s**. |
| JSON decode | p95 **≤ 500 ms**; transient decoded-model allocation **≤ 64 MiB**; no decode blocks main for **≥ 16.7 ms**. |
| Sort/group | p95 **≤ 250 ms**, runs off-main, and no main-thread grouping/sorting/layout operation **> 16.7 ms**. |
| Snapshot build/apply | Initial full diffable snapshot p95 **≤ 200 ms** with continuous main-thread stall **≤ 50 ms**. |
| One-photo refresh | Generation/insert/reorder refresh p95 **≤ 100 ms**. |
| Scrolling/full refresh | Preserve ID anchor; p95 frame **≤ 16.7 ms**, p99 frame **≤ 33 ms**, and no stall/hitch **> 100 ms**. |
| Relative p95 | For every comparable timing cell, native p95 **≤ 1.10× Expo p95** as well as meeting the absolute cap. |
| Image concurrency | Initial grid has visible-cell requests plus at most **2× visible-cell count** adjacent prefetch; loupe has at most current plus two immediate-neighbor `large` requests in flight; never request originals. |
| Small-image decode | p95 **≤ 75 ms**. |
| First 25 grid cells | **≤ 1.5 s cold**, **≤ 0.5 s warm**. |
| Large-image decode | p95 **≤ 200 ms**. |
| Adjacent loupe availability | At least **95%** available within **1.5 s cold** and **0.5 s warm**. |
| Resident memory | **≤ 1.2×** the measured Expo baseline and absolute RSS **≤ 350 MiB** on compact iPhone, **≤ 500 MiB** on iPad. Both relative and absolute limits apply. |
| Decoded-image cache | **≤ 128 MiB**. |
| Transient models | **≤ 64 MiB**. |
| Memory-warning recovery | Cache/memory recovery completes **≤ 2 s** with usable UI and stable current-photo identity. |

### Performance evidence template

```text
Scenario/gate:
Source commit and build:
Bundle ID/version/build:
Device/OS/RAM class:
Server revision and endpoint:
Fixture checksum/count:
Network profile and tool:
Cache state definition:
Instrumentation/signpost names:
Warmups: 5 (required)
Measured runs: ____ (must be >=30)
Raw-data artifact:
Calculation tool/command:
p50/p95/p99/max:
Bytes/RSS/cache/transient allocation as applicable:
Main-thread stall/off-main evidence:
Expo comparison build and p50/p95 for this gate:
Native/Expo p95 ratio (must be <=1.10 unless named exception):
Result: PASS | FAIL | BLOCKED | UNVERIFIED
Reviewer/date:
```

A mean cannot substitute for p95/p99. A single screen recording cannot prove a timing or memory percentile.

## Required physical-device evidence

At minimum, use a supported physical iPhone and physical iPad installed from the actual TestFlight build. Include an iOS 17-class device/runtime in the compatibility matrix before setting the 17.0 deployment claim to PASS; testing only iOS 26.5/26.6 does not prove the minimum version.

```text
Evidence ID:
Device class: iPhone | iPad
Device model (no serial/UDID):
OS version:
Install source: TestFlight
TestFlight build link/ID:
Bundle ID:
Marketing version/build:
Source commit:
Server environment/revision:
Fixture/data-set checksum (no private data):
Network condition:
Start/end UTC:
Operator:

Scenarios exercised:
- clean install/cold launch:
- upgrade from installed Expo Production (Production only):
- theme bridge light/dark/system/invalid:
- active nonterminal/terminal/missing scan bridge:
- list/grid/group/sort/filter:
- loupe/zoom/filmstrip/metadata:
- offline/recovery/background/foreground:
- rotation/multitasking as supported:
- accessibility settings:
- memory warning/recovery:
- containment and legacy compatibility:
- crash/hang/UI corruption observations:

Screenshots/video/log/Instruments artifact IDs:
Failures/deviations:
Result: PASS | FAIL | BLOCKED | UNVERIFIED
Reviewer/date:
Test data cleanup completed:
```

Do not record serial numbers, UDIDs, Apple IDs, tester emails, personal notifications, or real photos.

## Required signing and artifact evidence

For native Production, retain the nine-argument `apps/ios/scripts/inspect-signed-artifact.sh` PASS output created by `native-ios-release.yml`. For an Expo emergency Production replacement, retain the twelve-argument `apps/mobile/scripts/inspect-expo-signed-artifact.sh` PASS output created by `expo-ios-emergency-production.yml`. Both inspectors require exact identity/API/marketing-version/build/minimum-iOS values; the Expo inspector also requires its update URL, fingerprint runtime, and channel. Both are Production-only: do not use either inspector as Preview evidence. Record Preview signing/artifact inspection separately against its own identity and external authority. Neither implemented workflow is evidence until its exact artifact/run succeeds.

```text
Evidence ID:
Workflow file/run ID/attempt:
Manual dispatch inputs/confirmation:
Required secret names validated (never values):
Production concurrency group:
Source commit:
Requested common marketing version:
Derived durable run-ID/attempt floor:
App Store maximum/allocation evidence:
Allocated build number:
Artifact type: native Production | Expo emergency Production
Artifact path/retained artifact URL/expiry:
IPA SHA-256:
Archive and dSYM artifacts:
dSYM UUID evidence:
Scheme/configuration:
Expected/observed bundle ID:
Expected/observed marketing version:
Allocated/observed build number:
Expected/observed MinimumOSVersion: 17.0
Expected/observed PhotoBrainAPIURL/environment/custom URL scheme:
Strict inspector script and complete arguments (redact no identity/config values):
Strict inspector PASS output:
Signature verify output artifact:
Signing authority:
TeamIdentifier/application-identifier:
get-task-allow (distributed expected absent or false):
Entitlements artifact/diff from approved set:
Provisioning profile name/UUID/expiration:
Privacy manifest and usage-description inventory:
Native only—Expo Updates framework/resources/config/symbols present: expected no
Expo only—expected/observed update URL, fingerprint runtime, and channel:
App Store Connect upload response/status/timestamp:
Unexpected findings:
Result: PASS | FAIL | BLOCKED | UNVERIFIED
Reviewer/date:
```

Do not commit the profile, certificate, private key, authentication key, or token. A source `.entitlements` file is not signed-artifact evidence.

## Required ACL and containment evidence

The current API contract has no application authentication/authorization middleware. If release safety depends on VPN, reverse proxy, firewall, device posture, or another network ACL, prove that exact boundary from both sides. A public unauthenticated 200 response is a hard Production block, not “self-hosted by convention” and not an approver-waivable exception.

Minimum matrix:

| Origin | Request | Expected |
| --- | --- | --- |
| Authorized TestFlight device/network | library read and one thumbnail | Success without embedding a server secret in the app. |
| Unauthorized off-boundary client | library/list query | Denied before photo metadata is returned. |
| Unauthorized off-boundary client | original and thumbnail routes | Denied before image bytes are returned. |
| Unauthorized off-boundary client | native scan mutation | Denied. |
| Authorized client, containment false | native scan mutation | HTTP 503 with `NATIVE_SCAN_DISABLED`, zero new scan rows, zero sent events. |
| Authorized legacy client, containment false | legacy reads/tRPC plus `/api/inngest` health/registration path as appropriate | Existing behavior preserved; do not expose signing/event keys. |

```text
Evidence ID:
Environment/server revision:
ACL mechanism and configuration revision:
Authorized source description (no IP/identity secrets):
Unauthorized source description:
Request method/path/procedure:
Expected result:
Observed status/stable error code:
Response byte count/redacted artifact:
Before/after scan-row count:
Before/after event-publication count:
Server/access-log artifact:
Client contains no server credential: PASS | FAIL | UNVERIFIED
Containment flag value and configuration source:
Rollback/disable observation:
Result: PASS | FAIL | BLOCKED | UNVERIFIED
Reviewer/date:
```

Do not use a destructive Production scan to prove denial. Use the contained endpoint and synthetic environment first.

## TestFlight distribution evidence

An upload is not a distribution and a processed build is not an install. Record the full chain:

```text
App Store Connect app record:
Bundle ID:
Marketing version/build:
Uploaded artifact SHA-256:
Upload timestamp/result:
Processing completion timestamp/result:
Export compliance status:
Internal group assigned (name only):
Assignment timestamp:
Physical iPhone installation build observed:
Physical iPad installation build observed:
Launch/server environment observed:
Feedback/crash collection interval and exposure count:
External testing/Beta App Review, if used:
Result: PASS | FAIL | BLOCKED | UNVERIFIED
Reviewer/date:
```

Native Preview and Production need separate records. The Preview result cannot prove Production signing/identity. App Store phased release begins only after TestFlight proving and App Review; it does not phase TestFlight groups.

## State-bridge evidence

The approved bridge envelope under standard-`UserDefaults` key `com.photobrain.migration.v1` is exactly `{ schemaVersion: 1, theme, activeScanId }`. The checked-in Expo module, TypeScript validator, Swift actor, and tests agree on that exact shape. Prove it at runtime as an upgrade, not by directly seeding native preferences: install/launch the bridge-capable Expo Production build so it migrates legacy AsyncStorage, then replace it with native Production under the same bundle identifier.

```text
Predecessor Expo version/build:
Predecessor logical key/value:
Installed container preserved: yes/no
Native replacement version/build:
Bridge mechanism/revision:
Approved envelope source/test revision:
Approved `schemaVersion:1` producer read status/checksum or redacted decoded value:
Envelope status before native install: valid | absent | invalid
Legacy AsyncStorage seed exercised: yes/no
Native keys/consumed-marker behavior:
Observed native value/UI:
Invalid/missing/read-failure behavior:
One-time/idempotence behavior:
Legacy data retained during rollback window:
Active job durable server status:
New scan rows/events caused by import: expected 0 / observed ___
Terminal cleanup behavior:
Result/reviewer/date:
```

Test the Production same-identifier replacement. Preview's separate identifier/container is expected not to see Production predecessor state. Also exercise an absent envelope (safe defaults plus active-scan discovery), malformed/unsupported envelope (fail closed), terminal active-scan consumption (no re-import), and an existing native preference taking precedence on a later launch.

## Mandatory same-ID replacement drills

Complete all three on physical iPhone and iPad with Production-equivalent signing, exact `com.photobrain.app`, the Production Team/application identifier/capabilities, and strictly increasing builds from the exclusive iOS release lock:

1. **Expo → native:** install and launch the bridge-capable Expo build for each theme and a preferred active scan, then install native over it. Verify approved envelope shape, sandbox state, API/images/scans, URL scheme, effective entitlements/permissions, and active-only recovery. Separately exercise a pre-bridge Expo build and record the safe theme fallback plus active-scan discovery.
2. **Native → higher-build native:** install the current/faulty native build, allocate/build a higher last-good native tag or forward fix, and install it over the first. Verify native theme/active scan state, API/images/scans, links, signing/capabilities, containment, and telemetry. A clean reinstall is not this drill.
3. **Native → higher-build Expo-source replacement:** freeze containment false, restore the bridge-compatible Expo source/toolchain, dispatch the confirmed emergency Production workflow under the shared `ios-production-release` lock, and let its local App Store Connect allocator plus durable run-ID/attempt reservation choose a strictly higher build. Inspect/upload/process that same-ID Production binary and install it over native. Verify both envelope fields, API/images/scans, links, signing/capabilities, and telemetry. Do not synchronize or consume EAS remote version state; the internal/ad hoc emergency Preview workflow and OTA are not substitutes.

For each drill record starting and ending artifact hashes/version/builds, exclusive lock ID, App Store Connect/TestFlight IDs, physical devices, state before/after, containment evidence, elapsed containment/replacement time, and approval. Pausing assignment/phased release does not revert already installed devices.

## Retained Android and web evidence

Before native distribution, and again after iOS-only cleanup:

- record a **named Android owner** and backup;
- prove `.github/workflows/build.yml` remains the sole Android publisher and every update includes `--platform android`;
- capture `android-preview`/`android-production` profile, runtime fingerprint compatibility, channel/environment/API-origin equality, package identity, credentials ownership, and monotonic build behavior;
- from the installed receiving build, smoke Library, filters, Search, thumbnails/loupe, API connectivity, incremental scan, force confirmation, and progress/recovery;
- prove native/emergency iOS workflows cannot publish Android;
- preserve the independently released `apps/web` browser/Docker release smoke;
- if the manual Expo-web capability is retained, run `cd apps/mobile && bun run build:web` and smoke its theme and active-scan bridge fallback without resolving the iOS native module. Record it as a manual capability, not a supported released product.

```text
Android owner/backup:
Workflow run/build/update group:
Profile/channel/environment/runtime fingerprint:
Package and receiving build version:
API-origin equality check:
Library/filter/Search/image smoke:
Incremental/force/progress smoke:
iOS cannot publish Android evidence:
Independent apps/web smoke:
Manual apps/mobile build:web retained: yes/no
Manual Expo-web build/smoke artifact:
Result/reviewer/date:
```

## Initial evidence ledger

| Evidence | Initial status | Basis / closure requirement |
| --- | --- | --- |
| Xcode 26.6 available at selected path | Observed inventory | Capture `xcodebuild -version` in the release bundle. |
| iOS 26.5 simulator runtime available | Observed inventory | Capture `simctl` output and `.xcresult`. |
| Native iOS 17.0 project/schemes/configuration | Repository implementation / UNVERIFIED runtime | Source includes the SwiftUI/API/migration surface and three schemes; capture simulator and physical execution. |
| Exact Xcode/toolchain pin | Repository implementation / distribution proof pending | Simulator CI and both Production release workflows select exact Xcode 26.6 and report the toolchain. Retain the actual run output. |
| Build-environment API equality | Repository implementation / release evidence pending | Android guards profile versus EAS environment; native Production validates the dispatch origin and exact signed plist; Expo Production validates dispatch, EAS environment/profile, embedded JS/plist, and signed artifact. |
| Deterministic 7,961/80-entry fixtures | Target/repository evidence | Run generator, validate counts, record both SHA-256 values; identify CLI JSON versus native in-memory fixture. |
| Live native API/parity surface | UNVERIFIED runtime | Capture simulator and physical evidence against the release server. |
| Bounded decoded-image cache | UNVERIFIED runtime | Measure the implemented 128 MiB cost limit, RSS, and ≤2 s memory-warning recovery on physical devices. |
| Physical iPhone | BLOCKED/no connected device | Install the actual TestFlight build and complete the template. |
| Physical iPad | BLOCKED/no connected device | Install the actual TestFlight build and complete the template. |
| iOS 17 runtime/device compatibility | BLOCKED/no connected qualifying device | Exercise a supported physical or otherwise approved real-device matrix on iOS 17. |
| Preview signing/App ID/profile | BLOCKED/external Apple authority | Preview is not covered by the Production workflows/inspectors; provision, inspect, upload, and prove its separate identity. |
| Production signing/App ID/profile | BLOCKED/external secrets/execution | `native-ios-release.yml` implements validation/import/archive/export/inspection/retention/upload, but required secrets, signed result, and Apple acceptance remain unobserved. |
| Native signed artifact contains no Expo OTA | Nine-argument inspector implemented / UNVERIFIED artifact | Production inspector requires exact identity/API/version/build/minimum iOS 17.0 and rejects Expo Updates content. Retain PASS from the exact uploaded IPA. |
| Shared Production allocator and lock | Repository implementation / UNVERIFIED execution | Both Production workflows share `ios-production-release`, derive the run-ID/attempt floor, query App Store Connect, and allocate `max(remote+1, floor)`. Prove a real serialized allocation and reconcile out-of-band uploads. |
| Expo Production emergency build/upload | BLOCKED/external secrets/execution | Confirmed manual workflow implements Production EAS resolution, local iOS 17.0 signing, twelve-argument inspection, 90-day retention, and upload. Credentials, Apple processing, and install remain unobserved. |
| Production archive/IPA/dSYM retention | Workflow implemented / UNVERIFIED artifacts | Native retains 30 days; Expo emergency retains 90 days. Record names/URLs/expiry, hashes, dSYM UUIDs, and durable copies when rollback exceeds retention. |
| TestFlight processing/group/install | BLOCKED/external Apple/device evidence | Record upload response, processing, group assignment, and physical installs separately. |
| App Store Connect privacy/export/metadata | UNVERIFIED | Record values from the real app record and reconcile artifact behavior. |
| ACL protection | UNVERIFIED/security gap | Run authorized/unauthorized matrix; current routes have no app auth middleware. |
| Production containment | UNVERIFIED runtime | Prove deployed flag source, 503 code, zero rows/events, and unaffected reads/legacy behavior. |
| State bridge from installed Expo build | Repository implementation / UNVERIFIED runtime | Install/launch bridge-capable Expo Production and run the same-container native upgrade matrix. |
| Predecessor bridge rollout | UNVERIFIED | Prove the installed Expo Production build launched and wrote a valid approved `schemaVersion:1` envelope before native cutover. |
| Every numeric performance gate | UNVERIFIED | Five warmups plus at least 30 runs per cell; absolute cap and native p95 ≤1.10× Expo p95 both apply. |
| Native → higher-build native replacement | BLOCKED/external signed builds/devices | Complete the same-ID Production-signed physical replacement drill; clean reinstall is insufficient. |
| Native → higher-build Expo replacement | BLOCKED/external signed build/device drill | Dispatch the confirmed emergency Production workflow with the common marketing version; prove a newly allocated higher build, TestFlight processing, and install over native. OTA is insufficient. |
| Android owner and independent release smoke | UNVERIFIED | Name owner/backup and prove receiving builds, environment equality, sole publisher, and feature behavior. |
| Retained web smokes | UNVERIFIED | Preserve independent `apps/web` smoke; if retained, run manual `apps/mobile` `build:web` without native-module resolution. |
| Rollback-window expiry/cutover | BLOCKED/pending external gates | Requires signed workflow runs, physical drills, ACL/containment/performance evidence, named owner, predeclared thresholds, exposure/sample evidence, approval, and timestamp. |
| iOS-only cleanup safety | UNVERIFIED | Close rollback window, clean only iOS, then re-prove native archive and Android preview publication. |

## Release decision

The approver should sign this only after reviewing raw artifacts:

```text
Release ID:
Commit:
Production workflow/run ID/attempt:
Common marketing-version lineage:
Durable build floor/allocator result:
Native artifact SHA-256:
Bundle ID/version/build:
Native inspector PASS:
Retained archive/IPA/dSYM URL/expiry and durable copy:
Evidence index location:
Required checks PASS:
FAIL/BLOCKED/UNVERIFIED items:
Approved exceptions with owner/expiry:
Containment flag observed false:
ACL result:
Public unauthenticated API unreachable/denied from unauthorized network:
All three same-ID replacement drills:
Emergency Expo workflow/inspector/higher-build result:
Android owner/release smoke:
Physical iPhone result:
Physical iPad result:
Signing result:
Performance result:
Rollback owner/window criterion:
Decision: APPROVE TESTFLIGHT | APPROVE APP STORE | REJECT
Approver/date:
```

Any required row still `FAIL`, `BLOCKED`, or `UNVERIFIED` prevents its distribution stage. A documented exception may cover only a specifically approved non-security item such as the plan's named Expo-baseline exception when Expo already misses an absolute performance cap; it never converts the result to PASS. Public reachability of the unauthenticated API is nonwaivable: if an unauthorized external network can reach it, Production is blocked until a real ACL or authentication/authorization boundary is implemented and evidenced. Bundle/signing identity, containment, physical-device proof, the three replacement drills, and monotonic serialized build allocation are likewise hard cutover gates, not paper exceptions.
