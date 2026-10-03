#!/bin/bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

if [[ $# -ne 9 ]]; then
  fail "usage: $0 ARTIFACT(.app|.ipa) EXPECTED_BUNDLE_ID EXPECTED_APPLICATION_ID EXPECTED_TEAM_ID EXPECTED_URL_SCHEME EXPECTED_API_URL EXPECTED_MARKETING_VERSION EXPECTED_BUILD_NUMBER EXPECTED_MINIMUM_IOS_VERSION"
fi

artifact=$1
expected_bundle_id=$2
expected_application_id=$3
expected_team_id=$4
expected_url_scheme=$5
expected_api_url=$6
expected_marketing_version=$7
expected_build_number=$8
expected_minimum_ios_version=$9

[[ -e "$artifact" ]] || fail "artifact does not exist"
for value in "$expected_bundle_id" "$expected_application_id" "$expected_team_id" "$expected_url_scheme" "$expected_api_url" "$expected_marketing_version" "$expected_build_number" "$expected_minimum_ios_version"; do
  [[ -n "$value" ]] || fail "expected identity and configuration values must be non-empty"
done
[[ "$expected_build_number" =~ ^[1-9][0-9]*$ ]] || fail "expected build number must be a canonical positive integer"
if [[ ${#expected_minimum_ios_version} -gt 18 || ! "$expected_minimum_ios_version" =~ ^[1-9][0-9]*(\.(0|[1-9][0-9]*)){1,2}$ ]]; then
  fail "expected minimum iOS version must be a canonical dotted numeric version"
fi

workdir=$(mktemp -d "${TMPDIR:-/tmp}/photobrain-artifact.XXXXXX")
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

case "$artifact" in
  *.ipa)
    /usr/bin/unzip -qq "$artifact" -d "$workdir/unpacked" || fail "IPA extraction failed"
    shopt -s nullglob
    apps=("$workdir"/unpacked/Payload/*.app)
    shopt -u nullglob
    [[ ${#apps[@]} -eq 1 ]] || fail "IPA must contain exactly one Payload application"
    app=${apps[0]}
    ;;
  *.app)
    [[ -d "$artifact" ]] || fail ".app artifact is not a directory"
    app=$artifact
    ;;
  *)
    fail "artifact must be a signed .app or .ipa"
    ;;
esac

info="$app/Info.plist"
privacy="$app/PrivacyInfo.xcprivacy"
provision="$app/embedded.mobileprovision"
entitlements="$workdir/effective-entitlements.plist"
profile="$workdir/profile.plist"
[[ -f "$info" ]] || fail "application Info.plist is missing"
[[ -f "$privacy" ]] || fail "PrivacyInfo.xcprivacy is missing"
[[ -f "$provision" ]] || fail "embedded.mobileprovision is missing"

/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail "code signature verification failed"
/usr/bin/codesign -d --entitlements :- "$app" >"$entitlements" 2>/dev/null || fail "effective entitlements could not be read"
/usr/bin/security cms -D -i "$provision" >"$profile" 2>/dev/null || fail "embedded provisioning profile could not be decoded"
/usr/bin/plutil -lint "$info" "$privacy" "$entitlements" "$profile" >/dev/null || fail "an embedded property list is malformed"

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

bundle_id=$(plist_value "$info" CFBundleIdentifier) || fail "CFBundleIdentifier is missing"
[[ "$bundle_id" == "$expected_bundle_id" ]] || fail "bundle identifier does not match the expected identity"
application_id=$(plist_value "$entitlements" application-identifier) || fail "application-identifier entitlement is missing"
[[ "$application_id" == "$expected_application_id" ]] || fail "application-identifier entitlement does not match"
team_id=$(plist_value "$entitlements" com.apple.developer.team-identifier) || fail "team identifier entitlement is missing"
[[ "$team_id" == "$expected_team_id" ]] || fail "team identifier entitlement does not match"
profile_application_id=$(plist_value "$profile" Entitlements:application-identifier) || fail "profile application identifier is missing"
[[ "$profile_application_id" == "$expected_application_id" ]] || fail "provisioning profile application identifier does not match"
profile_team_id=$(plist_value "$profile" Entitlements:com.apple.developer.team-identifier) || fail "profile team identifier is missing"
[[ "$profile_team_id" == "$expected_team_id" ]] || fail "provisioning profile team identifier does not match"

if debug_value=$(plist_value "$entitlements" get-task-allow); then
  [[ "$debug_value" == "false" ]] || fail "get-task-allow must be false for a distribution artifact"
fi
for forbidden_entitlement in \
  com.apple.security.application-groups \
  com.apple.developer.ubiquity-container-identifiers \
  com.apple.developer.icloud-container-identifiers \
  aps-environment \
  com.apple.developer.associated-domains; do
  if plist_value "$entitlements" "$forbidden_entitlement" >/dev/null; then
    fail "unexpected effective capability: $forbidden_entitlement"
  fi
done

environment=$(plist_value "$info" PhotoBrainEnvironment) || fail "PhotoBrainEnvironment is missing"
[[ "$environment" == "Production" ]] || fail "signed release artifact must declare the Production environment"
executable_name=$(plist_value "$info" CFBundleExecutable) || fail "CFBundleExecutable is missing"
[[ -f "$app/$executable_name" ]] || fail "declared application executable is missing"
version=$(plist_value "$info" CFBundleShortVersionString) || fail "CFBundleShortVersionString is missing"
[[ "$version" == "$expected_marketing_version" ]] || fail "CFBundleShortVersionString does not match the expected marketing version"
build=$(plist_value "$info" CFBundleVersion) || fail "CFBundleVersion is missing"
[[ "$build" == "$expected_build_number" ]] || fail "CFBundleVersion does not match the allocated build number"
minimum_ios_version=$(plist_value "$info" MinimumOSVersion) || fail "MinimumOSVersion is missing"
[[ "$minimum_ios_version" == "$expected_minimum_ios_version" ]] || fail "MinimumOSVersion does not match the expected supported iOS version"
api_url=$(plist_value "$info" PhotoBrainAPIURL) || fail "PhotoBrainAPIURL is missing"
[[ "$api_url" == "$expected_api_url" ]] || fail "PhotoBrainAPIURL does not match the expected API URL"
API_URL="$api_url" /usr/bin/python3 - <<'PY' || fail "signed artifact API URL must be a non-local HTTPS origin"
import os
from urllib.parse import urlsplit

raw = os.environ["API_URL"]
if raw != raw.strip() or "?" in raw or "#" in raw:
    raise SystemExit(1)
try:
    url = urlsplit(raw)
    url.port
except ValueError:
    raise SystemExit(1)
host = (url.hostname or "").lower()
if (
    url.scheme != "https"
    or url.username is not None
    or url.password is not None
    or url.query
    or url.fragment
    or url.path not in ("", "/")
    or not host
):
    raise SystemExit(1)
is_local = (
    host in {"localhost", "0.0.0.0", "::1"}
    or host.startswith(("127.", "10.", "192.168.", "169.254."))
    or host.endswith(".local")
    or "." not in host
)
parts = host.split(".")
if len(parts) == 4:
    try:
        octets = [int(part) for part in parts]
    except ValueError:
        octets = []
    is_local = is_local or (
        len(octets) == 4 and octets[0] == 172 and 16 <= octets[1] <= 31
    )
if is_local:
    raise SystemExit(1)
PY

if arbitrary=$(plist_value "$info" NSAppTransportSecurity:NSAllowsArbitraryLoads); then
  [[ "$arbitrary" == "false" ]] || fail "NSAllowsArbitraryLoads must be false"
fi
if local_network=$(plist_value "$info" NSAppTransportSecurity:NSAllowsLocalNetworking); then
  [[ "$local_network" == "false" ]] || fail "NSAllowsLocalNetworking must be absent or false"
fi

EXPECTED_SCHEME="$expected_url_scheme" /usr/bin/python3 - "$info" <<'PY' || fail "expected URL scheme is missing or an unexpected Expo scheme is present"
import os
import plistlib
import sys
with open(sys.argv[1], "rb") as handle:
    info = plistlib.load(handle)
schemes = {
    scheme
    for item in info.get("CFBundleURLTypes", [])
    for scheme in item.get("CFBundleURLSchemes", [])
}
expected = os.environ["EXPECTED_SCHEME"]
if expected not in schemes or any(value.startswith("exp+") for value in schemes):
    raise SystemExit(1)
PY

for forbidden_info_key in \
  EXUpdatesURL \
  EXUpdatesRuntimeVersion \
  EXUpdatesRequestHeaders \
  EXUpdatesEnabled \
  EXUpdatesCheckOnLaunch \
  EXUpdatesLaunchWaitMs; do
  if plist_value "$info" "$forbidden_info_key" >/dev/null; then
    fail "Expo Updates Info.plist configuration is present"
  fi
done

PRIVACY_PATH="$privacy" /usr/bin/python3 - <<'PY' || fail "privacy manifest does not declare the expected no-tracking/no-collection policy"
import os
import plistlib
with open(os.environ["PRIVACY_PATH"], "rb") as handle:
    manifest = plistlib.load(handle)
if manifest.get("NSPrivacyTracking") is not False:
    raise SystemExit(1)
if manifest.get("NSPrivacyTrackingDomains") != []:
    raise SystemExit(1)
if manifest.get("NSPrivacyCollectedDataTypes") != []:
    raise SystemExit(1)
accessed = manifest.get("NSPrivacyAccessedAPITypes")
if not isinstance(accessed, list) or not accessed:
    raise SystemExit(1)
PY

if /usr/bin/find "$app" \( -iname '*EXUpdates*' -o -iname '*ExpoUpdates*' -o -iname 'Expo.plist' \) -print -quit | /usr/bin/grep -q .; then
  fail "Expo Updates framework or configuration file is embedded"
fi
if /usr/bin/grep -RIlE 'expo-updates|expo\.modules\.updates|EXUpdatesURL|runtimeVersion|releaseChannel|channel-name' "$app" >/dev/null 2>&1; then
  fail "Expo Updates runtime/channel/update configuration is embedded"
fi
strings_file="$workdir/executable-strings.txt"
/usr/bin/strings "$app/$executable_name" >"$strings_file" || fail "application executable strings could not be inspected"
if /usr/bin/grep -Eq 'expo-updates|expo\.modules\.updates|EXUpdates' "$strings_file"; then
  fail "Expo Updates symbols are linked into the executable"
fi

if [[ -f "$artifact" ]]; then
  artifact_hash=$(/usr/bin/shasum -a 256 "$artifact" | /usr/bin/cut -d ' ' -f 1)
else
  artifact_hash=$(/usr/bin/shasum -a 256 "$app/$executable_name" | /usr/bin/cut -d ' ' -f 1)
fi
printf 'PASS signed PhotoBrain artifact inspection\n'
printf 'bundle_id=%s\n' "$bundle_id"
printf 'version=%s\n' "$version"
printf 'build=%s\n' "$build"
printf 'artifact_or_executable_sha256=%s\n' "$artifact_hash"
printf 'privacy_manifest=present_validated\n'
printf 'expo_updates=absent\n'
