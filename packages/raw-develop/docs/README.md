# raw-develop documentation

`raw-develop` turns Fujifilm X-Trans RAF, Sony ARW and Apple ProRAW DNG files into Display
P3 images. It follows Apple's RawCamera pipeline (the engine behind Preview and Photos): the
demosaic, noise reduction, highlight recovery, detail and look stages are ports of
RawCamera's Core Image kernels, and the colour and lens stages are calibrated against, or
derived from, its output. It is a standalone Rust crate; nothing in the API
uses it yet.

| Document | Read it when you want to… |
|---|---|
| [Pipeline](pipeline.md) | understand what happens to the sensor data, stage by stage |
| [RAF format and decoder](raf-format.md) | understand the RAF container and the Fuji lossless decoder (ARW and DNG are described in [pipeline](pipeline.md#0-decode-once-per-file)) |
| [Colour and tone](color.md) | understand white balance, colour matrices, exposure and the look |
| [Noise reduction](noise-reduction.md) | understand the ported demosaic noise model, chroma NR and the luma pyramid |
| [Camera profiles](camera-profiles.md) | read or edit a `profiles/*.toml` file |
| [Adding a camera](adding-a-camera.md) | support a new body (a new X-Trans model, another Sony, a Bayer Fuji, or another make) |
| [Validation and calibration](validation.md) | compare against Apple, run fixture tests, refit a profile |
| [Using the library](usage.md) | call the crate or the CLI, store edit settings, integrate it later |
| [Reference: Apple's pipeline](apple-reference.md) | see what we observed in RawCamera and how it maps onto our code |
| [Plan: other cameras](plan-other-cameras.md) | read how the Sony ARW, iPhone ProRAW and X100VI support was built, and what remains |

## At a glance

```text
RAF / ARW / DNG file
 └─ raf / arw / dng::parse (by magic) ─ RawMetadata: geometry, black levels, WB, CFA, lens, orientation
 └─ unpack ─── RAF/ARW: 16-bit sensor mosaic; DNG LinearRaw: RGB (bit-exact with RawCamera)
                                                                   ← Negative (cache this)
     └─ develop(settings)
         RAF/ARW: linearise + WB inputs → deXtrans (X-Trans) or despeckle + deBayer (Bayer)
           demosaic + crop → chroma NR + luma pyramid (YAndRGBGather) → lens (distortion,
           bicubic) → highlight recovery → camera RGB → linear Display P3 + exposure
           → hue magnet, gamut map, boost
         DNG: detail graph → highlight recovery → DNG colour → linear Display P3 + exposure
           → gain table map → gamut map → ProfileToneCurve LUT
         → sRGB transfer → orientation / rotate / crop
     └─ encode ─────────────── PNG (16/8-bit) or JPEG with an embedded Display P3 ICC profile
```

## Status

- Supported:
  - Fujifilm X-E5 and X100VI (X-Trans 5 HR): lossless compressed and uncompressed RAF.
  - Sony ILCE-1M2 (A1 II), ILCE-7CR (A7C R) and ILCE-7RM5 (A7R V): Bayer ARW, uncompressed
    14-bit, lossless compressed (tiled lossless JPEG) and lossy cRAW.
  - Apple ProRAW DNG (iPhone 16 Pro Max lossless JPEG, iPhone 17 Pro Max JPEG XL; DNG
    1.6/1.7 LinearRaw). No camera profile is needed.
- Every decoder matches Apple's decoded data bit for bit on every fixture (DNG after rounding
  to half float, RawCamera's provider format).
- Final renders match Apple's closely: mean CIEDE2000 is 0.00–0.46 on every Fuji fixture,
  0.05–0.40 on Sony and 0.05–0.09 on iPhone (see [validation](validation.md#current-results)).
- On Apple Silicon (CPU, rayon): decode 0.03–0.2 s; full develop about 2.8 s for X-Trans
  40 MP, about 5 s for Sony 61 MP and 0.4–0.6 s for iPhone 12 MP. The X-Trans
  one-third-resolution preview takes about 0.12 s.
