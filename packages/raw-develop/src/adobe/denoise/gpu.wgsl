// HWC activations, full FP32 arithmetic. No FP16/TF32 or approximate transfers.
struct Params {
  oc: u32, oh: u32, ow: u32, ic: u32,
  ih: u32, iw: u32, kh: u32, kw: u32,
  sh: u32, sw: u32, pt: u32, pl: u32,
  groups: u32, k: u32, op: u32, alpha: f32,
  axis: u32, start: u32, rhs_c: u32, disinput_tile_x: u32,
  residual: u32, output_scale: u32,
}
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
// Convolutions: K x output-channels per group, followed by all output biases.
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<uniform> p: Params;
override POINTWISE: bool = false;
override KERNEL_H: u32 = 0u;
override KERNEL_W: u32 = 0u;
override COLS_PER_THREAD: u32 = 4u;

@compute @workgroup_size(256)
fn element(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x + id.y * p.disinput_tile_x * 256u;
  if i >= p.oc * p.oh * p.ow { return; }
  let c = i % p.oc;
  let pixel = i / p.oc;
  let y = pixel / p.ow;
  let x = pixel % p.ow;
  var value = 0.0;
  switch p.op {
    case 0u: { value = a[i]; }
    case 1u: { value = select(a[i], a[i] * p.alpha, a[i] < 0.0); }
    case 2u: { value = a[i] + b[i]; }
    case 3u: {
      if c < p.ic { value = a[pixel * p.ic + c]; }
      else { value = b[pixel * p.rhs_c + c - p.ic]; }
    }
    case 4u: { value = a[((y / 2u) * p.iw + x / 2u) * p.ic + c]; }
    case 5u: {
      let sy = y + select(0u, p.start, p.axis == 1u);
      let sx = x + select(0u, p.start, p.axis == 2u);
      value = a[(sy * p.iw + sx) * p.ic + c];
    }
    default: {}
  }
  out[i] = value;
}

// Implicit im2col GEMM. Reuse both operands in workgroup memory.
const ROWS_PER_THREAD: u32 = 8u;
const TILE_K: u32 = 16u;
var<workgroup> input_tile: array<f32, 8u * ROWS_PER_THREAD * TILE_K>;
var<workgroup> weight_tile: array<vec4<f32>, 2u * COLS_PER_THREAD * TILE_K>;

fn store_convolution(index: u32, value: f32) {
  var result = value;
  if p.residual != 0u { result += b[index]; }
  out[index] = result;
}

@compute @workgroup_size(8, 8)
fn convolution(
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
) {
  let thread = local.y * 8u + local.x;
  let channels = p.oc / p.groups;
  let inputs = p.ic / p.groups;
  let kh = select(p.kh, KERNEL_H, KERNEL_H != 0u);
  let kw = select(p.kw, KERNEL_W, KERNEL_W != 0u);
  let base_pixel = group.x * 8u * ROWS_PER_THREAD;
  let column_vectors = 2u * COLS_PER_THREAD;
  let base_channel = group.y * 8u * COLS_PER_THREAD;
  var s0 = vec4<f32>(0.0);
  var s1 = vec4<f32>(0.0);
  var s2 = vec4<f32>(0.0);
  var s3 = vec4<f32>(0.0);
  var s4 = vec4<f32>(0.0);
  var s5 = vec4<f32>(0.0);
  var s6 = vec4<f32>(0.0);
  var s7 = vec4<f32>(0.0);
  var t0 = vec4<f32>(0.0);
  var t1 = vec4<f32>(0.0);
  var t2 = vec4<f32>(0.0);
  var t3 = vec4<f32>(0.0);
  var t4 = vec4<f32>(0.0);
  var t5 = vec4<f32>(0.0);
  var t6 = vec4<f32>(0.0);
  var t7 = vec4<f32>(0.0);
  for (var base_k = 0u; base_k < p.k; base_k += TILE_K) {
    // j advances by64, a multiple of TILE_K: every load by this thread
    // uses the same reduction coordinate. Decode it once, outside the rows.
    let input_k = base_k + thread % TILE_K;
    let ky = (input_k / kw) % kh;
    let kx = input_k % kw;
    let input_c = group.z * inputs + input_k / (kh * kw);
    for (var j = thread; j < 8u * ROWS_PER_THREAD * TILE_K; j += 64u) {
      let pixel = base_pixel + j / TILE_K;
      var v = 0.0;
      if pixel < p.oh * p.ow && input_k < p.k {
        if POINTWISE {
          v = a[pixel * p.ic + input_k];
        } else {
        let y = i32((pixel / p.ow) * p.sh + ky) - i32(p.pt);
        let x = i32((pixel % p.ow) * p.sw + kx) - i32(p.pl);
        if y >= 0 && x >= 0 && y < i32(p.ih) && x < i32(p.iw) {
          v = a[(u32(y) * p.iw + u32(x)) * p.ic + input_c];
        }
        }
      }
      input_tile[j] = v;
    }
    for (var j = thread; j < column_vectors * TILE_K; j += 64u) {
      let k = base_k + j / column_vectors;
      let c = base_channel + (j % column_vectors) * 4u;
      var v = vec4<f32>(0.0);
      for (var d = 0u; d < 4u; d++) {
        if k < p.k && c + d < channels {
          v[d] = weights[(group.z * p.k + k) * channels + c + d];
        }
      }
      weight_tile[j] = v;
    }
    workgroupBarrier();
    for (var k = 0u; k < TILE_K; k++) {
      let wi = k * column_vectors + local.x * (COLS_PER_THREAD / 4u);
      let w = weight_tile[wi];
      let r = local.y * ROWS_PER_THREAD * TILE_K + k;
      s0 = fma(vec4<f32>(input_tile[r]), w, s0);
      s1 = fma(vec4<f32>(input_tile[r + TILE_K]), w, s1);
      s2 = fma(vec4<f32>(input_tile[r + 2u * TILE_K]), w, s2);
      s3 = fma(vec4<f32>(input_tile[r + 3u * TILE_K]), w, s3);
      if ROWS_PER_THREAD == 8u {
        s4 = fma(vec4<f32>(input_tile[r + 4u * TILE_K]), w, s4);
        s5 = fma(vec4<f32>(input_tile[r + 5u * TILE_K]), w, s5);
        s6 = fma(vec4<f32>(input_tile[r + 6u * TILE_K]), w, s6);
        s7 = fma(vec4<f32>(input_tile[r + 7u * TILE_K]), w, s7);
      }
      if COLS_PER_THREAD == 8u {
        let v = weight_tile[wi + 1u];
        t0 = fma(vec4<f32>(input_tile[r]), v, t0);
        t1 = fma(vec4<f32>(input_tile[r + TILE_K]), v, t1);
        t2 = fma(vec4<f32>(input_tile[r + 2u * TILE_K]), v, t2);
        t3 = fma(vec4<f32>(input_tile[r + 3u * TILE_K]), v, t3);
        t4 = fma(vec4<f32>(input_tile[r + 4u * TILE_K]), v, t4);
        t5 = fma(vec4<f32>(input_tile[r + 5u * TILE_K]), v, t5);
        t6 = fma(vec4<f32>(input_tile[r + 6u * TILE_K]), v, t6);
        t7 = fma(vec4<f32>(input_tile[r + 7u * TILE_K]), v, t7);
      }
    }
    workgroupBarrier();
  }
  let sums = array<vec4<f32>, 8>(s0, s1, s2, s3, s4, s5, s6, s7);
  let tails = array<vec4<f32>, 8>(t0, t1, t2, t3, t4, t5, t6, t7);
  for (var r = 0u; r < ROWS_PER_THREAD; r++) {
    let pixel = base_pixel + local.y * ROWS_PER_THREAD + r;
    for (var d = 0u; d < COLS_PER_THREAD; d++) {
      let c = base_channel + local.x * COLS_PER_THREAD + d;
      if pixel < p.oh * p.ow && c < channels {
        let channel = group.z * channels + c;
        var sum = sums[r][d % 4u];
        if d >= 4u { sum = tails[r][d % 4u]; }
        var value = sum + weights[p.oc * p.k + channel];
        if p.op == 6u && value < 0.0 { value *= p.alpha; }
        if p.output_scale == 2u {
          // A pointwise convolution commutes with nearest2x expansion. Compute
          // each channel dot product once, retaining its original FMA order.
          let index = ((pixel / p.ow) * 4u * p.ow + (pixel % p.ow) * 2u) * p.oc + channel;
          store_convolution(index, value);
          store_convolution(index + p.oc, value);
          store_convolution(index + 2u * p.ow * p.oc, value);
          store_convolution(index + (2u * p.ow + 1u) * p.oc, value);
        } else {
          store_convolution(pixel * p.oc + channel, value);
        }
      }
    }
  }
}
