# raw-develop documentation

`raw-develop` turns Fujifilm X-Trans RAF files into Display P3 images. It follows the
stage order of Apple's RawCamera pipeline (the engine behind Preview and Photos) and
is calibrated against its output. It is a standalone Rust crate; nothing in the API
uses it yet.

| Document | Read it when you want to… |
|---|---|
| [Pipeline](pipeline.md) | understand what happens to the sensor data, stage by stage |
| [RAF format and decoder](raf-format.md) | understand the file container and the Fuji lossless decoder |
| [Colour and tone](color.md) | understand white balance, colour matrices, exposure and the tone curve |
| [Camera profiles](camera-profiles.md) | read or edit a `profiles/*.toml` file |
| [Adding a camera](adding-a-camera.md) | support a new body (a new X-Trans model, a Bayer Fuji, or another make) |
| [Validation and calibration](validation.md) | compare against Apple, run fixture tests, refit a profile |
| [Using the library](usage.md) | call the crate or the CLI, store edit settings, integrate it later |
| [Reference: Apple's pipeline](apple-reference.md) | see what we observed in RawCamera and how it maps onto our code |

## At a glance

```text
RAF file
 └─ raf::parse ─────────── metadata: geometry, black levels, WB, CFA, lens params, orientation
 └─ unpack ─────────────── 16-bit sensor mosaic (bit-exact with RawCamera)   ← Negative (cache this)
     └─ develop(settings)
         linearise + white balance → demosaic → crop → noise reduction → lens correction
         → highlight recovery → camera RGB → linear Display P3 → exposure → sharpening
         → gamut compression + tone curve → orientation / rotate / crop
     └─ encode ─────────────── PNG (16/8-bit) or JPEG with an embedded Display P3 ICC profile
```

## Status

- Supported: Fujifilm X-E5 (X-Trans 5 HR), lossless compressed and uncompressed RAF.
- The decoder matches Apple's decoded mosaic bit for bit on all 11 calibration files.
- Final renders are close to Apple's: mean CIEDE2000 is 0.5–2.6 up to ISO 3200 and about 3
  at ISO 10000–12800. Most of the remaining difference is fine texture from demosaicing and
  noise reduction, not colour (see [validation](validation.md#current-results)).
- About 0.1 s to decode and about 1 s to develop 40 MP on Apple Silicon (CPU, rayon); the
  one-third-resolution preview mode takes about 0.08 s.
