//! Full RAW development through `raw-develop` (Apple or opt-in Adobe pipeline), for
//! the loupe's "Developed" view. Scans and thumbnails keep using the embedded preview.

use napi::bindgen_prelude::{Buffer, Int32Array};
use napi_derive::napi;
use std::sync::atomic::{AtomicI32, Ordering};

/// A developed RAW: a Display P3 JPEG (ICC embedded) at full resolution, with its size.
#[napi(object)]
pub struct DevelopedRaw {
  pub jpeg: Buffer,
  pub width: u32,
  pub height: u32,
  /// Actual engine used (LinearRaw DNG always uses Apple).
  pub engine: String,
}

#[napi(object)]
#[derive(Default)]
pub struct DevelopedRawOptions {
  /// "apple" (default) or "adobe" for supported RAF/ARW cameras.
  pub engine: Option<String>,
  /// Runtime Adobe Standard DCP directory; profiles are never bundled.
  pub adobe_profile_dir: Option<String>,
  /// Versioned core settings JSON; app callers supply only supported Basic controls.
  pub settings_json: Option<String>,
  /// Interactive proxy (1024 or 2048); absent means exact full-resolution output.
  pub max_edge: Option<u32>,
}

impl DevelopedRawOptions {
  fn engine(&self, linear_dng: bool) -> Result<raw_develop::Engine, String> {
    use raw_develop::Engine;
    let engine = match self.engine.as_deref().unwrap_or("apple") {
      "apple" => Engine::Apple,
      "adobe" => Engine::Adobe,
      _ => return Err("RAW engine must be apple or adobe".into()),
    };
    // Adobe does not support LinearRaw DNG. Preserve the existing ProRAW renderer.
    Ok(if linear_dng { Engine::Apple } else { engine })
  }
}

/// One bounded interactive image per native worker. Full-resolution pixels are released
/// after preparation; exports always use a fresh, unresized full-quality development.
struct PreviewCache {
  key: String,
  refined: raw_develop::Prepared,
  drag: raw_develop::Prepared,
  engine: raw_develop::Engine,
}
static PREVIEW_CACHE: std::sync::Mutex<Option<PreviewCache>> = std::sync::Mutex::new(None);

#[napi]
pub fn clear_developed_raw_cache() {
  if let Ok(mut cache) = PREVIEW_CACHE.lock() {
    *cache = None;
  }
}

fn source_key(path: &str, options: &DevelopedRawOptions) -> Result<String, String> {
  use std::fmt::Write;
  let mut key = format!(
    "{}:{:?}:{:?}",
    path, options.engine, options.adobe_profile_dir
  );
  let mut append = |path: &std::path::Path| -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    write!(&mut key, ":{:?}:{}:{:?}", path, meta.len(), meta.modified()).unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::MetadataExt;
      write!(
        &mut key,
        ":{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.ctime(),
        meta.ctime_nsec()
      )
      .unwrap();
    }
    Ok(())
  };
  append(std::path::Path::new(path))?;
  if let Some(dir) = &options.adobe_profile_dir
    && options.engine.as_deref() == Some("adobe")
  {
    // The core looks in both the supplied directory and its "Adobe Standard" child.
    // Stat the profile files too: editing an existing DCP does not change its parent's mtime.
    for root in [
      std::path::PathBuf::from(dir),
      std::path::Path::new(dir).join("Adobe Standard"),
    ] {
      if root != std::path::Path::new(dir) && !root.exists() {
        continue;
      }
      let mut files = std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
      files.sort();
      for file in files {
        append(&file)?;
      }
    }
  }
  Ok(key)
}

/// Error message of a develop stopped through its cancel flag.
pub const DEVELOP_CANCELLED: &str = "DEVELOP_CANCELLED";

/// Develop a RAW file at full resolution (orientation applied) and encode it as a JPEG
/// tagged Display P3. Fails for formats or cameras `raw-develop` does not support.
/// `options` selects Apple (default) or Adobe with runtime DCP profiles. LinearRaw
/// ProRAW DNG keeps Apple; the result reports the actual engine used.
///
/// `cancel` is an optional `Int32Array` over a `SharedArrayBuffer`: setting element 0 to
/// a non-zero value (from any thread) stops the develop at its next check, failing with
/// the message `DEVELOP_CANCELLED`.
#[napi]
pub fn render_developed_raw(
  path: String,
  quality: u32,
  cancel: Option<Int32Array>,
  options: Option<DevelopedRawOptions>,
) -> napi::Result<DevelopedRaw> {
  if !(1..=100).contains(&quality) {
    return Err(napi::Error::from_reason(
      "quality must be between 1 and 100",
    ));
  }
  let flag = match &cancel {
    Some(a) if a.is_empty() => {
      return Err(napi::Error::from_reason(
        "cancel flag must have at least one element",
      ));
    }
    Some(a) => Some(a.as_ptr() as *const AtomicI32),
    None => None,
  };
  develop_internal(&path, quality as u8, flag, options.unwrap_or_default())
    .map_err(napi::Error::from_reason)
}

fn develop_internal(
  path: &str,
  quality: u8,
  flag: Option<*const AtomicI32>,
  options: DevelopedRawOptions,
) -> Result<DevelopedRaw, String> {
  use raw_develop::{DevelopSettings, Error, Negative, Options, develop, encode, prepare};
  // Reject invalid engine names before decoding a potentially large source.
  options.engine(false)?;
  if options
    .max_edge
    .is_some_and(|edge| edge != 1024 && edge != 2048)
  {
    return Err("interactive max_edge must be 1024 or 2048".into());
  }
  let settings: DevelopSettings = match &options.settings_json {
    Some(json) => {
      serde_json::from_str(json).map_err(|e| format!("invalid develop settings: {e}"))?
    }
    None => DevelopSettings::default(),
  };
  settings.validate().map_err(|e| e.to_string())?;
  let token = raw_develop::Cancel::new();
  // Mirror the shared JS flag into the token from a watcher thread, so the pipeline's
  // checks stay a plain atomic load on Rust-owned memory.
  // SAFETY: the `Int32Array` argument keeps its backing buffer alive (a JS reference is
  // held) for the whole synchronous call, and the watcher is joined before returning.
  // The element is only read, with an atomic load matching JS `Atomics.store`.
  struct Flag(*const AtomicI32);
  unsafe impl Send for Flag {}
  let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
  let watcher = flag.map(|p| {
    let (flag, t, done) = (Flag(p), token.clone(), done.clone());
    std::thread::spawn(move || {
      let f = flag;
      while !done.load(Ordering::Relaxed) {
        if unsafe { (*f.0).load(Ordering::Relaxed) } != 0 {
          t.cancel();
          return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
      }
    })
  });
  let result = (|| -> Result<_, String> {
    let msg = |e: Error| match e {
      Error::Cancelled => DEVELOP_CANCELLED.to_string(),
      e => e.to_string(),
    };
    let mut opts = Options {
      cancel: token.clone(),
      engine: options.engine(false)?,
      adobe_profile_dir: options.adobe_profile_dir.as_deref().map(Into::into),
      ..Options::default()
    };
    let out = if let Some(edge) = options.max_edge {
      let key = source_key(path, &options)?;
      let mut cache = PREVIEW_CACHE
        .lock()
        .map_err(|_| "preview cache unavailable")?;
      if cache.as_ref().is_none_or(|cached| cached.key != key) {
        *cache = None; // Release the previous photo before decoding another one.
        let neg = Negative::open(path).map_err(msg)?;
        token.check().map_err(msg)?;
        opts.engine = options.engine(neg.dng.is_some())?;
        let refined = prepare(&neg, &DevelopSettings::default(), &opts).map_err(msg)?;
        drop(neg);
        let refined = refined.with_max_edge(2048).map_err(msg)?;
        let drag = refined.clone().with_max_edge(1024).map_err(msg)?;
        token.check().map_err(msg)?;
        // Never retain a preparation for a source/profile changed during the read.
        if source_key(path, &options)? != key {
          return Err("RAW source changed during preparation; retry".into());
        }
        *cache = Some(PreviewCache {
          key,
          refined,
          drag,
          engine: opts.engine,
        });
      }
      let cached = cache.as_ref().unwrap();
      opts.engine = cached.engine;
      let prepared = if edge == 1024 {
        &cached.drag
      } else {
        &cached.refined
      };
      prepared.render(&settings, &opts).map_err(msg)?
    } else {
      let neg = Negative::open(path).map_err(msg)?;
      token.check().map_err(msg)?;
      opts.engine = options.engine(neg.dng.is_some())?;
      develop(&neg, &settings, &opts).map_err(msg)?
    };
    token.check().map_err(msg)?;
    let jpeg = encode::encode(&out.image, encode::Format::Jpeg(quality)).map_err(msg)?;
    Ok((out, jpeg, opts.engine))
  })();
  done.store(true, Ordering::Relaxed);
  if let Some(w) = watcher {
    let _ = w.join();
  }
  let (out, jpeg, engine) = result?;
  Ok(DevelopedRaw {
    jpeg: jpeg.into(),
    width: out.image.width as u32,
    height: out.image.height as u32,
    engine: match engine {
      raw_develop::Engine::Apple => "apple",
      raw_develop::Engine::Adobe => "adobe",
    }
    .into(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use raw_develop::Engine;

  #[test]
  fn prepared_proxy_replays_exposure_exactly_without_retaining_the_negative() {
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("../raw-develop/tests/fixtures/synthetic.ARW");
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("synthetic.ARW");
    std::fs::copy(source, &path).unwrap();
    let path = path.to_str().unwrap();
    let render = |exposure: f64, max_edge| {
      develop_internal(
        path,
        95,
        None,
        DevelopedRawOptions {
          settings_json: Some(format!(r#"{{"exposure":{exposure}}}"#)),
          max_edge,
          ..Default::default()
        },
      )
      .unwrap()
    };
    let full = render(0.0, None);
    let proxy = render(0.0, Some(2048));
    assert_eq!(full.jpeg.as_ref(), proxy.jpeg.as_ref()); // synthetic source fits without resize
    let bright = render(1.0, Some(1024));
    assert_ne!(bright.jpeg.as_ref(), proxy.jpeg.as_ref());
    assert_eq!(bright.jpeg.as_ref(), render(1.0, None).jpeg.as_ref());
    assert_eq!(proxy.jpeg.as_ref(), render(0.0, Some(2048)).jpeg.as_ref());
    let key = source_key(path, &DevelopedRawOptions::default()).unwrap();
    // A change to the file's identity invalidates the prepared image.
    std::fs::write(path, b"replaced RAW").unwrap();
    assert_ne!(
      key,
      source_key(path, &DevelopedRawOptions::default()).unwrap()
    );
    assert!(
      develop_internal(
        path,
        95,
        None,
        DevelopedRawOptions {
          max_edge: Some(2048),
          ..Default::default()
        }
      )
      .is_err()
    );
    clear_developed_raw_cache();
    assert!(PREVIEW_CACHE.lock().unwrap().is_none());
  }

  #[test]
  fn changes_to_nested_adobe_profiles_invalidate_the_proxy_key() {
    let tmp = tempfile::tempdir().unwrap();
    let source = tmp.path().join("source.ARW");
    std::fs::write(&source, "raw").unwrap();
    let profiles = tmp.path().join("profiles");
    let nested = profiles.join("Adobe Standard");
    std::fs::create_dir_all(&nested).unwrap();
    let profile = nested.join("camera.dcp");
    std::fs::write(&profile, "profile").unwrap();
    let options = DevelopedRawOptions {
      engine: Some("adobe".into()),
      adobe_profile_dir: Some(profiles.to_string_lossy().into()),
      ..Default::default()
    };
    let before = source_key(source.to_str().unwrap(), &options).unwrap();
    std::fs::write(&profile, "changed profile").unwrap();
    assert_ne!(
      before,
      source_key(source.to_str().unwrap(), &options).unwrap()
    );
  }

  #[test]
  fn adobe_is_opt_in_and_proraw_retains_apple() {
    assert_eq!(
      DevelopedRawOptions::default().engine(false).unwrap(),
      Engine::Apple
    );
    let options = DevelopedRawOptions {
      engine: Some("adobe".into()),
      ..Default::default()
    };
    assert_eq!(options.engine(false).unwrap(), Engine::Adobe);
    assert_eq!(options.engine(true).unwrap(), Engine::Apple);
  }

  #[test]
  fn invalid_engine_never_silently_falls_back() {
    let options = DevelopedRawOptions {
      engine: Some("typo".into()),
      ..Default::default()
    };
    assert!(options.engine(false).is_err());
    assert!(options.engine(true).is_err());
  }
}

/// Bounded lossless state for local mobile Basic adjustments. The quality slot is
/// reserved so this operation shares the cancellable native executor ABI.
#[napi(object)]
pub struct SmartPreview {
  pub data: Buffer,
  pub engine: String,
  pub token: String,
}

#[napi]
pub fn prepare_smart_preview(
  path: String,
  _quality: u32,
  cancel: Option<Int32Array>,
  options: Option<DevelopedRawOptions>,
) -> napi::Result<SmartPreview> {
  use raw_develop::{DevelopSettings, Negative, Options, prepare};
  use sha2::{Digest, Sha256};
  let options = options.unwrap_or_default();
  let flag = match &cancel {
    Some(a) if a.is_empty() => return Err(napi::Error::from_reason("missing cancel flag")),
    Some(a) => Some(a.as_ptr() as *const AtomicI32),
    None => None,
  };
  let token = raw_develop::Cancel::new();
  // Mirror the shared JS flag into the token from a watcher thread, so the pipeline's
  // checks stay a plain atomic load on Rust-owned memory.
  // SAFETY: the `Int32Array` argument keeps its backing buffer alive (a JS reference is
  // held) for the whole synchronous call, and the watcher is joined before returning.
  // The element is only read, with an atomic load matching JS `Atomics.store`.
  struct Flag(*const AtomicI32);
  unsafe impl Send for Flag {}
  let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
  let watcher = flag.map(|p| {
    let (flag, t, done) = (Flag(p), token.clone(), done.clone());
    std::thread::spawn(move || {
      let f = flag;
      while !done.load(Ordering::Relaxed) {
        if unsafe { (*f.0).load(Ordering::Relaxed) } != 0 {
          t.cancel();
          return;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
      }
    })
  });

  let result = (|| -> Result<SmartPreview, String> {
    token.check().map_err(|_| DEVELOP_CANCELLED.to_string())?;
    let key = source_key(&path, &options)?;
    // Reuse a full-quality preparation when the editor just requested a preview.
    let cached = PREVIEW_CACHE
      .lock()
      .map_err(|_| "preview cache unavailable")?;
    let (prepared, engine) = if let Some(cache) = cached.as_ref().filter(|c| c.key == key) {
      (cache.refined.clone(), cache.engine)
    } else {
      let neg = Negative::open(&path).map_err(|e| e.to_string())?;
      let engine = options.engine(neg.dng.is_some())?;
      let opts = Options {
        engine,
        cancel: token.clone(),
        adobe_profile_dir: options.adobe_profile_dir.as_deref().map(Into::into),
        ..Options::default()
      };
      (
        prepare(&neg, &DevelopSettings::default(), &opts).map_err(|e| e.to_string())?,
        engine,
      )
    };
    drop(cached);
    let data = prepared.encode_smart_preview(&token).map_err(|e| match e {
      raw_develop::Error::Cancelled => DEVELOP_CANCELLED.to_string(),
      e => e.to_string(),
    })?;
    if source_key(&path, &options)? != key {
      return Err("RAW changed during preparation; retry".into());
    }
    let digest =
      Sha256::digest(format!("smart-preview:1:{}:{key}", raw_develop::PIPELINE_VERSION).as_bytes());
    Ok(SmartPreview {
      data: data.into(),
      engine: match engine {
        raw_develop::Engine::Apple => "apple",
        _ => "adobe",
      }
      .into(),
      token: format!("{digest:x}"),
    })
  })();
  done.store(true, Ordering::Relaxed);
  if let Some(w) = watcher {
    let _ = w.join();
  }
  result.map_err(napi::Error::from_reason)
}
