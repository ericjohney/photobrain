# Core ML denoise execution

`adobe-denoise-coreml` adds an explicit macOS executor for the recovered denoise
and Enhance Details networks. Rust retains RAW decoding, calibration, packing,
transfers, strength blending, stitching and display rendering. A small
Objective-C bridge calls public Core ML APIs. No Python, private Espresso API,
downloaded code or learned parameters are required by the running app.

## Select a backend

| Setting | Policy |
| --- | --- |
| `DENOISE_BACKEND=coreml` | Core ML All: CPU, GPU and Neural Engine permitted |
| `DENOISE_BACKEND=coreml-gpu` | Core ML CPU+GPU; Neural Engine excluded |
| `DENOISE_BACKEND=auto` | Existing Metal/Vulkan selection; does not choose Core ML |
| `DENOISE_BACKEND=cpu` | Existing Rust FP32 reference |

Both Core ML modes explicitly disable low-precision GPU accumulation, matching
the captured Adobe configuration. This flag does **not** require FP32 storage
or arithmetic throughout the compiled graph. Core ML chooses internal precision
and placement; output is not bit-identical to the Rust CPU or wgpu executors.
The All policy permits ANE execution but does not expose an actual per-layer
runtime trace. Core ML is unavailable on Linux; explicit requests return errors.

## Prepare external assets

The native addon builds the feature on Mac. Each PBDN in `DENOISE_MODEL_DIR`
needs two companions: the same stem with `.mlmodel` and `.coreml.json` suffixes.
Prepare these outside Git using the existing isolated Python environment with
`coremltools` and `numpy`:

```sh
python packages/raw-develop/tools/adobe-denoise/prepare_coreml.py \
  /external/rust/dn_bayer.pbdn --model /external/models/dn_bayer.mlmodel
python packages/raw-develop/tools/adobe-denoise/prepare_coreml.py \
  /external/rust/dn_xtrans.pbdn --model /external/models/dn_xtrans.mlmodel
python packages/raw-develop/tools/adobe-denoise/prepare_coreml.py \
  /external/rust/xtrans_details.pbdn
```

The tool validates that each original FP16 specification re-exports the same
PBDN graph and parameter bytes. Details is reconstructed from its FP32 PBDN
graph; unsupported convolution attributes fail. Companions are bound by SHA-256
to the complete PBDN bundle and Core ML file. Existing different companions
require explicit `--overwrite`; rerunning identical preparation changes nothing.
The runtime verifies hashes, geometry, feature count and float32 input/output
types before inference. It compiles the exact bytes it hashed, avoiding a
source-file change between verification and compilation. Learned assets remain
external and must not enter Git or container images. The 171-byte
`tests/fixtures/coreml-identity.pb` is a generated identity convolution for tests,
not a recovered or learned model.

```sh
cd packages/image-processing && bun run build
cd ../..
# Keep the existing Adobe engine, profiles, model directory and cache settings:
DENOISE_BACKEND=coreml bun run dev:api
```

Standalone inference:

```sh
cd packages/raw-develop
cargo build --release --features adobe-denoise-coreml --bin raw-denoise
DENOISE_BACKEND=coreml target/release/raw-denoise predict \
  /external/rust/dn_xtrans.pbdn /external/input.f32 /external/output.f32
```

Also prepare `dn_s3_raw` and `dn_pano_raw` from their original specifications when
using those network-level APIs. The app still accepts only the existing
validated X100VI/A1 II RAW layouts. This feature does not move denoise onto iOS;
the separate iOS FFI remains independent and the mobile app uses its server.

## Lifetime, cancellation and caching

A loaded model retains its compiled model, input array and batch-of-one provider
across tiles. Input storage is reused; outputs are copied in CHW order while
respecting Core ML's actual strides. Native temporary source/compiled artifacts
are owned by that model and removed on release. Compilation occurs when loading
a model; Core ML may also reuse its own framework compilation cache. There is
no additional unbounded process-global cache of loaded networks.

Predictions are serialized across model instances. Waiting for the inference
lock is cancellable. An executing Core ML prediction completes before its tile
is discarded on cancellation; no partly computed result is published. This can
take one network prediction, unlike the wgpu executor's four-dispatch bound.
Inference errors fail the request and never switch the remainder to another
backend. Layer observation remains a Rust CPU-only operation.

Backend identity includes implementation revision, compute policy, accumulation
setting, Mac/CPU identity, OS build, Core ML framework version and eligible Metal
devices. A loaded model also reports its Core ML SHA-256. The native preview and
camera-RGB cache keys include the runtime identity and the stat identity of all
PBDN/specification/binding assets. Compute modes and changed companions cannot
reuse one another's cached pixels. Eligible-device identity describes the system
and policy, not proof of which accelerator executed each layer.

## Validation on M4 Pro, 2026-11-04

| Network (structured input) | Core ML All | Core ML CPU+GPU |
| --- | --- | --- |
| Bayer | 0.1805 s | 0.3511 s |
| X-Trans | 0.1469 s | 0.3505 s |
| Enhance Details | 0.00724 s | 0.01514 s |

| Complete native smart preview | Fresh camera-RGB cache | Cached replay |
| --- | --- | --- |
| X100VI amount 100, 60 tiles | 13.093 s | 1.693 s |
| X100VI amount 50, 60 tiles + Details | 17.706 s | 1.675 s |
| Sony A1 II amount 100, 40 tiles | 10.213 s | 1.109 s |

The prior Metal v3 X100VI amount-100 call took 75.721 s. The Core ML call is
5.78× faster in these individual integration runs; they are historical single
calls rather than a paired statistical benchmark, and their numerical output
differs. A second independent Core ML run produced identical preview bytes for
all three settings. No complete Adobe photo timing is available for comparison.

The native Rust→Core ML bridge passed all 16 learned-model cases in each compute
mode: all five graphs, original geometry, finite outputs, five exact repeats
per case and cancellation followed by exact buffer reuse. All-mode Bayer and
X-Trans predictions match four distinct captured Adobe inputs/outputs (origin
and trailing corner for each camera) bit for bit on the recorded Mac/OS. The
CPU+GPU mode differs from those All-mode Adobe captures. This does not establish
whole-photo Adobe parity or universal determinism across OS/hardware changes.
The real Details input also matches its native Adobe tensor exactly. Four
111×111 origin crops (Bayer/Fuji, amounts 1 and 99) match the native canonical
camera-RGB results bit for bit after strength blending and final u16 commit:
147,852 channels in total. These crops do not establish complete-photo parity.

The synthetic X-Trans structured case still differs substantially from Rust
FP32 (max 0.2501, RMS 0.04415). Agreement with native Adobe on real captured
inputs explains why this is not by itself proof of a broken Core ML bridge.
Do not describe the discrepancy as negligible rounding or assert image-quality
equivalence from those few captures. The reference FP32 backends remain available.

Full native smart-preview validation covers X100VI amount 100 and amount 50,
Sony A1 II amount 100, identical cached replay, and cancellation after inference
has started with no completed cache file. Cropped amount-50 output also retains
exact overlapping samples across Bayer's 799-pixel denoise seam, X-Trans's
859-pixel denoise seam and its separate 465-pixel Details seam.

Timing records, hashes, numerical differences and scope are in
[`adobe-denoise-coreml-validation.json`](adobe-denoise-coreml-validation.json).
Network times are warmed five-run medians excluding loading/I/O. Whole-preview
times are individual calls with fresh camera-RGB caches; framework compilation
caches may already be warm. They include decoding, calibration, all image tiles,
display preparation and smart-preview encoding, but not HTTP or iOS UI time.
No complete Adobe photo was timed in this validation.

```sh
RAW_DENOISE_GPU_TESTS=1 cargo test --release \
  --features adobe-denoise-gpu,adobe-denoise-coreml --lib
RAW_DENOISE_COREML_FIXTURES=/external/rust \
RAW_DENOISE_COREML_REPORT=/external/new-report \
  cargo test --release --features adobe-denoise-coreml --test denoise_coreml learned -- --nocapture
RAW_DENOISE_COREML_RAW_ROOT=/external/investigation \
RAW_DENOISE_RAW_FIXTURES=/external/raw-files \
  cargo test --release --features adobe-denoise-coreml --test denoise_coreml coreml_partial -- --nocapture
```

The learned test expects retained native captures under the investigation's
`wrapper/{bayer,xtrans}-{output,corner}` directories. An explicitly requested
report directory contains output tensors; keep it outside the repository.

## NVIDIA vendor-runtime assessment

Core ML cannot accelerate the deployed Linux RTX. Its existing Vulkan backend
and approved GPU-sharing configuration continue to apply. The graph's operators
(convolution, activation, addition, concat, nearest resize and slice) can be
represented in ONNX; conversion must preserve padding, crop coordinates, channel
order, resize semantics and original parameter precision.

The next vendor-runtime experiment should export/check ONNX and test ONNX Runtime's
CUDA provider (cuDNN), followed by TensorRT if useful. The addon already pins
`ort` / `ort-sys` through FastEmbed: reuse that ABI if extending its runtime;
do not link an independent incompatible ONNX Runtime into the same N-API process.
The current PhotoBrain image has Vulkan dependencies, not the CUDA/cuDNN/TensorRT
runtime stack. The existing CUDA model-service image exposes CUDA/cuBLAS but
does not supply cuDNN or TensorRT to PhotoBrain. A candidate image needs explicit
compatible, pinned runtime dependencies and its own validation.

Start with batch one and FP32, with TF32 disabled. This still does not guarantee
the current GPU's reduction order or bits. Evaluate FP16/tensor-core execution as
a separately identified numerical mode only after real-image checks. Bound the
workspace/tactic-search memory, retain backend/engine/runtime cache separation,
and test simultaneous Qwen inference under the approved shared-slot allocation.
Time slicing does not isolate VRAM, so an advertised slot alone is insufficient.
No cuDNN/TensorRT speedup is claimed or deployed by this Core ML change.

The subsequent [CUDA implementation](adobe-denoise-cuda.md) provides the first
vendor-runtime backend described above, with direct Rust ONNX generation.
TensorRT remains a separate future experiment.
