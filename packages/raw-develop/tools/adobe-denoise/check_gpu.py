#!/usr/bin/env python3
"""Small CPU/GPU differential smoke test; no external models or Python packages.

python3 check_gpu.py /path/to/raw-denoise --backend metal
Use --write-fixture DIR to prepare the same inputs for a remote executable.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import os
import struct
import subprocess
import tempfile


def write_fixture(directory):
    directory.mkdir(parents=True, exist_ok=True)
    weights = [((i * 13 % 29) - 14) / 32 for i in range(69)]
    payload = struct.pack(f"<{len(weights)}f", *weights)

    def conv(name, source, ic, oc, groups, kernel, stride, padding, offset):
        count = oc * (ic // groups) * math.prod(kernel)
        return dict(name=name, inputs=[source], op="conv2d", in_channels=ic,
                    out_channels=oc, groups=groups, kernel=kernel, stride=stride,
                    padding=padding, weights=dict(offset=offset, count=count),
                    bias=dict(offset=offset + count, count=oc))

    layers = [
        conv("grouped", 0, 3, 6, 3, [3, 2], [2, 1], [2, 1, 1, 2], 0),
        dict(name="identity", inputs=[1], op="identity"),
        dict(name="relu", inputs=[2], op="leaky_relu", alpha=0.125),
        dict(name="residual", inputs=[1, 3], op="add"),
        dict(name="concat", inputs=[2, 4], op="concat"),
        conv("strided", 5, 12, 3, 3, [1, 1], [1, 2], [0]*4, 42),
        dict(name="nearest", inputs=[6], op="upsample", scale=[2, 2]),
        dict(name="rows", inputs=[7], op="slice", axis=1, start=1, end=7),
        dict(name="columns", inputs=[8], op="slice", axis=2, start=2, end=11),
        conv("pointwise", 9, 3, 3, 1, [1, 1], [1, 1], [0]*4, 57),
        dict(name="fused_relu", inputs=[10], op="leaky_relu", alpha=0.0625),
    ]
    manifest = dict(format_version=2, variant="bayer", source_sha256="0"*64,
                    weights_sha256=hashlib.sha256(payload).hexdigest(),
                    input_shape=[3, 7, 9], output_shape=[3, 6, 9],
                    output=len(layers), layers=layers)
    header = json.dumps(manifest).encode()
    (directory / "model.pbdn").write_bytes(b"PBDN0002" + struct.pack("<I", len(header)) + header + payload)
    values = [math.sin(i * 0.7) * 1.3 for i in range(189)]
    (directory / "input.f32").write_bytes(b"PBDT0001" + struct.pack("<3I189f", 3, 7, 9, *values))


def check(binary, backend, directory):
    outputs = []
    reports = []
    for index, selected in enumerate(["cpu", backend, backend]):
        path = directory / f"output-{index}.f32"
        result = subprocess.run([str(binary), "predict", str(directory / "model.pbdn"),
                                 str(directory / "input.f32"), str(path)], check=True,
                                env={**os.environ, "DENOISE_BACKEND": selected},
                                text=True, stdout=subprocess.PIPE)
        reports.append(json.loads(result.stdout))
        data = path.read_bytes()
        assert data[:20] == b"PBDT0001" + struct.pack("<3I", 3, 6, 9)
        outputs.append(data[20:])
    assert reports[1]["model"]["backend"] != "cpu-f32-v1", "GPU test fell back to CPU"
    assert outputs[1] == outputs[2], "GPU repeat is not bit-identical"
    cpu = struct.unpack("<162f", outputs[0])
    gpu = struct.unpack("<162f", outputs[1])
    errors = [abs(a - b) for a, b in zip(cpu, gpu)]
    assert all(math.isfinite(v) for v in gpu)
    assert max(errors) < 0.000002, max(errors)
    print(json.dumps(dict(backend=reports[1]["model"]["backend"], max_abs=max(errors),
                          rms=math.sqrt(sum(v*v for v in errors)/len(errors)),
                          repeat_bit_exact=True, reports=reports), indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, nargs="?")
    parser.add_argument("--backend", choices=["gpu", "metal", "vulkan"], default="gpu")
    parser.add_argument("--write-fixture", type=Path)
    args = parser.parse_args()
    if args.write_fixture:
        write_fixture(args.write_fixture)
    else:
        if not args.binary:
            parser.error("provide a binary, or --write-fixture")
        with tempfile.TemporaryDirectory(prefix="photobrain-gpu-check-") as directory:
            write_fixture(Path(directory))
            check(args.binary.resolve(), args.backend, Path(directory))
