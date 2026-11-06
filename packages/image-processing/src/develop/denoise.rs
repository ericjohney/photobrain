//! Server-owned experimental inference and bounded, atomic camera-RGB cache.
use super::{DevelopedRawOptions, source_key};
use raw_develop::adobe::denoise::{Backend, DecodedMosaic, Model, Variant, render};
use raw_develop::{DevelopSettings, Negative, Options, Prepared, image::RgbImage};
use sha2::{Digest, Sha256};
use std::{
  io::{Read, Write},
  sync::atomic::{AtomicI32, Ordering},
};

fn pipeline_error(error: raw_develop::Error) -> String {
  match error {
    raw_develop::Error::Cancelled => super::DEVELOP_CANCELLED.into(),
    error => error.to_string(),
  }
}

pub(super) fn settings(options: &DevelopedRawOptions) -> DevelopSettings {
  let mut settings = DevelopSettings::default();
  if options.denoise_amount.unwrap_or(0) > 0 {
    settings.adobe_noise_reduction = Some(raw_develop::settings::AdobeNoiseReduction {
      color: 0,
      luminance: 0,
      ..Default::default()
    });
  }
  settings
}

pub(super) fn prepare(
  path: &str,
  negative: &Negative,
  options: &DevelopedRawOptions,
  opts: &Options,
) -> Result<Prepared, String> {
  let amount = options.denoise_amount.unwrap_or(0);
  let settings = settings(options);
  if amount == 0 {
    return raw_develop::prepare(negative, &settings, opts).map_err(pipeline_error);
  }
  if amount > 100 || opts.engine != raw_develop::Engine::Adobe {
    return Err("Denoise requires Adobe and an amount in 1..100".into());
  }
  render::validate_render_inputs(negative, &settings, opts).map_err(pipeline_error)?;
  let models = options
    .denoise_model_dir
    .as_ref()
    .ok_or("Denoise is unavailable")?;
  let directory = std::path::Path::new(
    options
      .denoise_cache_dir
      .as_ref()
      .ok_or("Denoise cache is unavailable")?,
  );
  // This validates the complete calibration, including Sony exposure, before cache reuse.
  let mosaic = DecodedMosaic::new_with_cancel(negative, &opts.cancel).map_err(pipeline_error)?;
  let variant = mosaic.variant();
  let [height, width] = mosaic.bounds().size();
  drop(mosaic);
  let key = source_key(path, options)?;
  let digest = format!(
    "{:x}",
    Sha256::digest(format!(
      "denoise-camera:1:{}:{key}",
      raw_develop::PIPELINE_VERSION
    ))
  );
  std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
  let target = directory.join(format!("{digest}.rgb"));
  let progress = |done: usize, total: usize| {
    if let Some(flag) = &options.denoise_progress {
      if flag.len() >= 2 {
        // SharedArrayBuffer is kept alive by options for this synchronous call.
        unsafe {
          let ptr = flag.as_ptr().cast::<AtomicI32>();
          (*ptr.add(1)).store(total as i32, Ordering::Relaxed);
          (*ptr).store(done as i32, Ordering::Relaxed);
        }
      }
    }
  };
  let image = match read_cache(&target, width, height) {
    Ok(image) => {
      progress(1, 1);
      image
    }
    Err(_) => {
      let filename = if variant == Variant::Bayer {
        "dn_bayer.pbdn"
      } else {
        "dn_xtrans.pbdn"
      };
      let backend = Backend::from_env().map_err(pipeline_error)?;
      let model = Model::load_with_backend(std::path::Path::new(models).join(filename), backend)
        .map_err(pipeline_error)?;
      let details = if variant == Variant::Xtrans && amount < 100 {
        Some(
          Model::load_with_backend(
            std::path::Path::new(models).join("xtrans_details.pbdn"),
            backend,
          )
          .map_err(pipeline_error)?,
        )
      } else {
        None
      };
      let image =
        render::predict_camera_rgb(negative, &model, details.as_ref(), amount, opts, progress)
          .map_err(pipeline_error)?;
      opts.cancel.check().map_err(pipeline_error)?;
      if key != source_key(path, options)? {
        return Err("RAW or model changed during Denoise; retry".into());
      }
      // At most two completed Fuji images (~478 MB each); temporary files are RAII-owned.
      let mut entries: Vec<_> = std::fs::read_dir(directory)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| {
          let path = e.path();
          path.extension().is_some_and(|v| v == "rgb")
            && path
              .file_stem()
              .and_then(|v| v.to_str())
              .is_some_and(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
            && e.file_type().is_ok_and(|kind| kind.is_file())
        })
        .filter_map(|e| e.metadata().ok().map(|m| (m.modified().ok(), e.path())))
        .collect();
      entries.sort();
      while entries.len() >= 2 {
        let (_, path) = entries.remove(0);
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
      }
      write_cache(&target, &image).map_err(|e| e.to_string())?;
      image
    }
  };
  opts.cancel.check().map_err(pipeline_error)?;
  let prepared =
    render::prepare_camera_rgb(negative, image, &settings, opts).map_err(pipeline_error)?;
  if key != source_key(path, options)? {
    return Err("RAW or model changed during Denoise; retry".into());
  }
  Ok(prepared)
}

fn read_cache(path: &std::path::Path, width: usize, height: usize) -> std::io::Result<RgbImage> {
  let mut file = std::fs::File::open(path)?;
  let count = width * height * 3;
  if file.metadata()?.len() != (32 + count * 4) as u64 {
    return Err(std::io::ErrorKind::InvalidData.into());
  }
  let mut expected = [0; 32];
  file.read_exact(&mut expected)?;
  let mut data = vec![0u8; count * 4];
  file.read_exact(&mut data)?;
  if Sha256::digest(&data).as_slice() != expected {
    return Err(std::io::ErrorKind::InvalidData.into());
  }
  Ok(RgbImage {
    width,
    height,
    data: data
      .chunks_exact(4)
      .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
      .collect(),
  })
}
fn write_cache(path: &std::path::Path, image: &RgbImage) -> std::io::Result<()> {
  let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
  let mut digest = Sha256::new();
  for v in &image.data {
    if !v.is_finite() {
      return Err(std::io::ErrorKind::InvalidData.into());
    }
    digest.update(v.to_le_bytes());
  }
  file.write_all(&digest.finalize())?;
  {
    let mut writer = std::io::BufWriter::new(file.as_file_mut());
    for v in &image.data {
      writer.write_all(&v.to_le_bytes())?;
    }
    writer.flush()?;
  }
  file.as_file().sync_all()?;
  file.persist(path).map_err(|e| e.error)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  #[test]
  fn cache_is_bit_exact_and_rejects_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("test.rgb");
    let original = RgbImage {
      width: 2,
      height: 1,
      data: vec![0.0, -0.0, 1.25, 0.001, 1.1, 0.9],
    };
    write_cache(&path, &original).unwrap();
    let result = read_cache(&path, 2, 1).unwrap();
    assert_eq!(
      original
        .data
        .iter()
        .map(|v| v.to_bits())
        .collect::<Vec<_>>(),
      result.data.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    assert!(read_cache(&path, 1, 1).is_err());
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[40] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(read_cache(&path, 2, 1).is_err());
  }
}
