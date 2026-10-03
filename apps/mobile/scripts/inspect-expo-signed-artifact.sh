#!/bin/bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

if [[ $# -ne 12 ]]; then
  fail "usage: $0 ARTIFACT(.app|.ipa) EXPECTED_BUNDLE_ID EXPECTED_APPLICATION_ID EXPECTED_TEAM_ID EXPECTED_URL_SCHEME EXPECTED_API_URL EXPECTED_MARKETING_VERSION EXPECTED_BUILD_NUMBER EXPECTED_MINIMUM_IOS_VERSION EXPECTED_UPDATES_URL EXPECTED_RUNTIME_VERSION EXPECTED_UPDATES_CHANNEL"
fi

artifact=$1
expected_bundle_id=$2
expected_application_id=$3
expected_team_id=$4
expected_url_scheme=$5
expected_api_url=$6
expected_marketing_version=$7
expected_build=$8
expected_minimum_ios_version=$9
expected_updates_url=${10}
expected_runtime=${11}
expected_channel=${12}

[[ -e "$artifact" ]] || fail "artifact does not exist"
for value in \
  "$expected_bundle_id" \
  "$expected_application_id" \
  "$expected_team_id" \
  "$expected_url_scheme" \
  "$expected_api_url" \
  "$expected_marketing_version" \
  "$expected_build" \
  "$expected_minimum_ios_version" \
  "$expected_updates_url" \
  "$expected_runtime" \
  "$expected_channel"; do
  [[ -n "$value" ]] || fail "expected artifact values must be non-empty"
done
[[ "$expected_application_id" == "$expected_team_id.$expected_bundle_id" ]] || fail "expected application identifier must be TEAM_ID.BUNDLE_ID"
EXPECTED_API_URL="$expected_api_url" /usr/bin/python3 <<'PY' || fail "expected API URL is not a valid Production HTTPS origin"
import os
from urllib.parse import urlsplit

raw = os.environ["EXPECTED_API_URL"]
if any(value.isspace() for value in raw) or "?" in raw or "#" in raw:
    raise SystemExit(1)
try:
    parsed = urlsplit(raw)
    host = parsed.hostname
    parsed.port
except ValueError:
    raise SystemExit(1)
if (
    parsed.scheme != "https"
    or not host
    or parsed.username is not None
    or parsed.password is not None
    or parsed.path not in ("", "/")
):
    raise SystemExit(1)
host = host.lower()
local = (
    host in {"localhost", "0.0.0.0", "::1"}
    or host.startswith(("127.", "10.", "192.168.", "169.254."))
    or host.endswith(".local")
    or "." not in host
)
parts = host.split(".")
if len(parts) == 4:
    try:
        octets = [int(value) for value in parts]
    except ValueError:
        octets = []
    if len(octets) == 4 and octets[0] == 172 and 16 <= octets[1] <= 31:
        local = True
if local:
    raise SystemExit(1)
PY
[[ "$expected_updates_url" == https://* ]] || fail "expected Expo Updates URL must use HTTPS"
[[ "$expected_build" =~ ^[1-9][0-9]*$ ]] || fail "expected build number must be a positive integer"
[[ ${#expected_marketing_version} -le 18 && "$expected_marketing_version" =~ ^[1-9][0-9]*(\.(0|[1-9][0-9]*)){1,2}$ ]] || fail "expected marketing version is not canonical dotted numeric form"
[[ ${#expected_minimum_ios_version} -le 18 && "$expected_minimum_ios_version" =~ ^[1-9][0-9]*(\.(0|[1-9][0-9]*)){1,2}$ ]] || fail "expected minimum iOS version is not canonical dotted numeric form"
[[ "$expected_runtime" =~ ^[0-9a-fA-F]{40,64}$ ]] || fail "expected Expo runtime must be a fingerprint hash"

workdir=$(mktemp -d "${TMPDIR:-/tmp}/photobrain-expo-artifact.XXXXXX")
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
expo="$app/Expo.plist"
privacy="$app/PrivacyInfo.xcprivacy"
provision="$app/embedded.mobileprovision"
entitlements="$workdir/effective-entitlements.plist"
profile="$workdir/profile.plist"
[[ -f "$info" ]] || fail "application Info.plist is missing"
[[ -f "$expo" ]] || fail "Expo.plist is missing"
[[ -f "$privacy" ]] || fail "PrivacyInfo.xcprivacy is missing"
[[ -f "$provision" ]] || fail "embedded.mobileprovision is missing"
[[ -d "$app/EXUpdates.bundle" ]] || fail "Expo Updates resources are missing"
[[ -s "$app/main.jsbundle" ]] || fail "embedded production JavaScript bundle is missing"

/usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail "code signature verification failed"
/usr/bin/codesign -d --entitlements :- "$app" >"$entitlements" 2>/dev/null || fail "effective entitlements could not be read"
/usr/bin/security cms -D -i "$provision" >"$profile" 2>/dev/null || fail "embedded provisioning profile could not be decoded"
/usr/bin/plutil -lint "$info" "$expo" "$privacy" "$entitlements" "$profile" >/dev/null || fail "an embedded property list is malformed"

plist_value() {
  /usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null
}

bundle_id=$(plist_value "$info" CFBundleIdentifier) || fail "CFBundleIdentifier is missing"
[[ "$bundle_id" == "$expected_bundle_id" ]] || fail "bundle identifier does not match the production identity"
application_id=$(plist_value "$entitlements" application-identifier) || fail "application-identifier entitlement is missing"
[[ "$application_id" == "$expected_application_id" ]] || fail "application-identifier entitlement does not match"
team_id=$(plist_value "$entitlements" com.apple.developer.team-identifier) || fail "team identifier entitlement is missing"
[[ "$team_id" == "$expected_team_id" ]] || fail "team identifier entitlement does not match"
profile_application_id=$(plist_value "$profile" Entitlements:application-identifier) || fail "profile application identifier is missing"
[[ "$profile_application_id" == "$expected_application_id" ]] || fail "provisioning profile application identifier does not match"
profile_team_id=$(plist_value "$profile" Entitlements:com.apple.developer.team-identifier) || fail "profile team identifier is missing"
[[ "$profile_team_id" == "$expected_team_id" ]] || fail "provisioning profile team identifier does not match"
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

if debug_value=$(plist_value "$entitlements" get-task-allow); then
  [[ "$debug_value" == "false" ]] || fail "get-task-allow must be false for a distribution artifact"
fi
profile_debug_value=$(plist_value "$profile" Entitlements:get-task-allow) || fail "profile get-task-allow entitlement is missing"
[[ "$profile_debug_value" == "false" ]] || fail "provisioning profile is not an App Store distribution profile"
profile_beta_reports=$(plist_value "$profile" Entitlements:beta-reports-active) || fail "profile is not enabled for TestFlight beta reports"
[[ "$profile_beta_reports" == "true" ]] || fail "profile beta-reports-active entitlement must be true"
if provisioned_devices=$(plist_value "$profile" ProvisionedDevices); then
  fail "provisioning profile is device-scoped rather than App Store distribution"
fi
if provisions_all_devices=$(plist_value "$profile" ProvisionsAllDevices); then
  [[ "$provisions_all_devices" == "false" ]] || fail "enterprise provisioning profiles are not accepted"
fi

executable_name=$(plist_value "$info" CFBundleExecutable) || fail "CFBundleExecutable is missing"
[[ -f "$app/$executable_name" ]] || fail "declared application executable is missing"
version=$(plist_value "$info" CFBundleShortVersionString) || fail "CFBundleShortVersionString is missing"
[[ -n "$version" ]] || fail "CFBundleShortVersionString is empty"
[[ "$version" == "$expected_marketing_version" ]] || fail "CFBundleShortVersionString does not match the requested App Store marketing version"
build=$(plist_value "$info" CFBundleVersion) || fail "CFBundleVersion is missing"
[[ "$build" == "$expected_build" ]] || fail "CFBundleVersion does not match the allocated App Store build"
minimum_ios_version=$(plist_value "$info" MinimumOSVersion) || fail "MinimumOSVersion is missing"
[[ "$minimum_ios_version" == "$expected_minimum_ios_version" ]] || fail "MinimumOSVersion does not match the emergency compatibility target"
api_url=$(plist_value "$info" PhotoBrainAPIURL) || fail "PhotoBrainAPIURL is missing"
[[ "$api_url" == "$expected_api_url" ]] || fail "PhotoBrainAPIURL does not match the expected production API URL"
environment=$(plist_value "$info" PhotoBrainEnvironment) || fail "PhotoBrainEnvironment is missing"
[[ "$environment" == "Production" ]] || fail "signed Expo replacement must declare the Production environment"
/usr/bin/grep -aFq -- "$expected_api_url" "$app/main.jsbundle" || fail "embedded JavaScript was not built with the expected production API URL"

EXPECTED_SCHEME="$expected_url_scheme" \
EXPECTED_API_URL="$expected_api_url" \
EXPECTED_UPDATES_URL="$expected_updates_url" \
EXPECTED_RUNTIME="$expected_runtime" \
EXPECTED_CHANNEL="$expected_channel" \
EXPECTED_TEAM_ID="$expected_team_id" \
/usr/bin/python3 - "$info" "$expo" "$privacy" "$profile" <<'PY' || fail "signed Expo production configuration is invalid"
import datetime
import os
import plistlib
import sys

info_path, expo_path, privacy_path, profile_path = sys.argv[1:]
with open(info_path, "rb") as handle:
    info = plistlib.load(handle)
with open(expo_path, "rb") as handle:
    expo = plistlib.load(handle)
with open(privacy_path, "rb") as handle:
    privacy = plistlib.load(handle)
with open(profile_path, "rb") as handle:
    profile = plistlib.load(handle)

def reject(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)
expected_team = os.environ["EXPECTED_TEAM_ID"]
if profile.get("TeamIdentifier") != [expected_team]:
    reject("provisioning profile TeamIdentifier mismatch")
if "iOS" not in profile.get("Platform", []):
    reject("provisioning profile does not support iOS")
certificates = profile.get("DeveloperCertificates")
if not isinstance(certificates, list) or not certificates or not all(isinstance(value, bytes) for value in certificates):
    reject("provisioning profile developer certificates are missing")


schemes = {
    scheme
    for item in info.get("CFBundleURLTypes", [])
    if isinstance(item, dict)
    for scheme in item.get("CFBundleURLSchemes", [])
    if isinstance(scheme, str)
}
expected_scheme = os.environ["EXPECTED_SCHEME"]
if expected_scheme not in schemes:
    reject("expected production URL scheme is missing")
if any(value.startswith("exp+") for value in schemes):
    reject("development Expo URL scheme is present")

ats = info.get("NSAppTransportSecurity")
if not isinstance(ats, dict):
    reject("NSAppTransportSecurity dictionary is missing")
for key in (
    "NSAllowsArbitraryLoads",
    "NSAllowsArbitraryLoadsForMedia",
    "NSAllowsArbitraryLoadsInWebContent",
    "NSAllowsLocalNetworking",
):
    if ats.get(key) not in (None, False):
        reject(f"{key} must be absent or false")
if ats.get("NSExceptionDomains"):
    reject("ATS exception domains are not allowed")
if info.get("NSBonjourServices"):
    reject("Bonjour development services must not be present")
if info.get("NSLocalNetworkUsageDescription"):
    reject("development local-network usage must not be present")
if info.get("PhotoBrainAPIURL") != os.environ["EXPECTED_API_URL"]:
    reject("PhotoBrainAPIURL mismatch")
if info.get("PhotoBrainEnvironment") != "Production":
    reject("PhotoBrainEnvironment is not Production")

if expo.get("EXUpdatesEnabled") is not True:
    reject("Expo Updates must be enabled")
if expo.get("EXUpdatesCheckOnLaunch") != "ALWAYS":
    reject("Expo Updates must check on every production launch")
if expo.get("EXUpdatesLaunchWaitMs") != 0:
    reject("Expo Updates launch wait must be zero")
if expo.get("EXUpdatesURL") != os.environ["EXPECTED_UPDATES_URL"]:
    reject("Expo Updates URL mismatch")
if expo.get("EXUpdatesRuntimeVersion") != os.environ["EXPECTED_RUNTIME"]:
    reject("Expo Updates runtime mismatch")
headers = expo.get("EXUpdatesRequestHeaders")
if not isinstance(headers, dict) or headers.get("expo-channel-name") != os.environ["EXPECTED_CHANNEL"]:
    reject("Expo Updates channel header mismatch")

if privacy.get("NSPrivacyTracking") is not False:
    reject("privacy manifest must disable tracking")
if privacy.get("NSPrivacyTrackingDomains", []) != []:
    reject("privacy manifest must not declare tracking domains")
if privacy.get("NSPrivacyCollectedDataTypes") != []:
    reject("privacy manifest must declare no collected data")
accessed = privacy.get("NSPrivacyAccessedAPITypes")
if not isinstance(accessed, list) or not accessed:
    reject("privacy manifest must declare required-reason API usage")
for declaration in accessed:
    if not isinstance(declaration, dict) or not declaration.get("NSPrivacyAccessedAPIType"):
        reject("privacy manifest has a malformed required-reason declaration")
    reasons = declaration.get("NSPrivacyAccessedAPITypeReasons")
    if not isinstance(reasons, list) or not reasons or not all(isinstance(value, str) and value for value in reasons):
        reject("privacy manifest has a required-reason API without reasons")

expiration = profile.get("ExpirationDate")
if not isinstance(expiration, datetime.datetime):
    reject("provisioning profile expiration is missing")
now = datetime.datetime.now(datetime.timezone.utc)
if expiration.tzinfo is None:
    expiration = expiration.replace(tzinfo=datetime.timezone.utc)
if expiration <= now:
    reject("provisioning profile is expired")
PY

if [[ -f "$artifact" ]]; then
  hash_line=$(/usr/bin/shasum -a 256 "$artifact")
else
  hash_line=$(/usr/bin/shasum -a 256 "$app/$executable_name")
fi
artifact_hash=${hash_line%% *}
printf 'PASS signed Expo PhotoBrain artifact inspection\n'
printf 'bundle_id=%s\n' "$bundle_id"
printf 'version=%s\n' "$version"
printf 'build=%s\n' "$build"
printf 'minimum_ios_version=%s\n' "$minimum_ios_version"
printf 'api_url=%s\n' "$api_url"
printf 'expo_updates_url=%s\n' "$expected_updates_url"
printf 'expo_runtime=%s\n' "$expected_runtime"
printf 'expo_channel=%s\n' "$expected_channel"
printf 'artifact_or_executable_sha256=%s\n' "$artifact_hash"
printf 'privacy_manifest=present_validated\n'
printf 'provisioning=app_store_distribution_validated\n'
