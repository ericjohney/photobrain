"""Companion integrity and semantic rejection, using generated models only."""
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest

from coremltools.models.utils import save_spec
from export import export_model
from prepare_coreml import prepare, details_spec
from test_tools import model
from test_details import fixture, pack
from export_details import export_graph


class PrepareCoreMlTests(unittest.TestCase):
    def test_original_model_binding_and_reject_wrong_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, bundle = root / "source.mlmodel", root / "denoiser.pbdn"
            save_spec(model(), str(source))
            export_model(source, bundle, "bayer")
            result = prepare(bundle, source)
            self.assertEqual(result["bundle_sha256"], hashlib.sha256(bundle.read_bytes()).hexdigest())
            self.assertEqual(bundle.with_suffix(".mlmodel").read_bytes(), source.read_bytes())
            self.assertEqual(json.loads(bundle.with_suffix(".coreml.json").read_text()), result)
            self.assertEqual(prepare(bundle, source), result)
            changed = model(); changed.neuralNetwork.layers[1].convolution.bias.float16Value = struct.pack("<3e", 3, 2, 1)
            save_spec(changed, str(source))
            with self.assertRaisesRegex(ValueError, "does not reproduce"):
                prepare(bundle, source, True)
            self.assertEqual(json.loads(bundle.with_suffix(".coreml.json").read_text()), result)

    def test_details_reconstruction_rejects_unrepresented_attributes(self):
        graph, shapes, blobs = fixture()
        header, payload = export_graph(graph, shapes, pack(blobs), "0" * 64)
        self.assertGreater(len(details_spec(header, payload)), len(payload))
        for field, value in [("stride", [2, 1]), ("groups", 2), ("padding", [1, 0, 0, 0])]:
            changed = json.loads(json.dumps(header)); changed["layers"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                details_spec(changed, payload)


if __name__ == "__main__":
    unittest.main()
