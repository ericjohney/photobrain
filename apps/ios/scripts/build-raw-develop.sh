#!/usr/bin/env bash
# Xcode builds the selected static library. --xcframework packages device + both simulators.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
crate="$repo/packages/raw-develop/ffi"
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:/opt/homebrew/bin:$PATH"
cargo="${RAW_DEVELOP_CARGO:-cargo}"
export CARGO_TARGET_DIR="${RAW_DEVELOP_TARGET_DIR:-$crate/target}"
export RUSTUP_TOOLCHAIN=1.98.0
# Xcode exports SDKROOT for its destination; do not let it leak to host build scripts.
unset SDKROOT
export IPHONEOS_DEPLOYMENT_TARGET=17.0

build() {
  "$cargo" build --manifest-path "$crate/Cargo.toml" --locked --release --lib --target "$1"
}

if [[ "${1:-}" == --xcframework ]]; then
  build aarch64-apple-ios
  build aarch64-apple-ios-sim
  build x86_64-apple-ios
  staging="$CARGO_TARGET_DIR/xcframework-staging"
  mkdir -p "$staging"
  xcrun lipo -create \
    "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/libraw_develop_ffi.a" \
    "$CARGO_TARGET_DIR/x86_64-apple-ios/release/libraw_develop_ffi.a" \
    -output "$staging/libraw_develop_ffi.a"
  output="${2:-$CARGO_TARGET_DIR/RawDevelop.xcframework}"
  # Xcode refuses to replace an existing bundle. Only remove the generated bundle.
  [[ "$output" == *.xcframework ]] || { echo 'Output must end in .xcframework' >&2; exit 1; }
  rm -rf "$output"
  xcodebuild -create-xcframework \
    -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libraw_develop_ffi.a" -headers "$crate/include" \
    -library "$staging/libraw_develop_ffi.a" -headers "$crate/include" \
    -output "$output"
else
  libraries=()
  for arch in ${ARCHS:-arm64}; do
    case "${PLATFORM_NAME:-}:$arch" in
      iphoneos:arm64) target=aarch64-apple-ios ;;
      iphonesimulator:arm64) target=aarch64-apple-ios-sim ;;
      iphonesimulator:x86_64) target=x86_64-apple-ios ;;
      *) echo 'Run from Xcode for iOS, or pass --xcframework.' >&2; exit 1 ;;
    esac
    build "$target"
    libraries+=("$CARGO_TARGET_DIR/$target/release/libraw_develop_ffi.a")
  done
  mkdir -p "$DERIVED_FILE_DIR/RawDevelop"
  if [[ ${#libraries[@]} == 1 ]]; then
    cp "${libraries[0]}" "$DERIVED_FILE_DIR/RawDevelop/"
  else
    xcrun lipo -create "${libraries[@]}" -output "$DERIVED_FILE_DIR/RawDevelop/libraw_develop_ffi.a"
  fi
fi
