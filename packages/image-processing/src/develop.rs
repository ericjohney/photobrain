//! Full RAW development through `raw-develop` (Apple RawCamera-equivalent pipeline), for
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
}

/// Error message of a develop stopped through its cancel flag.
pub const DEVELOP_CANCELLED: &str = "DEVELOP_CANCELLED";

/// Develop a RAW file at full resolution (orientation applied) and encode it as a JPEG
/// tagged Display P3. Fails for formats or cameras `raw-develop` does not support.
///
/// `cancel` is an optional `Int32Array` over a `SharedArrayBuffer`: setting element 0 to
/// a non-zero value (from any thread) stops the develop at its next check, failing with
/// the message `DEVELOP_CANCELLED`.
#[napi]
pub fn render_developed_raw(
  path: String,
  quality: u32,
  cancel: Option<Int32Array>,
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
  develop_internal(&path, quality as u8, flag).map_err(napi::Error::from_reason)
}

fn develop_internal(
  path: &str,
  quality: u8,
  flag: Option<*const AtomicI32>,
) -> Result<DevelopedRaw, String> {
  use raw_develop::{DevelopSettings, Error, Negative, Options, develop, encode};
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
    let neg = Negative::open(path).map_err(msg)?;
    token.check().map_err(msg)?;
    let opts = Options {
      cancel: token.clone(),
      ..Options::default()
    };
    let out = develop(&neg, &DevelopSettings::default(), &opts).map_err(msg)?;
    token.check().map_err(msg)?;
    let jpeg = encode::encode(&out.image, encode::Format::Jpeg(quality)).map_err(msg)?;
    Ok((out, jpeg))
  })();
  done.store(true, Ordering::Relaxed);
  if let Some(w) = watcher {
    let _ = w.join();
  }
  let (out, jpeg) = result?;
  Ok(DevelopedRaw {
    jpeg: jpeg.into(),
    width: out.image.width as u32,
    height: out.image.height as u32,
  })
}
