#!/usr/bin/env python3
"""Export the recovered X-Trans Enhance Details Espresso graph with FP32 weights.

Caller supplies graph JSON, shape JSON, and framed Espresso weights. No assets
are downloaded or embedded. Only the observed graph dialect is accepted.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

MAGIC = b"PBDN0002"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse_blobs(raw):
    require(8 <= len(raw) <= 128_000_000, "invalid weights length")
    count, = struct.unpack_from("<Q", raw)
    require(0 < count <= 1024 and 8 + count * 16 <= len(raw), "invalid blob table")
    offset = 8 + count * 16
    blobs = {}
    for index in range(count):
        ident, size = struct.unpack_from("<QQ", raw, 8 + index * 16)
        require(ident == index, "expected sequential blob identifiers")
        require(offset + size <= len(raw), "truncated blob")
        blobs[ident] = raw[offset:offset + size]
        offset += size
    require(offset == len(raw), "trailing weight data")
    return blobs


def export_graph(graph, shapes, raw, source_sha256):
    require(set(graph) == {"storage", "properties", "format_version", "layers"}, "unknown graph fields")
    require(graph["storage"] == "model.espresso.weights" and graph["properties"] == {}
            and graph["format_version"] == 200, "unsupported graph metadata")
    require(set(shapes) == {"layer_shapes"}, "unknown shape fields")
    recorded = shapes["layer_shapes"]
    blobs = parse_blobs(raw)
    used = set()
    payload = bytearray()
    nodes = {"mosaick": (0, [3, 512, 512])}
    layers = []

    def shape_check(name, shape):
        require(recorded.get(name) == dict(k=shape[0], h=shape[1], w=shape[2], n=1),
                f"{name}: recorded shape mismatch")

    def append(name, inputs, shape, **op):
        require(name not in nodes, "duplicate tensor")
        layers.append(dict(name=name, inputs=inputs, **op))
        nodes[name] = (len(layers), shape)
        return len(layers)

    def weight(ident, count, bias=False):
        require(ident in blobs and ident not in used, "missing/reused weight blob")
        used.add(ident)
        data = blobs[ident]
        require(len(data) == count * (16 if bias else 4), "incorrect weight blob size")
        if bias:
            require(not any(data[count * 4:]), "unsupported nonzero bias padding")
            data = data[:count * 4]
        require(all(math.isfinite(v[0]) for v in struct.iter_unpack("<f", data)), "nonfinite weights")
        result = dict(offset=len(payload) // 4, count=count)
        payload.extend(data)
        return result

    shape_check("mosaick", [3, 512, 512])
    require(len(graph["layers"]) == 24, "unexpected layer count")
    for layer in graph["layers"]:
        kind = layer["type"]
        name = layer["name"]
        require(layer["top"] == name, "unexpected tensor naming")
        sources = layer["bottom"].split(",")
        require(all(s in nodes for s in sources), "missing/forward input")
        ids = [nodes[s][0] for s in sources]
        shape = list(nodes[sources[0]][1])
        if kind == "convolution":
            constants = dict(pad_r=0, fused_tanh=0, pad_fill_mode=0, pad_b=0, pad_l=0,
                             has_batch_norm=0, n_groups=1, pad_t=0, has_biases=1,
                             weights={}, pad_mode=0, pad_value=0, n_parallel=1)
            fields = set(constants) | {"fused_relu", "top", "blob_weights", "K", "blob_biases",
                                       "name", "type", "C", "bottom", "Nx", "Ny"}
            require(set(layer) == fields and all(layer[k] == v for k, v in constants.items()),
                    "unsupported convolution attributes")
            require(len(ids) == 1 and layer["K"] == shape[0] and 0 < layer["C"] <= 512,
                    "convolution channels")
            require(layer["Nx"] == layer["Ny"] and layer["Nx"] in (1, 3)
                    and layer["fused_relu"] in (0, 1), "convolution kernel/activation")
            c, k = layer["C"], layer["Nx"]
            shape = [c, shape[1] - k + 1, shape[2] - k + 1]
            conv_name = name + "_linear" if layer["fused_relu"] else name
            out = append(conv_name, ids, shape, op="conv2d", in_channels=layer["K"],
                         out_channels=c, groups=1, kernel=[k,k], stride=[1,1], padding=[0]*4,
                         weights=weight(layer["blob_weights"], c * layer["K"] * k * k),
                         bias=weight(layer["blob_biases"], c, True))
            if layer["fused_relu"]:
                append(name, [out], shape, op="leaky_relu", alpha=0.0)
        elif kind == "crop":
            require(set(layer) == {"bottom", "t", "weights", "l", "r", "top", "type", "name", "b"}
                    and layer["weights"] == {} and len(ids) == 2
                    and all(layer[k] == 20 for k in ("t", "b", "l", "r")), "unsupported crop")
            require(nodes[sources[1]][1][1:] == [shape[1]-40, shape[2]-40], "crop reference shape")
            h, w = shape[1:]
            out = append(name + "_y", ids[:1], [shape[0],h-40,w], op="slice", axis=1, start=20, end=h-20)
            shape = [shape[0],h-40,w-40]
            append(name, [out], shape, op="slice", axis=2, start=20, end=w-20)
        elif kind == "concat":
            require(set(layer) == {"weights", "top", "type", "name", "bottom"}
                    and layer["weights"] == {} and len(ids) == 2, "unsupported concat")
            second = nodes[sources[1]][1]
            require(shape[1:] == second[1:], "concat shape mismatch")
            shape[0] += second[0]
            append(name, ids, shape, op="concat")
        else:
            raise ValueError(f"unsupported operation: {kind}")
        shape_check(name, shape)
    require(set(recorded) == {"mosaick"} | {l["name"] for l in graph["layers"]}, "unused shape records")
    require(nodes.get("output") == (len(layers), [3,470,470]), "unexpected output")
    # Alignment and unused compiled parameter slots must contain only zeros.
    require(all(not any(data) for ident, data in blobs.items() if ident not in used), "nonzero unused blob")
    manifest = dict(format_version=2, variant="xtrans_details", source_sha256=source_sha256,
                    weights_sha256=hashlib.sha256(payload).hexdigest(), input_shape=[3,512,512],
                    output_shape=[3,470,470], output=len(layers), layers=layers)
    return manifest, bytes(payload)


def export_model(graph_path, shapes_path, weights_path, destination):
    parts = [p.read_bytes() for p in (graph_path, shapes_path, weights_path)]
    # Source identity hashes length-prefixed graph, shape, and blob bytes in order.
    digest = hashlib.sha256(b"".join(struct.pack("<Q",len(p)) + p for p in parts)).hexdigest()
    manifest, payload = export_graph(json.loads(parts[0]), json.loads(parts[1]), parts[2], digest)
    header = json.dumps(manifest, separators=(",", ":"), allow_nan=False).encode()
    require(len(header) <= 1 << 20, "oversized manifest")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(MAGIC + struct.pack("<I", len(header)) + header + payload)
    return manifest



def save_coreml(manifest, payload, destination):
    """Reconstruct a CPU-reference model; weights retain their original f32 bits."""
    import numpy as np
    import coremltools as ct
    from coremltools.models import datatypes
    from coremltools.models.neural_network import NeuralNetworkBuilder

    weights = np.frombuffer(payload, dtype="<f4")
    builder = NeuralNetworkBuilder(
        [("mosaick", datatypes.Array(*manifest["input_shape"]))],
        [("output", datatypes.Array(*manifest["output_shape"]))],
        disable_rank5_shape_mapping=False)
    names = ["mosaick"]
    for layer in manifest["layers"]:
        inputs = [names[i] for i in layer["inputs"]]
        name, op = layer["name"], layer["op"]
        names.append(name)
        if op == "conv2d":
            span = layer["weights"]
            matrix = weights[span["offset"]:span["offset"]+span["count"]].reshape(
                layer["out_channels"],layer["in_channels"],*layer["kernel"]).transpose(2,3,1,0)
            span = layer["bias"]
            bias = weights[span["offset"]:span["offset"]+span["count"]]
            builder.add_convolution(name,layer["in_channels"],layer["out_channels"],
                                    *layer["kernel"],1,1,"valid",1,matrix,bias,True,
                                    input_name=inputs[0],output_name=name)
        elif op == "leaky_relu":
            require(layer["alpha"] == 0, "reference supports ReLU only")
            builder.add_activation(name,"RELU",inputs[0],name)
        elif op == "slice":
            builder.add_slice(name,inputs[0],name,"height" if layer["axis"] == 1 else "width",
                              layer["start"],layer["end"],1)
        elif op == "concat":
            builder.add_elementwise(name,inputs,name,"CONCAT")
        else:
            raise ValueError(f"unsupported reference operation: {op}")
    builder.spec.specificationVersion = 4
    for feature in list(builder.spec.description.input) + list(builder.spec.description.output):
        feature.type.multiArrayType.dataType = 65568
    ct.utils.save_spec(builder.spec, str(destination))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("graph", "shapes", "weights", "destination"):
        parser.add_argument(name, type=Path)
    parser.add_argument("--coreml", type=Path, help="also reconstruct a Core ML reference model")
    args = parser.parse_args()
    try:
        require(args.destination.resolve() not in {p.resolve() for p in (args.graph,args.shapes,args.weights)},
                "source and destination must differ")
        if args.coreml:
            require(args.coreml.resolve() not in {p.resolve() for p in (args.graph,args.shapes,args.weights,args.destination)},
                    "Core ML destination must differ from inputs and bundle")
        manifest = export_model(args.graph,args.shapes,args.weights,args.destination)
        if args.coreml:
            bundle = args.destination.read_bytes()
            header_length, = struct.unpack_from("<I",bundle,8)
            save_coreml(manifest,bundle[12+header_length:],args.coreml)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"export failed: {error}\n")
    print(json.dumps({k:manifest[k] for k in ("variant","source_sha256","weights_sha256","input_shape","output_shape")},indent=2))


if __name__ == "__main__":
    main()
