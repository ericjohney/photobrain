"""Synthetic Espresso fixtures; no proprietary parameters required."""
import hashlib
import struct
import unittest

from export_details import export_graph, parse_blobs


def fixture():
    layers, blobs = [], []
    shapes = {"mosaick": dict(k=3,h=512,w=512,n=1)}
    source, channels, edge = "mosaick", 3, 512

    def conv(name, out_channels, kernel, relu):
        nonlocal source, channels, edge
        base = len(blobs)
        blobs.extend([b"", struct.pack("<f",0.123456)*out_channels + bytes(12*out_channels), b"",
                      struct.pack("<f",0.000123456)*(channels*out_channels*kernel*kernel)])
        layers.append(dict(pad_r=0,fused_relu=relu,fused_tanh=0,pad_fill_mode=0,pad_b=0,pad_l=0,
                           top=name,blob_weights=base+3,K=channels,blob_biases=base+1,name=name,
                           has_batch_norm=0,type="convolution",n_groups=1,pad_t=0,has_biases=1,
                           C=out_channels,bottom=source,weights={},pad_mode=0,Nx=kernel,pad_value=0,
                           Ny=kernel,n_parallel=1))
        source, channels, edge = name, out_channels, edge-kernel+1
        shapes[name] = dict(k=channels,h=edge,w=edge,n=1)

    for i in range(20):
        conv(f"conv{i+1}",32,3,1)
    layers.append(dict(bottom="mosaick,conv20",t=20,l=20,r=20,b=20,weights={},top="cropped_mosaick",
                       type="crop",name="cropped_mosaick"))
    shapes["cropped_mosaick"] = dict(k=3,h=472,w=472,n=1)
    source, channels = "residual_and_mosaick",35
    layers.append(dict(weights={},top=source,type="concat",name=source,bottom="cropped_mosaick,conv20"))
    shapes[source] = dict(k=35,h=472,w=472,n=1)
    conv("fullres_conv",32,3,1)
    conv("output",3,1,0)
    graph = dict(storage="model.espresso.weights",properties={},format_version=200,layers=layers)
    return graph, dict(layer_shapes=shapes), blobs


def pack(blobs):
    return struct.pack("<Q",len(blobs)) + b"".join(struct.pack("<QQ",i,len(v)) for i,v in enumerate(blobs)) + b"".join(blobs)


class DetailsTests(unittest.TestCase):
    def test_exact_fp32_payload_and_graph(self):
        graph, shapes, blobs = fixture()
        manifest, payload = export_graph(graph,shapes,pack(blobs),"0"*64)
        expected = b"".join(blobs[l["blob_weights"]]+blobs[l["blob_biases"]][:l["C"]*4]
                            for l in graph["layers"] if l["type"]=="convolution")
        self.assertEqual(payload,expected)
        self.assertEqual(len(payload)//4,186819)
        self.assertEqual(manifest["weights_sha256"],hashlib.sha256(expected).hexdigest())
        self.assertEqual(manifest["format_version"],2)
        self.assertEqual(manifest["output"],46)
        self.assertEqual(manifest["layers"][42]["op"],"concat")
        self.assertEqual(manifest["layers"][42]["inputs"],[42,40])
        self.assertNotEqual(struct.pack("<f",struct.unpack("<e",struct.pack("<e",0.123456))[0]),
                            struct.pack("<f",0.123456))

    def test_blob_table_validation(self):
        raw = pack([b"",b"1234"])
        self.assertEqual(parse_blobs(raw),{0:b"",1:b"1234"})
        for bad in (raw[:-1],raw+b"x",b"",struct.pack("<Q",1025),raw[:24]+struct.pack("<Q",0)+raw[32:]):
            with self.subTest(bad=bad[:32]),self.assertRaises(ValueError):parse_blobs(bad)

    def test_semantics_and_shape_rejection(self):
        for mutation in (lambda g,s,b:g["layers"][0].update(pad_l=1),
                         lambda g,s,b:g["layers"][0].update(stride=2),
                         lambda g,s,b:g["layers"][20].update(t=19),
                         lambda g,s,b:s["layer_shapes"]["conv1"].update(w=511),
                         lambda g,s,b:b.__setitem__(0,b"x"),
                         lambda g,s,b:b.__setitem__(1,b[1][:-1]+b"x"),
                         lambda g,s,b:b.__setitem__(3,struct.pack("<f",float("nan"))+b[3][4:])):
            g,s,b=fixture();mutation(g,s,b)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):export_graph(g,s,pack(b),"0"*64)


if __name__ == "__main__":unittest.main()
