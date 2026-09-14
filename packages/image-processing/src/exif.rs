use napi_derive::napi;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ExifData {
  // Camera info
  pub camera_make: Option<String>,
  pub camera_model: Option<String>,

  // Lens info
  pub lens_make: Option<String>,
  pub lens_model: Option<String>,
  pub focal_length: Option<u32>, // in mm

  // Exposure settings
  pub iso: Option<u32>,
  pub aperture: Option<String>,      // e.g., "f/2.8"
  pub shutter_speed: Option<String>, // e.g., "1/250"
  pub exposure_bias: Option<String>, // e.g., "+0.3 EV"

  // DateTime
  pub date_taken: Option<String>, // ISO 8601 format

  // GPS coordinates
  pub gps_latitude: Option<f64>,
  pub gps_longitude: Option<f64>,
  pub gps_altitude: Option<f64>,

  // Orientation (1-8, EXIF standard)
  pub orientation: Option<u32>,
}

pub(crate) const METADATA_CHUNK_SIZE: usize = 20;
// Leave ample room for flags and the environment below typical OS argv limits.
const MAX_PATH_ARG_BYTES: usize = 32 * 1024;
const METADATA_ARGS: &[&str] = &[
  "-json",
  "-Make",
  "-Model",
  "-LensMake",
  "-LensModel",
  "-FocalLength",
  "-ISO",
  "-FNumber",
  "-ExposureTime",
  "-ExposureCompensation",
  "-DateTimeOriginal",
  "-GPSLatitude",
  "-GPSLongitude",
  "-GPSAltitude",
  "-Orientation",
  "-Error", // Selected-tag output otherwise omits per-file errors.
  "-n",     // Numeric output for GPS, orientation, etc.
  "--",
];

fn full_path(path: &Path) -> Option<PathBuf> {
  // Keep the original filename: RAW tag interpretation can depend on its suffix.
  // Canonicalizing symlinks would merge distinct aliases and change that suffix.
  std::path::absolute(path).ok()
}

fn parse_records(stdout: &[u8]) -> Vec<(String, ExifData)> {
  let mut records = Vec::new();
  let Ok(serde_json::Value::Array(values)) = serde_json::from_slice(stdout) else {
    return records;
  };
  for value in values {
    let Some(obj) = value.as_object() else {
      continue;
    };
    if obj.contains_key("Error") {
      continue;
    }
    let Some(path) = obj.get("SourceFile").and_then(|v| v.as_str()) else {
      continue;
    };
    records.push((path.to_string(), parse_metadata(obj)));
  }
  records
}

fn run_metadata(
  paths: &[PathBuf],
  run: &mut impl FnMut(&mut Command) -> io::Result<Output>,
) -> HashMap<PathBuf, ExifData> {
  let mut command = Command::new("exiftool");
  command.args(METADATA_ARGS).args(paths);
  // ExifTool can return valid records alongside errors with a nonzero exit status.
  let mut records = HashMap::new();
  if let Ok(output) = run(&mut command) {
    for (path, metadata) in parse_records(&output.stdout) {
      if let Some(path) = full_path(Path::new(&path)) {
        // A later error/duplicate must not replace already usable metadata.
        records.entry(path).or_insert(metadata);
      }
    }
  }
  records
}

fn extract_exif_batch_with_runner(
  file_paths: &[String],
  mut run: impl FnMut(&mut Command) -> io::Result<Output>,
) -> Vec<Option<ExifData>> {
  let paths: Vec<_> = file_paths.iter().map(|p| full_path(Path::new(p))).collect();
  let mut seen = HashSet::new();
  let unique: Vec<_> = paths
    .iter()
    .flatten()
    .filter(|p| seen.insert((*p).clone()))
    .cloned()
    .collect();
  let mut records = HashMap::new();
  let mut start = 0;
  while start < unique.len() {
    let mut end = start;
    let mut bytes = 0;
    while end < unique.len() && end - start < METADATA_CHUNK_SIZE {
      let size = unique[end].as_os_str().as_encoded_bytes().len() + 1;
      if bytes + size > MAX_PATH_ARG_BYTES {
        break;
      }
      bytes += size;
      end += 1;
    }
    if end == start {
      // An individual oversized argument cannot be retried within the bound.
      start += 1;
      continue;
    }
    let chunk = &unique[start..end];
    let mut batch = run_metadata(chunk, &mut run);
    for path in chunk {
      let metadata = batch.remove(path).or_else(|| {
        if chunk.len() > 1 {
          run_metadata(std::slice::from_ref(path), &mut run).remove(path)
        } else {
          None
        }
      });
      if let Some(metadata) = metadata {
        records.insert(path.clone(), metadata);
      }
    }
    start = end;
  }
  paths
    .iter()
    .map(|path| path.as_ref().and_then(|p| records.get(p)).cloned())
    .collect()
}

pub(crate) fn extract_exif_batch(file_paths: &[String]) -> Vec<Option<ExifData>> {
  extract_exif_batch_with_runner(file_paths, |command| command.output())
}

/// Internal function to extract EXIF data using exiftool.
pub fn extract_exif_internal(file_path: &str) -> Option<ExifData> {
  extract_exif_batch(&[file_path.to_string()]).pop().flatten()
}

fn parse_metadata(obj: &serde_json::Map<String, serde_json::Value>) -> ExifData {
  // Helper to get string value
  let get_str = |key: &str| -> Option<String> {
    obj.get(key).and_then(|v| {
      if v.is_string() {
        v.as_str().map(|s| s.to_string())
      } else {
        // Convert numbers to strings if needed
        Some(v.to_string().trim_matches('"').to_string())
      }
    })
  };

  // Helper to get numeric value
  let get_f64 = |key: &str| -> Option<f64> { obj.get(key).and_then(|v| v.as_f64()) };

  let get_u32 =
    |key: &str| -> Option<u32> { obj.get(key).and_then(|v| v.as_u64()).map(|n| n as u32) };

  // Extract values
  let camera_make = get_str("Make");
  let camera_model = get_str("Model");
  let lens_make = get_str("LensMake");
  let lens_model = get_str("LensModel");

  // Focal length - exiftool returns as number with -n flag
  let focal_length = get_f64("FocalLength").map(|f| f as u32);

  // ISO
  let iso = get_u32("ISO");

  // Aperture (F-number)
  let aperture = get_f64("FNumber").map(|f| format!("f/{:.1}", f));

  // Shutter speed (exposure time in seconds)
  let shutter_speed = get_f64("ExposureTime").map(|exposure| {
    if exposure >= 1.0 {
      format!("{:.1}s", exposure)
    } else {
      let denominator = (1.0 / exposure).round() as u32;
      format!("1/{}", denominator)
    }
  });

  // Exposure bias
  let exposure_bias = get_f64("ExposureCompensation").map(|bias| {
    if bias > 0.0 {
      format!("+{:.1} EV", bias)
    } else if bias < 0.0 {
      format!("{:.1} EV", bias)
    } else {
      "0 EV".to_string()
    }
  });

  // Date taken
  let date_taken = get_str("DateTimeOriginal");

  // GPS coordinates (already in decimal with -n flag)
  let gps_latitude = get_f64("GPSLatitude");
  let gps_longitude = get_f64("GPSLongitude");
  let gps_altitude = get_f64("GPSAltitude");

  // Orientation
  let orientation = get_u32("Orientation");

  ExifData {
    camera_make,
    camera_model,
    lens_make,
    lens_model,
    focal_length,
    iso,
    aperture,
    shutter_speed,
    exposure_bias,
    date_taken,
    gps_latitude,
    gps_longitude,
    gps_altitude,
    orientation,
  }
}

/// Extract EXIF data from an image file
/// Returns None if the file has no EXIF data or cannot be read
#[napi]
pub fn extract_exif(file_path: String) -> Option<ExifData> {
  extract_exif_internal(&file_path)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn output(value: serde_json::Value, success: bool) -> io::Result<Output> {
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    Ok(Output {
      status: std::process::ExitStatus::from_raw(if success { 0 } else { 256 }),
      stdout: serde_json::to_vec(&value).unwrap(),
      stderr: b"diagnostics must not be parsed as metadata".to_vec(),
    })
  }

  fn command_paths(command: &Command) -> Vec<String> {
    assert_eq!(command.get_program(), "exiftool");
    let args: Vec<_> = command
      .get_args()
      .map(|arg| arg.to_str().unwrap())
      .collect();
    assert_eq!(
      &args[..METADATA_ARGS.len()],
      &[
        "-json",
        "-Make",
        "-Model",
        "-LensMake",
        "-LensModel",
        "-FocalLength",
        "-ISO",
        "-FNumber",
        "-ExposureTime",
        "-ExposureCompensation",
        "-DateTimeOriginal",
        "-GPSLatitude",
        "-GPSLongitude",
        "-GPSAltitude",
        "-Orientation",
        "-Error",
        "-n",
        "--",
      ]
    );
    let paths = &args[METADATA_ARGS.len()..];
    assert!(!paths.is_empty() && paths.len() <= METADATA_CHUNK_SIZE);
    assert!(paths.iter().map(|p| p.len() + 1).sum::<usize>() <= MAX_PATH_ARG_BYTES);
    assert!(paths.iter().all(|p| Path::new(p).is_absolute()));
    paths.iter().map(|p| p.to_string()).collect()
  }

  #[test]
  fn parser_preserves_numeric_orientation_and_existing_formats() {
    let records = parse_records(
      &serde_json::to_vec(&json!([{
        "SourceFile": "photo.jpg", "Make": "Canon", "Model": 123,
        "LensMake": "Sigma", "LensModel": "Art", "FocalLength": 35.9,
        "ISO": 400, "FNumber": 2.8, "ExposureTime": 0.004,
        "ExposureCompensation": 0.333, "DateTimeOriginal": "2024:05:06 12:34:56",
        "GPSLatitude": 45.125, "GPSLongitude": -73.5, "GPSAltitude": -2.25,
        "Orientation": 6
      }]))
      .unwrap(),
    );
    assert_eq!(records[0].0, "photo.jpg");
    let exif = &records[0].1;
    assert_eq!(exif.camera_make.as_deref(), Some("Canon"));
    assert_eq!(exif.camera_model.as_deref(), Some("123"));
    assert_eq!(exif.lens_make.as_deref(), Some("Sigma"));
    assert_eq!(exif.lens_model.as_deref(), Some("Art"));
    assert_eq!(exif.focal_length, Some(35));
    assert_eq!(exif.iso, Some(400));
    assert_eq!(exif.aperture.as_deref(), Some("f/2.8"));
    assert_eq!(exif.shutter_speed.as_deref(), Some("1/250"));
    assert_eq!(exif.exposure_bias.as_deref(), Some("+0.3 EV"));
    assert_eq!(exif.date_taken.as_deref(), Some("2024:05:06 12:34:56"));
    assert_eq!(exif.gps_latitude, Some(45.125));
    assert_eq!(exif.gps_longitude, Some(-73.5));
    assert_eq!(exif.gps_altitude, Some(-2.25));
    assert_eq!(exif.orientation, Some(6));
    for orientation in 1..=8 {
      let value =
        json!({"Orientation": orientation, "ExposureTime": 2, "ExposureCompensation": -0.7});
      let exif = parse_metadata(value.as_object().unwrap());
      assert_eq!(exif.orientation, Some(orientation));
      assert_eq!(exif.shutter_speed.as_deref(), Some("2.0s"));
      assert_eq!(exif.exposure_bias.as_deref(), Some("-0.7 EV"));
    }
    let value = json!({"Orientation": "6", "ExposureCompensation": 0});
    let exif = parse_metadata(value.as_object().unwrap());
    assert_eq!(exif.orientation, None); // Do not change numeric parsing semantics.
    assert_eq!(exif.exposure_bias.as_deref(), Some("0 EV"));
  }

  #[test]
  fn parser_rejects_errors_and_malformed_records_but_accepts_empty_metadata() {
    for bytes in [b"not json".as_slice(), b"{}", b"null", b"[{"] {
      assert!(parse_records(bytes).is_empty());
    }
    let records = parse_records(
      &serde_json::to_vec(&json!([
        null, 42, {}, {"SourceFile": 1}, {"Make": "no source"},
        {"SourceFile": "bad.jpg", "Error": "unreadable", "Orientation": 8},
        {"SourceFile": "empty.jpg"},
        {"SourceFile": "warning.jpg", "Warning": "minor issue", "Orientation": 3}
      ]))
      .unwrap(),
    );
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].1.orientation, None);
    assert_eq!(records[1].1.orientation, Some(3));
  }

  #[test]
  fn commands_batch_45_files_in_three_launches_and_align_reordered_records() {
    let paths: Vec<_> = (0..45).map(|i| format!("photos/{i}.jpg")).collect();
    let mut launches = Vec::new();
    let result = extract_exif_batch_with_runner(&paths, |command| {
      let paths = command_paths(command);
      launches.push(paths.len());
      output(
        json!(
          paths
            .iter()
            .rev()
            .map(|p| json!({
              "SourceFile": p, "Model": Path::new(p).file_stem().unwrap().to_str().unwrap(),
              "Orientation": 6
            }))
            .collect::<Vec<_>>()
        ),
        true,
      )
    });
    assert_eq!(launches, [20, 20, 5]);
    for (i, exif) in result.iter().enumerate() {
      assert_eq!(exif.as_ref().unwrap().camera_model, Some(i.to_string()));
      assert_eq!(exif.as_ref().unwrap().orientation, Some(6));
    }
  }

  #[test]
  fn commands_keep_valid_nonzero_records_and_retry_only_unresolved_unique_paths() {
    let inputs = ["a/photo.jpg", "b/photo.jpg", "missing.jpg", "a/photo.jpg"].map(String::from);
    let mut launches = Vec::new();
    let result = extract_exif_batch_with_runner(&inputs, |command| {
      let paths = command_paths(command);
      launches.push(paths.clone());
      match launches.len() {
        1 => output(
          json!([
            {"SourceFile": paths[1], "Error": "temporary failure"},
            {"SourceFile": paths[0], "Orientation": 6},
            {"SourceFile": paths[0], "Error": "later duplicate error"},
            {"SourceFile": paths[0], "Orientation": 8},
            {"SourceFile": "unrequested.jpg", "Orientation": 1}
          ]),
          false,
        ),
        2 => output(
          json!([
            {"SourceFile": paths[0], "Orientation": 3},
            {"SourceFile": launches[0][0], "Error": "must not overwrite valid metadata"}
          ]),
          false,
        ),
        3 => output(
          json!([{"SourceFile": paths[0], "Error": "still missing"}]),
          false,
        ),
        _ => panic!("unexpected metadata launch"),
      }
    });
    assert_eq!(launches.iter().map(Vec::len).collect::<Vec<_>>(), [3, 1, 1]);
    assert_eq!(launches[1][0], launches[0][1]);
    assert_eq!(launches[2][0], launches[0][2]);
    assert_eq!(
      result
        .iter()
        .map(|e| e.as_ref().and_then(|e| e.orientation))
        .collect::<Vec<_>>(),
      [Some(6), Some(3), None, Some(6)]
    );
  }

  #[test]
  fn commands_use_safe_full_paths_and_deduplicate_normalized_inputs() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("-photo with spaces ' ; $ \u{00e9}.jpg");
    std::fs::write(&path, []).unwrap();
    let alias = temp.path().join(".").join(path.file_name().unwrap());
    let relative = "-relative file with spaces.jpg";
    let inputs = vec![
      path.to_str().unwrap().to_string(),
      alias.to_str().unwrap().to_string(),
      relative.to_string(),
    ];
    let mut launches = 0;
    let result = extract_exif_batch_with_runner(&inputs, |command| {
      let paths = command_paths(command);
      launches += 1;
      assert_eq!(paths.len(), 2);
      assert_eq!(Path::new(&paths[0]), std::path::absolute(&path).unwrap());
      assert_eq!(Path::new(&paths[1]), std::path::absolute(relative).unwrap());
      output(
        json!([
          {"SourceFile": relative, "Orientation": 8},
          {"SourceFile": alias, "Orientation": 2}
        ]),
        true,
      )
    });
    assert_eq!(launches, 1);
    assert_eq!(
      result
        .iter()
        .map(|e| e.as_ref().unwrap().orientation)
        .collect::<Vec<_>>(),
      [Some(2), Some(2), Some(8)]
    );
  }

  #[test]
  #[cfg(unix)]
  fn symlink_aliases_keep_their_filenames_and_are_not_merged() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("blob");
    std::fs::write(&target, []).unwrap();
    let aliases = [temp.path().join("photo.arw"), temp.path().join("photo.tif")];
    for alias in &aliases {
      std::os::unix::fs::symlink(&target, alias).unwrap();
    }
    let inputs: Vec<_> = aliases
      .iter()
      .map(|p| p.to_str().unwrap().to_string())
      .collect();
    let result = extract_exif_batch_with_runner(&inputs, |command| {
      let paths = command_paths(command);
      assert_eq!(paths, inputs);
      output(
        json!([
          {"SourceFile": paths[0], "Orientation": 6},
          {"SourceFile": paths[1], "Orientation": 3}
        ]),
        true,
      )
    });
    assert_eq!(result[0].as_ref().unwrap().orientation, Some(6));
    assert_eq!(result[1].as_ref().unwrap().orientation, Some(3));
  }

  #[test]
  fn command_byte_budget_splits_long_paths_and_skips_impossible_arguments() {
    let mut inputs: Vec<_> = (0..20)
      .map(|i| format!("{}/{i}.jpg", "a".repeat(2000)))
      .collect();
    inputs.push("b".repeat(MAX_PATH_ARG_BYTES));
    let mut launches = 0;
    let result = extract_exif_batch_with_runner(&inputs, |command| {
      let paths = command_paths(command);
      launches += 1;
      output(
        json!(
          paths
            .iter()
            .map(|p| json!({"SourceFile": p}))
            .collect::<Vec<_>>()
        ),
        true,
      )
    });
    assert_eq!(launches, 2);
    assert!(result[..20].iter().all(Option::is_some));
    assert!(result[20].is_none());
  }

  #[test]
  fn malformed_or_failed_batch_retries_each_input_once_without_recursive_retries() {
    for spawn_failure in [false, true] {
      let mut launches = 0;
      let result = extract_exif_batch_with_runner(&["a.jpg".into(), "b.jpg".into()], |command| {
        let paths = command_paths(command);
        launches += 1;
        if launches == 1 && spawn_failure {
          Err(io::Error::new(
            io::ErrorKind::NotFound,
            "fake missing executable",
          ))
        } else if launches == 2 {
          output(json!([{"SourceFile": paths[0], "Orientation": 7}]), true)
        } else {
          let mut invalid = output(json!([]), false).unwrap();
          invalid.stdout = b"truncated [{".to_vec();
          Ok(invalid)
        }
      });
      assert_eq!(launches, 3);
      assert_eq!(result[0].as_ref().unwrap().orientation, Some(7));
      assert!(result[1].is_none());
    }
  }

  #[test]
  fn empty_input_launches_nothing_and_singleton_failure_is_not_retried() {
    assert!(extract_exif_batch_with_runner(&[], |_| panic!("empty command")).is_empty());
    let mut launches = 0;
    let result = extract_exif_batch_with_runner(&["missing.jpg".into()], |command| {
      command_paths(command);
      launches += 1;
      Err(io::Error::new(
        io::ErrorKind::NotFound,
        "fake missing executable",
      ))
    });
    assert_eq!(launches, 1);
    assert!(result[0].is_none());
  }
}
