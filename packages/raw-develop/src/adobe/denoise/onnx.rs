//! Minimal ONNX IR 9 / opset 18 encoder for the validated PBDN operator set.
//! Field numbers follow onnx/onnx.proto. No decoder or caller-supplied ONNX is used.
use super::{Model, Op};
use prost::Message;

#[derive(Clone, PartialEq, Message)]
struct ModelProto {
  #[prost(int64, tag = "1")]
  ir_version: i64,
  #[prost(string, tag = "2")]
  producer_name: String,
  #[prost(message, optional, tag = "7")]
  graph: Option<Graph>,
  #[prost(message, repeated, tag = "8")]
  opset_import: Vec<Opset>,
}
#[derive(Clone, PartialEq, Message)]
struct Opset {
  #[prost(int64, tag = "2")]
  version: i64,
}
#[derive(Clone, PartialEq, Message)]
struct Graph {
  #[prost(message, repeated, tag = "1")]
  node: Vec<Node>,
  #[prost(string, tag = "2")]
  name: String,
  #[prost(message, repeated, tag = "5")]
  initializer: Vec<Initializer>,
  #[prost(message, repeated, tag = "11")]
  input: Vec<ValueInfo>,
  #[prost(message, repeated, tag = "12")]
  output: Vec<ValueInfo>,
}
#[derive(Clone, PartialEq, Message)]
struct Node {
  #[prost(string, repeated, tag = "1")]
  input: Vec<String>,
  #[prost(string, repeated, tag = "2")]
  output: Vec<String>,
  #[prost(string, tag = "3")]
  name: String,
  #[prost(string, tag = "4")]
  op_type: String,
  #[prost(message, repeated, tag = "5")]
  attribute: Vec<Attribute>,
}
#[derive(Clone, PartialEq, Message)]
struct Attribute {
  #[prost(string, tag = "1")]
  name: String,
  #[prost(float, tag = "2")]
  f: f32,
  #[prost(int64, tag = "3")]
  i: i64,
  #[prost(bytes = "vec", tag = "4")]
  s: Vec<u8>,
  #[prost(int64, repeated, tag = "8")]
  ints: Vec<i64>,
  #[prost(int32, tag = "20")]
  kind: i32,
}
impl Attribute {
  fn ints(name: &str, values: &[usize]) -> Self {
    Self {
      name: name.into(),
      kind: 7,
      ints: values.iter().map(|&v| v as i64).collect(),
      ..Default::default()
    }
  }
  fn int(name: &str, i: usize) -> Self {
    Self {
      name: name.into(),
      kind: 2,
      i: i as i64,
      ..Default::default()
    }
  }
  fn float(name: &str, f: f32) -> Self {
    Self {
      name: name.into(),
      kind: 1,
      f,
      ..Default::default()
    }
  }
  fn string(name: &str, s: &str) -> Self {
    Self {
      name: name.into(),
      kind: 3,
      s: s.as_bytes().to_vec(),
      ..Default::default()
    }
  }
}
#[derive(Clone, PartialEq, Message)]
struct Initializer {
  #[prost(int64, repeated, tag = "1")]
  dims: Vec<i64>,
  #[prost(int32, tag = "2")]
  data_type: i32,
  #[prost(string, tag = "8")]
  name: String,
  #[prost(bytes = "vec", tag = "9")]
  raw_data: Vec<u8>,
}
#[derive(Clone, PartialEq, Message)]
struct ValueInfo {
  #[prost(string, tag = "1")]
  name: String,
  #[prost(message, optional, tag = "2")]
  r#type: Option<Type>,
}
#[derive(Clone, PartialEq, Message)]
struct Type {
  #[prost(message, optional, tag = "1")]
  tensor_type: Option<TensorType>,
}
#[derive(Clone, PartialEq, Message)]
struct TensorType {
  #[prost(int32, tag = "1")]
  elem_type: i32,
  #[prost(message, optional, tag = "2")]
  shape: Option<Shape>,
}
#[derive(Clone, PartialEq, Message)]
struct Shape {
  #[prost(message, repeated, tag = "1")]
  dim: Vec<Dimension>,
}
#[derive(Clone, PartialEq, Message)]
struct Dimension {
  #[prost(int64, tag = "1")]
  dim_value: i64,
}
fn value(index: usize, shape: [usize; 3]) -> ValueInfo {
  ValueInfo {
    name: format!("v{index}"),
    r#type: Some(Type {
      tensor_type: Some(TensorType {
        elem_type: 1,
        shape: Some(Shape {
          dim: [1, shape[0], shape[1], shape[2]]
            .into_iter()
            .map(|v| Dimension {
              dim_value: v as i64,
            })
            .collect(),
        }),
      }),
    }),
  }
}
fn f32_parameter(name: String, dims: &[usize], values: &[f32]) -> Initializer {
  Initializer {
    name,
    dims: dims.iter().map(|&v| v as i64).collect(),
    data_type: 1,
    raw_data: values.iter().flat_map(|v| v.to_le_bytes()).collect(),
  }
}
fn i64_parameter(name: String, value: i64) -> Initializer {
  Initializer {
    name,
    dims: vec![1],
    data_type: 7,
    raw_data: value.to_le_bytes().to_vec(),
  }
}

pub(super) fn encode(model: &Model) -> Vec<u8> {
  encode_graph(model, true)
}

fn encode_graph(model: &Model, compact: bool) -> Vec<u8> {
  let m = &model.manifest;
  let mut graph = Graph {
    name: "photobrain-denoise-f32-v1".into(),
    input: vec![value(0, m.input_shape)],
    output: vec![value(m.output, m.output_shape)],
    ..Default::default()
  };
  for (i, layer) in m.layers.iter().enumerate() {
    // Generated identifiers avoid collisions with untrusted manifest names.
    let id = i + 1;
    let mut node = Node {
      name: format!("n{id}"),
      input: layer.inputs.iter().map(|v| format!("v{v}")).collect(),
      output: vec![format!("v{id}")],
      ..Default::default()
    };
    node.op_type = match layer.op {
      Op::Identity {} => "Identity",
      Op::Add {} => "Add",
      Op::Concat {} => {
        node.attribute.push(Attribute::int("axis", 1));
        "Concat"
      }
      Op::LeakyRelu { alpha } => {
        node.attribute.push(Attribute::float("alpha", alpha));
        "LeakyRelu"
      }
      Op::Conv2d {
        in_channels,
        out_channels,
        groups,
        kernel,
        stride,
        padding,
        weights,
        bias,
      } => {
        let w = format!("w{id}");
        let b = format!("b{id}");
        graph.initializer.push(f32_parameter(
          w.clone(),
          &[out_channels, in_channels / groups, kernel[0], kernel[1]],
          &model.weights[weights.offset..weights.offset + weights.count],
        ));
        graph.initializer.push(f32_parameter(
          b.clone(),
          &[out_channels],
          &model.weights[bias.offset..bias.offset + bias.count],
        ));
        node.input.extend([w, b]);
        node.attribute.extend([
          Attribute::int("group", groups),
          Attribute::ints("kernel_shape", &kernel),
          Attribute::ints("strides", &stride),
          // PBDN: top,bottom,left,right. ONNX: top,left,bottom,right.
          Attribute::ints("pads", &[padding[0], padding[2], padding[1], padding[3]]),
        ]);
        "Conv"
      }
      Op::Upsample { scale } => {
        let scales = format!("scales{id}");
        graph.initializer.push(f32_parameter(
          scales.clone(),
          &[4],
          &[1., 1., scale[0] as f32, scale[1] as f32],
        ));
        node.input.extend([String::new(), scales]);
        node.attribute.extend([
          Attribute::string("mode", "nearest"),
          Attribute::string("coordinate_transformation_mode", "asymmetric"),
          Attribute::string("nearest_mode", "floor"),
        ]);
        "Resize"
      }
      Op::Slice { axis, start, end } => {
        for (suffix, v) in [
          ("start", start),
          ("end", end),
          ("axis", axis + 1),
          ("step", 1),
        ] {
          let name = format!("{suffix}{id}");
          graph
            .initializer
            .push(i64_parameter(name.clone(), v as i64));
          node.input.push(name);
        }
        "Slice"
      }
    }
    .into();
    graph.node.push(node);
  }
  if compact {
    // A pointwise convolution commutes with nearest replication. Evaluate each
    // unique low-resolution pixel once. Single-use adjacency is essential: a
    // shared resize output must retain its original shape and graph identity.
    let mut nodes = Vec::with_capacity(graph.node.len());
    let mut i = 0;
    while i < graph.node.len() {
      let eligible = i + 1 < model.manifest.layers.len()
        && matches!(model.manifest.layers[i].op, Op::Upsample { .. })
        && model.uses[i + 1] == 1
        && model.manifest.layers[i + 1].inputs == [i + 1]
        && matches!(
          model.manifest.layers[i + 1].op,
          Op::Conv2d {
            kernel: [1, 1],
            stride: [1, 1],
            padding: [0, 0, 0, 0],
            ..
          }
        );
      if eligible {
        let mut resize = graph.node[i].clone();
        let mut conv = graph.node[i + 1].clone();
        let output = conv.output[0].clone();
        let low = format!("{output}_low");
        conv.input[0] = resize.input[0].clone();
        conv.output[0] = low.clone();
        resize.input[0] = low;
        resize.output[0] = output;
        nodes.extend([conv, resize]);
        i += 2;
      } else {
        nodes.push(graph.node[i].clone());
        i += 1;
      }
    }
    graph.node = nodes;
  }
  ModelProto {
    ir_version: 9,
    producer_name: "photobrain".into(),
    graph: Some(graph),
    opset_import: vec![Opset { version: 18 }],
  }
  .encode_to_vec()
}
