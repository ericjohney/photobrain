//! Face model files: cache location, lazy download, size and SHA-256 verification,
//! atomic installation, ONNX shape relaxation, and ONNX Runtime session construction.

use std::ffi::OsString;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use sha2::{Digest, Sha256};

/// A pinned model artifact. The size and digest are part of the contract: a file that
/// does not match both is never handed to ONNX Runtime.
pub(crate) struct ModelSpec<'a> {
  pub file_name: &'a str,
  pub url: &'a str,
  pub size: u64,
  pub sha256: &'a str,
}

/// OpenCV Zoo YuNet 2023mar (MIT).
pub(crate) const YUNET: ModelSpec<'static> = ModelSpec {
  file_name: "face_detection_yunet_2023mar.onnx",
  url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
  size: 232_589,
  sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
};

/// OpenCV Zoo SFace 2021dec (Apache-2.0).
pub(crate) const SFACE: ModelSpec<'static> = ModelSpec {
  file_name: "face_recognition_sface_2021dec.onnx",
  url: "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
  size: 38_696_353,
  sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
};

/// `FACE_MODEL_DIR`, else `$FASTEMBED_CACHE_DIR/faces`, else `.face_models` in the
/// working directory. Empty values count as unset.
pub(crate) fn model_dir() -> PathBuf {
  model_dir_from(
    std::env::var_os("FACE_MODEL_DIR"),
    std::env::var_os("FASTEMBED_CACHE_DIR"),
  )
}

fn model_dir_from(face_model_dir: Option<OsString>, fastembed_dir: Option<OsString>) -> PathBuf {
  let non_empty = |value: Option<OsString>| value.filter(|value| !value.is_empty());
  if let Some(dir) = non_empty(face_model_dir) {
    return PathBuf::from(dir);
  }
  if let Some(dir) = non_empty(fastembed_dir) {
    return PathBuf::from(dir).join("faces");
  }
  PathBuf::from(".face_models")
}

/// Return the verified model bytes from `dir`, downloading them from `url` first when
/// the cached file is missing or fails verification. A download is written to a temp
/// file in `dir`, verified, and only then renamed into place; a mismatch is an error
/// and leaves nothing behind.
pub(crate) fn load_model(spec: &ModelSpec, dir: &Path, url: &str) -> Result<Vec<u8>, String> {
  let path = dir.join(spec.file_name);
  match fs::read(&path) {
    Ok(bytes) => match verify(spec, &bytes) {
      Ok(()) => return Ok(bytes),
      Err(reason) => {
        eprintln!(
          "[faces] Discarding cached {}: {reason}; downloading it again",
          path.display()
        );
        fs::remove_file(&path)
          .map_err(|error| format!("Failed to remove {}: {error}", path.display()))?;
      }
    },
    Err(error) if error.kind() == ErrorKind::NotFound => {}
    Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
  }

  fs::create_dir_all(dir).map_err(|error| {
    format!(
      "Failed to create face model directory {}: {error}",
      dir.display()
    )
  })?;
  let bytes = download(url, spec.size)?;
  let mut temp = tempfile::Builder::new()
    .prefix(".download-")
    .tempfile_in(dir)
    .map_err(|error| format!("Failed to create a temp file in {}: {error}", dir.display()))?;
  temp
    .write_all(&bytes)
    .and_then(|()| temp.as_file().sync_all())
    .map_err(|error| format!("Failed to write {}: {error}", temp.path().display()))?;
  // Dropping `temp` on any error below deletes it.
  verify(spec, &bytes).map_err(|reason| {
    format!(
      "Downloaded {} from {url} failed verification: {reason}",
      spec.file_name
    )
  })?;
  temp
    .persist(&path)
    .map_err(|error| format!("Failed to install {}: {}", path.display(), error.error))?;
  Ok(bytes)
}

fn download(url: &str, expected_size: u64) -> Result<Vec<u8>, String> {
  let agent = ureq::AgentBuilder::new()
    .timeout_connect(Duration::from_secs(30))
    .timeout_read(Duration::from_secs(120))
    .build();
  let response = agent
    .get(url)
    .call()
    .map_err(|error| format!("Failed to download {url}: {error}"))?;
  // Read one byte past the expected size so an oversized body fails verification
  // without buffering an unbounded response.
  let mut bytes = Vec::with_capacity(expected_size as usize);
  response
    .into_reader()
    .take(expected_size + 1)
    .read_to_end(&mut bytes)
    .map_err(|error| format!("Failed to download {url}: {error}"))?;
  Ok(bytes)
}

fn verify(spec: &ModelSpec, bytes: &[u8]) -> Result<(), String> {
  if bytes.len() as u64 != spec.size {
    return Err(format!(
      "size {} bytes, expected {}",
      bytes.len(),
      spec.size
    ));
  }
  let digest = sha256_hex(bytes);
  if digest != spec.sha256 {
    return Err(format!("sha256 {digest}, expected {}", spec.sha256));
  }
  Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
  Sha256::digest(bytes)
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}

/// One protobuf field: number, wire type, and the byte range of its payload (the
/// varint bytes for wire type 0, the contents for length-delimited fields).
type Field = (u64, u8, Range<usize>);

fn read_varint(bytes: &[u8], at: &mut usize, end: usize) -> Result<u64, String> {
  let mut value = 0u64;
  for shift in (0..64).step_by(7) {
    let byte = *bytes[..end].get(*at).ok_or("truncated protobuf varint")?;
    *at += 1;
    value |= u64::from(byte & 0x7f) << shift;
    if byte & 0x80 == 0 {
      return Ok(value);
    }
  }
  Err("overlong protobuf varint".to_string())
}

fn fields(bytes: &[u8], range: Range<usize>) -> Result<Vec<Field>, String> {
  let (mut at, end) = (range.start, range.end);
  let mut fields = Vec::new();
  while at < end {
    let key = read_varint(bytes, &mut at, end)?;
    let (number, wire) = (key >> 3, (key & 7) as u8);
    let start = at;
    let payload = match wire {
      0 => {
        read_varint(bytes, &mut at, end)?;
        start..at
      }
      1 | 5 => {
        at += if wire == 1 { 8 } else { 4 };
        start..at
      }
      2 => {
        let len = read_varint(bytes, &mut at, end)? as usize;
        let payload = at..at.checked_add(len).ok_or("protobuf length overflow")?;
        at = payload.end;
        payload
      }
      _ => return Err(format!("unsupported protobuf wire type {wire}")),
    };
    if at > end {
      return Err("truncated protobuf field".to_string());
    }
    fields.push((number, wire, payload));
  }
  Ok(fields)
}

fn submessage(bytes: &[u8], range: Range<usize>, number: u64) -> Result<Range<usize>, String> {
  fields(bytes, range)?
    .into_iter()
    .find(|(n, wire, _)| *n == number && *wire == 2)
    .map(|(_, _, payload)| payload)
    .ok_or_else(|| format!("missing protobuf field {number}"))
}

/// Rewrite fixed graph input/output dimensions of an ONNX `ModelProto` as symbolic, in
/// place and without changing the file length. Each `targets` entry names a graph input
/// or output and the indices of its dimensions to relax. A `Dimension { dim_value: v }`
/// is encoded as `08 <varint v>`; it is overwritten by `12 <len> <param>` (a `dim_param`
/// string of the same total length), so no enclosing length prefix changes. This is how
/// the fixed 640x640 YuNet export accepts other input sizes, as OpenCV does by
/// reshaping the network input.
pub(crate) fn make_dims_symbolic(
  model: &mut [u8],
  targets: &[(&str, &[usize])],
) -> Result<(), String> {
  // ModelProto.graph = 7; GraphProto.input = 11, .output = 12; ValueInfoProto.name = 1,
  // .type = 2; TypeProto.tensor_type = 1; Tensor.shape = 2; TensorShapeProto.dim = 1.
  let graph = submessage(model, 0..model.len(), 7)?;
  let mut edits = Vec::new();
  let mut matched = vec![false; targets.len()];
  for (number, wire, info) in fields(model, graph)? {
    if wire != 2 || (number != 11 && number != 12) {
      continue;
    }
    let name_range = submessage(model, info.clone(), 1)?;
    let name = std::str::from_utf8(&model[name_range]).map_err(|_| "non-UTF-8 value name")?;
    let Some(target) = targets.iter().position(|(target, _)| *target == name) else {
      continue;
    };
    matched[target] = true;
    let shape = submessage(model, info, 2)
      .and_then(|ty| submessage(model, ty, 1))
      .and_then(|tensor| submessage(model, tensor, 2))?;
    let dims: Vec<Range<usize>> = fields(model, shape)?
      .into_iter()
      .filter(|(number, wire, _)| *number == 1 && *wire == 2)
      .map(|(_, _, payload)| payload)
      .collect();
    for &index in targets[target].1 {
      let dim = dims
        .get(index)
        .ok_or_else(|| format!("{name} has no dimension {index}"))?;
      let inner = fields(model, dim.clone())?;
      if !matches!(inner.as_slice(), [(1, 0, _)]) || dim.len() < 2 {
        return Err(format!("{name} dimension {index} is not a fixed value"));
      }
      edits.push(dim.clone());
    }
  }
  if let Some(missing) = matched.iter().position(|found| !found) {
    return Err(format!("model has no graph value {}", targets[missing].0));
  }
  for (n, dim) in edits.into_iter().enumerate() {
    // `dim.len() - 2` is at most 9 (the varint plus its key), a one-byte length.
    model[dim.start] = 0x12;
    model[dim.start + 1] = (dim.len() - 2) as u8;
    model[dim.start + 2..dim.end].fill(b'a' + (n % 26) as u8);
  }
  Ok(())
}

/// Single-threaded sessions: callers already parallelize across images on the shared
/// processing pool, so per-session intra-op threads would only oversubscribe it.
pub(crate) fn session(bytes: &[u8], name: &str) -> Result<Session, String> {
  Session::builder()
    .and_then(|builder| builder.with_optimization_level(GraphOptimizationLevel::Level3))
    .and_then(|builder| builder.with_intra_threads(1))
    .and_then(|builder| builder.with_inter_threads(1))
    .and_then(|builder| builder.commit_from_memory(bytes))
    .map_err(|error| format!("Failed to load {name}: {error}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::BufRead;
  use std::net::TcpListener;
  use std::thread;

  fn spec_for<'a>(body: &[u8], sha256: &'a str) -> ModelSpec<'a> {
    ModelSpec {
      file_name: "model.onnx",
      url: "unused",
      size: body.len() as u64,
      sha256,
    }
  }

  /// Serve `body` to `requests` sequential HTTP/1.1 GETs on a loopback port.
  fn serve(body: Vec<u8>, requests: usize) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/model.onnx", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
      for _ in 0..requests {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap() > 0 && line != "\r\n" {
          line.clear();
        }
        let header = format!(
          "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
          body.len()
        );
        stream.write_all(header.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
      }
    });
    (url, handle)
  }

  fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
      .unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
      .collect();
    names.sort();
    names
  }

  #[test]
  fn cache_dir_precedence() {
    let some = |value: &str| Some(OsString::from(value));
    assert_eq!(
      model_dir_from(some("/models"), some("/fastembed")),
      PathBuf::from("/models")
    );
    assert_eq!(
      model_dir_from(None, some("/fastembed")),
      PathBuf::from("/fastembed/faces")
    );
    assert_eq!(
      model_dir_from(some(""), some("/fastembed")),
      PathBuf::from("/fastembed/faces")
    );
    assert_eq!(model_dir_from(None, None), PathBuf::from(".face_models"));
    assert_eq!(
      model_dir_from(some(""), some("")),
      PathBuf::from(".face_models")
    );
  }

  #[test]
  fn downloads_verifies_and_installs_atomically() {
    let body = b"pretend onnx bytes".repeat(1000);
    let digest = sha256_hex(&body);
    let spec = spec_for(&body, &digest);
    let dir = tempfile::tempdir().unwrap();
    let models = dir.path().join("nested/faces");
    let (url, server) = serve(body.clone(), 1);

    assert_eq!(load_model(&spec, &models, &url).unwrap(), body);
    server.join().unwrap();
    assert_eq!(entries(&models), ["model.onnx"]);
    assert_eq!(fs::read(models.join("model.onnx")).unwrap(), body);

    // A verified cache hit never touches the network (the server has exited).
    assert_eq!(load_model(&spec, &models, &url).unwrap(), body);
  }

  #[test]
  fn sha256_mismatch_is_rejected_and_leaves_no_file() {
    let body = b"genuine model".to_vec();
    let spec = spec_for(
      &body,
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    let dir = tempfile::tempdir().unwrap();
    let (url, server) = serve(body, 1);

    let error = load_model(&spec, dir.path(), &url).unwrap_err();
    server.join().unwrap();
    assert!(error.contains("failed verification"), "{error}");
    assert!(error.contains("sha256"), "{error}");
    assert!(entries(dir.path()).is_empty(), "{:?}", entries(dir.path()));
  }

  #[test]
  fn size_mismatch_is_rejected_including_oversized_bodies() {
    let expected = b"twelve bytes".to_vec();
    let digest = sha256_hex(&expected);
    let spec = spec_for(&expected, &digest);
    for body in [b"short".to_vec(), b"twelve bytes and more".to_vec()] {
      let dir = tempfile::tempdir().unwrap();
      let (url, server) = serve(body, 1);
      let error = load_model(&spec, dir.path(), &url).unwrap_err();
      server.join().unwrap();
      assert!(error.contains("size"), "{error}");
      assert!(entries(dir.path()).is_empty());
    }
  }

  #[test]
  fn corrupt_cached_file_is_replaced_by_a_verified_download() {
    let body = b"the real model".to_vec();
    let digest = sha256_hex(&body);
    let spec = spec_for(&body, &digest);
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("model.onnx"), b"truncated").unwrap();
    let (url, server) = serve(body.clone(), 1);

    assert_eq!(load_model(&spec, dir.path(), &url).unwrap(), body);
    server.join().unwrap();
    assert_eq!(fs::read(dir.path().join("model.onnx")).unwrap(), body);
  }

  #[test]
  fn unreachable_server_is_an_error_without_files() {
    let spec = spec_for(b"x", "unused");
    let dir = tempfile::tempdir().unwrap();
    let port = TcpListener::bind("127.0.0.1:0")
      .unwrap()
      .local_addr()
      .unwrap()
      .port();
    let error = load_model(&spec, dir.path(), &format!("http://127.0.0.1:{port}/m")).unwrap_err();
    assert!(error.contains("Failed to download"), "{error}");
    assert!(entries(dir.path()).is_empty());
  }
}
