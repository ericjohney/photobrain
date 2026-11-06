# Denoise GPU execution

The optional `adobe-denoise-gpu` Cargo feature evaluates the recovered PBDN
graphs with FP32 compute shaders through wgpu 24: Metal on macOS and Vulkan on
Linux, including NVIDIA. It handles all four denoise networks and the separate
FP32 Fuji Enhance Details baseline. The app's native addon builds this feature.
RAW decoding, calibration, transfers, stitching, strength blending and Adobe
rendering still use the existing Rust stages. Camera/layout support is unchanged.
Models and profiles remain external assets.

## Selection and fallback

`DENOISE_BACKEND` accepts:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Hardware Metal on Mac or hardware Vulkan on Linux; CPU if device initialization fails |
| `cpu` | Existing Rust f32 GEMM executor |
| `gpu` | Require the platform's hardware GPU backend |
| `metal` | Require Metal on macOS |
| `vulkan` | Require Vulkan on Linux |
| `coreml` | Explicit macOS Core ML All; permits Neural Engine, requires companion assets |
| `coreml-gpu` | Explicit macOS Core ML CPU+GPU; requires companion assets |

The Core ML modes use the separate `adobe-denoise-coreml` feature. They do not
preserve this FP32 executor's bits. See [Core ML setup and validation](adobe-denoise-coreml.md).

Software Vulkan adapters are excluded. Explicit GPU requests fail if unavailable.
After selecting a device, graph allocation/inference errors fail the request;
they never switch part of an image to CPU. Device initialization is retained for
the process lifetime; restart after changing GPU availability. `Model::load`
remains CPU for reference tests and existing library callers. Use
`Model::load_with_backend(path, Backend::Auto)` to opt in. `predict_observed`
requires CPU; a GPU model returns an error instead of substituting a CPU trace.

Full FP32 includes exactly decoded FP16/FP32 weights and FP32 FMA accumulation,
without FP16/TF32 compute. Reduction order differs from CPU, so GPU pixels are
**not CPU bit-exact**. Existing exact wrapper/render oracles are retained.
The backend revision, actual adapter/driver and Metal OS build participate in
cache identity; CPU, GPU and changed drivers cannot reuse each other's pixels.
Saving a recipe does not pin a device: it is replayed by the server's selected
executor, subject to the same numerical differences.

## Mac

```sh
cd packages/image-processing
bun run build
cd ../..
# Set alongside the existing Adobe/profile/model/cache configuration:
DENOISE_BACKEND=metal bun run dev:api
```

For the standalone CLI:

```sh
cd packages/raw-develop
cargo build --release --features adobe-denoise-gpu --bin raw-denoise
DENOISE_BACKEND=metal target/release/raw-denoise predict MODEL.pbdn INPUT.f32 OUTPUT.f32
```

`auto` uses Metal without an explicit override. The separate iOS FFI does not
enable this feature; denoise continues to run on the server for the mobile app.
CLI `info` reads model metadata without allocating a GPU graph; `predict` JSON
and the runtime logs report the actual selected executor.

## NVIDIA deployment

The API image includes `libvulkan1`, `libx11-6`, `libxext6`, and `libegl1`.
The NVIDIA container runtime supplies the matching host driver and ICD. Include
`graphics` in `NVIDIA_DRIVER_CAPABILITIES` (or `all`); compute-only CUDA injection
is insufficient. The existing external webapp chart's `nvidia: true` selects its
NVIDIA runtime class and injects `all` driver capabilities. Request a GPU through
Kubernetes resources, rather than bypassing the device-plugin reservation.

[`docs/photobrain-gpu-values.yaml`](../../../docs/photobrain-gpu-values.yaml) is a
renderable overlay for that chart. Merge it through GitOps, preserving the
existing database/photos claims and Recreate strategy. It requests and limits
one GPU. The overlay and production CI now select the separate CUDA executor;
set `DENOISE_BACKEND=vulkan` explicitly when testing this wgpu path. Keep the
existing backup/snapshot rollout rules. Explicit selection makes missing driver
access visible during the smoke test. Logs name the actual adapter and activation arena size.

GPU activations persist only while a model is in use, and are reused across its
tiles. Measured v3 arena sizes are 1,844 MiB for Bayer/linear/panorama, 1,012 MiB
for X-Trans, and 66.3 MiB for Details, plus weights, driver and readback memory.
Allow at least 4 GiB free VRAM. Kubernetes time slicing shares compute access;
it does not partition or reserve VRAM. One inference runs at a time in a process.
Cancellation drains the current batch of up to four dispatches before scratch
can be reused. It does not abort a kernel already executing on the device.

GPU sharing was enabled on 2026-11-04 through external ArgoCD commit
`de2de397c15576d2011e511de3b9bbf164aa7585`. The RTX 4070 Ti SUPER on `k3s1`
advertises two time-sliced `nvidia.com/gpu` slots; each workload requests one,
and requests greater than one are rejected. Qwen retains its model, draft model,
65,536-token context and CUDA build/runtime pins. Its main-model GPU offload was
reduced from 60 to 40 layers, leaving 4,633 MiB free while idle. Moving layers
to CPU slows Qwen; sharing also adds compute contention. The slots provide
neither VRAM isolation nor a guaranteed compute split. Recheck simultaneous
inference and memory headroom when changing either workload.

The sharing infrastructure is live and NVIDIA inference has been validated in
a temporary pod requesting the second slot. PhotoBrain's production API remains
on its existing image without GPU resources. Enabling it still requires publishing
the GPU-capable image and merging the overlay through GitOps with the existing
backup/snapshot rollout procedure; applying the overlay to the old image is
insufficient. The validation pods have been removed.

## Validation

Run the synthetic differential test without proprietary assets:

```sh
cd packages/raw-develop
RAW_DENOISE_GPU_TESTS=1 cargo test --release --features adobe-denoise-gpu --lib
python3 tools/adobe-denoise/check_gpu.py target/release/raw-denoise --backend metal
```

For learned-model regressions, set `RAW_DENOISE_GPU_FIXTURES` to the external
`rust` directory containing PBDNs, the saved Rust CPU tensors, `references/`
inputs and `details-references/`. This requires a real GPU; it cannot fall back.

```sh
RAW_DENOISE_GPU_FIXTURES=/external/rust cargo test --release \
  --features adobe-denoise-gpu --test denoise_gpu -- --nocapture
```

Checks cover all five graphs, zero/structured/noisy inputs and real Details
input, finite output, fixed CPU error bounds, repeat determinism, mid-inference
cancellation and safe arena reuse. Layer/operator tests cover asymmetric
padding, groups, strides, channel concatenation, residuals, nearest upsampling,
both spatial slices and fused activations. Synthetic fused/unfused comparisons
also check residual liveness, both Add operand orders, post-Add activation and
exclusion of shared upsampling from fusion. To check exact output preservation
while tuning, additionally set `RAW_DENOISE_GPU_BASELINE_DIR` to snapshots from
the previous executor on the same device/driver. Files are named
`baseline-{model}-{case}.f32`; all 16 expected files are required.

In the initial v2 implementation, a 1024-square structured Bayer tile measured
2.73 s CPU and 1.72 s GPU in an isolated three-run median (inference only, excluding model load
and file encoding). Earlier CPU measurements taken during concurrent builds
were inflated and are not the paired result. Raw timings and error measurements
are saved in [adobe-denoise-gpu-validation.json](adobe-denoise-gpu-validation.json).
Across all five graph fixtures, the largest absolute GPU/CPU difference was
7.31e-6; RMS differences were below 3.2e-7. Repeats were bit-identical.
Cancellation/drain in the Bayer test took 0.27 s. All 277 Rust library tests and
five native develop/cache tests passed; the separate FFI checked with its locked
dependencies. These are measured numerical comparisons, not Adobe parity.

### Initial v2 comparison with recovered models through Core ML

On the same M4 Pro, matching 1024-square structured inputs and model source
digests were measured with Core ML 9.0 `CPU_AND_GPU` (Neural Engine excluded)
and our Metal executor. Each retained model received one warmup and five timed
predictions; the table reports medians. Model loading, RAW decoding, calibration,
stitching and encoding are excluded. The executors ran sequentially.

| Network | Rust Metal FP32 | Recovered model via Core ML CPU+GPU | Rust/Core ML time |
| --- | --- | --- | --- |
| Bayer, 800-square output | 1.626 s | 0.350 s | 4.64× |
| X-Trans, 864-square output | 1.983 s | 0.353 s | 5.62× |

This measures the recovered Adobe networks through Apple's runtime, not actual
Camera Raw/Lightroom whole-photo latency. Core ML's GPU placement and internal
arithmetic precision were not instrumented or forced to match our FP32 shaders.
Its output differs from saved Core ML CPU references (structured Bayer RMS
1.13e-3, X-Trans 6.49e-4), whereas our previous FP32 comparisons stayed below
3.2e-7 RMS. These synthetic cases do not establish visible image-quality
differences. The speed gap cannot be attributed to precision alone without
profiling. Both executors repeated their own outputs bit-identically. Full raw
timings, source/input hashes and error measurements are in the validation JSON.

A real 40 MP X100VI passed the app's full native smart-preview path on Metal:
126.4 s uncached, 1.72 s cached, with identical cached preview bytes and token.
The job included all 60 tiles plus calibration/rendering/preview encoding.
The native Sony GPU bridge also returned `DEVELOP_CANCELLED` after a shared-flag
request during inference, with no completed cache file. Total test time was
0.80 s including the 0.70 s delay before requesting cancellation. RAW pipeline
cancellation is normalized to that same API error code by the denoise adapter.

## Performance pass: v3, 2026-11-04

On the same M4 Pro (16 GPU cores, Metal OS build `26B123`), the preserved v2
binary and v3 ran sequentially without concurrent builds/inference. Each retained
model received one warmup and five timed predictions on the same 1024-square
structured input and weights. Medians exclude model load and file I/O.

| Network | Previous v2 | Optimized v3 | Latency reduction | Speedup |
| --- | --- | --- | --- | --- |
| Bayer | 1.6491 s | 1.0504 s | 36.3% | 1.57× |
| X-Trans | 2.0192 s | 1.2087 s | 40.1% | 1.67× |

All 16 learned-model cases matched the saved v2 GPU float bits exactly, including
the real Details input. CPU error bounds are unchanged (max 7.31e-6, RMS below
3.2e-7). All 278 GPU-feature library tests passed, as did repeatability and
post-cancellation arena reuse. The Bayer cancellation/drain check took 0.088 s.
These are finite-fixture checks on this device/driver, not proof of universal
GPU bit-exactness or Adobe output parity.

The rebuilt native addon passed all five develop/cache tests. A fresh-cache
amount-100 smart preview of the same 40 MP X100VI completed all 60 tiles in
75.721 s, compared with the earlier v2 run's 126.400 s (40.1% less time). These
are single native integration runs, not repeated medians or HTTP/UI timings.
The complete 38,665,924-byte preview retains SHA-256
`ca4c16acd3b6926cc563395a26bb50915b32b7b81189f0ed40370d5c71aa364f`.
A cached request took 1.758 s and returned identical bytes and token. The token
differs from v2 because the cache identity includes the executor revision.
Native Sony cancellation returned `DEVELOP_CANCELLED` in 0.720 s including the
0.700 s request delay and left no completed cache file. Existing v2 caches were
preserved; the v3 smoke used a separate fresh directory.

The executor now folds adjacent single-consumer convolution/residual Adds and
nearest2x/1x1 convolution pairs. The latter computes each channel dot product
once and repeats it into its original 2x2 output. Compiled residual inputs
participate in allocation liveness; bias/activation/Add ordering is retained.
Dispatches per tile fall from 131 to 90 for Bayer and from 111 to 76 for X-Trans.
The corresponding activation arenas fall from 2,612 to 1,844 MiB and from 1,524
to 1,012 MiB. Details retains its 66.3 MiB arena and 25 dispatches.

Convolution uses 64 spatial positions by 32 output channels per workgroup,
hoists input-coordinate decoding outside row loads, and specializes 3x3/2x2
geometry. Ungrouped 1x1 layers whose output channels divide into blocks of 64
use a wider 64x64 block. Reduction stays K16, including padded-zero FMAs.
K32 trials were slower and were rejected. Cache implementation identity is
`wgpu24-f32-v3`; prior CPU/device/driver separation is retained.

`DENOISE_GPU_PROFILE=1` prints JSON layer wall times to stderr using one-dispatch
batches. These include CPU submission and completion waits, change scheduling,
and are not hardware timestamps or normal batched latency. Original profiling
identified convolutions as the main cost; normal cancellation still drains at
most four queued dispatches.

### What Adobe actually selects

Static analysis used Adobe DNG Converter 18.7 arm64 SHA-256
`4001cc9abfa1e5352aa88c99c84833cf73c0282ad469ace6d8d196adb7d6aacc`.
REA Mach-O identity Evidence:
`ev_5ce3ce0a2a30af45ce5eefa864018a388a3ab880c2b00af00c8a97658e869e47`.
The existing Ghidra database was opened read-only for focused decompilation;
those results and the LLDB replay below are separate shell observations, not
additional authenticated REA Evidence.

- `MakeCNNBayerDenoiseModel_Apple` at `0x10075b1d8` and the Fuji equivalent at
  `0x10075b4d8` retain models and set compute units to 2 (`MLComputeUnitsAll`).
- `PickMetalDevice` at `0x10075d494` leaves selection automatic on this
  single-device Mac; nil does not mean CPU-only.
- `cnn_rgb_data_cml::Predict` at `0x100760c58` uses
  `predictionsFromBatch:error:`. Controlled native replay observed batch size 1
  with a 3x1024x1024 tensor, compute units All, no preferred Metal device and
  `allowLowPrecisionAccumulationOnGPU=false`.
- The replay enabled amount-100 denoise only in the launched debuggable process
  and stopped after four X100VI network calls, without exporting a photo. The
  calls took 0.309 s initially, then 0.166, 0.159 and 0.161 s, including debugger
  boundary/adapter overhead. These are network calls, not whole-photo latency.

A controlled Core ML experiment on the same recovered models/input explains
why the previous CPU+GPU comparison did not cover Adobe's allowed hardware:

| Network | Core ML CPU+GPU, batch 1 | Core ML All, batch 1 | v3 / CPU+GPU | v3 / All |
| --- | --- | --- | --- | --- |
| Bayer | 0.3521 s | 0.1772 s | 2.98× | 5.93× |
| X-Trans | 0.3529 s | 0.1446 s | 3.42× | 8.36× |

Single-prediction API timings were essentially the same as batch-1 timings.
Core ML's anticipated compute plan assigns all 175 Bayer and 147 X-Trans layers
to the Neural Engine when All is allowed. This is a planned assignment, not a
runtime per-layer trace of Adobe. The All speedup is consistent with Neural
Engine use; no claim is made that Adobe's measured calls were GPU-only.

Disabling low-precision accumulation does not establish FP32 tensor storage or
arithmetic throughout Core ML. All-mode output also differs from Rust CPU on
the structured cases (RMS 3.92e-4 Bayer and 4.41e-2 X-Trans). This pass retains
the FP32 executor and its previous output bits; it does not adopt Core ML/ANE or
claim equal-precision speed comparisons. The remaining work is convolution
throughput, or a separately evaluated native accelerator backend with an explicit
numerical contract. Raw measurements and evidence locations are in the validation
JSON; external weights and proprietary decompilation dumps are not bundled.

### NVIDIA validation: shared device, 2026-11-04

The previous v2 NVIDIA executor passed the asset-free operator differential test.
The same Bayer/X-Trans learned graphs were also checked with 256-square input
geometry to stay within the existing service's available VRAM; those checks
retain all original layers and weights but are not full 1024-square wrapper or
whole-photo validation. Their maximum absolute CPU differences were 7.57e-7
(Bayer) and 1.20e-6 (X-Trans); RMS was below 1.8e-7 and repeats were bit-identical.

After enabling sharing, all 16 full-size learned-model cases passed on the
RTX 4070 Ti SUPER with driver `610.43.02`: zero/structured/noisy for Bayer,
X-Trans, Linear Raw and Panorama Raw, plus zero/structured/noisy/real for Details.
Each ran with explicit Vulkan on the previous v2 executor, v3 and a v3 repeat.
All output bits matched v2 and the repeat; all values were finite and met the
existing CPU tolerances (maximum absolute error 7.30157e-6, RMS below 3.2e-7).
These 16 output files also matched the saved Mac GPU fixture hashes. This
establishes parity for those tensors on the tested devices/drivers, not universal
cross-platform determinism or CPU bit-exactness.

A complete X100VI `DSCF0008.RAF` at amount 100 passed the camera-RGB wrapper:
all 60 tiles, 7,733 × 5,154 pixels, matched the stitched previous NVIDIA v2
export bit for bit. Decode, calibration, inference and stitching took 19.823 s,
excluding model loading and display rendering. Its HWC f32 SHA-256 was
`5e2c5332f4561ee3593e977250d5c56d974e4a9e3d5a230056f39feaea5f07cd`.
The complete Mac camera-RGB hash differs
(`8e0706067e261d7f61090e2aa49b0d43917dc3626f2fcab6221b7f0105cf59eb`);
the cause has not been isolated. Whole-RAW cross-platform bit parity is therefore
not established, even though the 16 prepared tensor fixtures match.

Cancellation returned after 0.0204 s including a 0.010 s request delay, and
post-cancel arena reuse remained bit-exact. An actual Qwen request completed
during the learned-model suite (HTTP 200, nonempty response, 192 generated tokens,
2.46 tokens/s generation). During 120 memory samples spanning about 64 s, the
minimum free VRAM was 1,839 MiB and maximum used was 14,134 MiB. This interval
included both the larger v2 arenas and v3; it is not a v3-only memory peak.
The concurrent timings are diagnostics, not isolated performance benchmarks.
The earlier short Qwen request used a different prompt/length and is not a valid
paired performance baseline.

The machine-readable validation JSON retains all case hashes, numerical errors,
backend identities, timing records and the sharing configuration. Production API
GPU deployment remains pending; these runs did not restart it.

The optional [CUDA/cuDNN backend](adobe-denoise-cuda.md) provides a separate NVIDIA vendor-runtime path. Auto remains unchanged; CUDA has its own numerical output and runtime packaging.
