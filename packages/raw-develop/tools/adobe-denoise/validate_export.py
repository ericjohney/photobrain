#!/usr/bin/env python3
"""Validate raw-denoise exports without Adobe assets or network execution.

Requires NumPy. Full/region comparisons operate on serialized float bits, preserving
signed zero. A partial-strength export must also lie on the normalized u16 lattice.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            result.update(chunk)
    return result.hexdigest()


def tensor(path):
    with open(path, "rb") as handle:
        header = handle.read(20)
    require(len(header) == 20 and header[:8] == b"PBDT0001", f"invalid tensor: {path}")
    shape = struct.unpack("<3I", header[8:])
    require(all(shape) and shape[0] == 3 and max(shape[1:]) <= 4096, f"invalid RGB shape: {path}")
    require(path.stat().st_size == 20 + 4 * int(np.prod(shape)), f"invalid size: {path}")
    return np.memmap(path, mode="r", dtype="<f4", offset=20, shape=shape)


def rect(value):
    require(isinstance(value, list) and len(value) == 4
            and all(type(v) is int for v in value), "invalid rectangle")
    t, l, b, r = value
    require(t < b and l < r, "empty/inverted rectangle")
    return t, l, b, r


def contains(outer, inner):
    t, l, b, r = outer
    tt, ll, bb, rr = inner
    return t <= tt < bb <= b and l <= ll < rr <= r


def inspect(directory, full_image=False):
    directory = Path(directory).resolve()
    manifest_path = directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get("complete") is True, "export is incomplete")
    bounds = rect(manifest["image_bounds"])
    crop = rect(manifest["active_crop"])
    require(contains(bounds, crop), "active crop outside canonical bounds")
    records = manifest["tiles"]
    require(records and len(records) == manifest["tiles_expected"], "tile count mismatch")
    rectangles = [rect(record["rect"]) for record in records]
    extent = (min(r[0] for r in rectangles), min(r[1] for r in rectangles),
              max(r[2] for r in rectangles), max(r[3] for r in rectangles))
    require(contains(bounds, extent), "tiles outside canonical bounds")
    if full_image:
        require(extent == bounds, "export does not span full canonical bounds")
    t, l, b, r = extent
    # One byte per pixel; reject overlap before writing so counters cannot wrap.
    require(b-t <= 65536 and r-l <= 65536 and (b-t)*(r-l) <= 256*1024*1024,
            "export extent exceeds validation allocation limits")
    coverage = np.zeros((b - t, r - l), dtype=np.uint8)
    samples, tiles, files = 0, [], set()
    all_in_unit_range = True
    strength = manifest.get("strength", 100)
    require(type(strength) is int and 1 <= strength <= 100, "invalid strength")
    partial = strength < 100
    for record, area in zip(records, rectangles):
        filename = record["file"]
        require(isinstance(filename, str) and filename == Path(filename).name
                and filename not in files, "invalid/duplicate tensor filename")
        files.add(filename)
        path = directory / filename
        a = tensor(path)
        tt, ll, bb, rr = area
        require(list(a.shape) == record["shape"] == [3, bb - tt, rr - ll], "tile shape mismatch")
        covered = coverage[tt-t:bb-t, ll-l:rr-l]
        require(not covered.any(), "overlapping output tiles")
        covered[:] = 1
        require(np.isfinite(a).all(), f"nonfinite output: {filename}")
        in_unit_range = bool((a >= 0).all() and (a <= 1).all())
        all_in_unit_range = all_in_unit_range and in_unit_range
        if partial:
            require(in_unit_range, f"partial output outside unit range: {filename}")
            normalized = np.rint(a * np.float32(65535)).astype("u2").astype("f4") * np.float32(1/65535)
            require(np.array_equal(a.view("u4"), normalized.view("u4")), f"not normalized u16: {filename}")
        samples += int(a.size)
        tiles.append({"file": filename, "rect": list(area), "shape": list(a.shape), "sha256": digest(path)})
    require(coverage.all(), "gap in rectangular export coverage")
    source_path = Path(manifest.get("source", ""))
    source_verified = False
    if source_path.is_file():
        require(digest(source_path) == manifest["source_sha256"], "source digest mismatch")
        source_verified = True
    report = {"directory": str(directory), "manifest_sha256": digest(manifest_path),
              "image_bounds": list(bounds), "active_crop": list(crop), "export_bounds": list(extent),
              "full_image": extent == bounds, "strength": strength, "tile_count": len(tiles),
              "pixels_covered_once": int(coverage.size), "samples_checked": samples,
              "all_finite": True, "all_in_unit_range": all_in_unit_range,
              "all_u16_normalized_exact": True if partial else None,
              "source": manifest.get("source"), "source_sha256": manifest.get("source_sha256"),
              "source_file_digest_verified": source_verified,
              "model": manifest.get("model"), "baseline_model": manifest.get("baseline_model"), "tiles": tiles}
    return report


def compare_region(reference, region):
    for field in ("image_bounds", "active_crop", "strength", "source_sha256", "model", "baseline_model"):
        require(reference[field] == region[field], f"region identity differs: {field}")
    require(contains(reference["export_bounds"], region["export_bounds"]), "region outside reference export")
    compared = 0
    for tile in region["tiles"]:
        area = tile["rect"]
        t, l, b, r = area
        actual = tensor(Path(region["directory"]) / tile["file"])
        for base in reference["tiles"]:
            tt, ll, bb, rr = base["rect"]
            it, il, ib, ir = max(t, tt), max(l, ll), min(b, bb), min(r, rr)
            if it >= ib or il >= ir:
                continue
            expected = tensor(Path(reference["directory"]) / base["file"])
            a = actual[:, it-t:ib-t, il-l:ir-l]
            e = expected[:, it-tt:ib-tt, il-ll:ir-ll]
            require(np.array_equal(a.view("u4"), e.view("u4")), f"region bit mismatch: {tile['file']}")
            compared += int(a.size)
    require(compared == region["samples_checked"], "region comparison coverage mismatch")
    return {"directory": region["directory"], "manifest_sha256": region["manifest_sha256"],
            "rect": region["export_bounds"], "tile_count": region["tile_count"],
            "samples_compared": compared, "bit_mismatches": 0,
            "tiles": region["tiles"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("directory", type=Path)
    validate.add_argument("--full-image", action="store_true")
    validate.add_argument("--compare-region", type=Path, action="append", default=[])
    validate.add_argument("--json", type=Path, required=True, dest="report")
    args = parser.parse_args()
    report = inspect(args.directory, args.full_image)
    report["regions"] = [compare_region(report, inspect(path)) for path in args.compare_region]
    report["complete"] = True
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("complete", "tile_count", "pixels_covered_once", "samples_checked")}))


if __name__ == "__main__":
    main()
