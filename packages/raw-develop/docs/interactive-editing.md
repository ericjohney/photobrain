# Interactive RAW editing

The engine now separates preparation from repeated rendering. `prepare` returns an owned,
immutable `Prepared` image; exposure, tone amount, crop and rotation can change without
decoding or preparing again. The existing one-shot `develop` uses the same implementation.
See [usage](usage.md#repeated-editing) for the API and cache invalidation rules.

The iOS loupe now offers **Edit RAW** for converted RAWs and RAW+JPEG pairs. It downloads
the untouched source once, prepares it locally and renders an exposure slider entirely on
the device. The existing server-rendered Developed view remains available separately.
The editor is a transient preview: closing it or leaving the photo discards the adjustment.

## Repeat-render measurements

Measured 2026-10-20 on an Apple M4 Pro, release build with four Rayon threads,
`Quality::Preview`, default settings and 30 exposure updates after three warmups.
No builds or tests ran alongside this measurement. Each cell is **p50 / p95 milliseconds**.

| Fixture | 2048 maximum edge | 1536 maximum edge | 1024 maximum edge |
|---|---:|---:|---:|
| Fuji X-E5, `DSCF0970.RAF` | 45.5 / 56.3 | 25.1 / 26.0 | 11.2 / 11.5 |
| Sony A7C R cRAW, `a7cr/6453.ARW` | 38.1 / 39.1 | 21.5 / 22.2 | 9.5 / 10.3 |
| iPhone 16 Pro Max, `iphone16pm/12686.DNG` | 168.2 / 173.4 | 98.1 / 99.8 | 43.7 / 43.8 |
| iPhone 17 Pro Max, `iphone17pm/116.DNG` | 169.9 / 180.7 | 98.5 / 103.2 | 43.7 / 44.2 |

At the 2048 limit, Fuji/Sony working images are 2048×1365 and these ProRAW images are
2016×1512 (no upscaling). At 1024 they are roughly 1024×682 and 1024×768 respectively.

The timed interval includes cloning the working pixels, all remaining processing stages
and output allocations. It excludes image encoding, file/network I/O, UI presentation,
destruction of the returned output and the final digest. Exposure sweeps from −1 to +1 EV. These are
desktop CPU measurements; iPhone latency, frame pacing and sustained thermal performance
remain unmeasured.

RAF/ARW cache after highlight recovery, before colour/exposure. Their preview sharpening
still runs after exposure. ProRAW caches before its detail graph, whose thresholds depend
on exposure, so each update reruns detail and highlight recovery. Caching the DNG detail
result would change the output for exposure edits.

The initial decode/preparation/resize cost in these runs was 0.35–0.39 s for Fuji/Sony,
0.07–0.08 s for the iPhone 16 file and 0.27–0.29 s for the iPhone 17 JPEG XL file. This
excludes the first render, download and presentation. File-system cache state was not
controlled, so these are not cold-open measurements.

The working RGB buffer occupies about 32–35 MiB at the 2048 limit, 18–20 MiB at 1536 and
8–9 MiB at 1024. These numbers exclude render outputs, intermediate detail buffers, decoded
source pixels and allocator overhead. Preparation still decodes the original and builds a
larger image before resizing; peak memory on a phone must be measured separately, especially
for large ProRAW files. `keep_linear` adds another full working-sized RGB buffer per render.

Reproduce from this package after `cargo build --release --bin raw-edit-bench`:

```bash
target/release/raw-edit-bench --threads 4 --iterations 30 --max-edge 1024 \
  ~/raw-develop-fixtures/DSCF0970.RAF \
  ~/raw-develop-fixtures/a7cr/6453.ARW \
  ~/raw-develop-fixtures/iphone16pm/12686.DNG \
  ~/raw-develop-fixtures/iphone17pm/116.DNG
```

Repeat with `--max-edge 1536` and `2048`. `--full` measures a different preparation path;
the table above uses preview quality. Resizing before nonlinear stages produces an
approximate preview; full-resolution rendering remains the source of final output.

## Verification

- All 66 pre-refactor output fingerprints matched: 33 real files in Full and Preview.
- All 33 files passed decoder and final-render checks against the existing Apple references,
  across the X-E5, X100VI, A1 II, A7C R, A7R V and iPhone fixture directories.
- Synthetic integration tests cover repeated exposure/tone/geometry edits in all three
  formats and both qualities, ownership after dropping the decoded negative, cancellation,
  settings invalidation, bounded previews and tiny edge crops.
- The area resampler preserves negative values and highlight headroom above 1.0.

Unresized prepared output is bit-identical to one-shot output. `PIPELINE_VERSION` stays at
2 because this refactor preserves the existing render contract.

## Native iOS implementation

- `ffi/` packages the engine as a Rust static library with an opaque C session API. Its
  header specifies buffer ownership and concurrency. Errors own their message, Rust
  panics are contained at the open/render boundary, and cancellation tokens can be signaled
  concurrently. A private Rayon pool uses at most four threads, including decode.
- `NativeRawEditRenderer` (`apps/ios/PhotoBrain/Library/RawEditing.swift`) serialises
  preparation, rendering and destruction on a Swift actor. It copies the returned RGBA8
  buffer into an owned `CGImage` with an explicit Display P3 colour space, then frees the
  Rust output. The UIKit image is created on the main actor and preserves the loupe zoom.
- `LoupeRawEditStore` downloads through the original export route, not `/file` (which may
  serve an embedded RAW preview). Downloaded originals are removed after preparation,
  including failure/cancellation. The session owns both a 1024-edge drag proxy and a
  2048-edge release proxy; it does not retain the decoded negative.
- There is at most one render in flight and one latest requested setting. During a drag,
  completed frames advance in order while intermediate settings are coalesced. Once the
  finger lifts, obsolete frames are suppressed and the final value is rendered at the
  larger size. Results from closed or replaced sessions are always discarded.
- Paging, dismissal, closing the editor, backgrounding and memory warnings cancel work
  and release the session. Cancellation checks run between stages and RGBA output rows;
  decode and individual inner kernels cannot be interrupted mid-operation.

The UI offers exposure ±3 EV, Reset, Close editor, download/preparation progress and a
failure/retry state. It explicitly says changes are not saved. Share uses the existing
unmodified server export, so sharing is hidden while the editor is open.

### Build and package

Install Rust through rustup in addition to Xcode 26.6:

```bash
rustup toolchain install 1.98.0 --profile minimal
rustup target add --toolchain 1.98.0 aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

Xcode's **Build RAW engine** phase runs `apps/ios/scripts/build-raw-develop.sh`, building
only the selected destination architectures with the locked dependencies and release
optimisation. It places a static library in DerivedData for linking into the app. This phase
disables Xcode script sandboxing for the app target because Cargo reads the shared source
tree and toolchain/cache directories. Cargo performs incremental freshness checks each run.
`RAW_DEVELOP_CARGO` and `RAW_DEVELOP_TARGET_DIR` can override the Cargo executable and cache.
The normal app build requires neither the N-API addon nor exiftool/libheif.

To create a reusable bundle containing iOS arm64 and a universal arm64/x86_64 simulator slice:

```bash
apps/ios/scripts/build-raw-develop.sh --xcframework
# packages/raw-develop/ffi/target/RawDevelop.xcframework (generated, not committed)
cargo +1.98.0 test --manifest-path packages/raw-develop/ffi/Cargo.toml --release
```

Both native CI workflows install this pinned Rust toolchain. Changes under
`packages/raw-develop/**` also trigger the Production release workflow.

### Simulator integration check

The iPhone and iPad XCUITest flow downloads a synthetic Sony-shaped RAW through the real
original-export route, opens the local editor, adjusts exposure, resets and closes it. A
native unit test compares the C bridge's pixels with the Rust engine and verifies Display
P3/orientation. Controlled renderer tests cover coalescing and late results after closing.

An opt-in simulator unit test also opens local real fixtures without committing originals:

```bash
TEST_RUNNER_PHOTOBRAIN_RAW_FIXTURES="$HOME/raw-develop-fixtures" xcodebuild \
  -project apps/ios/PhotoBrain.xcodeproj -scheme PhotoBrain-Preview -configuration Preview \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5' \
  CODE_SIGNING_ALLOWED=NO -only-testing:PhotoBrainTests/RawEditingTests test
```

One run on this M4 Pro, using the iOS 26.5 arm64 simulator and the release Rust library,
produced the following milliseconds. Preparation includes local file decode and both
proxies; drag samples include RGBA8 conversion and Core Graphics image construction,
with 30 measured samples after three warmups. Release is one 2048-limit render. These
measurements exclude source download, UIKit presentation and display refresh.

| Fixture | Prepare | Drag p50 / p95 | Release |
|---|---:|---:|---:|
| X-E5 `DSCF0970.RAF` | 389.4 | 13.5 / 14.3 | 59.2 |
| A7C R `a7cr/6453.ARW` | 401.4 | 11.8 / 12.0 | 48.0 |
| iPhone 16 `iphone16pm/12686.DNG` | 82.6 | 47.7 / 48.2 | 183.8 |
| iPhone 17 `iphone17pm/116.DNG` | 289.6 | 47.7 / 47.9 | 184.3 |
| 48 MP ProRAW `iphone-more/13109.DNG` | 254.7 | 48.0 / 56.9 | 191.1 |

The opt-in real-fixture test skips when its environment variable is absent. Normal CI
uses the committed synthetic fixture. Simulator performance measures the host CPU;
it does not predict an iPhone's speed, memory ceiling or thermal behavior.

A second run kept the drag medians within 0.9 ms of the table, with ProRAW p95 ranging
from 64 to 104 ms. Tail latency varies even on the simulator. The final full run passed
all 695 iOS unit tests, including these real files. An earlier repeat hit intermittent
failures in two unchanged `DeviceLibraryStoreTests` while rebuilding presentation; the
unchanged rerun passed. RAW editor tests passed in every run.

### Remaining device measurements

Measure physical-phone peak memory, first-open latency, p50/p95 updates and sustained
dragging before choosing device-specific limits. The desktop table excludes RGBA8
conversion and Core Graphics presentation. The two cached proxies together retain about
40–44 MiB for the measured files, plus output/intermediate buffers. Preparation still has a
larger memory peak, especially for 48 MP ProRAW; simulator success does not establish a
physical phone's memory or thermal limits. CPU optimisation, Metal late stages or a cheaper
detail path during dragging can follow those measurements.

Saving edits, syncing settings and full-resolution export are separate app integration
work. White balance and other early-stage controls currently require a new preparation;
custom white balance for ProRAW is still unsupported.
