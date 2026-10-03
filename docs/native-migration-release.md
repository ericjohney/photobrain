# Native Migration Release Runbook

## Purpose and hard boundaries

This runbook governs the cutover from the Expo/React Native iOS application to the native Swift iOS application. Android remains in `apps/mobile`; the web application remains in `apps/web`. A release is not complete merely because an archive exists: its identity, signing, containment, distribution, rollback, and observed behavior all need recorded evidence.

The release identities are fixed:

| Surface | Build identity | Distribution | Update mechanism |
| --- | --- | --- | --- |
| Android preview | Android package from the explicit preview profile | EAS internal distribution | EAS Update, `preview`, **Android only** |
| Android production | `com.photobrain.app` | EAS production build/store process | EAS Update, `production`, **Android only** |
| Native iOS Preview | `com.photobrain.app.preview` | TestFlight/internal Apple distribution | Signed native binary; no Expo OTA |
| Native iOS Production | `com.photobrain.app` | TestFlight, then App Store | Signed native binary; no Expo OTA |
| Expo iOS emergency replacement | `com.photobrain.app` | TestFlight/App Store, only during the rollback window | A newly signed Expo binary with a build number greater than every uploaded native build |

Every `eas update` invocation MUST name `--platform android` or `--platform ios`. The normal post-cutover publisher never emits an unqualified update. An update without a platform flag is a release failure because it can publish unintended manifests even when no compatible runtime currently consumes them.

## Release ownership and serialization

1. Name one release operator and one rollback approver in the release record.
2. Let `.github/workflows/build.yml` be the only automated Android publisher. Do not add a second scheduled, tag, manual, or native-iOS workflow that publishes Android updates.
3. `.github/workflows/native-ios.yml` remains unsigned simulator CI only.
4. `.github/workflows/eas-preview-build.yml` remains a manually dispatched internal/ad hoc Expo Preview continuity check only; it is not a store replacement. It shares the static `ios-production-release` concurrency group with cancellation disabled, so the check cannot overlap either Production lane.
5. `.github/workflows/native-ios-release.yml` and `.github/workflows/expo-ios-emergency-production.yml` are the two manual Production lanes. Under the shared `ios-production-release` lock, they are the repository's exclusive native/Expo Production allocators and uploaders through allocation, archive, inspection, retention, and upload. The Preview continuity workflow neither allocates nor uploads a Production build.
6. Both Production lanes derive a durable build floor as `github.run_id * 100 + github.run_attempt`, query all builds for the Production `ASC_APP_ID`, and allocate `max(App Store maximum + 1, durable floor)`. Never bypass `apps/ios/scripts/allocate-app-store-build.mjs` or reuse an allocated number.
7. Both lanes require the same explicit canonical marketing-version lineage for a native release and its emergency Expo replacement. The fallback obtains a new higher build from the shared local allocator; it does not synchronize or consume EAS remote build numbering.
8. Uploads performed outside these workflows are not serialized by GitHub concurrency. Reconcile them in App Store Connect before dispatch and stop if the workflow's queried state cannot be trusted.
9. Workflow implementation is not release evidence. Record workflow/run ID and attempt, source SHA, requested marketing version/API URL, durable floor, allocated build, artifact hashes, retained artifact URL, inspector result, and App Store upload response.

The manual Production workflows require repository access to `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`, `ASC_APP_ID`, `IOS_DISTRIBUTION_CERTIFICATE_BASE64`, `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_DISTRIBUTION_IDENTITY_SHA1`, `IOS_TEAM_ID`, and `IOS_APPLICATION_ID`; the Expo emergency lane additionally requires `EXPO_TOKEN`. Never paste their values into workflow inputs or evidence. Missing, malformed, expired, or mismatched authority stops the workflow before upload.

## Release record

Create a release record outside the repository's source tree before triggering a distribution. Populate every field; use `N/A` only when a field is structurally inapplicable to that lane, and `UNVERIFIED` when an applicable fact is unknown.

```text
Release owner:
Rollback approver:
Android owner and backup:
Source commit:
Release kind: Android preview | Android production | native iOS Preview | native iOS Production | Expo iOS emergency
Scheme or EAS profile:
Marketing version:
Allocated build number:
Production concurrency group/workflow run ID/attempt:
Derived durable build floor:
Predecessor Expo approved `schemaVersion: 1` bridge version/build and rollout evidence:
Bundle/package identifier:
API origin (host only; no credentials):
Effective profile/environment/artifact API-origin equality:
Exact Xcode/Swift version pin and observed version:
V1_NATIVE_SCAN_MUTATIONS_ENABLED observed value and source:
Workflow file/run URL:
Retained artifact name/URL/expiry:
Archive/IPA/dSYM paths and SHA-256:
dSYM UUID evidence:
Strict signed-inspector result/output:
App Store Connect upload/build status:
Evidence folder:
Rollback-window start:
Rollback-window expiry criterion:
Rollback decision owner:
Notes/unverified facts:
```

Never put tokens, provisioning-profile contents, private keys, tester email addresses, real photo metadata, or production response bodies in the record.

## Preflight for every lane

1. Confirm the source commit is the reviewed commit and that the requested lane matches the intended platform.
2. Enforce the approved Xcode 26.6/Swift toolchain. The current simulator workflow uses exact `setup-xcode` input; the archive environment must pass the same exact-version guard. Exporting a mutable path and merely printing its version is not sufficient.
3. Confirm the environment name, channel, effective API origin, bundle/package identifier, version, and build number from the profile/environment and generated/signed artifact. Fail before build/update if the environment and profile differ.
4. Confirm all required evidence in `docs/native-migration-verification.md` is present. Simulator evidence cannot replace physical-device, signing, ACL, TestFlight, replacement-drill, or performance evidence.
5. Confirm the fixture or test library is privacy-safe. Do not point automated parity or performance tooling at a personal photo library.
6. Confirm the v1 scan-mutation containment flag is false in the release environment. Both incremental and `force:true` native mutations must return HTTP 503 code `NATIVE_SCAN_DISABLED` before creating a scan row or sending an event. Reads, image routes, `/api/inngest`, and legacy tRPC—including legacy scan—remain available.
7. Prove the intended private-network/VPN/proxy boundary from authorized and unauthorized origins. A publicly reachable unauthenticated API is a nonwaivable Production block.
8. Confirm no active incident, incompatible server migration, or unfinished App Store Connect processing blocks distribution.
9. Record the rollback owner and expiry criterion. There is intentionally no invented fixed rollback duration.

Stop if a required value is unknown. Record it as `UNVERIFIED`; do not substitute a local project value for an Apple/EAS/server value.

For the currently approved origin, Android publication, native Production, and Expo emergency Production workflows all fail on their lane-specific environment/artifact mismatch. Reproduce the resolved values independently for evidence:

```bash
export APPROVED_API_ORIGIN=https://photobrain-api.ericj5.com
xcodebuild \
  -project apps/ios/PhotoBrain.xcodeproj \
  -scheme <PhotoBrain-Preview-or-PhotoBrain-Production> \
  -configuration <Preview-or-Production> \
  -showBuildSettings -json > /absolute/evidence/path/native-build-settings.json
test "$(plutil -extract 0.buildSettings.PHOTO_BRAIN_API_URL raw /absolute/evidence/path/native-build-settings.json)" = "$APPROVED_API_ORIGIN"

cd apps/mobile
eas env:exec preview 'test "$EXPO_PUBLIC_API_URL" = "https://photobrain-api.ericj5.com"'
eas env:exec production 'test "$EXPO_PUBLIC_API_URL" = "https://photobrain-api.ericj5.com"'
```

Run only the environment(s) participating in the requested lane, retain the redacted output, and confirm the exported signed plist independently.


## Android publishing

### Preview from `main`

The build workflow is the sole publisher. It submits an Android internal build from the explicit preview profile and then publishes only the Android manifest:

```bash
cd apps/mobile
eas build --platform android --profile android-preview --non-interactive
eas env:exec preview "node -e 'const { readFileSync } = require(\"node:fs\"); const profile = JSON.parse(readFileSync(\"eas.json\", \"utf8\")).build[\"android-preview\"]; for (const [name, value] of Object.entries(profile.env ?? {})) { if (process.env[name] !== value) throw new Error(\"EAS preview environment \" + name + \" must match android-preview profile.\"); }' && eas update --platform android --branch preview --environment preview --message \"main@${GITHUB_SHA::7}\" --non-interactive" --non-interactive
```

The checked-in publisher runs inside the Preview EAS environment and fails before update if any `android-preview` profile `env` value differs. A compatible iOS Expo build is not a prerequisite for an Android update after the cutover.

### Production from a version tag

The tag lane first creates the explicit Android production build, then publishes only the matching Android update:

```bash
cd apps/mobile
eas build --platform android --profile android-production --non-interactive
eas env:exec production "node -e 'const { readFileSync } = require(\"node:fs\"); const profile = JSON.parse(readFileSync(\"eas.json\", \"utf8\")).build[\"android-production\"]; for (const [name, value] of Object.entries(profile.env ?? {})) { if (process.env[name] !== value) throw new Error(\"EAS production environment \" + name + \" must match android-production profile.\"); }' && eas update --platform android --branch production --environment production --message \"$RELEASE_TAG\" --non-interactive" --non-interactive
```

The checked-in Production publisher likewise fails on profile/effective-environment mismatch before issuing its Android-only update. Do not add `--platform all`, omit `--platform`, or couple Android publication to native iOS build success. Record the EAS build and update group IDs. Promotion between channels must still be platform-qualified.

### Permanent Android and retained-web gates

Name one Android owner and backup. Before native distribution and again after iOS cleanup, install the resulting Preview/Production receiving binary and smoke Library, filters, Search, images/loupe, API connectivity, incremental scan, force confirmation, and progress/recovery. Record profile, runtime fingerprint compatibility, channel/environment/API-origin equality, package, credentials owner, build number, EAS build/update group IDs, and the smoke result. Native/emergency iOS workflows must be incapable of publishing Android.

`apps/web` keeps its independent browser/Docker release smoke. If the optional Expo-web capability remains, run:

```bash
cd apps/mobile
bun run build:web
```

Smoke theme and scan recovery without an iOS native-module resolution error. This remains a manual capability, not a supported released product.

## Native iOS Preview through TestFlight

Native iOS Preview uses `PhotoBrain-Preview`, iOS 17.0, and `com.photobrain.app.preview`. The checked-in signed release workflow and strict native inspector are Production-only; they do not automate or validate a Preview upload.

1. Run `native-ios-ci` for the reviewed commit and retain its pinned Xcode 26.6 unsigned simulator result as simulator evidence only.
2. Verify the Preview App ID/App Store record, distribution certificate/profile, API environment, export options, and TestFlight group. These remain external and `UNVERIFIED`.
3. Use the Preview App Store record's separately serialized allocator/authority. Never point the Production `ASC_APP_ID`, Production profile, shared Production workflow, or Production inspector at the Preview identity.
4. Archive/export `PhotoBrain-Preview` with the separately allocated Preview build:

   ```bash
   export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
   test "$(xcodebuild -version | sed -n '1p')" = "Xcode 26.6"
   export BUILD_NUMBER=<preview-allocated-number>
   export ARCHIVE_PATH=/absolute/path/PhotoBrain-Preview.xcarchive
   export EXPORT_PATH=/absolute/path/export-preview
   export EXPORT_OPTIONS_PLIST=/absolute/path/verified-preview-export-options.plist

   xcodebuild archive \
     -project apps/ios/PhotoBrain.xcodeproj \
     -scheme PhotoBrain-Preview \
     -configuration Preview \
     -destination 'generic/platform=iOS' \
     -archivePath "$ARCHIVE_PATH" \
     CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

   xcodebuild -exportArchive \
     -archivePath "$ARCHIVE_PATH" \
     -exportPath "$EXPORT_PATH" \
     -exportOptionsPlist "$EXPORT_OPTIONS_PLIST"
   ```

5. Manually inspect Preview identity, signature/profile, exact Preview API/environment/scheme, version/build, minimum OS 17.0, entitlements, privacy, and linked content. Do not use the Production-only nine-argument inspector as Preview evidence.
6. Upload with approved Apple tooling, retain archive/IPA/dSYMs, wait for processing, and assign the named Preview TestFlight group.
7. Install on physical iPhone and iPad and execute the fixture/parity, recovery, accessibility, memory-warning, and performance scenarios. Stop on any failed gate.

## Native iOS Production through TestFlight and App Store

Production uses `PhotoBrain-Production`, minimum iOS 17.0, and `com.photobrain.app`. `.github/workflows/native-ios-release.yml` implements the manual signed archive/inspection/retention/TestFlight-upload path; it has not proved credentials, signing, or Apple acceptance until a real run succeeds.

1. Confirm Preview/parity evidence, false/503/no-side-effect containment, private ACL, the exact `{schemaVersion:1, theme, activeScanId}` bridge, and predecessor Expo Production rollout.
2. Choose the canonical marketing version that the native release and any emergency Expo replacement will share. Record it; never derive it from source defaults.
3. Confirm the required repository secrets listed above belong to the Production `com.photobrain.app` App Store record and that no out-of-band upload is racing or missing from App Store Connect.
4. In GitHub Actions, manually dispatch **Native iOS Production Release** for the reviewed commit with:
   - `bundle_id=com.photobrain.app`;
   - `xcode_scheme=PhotoBrain-Production`;
   - the recorded `marketing_version`;
   - the exact approved non-local HTTPS `expected_api_url`.
5. The workflow joins `ios-production-release`, derives the durable run-ID/attempt floor, queries App Store Connect, and allocates the next safe build. Record the workflow run/attempt, floor, remote maximum evidence, and allocated number. Do not override it.
6. Require every step to pass: Xcode 26.6 setup; authority/input validation; certificate/profile import; manual Production archive/export with minimum iOS 17.0; nine-argument strict Production inspection; packaging; 30-day upload of the `.xcarchive`, IPA, and dSYMs; and `altool` upload.
7. Download or copy the retained archive/IPA/dSYMs and hashes into approved durable release storage before GitHub's 30-day expiry if the rollback window may outlive it.
8. A green workflow proves only that its checks and upload command completed. Wait for App Store Connect processing, reconcile the accepted `CFBundleVersion`, assign the named internal TestFlight group, and retain external evidence.
9. Install the processed build on physical iPhone and iPad. Capture same-container migration, API/images/scans/links, crash/stability, ACL, accessibility, memory warning, and every numeric performance result.
10. Complete all three mandatory same-ID drills below, then obtain explicit approval citing the evidence folder. Security, identity, device, signing, and drill gates are not waivable.
11. Submit for App Review only after the real privacy, export-compliance, age-rating, and metadata answers are verified. After approval, deliberately select immediate or phased release and start the rollback-window record when exposure begins.

## Mandatory same-ID physical replacement drills

Use Production-equivalent signing, exact `com.photobrain.app`, the Production Team/application identifier/capabilities, the exclusive allocator, and physical iPhone plus iPad:

1. **Expo → native:** install/launch the reconciled bridge-capable Expo binary, then install native over it. Verify both migration fields, API/images/scans, links, sandbox state, entitlements/permissions, and active-only recovery. Separately record pre-bridge fallback.
2. **Native → higher-build native:** install the candidate/faulty native build, allocate/archive/upload a strictly higher last-good native tag or forward fix, then install it over the first. Verify native theme/scan state, API/images/scans, links, signing/capabilities, containment, and telemetry. Retain last-good tags, archives, and dSYMs through rollback-window expiry.
3. **Native → higher-build Expo source:** follow the emergency procedure in this runbook and install the higher same-ID Production Expo binary over native. Verify both envelope fields plus the same API/images/scans/links/signing/capabilities/telemetry surface.

An uninstall/reinstall, lower build, old IPA, internal/ad hoc Preview, or OTA does not satisfy a replacement drill.

## Apple phased-release limits

Apple's App Store phased release applies to **automatic App Store updates**, not TestFlight. It releases over seven days to 1%, 2%, 5%, 10%, 20%, 50%, then 100% of eligible automatic-update users. It is not a precise exposure control:

- anyone can manually download the update at any time;
- TestFlight group assignment is separate and is not phased release;
- a phased release can be paused for a total of 30 days, but pausing does not remove an already installed build;
- releasing to all ends the gradual rollout;
- removing the app from sale stops that version's phased release and does not create a binary rollback;
- resuming picks up at the paused day; Apple, not PhotoBrain, selects the automatic-update cohort.
- expedited review is eligibility-based, offers no SLA, and is not a rollback mechanism; plan the higher-build replacement on ordinary review timing.

Therefore, use TestFlight for the controlled native proving stage and server-side containment for risky server mutations. Do not claim that phased release provides rollback, perfect cohort isolation, or protection for users who update manually. Policy reference: [Apple—Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/).

## V1 server containment

`V1_NATIVE_SCAN_MUTATIONS_ENABLED` is the kill switch for the new native scan-mutation surface.

- The release default is `false`.
- When false, the native scan mutation returns HTTP 503 and stable code `NATIVE_SCAN_DISABLED` before a database row or Inngest event is created.
- The flag does not disable library reads, image/thumbnail routes, `/api/inngest`, or legacy tRPC clients.
- Enabling requires a separately recorded approval, ACL evidence, a rollback owner, and proof that disabling again restores the 503/no-side-effect behavior.
- Never use the flag to conceal a client error. Investigate and fix the fault; containment only limits exposure.

Minimum evidence for each flag transition:

```text
Environment:
Change owner/approver:
Previous -> new value:
Configuration source and revision:
Applied timestamp (UTC):
Observed HTTP status/body code:
Observed scan-row delta:
Observed event-publication delta:
Legacy read/tRPC/Inngest checks:
Rollback timestamp/result:
```

## Native Production signed-artifact inspection

`apps/ios/scripts/inspect-signed-artifact.sh` is Production-only and requires exactly nine arguments: artifact, bundle ID, application ID, team ID, URL scheme, API URL, marketing version, build number, and minimum iOS version. `native-ios-release.yml` calls it before artifact retention or upload. The current invocation shape is:

```bash
export IPA=/absolute/path/PhotoBrain.ipa
export EXPECTED_BUNDLE_ID=com.photobrain.app
export EXPECTED_TEAM_ID=APPLE_TEAM_ID
export EXPECTED_APPLICATION_ID="$EXPECTED_TEAM_ID.$EXPECTED_BUNDLE_ID"
export EXPECTED_URL_SCHEME=photobrain
export EXPECTED_API_URL=https://photobrain-api.ericj5.com
export EXPECTED_MARKETING_VERSION=<recorded-common-version>
export EXPECTED_BUILD_NUMBER=<allocator-output>
export EXPECTED_MINIMUM_IOS_VERSION=17.0

bash apps/ios/scripts/inspect-signed-artifact.sh \
  "$IPA" \
  "$EXPECTED_BUNDLE_ID" \
  "$EXPECTED_APPLICATION_ID" \
  "$EXPECTED_TEAM_ID" \
  "$EXPECTED_URL_SCHEME" \
  "$EXPECTED_API_URL" \
  "$EXPECTED_MARKETING_VERSION" \
  "$EXPECTED_BUILD_NUMBER" \
  "$EXPECTED_MINIMUM_IOS_VERSION" |
  tee /absolute/evidence/path/native-production-inspection.txt
```

The inspector fail-closes on Production environment/identity/config mismatch, signature/profile disagreement, unexpected entitlements, unsafe ATS, missing/invalid privacy declaration, any Expo Updates configuration/resources/symbols, and mismatched version/build/minimum OS/API/scheme. It does not turn source implementation into evidence: retain the exact PASS output from the uploaded IPA.

Also retain the workflow's signing-authority/profile validation, profile name/UUID/expiry, archive/IPA hashes, dSYM UUIDs, 30-day artifact URL/expiry, source/run association, and `altool` response. Download archive/IPA/dSYMs to approved durable storage if rollback retention must exceed 30 days. Apple credentials, App Store processing, and TestFlight install remain external until observed.

## Emergency rollback to Expo iOS

An Expo OTA cannot replace the native Swift binary. `.github/workflows/expo-ios-emergency-production.yml` implements a manually confirmed, locally archived, manually signed Production Expo replacement; it never publishes an OTA and has not proved credentials, signing, upload, or replacement behavior until exercised.

To replace native iOS:

1. Stop further TestFlight assignment. Pause a phased App Store release if applicable; installed/manual-download users are not reverted.
2. Set `V1_NATIVE_SCAN_MUTATIONS_ENABLED=false` and prove incremental and `force:true` calls return 503/`NATIVE_SCAN_DISABLED` with no row/event side effect.
3. Select the frozen bridge-compatible Expo commit and confirm its server/data compatibility. The internal/ad hoc `.github/workflows/eas-preview-build.yml` continuity check is not the replacement.
4. Reuse the exact canonical marketing-version lineage recorded for the native release. Confirm all common Production secrets plus `EXPO_TOKEN`, and reconcile any out-of-band App Store uploads.
5. In GitHub Actions, dispatch **Expo iOS Emergency Production Replacement** from the frozen source with:
   - the exact approved Production `expected_api_url`;
   - the common `marketing_version`;
   - `confirm_production_replacement=true`.
6. The workflow joins the same `ios-production-release` group, derives a new durable run-ID/attempt floor, queries App Store Connect, and allocates a build above observed/reserved native and Expo builds. It does not use `eas build:version:set`, EAS remote auto-increment, or an EAS cloud build.
7. Require the frozen install, exact Production EAS environment/API equality, Xcode 26.6, minimum iOS 17.0 local prebuild, manual signing/archive/export, and twelve-argument `apps/mobile/scripts/inspect-expo-signed-artifact.sh` to pass. The inspector checks the common identity/API/version/build/minimum-OS values plus the expected Expo Updates URL, fingerprint runtime, and `production` channel.
8. Require the workflow to retain the signed `.xcarchive`, IPA, dSYMs, inspection output, dSYM UUIDs, hashes, release metadata, and Podfile lock for 90 days before `altool` upload. Copy them to approved durable storage if the rollback window may outlive retention.
9. A green workflow/upload command is not a processed or installable build. Wait for App Store Connect processing, reconcile the accepted build, assign the emergency TestFlight group, and install over native on physical iPhone and iPad.
10. Verify both bridge fields plus API/images/scans/links/signing/capabilities/ACL/telemetry; obtain explicit rollback approval before wider distribution.
11. Record the affected native builds, exposure, containment state, common marketing version, higher replacement build, workflow/run/attempt, retained evidence, and final resolution.

Do not publish an iOS EAS Update, use the internal/ad hoc Preview artifact, decrement/change the recorded marketing-version lineage, or bypass the shared allocator as a substitute for this Production replacement.

## Rollback-window exit

The rollback window has no fixed number of days. The named owner may close it only when all of these are recorded:

- physical iPhone and iPad TestFlight evidence;
- successful native Production workflow allocation/signing/nine-argument inspection/retention/upload evidence and App Store Connect processing;
- all three same-ID replacement drills, including higher-build native and higher-build Expo source;
- successful emergency workflow allocation/signing/twelve-argument Expo inspection/retention/upload rehearsal for the common marketing lineage;
- approved `schemaVersion` bridge source/tests and predecessor rollout evidence;
- private-network ACL proof from both sides and disabled-scan incremental/force no-side-effect evidence;
- every absolute and relative p95 performance/memory gate passing, except a named preapproved Expo-baseline exception where Expo itself misses an absolute cap;
- named Android owner plus independent Android and retained-web smoke evidence;
- stability thresholds chosen before release, their observation interval, sample size, and passing results;
- incident/feedback review and an explicit approval;
- an expiry timestamp and owner decision.

Until then, keep last-good native tags plus archive/IPA/dSYMs, and the frozen bridge-compatible Expo source, lockfile, pinned toolchain, signing access, and emergency workflow usable. Native GitHub artifacts expire after 30 days and Expo emergency artifacts after 90; copy them to approved durable storage before expiry when the rollback window remains open. “No reports received” is not stability evidence without exposure and sample counts.

## iOS-only cleanup after rollback-window closure

Cleanup is a separate reviewed change. It must not change Android or web release behavior.

1. Preserve `apps/mobile`, its Android source/configuration, `android-preview`/`android-production` profiles, Android channels/credentials, and the sole Android publisher.
2. Preserve `expo-updates`, the EAS project ID/update URL, and shared Expo assets/configuration still required by Android. Do not infer that an “iOS cleanup” may delete shared Expo configuration.
3. Remove only obsolete generic Expo iOS build profiles, iOS-specific scripts, `apps/mobile/ios` generated project material, iOS workflow steps, iOS-only channel bindings, and iOS credentials references proven unused after native cutover.
4. Remove the internal Preview continuity workflow, Production emergency workflow, Expo inspector, and emergency signing references only after rollback closure; retain workflow runs and copied archive/IPA/dSYM/inspection evidence.
5. Remove obsolete `exp+photobrain` development URL handling from the distributed native product if it is present and unused. Preserve any tested native Production/Preview URL schemes and all three shared Xcode build schemes.
6. Re-audit App Store privacy answers, privacy manifests, entitlements, usage descriptions, universal/custom links, and registered bundle IDs after cleanup.
7. Search all workflows for `eas update` and confirm every remaining call names a platform and all normal calls are Android-only.
8. Confirm no cleanup deletes Android assets, Expo project identity needed by Android, shared TypeScript behavior, or web code.
9. Confirm Android can still build from `apps/mobile` without the removed Expo iOS material.
10. Produce fresh native archive/signing/no-Expo-OTA evidence and an Android preview build/update/smoke record. If retained, rerun `apps/mobile` `build:web` and its non-iOS bridge smoke before declaring cleanup complete.

## Abort conditions

Abort distribution on any of the following:

- unknown or mismatched bundle/package identifier, version, build number, channel, environment, or API origin;
- Xcode/Swift is not pinned to the approved toolchain, or effective profile/environment/artifact API origins differ;
- an unqualified `eas update` or a second Android publisher;
- allocator cannot reconcile App Store Connect, an out-of-band upload is not reflected, or the run-ID/attempt floor cannot be derived safely;
- native or Expo Production dispatch bypasses the shared `ios-production-release` group, common allocator, required manual confirmation, or expected secrets/authority checks;
- native and emergency Expo replacement do not use the same recorded marketing-version lineage, or the replacement build is not newly allocated above the prior line;
- required archive/IPA/dSYM/inspection artifacts are missing or not retained;
- treating the internal/ad hoc Expo emergency Preview build as TestFlight/App Store rollback;
- producer, consumer, tests, or frozen emergency source diverges from approved `{schemaVersion:1, theme, activeScanId}`, or the same-container rollout/drill is unproven;
- a signed native artifact whose lane/API/scheme does not match the release record or still contains an Expo Updates runtime/configuration;
- a signed Expo replacement whose identity/API/version/build/minimum OS/update URL/fingerprint runtime/channel differs from the emergency release record;
- failure to meet any absolute or relative p95, decoded-cache, or memory-warning recovery gate without the narrow approved Expo-baseline exception;
- unexpected entitlement, usage description, signing identity, privacy declaration, or `get-task-allow=true` in a distributed artifact;
- missing physical-device, signing, ACL, TestFlight, or required performance evidence;
- the unauthenticated API is reachable from an unauthorized external network; this cannot be waived by approval;
- any of the three same-ID physical replacement drills is missing;
- real/private media in fixtures or evidence;
- inability to prove the deployed false/503/no-side-effect containment path and unaffected read/legacy routes;
- enabled v1 native scan mutations without separate approval and rollback proof;
- a proposal to “roll back” native iOS using only OTA or a lower build number.
