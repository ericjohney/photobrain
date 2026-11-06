//! Explicit Core ML execution of checksum-bound external models. The compiler
//! chooses internal precision and placement; this is not an FP32-exact backend.
use super::{Backend, Cancel, Model, Result, Tensor, invalid};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
  io::Read,
  path::Path,
  sync::{Mutex, MutexGuard, TryLockError},
};

static INFERENCE_GATE: Mutex<()> = Mutex::new(());

pub(super) fn identity(backend: Backend) -> Result<String> {
  let mode = match backend {
    Backend::CoreMl => "all",
    Backend::CoreMlGpu => "cpu-gpu",
    _ => return Err(invalid("invalid Core ML compute mode")),
  };
  Ok(format!(
    "coreml-v1:{mode}:low-precision-accumulation=false:{}",
    platform::identity()?
  ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
  format_version: u32,
  bundle_sha256: String,
  model_sha256: String,
  input_shape: [usize; 3],
  output_shape: [usize; 3],
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
  let file = std::fs::File::open(path)?;
  let meta = file.metadata()?;
  if !meta.is_file() || meta.len() > limit {
    return Err(invalid("Core ML companion file exceeds size limit"));
  }
  let mut bytes = Vec::with_capacity(meta.len() as usize);
  file.take(limit + 1).read_to_end(&mut bytes)?;
  if bytes.len() as u64 > limit {
    return Err(invalid("Core ML companion file grew beyond size limit"));
  }
  Ok(bytes)
}

fn validated_asset(path: &Path, model: &Model) -> Result<(Vec<u8>, String)> {
  let binding: Binding =
    serde_json::from_slice(&read_bounded(&path.with_extension("coreml.json"), 4096)?)
      .map_err(|e| invalid(format!("Core ML binding: {e}")))?;
  if binding.format_version != 1
    || binding.bundle_sha256 != model.bundle_sha256
    || binding.input_shape != model.manifest.input_shape
    || binding.output_shape != model.manifest.output_shape
  {
    return Err(invalid(
      "Core ML binding does not match the PBDN model; run prepare_coreml.py",
    ));
  }
  let bytes = read_bounded(&path.with_extension("mlmodel"), 128 * 1024 * 1024)?;
  let digest = format!("{:x}", Sha256::digest(&bytes));
  if digest != binding.model_sha256
    || (model.manifest.format_version == 1 && digest != model.manifest.source_sha256)
  {
    return Err(invalid("Core ML model checksum mismatch"));
  }
  Ok((bytes, digest))
}

pub(super) struct CoreMlModel {
  native: Mutex<platform::Native>,
  identity: String,
  input_shape: [usize; 3],
  output_shape: [usize; 3],
}

impl CoreMlModel {
  pub(super) fn load(path: &Path, model: &Model, backend: Backend) -> Result<Self> {
    let runtime = identity(backend)?;
    let (bytes, digest) = validated_asset(path, model)?;
    let native = platform::Native::new(
      &bytes,
      backend == Backend::CoreMl,
      model.manifest.input_shape,
      model.manifest.output_shape,
    )?;
    let identity = format!("{runtime}:model={digest}");
    eprintln!("denoise: selected {identity}");
    Ok(Self {
      native: Mutex::new(native),
      identity,
      input_shape: model.manifest.input_shape,
      output_shape: model.manifest.output_shape,
    })
  }

  pub(super) fn identity(&self) -> &str {
    &self.identity
  }

  pub(super) fn predict(&self, input: &Tensor, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    if input.shape() != self.input_shape {
      return Err(invalid("model input shape mismatch"));
    }
    let _gate = cancellable_lock(&INFERENCE_GATE, cancel)?;
    let mut native = self
      .native
      .lock()
      .map_err(|_| invalid("Core ML model lock poisoned"))?;
    cancel.check()?;
    let mut output = vec![0.0; self.output_shape.iter().product()];
    let result = native.predict(input.data(), &mut output);
    // Core ML's synchronous prediction cannot be preempted. Discard the entire
    // tile if cancellation arrived during the call; never publish partial pixels.
    cancel.check()?;
    result?;
    Tensor::new(self.output_shape, output)
  }
}

fn cancellable_lock<'a>(mutex: &'a Mutex<()>, cancel: &Cancel) -> Result<MutexGuard<'a, ()>> {
  loop {
    cancel.check()?;
    match mutex.try_lock() {
      Ok(guard) => return Ok(guard),
      Err(TryLockError::Poisoned(_)) => return Err(invalid("Core ML inference lock poisoned")),
      Err(TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(1)),
    }
  }
}

#[cfg(target_os = "macos")]
mod platform {
  use super::*;
  use std::ffi::{CStr, c_char, c_void};
  unsafe extern "C" {
    fn pb_coreml_identity(out: *mut c_char, capacity: usize) -> i32;
    fn pb_coreml_create(
      bytes: *const u8,
      len: usize,
      all: bool,
      input: *const usize,
      output: *const usize,
      error: *mut c_char,
      capacity: usize,
    ) -> *mut c_void;
    fn pb_coreml_predict(
      model: *mut c_void,
      input: *const f32,
      output: *mut f32,
      error: *mut c_char,
      capacity: usize,
    ) -> i32;
    fn pb_coreml_destroy(model: *mut c_void);
  }
  fn message(buffer: &[c_char]) -> String {
    // Native calls always terminate their bounded output buffer.
    unsafe { CStr::from_ptr(buffer.as_ptr()) }
      .to_string_lossy()
      .into_owned()
  }
  pub(super) fn identity() -> Result<String> {
    let mut buffer = [0; 2048];
    if unsafe { pb_coreml_identity(buffer.as_mut_ptr(), buffer.len()) } != 0 {
      return Err(invalid(message(&buffer)));
    }
    Ok(message(&buffer))
  }
  pub(super) struct Native(*mut c_void);
  // The retained Objective-C model owns its input storage. Every access is
  // serialized by the Rust mutex; no Rust borrow is retained by Core ML.
  unsafe impl Send for Native {}
  impl Native {
    pub(super) fn new(
      bytes: &[u8],
      all: bool,
      input: [usize; 3],
      output: [usize; 3],
    ) -> Result<Self> {
      let mut error = [0; 2048];
      let handle = unsafe {
        pb_coreml_create(
          bytes.as_ptr(),
          bytes.len(),
          all,
          input.as_ptr(),
          output.as_ptr(),
          error.as_mut_ptr(),
          error.len(),
        )
      };
      if handle.is_null() {
        Err(invalid(message(&error)))
      } else {
        Ok(Self(handle))
      }
    }
    pub(super) fn predict(&mut self, input: &[f32], output: &mut [f32]) -> Result<()> {
      let mut error = [0; 2048];
      if unsafe {
        pb_coreml_predict(
          self.0,
          input.as_ptr(),
          output.as_mut_ptr(),
          error.as_mut_ptr(),
          error.len(),
        )
      } != 0
      {
        Err(invalid(message(&error)))
      } else {
        Ok(())
      }
    }
  }
  impl Drop for Native {
    fn drop(&mut self) {
      unsafe { pb_coreml_destroy(self.0) };
    }
  }
}

#[cfg(not(target_os = "macos"))]
mod platform {
  use super::*;
  pub(super) struct Native;
  pub(super) fn identity() -> Result<String> {
    Err(invalid("Core ML is available only on macOS"))
  }
  impl Native {
    pub(super) fn new(_: &[u8], _: bool, _: [usize; 3], _: [usize; 3]) -> Result<Self> {
      Err(invalid("Core ML is available only on macOS"))
    }
    pub(super) fn predict(&mut self, _: &[f32], _: &mut [f32]) -> Result<()> {
      Err(invalid("Core ML is available only on macOS"))
    }
  }
}
