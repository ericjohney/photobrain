#!/usr/bin/env python3
"""Check Rust-generated ONNX and compare its CPU execution with a Rust tensor.

Requires onnx==1.17.0, onnxruntime==1.20.1 and numpy. All models stay external.
This verifies export semantics; it does not measure CUDA or Adobe agreement.
"""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
import onnx
import onnxruntime as ort


def tensor(path):
    data = path.read_bytes()
    if data[:8] != b"PBDT0001":
        raise ValueError("not a PBDT tensor")
    shape = struct.unpack_from("<3I", data, 8)
    return np.frombuffer(data, dtype="<f4", offset=20).reshape((1, *shape))


def check(binary, bundle, input_path, reference_path):
    with tempfile.TemporaryDirectory(prefix="photobrain-onnx-check-") as temporary:
        path = Path(temporary) / "model.onnx"
        subprocess.run([str(binary), "onnx", str(bundle), str(path)], check=True)
        model = onnx.load(path)
        onnx.checker.check_model(model, full_check=True)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        session = ort.InferenceSession(path.read_bytes(), sess_options=options,
                                       providers=["CPUExecutionProvider"])
        actual = session.run(None, {"v0": tensor(input_path)})[0]
        expected = tensor(reference_path)
        if actual.shape != expected.shape or not np.isfinite(actual).all():
            raise ValueError("invalid ONNX output")
        delta = actual.astype(np.float64) - expected.astype(np.float64)
        maximum = float(np.max(np.abs(delta)))
        rms = float(np.sqrt(np.mean(delta * delta)))
        if maximum >= 0.0002 or rms >= 0.00001:
            raise ValueError(f"ONNX/Rust difference: max={maximum}, rms={rms}")
        return dict(model=bundle.name, nodes=len(model.graph.node),
                    max_abs_vs_rust=maximum, rms_vs_rust=rms,
                    checker=True, onnx=onnx.__version__, onnxruntime=ort.__version__)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["binary", "bundle", "input", "reference"]:
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    print(json.dumps(check(args.binary.resolve(), args.bundle, args.input, args.reference)))


if __name__ == "__main__":
    main()
