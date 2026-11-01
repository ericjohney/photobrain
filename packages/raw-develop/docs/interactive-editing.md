# Interactive RAW editing

The engine now separates preparation from repeated rendering. `prepare` returns an owned,
immutable `Prepared` image; exposure, tone amount, crop and rotation can change without
decoding or preparing again. The existing one-shot `develop` uses the same implementation.
See [usage](usage.md#repeated-editing) for the API and cache invalidation rules.

## Smart previews and saved edits

The iOS loupe’s **Edit RAW** downloads a full-quality, prepared 2048-pixel smart preview once, then runs the linked Rust renderer locally. Adobe RAF/ARW previews expose Exposure, Contrast, Highlights, Shadows, Whites and Blacks; ProRAW keeps Apple and Exposure only. Dragging renders at 1024 pixels and release at 2048. **Before / After**, **Reset**, and saved recipes share the same working state. No RAW decode or runtime Adobe profile is needed on the phone.

`GET /api/photos/:id/smart-preview` returns `application/vnd.photobrain.smart-preview`, an opaque ETag and `X-Developed-Engine`. Conditional requests return 304. The token hashes source/profile stat identity and format/pipeline versions; private paths and fingerprints never appear in response headers. Full preparation, spatial-mask compaction and compression run through the cancellable native executor. The server selects the recipe’s engine, including saved Apple recipes on an Adobe-default server.

Portable format v1 (`PBSP`) contains lossless f32 working pixels, original scene statistics and small profile/render state. Adobe’s full spatial guide is replaced with its 2048-pixel sampled mask plus the exact reduced post-statistics mask. A versioned little-endian bincode payload is zlib-compressed; readers reject incompatible format/pipeline versions, trailing bytes, invalid dimensions/tables and bodies expanding beyond 96 MiB. Keep `PIPELINE_VERSION` unchanged when only the portable format changes; bump the portable format whenever its schema changes. Full exports never compact their preparation. A portable 2048 render is bit-exact with the existing server 2048 proxy, which remains an approximate screen preview rather than a downsampled full render. The 1024 drag mask is sampled from the portable 2048 mask.

The phone caches previews and photo metadata in origin-scoped Application Support. The default limit is 512 MiB per origin with LRU eviction of clean entries. Drafts and queued saves are protected; new downloads are refused when those protected entries fill storage. Each slider change journals the draft atomically. App restart recovers it, including when offline; the unfiltered Library falls back to cached RAW photos when the API is unreachable. Filtered views do not pretend to contain the complete offline catalog. **Cancel** discards the current draft while keeping an earlier explicitly saved offline recipe.

**Save** queues a revision-checked recipe locally before attempting sync. Offline saves remain in the editor with “Saved on device”; startup, foreground, reopening the editor and developed sharing retry sync. Conflicts preserve local edits and never overwrite newer server settings. **Reload Saved Adjustments** explicitly confirms replacing the local draft/queue with the server version. Full-resolution **Share Developed Photo** must finish syncing first; it fails when offline or conflicted rather than exporting an older recipe. Ordinary photo/original sharing keeps its existing behavior.

`GET /api/v1/photos/:id/raw-edit` returns `{ settings, revision, engine, supportsTone }`; `PUT` takes `{ settings, revision }`. Version 1 settings support exposure -5..5 EV in hundredths and integer tone controls -100..100. A stale revision returns 409 `RAW_EDIT_CONFLICT`. Migration `0021_photo_raw_edits.sql` stores independent user recipes and scans preserve them. The original RAW and library thumbnails are never overwritten by an edit.

Older servers retain the server-preview fallback: POST `/api/photos/:id/developed` coalesces slider renders using the existing 1024/2048 proxy cache with 60 s idle expiry. GET `/api/photos/:id/developed?download=1` always renders the saved recipe afresh at full resolution with Display P3 ICC. Server preview POSTs never save.

### Smart-preview verification (2026-10-31)

- Real Sony A7C R, Fuji X-E5 and iPhone ProRAW previews round-tripped exactly for default/exposure/mixed supported controls. Lossless files measured approximately 38.2, 40.0 and 31.6 MB respectively; these are intentionally larger than lossy Lightroom proxies.
- A real Sony portable preview on the iPhone 17 Pro simulator opened in 138 ms after download; mixed six-control 1024 renders measured 22.4 ms p50 / 23.2 ms p95 and a 2048 render 85.2 ms. These are simulator measurements, excluding network transfer, not physical iPhone performance.
- Original Apple and Adobe baseline JPEGs retained their captured hashes; full-resolution saved exports still matched direct native rendering byte for byte.
- Synthetic native/C-bridge tests cover corruption, versions, bounds, cancellation, repeated edits and ownership after releasing download bytes. iOS tests cover durable draft restart, protected LRU entries, origin isolation, save conflicts/lost responses, concurrent sync waiters and the developed-export sync barrier.
- The XCUITest flow downloads a preview, blocks API access, edits locally, terminates/relaunches the app, recovers the draft from the offline Library, saves offline, reconnects and syncs. This proves application-level offline behavior; physical-device memory/thermal measurements remain separate work.

Generate and compare a local portable fixture without changing full-resolution output:

```bash
ADOBE_PROFILE_DIR='/path/to/CameraProfiles' cargo run --release --example smart-preview -- input.ARW /tmp/preview.pbsp --adobe
# Omit --adobe for ProRAW/Apple. Output is a private working artifact; do not commit camera profiles.
```

Run the dedicated simulator flow from the repository root:

```bash
UI_TEST_SMART_PREVIEWS=1 TEST_RUNNER_PHOTOBRAIN_SMART_PREVIEW_UI_TEST=1 \
  apps/ios/scripts/run-ui-tests.sh \
  -only-testing:PhotoBrainUITests/LibraryFlowTests/testSmartPreviewWorksOfflineAfterRestartAndSyncsOnReconnect
```

`TEST_RUNNER_PHOTOBRAIN_SMART_PREVIEW=/tmp/preview.pbsp` enables the real Adobe portable-render simulator measurement in `RawEditingTests`. The older Apple Preview FFI below remains an independent harness.

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

Unresized prepared output is bit-identical to one-shot output. The original Prepared
refactor preserved pipeline version 2. The current version is 5 following the secondary
Adobe engine's modern tone/output integration; the Apple render contract is unchanged.

## Native iOS Apple Preview harness

- `ffi/` packages the engine as a Rust static library with an opaque C session API. Its
  header specifies buffer ownership and concurrency. Errors own their message, Rust
  panics are contained at the open/render boundary, and cancellation tokens can be signaled
  concurrently. A private Rayon pool uses at most four threads, including decode.
- `NativeRawEditRenderer` (`apps/ios/PhotoBrain/Library/RawEditing.swift`) serialises
  preparation, rendering and destruction on a Swift actor. It copies the returned RGBA8
  buffer into an owned `CGImage` with an explicit Display P3 colour space, then frees the
  Rust output. The UIKit image is created on the main actor and preserves the loupe zoom.
- The historical local editor downloaded originals through the export route. The retained native harness owns 1024/2048-edge prepared proxies and does not retain the decoded negative; the shipping `LoupeRawEditStore` now uses the server endpoints above.
- There is at most one render in flight and one latest requested setting. During a drag,
  completed frames advance in order while intermediate settings are coalesced. Once the
  finger lifts, obsolete frames are suppressed and the final value is rendered at the
  larger size. Results from closed or replaced sessions are always discarded.
- Paging, dismissal, closing the editor, backgrounding and memory warnings cancel work
  and release the session. Cancellation checks run between stages and RGBA output rows;
  decode and individual inner kernels cannot be interrupted mid-operation.

The old preview-only UI exposed exposure ±3 EV. The current saved server editor exposes the controls described above.

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

Saving Basic edits and full-resolution developed export are integrated through the server. White balance and other early-stage controls still require a new preparation;
custom white balance for ProRAW is still unsupported.
