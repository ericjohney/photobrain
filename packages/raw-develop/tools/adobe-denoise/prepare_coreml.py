#!/usr/bin/env python3
"""Prepare checksum-bound external Core ML companions beside a PBDN bundle.

For the four denoisers, supply the original recovered .mlmodel with --model.
For FP32 Enhance Details, reconstruct it from the bundle's graph and parameters.
No model download or extraction is performed. Requires coremltools and numpy.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import os
import struct
import tempfile

from export import export_spec, require
from export_details import save_coreml


def read_bundle(path):
    require(12 <= path.stat().st_size <= 130_000_000, "invalid bundle size")
    data = path.read_bytes()
    require(data[:8] in (b"PBDN0001", b"PBDN0002"), "invalid bundle magic")
    length = struct.unpack_from("<I", data, 8)[0]
    require(0 < length <= 1024 * 1024 and 12 + length <= len(data), "invalid header size")
    header = json.loads(data[12:12 + length])
    payload = data[12 + length:]
    require(header["format_version"] == int(chr(data[7])), "bundle version mismatch")
    require(hashlib.sha256(payload).hexdigest() == header["weights_sha256"], "weight checksum mismatch")
    return data, header, payload


def details_spec(header, payload):
    require(header["format_version"] == 2 and header["variant"] == "xtrans_details", "expected FP32 Details bundle")
    require(len(payload) % 4 == 0 and all(math.isfinite(v[0]) for v in struct.iter_unpack("<f", payload)), "invalid FP32 weights")
    # save_coreml only implements this recovered subset. Reject attributes it
    # cannot represent instead of silently dropping stride/padding/grouping.
    require(header["output"] == len(header["layers"]), "output must be the final layer")
    shapes = [header["input_shape"]]
    names = {"mosaick"}
    cursor = 0
    for i, layer in enumerate(header["layers"], 1):
        require(layer["name"] not in names, "duplicate/reserved layer name")
        names.add(layer["name"])
        op = layer["op"]
        inputs = layer["inputs"]
        require(len(inputs) == (2 if op == "concat" else 1) and all(0 <= n < i for n in inputs), "invalid Details graph inputs")
        shape = list(shapes[inputs[0]])
        if op == "conv2d":
            require(layer["groups"] == 1 and layer["stride"] == [1, 1] and layer["padding"] == [0, 0, 0, 0], "unsupported Details convolution")
            require(layer["in_channels"] == shape[0], "convolution input channels differ")
            for field, count in [("weights", layer["out_channels"] * shape[0] * math.prod(layer["kernel"])), ("bias", layer["out_channels"])]:
                require(layer[field] == {"offset": cursor, "count": count}, "invalid parameter span")
                cursor += count
            shape = [layer["out_channels"], shape[1] - layer["kernel"][0] + 1, shape[2] - layer["kernel"][1] + 1]
        elif op == "leaky_relu":
            require(layer["alpha"] == 0, "Details reference supports ReLU only")
        elif op == "slice":
            axis = layer["axis"]
            require(axis in (1, 2) and 0 <= layer["start"] < layer["end"] <= shape[axis], "invalid slice")
            shape[axis] = layer["end"] - layer["start"]
        elif op == "concat":
            other = shapes[inputs[1]]
            require(shape[1:] == other[1:], "concat spatial shape mismatch")
            shape[0] += other[0]
        else:
            raise ValueError(f"unsupported Details operation: {op}")
        require(all(0 < n <= 4096 for n in shape), "invalid intermediate shape")
        shapes.append(shape)
    require(shapes[-1] == header["output_shape"] and cursor * 4 == len(payload), "output shape or parameter length mismatch")
    with tempfile.TemporaryDirectory(prefix="photobrain-coreml-export-") as directory:
        path = Path(directory) / "model.mlmodel"
        save_coreml(header, payload, path)
        return path.read_bytes()


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".coreml-", delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def prepare(bundle, source=None, overwrite=False):
    data, header, payload = read_bundle(bundle)
    if header["format_version"] == 1:
        from coremltools.models.utils import load_spec
        require(source is not None, "--model ORIGINAL.mlmodel is required for FP16 denoisers")
        model = source.read_bytes()
        digest = hashlib.sha256(model).hexdigest()
        # Check graph AND parameter bytes; a filename or feature shape is insufficient.
        exported, weights = export_spec(load_spec(str(source)), header["variant"], digest)
        require(exported == header and weights == payload, "Core ML source does not reproduce the PBDN bundle")
    else:
        require(source is None, "Details is reconstructed from PBDN; omit --model")
        model = details_spec(header, payload)
    binding = dict(format_version=1, bundle_sha256=hashlib.sha256(data).hexdigest(),
                   model_sha256=hashlib.sha256(model).hexdigest(),
                   input_shape=header["input_shape"], output_shape=header["output_shape"])
    outputs = [(bundle.with_suffix(".mlmodel"), model),
               (bundle.with_suffix(".coreml.json"), (json.dumps(binding, indent=2) + "\n").encode())]
    for path, value in outputs:
        require(path.resolve() != bundle.resolve(), "output overlaps bundle")
        require(overwrite or not path.exists() or path.read_bytes() == value,
                f"{path} differs; use --overwrite to replace it")
    for path, value in outputs:
        if not path.exists() or path.read_bytes() != value:
            atomic_write(path, value)
    return binding


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.bundle, args.model, args.overwrite), indent=2))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"Core ML preparation failed: {error}\n")


if __name__ == "__main__":
    main()
