use super::format::WeightRange;
use super::*;
use serde_json::{Value, json};

fn bundle(layers: Value, input: [usize; 3], output: [usize; 3], weights: &[f32]) -> Vec<u8> {
  bundle_version(layers, input, output, weights, 1)
}

fn bundle_version(
  layers: Value,
  input: [usize; 3],
  output: [usize; 3],
  weights: &[f32],
  version: u32,
) -> Vec<u8> {
  let payload: Vec<_> = weights
    .iter()
    .flat_map(|&v| {
      if version == 1 {
        half::f16::from_f32(v).to_bits().to_le_bytes().to_vec()
      } else {
        v.to_le_bytes().to_vec()
      }
    })
    .collect();
  let manifest = json!({"format_version":version,"variant":"bayer","source_sha256":"0".repeat(64),"weights_sha256":format!("{:x}",Sha256::digest(&payload)),"input_shape":input,"output_shape":output,"output":layers.as_array().unwrap().len(),"layers":layers});
  let header = serde_json::to_vec(&manifest).unwrap();
  let mut out = b"PBDN0001".to_vec();
  if version == 2 {
    out[7] = b'2';
  }
  out.extend_from_slice(&(header.len() as u32).to_le_bytes());
  out.extend(header);
  out.extend(payload);
  out
}

#[test]
fn fp32_payload_preserves_precision_and_rejects_invalid_versions_and_values() {
  let value = f32::from_bits(0x3f800001); // Lost by an accidental FP16 conversion.
  let graph = json!([{"name":"conv","inputs":[0],"op":"conv2d","in_channels":3,"out_channels":3,"groups":3,"kernel":[1,1],"stride":[1,1],"padding":[0,0,0,0],"weights":{"offset":0,"count":3},"bias":{"offset":3,"count":3}}]);
  let weights = [value, value, value, 0.0, 0.0, 0.0];
  let bytes = bundle_version(graph.clone(), [3, 1, 1], [3, 1, 1], &weights, 2);
  let model = Model::from_bytes(&bytes).unwrap();
  assert_eq!(model.info().weight_dtype, "float32");
  let actual = model
    .predict(
      &Tensor::new([3, 1, 1], vec![1.0; 3]).unwrap(),
      &Cancel::never(),
    )
    .unwrap();
  assert!(actual.data().iter().all(|v| v.to_bits() == value.to_bits()));
  let mut wrong_magic = bytes.clone();
  wrong_magic[7] = b'1';
  assert!(Model::from_bytes(&wrong_magic).is_err());
  let mut truncated = bytes.clone();
  truncated.pop();
  assert!(Model::from_bytes(&truncated).is_err());
  let mut corrupt = bytes;
  *corrupt.last_mut().unwrap() ^= 1;
  assert!(Model::from_bytes(&corrupt).is_err());
  for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
    let mut weights = weights;
    weights[0] = bad;
    assert!(
      Model::from_bytes(&bundle_version(
        graph.clone(),
        [3, 1, 1],
        [3, 1, 1],
        &weights,
        2
      ))
      .is_err()
    );
  }
}

#[test]
fn concat_preserves_channel_order_with_shared_cropped_input() {
  // Mimics the Enhance Details skip: crop the original input, concatenate it
  // before a transformed branch, then select different channels in a 1x1 conv.
  let graph = json!([
    {"name":"crop","inputs":[0],"op":"slice","axis":2,"start":1,"end":3},
    {"name":"relu","inputs":[1],"op":"leaky_relu","alpha":0.0},
    {"name":"concat","inputs":[1,2],"op":"concat"},
    {"name":"select","inputs":[3],"op":"conv2d","in_channels":6,"out_channels":3,"groups":1,"kernel":[1,1],"stride":[1,1],"padding":[0,0,0,0],"weights":{"offset":0,"count":18},"bias":{"offset":18,"count":3}}
  ]);
  let mut weights = vec![0.0; 21];
  weights[0] = 1.0;
  weights[6 + 4] = 1.0;
  weights[12 + 2] = 1.0;
  let model = Model::from_bytes(&bundle_version(graph, [3, 1, 3], [3, 1, 2], &weights, 2)).unwrap();
  let input = Tensor::new(
    [3, 1, 3],
    vec![99.0, -2.0, 3.0, 99.0, -4.0, 5.0, 99.0, -6.0, 7.0],
  )
  .unwrap();
  assert_eq!(
    model.predict(&input, &Cancel::never()).unwrap().data(),
    [-2.0, 3.0, 0.0, 5.0, -6.0, 7.0]
  );
  let invalid = json!([
    {"name":"crop","inputs":[0],"op":"slice","axis":2,"start":1,"end":3},
    {"name":"bad","inputs":[0,1],"op":"concat"}
  ]);
  assert!(Model::from_bytes(&bundle_version(invalid, [3, 1, 3], [3, 1, 2], &[], 2)).is_err());
}

#[test]
fn details_model_cannot_use_denoise_transfer_or_geometry() {
  let area = tiles::Rect::new(0, 0, 100, 100).unwrap();
  assert!(MosaicTilePlan::new(Variant::XtransDetails, area, 0.0).is_err());
  assert!(tiles::TileGeometry::calculate(Variant::XtransDetails, area).is_err());
  assert!(pack_mosaic_tile(Variant::XtransDetails, &vec![0.0; 1024 * 1024], [0.0; 3]).is_err());
  let visits: Vec<_> = border::TileTraversal::new(
    Variant::XtransDetails,
    tiles::Rect::new(0, 0, 466, 466).unwrap(),
  )
  .map(|r| r.as_array())
  .collect();
  assert_eq!(
    visits,
    [
      [0, 0, 465, 465],
      [0, 465, 465, 466],
      [465, 0, 466, 465],
      [465, 465, 466, 466]
    ]
  );
}

#[test]
fn streamed_mosaic_tiles_stitch_without_gaps_or_phase_changes_and_stop_on_cancel() {
  use tiles::Rect;
  // An independent crop-only graph exposes sampling/phase/stitching errors
  // without learned parameters or convolution tolerances masking them.
  let graph = json!([
    {"name":"rows","inputs":[0],"op":"slice","axis":1,"start":112,"end":912},
    {"name":"cols","inputs":[1],"op":"slice","axis":2,"start":112,"end":912}
  ]);
  let model = Model::from_bytes(&bundle(graph, [3, 1024, 1024], [3, 800, 800], &[])).unwrap();
  let edge = 805;
  let source: Vec<f32> = (0..edge * edge)
    .map(|i| {
      if ((i / edge) * 7 + (i % edge) * 11) % 13 < 6 {
        1.0
      } else {
        16.0
      }
    })
    .collect();
  let bounds = Rect::new(0, 0, edge as i32, edge as i32).unwrap();
  let mut visits = vec![0u8; edge * edge];
  let mut tiles = 0;
  model
    .predict_mosaic_tiles(bounds, &source, 0.0, &Cancel::never(), |rect, tensor| {
      tiles += 1;
      let [height, width] = rect.size();
      assert_eq!(tensor.shape(), [3, height, width]);
      for y in 0..height {
        for x in 0..width {
          let row = rect.top() as usize + y;
          let col = rect.left() as usize + x;
          visits[row * edge + col] += 1;
          let sampled_channel = [[0, 1], [1, 2]][row % 2][col % 2];
          for channel in 0..3 {
            let expected = if channel == sampled_channel {
              source[row * edge + col]
            } else {
              0.0
            };
            assert_eq!(tensor.data()[(channel * height + y) * width + x], expected);
          }
        }
      }
      Ok(())
    })
    .unwrap();
  assert_eq!(tiles, 4);
  assert!(visits.iter().all(|&n| n == 1));
  let cancel = Cancel::new();
  let mut delivered = 0;
  let result = model.predict_mosaic_tiles(bounds, &source, 0.0, &cancel, |_, _| {
    delivered += 1;
    cancel.cancel();
    Ok(())
  });
  assert!(matches!(result, Err(Error::Cancelled)));
  assert_eq!(delivered, 1);
}

#[test]
fn convolution_matches_independent_f64_reference() {
  // All actual kernel/stride/group paths plus asymmetric padding and a tail
  // spatial block, using exact dyadic weights to isolate indexing errors.
  for (channels, outputs, groups, kernel, stride, padding) in [
    (3, 5, 1, [1, 1], [1, 1], [0, 0, 0, 0]),
    (8, 12, 4, [3, 3], [1, 1], [1, 1, 1, 1]),
    (3, 6, 1, [2, 2], [2, 2], [0, 0, 0, 0]),
    (3, 7, 1, [3, 3], [2, 1], [0, 2, 1, 0]),
  ] {
    let (h, w) = (13, 17);
    let x: Vec<f32> = (0..channels * h * w)
      .map(|i| ((i * 7 % 37) as f32 - 18.0) / 32.0)
      .collect();
    let ic = channels / groups;
    let oc = outputs / groups;
    let k = ic * kernel[0] * kernel[1];
    let mut parameters: Vec<f32> = (0..outputs * k)
      .map(|i| ((i * 11 % 29) as f32 - 14.0) / 64.0)
      .collect();
    parameters.extend((0..outputs).map(|i| (i as f32 - 3.0) / 16.0));
    let shape = [
      outputs,
      (h + padding[0] + padding[1] - kernel[0]) / stride[0] + 1,
      (w + padding[2] + padding[3] - kernel[1]) / stride[1] + 1,
    ];
    let op = Op::Conv2d {
      in_channels: channels,
      out_channels: outputs,
      groups,
      kernel,
      stride,
      padding,
      weights: WeightRange {
        offset: 0,
        count: outputs * k,
      },
      bias: WeightRange {
        offset: outputs * k,
        count: outputs,
      },
    };
    let input = Buffer::new([channels, h, w], x.clone());
    let actual = kernels::convolve(&input, shape, &op, &parameters, &Cancel::never()).unwrap();
    for y in 0..shape[1] {
      for xout in 0..shape[2] {
        for out in 0..outputs {
          let mut value = 0f64;
          for i in 0..ic {
            for ky in 0..kernel[0] {
              for kx in 0..kernel[1] {
                let sy = (y * stride[0] + ky) as isize - padding[0] as isize;
                let sx = (xout * stride[1] + kx) as isize - padding[2] as isize;
                if sy >= 0 && sx >= 0 && (sy as usize) < h && (sx as usize) < w {
                  let ch = (out / oc) * ic + i;
                  value += x[(sy as usize * w + sx as usize) * channels + ch] as f64
                    * parameters[out * k + (i * kernel[0] + ky) * kernel[1] + kx] as f64;
                }
              }
            }
          }
          value += parameters[outputs * k + out] as f64;
          assert_eq!(
            actual.data[(y * shape[2] + xout) * outputs + out],
            value as f32
          );
        }
      }
    }
  }
}

#[test]
fn residual_liveness_activation_upsample_and_crop() {
  let graph = json!([
    {"name":"expand","inputs":[0],"op":"identity"},
    {"name":"relu","inputs":[1],"op":"leaky_relu","alpha":0.25},
    {"name":"residual","inputs":[1,2],"op":"add"},
    {"name":"up","inputs":[3],"op":"upsample","scale":[2,2]},
    {"name":"height","inputs":[4],"op":"slice","axis":1,"start":1,"end":3},
    {"name":"width","inputs":[5],"op":"slice","axis":2,"start":1,"end":3}
  ]);
  let model = Model::from_bytes(&bundle(graph, [3, 2, 2], [3, 2, 2], &[])).unwrap();
  let input = Tensor::new(
    [3, 2, 2],
    vec![
      -4.0, -2.0, 0.0, 4.0, 1.0, -1.0, 2.0, -2.0, 3.0, -3.0, 4.0, -4.0,
    ],
  )
  .unwrap();
  let expected: Vec<_> = input
    .data()
    .iter()
    .map(|&x| x + if x < 0.0 { x * 0.25 } else { x })
    .collect();
  let out = model.predict(&input, &Cancel::never()).unwrap();
  assert_eq!(out.data(), expected);
  let again = model.predict(&input, &Cancel::never()).unwrap();
  assert!(
    out
      .data()
      .iter()
      .zip(again.data())
      .all(|(a, b)| a.to_bits() == b.to_bits())
  );
  let mut observed = Vec::new();
  model
    .predict_observed(
      &input,
      &Cancel::never(),
      |i, _| i == 3,
      |i, name, t| {
        observed.push((i, name.to_owned(), t.data().to_vec()));
        Ok(())
      },
    )
    .unwrap();
  assert_eq!(observed, vec![(3, "residual".into(), expected)]);
}

#[test]
fn fp16_payload_and_convolution_graph_round_trip() {
  let mut weights = vec![0.0; 9];
  for i in 0..3 {
    weights[i * 3 + i] = 1.0;
  }
  weights.extend([0.5, -0.5, 0.0]);
  let graph = json!([{"name":"conv","inputs":[0],"op":"conv2d","in_channels":3,"out_channels":3,"groups":1,"kernel":[1,1],"stride":[1,1],"padding":[0,0,0,0],"weights":{"offset":0,"count":9},"bias":{"offset":9,"count":3}}]);
  let bytes = bundle(graph, [3, 1, 2], [3, 1, 2], &weights);
  let m = Model::from_bytes(&bytes).unwrap();
  let input = Tensor::new([3, 1, 2], vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]).unwrap();
  assert_eq!(
    m.predict(&input, &Cancel::never()).unwrap().data(),
    [1.5, 2.5, 2.5, 3.5, 5.0, 6.0]
  );
  let mut corrupt = bytes;
  *corrupt.last_mut().unwrap() ^= 1;
  assert!(Model::from_bytes(&corrupt).is_err());
}

#[test]
fn malformed_graphs_and_tensors_are_rejected_before_inference() {
  for graph in [
    json!([{"name":"future","inputs":[1],"op":"identity"}]),
    json!([{"name":"arity","inputs":[],"op":"add"}]),
    json!([{"name":"slice","inputs":[0],"op":"slice","axis":99,"start":0,"end":1}]),
    json!([{"name":"slice","inputs":[0],"op":"slice","axis":1,"start":4,"end":5}]),
    json!([{"name":"extra","inputs":[0],"op":"identity","unhandled":1}]),
    json!([{"name":"up","inputs":[0],"op":"upsample","scale":[usize::MAX,2]}]),
  ] {
    assert!(Model::from_bytes(&bundle(graph, [3, 2, 2], [3, 2, 2], &[])).is_err());
  }
  assert!(Tensor::new([3, 1, 1], vec![0.0, 0.0, f32::NAN]).is_err());
  assert!(Tensor::new([3, usize::MAX, usize::MAX], vec![]).is_err());
  assert!(Tensor::new([3, 0, 1], vec![]).is_err());
  assert!(Model::from_bytes(b"PBDN0001\xff\xff\xff\xff").is_err());
}

#[test]
fn cancellation_and_input_shape_are_checked() {
  let m = Model::from_bytes(&bundle(
    json!([{"name":"id","inputs":[0],"op":"identity"}]),
    [3, 1, 1],
    [3, 1, 1],
    &[],
  ))
  .unwrap();
  let input = Tensor::new([3, 1, 1], vec![1.0; 3]).unwrap();
  let cancel = Cancel::new();
  cancel.cancel();
  assert!(matches!(m.predict(&input, &cancel), Err(Error::Cancelled)));
  assert!(
    m.predict(
      &Tensor::new([3, 1, 2], vec![1.0; 6]).unwrap(),
      &Cancel::never()
    )
    .is_err()
  );
}

#[test]
fn sparse_packing_preserves_cfa_phase_and_only_offsets_sampled_sites() {
  let mosaic = vec![0.5; 1024 * 1024];
  for (variant, patterns) in [
    (Variant::Bayer, vec![vec![1, 0], vec![2, 1]]),
    (
      Variant::Xtrans,
      vec![
        vec![1, 2, 1, 1, 0, 1],
        vec![0, 1, 0, 2, 1, 2],
        vec![1, 2, 1, 1, 0, 1],
        vec![1, 0, 1, 1, 2, 1],
        vec![2, 1, 2, 0, 1, 0],
        vec![1, 0, 1, 1, 2, 1],
      ],
    ),
  ] {
    let t = pack_mosaic_tile(variant, &mosaic, [0.125, 0.25, 0.375]).unwrap();
    for y in 0..12 {
      for x in 0..12 {
        for c in 0..3 {
          let sampled = patterns[y % patterns.len()][x % patterns.len()];
          let expected = if sampled == c {
            0.5 + [0.125, 0.25, 0.375][c]
          } else {
            0.0
          };
          assert_eq!(t.data()[c * 1024 * 1024 + y * 1024 + x], expected);
        }
      }
    }
  }
  assert!(pack_mosaic_tile(Variant::LinearRaw, &mosaic, [0.0; 3]).is_err());
  assert!(pack_mosaic_tile(Variant::Bayer, &mosaic[..10], [0.0; 3]).is_err());
}

#[test]
fn convolution_is_bit_identical_across_worker_counts() {
  let input = Buffer::new(
    [3, 16, 17],
    (0..3 * 16 * 17).map(|i| (i as f32 * 0.731).sin()).collect(),
  );
  let parameters: Vec<_> = (0..3 * 3 * 3 * 3 + 3)
    .map(|i| (i as f32 * 0.123).sin())
    .collect();
  let op = Op::Conv2d {
    in_channels: 3,
    out_channels: 3,
    groups: 1,
    kernel: [3, 3],
    stride: [1, 1],
    padding: [1, 1, 1, 1],
    weights: WeightRange {
      offset: 0,
      count: 81,
    },
    bias: WeightRange {
      offset: 81,
      count: 3,
    },
  };
  let run = |threads| {
    rayon::ThreadPoolBuilder::new()
      .num_threads(threads)
      .build()
      .unwrap()
      .install(|| {
        kernels::convolve(&input, [3, 16, 17], &op, &parameters, &Cancel::never()).unwrap()
      })
  };
  let a = run(1);
  let b = run(4);
  assert!(
    a.data
      .iter()
      .zip(b.data.iter())
      .all(|(x, y)| x.to_bits() == y.to_bits())
  );
}

#[test]
fn tensor_file_round_trip_and_trailing_data_rejection() {
  let path = std::env::temp_dir().join(format!(
    "photobrain-denoise-{}-tensor.f32",
    std::process::id()
  ));
  let tensor = Tensor::new([3, 1, 2], vec![-0.0, 1.0, 2.0, 3.0, -4.0, 0.125]).unwrap();
  tensor.write(&path).unwrap();
  let read = Tensor::read(&path).unwrap();
  assert_eq!(read.shape(), tensor.shape());
  assert!(
    read
      .data()
      .iter()
      .zip(tensor.data())
      .all(|(a, b)| a.to_bits() == b.to_bits())
  );
  use std::io::Write;
  std::fs::OpenOptions::new()
    .append(true)
    .open(&path)
    .unwrap()
    .write_all(&[0])
    .unwrap();
  assert!(Tensor::read(&path).is_err());
  std::fs::remove_file(path).unwrap();
}
