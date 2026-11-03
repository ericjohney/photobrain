"""Small synthetic fixtures; no Adobe weights or RAW files are needed."""

from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np
from coremltools.proto import Model_pb2

from export import export_spec
from reference import compare, make_input, read_tensor, write_tensor


def model():
    spec = Model_pb2.Model()
    spec.specificationVersion = 4
    for features, name, edge in ((spec.description.input, "mosaick", 1024),
                                  (spec.description.output, "output", 800)):
        f = features.add()
        f.name = name
        f.type.multiArrayType.shape.extend([3, edge, edge])
        f.type.multiArrayType.dataType = 65568
    net = spec.neuralNetwork
    net.arrayInputShapeMapping = net.imageInputShapeMapping = 1

    def layer(name, source, target):
        l = net.layers.add()
        l.name = name
        l.input.extend([source])
        l.output.extend([target])
        return l

    layer("expand", "mosaick", "expanded").expandDims.axes.append(0)
    conv = layer("conv", "expanded", "convolved").convolution
    conv.outputChannels = conv.kernelChannels = 3
    conv.nGroups = 1
    conv.kernelSize.extend([1, 1])
    conv.stride.extend([1, 1])
    conv.dilationFactor.extend([1, 1])
    conv.valid.paddingAmounts.borderAmounts.add()
    conv.valid.paddingAmounts.borderAmounts.add()
    conv.hasBias = True
    conv.weights.float16Value = struct.pack("<9e", *range(9))
    conv.bias.float16Value = struct.pack("<3e", 0, 1, 2)
    layer("squeeze", "convolved", "squeezed").squeeze.axes.append(0)
    for name, source, target, axis in (("crop_y", "squeezed", "cropped", 1),
                                      ("crop_x", "cropped", "output", 2)):
        p = layer(name, source, target).slice
        p.startIndex, p.endIndex, p.stride, p.axis = 112, 912, 1, axis
    return spec


class ExportTests(unittest.TestCase):
    def test_preserves_fp16_bytes_and_graph_indices(self):
        spec = model()
        manifest, weights = export_spec(spec, "bayer", "0" * 64)
        self.assertEqual(manifest["output"], 5)
        self.assertEqual(manifest["layers"][1]["inputs"], [1])
        self.assertEqual(manifest["layers"][1]["weights"], {"offset": 0, "count": 9})
        self.assertEqual(manifest["layers"][1]["bias"], {"offset": 9, "count": 3})
        self.assertEqual(weights, struct.pack("<12e", *range(9), 0, 1, 2))

    def test_rejects_unsupported_convolution_attributes(self):
        for change in (lambda c: setattr(c, "isDeconvolution", True),
                       lambda c: c.dilationFactor.__setitem__(0, 2),
                       lambda c: setattr(c, "hasBias", False),
                       lambda c: setattr(c.weights, "float16Value", b""),
                       lambda c: setattr(c.weights, "float16Value", struct.pack("<9e", float("nan"), *range(8)))):
            with self.subTest(change=change):
                spec = model()
                change(spec.neuralNetwork.layers[1].convolution)
                with self.assertRaises(ValueError):
                    export_spec(spec, "bayer", "0" * 64)

    def test_rejects_foreign_layer_and_invalid_graph(self):
        spec = model()
        spec.neuralNetwork.layers[1].ClearField("convolution")
        spec.neuralNetwork.layers[1].activation.ReLU.SetInParent()
        with self.assertRaisesRegex(ValueError, "unsupported"):
            export_spec(spec, "bayer", "0" * 64)
        spec = model()
        spec.neuralNetwork.layers[1].input[0] = "future"
        with self.assertRaisesRegex(ValueError, "forward/missing"):
            export_spec(spec, "bayer", "0" * 64)
        spec = model()
        spec.neuralNetwork.layers[0].expandDims.axes[0] = 1
        with self.assertRaisesRegex(ValueError, "batch axis"):
            export_spec(spec, "bayer", "0" * 64)

    def test_rejects_optional_and_flexible_features(self):
        spec = model()
        spec.description.input[0].type.isOptional = True
        with self.assertRaisesRegex(ValueError, "unsupported"):
            export_spec(spec, "bayer", "0" * 64)
        spec = model()
        spec.description.input[0].type.multiArrayType.shapeRange.sizeRanges.add(lowerBound=3, upperBound=3)
        with self.assertRaisesRegex(ValueError, "unsupported"):
            export_spec(spec, "bayer", "0" * 64)


class ReferenceTests(unittest.TestCase):
    def test_roundtrip_and_sign_sensitive_bit_comparison(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "a", Path(root) / "b"
            write_tensor(a, np.array([[[0.0, 1.0]]], np.float32))
            write_tensor(b, np.array([[[-0.0, 1.0]]], np.float32))
            result = compare(a, b)
            self.assertEqual(result["max_absolute_error"], 0)
            self.assertFalse(result["bit_exact"])
            self.assertEqual(result["bit_exact_elements"], 1)
            self.assertEqual(read_tensor(a).shape, (1, 1, 2))

    def test_malformed_tensors_fail(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "tensor"
            valid = b"PBDT0001" + struct.pack("<III", 1, 1, 1) + struct.pack("<f", 1)
            invalid = [b"", valid[:-1], valid + b"x", b"OTHER000" + valid[8:],
                       b"PBDT0001" + struct.pack("<III", 0, 1, 1),
                       valid[:-4] + struct.pack("<f", float("inf"))]
            for data in invalid:
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    read_tensor(path)

    def test_sparse_cfa_phases(self):
        bayer = make_input("bayer", "noisy", 12)
        self.assertEqual(np.count_nonzero(bayer), 1024 * 1024)
        self.assertEqual(np.flatnonzero(bayer[:, 0, 0]).tolist(), [1])
        self.assertEqual(np.flatnonzero(bayer[:, 0, 1]).tolist(), [0])
        self.assertEqual(np.flatnonzero(bayer[:, 1, 0]).tolist(), [2])
        xtrans = make_input("xtrans", "noisy", 12)
        self.assertEqual(np.count_nonzero(xtrans), 1024 * 1024)
        self.assertEqual(np.flatnonzero(xtrans[:, 0, 1]).tolist(), [2])
        self.assertEqual(np.flatnonzero(xtrans[:, 0, 4]).tolist(), [0])


if __name__ == "__main__":
    unittest.main()
