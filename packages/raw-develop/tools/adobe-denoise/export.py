#!/usr/bin/env python3
"""Export a recovered Core ML denoiser to PhotoBrain's explicit Rust graph format.

Requires coremltools. Reads an already recovered, caller-supplied .mlmodel; it
does not decrypt Adobe assets, fetch weights, or include learned data in source.
Unsupported operations and attributes are errors, never approximate fallbacks.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

MAGIC = b"PBDN0001"
VARIANTS = ("bayer", "xtrans", "linear_raw", "panorama_raw")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(message, allowed):
    extra = {field.name for field, _ in message.ListFields()} - set(allowed)
    require(not extra, f"unsupported {message.DESCRIPTOR.name} fields: {sorted(extra)}")


def feature_shape(feature):
    fields(feature, {"name", "type", "shortDescription"})
    fields(feature.type, {"multiArrayType"})
    require(feature.type.WhichOneof("Type") == "multiArrayType", "expected tensor feature")
    array = feature.type.multiArrayType
    fields(array, {"shape", "dataType"})
    require(array.dataType == 65568, "expected FLOAT32 feature")
    shape = list(array.shape)
    require(len(shape) == 3 and all(v > 0 for v in shape), "expected positive CHW shape")
    return shape


def export_spec(spec, variant, source_sha256):
    require(variant in VARIANTS, "unknown model variant")
    # Unknown protobuf attributes must not silently change inference semantics.
    known = type(spec)()
    known.CopyFrom(spec)
    known.DiscardUnknownFields()
    require(known.SerializeToString(deterministic=True) == spec.SerializeToString(deterministic=True),
            "model contains unknown protobuf fields")
    fields(spec, {"specificationVersion", "description", "neuralNetwork"})
    require(spec.specificationVersion == 4, "expected recovered specification version 4")
    require(spec.WhichOneof("Type") == "neuralNetwork", "expected neuralNetwork model")
    fields(spec.description, {"input", "output", "metadata"})
    require(len(spec.description.input) == len(spec.description.output) == 1,
            "expected exactly one input and output")
    input_feature, output_feature = spec.description.input[0], spec.description.output[0]
    input_shape, output_shape = feature_shape(input_feature), feature_shape(output_feature)
    require(input_shape == [3, 1024, 1024], "unexpected denoiser input shape")
    expected_edge = 864 if variant == "xtrans" else 800
    require(output_shape == [3, expected_edge, expected_edge], "unexpected denoiser output shape")
    net = spec.neuralNetwork
    fields(net, {"layers", "arrayInputShapeMapping", "imageInputShapeMapping"})
    require(net.arrayInputShapeMapping == 1 and net.imageInputShapeMapping == 1,
            "unsupported network shape mapping")
    require(0 < len(net.layers) <= 256, "invalid graph length")
    nodes = {input_feature.name: (0, input_shape, 3)}
    weights = bytearray()
    layers = []

    def append_weights(weight, count):
        fields(weight, {"float16Value"})
        raw = bytes(weight.float16Value)
        require(len(raw) == count * 2, "incorrect FP16 weight count")
        require(all(math.isfinite(v[0]) for v in struct.iter_unpack("<e", raw)),
                "nonfinite FP16 parameter")
        result = {"offset": len(weights) // 2, "count": count}
        weights.extend(raw)
        return result

    for i, layer in enumerate(net.layers, 1):
        kind = layer.WhichOneof("layer")
        fields(layer, {"name", "input", "output", kind})
        require(len(layer.output) == 1 and layer.output[0] not in nodes,
                f"{layer.name}: output must be unique")
        require(all(name in nodes for name in layer.input), f"{layer.name}: forward/missing input")
        require(len(layer.input) == (2 if kind == "add" else 1), f"{layer.name}: input arity")
        sources = [nodes[name] for name in layer.input]
        shape, rank = list(sources[0][1]), sources[0][2]
        node = {"name": layer.name, "inputs": [v[0] for v in sources]}
        p = getattr(layer, kind) if kind else None
        if kind in ("expandDims", "squeeze"):
            fields(p, {"axes"})
            require(list(p.axes) == [0], f"{kind}: only batch axis 0 is supported")
            require(rank == (3 if kind == "expandDims" else 4), f"{kind}: unexpected rank")
            rank = 4 if kind == "expandDims" else 3
            node["op"] = "identity"
        elif kind == "convolution":
            fields(p, {"outputChannels", "kernelChannels", "nGroups", "kernelSize", "stride",
                       "dilationFactor", "valid", "hasBias", "weights", "bias"})
            require(rank == 4, "convolution: expected expanded batch rank")
            require(p.WhichOneof("ConvolutionPaddingType") == "valid", "unsupported convolution padding")
            require(p.hasBias and list(p.dilationFactor) == [1, 1], "unsupported bias/dilation")
            fields(p.valid, {"paddingAmounts"})
            fields(p.valid.paddingAmounts, {"borderAmounts"})
            borders = p.valid.paddingAmounts.borderAmounts
            require(len(borders) == 2, "convolution: expected two padding axes")
            for border in borders:
                fields(border, {"startEdgeSize", "endEdgeSize"})
            padding = [borders[0].startEdgeSize, borders[0].endEdgeSize,
                       borders[1].startEdgeSize, borders[1].endEdgeSize]
            kernel, stride = list(p.kernelSize), list(p.stride)
            require(len(kernel) == len(stride) == 2 and all(0 < v <= 3 for v in kernel)
                    and all(0 < v <= 2 for v in stride), "unsupported convolution kernel/stride")
            groups, out_channels = p.nGroups, p.outputChannels
            require(groups in (1, 4) and 0 < out_channels <= 512 and out_channels % groups == 0
                    and p.kernelChannels * groups == shape[0], "convolution channel mismatch")
            require(all(v <= 1 for v in padding), "unsupported convolution padding size")
            channels = shape[0]
            shape = [out_channels] + [(shape[d + 1] + sum(padding[2*d:2*d+2]) - kernel[d])
                                     // stride[d] + 1 for d in range(2)]
            node.update(op="conv2d", out_channels=out_channels, in_channels=channels,
                        groups=groups, kernel=kernel, stride=stride, padding=padding,
                        weights=append_weights(p.weights, out_channels * p.kernelChannels * math.prod(kernel)),
                        bias=append_weights(p.bias, out_channels))
        elif kind == "activation":
            fields(p, {"leakyReLU"})
            require(p.WhichOneof("NonlinearityType") == "leakyReLU", "unsupported activation")
            fields(p.leakyReLU, {"alpha"})
            require(math.isfinite(p.leakyReLU.alpha), "nonfinite activation alpha")
            node.update(op="leaky_relu", alpha=p.leakyReLU.alpha)
        elif kind == "add":
            fields(p, {"alpha"})
            require(p.alpha == 0, "unsupported add alpha")
            require(sources[0][1:] == sources[1][1:], "add: broadcasting not supported")
            node["op"] = "add"
        elif kind == "upsample":
            fields(p, {"scalingFactor", "mode"})
            require(p.mode == 0, "only nearest-neighbor upsampling is supported")
            scale = list(p.scalingFactor)
            require(scale == [2, 2], "unexpected upsample factor")
            shape = [shape[0], shape[1] * 2, shape[2] * 2]
            node.update(op="upsample", scale=scale)
        elif kind == "slice":
            fields(p, {"startIndex", "endIndex", "stride", "axis"})
            axis_name = p.DESCRIPTOR.fields_by_name["axis"].enum_type.values_by_number[p.axis].name
            require(axis_name in ("HEIGHT_AXIS", "WIDTH_AXIS") and p.stride == 1,
                    "unsupported slice axis/stride")
            axis = 1 if axis_name == "HEIGHT_AXIS" else 2
            require(0 <= p.startIndex < p.endIndex <= shape[axis], "slice out of bounds")
            node.update(op="slice", axis=axis, start=p.startIndex, end=p.endIndex)
            shape[axis] = p.endIndex - p.startIndex
        else:
            raise ValueError(f"unsupported layer {kind}: {layer.name}")
        require(all(0 < v <= 1024 for v in shape), f"{layer.name}: invalid intermediate shape")
        nodes[layer.output[0]] = (i, shape, rank)
        layers.append(node)
    require(output_feature.name in nodes, "missing graph output")
    output, shape, rank = nodes[output_feature.name]
    require(output == len(layers) and shape == output_shape and rank == 3,
            "output shape/rank or final node mismatch")
    require(len(weights) <= 64_000_000, "parameter payload exceeds format limit")
    manifest = dict(format_version=1, variant=variant, source_sha256=source_sha256,
                    weights_sha256=hashlib.sha256(weights).hexdigest(), input_shape=input_shape,
                    output_shape=output_shape, output=output, layers=layers)
    return manifest, bytes(weights)


def export_model(source, destination, variant):
    from coremltools.models.utils import load_spec

    manifest, weights = export_spec(load_spec(str(source)), variant,
                                    hashlib.sha256(source.read_bytes()).hexdigest())
    header = json.dumps(manifest, separators=(",", ":"), allow_nan=False).encode()
    require(len(header) <= 1024 * 1024, "manifest exceeds format limit")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(MAGIC + struct.pack("<I", len(header)) + header + weights)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--variant", choices=VARIANTS, required=True)
    args = parser.parse_args()
    try:
        require(args.source.resolve() != args.destination.resolve(), "source and destination must differ")
        manifest = export_model(args.source, args.destination, args.variant)
    except (ValueError, OSError) as error:
        parser.exit(1, f"export failed: {error}\n")
    print(json.dumps({key: manifest[key] for key in
                      ("variant", "source_sha256", "weights_sha256", "input_shape", "output_shape")}, indent=2))


if __name__ == "__main__":
    main()
