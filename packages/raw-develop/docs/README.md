# raw-develop documentation

`raw-develop` turns Fujifilm X-Trans RAF files into Display P3 images. It follows Apple's
RawCamera pipeline (the engine behind Preview and Photos): the demosaic, noise reduction,
highlight recovery and look stages are ports of RawCamera's Core Image kernels, and the
colour and lens stages are calibrated against its output. It is a standalone Rust crate; nothing in the API
uses it yet.

| Document | Read it when you want to… |
|---|---|
| [Pipeline](pipeline.md) | understand what happens to the sensor data, stage by stage |
| [RAF format and decoder](raf-format.md) | understand the file container and the Fuji lossless decoder |
| [Colour and tone](color.md) | understand white balance, colour matrices, exposure and the look |
| [Noise reduction](noise-reduction.md) | understand the ported demosaic noise model, chroma NR and the luma pyramid |
| [Camera profiles](camera-profiles.md) | read or edit a `profiles/*.toml` file |
| [Adding a camera](adding-a-camera.md) | support a new body (a new X-Trans model, a Bayer Fuji, or another make) |
| [Validation and calibration](validation.md) | compare against Apple, run fixture tests, refit a profile |
| [Using the library](usage.md) | call the crate or the CLI, store edit settings, integrate it later |
| [Reference: Apple's pipeline](apple-reference.md) | see what we observed in RawCamera and how it maps onto our code |
| [Plan: other cameras](plan-other-cameras.md) | pick up the handoff plan for the Sony ARW, iPhone ProRAW and X100VI files in the production library |

## At a glance

```text
RAF file
 └─ raf::parse (by magic) ─ metadata: geometry, black levels, WB, CFA, lens params, orientation
 └─ unpack ─────────────── 16-bit sensor mosaic (bit-exact with RawCamera)   ← Negative (cache this)
     └─ develop(settings)
         linearise + WB inputs → deXtrans demosaic + crop → chroma NR + luma pyramid
         (YAndRGBGather) → lens (distortion, bicubic) → highlight recovery
         → camera RGB → linear Display P3 + exposure → hue magnet, gamut map, boost
         → sRGB transfer → orientation / rotate / crop
     └─ encode ─────────────── PNG (16/8-bit) or JPEG with an embedded Display P3 ICC profile
```

## Status

- Supported: Fujifilm X-E5 and X100VI (X-Trans 5 HR), lossless compressed and uncompressed RAF.
  Sony ARW and iPhone ProRAW are planned ([plan](plan-other-cameras.md)).
- The decoder matches Apple's decoded mosaic bit for bit on all 11 calibration files.
- Final renders match Apple's closely: mean CIEDE2000 is 0.00–0.41 (p95 at most 1.47) on
  every fixture from ISO 64 to 12800 (see [validation](validation.md#current-results)).
- About 0.1 s to decode and about 2.5 s to develop 40 MP on Apple Silicon (CPU, rayon); the
  one-third-resolution preview mode takes about 0.12 s.
