//! Embedded Fuji illumination correction. The camera stores illumination, not
//! gain; Adobe solves a monotone spline and samples its reciprocal in radius².

use super::spline::MonotoneSpline;
use crate::error::{Error, Result};
use crate::metadata::{LensSource, RawMetadata};
use crate::{Cancel, image::RgbImage};
use rayon::prelude::*;

#[derive(Clone, Debug)]
pub(crate) struct EmbeddedVignette {
  /// Optical center in active-image pixels, [horizontal, vertical].
  center: [f32; 2],
  inverse_radius: f32,
  table: Vec<f32>,
}

impl EmbeddedVignette {
  pub(crate) fn from_metadata(meta: &RawMetadata, active: [usize; 2]) -> Result<Option<Self>> {
    let LensSource::Fuji(params) = &meta.lens else {
      // Sony's embedded profile builder creates only its distortion model.
      return Ok(None);
    };
    let Some(values) = params.vignetting.as_deref() else {
      return Ok(None);
    };
    let limit = match meta.model.trim() {
      "X-E5" => 2930,
      "X100VI" => 1490,
      _ => {
        return Err(Error::Unsupported(format!(
          "Adobe embedded vignetting: unsupported Fuji {}",
          meta.model
        )));
      }
    };
    if values.len() != 19 || values.iter().any(|v| !v.is_finite()) || active.contains(&0) {
      return Err(Error::Malformed(
        "Adobe Fuji vignette: invalid nine-knot table".into(),
      ));
    }
    if values[10..].iter().all(|&v| v == 100.0) {
      return Ok(None);
    }
    // The TIFF SRATIONAL header is actually [normalization, count], not a
    // numerical ratio. For the supported nine-knot format, rounding reverses
    // the parser's division exactly for every valid 32-bit numerator.
    let normalization = (values[0] * 9.0).round();
    if !(2.0..=f64::from(i32::MAX)).contains(&normalization) {
      return Err(Error::Malformed(
        "Adobe Fuji vignette: invalid radius normalization".into(),
      ));
    }
    let focal = meta
      .focal_length
      .filter(|f| f.is_finite() && *f >= 1.0)
      .ok_or_else(|| Error::Malformed("Adobe Fuji vignette: missing focal length".into()))?;
    // ModelToMicrons uses this physical sensor pitch for both 40 MP X-Trans bodies.
    // SetModelPixelPitch stores it as an EXIF rational before lens rendering.
    let profile_pixels_per_mm = 1000.0f64 / 3.0267665252483718;
    let pixels_per_mm = (profile_pixels_per_mm * 65536.0).round() / 65536.0;
    let physical_scale = pixels_per_mm * focal;
    let profile_scale = profile_pixels_per_mm * focal;
    let quantize = |x: f64| (x * 1000000.0 + 0.5).floor() * 0.000001;
    let mut center = [0.5, 0.5];
    if let Some(shift) = meta
      .fuji_ibis_shift
      .filter(|s| s.iter().all(|&v| (-limit..=limit).contains(&v)))
    {
      for c in 0..2 {
        center[c] += (f64::from(shift[c]) / 10.0) / active[c] as f64;
      }
    }
    for c in 0..2 {
      center[c] = quantize(center[c]) * (active[c] - 1) as f64;
    }
    let far = std::array::from_fn::<_, 2, _>(|c| {
      center[c]
        .abs()
        .max(((active[c] - 1) as f64 - center[c]).abs())
    });
    let pixel_radius = far[0].hypot(far[1]);
    let radius = (far[0] / physical_scale).hypot(far[1] / physical_scale);
    let mut points = vec![[0.0, 1.0]];
    let mut illumination = 1.0f64;
    for i in 0..9 {
      let r = quantize(values[1 + i] * normalization / profile_scale);
      if r > points.last().unwrap()[0] {
        illumination = illumination.min((values[10 + i] / 100.0).min(1.2));
        points.push([r, quantize(illumination)]);
      }
    }
    Self::from_points(points, center, radius, pixel_radius).map(Some)
  }

  fn from_points(
    points: Vec<[f64; 2]>,
    center: [f64; 2],
    radius: f64,
    pixel_radius: f64,
  ) -> Result<Self> {
    let spline = MonotoneSpline::illumination(points)?;
    let mut table: Vec<f32> = (0..=4096)
      .map(|i| {
        let r = ((1.0 / 4096.0) * i as f64).sqrt() * radius;
        (1.0 / spline.evaluate(r).clamp(0.0625, 16.0)) as f32
      })
      .collect();
    table.push(table[4096]);
    Ok(Self {
      center: center.map(|v| v as f32),
      inverse_radius: (1.0 / pixel_radius) as f32,
      table,
    })
  }

  pub(crate) fn apply(
    &self,
    image: &mut RgbImage,
    black: f64,
    clip: bool,
    source_position: impl Fn([f32; 2]) -> [f32; 2] + Sync,
    cancel: &Cancel,
  ) -> Result<()> {
    image
      .data
      .par_chunks_mut(image.width * 3)
      .enumerate()
      .try_for_each(|(y, row)| {
        cancel.check()?;
        for (x, pixel) in row.chunks_exact_mut(3).enumerate() {
          let gain = self.gain(source_position([x as f32, y as f32]));
          for value in pixel {
            *value = apply_gain(*value, gain, black, clip);
          }
        }
        Ok(())
      })
  }

  /// `source` is the level-zero source position after the backward lens warp.
  /// This makes the illumination correction follow the uncorrected lens rays.
  pub(crate) fn gain(&self, source: [f32; 2]) -> f32 {
    let x = (source[0] - self.center[0]) * self.inverse_radius;
    let y = (source[1] - self.center[1]) * self.inverse_radius;
    let index = x.mul_add(x, y * y).min(1.0) * 4096.0;
    let i = index as usize;
    let fraction = index - i as f32;
    self.table[i].mul_add(1.0 - fraction, fraction * self.table[i + 1])
  }
}

/// RefVignetteRGB32 operates around the current preserved-black pedestal.
pub(super) fn apply_gain(value: f32, gain: f32, black: f64, clip: bool) -> f32 {
  let black = black as f32;
  let span = black - 1.0;
  let inverse = if black == 1.0 { 0.0 } else { -1.0 / span };
  let offset = -(inverse * black);
  let neutral = span.mul_add(0.0, black);
  let value = (-span).mul_add(value.mul_add(inverse, offset) * gain, neutral);
  if clip { value.min(1.0) } else { value }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Full RAW preparation checks lens placement relative to camera colour and
  /// the first profile map, not just each isolated captured lens stage.
  #[test]
  fn captured_raw_to_vignette_pipeline() {
    let (Some(root), Some(raw), Some(profiles)) = (
      std::env::var_os("RAW_DEVELOP_ADOBE_LENS_TRACE"),
      std::env::var_os("RAW_DEVELOP_ADOBE_LENS_RAW"),
      std::env::var_os("ADOBE_PROFILE_DIR"),
    ) else {
      return;
    };
    let root = std::path::Path::new(&root);
    let neg = crate::Negative::open(raw).unwrap();
    let neutral = crate::adobe::xtrans::rounded_neutral([
      1.0 / neg.meta.as_shot_wb[0],
      1.0,
      1.0 / neg.meta.as_shot_wb[2],
    ]);
    let dcp = crate::adobe::dcp::Dcp::open(
      &crate::adobe::dcp::Dcp::find_adobe_standard(
        std::path::Path::new(&profiles),
        &neg.meta.make,
        &neg.meta.model,
      )
      .unwrap(),
    )
    .unwrap();
    let settings = crate::DevelopSettings {
      adobe_noise_reduction: Some(crate::settings::AdobeNoiseReduction {
        color: 0,
        luminance: 0,
        ..Default::default()
      }),
      chroma_noise_reduction: 0.0,
      luma_noise_reduction: Some(0.0),
      sharpening: 0.0,
      highlight_recovery: false,
      lens: crate::settings::LensSettings {
        distortion: true,
        chromatic_aberration: true,
        vignetting: true,
      },
      ..Default::default()
    };
    let cancel = Cancel::never();
    let mut image =
      crate::adobe::xtrans::develop_preserved_with_lens(&neg, neutral, false, &cancel).unwrap();
    let warp_source = std::fs::read(root.join("129_cr_stage_warp_src.bin"))
      .ok()
      .map(|pixels| {
        let header: serde_json::Value =
          serde_json::from_slice(&std::fs::read(root.join("129_cr_stage_warp_src.json")).unwrap())
            .unwrap();
        (header, pixels)
      });
    let source_differences = |image: &RgbImage| -> usize {
      let Some((header, pixels)) = &warp_source else {
        return 0;
      };
      let n = |k: &str| header[k].as_i64().unwrap() as usize;
      let mut differences = 0;
      for y in n("t")..n("b") {
        for x in n("l")..n("r") {
          for c in 0..3 {
            let i =
              ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step"))
                * 2;
            let expected =
              (i32::from(i16::from_le_bytes(pixels[i..i + 2].try_into().unwrap())) + 32768) as u16;
            differences +=
              usize::from(crate::adobe::bayer::tables::code(image.px(x, y)[c]) != expected);
          }
        }
      }
      differences
    };
    let uncorrected = source_differences(&image);
    if let Some(ca) = crate::adobe::lens::embedded_ca(&neg.meta, neg.meta.fuji_ibis_shift).unwrap()
    {
      image = ca
        .apply_crop(&image, [0, 0, image.height, image.width], &cancel)
        .unwrap();
    }
    if warp_source.is_some() {
      let corrected = source_differences(&image);
      eprintln!("RAW->warp source: CA off {uncorrected} differences, CA on {corrected}");
      assert!(uncorrected > 0, "capture must distinguish the CA setting");
      assert_eq!(corrected, 0, "mandatory CA precedes optional distortion");
    }
    let mut render =
      crate::adobe::AdobeRender::new(&dcp, &neg.meta, neutral, 0.0, &settings.white_balance, true)
        .unwrap();
    render
      .prepare_camera(&mut image, &dcp, &neg.meta, &settings, &cancel)
      .unwrap();
    if let Some(color_trace) = std::env::var_os("RAW_DEVELOP_ADOBE_LENS_COLOR_TRACE") {
      let color_trace = std::path::Path::new(&color_trace);
      for (stem, mapped) in [
        ("000_cr_stage_ABCtoRGB_local_dst", false),
        ("002_cr_stage_color_table_dst", true),
      ] {
        let header: serde_json::Value =
          serde_json::from_slice(&std::fs::read(color_trace.join(format!("{stem}.json"))).unwrap())
            .unwrap();
        let pixels = std::fs::read(color_trace.join(format!("{stem}.bin"))).unwrap();
        let n = |k: &str| header[k].as_i64().unwrap() as usize;
        let mut differences = 0;
        let mut maximum = 0.0f32;
        for y in n("t")..n("b") {
          for x in n("l")..n("r") {
            let p = image.px(x, y);
            let p = if mapped {
              render.modern_color.as_ref().unwrap().input_pixel(p)
            } else {
              p
            };
            for c in 0..3 {
              let i =
                ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step"))
                  * 4;
              let expected = f32::from_le_bytes(pixels[i..i + 4].try_into().unwrap());
              let expected = if mapped {
                crate::adobe::bayer::tables::normalized(crate::adobe::bayer::tables::code(expected))
              } else {
                expected
              };
              if p[c].to_bits() != expected.to_bits() {
                if differences < 5 {
                  eprintln!("{stem} {x},{y},{c}: {} != {expected}", p[c]);
                }
                differences += 1;
                maximum = maximum.max((p[c] - expected).abs());
              }
            }
          }
        }
        eprintln!("{stem}: {differences} differences maximum {maximum}");
        assert_eq!(differences, 0, "{stem}");
      }
    }
    render.prepare_color(&mut image, &cancel).unwrap();
    let stage = std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .find(|p| {
        let name = p.file_name().unwrap().to_string_lossy();
        name.contains("cr_stage_warp_aware_vignette") && name.ends_with("_dst.json")
      })
      .unwrap();
    let header: serde_json::Value =
      serde_json::from_slice(&std::fs::read(&stage).unwrap()).unwrap();
    let pixels = std::fs::read(stage.with_extension("bin")).unwrap();
    let n = |k: &str| header[k].as_i64().unwrap() as usize;
    let mut differences = 0;
    let mut maximum = 0.0f32;
    for y in n("t")..n("b") {
      for x in n("l")..n("r") {
        for c in 0..3 {
          let i =
            ((y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step")) * 4;
          let expected = f32::from_le_bytes(pixels[i..i + 4].try_into().unwrap());
          let actual = image.px(x, y)[c];
          if actual.to_bits() != expected.to_bits() {
            if differences < 5 {
              eprintln!("RAW->vignette {x},{y},{c}: {actual} != {expected}");
            }
            differences += 1;
            maximum = maximum.max((actual - expected).abs());
          }
        }
      }
    }
    eprintln!("RAW->vignette: {differences} differences, maximum {maximum}");
    assert_eq!(differences, 0);
  }

  #[test]
  fn captured_vignette_table_matches() {
    let Some(root) = std::env::var_os("RAW_DEVELOP_ADOBE_LENS_TRACE") else {
      return;
    };
    let root = std::path::Path::new(&root);
    let doubles = |p: &std::path::Path| -> Vec<f64> {
      std::fs::read(p)
        .unwrap()
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect()
    };
    let mut files: Vec<_> = std::fs::read_dir(root)
      .unwrap()
      .map(|e| e.unwrap().path())
      .collect();
    files.sort();
    let solver = files
      .iter()
      .find(|p| p.to_string_lossy().ends_with("_solver.bin"))
      .unwrap();
    let stem = solver.file_name().unwrap().to_string_lossy();
    let stem = stem.split('_').next().unwrap();
    let x = doubles(&root.join(format!("{stem}_x.bin")));
    let y = doubles(&root.join(format!("{stem}_y.bin")));
    let spline =
      MonotoneSpline::illumination(x.into_iter().zip(y).map(|(x, y)| [x, y]).collect()).unwrap();
    let mut checked = 0;
    let mut vignette_stem = String::new();
    for file in &files {
      let name = file.file_name().unwrap().to_string_lossy();
      let stem = name.split('_').next().unwrap();
      if !name.ends_with("_table.bin") {
        continue;
      }
      let calc_path = root.join(format!("{stem}_calculator.bin"));
      let calc = std::fs::read(calc_path).unwrap();
      if calc.len() != 0x58 {
        continue;
      }
      // The calculator Initialize entry precedes its nested model Initialize.
      let seq: usize = stem.parse().unwrap();
      let model = doubles(&root.join(format!("{:03}_model.bin", seq + 1)));
      let radius = model[0x70 / 8];
      let actual: Vec<u32> = (0..4098)
        .map(|i| {
          (1.0
            / spline
              .evaluate(((1.0 / 4096.0) * i.min(4096) as f64).sqrt() * radius)
              .clamp(0.0625, 16.0)) as f32
        })
        .map(f32::to_bits)
        .collect();
      let expected: Vec<u32> = std::fs::read(file)
        .unwrap()
        .chunks_exact(4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
        .collect();
      let mismatch = actual.iter().zip(&expected).filter(|(a, b)| a != b).count();
      assert_eq!(mismatch, 0, "{name}");
      vignette_stem = stem.to_owned();
      checked += 1;
    }
    if let Some(raw) = std::env::var_os("RAW_DEVELOP_ADOBE_LENS_RAW") {
      let neg = crate::Negative::open(raw).unwrap();
      let active = [neg.meta.crop_width, neg.meta.crop_height];
      let ours = EmbeddedVignette::from_metadata(&neg.meta, active)
        .unwrap()
        .unwrap();
      let calc = std::fs::read(root.join(format!("{vignette_stem}_calculator.bin"))).unwrap();
      let at = |i| f32::from_le_bytes(calc[i..i + 4].try_into().unwrap());
      assert_eq!(ours.center, [at(0x2c), at(0x28)]);
      assert_eq!(ours.inverse_radius, at(0x30));
      let expected: Vec<u32> = std::fs::read(root.join(format!("{vignette_stem}_table.bin")))
        .unwrap()
        .chunks_exact(4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
        .collect();
      let count = ours
        .table
        .iter()
        .zip(&expected)
        .filter(|(a, b)| a.to_bits() != **b)
        .count();
      assert_eq!(count, 0, "metadata LUT");
      {
        let distortion =
          super::super::distortion::EmbeddedDistortion::from_metadata(&neg.meta, active).unwrap();
        let stage = files
          .iter()
          .find(|p| {
            p.to_string_lossy().contains("cr_stage_warp_aware_vignette")
              && p.to_string_lossy().ends_with("_obj.bin")
          })
          .unwrap();
        let stage_stem = stage.file_name().unwrap().to_string_lossy();
        let stage_stem = stage_stem.strip_suffix("_obj.bin").unwrap();
        let obj = std::fs::read(stage).unwrap();
        let black = f64::from_le_bytes(obj[0x68..0x70].try_into().unwrap());
        let clip = obj[0x70] == 0;
        let j: serde_json::Value = serde_json::from_slice(
          &std::fs::read(root.join(format!("{stage_stem}_src.json"))).unwrap(),
        )
        .unwrap();
        let n = |k: &str| j[k].as_i64().unwrap() as usize;
        let src = std::fs::read(root.join(format!("{stage_stem}_src.bin"))).unwrap();
        let dst = std::fs::read(root.join(format!("{stage_stem}_dst.bin"))).unwrap();
        let read = |b: &[u8], i: usize| f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
        let mut mismatch = 0;
        for y in n("t")..n("b") {
          for x in n("l")..n("r") {
            let position = [x as f32, y as f32];
            let position = distortion
              .as_ref()
              .map_or(position, |d| d.source_position(position));
            let gain = ours.gain(position);
            for c in 0..3 {
              let i =
                (y - n("t")) * n("row_step") + (x - n("l")) * n("col_step") + c * n("plane_step");
              let actual = apply_gain(read(&src, i), gain, black, clip);
              if actual.to_bits() != read(&dst, i).to_bits() {
                mismatch += 1;
              }
            }
          }
        }
        assert_eq!(mismatch, 0, "vignette pixels");
      }
    }
    assert!(checked > 0);
  }
}
