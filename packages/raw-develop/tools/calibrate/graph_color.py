#!/usr/bin/env python3
"""Derive a profile's look matrices and exposure from RawCamera render graphs.

RawCamera's graph (`graph.txt` from tools/apple-reference) contains, after highlight
recovery, two `color_matrix` nodes in linear Adobe RGB (1998):

    camera  : unbalanced camera RGB (white level 1) -> linear Adobe RGB
    exposure: diagonal gain 2^baselineExposure with bias -black_render * gain

Our pipeline computes, on white-balanced camera RGB,

    P3 = look(T) . XYZ_D50->P3 . ForwardMatrix(T)  (then (x - black_render) * 2^ev)

so each graph gives an exact implied look matrix at that file's colour temperature:

    look(T) = AdobeRGB->P3 . camera . diag(1/wb) . inv(XYZ_D50->P3 . FM(T))

Two or more graphs at different temperatures are least-squares fitted to the profile's
two white-preserving look matrices (interpolated in 1/T like the DNG matrices).

Usage:
    RAW_DEVELOP_PROFILE=profiles/sony-ilce-7cr.toml python graph_color.py GRAPH...
"""
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dng import FM1, FM2, XYZD50_to_P3, interp, neutral_to_cct  # noqa: E402

# Linear Adobe RGB (1998) and Display P3 to XYZ (D65).
ADOBE_TO_XYZ = np.array([[0.5767309, 0.1855540, 0.1881852], [0.2973769, 0.6273491, 0.0752741], [0.0270343, 0.0706872, 0.9911085]])
P3_TO_XYZ = np.array([[0.48657, 0.26567, 0.19822], [0.22897, 0.69174, 0.07929], [0.0, 0.04511, 1.04394]])
ADOBE_TO_P3 = np.linalg.inv(P3_TO_XYZ) @ ADOBE_TO_XYZ


def parse(path):
    t = open(path).read()
    mats = re.findall(r"color_matrix r=\(([^)]*)\) g=\(([^)]*)\) b=\(([^)]*)\)", t)
    rows = lambda m: np.array([[float(x) for x in r.split()[:3]] for r in m])  # noqa: E731
    exposure = rows(mats[0])
    camera = rows(mats[1])
    bias = re.search(r"color_matrix r=\([^)]*\) g=\([^)]*\) b=\([^)]*\) a=\([^)]*\) bias=\(([-\d.e]+)", t)
    gain = exposure[0, 0]
    black_render = -float(bias.group(1)) / gain if bias else 0.0
    wb = [float(x) for x in re.search(r"RAWRecoverHighlightsV2\(src,factors=\[([^\]]*)\]", t).group(1).split()]
    return camera, np.log2(gain), black_render, np.array(wb)


def w_of(T):
    T = min(max(T, 2856), 6504)
    return (1 / T - 1 / 6504) / (1 / 2856 - 1 / 6504)


def main():
    rows = []
    for g in sys.argv[1:]:
        camera, ev, br, wb = parse(g)
        neutral = 1 / wb
        T = neutral_to_cct(neutral)
        base = XYZD50_to_P3 @ interp(T, FM1, FM2)
        look = ADOBE_TO_P3 @ camera @ np.diag(1 / wb) @ np.linalg.inv(base)
        # Normalise so white maps to white; the residual scale is exposure.
        s = (look @ np.ones(3)).mean()
        rows.append((g, T, look / s, ev + np.log2(s), br))
        print(f"{g}: T {T:.0f} K, exposure {ev:.4f} EV (+ matrix scale {np.log2(s):+.4f}), black_render {br:.5f}")
        print("   white residual", np.round(look / s @ np.ones(3) - 1, 5))
    # Fit look_matrix_1 (2856 K) and look_matrix_2 (6504 K): look(T) = w*A + (1-w)*D.
    W = np.array([w_of(T) for _, T, *_ in rows])
    L = np.stack([r[2] for r in rows])
    if len(rows) >= 2 and W.max() - W.min() > 0.05:
        X = np.stack([W, 1 - W], 1)
        coef = np.linalg.lstsq(X, L.reshape(len(rows), 9), rcond=None)[0]
        A, D = coef[0].reshape(3, 3), coef[1].reshape(3, 3)
    else:
        A = D = L.mean(0)
        print("only one colour temperature: look_matrix_1 = look_matrix_2")
    # Rows must sum to exactly 1 (white-preserving) after rounding.
    A, D = (np.column_stack([m[:, 0], m[:, 1], 1 - m[:, 0] - m[:, 1]]) for m in (np.round(A, 6), np.round(D, 6)))
    fmt = lambda m: "[\n  " + ",\n  ".join(", ".join(f"{v:.6f}" for v in r) for r in m) + ",\n]"  # noqa: E731
    print(f"baseline_exposure = {np.mean([r[3] for r in rows]):.4f}")
    print(f"black_render = {np.mean([r[4] for r in rows]):.4f}")
    print("look_matrix_1 =", fmt(A))
    print("look_matrix_2 =", fmt(D))
    for g, T, look, *_ in rows:
        w = w_of(T)
        print(f"{os.path.basename(os.path.dirname(g))}: fit residual {np.abs(w * A + (1 - w) * D - look).max():.5f}")


if __name__ == "__main__":
    main()
