//! Small owned C ABI for the native iOS editor. See include/RawDevelop.h for ownership.
//! Callers must pass live handles, serialise session use, and free each handle once.
#![allow(clippy::missing_safety_doc)] // The C header defines the contract for every entry point.

use raw_develop::{Cancel, DevelopSettings, Error, Negative, Options, Prepared, Quality, prepare};
use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::sync::OnceLock;

pub struct PBRAWSession {
  drag: Prepared,
  refined: Prepared,
}
pub struct PBRAWCancel(Cancel);
pub struct PBRAWImage {
  width: usize,
  height: usize,
  pixels: Vec<u8>,
}
#[repr(C)]
pub struct PBRAWError {
  pub code: i32,
  pub message: *mut c_char,
}

fn pool() -> &'static rayon::ThreadPool {
  static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
  POOL.get_or_init(|| {
    rayon::ThreadPoolBuilder::new()
      .num_threads(std::thread::available_parallelism().map_or(1, |n| usize::from(n).min(4)))
      .build()
      .expect("RAW render pool")
  })
}

unsafe fn token(cancel: *const PBRAWCancel) -> Cancel {
  if cancel.is_null() {
    Cancel::never()
  } else {
    unsafe { &*cancel }.0.clone()
  }
}

unsafe fn guarded<T>(error: *mut PBRAWError, f: impl FnOnce() -> raw_develop::Result<T>) -> *mut T {
  if !error.is_null() {
    // The caller must clear a previous error before reusing this slot.
    unsafe {
      *error = PBRAWError {
        code: 0,
        message: ptr::null_mut(),
      }
    };
  }
  let (code, message) = match catch_unwind(AssertUnwindSafe(f)) {
    Ok(Ok(value)) => return Box::into_raw(Box::new(value)),
    Ok(Err(e)) => {
      let code = match e {
        Error::Unsupported(_) | Error::NotRaw | Error::NotRaf => 2,
        Error::Settings(_) => 3,
        Error::Cancelled => 4,
        _ => 1,
      };
      (code, e.to_string())
    }
    Err(_) => (5, "The RAW renderer could not finish this image".into()),
  };
  if !error.is_null() {
    let message = CString::new(message.replace('\0', " ")).unwrap().into_raw();
    unsafe { *error = PBRAWError { code, message } };
  }
  ptr::null_mut()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_error_clear(error: *mut PBRAWError) {
  if let Some(e) = unsafe { error.as_mut() } {
    if !e.message.is_null() {
      drop(unsafe { CString::from_raw(e.message) });
    }
    e.code = 0;
    e.message = ptr::null_mut();
  }
}
#[unsafe(no_mangle)]
pub extern "C" fn pbraw_cancel_new() -> *mut PBRAWCancel {
  Box::into_raw(Box::new(PBRAWCancel(Cancel::new())))
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_cancel_request(cancel: *const PBRAWCancel) {
  if let Some(c) = unsafe { cancel.as_ref() } {
    c.0.cancel();
  }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_cancel_free(cancel: *mut PBRAWCancel) {
  if !cancel.is_null() {
    drop(unsafe { Box::from_raw(cancel) });
  }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_open(
  path: *const c_char,
  cancel: *const PBRAWCancel,
  error: *mut PBRAWError,
) -> *mut PBRAWSession {
  unsafe {
    guarded(error, || {
      if path.is_null() {
        return Err(Error::Settings("missing RAW path".into()));
      }
      let path = CStr::from_ptr(path)
        .to_str()
        .map_err(|_| Error::Settings("RAW path must be UTF-8".into()))?;
      let opts = Options {
        quality: Quality::Preview,
        cancel: token(cancel),
        ..Options::default()
      };
      opts.cancel.check()?;
      pool().install(|| {
        let neg = Negative::open(path)?;
        opts.cancel.check()?;
        let refined = prepare(&neg, &DevelopSettings::default(), &opts)?.with_max_edge(2048)?;
        drop(neg);
        opts.cancel.check()?;
        let drag = refined.clone().with_max_edge(1024)?;
        opts.cancel.check()?;
        Ok(PBRAWSession { drag, refined })
      })
    })
  }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_session_free(session: *mut PBRAWSession) {
  if !session.is_null() {
    drop(unsafe { Box::from_raw(session) });
  }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_render(
  session: *const PBRAWSession,
  exposure: f64,
  refined: i32,
  cancel: *const PBRAWCancel,
  error: *mut PBRAWError,
) -> *mut PBRAWImage {
  unsafe {
    guarded(error, || {
      let session = session
        .as_ref()
        .ok_or_else(|| Error::Settings("missing RAW session".into()))?;
      if !(0..=1).contains(&refined) {
        return Err(Error::Settings("refined must be 0 or 1".into()));
      }
      let opts = Options {
        quality: Quality::Preview,
        cancel: token(cancel),
        ..Options::default()
      };
      pool().install(|| {
        let prepared = if refined == 1 {
          &session.refined
        } else {
          &session.drag
        };
        let out = prepared
          .render(
            &DevelopSettings {
              exposure,
              ..DevelopSettings::default()
            },
            &opts,
          )?
          .image;
        opts.cancel.check()?;
        let mut pixels = Vec::with_capacity(out.width * out.height * 4);
        for row in out.data.chunks(out.width * 3) {
          opts.cancel.check()?;
          for rgb in row.as_chunks::<3>().0 {
            pixels.extend(
              rgb
                .iter()
                .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8),
            );
            pixels.push(255);
          }
        }
        Ok(PBRAWImage {
          width: out.width,
          height: out.height,
          pixels,
        })
      })
    })
  }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_image_width(image: *const PBRAWImage) -> usize {
  unsafe { image.as_ref() }.map_or(0, |i| i.width)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_image_height(image: *const PBRAWImage) -> usize {
  unsafe { image.as_ref() }.map_or(0, |i| i.height)
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_image_len(image: *const PBRAWImage) -> usize {
  unsafe { image.as_ref() }.map_or(0, |i| i.pixels.len())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_image_pixels(image: *const PBRAWImage) -> *const u8 {
  unsafe { image.as_ref() }.map_or(ptr::null(), |i| i.pixels.as_ptr())
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_image_free(image: *mut PBRAWImage) {
  if !image.is_null() {
    drop(unsafe { Box::from_raw(image) });
  }
}

/// Open server-prepared pixels, with no original decode or camera profile on device.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_open_smart_preview(
  bytes: *const u8,
  len: usize,
  cancel: *const PBRAWCancel,
  error: *mut PBRAWError,
) -> *mut PBRAWSession {
  unsafe {
    guarded(error, || {
      if bytes.is_null() || len > raw_develop::smart_preview::MAX_BYTES + 20 {
        return Err(Error::Settings("invalid smart preview bytes".into()));
      }
      let cancel = token(cancel);
      cancel.check()?;
      let bytes = std::slice::from_raw_parts(bytes, len);
      pool().install(|| {
        let refined = Prepared::decode_smart_preview(bytes)?;
        cancel.check()?;
        let drag = refined.clone().with_max_edge(1024)?;
        Ok(PBRAWSession { drag, refined })
      })
    })
  }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pbraw_render_basic(
  session: *const PBRAWSession,
  exposure: f64,
  contrast: i32,
  highlights: i32,
  shadows: i32,
  whites: i32,
  blacks: i32,
  refined: i32,
  cancel: *const PBRAWCancel,
  error: *mut PBRAWError,
) -> *mut PBRAWImage {
  unsafe {
    guarded(error, || {
      let session = session
        .as_ref()
        .ok_or_else(|| Error::Settings("missing RAW session".into()))?;
      if !(0..=1).contains(&refined) {
        return Err(Error::Settings("invalid refined flag".into()));
      }
      let prepared = if refined == 1 {
        &session.refined
      } else {
        &session.drag
      };
      let opts = prepared.render_options(token(cancel));
      let controls = raw_develop::settings::AdobeTone {
        contrast,
        highlights,
        shadows,
        whites,
        blacks,
      };
      if opts.engine != raw_develop::Engine::Adobe
        && [contrast, highlights, shadows, whites, blacks] != [0; 5]
      {
        return Err(Error::Settings("tone controls require Adobe".into()));
      }
      let settings = DevelopSettings {
        exposure,
        adobe_tone: (opts.engine == raw_develop::Engine::Adobe).then_some(controls),
        ..DevelopSettings::default()
      };
      pool().install(|| {
        let out = prepared.render(&settings, &opts)?.image;
        let mut pixels = Vec::with_capacity(out.width * out.height * 4);
        for row in out.data.chunks(out.width * 3) {
          opts.cancel.check()?;
          for rgb in row.as_chunks::<3>().0 {
            pixels.extend(
              rgb
                .iter()
                .map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8),
            );
            pixels.push(255);
          }
        }
        Ok(PBRAWImage {
          width: out.width,
          height: out.height,
          pixels,
        })
      })
    })
  }
}
