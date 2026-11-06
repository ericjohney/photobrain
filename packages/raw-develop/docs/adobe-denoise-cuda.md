# NVIDIA CUDA denoise

`adobe-denoise-cuda` adds an explicit Linux CUDA/cuDNN executor through the same
`ort` / `ort-sys` 2.0.0-rc.9 ABI that FastEmbed and face detection already use.
It is selected by `DENOISE_BACKEND=cuda`. Auto selection remains Metal/Vulkan;
Core ML remains available on Mac. iOS continues to request server denoise.

## Graph and precision

The Rust loader first validates the existing PBDN graph, parameter hashes,
geometry and allocation limits. It then generates an ONNX IR 9 / opset 18 graph
in memory. FP16 parameters are expanded exactly to FP32; FP32 parameters retain
their bits. No new model companions, Python runtime, downloaded models or
caller-supplied ONNX files are involved in prediction. Learned weights remain
external. The encoder supports only the existing validated operators, including
grouped convolution, explicit asymmetric padding, channel concatenation,
nearest-neighbour 2× resize and spatial slices. A single-consumer nearest resize
immediately followed by a stride-one, unpadded 1×1 convolution is commuted: the
convolution runs first on unique pixels, then its result is replicated. Shared
resize outputs retain their original graph. This reduces memory and repeated
work while preserving the mathematical operation; vendor kernel changes can
still change rounding, which is checked numerically.

CUDA execution uses FP32 tensors, basic graph optimization, sequential execution,
cuDNN heuristic selection and deterministic-compute requests. TF32 is disabled
both in the provider options and with **`NVIDIA_TF32_OVERRIDE=0` at process
startup**, which the backend requires. ONNX Runtime 1.20's cuDNN 9 frontend can
retry an unsupported plan with its TF32 option enabled; the NVIDIA override is
needed to forbid reduced-precision TF32 in that case. Do not set environment
variables after starting the API or initialize a second ONNX Runtime in N-API.

This is a new numerical backend, not a bit-preserving optimization of the Rust,
wgpu or Core ML executors. Keep the existing executors and their regression
fixtures. Repeated-output checks establish determinism only on the recorded
hardware/runtime, not across driver or library upgrades.

## Memory, cancellation and identity

Prediction and model initialization are serialized within this backend. Sessions
retain weights and allocator storage across tiles. The device arena limit is
3 GiB for a denoiser and 384 MiB for Enhance Details; memory-pattern allocation
is disabled to avoid an additional large patterned allocation after warmup.
Before model loading, CUDA free memory must cover that model's arena plus a
256 MiB margin. This check is not a reservation against other workloads.
Inspected CUDA library handles are retained for process lifetime, avoiding
unloading libraries with live CUDA thread/process state.
These are per-session ORT arena limits, **not total VRAM quotas**. CUDA contexts,
libraries and other workloads consume additional memory. The limited cuDNN
workspace preference is set, but cuDNN 9 frontend plans can exceed the older
32 MiB preference; the arena limit remains the allocation guard. No exhaustive
algorithm search is requested.

Cancellation while waiting for the prediction lock exits promptly. An executing
prediction completes, including its output transfer, then discards the entire
tile if cancelled. The existing wrapper/cache publication rules remain intact.
Provider registration and unsupported graph nodes fail explicitly: CPU fallback
is disabled, and errors do not switch execution backends mid-image.

Cache identity includes implementation revision, compute/arena policies, actual
CUDA device UUID/name, NVIDIA kernel driver release, CUDA driver/runtime versions,
cuDNN/cuBLAS versions and ONNX Runtime build information. Existing source/model
identities still enter both the native preview and camera-RGB cache keys. Device
ordinal zero respects CUDA visibility configured by the container runtime.

## Build and use

The normal addon build does not link CUDA libraries. Build the CUDA feature only
for a Linux NVIDIA runtime with CUDA 12 and cuDNN 9. The pinned Rust dependency
fetches a checksum-verified ONNX Runtime 1.20.0 CUDA distribution, shared with the
addon's other ORT users. Preserve all three runtime libraries:
`libonnxruntime.so`, `libonnxruntime_providers_shared.so` and
`libonnxruntime_providers_cuda.so`. TensorRT is not registered or required.

```sh
cd packages/image-processing
bun run build --features adobe-denoise-cuda
# Add the directory containing the three ORT libraries to LD_LIBRARY_PATH.
cd ../../apps/api
NVIDIA_TF32_OVERRIDE=0 DENOISE_BACKEND=cuda bun run src/index.ts
```

The usual Adobe engine, profiles, PBDN model directory and writable denoise cache
settings are also required. For the packaged x86_64 deployment candidate:

```sh
docker build --platform linux/amd64 --target api-cuda \
  --build-arg DENOISE_CUDA=1 -t photobrain-api:cuda .
```

The separate `api-cuda` target retains the API's Debian dependencies and copies
CUDA 12.6.3 / cuDNN 9.5.1 libraries from a digest-pinned NVIDIA image. It includes
the three ORT libraries and sets `DENOISE_BACKEND=cuda` and
`NVIDIA_TF32_OVERRIDE=0`. The NVIDIA container runtime supplies the host driver.
The existing `api` and `web` targets retain their defaults. Do not use
`DENOISE_CUDA=1` with the ordinary `api` target: that target lacks CUDA runtime
packaging.

The shared RTX advertises two time-sliced slots, one already used by Qwen.
PhotoBrain needs the existing GPU resource overlay as well as a CUDA-capable
image. Slots do not isolate memory or guarantee compute shares. This implementation
does not change Qwen, production deployment manifests or the production image.
Follow the existing GitOps backup/snapshot procedure for a later rollout.

## Reproduce validation

Export semantics can be checked on a Mac without CUDA:

```sh
cd packages/raw-develop
cargo build --release --features adobe-denoise-cuda --bin raw-denoise
python tools/adobe-denoise/check_onnx.py target/release/raw-denoise \
  /external/model.pbdn /external/input.f32 /external/cpu-reference.f32
```

`check_onnx.py` uses the official checker plus ONNX Runtime CPU against the Rust
reference, including declared shapes and finite outputs. The CLI's `onnx MODEL
NEW_OUTPUT.onnx` command exposes the exact generated graph for diagnostics and
refuses to overwrite an existing file. Keep exported learned parameters outside
Git. `RAW_DENOISE_ONNX_EXPORT` enables the synthetic all-operator fixture export
in the library tests.

On NVIDIA, prepare an external validation directory with `models/*.pbdn`, the
16 `fixtures/{model}-{case}.{input,cpu}.f32` tensors and the two validated RAWs
(`DSCF0008.RAF`, `12766.ARW`), then run:

```sh
NVIDIA_TF32_OVERRIDE=0 RAW_DENOISE_CUDA_TESTS=1 \
  cargo test --release --features adobe-denoise-cuda --lib
NVIDIA_TF32_OVERRIDE=0 RAW_DENOISE_CUDA_FIXTURES=/external/validation \
  RAW_DENOISE_CUDA_REPORT=/external/new-report \
  cargo test --release --features adobe-denoise-cuda --test denoise_cuda -- --nocapture --test-threads=1
```

The learned checks compare all five networks to saved CPU tensors, repeat each
case five times bit-for-bit, and cancel/reuse each network. Partial-strength
checks cross both denoise grids and the separate Details grid, checking exact
overlap and no callbacks after pre-cancellation. Whole native smart previews,
cache replay and simultaneous Qwen load require the addon/integration harness.

### Packaged API integration check

`tools/adobe-denoise/check_cuda_image.ts` tests the real `api-cuda` image. Copy
or mount the script into an isolated validation container with one GPU slot.
It starts the shipped API on loopback with its own temporary SQLite database,
runs all startup migrations, and seeds only that database. It does not connect
to the production API or need its database, credentials or photo mounts.

Prepare a writable external `/validation` directory containing the calibrated
`DSCF0008.RAF` and `12766.ARW`, `models/{dn_bayer,dn_xtrans,xtrans_details}.pbdn`,
and `profiles/Adobe Standard/` with the X100VI Standard and A1 II Standard/Standard
v2 DCPs. `face.jpg` must contain a detectable face so both YuNet and SFace run;
the recorded check uses OpenCV 4.12.0's `samples/data/lena.jpg`. CLIP and face
models download into this directory on the first run. None of these assets
belongs in the image or Git.

```sh
# Inside the validation container; the image supplies the CUDA environment.
bun /check_cuda_image.ts /app /validation /validation/image-report.json
```

The check exercises HTTP Denoise at Fuji amounts 100 and 50, saved recipe replay,
ETags, stale revisions and busy admission. It asserts the previous Linux native
preview SHA-256 values, then runs real CLIP text/image and YuNet/SFace inference
before and after a fresh Sony CUDA render in one N-API process. It checks exact
CPU output reuse, disk-cache replay and the loaded ORT library paths. The JSON
report is marked passed only after all assertions; also require process exit
code zero. Temporary API/database/cache storage is removed on exit; downloaded
public models, the report and API log remain in the validation directory.

## RTX 4070 Ti SUPER validation, 2026-11-04

The final runtime uses driver 610.43.02, CUDA 12.6, cuDNN 9.5.1, cuBLAS 12.6.4
and ONNX Runtime 1.20.0. Qwen retained its existing GPU-sharing configuration.
These are sequential, warmed five-run medians on the same RTX, using full-size
structured input tensors and the same validation executable:

| Network | Existing Vulkan v3 | CUDA/cuDNN FP32 | Speedup |
| --- | ---: | ---: | ---: |
| Bayer | 232.45 ms | 182.17 ms | 1.28× |
| X-Trans | 263.53 ms | 124.61 ms | 2.11× |
| Linear RAW | 233.95 ms | 181.99 ms | 1.29× |
| Panorama RAW | 233.40 ms | 182.06 ms | 1.28× |
| Enhance Details | 17.56 ms | 7.12 ms | 2.47× |

Network times include the Rust prediction boundary and host/device transfers,
but exclude model loading, decoding, blending and rendering. They are not
whole-photo speedups. No TensorRT, TF32 or FP16 execution is used.

All 16 full-size learned cases passed the CPU comparison (maximum absolute
error 0.00000626, worst RMS below 0.00000032), five exact repeats per case, and
cancellation followed by exact reuse for all five networks. Three partial-strength
seam comparisons preserve all 300 overlapping channels each, including both
Fuji grids. The same-process CUDA/CPU ORT coexistence test passes; CUDA registration
does not replace the CPU provider used by the addon's other models.

Five real captured Adobe tensors were also compared. They are **not bit-exact**:
maximum errors range from 0.000669 to 0.001678 and RMS from 0.0000581 to 0.000312.
These are sampled tensor comparisons, not full-photo Adobe parity or a perceptual
quality assessment. The exact Core ML matches on the Mac remain a separate result.

The release N-API addon completed these smart previews in a pod limited to two
CPU cores; camera-RGB caches were fresh for the first call and exact on replay:

| Complete native smart preview | Fresh cache | Cached replay |
| --- | ---: | ---: |
| X100VI amount 100, 60 tiles | 22.53 s | 8.40 s |
| X100VI amount 50, 60 tiles + Details | 33.86 s | 8.11 s |
| Sony A1 II amount 100, 40 tiles | 14.77 s | 4.75 s |

These are individual integration calls, not paired statistical whole-photo
benchmarks. They include decode, calibration, inference, rendering preparation
and smart-preview encoding, and exclude HTTP/UI time. Framework/driver caches
may already be warm. The CPU-limited server timings cannot be compared directly
with the Mac's earlier full-preview timings. Both the learned suite and native
preview run retained at least 1,825 MiB free GPU memory while Qwen was loaded.

Other checks: 282 Mac library tests, 279 Linux library tests, six native
prepare/cache tests, three API configuration tests, unchanged bits in all 16
prior wgpu snapshots, official ONNX checking/CPU comparisons for 15 learned
cases and synthetic operator/shared-resize graphs, and the independent iOS FFI
host build. One existing broader Linux scalar-tone test is excluded from the
279 count: `scalar_functions_match_native_f64_payloads` expects Mac f64 payloads
and fails on Linux at `black_lift_0.03125`; the failure was reproduced with no
CUDA or denoise features. It is unrelated to this executor and remains unfixed.

The initial checks used the release addon and ORT/CUDA libraries together in a
temporary GPU pod. Complete image validation is recorded below; production
rollout remains separate. Machine-readable timings, identities, errors and scope are in
[the validation record](adobe-denoise-cuda-validation.json).

A separate simultaneous-load check completed a fresh X100VI amount-100 preview
and exact cache replay while Qwen generated 256 tokens (HTTP 200, nonempty
response). The preview remained byte-identical to the isolated run; 382 memory
samples retained at least 2,735 MiB free. Qwen's request took 88.87 s at 3.03
reported generation tokens/s; there is no paired Qwen baseline, so this does not
measure its slowdown. GPU slots still provide no memory isolation.

Native cancellation after the first Sony tile returned 70 ms after the request,
with no completed cache file. Missing TF32 override, no visible GPU and deliberately
insufficient free VRAM all failed with an explicit error and no output file.
The last check reserved/released temporary memory in the validation pod only.
Both temporary validation/build pods were removed afterward; no production
service, model configuration or deployment was changed.

## Packaged image validation, 2026-11-05

The full `api-cuda` target was built and published as
`registry.ericj5.com/photobrain-api:cuda-validation-20261105`, digest
`sha256:55dcf8d70f7a2e9c0f383d4ec3bf31ebdfe49f71f780480b7d0c64b439ead46c`.
This candidate contains the uncommitted GPU work, not a new release commit.
Compressed image layers total 3,099,124,822 bytes. The builder used Rust 1.99.1;
the runtime uses Bun 1.4.3, Debian glibc 2.41 and libheif 1.23.6.

Building the actual Dockerfile found and fixed the ORT library copy path:
`napi --platform` writes into `target/x86_64-unknown-linux-gnu/release`, not
`target/release`. ORT's download directory is now a BuildKit cache mount because
Cargo's cached outputs symlink into it; a warm rebuild also passed. Docker ignores
now exclude nested build outputs/caches, scratch work and external Adobe assets.

The published digest ran in a separate RTX pod with two CPU cores and 6 GiB RAM:

- The shipped API applied all 22 migrations to a throwaway database and passed
  health, catalog, Denoise capability and SQLite integrity checks.
- Real HTTP Fuji denoise at amounts 100 and 50 retained the previous Linux native
  preview hashes exactly. Saved recipes, exact preview replay, ETag/304 responses,
  stale-revision rejection and single-job admission passed.
- Sony amount 100 also retained its prior preview hash, including disk-cache replay.
- Real CLIP text/image and YuNet/SFace models ran in the same N-API process before
  and after CUDA, with identical CPU outputs and clean process exit. HTTP semantic
  search also ran the real CLIP text model.
- A concurrent Qwen request completed with HTTP 200 and 68 generated tokens.
  Across 260 memory samples, at least 1,823 MiB of GPU memory remained free;
  4,590 MiB was free again after the test process exited. This is a compatibility
  check, not a Qwen slowdown benchmark.

The validation harness and reproduction instructions are above. Reports, exact
asset/source hashes and the image identity are in `container_validation` in the
JSON record. The validation image remains published; temporary builder/test pods
were removed. Production is unchanged.

Production CI now builds `api-cuda` with `DENOISE_CUDA=1` and applies GPU allocation,
`DENOISE_BACKEND=cuda` and `NVIDIA_TF32_OVERRIDE=0` with the new image tag in one
GitOps commit. Later releases retain this configuration. Follow the verified
backup/iSCSI-snapshot procedure and preserve the existing PVCs and Recreate
strategy. This pass changes no database migrations. The dated validation above
predates the production rollout and describes the separately published candidate.
