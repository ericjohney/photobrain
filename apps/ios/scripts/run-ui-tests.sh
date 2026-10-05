#!/usr/bin/env bash
# Runs the native XCUITest flows against the seeded fixture API.
#
#   apps/ios/scripts/run-ui-tests.sh [extra xcodebuild args, e.g. -only-testing:PhotoBrainUITests/LibraryFlowTests]
#
# Starts apps/api/scripts/ui-test-server.ts on a free loopback port, passes its origin
# to the UI-test runner (TEST_RUNNER_ variables reach the runner without the prefix),
# and stops the server on exit. Requires `bun install` at the repository root; the
# Rust addon is not needed.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
destination="${IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5}"
log="$(mktemp -t photobrain-ui-server)"

bun "$repo/apps/api/scripts/ui-test-server.ts" >"$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; rm -f "$log"' EXIT

origin=""
for _ in $(seq 1 150); do
	origin="$(sed -n 's/^READY //p' "$log")"
	[[ -n "$origin" ]] && break
	if ! kill -0 "$server" 2>/dev/null; then
		cat "$log" >&2
		echo "UI-test fixture server exited before becoming ready" >&2
		exit 1
	fi
	sleep 0.2
done
if [[ -z "$origin" ]]; then
	cat "$log" >&2
	echo "UI-test fixture server did not become ready" >&2
	exit 1
fi
cat "$log"

TEST_RUNNER_PHOTOBRAIN_FIXTURE_URL="$origin" xcodebuild \
	-project "$repo/apps/ios/PhotoBrain.xcodeproj" \
	-scheme PhotoBrain-UITests \
	-configuration Debug \
	-destination "$destination" \
	CODE_SIGNING_ALLOWED=NO \
	test "$@"
