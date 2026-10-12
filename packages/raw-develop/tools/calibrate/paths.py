"""Shared paths for the calibration scripts (env RAW_DEVELOP_FIXTURES / RAW_DEVELOP_REFS)."""
import os
FIX = os.path.expanduser(os.environ.get('RAW_DEVELOP_FIXTURES', '~/raw-develop-fixtures'))
REFS = os.path.expanduser(os.environ.get('RAW_DEVELOP_REFS', '~/raw-develop-refs'))
OUT = os.environ.get('RAW_DEVELOP_CALIB_OUT', '/tmp/raw-develop-calib')
os.makedirs(OUT, exist_ok=True)

import json, re, subprocess
from functools import lru_cache

PROFILES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'profiles')
PROFILE = os.environ.get('RAW_DEVELOP_PROFILE', os.path.join(PROFILES, 'fujifilm-x-e5.toml'))

@lru_cache(maxsize=None)
def meta(stem):
    """Sensor geometry and levels for one fixture, read with exiftool."""
    j = json.loads(subprocess.run(
        ['exiftool', '-j', '-n', '-RawImageFullSize', '-RawImageCropTopLeft', '-RawImageCroppedSize',
         '-BlackLevel', '-XTransLayout', '-WB_GRBLevels', '-RawExposureBias', '-Model', f'{FIX}/{stem}.RAF'],
        capture_output=True, text=True, check=True).stdout)[0]
    ints = lambda k: [int(float(v)) for v in str(j[k]).split()]
    fw, fh = ints('RawImageFullSize'); top, left = ints('RawImageCropTopLeft'); cw, ch = ints('RawImageCroppedSize')
    lay = ints('XTransLayout')[::-1]  # stored in reverse raster order
    pat = [[('RGB')[lay[r * 6 + c]] for c in range(6)] for r in range(6)]
    return dict(full=(fw, fh), top=top, left=left, crop=(cw, ch), black=ints('BlackLevel')[0],
                pattern=pat, wb=ints('WB_GRBLevels'), reb=float(j.get('RawExposureBias', 0) or 0),
                model=str(j.get('Model', '')))

@lru_cache(maxsize=None)
def profile():
    """Minimal reader for the scalar and array keys of a profile TOML (no tomllib on py<3.11)."""
    text = open(PROFILE).read()
    out = {}
    for m in re.finditer(r'^(\w+)\s*=\s*(\[[^\]]*\]|[-\d.eE+]+)', text, re.M):
        v = m.group(2)
        out[m.group(1)] = [float(x) for x in re.findall(r'[-\d.eE+]+', v)] if v.startswith('[') else float(v)
    return out
