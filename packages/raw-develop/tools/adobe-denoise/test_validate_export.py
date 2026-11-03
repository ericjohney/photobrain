"""Synthetic PBDT/manifest tests; no RAW images or learned parameters required."""
import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

from validate_export import compare_region, inspect


class ExportValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.image = np.arange(3*8*10, dtype="f4").reshape(3,8,10) * np.float32(1/65535)

    def tearDown(self):
        self.temporary.cleanup()

    def export(self, name, areas, image=None):
        directory = self.root/name
        directory.mkdir()
        image = self.image if image is None else image
        records = []
        for i, (t,l,b,r) in enumerate(areas):
            a = image[:,t:b,l:r].copy()
            filename = f"tile-{i:04}.f32"
            (directory/filename).write_bytes(b"PBDT0001"+struct.pack("<3I",*a.shape)+a.astype("<f4").tobytes())
            records.append({"file":filename,"rect":[t,l,b,r],"shape":list(a.shape)})
        manifest = {"complete":True,"image_bounds":[0,0,8,10],"active_crop":[1,2,7,9],
                    "strength":50,"source_sha256":"a"*64,"source":"missing-synthetic-raw",
                    "model":{"variant":"xtrans"},"baseline_model":{"variant":"xtrans_details"},
                    "tiles_expected":len(records),"tiles":records}
        (directory/"manifest.json").write_text(json.dumps(manifest))
        return directory

    def test_full_coverage_and_cross_tile_region(self):
        full=inspect(self.export("full",[(0,0,4,10),(4,0,8,10)]),True)
        region=inspect(self.export("region",[(2,3,6,8)]))
        self.assertEqual(full["pixels_covered_once"],80)
        self.assertEqual(full["samples_checked"],240)
        self.assertEqual(compare_region(full,region)["samples_compared"],60)

    def test_overlap_and_gap_rejected(self):
        for name,areas in [("overlap",[(0,0,5,10),(4,0,8,10)]),("gap",[(0,0,3,10),(4,0,8,10)])]:
            with self.subTest(name=name),self.assertRaises(ValueError):inspect(self.export(name,areas),True)

    def test_float_corruption_rejected(self):
        for name,value in [("nan",np.nan),("range",1.5),("off-lattice",0.1234567)]:
            image=self.image.copy();image[0,0,0]=value
            with self.subTest(name=name),self.assertRaises(ValueError):inspect(self.export(name,[(0,0,8,10)],image),True)

    def test_full_strength_finite_headroom_is_retained(self):
        image=self.image.copy();image[0,0,0]=-0.2;image[2,7,9]=1.5
        directory=self.export("headroom",[(0,0,8,10)],image)
        with self.assertRaisesRegex(ValueError,"outside unit range"):inspect(directory)
        manifest=json.loads((directory/"manifest.json").read_text());manifest["strength"]=100
        (directory/"manifest.json").write_text(json.dumps(manifest))
        report=inspect(directory,True)
        self.assertFalse(report["all_in_unit_range"])
        self.assertTrue(report["all_finite"])
        self.assertIsNone(report["all_u16_normalized_exact"])

    def test_region_mismatch_rejected(self):
        full=inspect(self.export("full",[(0,0,8,10)]),True)
        image=self.image.copy();image[0,2,3]=np.float32(500/65535)
        region=inspect(self.export("region",[(2,3,6,8)],image))
        with self.assertRaisesRegex(ValueError,"bit mismatch"):compare_region(full,region)

    def test_incomplete_or_partial_full_export_rejected(self):
        path=self.export("partial",[(1,1,7,9)])
        with self.assertRaisesRegex(ValueError,"full canonical"):inspect(path,True)
        manifest=json.loads((path/"manifest.json").read_text());manifest["complete"]=False
        (path/"manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,"incomplete"):inspect(path)


if __name__ == "__main__":
    unittest.main()
