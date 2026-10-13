#!/usr/bin/env python3
"""Transcribe RawCamera render graphs into a profile's [[noise]] table.

Usage:
    python noise_table.py GRAPH [GRAPH ...] > noise.toml

Each GRAPH is a `graph.txt` written by `tools/apple-reference` (CI_PRINT_TREE output) for
one file of the camera. ISO is taken from `--iso FILE=ISO` overrides, else from a sibling
`params.json`/`iso` hint, else from the path (`ISO800`), else from the source RAW given
with `--raw-dir` (exiftool). One entry is written per distinct ISO (first graph wins).

The field mapping is documented in docs/adding-a-camera.md (step 8) and
docs/camera-profiles.md. The output is TOML text to paste into profiles/<camera>.toml.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys

PASS_KINDS = {
    "powerBlurL": "plain",
    "powerBlurEarlyOutL": "early_out",
    "powerBlurLHF": "hf",
    "powerBlurEarlyOutLHFi": "hf_early_out",
    "powerBlurEarlyOut2L": "early_out2",
    "powerBlurDespeckleL": "despeckle",
}

LEVEL_KINDS = {
    "expandPlusDWithOverdrive": "plain",
    "expandPlusDThruG": "thru_g",
    "expandPlusDThruG2": "thru_g2",
    "expandPlusDThruG3": "thru_g3",
}


def vec(args, name):
    m = re.search(r"(?<![A-Za-z0-9])" + name + r"=\[([^\]]*)\]", args)
    if m:
        return [float(x) for x in m.group(1).split()]
    m = re.search(r"(?<![A-Za-z0-9])" + name + r"=([-\d.e+]+)", args)
    return [float(m.group(1))] if m else None


def parse_tree(text, root_kernel):
    """Parse the CI_PRINT_TREE subtree rooted at the first `root_kernel` node."""
    lines = text.split("\n")
    start = next(i for i, l in enumerate(lines) if root_kernel + "(" in l)
    base = lines[start].index("kernel") if "colorkernel" not in lines[start] else lines[start].index("colorkernel")
    labels, stack, nodes = {}, [], []
    pat = re.compile(r"(kernel|colorkernel|clampRect|crop|affine|colormatch|setprops|samplemode|provider|IOSurface|<\d+>)")
    for line in lines[start:]:
        m = pat.search(line)
        if not m:
            continue
        col = m.start()
        if col <= base and nodes:
            break
        txt = line[col:]
        lab = re.search(r" <(\d+)>\s*$", txt)
        if txt.startswith("<"):
            node, new = labels[int(re.match(r"<(\d+)>", txt).group(1))], False
        else:
            km = re.match(r"(?:colorkernel|kernel) (\w+)\((.*?)\)(?: outputFormat| roi=|$)", txt)
            node = {"k": km.group(1) if km else txt.split()[0], "args": km.group(2) if km else "", "c": []}
            if lab:
                labels[int(lab.group(1))] = node
            new = True
        while stack and stack[-1][0] >= col:
            stack.pop()
        if stack:
            stack[-1][1]["c"].append(node)
        if new:
            stack.append((col, node))
        nodes.append(node)
    return nodes[0]


def dir_info(a):
    if a["k"] == "annealG":
        return {"anneal": vec(a["args"], "threshmodel")[:3]}
    assert a["k"] == "annealGAndC", a["k"]
    d = a["c"][0]
    assert d["k"] == "DIRToC", d["k"]
    return {
        "dir_to_c": vec(d["args"], "params")[:3],
        "cfactor": vec(a["args"], "cfactor")[0],
        "anneal": vec(a["args"], "threshmodel")[:3],
    }


def sharpen_chain(n, diff):
    out = []
    while n["k"] in ("smoothDSharpen", "smoothDSharpenAntiBloom"):
        # parms (4) + parms2 (3); AntiBloom adds parms2.a, the anti-bloom range.
        out.append(vec(n["args"], "parms") + vec(n["args"], "parms2"))
        n = n["c"][0]
    assert n is diff
    return list(reversed(out))


def walk_levels(n, out):
    k = n["k"]
    if k == "reduce":
        return
    walk_levels(n["c"][0], out)
    if k not in LEVEL_KINDS:
        raise SystemExit(f"unsupported luma level kernel {k} (port it first)")
    e = {"kind": LEVEL_KINDS[k]}
    if k == "expandPlusDWithOverdrive":
        od = vec(n["args"], "overdrive")[0]
        if od:
            e["overdrive"] = od
    else:
        e["parms"] = vec(n["args"], "parms")
        e["roparms"] = vec(n["args"], "roparms")
        e["omparms"] = vec(n["args"], "omparms")[:2]
        if k == "expandPlusDThruG2":
            e.update(dir_info(n["c"][2]))
        else:
            diff, sd, gr = n["c"][1], n["c"][2], n["c"][3]
            e.update(dir_info(gr))
            sh = [] if sd is diff else sharpen_chain(sd, diff)
            if sh:
                e["sharpen"] = sh
    out.append(e)


def entry(text):
    rn = vec(re.search(r"deXtrans_v8\(([^)]*)\)|deBayer_v8\(([^)]*)\)", text).group(0), "rn")
    passes = []
    for m in re.finditer(r"kernel (powerBlur[A-Za-z0-9]*)\((.*?)\) outputFormat", text):
        name, args = m.groups()
        if name not in PASS_KINDS:
            raise SystemExit(f"unsupported chroma pass {name} (port it first)")
        p = {"kind": PASS_KINDS[name], "scale": int(vec(args, "params")[3]), "threshold": vec(args, "params2")}
        it = vec(args, "interpolant")
        if it and it[0]:
            p["interpolant"] = it[0]
        if name == "powerBlurDespeckleL":
            p["despeckle"] = vec(args, "params3") + vec(args, "params4") + vec(args, "params5") + vec(args, "params6")[:1]
        elif name == "powerBlurEarlyOut2L":
            p["despeckle"] = vec(args, "params3")[:2]
        passes.append(p)
    passes.reverse()  # the graph prints the outermost pass first
    ex = re.search(r"kernel (extractHRGB\w*)\(", text).group(1)
    root = parse_tree(text, "YAndRGBGather")
    levels = []
    walk_levels(root["c"][0], levels)
    g2 = re.search(r"gaborToSYAndG\(src,([^)]*)\)", text)
    for lv in levels:
        if lv["kind"] == "thru_g2":
            lv["gabor"] = vec(g2.group(1), "smoothAmt") + vec(g2.group(1), "f1") + vec(g2.group(1), "f2")[:2]
    levels.reverse()  # finest first
    return {"demosaic_noise": rn, "moire_detect": ex == "extractHRGBHF", "chroma_passes": passes, "luma": levels}


def num(x):
    if float(x).is_integer() and abs(x) < 1e15:
        return str(int(x))
    return f"{x:.6g}"


def arr(v):
    return "[" + ", ".join(num(x) for x in v) + "]"


def emit(iso, e):
    out = ["[[noise]]", f"iso = {num(iso)}", f"demosaic_noise = {arr(e['demosaic_noise'])}", f"moire_detect = {str(e['moire_detect']).lower()}"]
    for p in e["chroma_passes"]:
        out += ["[[noise.chroma_passes]]", f'kind = "{p["kind"]}"', f"scale = {p['scale']}", f"threshold = {arr(p['threshold'])}"]
        if "interpolant" in p:
            out.append(f"interpolant = {num(p['interpolant'])}")
        if "despeckle" in p:
            out.append(f"despeckle = {arr(p['despeckle'])}")
    for lv in e["luma"]:
        out += ["[[noise.luma]]", f'kind = "{lv["kind"]}"']
        for key in ["overdrive", "parms", "roparms", "omparms", "dir_to_c", "cfactor", "anneal"]:
            if key in lv:
                v = lv[key]
                out.append(f"{key} = {arr(v) if isinstance(v, list) else num(v)}")
        if "sharpen" in lv:
            out.append("sharpen = [" + ", ".join(arr(s) for s in lv["sharpen"]) + "]")
        if "gabor" in lv:
            out.append(f"gabor = {arr(lv['gabor'])}")
    return "\n".join(out)


def iso_for(path, overrides, raw_dir):
    if path in overrides:
        return overrides[path]
    m = re.search(r"ISO(\d+)", path)
    if m:
        return int(m.group(1))
    hint = os.path.join(os.path.dirname(path), "iso")
    if os.path.exists(hint):
        return int(open(hint).read().strip())
    if raw_dir:
        stem = os.path.basename(os.path.dirname(path))
        cands = glob.glob(os.path.join(raw_dir, stem + ".*"))
        if cands:
            o = subprocess.run(["exiftool", "-n", "-ISO", "-s3", cands[0]], capture_output=True, text=True).stdout
            return int(float(o.split()[0]))
    raise SystemExit(f"cannot determine ISO for {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("graphs", nargs="+")
    ap.add_argument("--raw-dir", help="directory holding the source RAWs (ISO via exiftool)")
    ap.add_argument("--iso", action="append", default=[], help="GRAPH=ISO override")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of TOML")
    a = ap.parse_args()
    overrides = {k: int(v) for k, v in (s.split("=", 1) for s in a.iso)}
    rows = {}
    for g in a.graphs:
        iso = iso_for(g, overrides, a.raw_dir)
        if iso not in rows:
            rows[iso] = entry(open(g).read())
    if a.json:
        json.dump(rows, sys.stdout, indent=1)
    else:
        print("\n\n".join(emit(iso, rows[iso]) for iso in sorted(rows)))


if __name__ == "__main__":
    main()
