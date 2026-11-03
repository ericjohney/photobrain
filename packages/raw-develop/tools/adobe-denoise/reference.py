#!/usr/bin/env python3
"""Generate controlled Core ML tensor references, or compare native Rust output.

These are network-level cases; normalization, tile stitching, and strength
blending from the Adobe application are deliberately outside this harness.
Generate requires macOS, numpy and coremltools. Compare requires only numpy.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import platform
import struct
import time

import numpy as np

from export import VARIANTS, export_spec, require

TENSOR_MAGIC = b"PBDT0001"
CASES = ("zero", "noisy", "structured")
MAX_ELEMENTS = 3 * 1024 * 1024


def write_tensor(path, tensor):
    require(tensor.ndim == 3 and 0 < tensor.size <= MAX_ELEMENTS,
            "expected bounded CHW tensor")
    require(np.isfinite(tensor).all(), "cannot write nonfinite reference")
    data = TENSOR_MAGIC + struct.pack("<III", *tensor.shape) + tensor.astype("<f4").tobytes(order="C")
    path.write_bytes(data)
    return {"file": path.name, "shape": list(tensor.shape), "sha256": hashlib.sha256(data).hexdigest()}


def read_tensor(path):
    size = path.stat().st_size
    require(20 <= size <= 20 + MAX_ELEMENTS * 4, "invalid tensor file size")
    data = path.read_bytes()
    require(data[:8] == TENSOR_MAGIC, "invalid tensor magic")
    shape = struct.unpack_from("<III", data, 8)
    require(all(v > 0 for v in shape) and math.prod(shape) <= MAX_ELEMENTS,
            "invalid tensor dimensions")
    require(len(data) == 20 + math.prod(shape) * 4, "truncated or trailing tensor data")
    array = np.frombuffer(data, dtype="<f4", offset=20).reshape(shape)
    require(np.isfinite(array).all(), "nonfinite tensor values")
    return array


def make_input(variant, case, seed):
    require(variant in VARIANTS and case in CASES, "unknown variant/case")
    y, x = np.indices((1024, 1024))
    if case == "zero":
        image = np.zeros((3, 1024, 1024), np.float32)
    elif case == "noisy":
        rng = np.random.default_rng(seed)
        image = (np.float32(0.2) + rng.normal(0, 0.02, (3, 1024, 1024)).astype(np.float32))
    else:
        # Color ramps, abrupt vertical/horizontal transitions, negative samples,
        # and values above one exercise padding, nonlinearities and residuals.
        ramp = (x / 1023).astype(np.float32)
        image = np.stack((ramp * 1.2 - 0.05,
                          0.08 + (y >= 512).astype(np.float32) * 0.75,
                          0.1 + ((x // 32 + y // 32) % 2).astype(np.float32) * 0.6))
        image[:, 509:515, 509:515] += np.float32(0.2)
    if variant == "bayer":
        # The model origin is even sensor row, odd sensor column: G R / B G.
        mask = np.stack(((y % 2 == 0) & (x % 2 == 1), (y + x) % 2 == 0,
                         (y % 2 == 1) & (x % 2 == 0)))
        image *= mask
    elif variant == "xtrans":
        # Observed kIsRed/kIsGreen constants, origin aligned to a 6x6 cell.
        pattern = np.array([list(row) for row in
                            ("GBGGRG", "RGRBGB", "GBGGRG", "GRGGBG", "BGBRGR", "GRGGBG")])
        phase = pattern[y % 6, x % 6]
        image *= np.stack([phase == color for color in "RGB"])
    return np.ascontiguousarray(image, dtype=np.float32)


def generate(args):
    import coremltools as ct
    from coremltools.models.utils import load_spec

    source_digest = hashlib.sha256(args.model.read_bytes()).hexdigest()
    spec = load_spec(str(args.model))
    manifest, _ = export_spec(spec, args.variant, source_digest)
    args.destination.mkdir(parents=True, exist_ok=True)
    result = {"format_version": 1, "variant": args.variant, "source_sha256": source_digest,
              "weights_sha256": manifest["weights_sha256"], "platform": platform.platform(),
              "coremltools": ct.__version__, "numpy": np.__version__, "compute_units": "CPU_ONLY",
              "seed": args.seed, "scope": "network-only synthetic tensors", "cases": []}
    model = ct.models.MLModel(str(args.model), compute_units=ct.ComputeUnit.CPU_ONLY)
    for case in args.case or CASES:
        tensor = make_input(args.variant, case, args.seed)
        start = time.perf_counter()
        output = model.predict({spec.description.input[0].name: tensor})[spec.description.output[0].name]
        seconds = time.perf_counter() - start
        require(list(output.shape) == manifest["output_shape"], "runtime output shape mismatch")
        stem = f"{args.variant}-{case}"
        item = {"case": case, "input": write_tensor(args.destination / f"{stem}.input.f32", tensor),
                "output": write_tensor(args.destination / f"{stem}.coreml.f32", output),
                "seconds": seconds, "finite": True}
        if args.repeat:
            repeat = model.predict({spec.description.input[0].name: tensor})[spec.description.output[0].name]
            item["repeat_bit_exact"] = output.tobytes() == repeat.tobytes()
            require(item["repeat_bit_exact"], "Core ML repeated prediction changed")
        result["cases"].append(item)
        print(json.dumps(item), flush=True)
        # Each invocation produces its own complete selected-case manifest.
        (args.destination / f"{args.variant}-references.json").write_text(json.dumps(result, indent=2) + "\n")


def compare(reference, actual):
    expected, observed = read_tensor(reference), read_tensor(actual)
    require(expected.shape == observed.shape, "tensor shape mismatch")
    delta = observed.astype(np.float64) - expected.astype(np.float64)
    absolute = np.abs(delta)
    equal_bits = expected.view(np.uint32) == observed.view(np.uint32)
    return {"shape": list(expected.shape), "elements": int(expected.size),
            "max_absolute_error": float(absolute.max()), "mean_absolute_error": float(absolute.mean()),
            "rmse": float(np.sqrt(np.mean(delta * delta))), "bit_exact": bool(equal_bits.all()),
            "bit_exact_elements": int(equal_bits.sum()),
            "reference_sha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
            "actual_sha256": hashlib.sha256(actual.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    gen = commands.add_parser("generate", help="generate network-only Core ML references")
    gen.add_argument("model", type=Path)
    gen.add_argument("destination", type=Path)
    gen.add_argument("--variant", choices=VARIANTS, required=True)
    gen.add_argument("--case", choices=CASES, action="append")
    gen.add_argument("--seed", type=int, default=20261103)
    gen.add_argument("--repeat", action="store_true")
    cmp = commands.add_parser("compare", help="compare two PBDT0001 tensor files")
    cmp.add_argument("reference", type=Path)
    cmp.add_argument("actual", type=Path)
    cmp.add_argument("--max-abs", type=float, help="fail if max absolute error exceeds this explicit limit")
    cmp.add_argument("--rmse", type=float, help="fail if RMSE exceeds this explicit limit")
    cmp.add_argument("--require-bit-exact", action="store_true")
    cmp.add_argument("--json", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "generate":
            generate(args)
        else:
            for limit in (args.max_abs, args.rmse):
                require(limit is None or (math.isfinite(limit) and limit >= 0), "invalid tolerance")
            result = compare(args.reference, args.actual)
            result["passes_explicit_limits"] = ((args.max_abs is None or result["max_absolute_error"] <= args.max_abs)
                and (args.rmse is None or result["rmse"] <= args.rmse)
                and (not args.require_bit_exact or result["bit_exact"]))
            result["limits"] = {"max_absolute_error": args.max_abs, "rmse": args.rmse,
                                "require_bit_exact": args.require_bit_exact}
            output = json.dumps(result, indent=2) + "\n"
            if args.json:
                args.json.write_text(output)
            print(output, end="")
            if not result["passes_explicit_limits"]:
                parser.exit(1, "comparison exceeded explicit limits\n")
    except (ValueError, OSError) as error:
        parser.exit(1, f"reference failed: {error}\n")


if __name__ == "__main__":
    main()
