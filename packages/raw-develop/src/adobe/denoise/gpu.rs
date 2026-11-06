//! Shared Metal/Vulkan graph executor. Weights and a liveness-planned activation
//! arena stay on the device across tiles. Only input and final output cross it.
use super::{Backend, Buffer, Cancel, Model, Op, Result, Tensor, invalid};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, TryLockError};
use wgpu::util::DeviceExt;

pub(super) struct Context {
  device: wgpu::Device,
  queue: wgpu::Queue,
  layout: wgpu::BindGroupLayout,
  element: wgpu::ComputePipeline,
  convolution: wgpu::ComputePipeline,
  spatial_3x3: wgpu::ComputePipeline,
  spatial_2x2: wgpu::ComputePipeline,
  pointwise: wgpu::ComputePipeline,
  pointwise_wide: wgpu::ComputePipeline,
  identity: String,
  gate: Mutex<()>,
  fault: Arc<Mutex<Option<String>>>,
}

static CONTEXT: OnceLock<std::result::Result<Arc<Context>, String>> = OnceLock::new();

pub(super) fn context(backend: Backend) -> std::result::Result<Arc<Context>, String> {
  let native = if cfg!(target_os = "macos") {
    Backend::Metal
  } else {
    Backend::Vulkan
  };
  if matches!(backend, Backend::Metal | Backend::Vulkan) && backend != native {
    return Err(format!("{backend:?} is unavailable on this platform"));
  }
  CONTEXT.get_or_init(|| Context::new().map(Arc::new)).clone()
}

impl Context {
  pub(super) fn identity(&self) -> &str {
    &self.identity
  }
  fn new() -> std::result::Result<Self, String> {
    let backends = if cfg!(target_os = "macos") {
      wgpu::Backends::METAL
    } else {
      wgpu::Backends::VULKAN
    };
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
      backends,
      ..Default::default()
    });
    let mut adapters = instance.enumerate_adapters(backends);
    // Never mistake a Vulkan software adapter (e.g. llvmpipe) for acceleration.
    adapters.retain(|a| {
      matches!(
        a.get_info().device_type,
        wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
      )
    });
    adapters.sort_by_key(|a| a.get_info().device_type != wgpu::DeviceType::DiscreteGpu);
    let adapter = adapters
      .into_iter()
      .next()
      .ok_or("no hardware Metal/Vulkan adapter")?;
    let info = adapter.get_info();
    let limits = adapter.limits();
    let requested = wgpu::Limits {
      max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size.min(1 << 30),
      max_buffer_size: limits.max_buffer_size.min(1 << 30),
      ..Default::default()
    };
    let (device, queue) = pollster::block_on(adapter.request_device(
      &wgpu::DeviceDescriptor {
        label: Some("PhotoBrain denoise FP32"),
        required_features: wgpu::Features::empty(),
        required_limits: requested,
        memory_hints: wgpu::MemoryHints::MemoryUsage,
      },
      None,
    ))
    .map_err(|e| e.to_string())?;
    let fault = Arc::new(Mutex::new(None));
    let lost = fault.clone();
    device.set_device_lost_callback(move |reason, message| {
      if let Ok(mut value) = lost.lock() {
        *value = Some(format!("GPU device lost ({reason:?}): {message}"));
      }
    });
    let uncaptured = fault.clone();
    device.on_uncaptured_error(Box::new(move |error| {
      if let Ok(mut value) = uncaptured.lock() {
        *value = Some(format!("GPU error: {error}"));
      }
    }));
    device.push_error_scope(wgpu::ErrorFilter::Internal);
    device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    device.push_error_scope(wgpu::ErrorFilter::Validation);
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
      label: Some("denoise graph operands"),
      entries: &[
        binding(0, true),
        binding(1, true),
        binding(2, true),
        binding(3, false),
        wgpu::BindGroupLayoutEntry {
          binding: 4,
          visibility: wgpu::ShaderStages::COMPUTE,
          ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
          },
          count: None,
        },
      ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
      label: Some("denoise"),
      bind_group_layouts: &[&layout],
      push_constant_ranges: &[],
    });
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
      label: Some("denoise FP32 kernels"),
      source: wgpu::ShaderSource::Wgsl(include_str!("gpu.wgsl").into()),
    });
    let pipeline = |entry| {
      device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
      })
    };
    let element = pipeline("element");
    let convolution = pipeline("convolution");
    let spatial = |size: u32| {
      device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("denoise spatial specialization"),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some("convolution"),
        compilation_options: wgpu::PipelineCompilationOptions {
          constants: &std::collections::HashMap::from([
            ("KERNEL_H".into(), size as f64),
            ("KERNEL_W".into(), size as f64),
          ]),
          ..Default::default()
        },
        cache: None,
      })
    };
    let spatial_3x3 = spatial(3);
    let spatial_2x2 = spatial(2);
    let pointwise = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
      label: Some("denoise pointwise"),
      layout: Some(&pipeline_layout),
      module: &module,
      entry_point: Some("convolution"),
      compilation_options: wgpu::PipelineCompilationOptions {
        constants: &std::collections::HashMap::from([("POINTWISE".into(), 1.0)]),
        ..Default::default()
      },
      cache: None,
    });
    let pointwise_wide = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
      label: Some("denoise wide pointwise"),
      layout: Some(&pipeline_layout),
      module: &module,
      entry_point: Some("convolution"),
      compilation_options: wgpu::PipelineCompilationOptions {
        constants: &std::collections::HashMap::from([
          ("POINTWISE".into(), 1.0),
          ("COLS_PER_THREAD".into(), 8.0),
        ]),
        ..Default::default()
      },
      cache: None,
    });
    let validation = pollster::block_on(device.pop_error_scope());
    let memory = pollster::block_on(device.pop_error_scope());
    let internal = pollster::block_on(device.pop_error_scope());
    if let Some(error) = validation.or(memory).or(internal) {
      return Err(error.to_string());
    }
    // Metal does not expose a driver version through AdapterInfo. Include the
    // OS build so an OS/compiler update cannot reuse old floating-point pixels.
    let os_build = if cfg!(target_os = "macos") {
      std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "kern.osversion"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .ok_or("cannot identify Metal OS build")?
    } else {
      String::new()
    };
    let identity = format!(
      "wgpu24-f32-v3:{:?}:{}:{:x}:{:x}:{}:{}:{os_build}",
      info.backend, info.name, info.vendor, info.device, info.driver, info.driver_info
    );
    eprintln!("denoise: selected {identity}");
    Ok(Self {
      device,
      queue,
      layout,
      element,
      convolution,
      spatial_3x3,
      spatial_2x2,
      pointwise,
      pointwise_wide,
      identity,
      gate: Mutex::new(()),
      fault,
    })
  }

  fn lock(&self, cancel: &Cancel) -> Result<MutexGuard<'_, ()>> {
    loop {
      cancel.check()?;
      match self.gate.try_lock() {
        Ok(guard) => {
          self.check()?;
          return Ok(guard);
        }
        Err(TryLockError::Poisoned(_)) => return Err(invalid("GPU executor unavailable")),
        Err(TryLockError::WouldBlock) => std::thread::sleep(std::time::Duration::from_millis(5)),
      }
    }
  }

  fn check(&self) -> Result<()> {
    match self.fault.lock() {
      Ok(fault) => match fault.as_ref() {
        Some(message) => Err(invalid(message.clone())),
        None => Ok(()),
      },
      Err(_) => Err(invalid("GPU error state unavailable")),
    }
  }
}

fn binding(index: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
  wgpu::BindGroupLayoutEntry {
    binding: index,
    visibility: wgpu::ShaderStages::COMPUTE,
    ty: wgpu::BindingType::Buffer {
      ty: wgpu::BufferBindingType::Storage { read_only },
      has_dynamic_offset: false,
      min_binding_size: None,
    },
    count: None,
  }
}

struct Step {
  name: String,
  node: usize,
  bindings: wgpu::BindGroup,
  convolution: bool,
  kernel: [usize; 2],
  pointwise: bool,
  wide_pointwise: bool,
  dispatch: [u32; 3],
}

pub(super) struct GpuModel {
  context: Arc<Context>,
  buffers: Vec<wgpu::Buffer>,
  input: usize,
  output: usize,
  input_shape: [usize; 3],
  output_shape: [usize; 3],
  readback: wgpu::Buffer,
  steps: Vec<Step>,
}

impl GpuModel {
  pub(super) fn identity(&self) -> &str {
    &self.context.identity
  }

  pub(super) fn new(model: &Model, context: Arc<Context>) -> Result<Self> {
    let _guard = context.lock(&Cancel::never())?;
    let device = &context.device;
    device.push_error_scope(wgpu::ErrorFilter::Internal);
    device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    device.push_error_scope(wgpu::ErrorFilter::Validation);
    // Always pop scopes, including when our own shape/memory validation fails.
    let result = Self::compile(model, context.clone());
    let validation = pollster::block_on(device.pop_error_scope());
    let memory = pollster::block_on(device.pop_error_scope());
    let internal = pollster::block_on(device.pop_error_scope());
    if let Some(error) = validation.or(memory).or(internal) {
      return Err(invalid(format!("GPU graph: {error}")));
    }
    context.check()?;
    result
  }

  fn compile(model: &Model, context: Arc<Context>) -> Result<Self> {
    let device = &context.device;
    let mut buffers: Vec<wgpu::Buffer> = Vec::new();
    let mut free = Vec::<usize>::new();
    let mut nodes = vec![0; model.shapes.len()];
    let mut aliases: Vec<_> = (0..model.shapes.len()).collect();
    let mut skipped = vec![false; model.manifest.layers.len()];
    let mut slopes = vec![None; model.manifest.layers.len()];
    let mut residuals = vec![None; model.manifest.layers.len()];
    let mut expansions = vec![1; model.manifest.layers.len()];
    let mut inputs: Vec<_> = model
      .manifest
      .layers
      .iter()
      .map(|layer| layer.inputs.clone())
      .collect();
    // Eliminate copies and fold single-consumer operations into convolution.
    // Resolve aliases before liveness planning so the actual allocation stays
    // live through every logical user, including a fused residual's extra input.
    for (i, layer) in model.manifest.layers.iter().enumerate() {
      let alias = match layer.op {
        Op::Identity {} => Some(aliases[layer.inputs[0]]),
        Op::Upsample { scale: [2, 2] }
          if model.uses[i + 1] == 1
            && model.manifest.layers.get(i + 1).is_some_and(|next| {
              next.inputs == [i + 1]
                && matches!(
                  next.op,
                  Op::Conv2d {
                    kernel: [1, 1],
                    stride: [1, 1],
                    padding: [0, 0, 0, 0],
                    groups: 1,
                    ..
                  }
                )
            }) =>
        {
          // The same channel vector would be evaluated four times. Evaluate it
          // once, then expand the final value into the original output tensor.
          expansions[i + 1] = 2;
          inputs[i + 1][0] = layer.inputs[0];
          Some(aliases[layer.inputs[0]])
        }
        Op::LeakyRelu { alpha } if layer.inputs[0] > 0 => {
          let source = layer.inputs[0];
          if model.uses[source] == 1
            && matches!(model.manifest.layers[source - 1].op, Op::Conv2d { .. })
          {
            slopes[source - 1] = Some(alpha);
            Some(source)
          } else {
            None
          }
        }
        Op::Add {} if i > 0 && model.uses[i] == 1 => {
          // Adjacency guarantees that the other operand is ready when the
          // convolution runs. Do not follow an activation/Add alias here:
          // their arithmetic must retain its original order.
          let other = if layer.inputs[0] == i {
            Some(layer.inputs[1])
          } else if layer.inputs[1] == i {
            Some(layer.inputs[0])
          } else {
            None
          };
          if let Some(other) = other.filter(|&node| node < i)
            && matches!(model.manifest.layers[i - 1].op, Op::Conv2d { .. })
          {
            residuals[i - 1] = Some(other);
            inputs[i - 1].push(other);
            Some(i)
          } else {
            None
          }
        }
        _ => None,
      };
      if let Some(alias) = alias {
        aliases[i + 1] = alias;
        skipped[i] = true;
      }
    }
    let mut uses = vec![0usize; nodes.len()];
    for (i, layer_inputs) in inputs.iter().enumerate() {
      if !skipped[i] {
        for &j in layer_inputs {
          uses[aliases[j]] += 1;
        }
      }
    }
    uses[aliases[model.manifest.output]] += 1;
    let mut allocate = |bytes: u64, free: &mut Vec<usize>| -> Result<usize> {
      if bytes > device.limits().max_storage_buffer_binding_size as u64 {
        return Err(invalid("GPU tensor exceeds adapter buffer limit"));
      }
      if let Some((position, _)) = free
        .iter()
        .enumerate()
        .filter(|(_, i)| buffers[**i].size() >= bytes)
        .min_by_key(|(_, i)| buffers[**i].size())
      {
        return Ok(free.swap_remove(position));
      }
      if buffers.iter().map(|b| b.size()).sum::<u64>() + bytes > 4 << 30 {
        return Err(invalid("GPU graph arena exceeds 4 GiB"));
      }
      let index = buffers.len();
      buffers.push(device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("denoise reusable activation"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE
          | wgpu::BufferUsages::COPY_DST
          | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
      }));
      Ok(index)
    };
    nodes[0] = allocate(
      (model.shapes[0].iter().product::<usize>() * 4) as u64,
      &mut free,
    )?;
    // Plan before creating bindings; an input is reusable only AFTER its last
    // consuming dispatch, never for that dispatch's destination.
    for (i, layer_inputs) in inputs.iter().enumerate() {
      if skipped[i] {
        continue;
      }
      nodes[i + 1] = allocate(
        (model.shapes[i + 1].iter().product::<usize>() * 4) as u64,
        &mut free,
      )?;
      for &node in layer_inputs {
        let node = aliases[node];
        uses[node] -= 1;
        if uses[node] == 0 {
          free.push(nodes[node]);
        }
      }
    }
    let dummy = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
      label: Some("denoise unused operand"),
      contents: &[0; 16],
      usage: wgpu::BufferUsages::STORAGE,
    });
    let mut steps = Vec::new();
    for (i, layer) in model.manifest.layers.iter().enumerate() {
      if skipped[i] {
        continue;
      }
      let [ic, ih, iw] = model.shapes[aliases[inputs[i][0]]];
      let [oc, full_oh, full_ow] = model.shapes[i + 1];
      let oh = full_oh / expansions[i];
      let ow = full_ow / expansions[i];
      let count = oc * oh * ow;
      let pointwise = matches!(
        layer.op,
        Op::Conv2d {
          kernel: [1, 1],
          stride: [1, 1],
          padding: [0, 0, 0, 0],
          groups: 1,
          ..
        }
      );
      let wide_pointwise = pointwise && oc.is_multiple_of(64);
      let dispatch_x = count.div_ceil(256).min(65535);
      let mut p = [0u32; 32];
      for (slot, value) in p.iter_mut().zip([oc, oh, ow, ic, ih, iw]) {
        *slot = value as u32;
      }
      p[19] = dispatch_x as u32;
      p[20] = u32::from(residuals[i].is_some());
      p[21] = expansions[i] as u32;
      let mut dispatch = [
        dispatch_x as u32,
        count.div_ceil(256 * dispatch_x) as u32,
        1,
      ];
      let mut parameters = None;
      match &layer.op {
        Op::Identity {} => {}
        Op::LeakyRelu { alpha } => {
          p[14] = 1;
          p[15] = alpha.to_bits();
        }
        Op::Add {} => p[14] = 2,
        Op::Concat {} => {
          p[14] = 3;
          p[18] = model.shapes[layer.inputs[1]][0] as u32;
        }
        Op::Upsample { .. } => p[14] = 4,
        Op::Slice { axis, start, .. } => {
          p[14] = 5;
          p[16] = *axis as u32;
          p[17] = *start as u32;
        }
        Op::Conv2d {
          groups,
          kernel,
          stride,
          padding,
          weights,
          bias,
          ..
        } => {
          let k = ic / groups * kernel[0] * kernel[1];
          let channels = oc / groups;
          let mut data = vec![0f32; weights.count + bias.count];
          for group in 0..*groups {
            for c in 0..channels {
              for j in 0..k {
                data[(group * k + j) * channels + c] =
                  model.weights[weights.offset + (group * channels + c) * k + j];
              }
            }
          }
          data[weights.count..]
            .copy_from_slice(&model.weights[bias.offset..bias.offset + bias.count]);
          parameters = Some(
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
              label: Some(&layer.name),
              contents: bytemuck::cast_slice(&data),
              usage: wgpu::BufferUsages::STORAGE,
            }),
          );
          for (slot, value) in p[6..14].iter_mut().zip([
            kernel[0], kernel[1], stride[0], stride[1], padding[0], padding[2], *groups, k,
          ]) {
            *slot = value as u32;
          }
          if let Some(alpha) = slopes[i] {
            p[14] = 6;
            p[15] = alpha.to_bits();
          }
          dispatch = [
            (oh * ow).div_ceil(64) as u32,
            channels.div_ceil(if wide_pointwise { 64 } else { 32 }) as u32,
            *groups as u32,
          ];
        }
      }
      if dispatch
        .iter()
        .any(|&v| v > device.limits().max_compute_workgroups_per_dimension)
      {
        return Err(invalid("GPU graph dispatch exceeds adapter limits"));
      }
      let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("denoise geometry"),
        contents: bytemuck::cast_slice(&p),
        usage: wgpu::BufferUsages::UNIFORM,
      });
      let a = &buffers[nodes[aliases[inputs[i][0]]]];
      let b = inputs[i]
        .get(1)
        .map(|&j| &buffers[nodes[aliases[j]]])
        .unwrap_or(&dummy);
      let parameters = parameters.as_ref().unwrap_or(&dummy);
      let operands = [a, b, parameters, &buffers[nodes[i + 1]], &uniform];
      let entries: Vec<_> = operands
        .iter()
        .enumerate()
        .map(|(binding, buffer)| wgpu::BindGroupEntry {
          binding: binding as u32,
          resource: buffer.as_entire_binding(),
        })
        .collect();
      let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some(&layer.name),
        layout: &context.layout,
        entries: &entries,
      });
      steps.push(Step {
        name: layer.name.clone(),
        node: i + 1,
        bindings,
        convolution: matches!(layer.op, Op::Conv2d { .. }),
        kernel: match layer.op {
          Op::Conv2d { kernel, .. } => kernel,
          _ => [0, 0],
        },
        pointwise,
        wide_pointwise,
        dispatch,
      });
    }
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
      label: Some("denoise final readback"),
      size: (model.manifest.output_shape.iter().product::<usize>() * 4) as u64,
      usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
      mapped_at_creation: false,
    });
    eprintln!(
      "denoise: GPU arena {:.1} MiB, {} dispatches/tile",
      buffers.iter().map(|b| b.size()).sum::<u64>() as f64 / (1 << 20) as f64,
      steps.len()
    );
    Ok(Self {
      context,
      buffers,
      input: nodes[0],
      output: nodes[aliases[model.manifest.output]],
      input_shape: model.manifest.input_shape,
      output_shape: model.manifest.output_shape,
      readback,
      steps,
    })
  }

  pub(super) fn predict(&self, input: &Tensor, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    if input.shape() != self.input_shape {
      return Err(invalid("model input shape mismatch"));
    }
    let context = &self.context;
    let _guard = context.lock(cancel)?;
    let input = Buffer::from_planar(input);
    context.queue.write_buffer(
      &self.buffers[self.input],
      0,
      bytemuck::cast_slice(&input.data),
    );
    context.device.push_error_scope(wgpu::ErrorFilter::Internal);
    context
      .device
      .push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    context
      .device
      .push_error_scope(wgpu::ErrorFilter::Validation);
    let result = self.execute(cancel);
    let validation = pollster::block_on(context.device.pop_error_scope());
    let memory = pollster::block_on(context.device.pop_error_scope());
    let internal = pollster::block_on(context.device.pop_error_scope());
    if let Some(error) = validation.or(memory).or(internal) {
      return Err(invalid(format!("GPU inference: {error}")));
    }
    context.check()?;
    result
  }

  fn execute(&self, cancel: &Cancel) -> Result<Tensor> {
    let context = &self.context;
    // Diagnostic wall time includes submission and completion. A one-dispatch
    // batch isolates layers without requiring optional timestamp-query support.
    let profile = std::env::var_os("DENOISE_GPU_PROFILE").is_some_and(|v| v == "1");
    // Bound queued work: cancellation drains the current four layers before
    // returning. Scratch cannot be reused while a cancelled dispatch is live.
    for steps in self.steps.chunks(if profile { 1 } else { 4 }) {
      cancel.check()?;
      let start = profile.then(std::time::Instant::now);
      let mut encoder = context.device.create_command_encoder(&Default::default());
      for step in steps {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(if step.wide_pointwise {
          &context.pointwise_wide
        } else if step.pointwise {
          &context.pointwise
        } else if step.kernel == [3, 3] {
          &context.spatial_3x3
        } else if step.kernel == [2, 2] {
          &context.spatial_2x2
        } else if step.convolution {
          &context.convolution
        } else {
          &context.element
        });
        pass.set_bind_group(0, &step.bindings, &[]);
        pass.dispatch_workgroups(step.dispatch[0], step.dispatch[1], step.dispatch[2]);
      }
      context.queue.submit([encoder.finish()]);
      context.device.poll(wgpu::Maintain::Wait);
      context.check()?;
      if let Some(start) = start {
        let step = &steps[0];
        eprintln!(
          "{}",
          serde_json::json!({"gpu_profile": {
            "node": step.node, "name": step.name,
            "kind": if step.pointwise { "pointwise" } else if step.convolution { "spatial" } else { "element" },
            "dispatch": step.dispatch, "wall_seconds": start.elapsed().as_secs_f64()
          }})
        );
      }
    }
    cancel.check()?;
    let mut encoder = context.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(
      &self.buffers[self.output],
      0,
      &self.readback,
      0,
      self.readback.size(),
    );
    context.queue.submit([encoder.finish()]);
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    self
      .readback
      .slice(..)
      .map_async(wgpu::MapMode::Read, move |result| {
        let _ = tx.send(result);
      });
    context.device.poll(wgpu::Maintain::Wait);
    rx.recv()
      .map_err(|e| invalid(e.to_string()))?
      .map_err(|e| invalid(format!("GPU readback: {e}")))?;
    let data = {
      let view = self.readback.slice(..).get_mapped_range();
      bytemuck::cast_slice::<u8, f32>(&view).to_vec()
    };
    self.readback.unmap();
    cancel.check()?;
    Buffer::new(self.output_shape, data).to_planar()
  }
}
