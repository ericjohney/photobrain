//! Explicit Linux CUDA/cuDNN executor. FP32 graph, TF32 off, no CPU fallback.
use super::{Model, Tensor, invalid};
use crate::{Cancel, Result};

#[cfg(target_os = "linux")]
pub(crate) use platform::{CudaModel, identity};

#[cfg(target_os = "linux")]
mod platform {
  use super::*;
  use ort::{
    execution_providers::{
      ArenaExtendStrategy, CUDAExecutionProvider, cuda::CUDAExecutionProviderCuDNNConvAlgoSearch,
    },
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor as OrtTensor,
  };
  use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};

  // Per model arena; the Fuji partial-strength path retains two models. This
  // bounds ORT allocations including workspace, NOT total process VRAM. cuDNN 9
  // frontend plans can exceed the legacy 32 MiB workspace preference.
  const ARENA_BYTES: usize = 3072 * 1024 * 1024;
  const DETAILS_ARENA_BYTES: usize = 384 * 1024 * 1024;
  static GATE: Mutex<()> = Mutex::new(());
  static IDENTITY: OnceLock<std::result::Result<String, String>> = OnceLock::new();
  fn ort_error(e: ort::Error) -> crate::Error {
    invalid(format!("CUDA/ONNX Runtime: {e}"))
  }

  pub(crate) fn identity() -> Result<String> {
    IDENTITY
      .get_or_init(|| runtime_identity().map_err(|e| e.to_string()))
      .clone()
      .map_err(invalid)
  }

  fn gate(cancel: &Cancel) -> Result<MutexGuard<'static, ()>> {
    loop {
      cancel.check()?;
      match GATE.try_lock() {
        Ok(g) => return Ok(g),
        Err(TryLockError::Poisoned(_)) => return Err(invalid("CUDA inference lock poisoned")),
        Err(TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(1)),
      }
    }
  }

  struct Libraries {
    driver: libloading::Library,
    runtime: libloading::Library,
    cudnn: libloading::Library,
    cublas: libloading::Library,
  }
  static LIBRARIES: OnceLock<std::result::Result<Libraries, String>> = OnceLock::new();
  fn libraries() -> Result<&'static Libraries> {
    // CUDA libraries retain process/thread state. Keep inspection handles alive
    // for the process, just as ORT retains its execution-provider libraries.
    LIBRARIES
      .get_or_init(|| unsafe {
        Ok(Libraries {
          driver: libloading::Library::new("libcuda.so.1").map_err(|e| e.to_string())?,
          runtime: libloading::Library::new("libcudart.so.12").map_err(|e| e.to_string())?,
          cudnn: libloading::Library::new("libcudnn.so.9").map_err(|e| e.to_string())?,
          cublas: libloading::Library::new("libcublas.so.12").map_err(|e| e.to_string())?,
        })
      })
      .as_ref()
      .map_err(|e| invalid(format!("CUDA library: {e}")))
  }

  // Public CUDA driver/runtime/library APIs; handles remain alive through calls.
  // Query CUDA ordinal zero, exactly the ordinal used by the execution provider,
  // rather than assuming nvidia-smi enumeration matches CUDA_VISIBLE_DEVICES.
  fn runtime_identity() -> Result<String> {
    // ORT 1.20's cuDNN 9 frontend can retry unsupported plans with TF32 enabled.
    // The vendor override forbids TF32 even in that fallback. It must be set
    // before any CUDA user initializes; never mutate process env in this library.
    if std::env::var("NVIDIA_TF32_OVERRIDE").as_deref() != Ok("0") {
      return Err(invalid(
        "CUDA FP32 requires NVIDIA_TF32_OVERRIDE=0 at process startup",
      ));
    }
    use std::ffi::{CStr, c_char, c_int};
    let fail = |e: libloading::Error| invalid(format!("CUDA library: {e}"));
    let check = |code: i32| {
      if code == 0 {
        Ok(())
      } else {
        Err(invalid(format!("CUDA identity query failed: {code}")))
      }
    };
    unsafe {
      let libs = libraries()?;
      let driver = &libs.driver;
      check(driver
        .get::<unsafe extern "C" fn(u32) -> c_int>(b"cuInit\0")
        .map_err(fail)?(0))?;
      let mut device = 0;
      check(driver
        .get::<unsafe extern "C" fn(*mut c_int, c_int) -> c_int>(b"cuDeviceGet\0")
        .map_err(fail)?(&mut device, 0))?;
      let mut name = [0 as c_char; 256];
      check(driver
        .get::<unsafe extern "C" fn(*mut c_char, c_int, c_int) -> c_int>(b"cuDeviceGetName\0")
        .map_err(fail)?(name.as_mut_ptr(), 256, device))?;
      let mut uuid = [0u8; 16];
      check(driver
        .get::<unsafe extern "C" fn(*mut u8, c_int) -> c_int>(b"cuDeviceGetUuid_v2\0")
        .map_err(fail)?(uuid.as_mut_ptr(), device))?;
      let mut driver_version = 0;
      check(driver
        .get::<unsafe extern "C" fn(*mut c_int) -> c_int>(b"cuDriverGetVersion\0")
        .map_err(fail)?(&mut driver_version))?;
      // The kernel module release distinguishes driver patches with the same API version.
      let kernel_driver = std::fs::read_to_string("/proc/driver/nvidia/version")?;
      let runtime = &libs.runtime;
      let mut runtime_version = 0;
      check(runtime
        .get::<unsafe extern "C" fn(*mut c_int) -> c_int>(b"cudaRuntimeGetVersion\0")
        .map_err(fail)?(&mut runtime_version))?;
      let cudnn = &libs.cudnn;
      let cudnn_version = cudnn
        .get::<unsafe extern "C" fn() -> usize>(b"cudnnGetVersion\0")
        .map_err(fail)?();
      let cublas = &libs.cublas;
      let property = cublas
        .get::<unsafe extern "C" fn(c_int, *mut c_int) -> c_int>(b"cublasGetProperty\0")
        .map_err(fail)?;
      let mut blas = [0; 3];
      for (i, v) in blas.iter_mut().enumerate() {
        check(property(i as c_int, v))?;
      }
      let uuid: String = uuid.iter().map(|v| format!("{v:02x}")).collect();
      Ok(format!(
        "cuda-onnx-f32-v1:compact-nearest-pointwise=1:tf32=0:deterministic=1:opt=basic:algo=heuristic:tf32-override=0:workspace-preference=limited:arena={ARENA_BYTES}:details-arena={DETAILS_ARENA_BYTES}:memory-pattern=off:device={uuid}:name={}:driver-api={driver_version}:driver={}:runtime={runtime_version}:cudnn={cudnn_version}:cublas={blas:?}:ort={}",
        CStr::from_ptr(name.as_ptr()).to_string_lossy(),
        kernel_driver.trim(),
        ort::info()
      ))
    }
  }

  fn check_headroom(arena: usize) -> Result<()> {
    // This is a preflight, not a reservation against other processes. Fail before
    // constructing a session when the known arena plus library margin cannot fit.
    unsafe {
      let runtime = &libraries()?.runtime;
      let set = runtime
        .get::<unsafe extern "C" fn(i32) -> i32>(b"cudaSetDevice\0")
        .map_err(|e| invalid(e.to_string()))?;
      let query = runtime
        .get::<unsafe extern "C" fn(*mut usize, *mut usize) -> i32>(b"cudaMemGetInfo\0")
        .map_err(|e| invalid(e.to_string()))?;
      let (mut free, mut total) = (0, 0);
      if set(0) != 0 || query(&mut free, &mut total) != 0 {
        return Err(invalid("CUDA memory headroom query failed"));
      }
      let required = arena + 256 * 1024 * 1024;
      if free < required {
        return Err(invalid(format!(
          "CUDA requires at least {} MiB free before loading this model; {} MiB available. Other GPU workloads must release memory",
          required / 1048576,
          free / 1048576
        )));
      }
    }
    Ok(())
  }

  pub(crate) struct CudaModel {
    session: Mutex<Session>,
    identity: String,
    input_shape: [usize; 3],
    output_shape: [usize; 3],
  }
  impl CudaModel {
    pub(crate) fn new(model: &Model) -> Result<Self> {
      let identity = identity()?;
      let _gate = gate(&Cancel::never())?;
      let arena = if model.manifest.variant == super::super::Variant::XtransDetails {
        DETAILS_ARENA_BYTES
      } else {
        ARENA_BYTES
      };
      check_headroom(arena)?;
      let cuda = CUDAExecutionProvider::default()
        .with_device_id(0)
        .with_memory_limit(arena)
        .with_arena_extend_strategy(ArenaExtendStrategy::SameAsRequested)
        .with_conv_algorithm_search(CUDAExecutionProviderCuDNNConvAlgoSearch::Heuristic)
        .with_conv_max_workspace(false)
        .with_copy_in_default_stream(true)
        .with_tf32(false)
        .build()
        .error_on_failure();
      // Basic optimizations avoid fused Conv+activation arithmetic changes.
      // CPU fallback is disabled so an unsupported operator fails initialization.
      let session = Session::builder()
        .map_err(ort_error)?
        .with_execution_providers([cuda])
        .map_err(ort_error)?
        .with_config_entry("session.disable_cpu_ep_fallback", "1")
        .map_err(ort_error)?
        .with_optimization_level(GraphOptimizationLevel::Level1)
        .map_err(ort_error)?
        .with_deterministic_compute(true)
        .map_err(ort_error)?
        .with_parallel_execution(false)
        .map_err(ort_error)?
        .with_memory_pattern(false)
        .map_err(ort_error)?
        .with_intra_threads(1)
        .map_err(ort_error)?
        .commit_from_memory(&model.to_onnx())
        .map_err(ort_error)?;
      eprintln!("denoise: selected {identity}");
      Ok(Self {
        session: Mutex::new(session),
        identity,
        input_shape: model.manifest.input_shape,
        output_shape: model.manifest.output_shape,
      })
    }
    pub(crate) fn identity(&self) -> &str {
      &self.identity
    }
    pub(crate) fn predict(&self, input: &Tensor, cancel: &Cancel) -> Result<Tensor> {
      cancel.check()?;
      if input.shape() != self.input_shape {
        return Err(invalid("model input shape mismatch"));
      }
      let _gate = gate(cancel)?;
      let session = self
        .session
        .lock()
        .map_err(|_| invalid("CUDA model lock poisoned"))?;
      cancel.check()?;
      let [c, h, w] = self.input_shape;
      let tensor = OrtTensor::from_array(([1, c, h, w], input.data())).map_err(ort_error)?;
      let inputs = ort::inputs![tensor].map_err(ort_error)?;
      let result = session.run(inputs);
      // Run is synchronous, including the output's device-to-host transfer.
      // Complete the prediction, then discard it if cancelled; buffers are safe
      // to reuse and no partial tile/cache is published.
      cancel.check()?;
      let output = result.map_err(ort_error)?;
      let (shape, data) = output[0]
        .try_extract_raw_tensor::<f32>()
        .map_err(ort_error)?;
      let [c, h, w] = self.output_shape;
      if shape != [1, c as i64, h as i64, w as i64] {
        return Err(invalid("CUDA output shape mismatch"));
      }
      Tensor::new(self.output_shape, data.to_vec())
    }
  }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn identity() -> Result<String> {
  Err(invalid("CUDA denoise is available only on Linux"))
}
#[cfg(not(target_os = "linux"))]
pub(crate) struct CudaModel;
#[cfg(not(target_os = "linux"))]
impl CudaModel {
  pub(crate) fn new(_: &Model) -> Result<Self> {
    Err(invalid("CUDA denoise is available only on Linux"))
  }
  pub(crate) fn identity(&self) -> &str {
    unreachable!()
  }
  pub(crate) fn predict(&self, _: &Tensor, _: &Cancel) -> Result<Tensor> {
    Err(invalid("CUDA denoise is available only on Linux"))
  }
}
