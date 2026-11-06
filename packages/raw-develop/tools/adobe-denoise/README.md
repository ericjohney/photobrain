# Denoise model export and references

These tools support the native Rust reconstruction of the four recovered ACR
18.7 denoise networks. Learned weights remain external runtime assets. The
exporter reads caller-supplied, already recovered Core ML specifications; it
does not decrypt or download model files.

Use an isolated Python environment with `coremltools` and `numpy`. Core ML
reference generation requires macOS. Model export, tensor comparison, and the
synthetic tests do not require Core ML inference.

```sh
python export.py /external/dn_bayer.mlmodel /external/dn_bayer.pbdn --variant bayer
python reference.py generate /external/dn_bayer.mlmodel /external/references \
  --variant bayer --repeat
python reference.py compare /external/references/bayer-noisy.coreml.f32 \
  /external/bayer-noisy.rust.f32 --json /external/comparison.json
python -m unittest discover -s packages/raw-develop/tools/adobe-denoise -v
```

Run the first three commands from this tools directory, or prefix the script
paths when running from the repository root. Run the test command from the root.
Use variants `bayer`, `xtrans`, `linear_raw`, and `panorama_raw` for
`dn_bayer.mlmodel`, `dn_xtrans.mlmodel`, `dn_s3_raw.mlmodel`, and
`dn_pano_raw.mlmodel`, respectively.

Generation defaults to `zero`, `noisy`, and `structured` cases. Repeat `--case`
to select cases. The seeded noise and color ramps/edges exercise the entire
network. Bayer uses the model-local `GR/BG` phase; X-Trans uses the recovered
6×6 phase. Linear-RAW variants receive dense planes. These inputs bypass Adobe's
normalization and output transforms; they are network tests, not complete RAW
development or image-quality tests.

Comparisons report maximum/mean absolute error, RMSE, and exact float-bit matches.
No numerical tolerance is assumed. Supply `--max-abs VALUE`, `--rmse VALUE`, or
`--require-bit-exact` for an explicit pass/fail gate. Nonfinite or malformed
tensors always fail. CPU Core ML repeatability does not establish equality with
Adobe's GPU/ANE execution or with the Rust kernels.

## Formats

All multibyte integers and floating-point payloads are little-endian.

`PBDN0001` bundles contain an 8-byte magic, a u32 JSON byte length, the UTF-8
manifest, then the original FP16 weight/bias bytes. Manifest offsets and counts
are in FP16 elements, not bytes. The manifest records source-model and parameter
payload SHA-256 digests. Node 0 is the input; layer `i` produces node `i + 1`.
Supported operations are convolution, leaky-ReLU, equal-shape addition, nearest
2× upsampling, spatial slices, and identity for singleton batch expansion/removal.
Unsupported operations, broadcasting, attributes, quantization, dilation,
shape mapping, or graph topology cause export failure.

`PBDN0002` uses the same framing with `format_version: 2` and original FP32
parameters. Offsets/counts remain scalar units. The runtime also supports
two-input channel concatenation. Magic and manifest version must agree; FP32
parameters are never silently rounded to FP16.

The separate Fuji Enhance Details baseline uses this format. Export already
recovered local Espresso graph, shapes and weights with:

```sh
python export_details.py /external/model.espresso.net /external/model.espresso.shape \
  /external/model.espresso.weights /external/xtrans_details.pbdn \
  --coreml /external/xtrans_details.mlmodel
```

The optional `--coreml` reconstructs a reference model and requires coremltools
and numpy; the bundle exporter itself uses the Python standard library. It
validates the observed graph attributes, blob framing, zero padding and shapes.
The source digest covers the graph, shapes and weight bytes in that order, each
prefixed by its little-endian u64 byte length. The 186,819 used FP32 parameters
exclude compiled bias padding and unused slots. No recovered files are bundled.

## Core ML runtime companions

`prepare_coreml.py` prepares external `.mlmodel` / `.coreml.json` files beside a
PBDN bundle for the optional native Core ML backend. For FP16 denoisers, provide
the original recovered specification; the tool re-exports and checks the entire
graph and parameter payload. For Details, it reconstructs the supported FP32
graph from PBDN and rejects convolution attributes it cannot represent.

```sh
python prepare_coreml.py /external/rust/dn_bayer.pbdn --model /external/models/dn_bayer.mlmodel
python prepare_coreml.py /external/rust/dn_xtrans.pbdn --model /external/models/dn_xtrans.mlmodel
python prepare_coreml.py /external/rust/xtrans_details.pbdn
```

The runtime verifies bundle and companion hashes plus input/output geometry.
Existing different companions require `--overwrite`; identical preparation is
idempotent. All learned assets remain outside Git and application images.
See [Core ML execution](../../docs/adobe-denoise-coreml.md) for build/run commands,
precision, cancellation, cache policy and measured native-Adobe agreement.

`PBDT0001` tensors contain an 8-byte magic, three u32 dimensions `(C,H,W)`, then
planar float32 values. Their header is 20 bytes; no padding or extra metadata is
present. Reference manifests record each complete tensor file's SHA-256 digest.

The tests use generated tiny graphs and tensors, with no Adobe parameters.

## Validate completed exports

```sh
python validate_export.py validate /external/full-run --full-image \
  --compare-region /external/corner-run --json /external/validation.json
```

The verifier checks full coverage, finite tensors, calibration/source identity,
per-tile hashes and exact overlapping float bits. Partial-strength outputs must
lie on the normalized u16 lattice; full-strength float exports may retain
headroom before the renderer commits them. `--compare-region` is repeatable.
Synthetic tests cover coverage, corrupt data and crop mismatches without models.

## NVIDIA export validation

The optional `adobe-denoise-cuda` Rust feature generates ONNX directly from the
validated PBDN graph. `raw-denoise onnx MODEL NEW_OUTPUT.onnx` exposes that graph
for diagnostics; keep learned exports external. `check_onnx.py BINARY MODEL INPUT
CPU_REFERENCE` runs the official checker and compares ONNX Runtime CPU output
against Rust. It needs `onnx==1.17.0`, `onnxruntime==1.20.1` and numpy; none are
needed by the running app. See [CUDA execution](../../docs/adobe-denoise-cuda.md).

`check_cuda_image.ts APP_ROOT ASSET_DIR REPORT.json` is a Bun integration check
for the complete Linux `api-cuda` image, with real HTTP denoise and CPU CLIP/face
inference sharing the packaged ORT runtime. It starts a private loopback API and
throwaway database, requires the documented external calibration fixtures, and
asserts the prior Linux preview hashes. See the packaged API check in the same
CUDA guide for asset layout and execution instructions.
