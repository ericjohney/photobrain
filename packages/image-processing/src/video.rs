//! Video metadata through `ffprobe` and poster frames through `ffmpeg`.
//!
//! Both executables run as direct child processes (no shell) under `run_with_timeout`,
//! so a hung or runaway decoder is killed and reaped instead of stalling a scan worker.

use image::{DynamicImage, ImageFormat};
use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Video extensions handled by this module (case-insensitive suffixes).
const VIDEO_EXTENSIONS: &[&str] = &[".mp4", ".mov", ".m4v"];

/// Hard limit for each `ffprobe`/`ffmpeg` invocation.
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);
/// `ffprobe` JSON for a handful of streams is a few KiB; anything near this is hostile.
const PROBE_STDOUT_CAP: usize = 8 * 1024 * 1024;
/// Largest accepted poster PNG.
const POSTER_STDOUT_CAP: usize = 64 * 1024 * 1024;
/// Diagnostics retained from stderr; the remainder is drained and discarded.
const STDERR_CAP: usize = 64 * 1024;
/// Upper bound of the poster seek position.
const MAX_POSTER_SECONDS: f64 = 1.0;

pub(crate) fn is_video_file(file_path: &str) -> bool {
  let lower = file_path.to_lowercase();
  VIDEO_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

pub(crate) fn video_mime_type(file_path: &str) -> Option<&'static str> {
  let lower = file_path.to_lowercase();
  if lower.ends_with(".mp4") {
    Some("video/mp4")
  } else if lower.ends_with(".mov") {
    Some("video/quicktime")
  } else if lower.ends_with(".m4v") {
    Some("video/x-m4v")
  } else {
    None
  }
}

/// Output of a child process that exited before its deadline.
#[derive(Debug)]
pub(crate) struct ProcessOutput {
  pub status: ExitStatus,
  pub stdout: Vec<u8>,
  /// At most `STDERR_CAP` leading bytes.
  pub stderr: Vec<u8>,
}

#[derive(Debug)]
pub(crate) enum RunError {
  /// The executable could not be started (`NotFound` for a missing binary).
  Spawn(io::Error),
  /// The deadline passed; the child was killed and reaped.
  TimedOut(Duration),
  /// Stdout exceeded the cap; the child was killed and reaped.
  StdoutLimit(usize),
  Io(io::Error),
}

enum Pipe {
  Stdout(io::Result<Option<Vec<u8>>>),
  Stderr(io::Result<Vec<u8>>),
}

fn kill_and_reap(child: &mut Child) {
  // `kill` fails only if the child already exited; `wait` then reaps it either way.
  let _ = child.kill();
  let _ = child.wait();
}

/// Runs `command` with null stdin and piped stdout/stderr, read on helper threads.
/// Returns once the child exits; on timeout or when stdout exceeds `stdout_cap` bytes the
/// child is killed and waited for, so no zombie remains. A nonzero exit status is not an
/// error here: callers interpret `status`. Grandchildren that inherit the pipes are not
/// tracked, so commands must be direct executables, not shell wrappers.
pub(crate) fn run_with_timeout(
  command: &mut Command,
  timeout: Duration,
  stdout_cap: usize,
) -> Result<ProcessOutput, RunError> {
  let deadline = Instant::now() + timeout;
  let mut child = command
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(RunError::Spawn)?;
  let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
  let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
  let (sender, events) = mpsc::channel();
  let stdout_sender = sender.clone();
  let readers = thread::Builder::new()
    .name("child-stdout".into())
    .spawn(move || {
      let mut buffer = Vec::new();
      let limit = stdout_cap as u64 + 1;
      let result = (&mut stdout_pipe)
        .take(limit)
        .read_to_end(&mut buffer)
        .map(|_| (buffer.len() <= stdout_cap).then_some(buffer));
      // Dropping the pipe on overflow lets a blocked writer fail fast before the kill.
      let _ = stdout_sender.send(Pipe::Stdout(result));
    })
    .and_then(|_| {
      thread::Builder::new()
        .name("child-stderr".into())
        .spawn(move || {
          let mut buffer = Vec::new();
          let result = (&mut stderr_pipe)
            .take(STDERR_CAP as u64)
            .read_to_end(&mut buffer)
            .and_then(|_| io::copy(&mut stderr_pipe, &mut io::sink()))
            .map(|_| buffer);
          let _ = sender.send(Pipe::Stderr(result));
        })
    });
  if let Err(error) = readers {
    kill_and_reap(&mut child);
    return Err(RunError::Io(error));
  }

  let (mut stdout, mut stderr) = (None, None);
  while stdout.is_none() || stderr.is_none() {
    let remaining = deadline.saturating_duration_since(Instant::now());
    match events.recv_timeout(remaining) {
      Ok(Pipe::Stdout(Ok(Some(bytes)))) => stdout = Some(bytes),
      Ok(Pipe::Stdout(Ok(None))) => {
        kill_and_reap(&mut child);
        return Err(RunError::StdoutLimit(stdout_cap));
      }
      Ok(Pipe::Stderr(Ok(bytes))) => stderr = Some(bytes),
      Ok(Pipe::Stdout(Err(error)) | Pipe::Stderr(Err(error))) => {
        kill_and_reap(&mut child);
        return Err(RunError::Io(error));
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {
        kill_and_reap(&mut child);
        return Err(RunError::TimedOut(timeout));
      }
      Err(mpsc::RecvTimeoutError::Disconnected) => {
        kill_and_reap(&mut child);
        return Err(RunError::Io(io::Error::other("child output reader exited")));
      }
    }
  }

  // Both pipes reached EOF, which normally means the child is exiting. A child that
  // closed its outputs but keeps running is still bounded by the deadline.
  let mut pause = Duration::from_micros(200);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if Instant::now() >= deadline => {
        kill_and_reap(&mut child);
        return Err(RunError::TimedOut(timeout));
      }
      Ok(None) => {
        thread::sleep(pause);
        pause = (pause * 2).min(Duration::from_millis(10));
      }
      Err(error) => {
        kill_and_reap(&mut child);
        return Err(RunError::Io(error));
      }
    }
  };
  Ok(ProcessOutput {
    status,
    stdout: stdout.unwrap_or_default(),
    stderr: stderr.unwrap_or_default(),
  })
}

/// A configured executable: `FFPROBE_BIN`/`FFMPEG_BIN`, else the name on `PATH`.
struct Tool {
  name: &'static str,
  env: &'static str,
  program: OsString,
}

impl Tool {
  fn resolve(name: &'static str, env: &'static str) -> Self {
    let program = std::env::var_os(env)
      .filter(|value| !value.is_empty())
      .unwrap_or_else(|| name.into());
    Tool { name, env, program }
  }

  fn ffprobe() -> Self {
    Self::resolve("ffprobe", "FFPROBE_BIN")
  }

  fn ffmpeg() -> Self {
    Self::resolve("ffmpeg", "FFMPEG_BIN")
  }

  fn run(&self, args: &[&OsStr], stdout_cap: usize) -> Result<ProcessOutput, String> {
    let mut command = Command::new(&self.program);
    command.args(args);
    run_with_timeout(&mut command, PROCESS_TIMEOUT, stdout_cap).map_err(|error| {
      let program = self.program.to_string_lossy();
      match error {
        RunError::Spawn(error) if error.kind() == io::ErrorKind::NotFound => format!(
          "{} executable `{program}` not found; install ffmpeg or set {}",
          self.name, self.env
        ),
        RunError::Spawn(error) => format!("Failed to start {} `{program}`: {error}", self.name),
        RunError::TimedOut(timeout) => {
          format!("{} timed out after {} s", self.name, timeout.as_secs_f64())
        }
        RunError::StdoutLimit(cap) => format!("{} output exceeded {cap} bytes", self.name),
        RunError::Io(error) => format!("{} I/O error: {error}", self.name),
      }
    })
  }
}

/// Last non-empty stderr line, for concise error messages.
fn diagnostic(stderr: &[u8]) -> String {
  String::from_utf8_lossy(stderr)
    .lines()
    .rev()
    .map(str::trim)
    .find(|line| !line.is_empty())
    .unwrap_or("no diagnostics")
    .to_string()
}

/// `file:` prevents names beginning with `-` or containing `:` being read as options or
/// protocol URLs.
fn input_url(file_path: &str) -> OsString {
  let mut url = OsString::from("file:");
  url.push(file_path);
  url
}

#[derive(Debug, PartialEq)]
pub(crate) struct VideoProbe {
  /// Container stream index of the first non-cover-art video stream.
  pub stream_index: u64,
  /// Display dimensions: coded size swapped for ±90/270° rotation.
  pub width: u32,
  pub height: u32,
  /// Positive, finite duration in seconds.
  pub duration: Option<f64>,
  pub codec: Option<String>,
}

fn positive_seconds(value: Option<&serde_json::Value>) -> Option<f64> {
  let seconds = match value? {
    serde_json::Value::String(text) => text.trim().parse::<f64>().ok()?,
    value => value.as_f64()?,
  };
  (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

fn stream_rotation(stream: &serde_json::Value) -> i64 {
  let side_data = stream["side_data_list"]
    .as_array()
    .into_iter()
    .flatten()
    .find_map(|entry| entry["rotation"].as_f64());
  let tag = || {
    stream["tags"]["rotate"]
      .as_str()
      .and_then(|text| text.trim().parse::<f64>().ok())
  };
  side_data
    .or_else(tag)
    .filter(|degrees| degrees.is_finite())
    .map_or(0, |degrees| (degrees.round() as i64).rem_euclid(360))
}

pub(crate) fn parse_probe(json: &[u8]) -> Result<VideoProbe, String> {
  let value: serde_json::Value = serde_json::from_slice(json)
    .map_err(|error| format!("ffprobe returned invalid JSON: {error}"))?;
  let stream = value["streams"]
    .as_array()
    .into_iter()
    .flatten()
    .find(|stream| {
      stream["codec_type"] == "video" && stream["disposition"]["attached_pic"].as_i64() != Some(1)
    })
    .ok_or("File has no video stream")?;
  let dimension = |key: &str| {
    stream[key]
      .as_u64()
      .and_then(|value| u32::try_from(value).ok())
      .filter(|value| *value > 0)
  };
  let (Some(coded_width), Some(coded_height)) = (dimension("width"), dimension("height")) else {
    return Err("Video stream has no dimensions".into());
  };
  let (width, height) = match stream_rotation(stream) {
    90 | 270 => (coded_height, coded_width),
    _ => (coded_width, coded_height),
  };
  Ok(VideoProbe {
    stream_index: stream["index"]
      .as_u64()
      .ok_or("Video stream has no index")?,
    width,
    height,
    duration: positive_seconds(value["format"].get("duration"))
      .or_else(|| positive_seconds(stream.get("duration"))),
    codec: stream["codec_name"].as_str().map(str::to_string),
  })
}

fn probe_with(tool: &Tool, file_path: &str) -> Result<VideoProbe, String> {
  let url = input_url(file_path);
  let args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
  ]
  .map(OsStr::new);
  let mut argv: Vec<&OsStr> = args.to_vec();
  argv.push(&url);
  let output = tool.run(&argv, PROBE_STDOUT_CAP)?;
  if !output.status.success() {
    return Err(format!("ffprobe failed: {}", diagnostic(&output.stderr)));
  }
  parse_probe(&output.stdout)
}

/// Poster seek position: `min(1 s, duration / 2)`, or the first frame when unknown.
pub(crate) fn poster_seconds(duration: Option<f64>) -> f64 {
  duration.map_or(0.0, |duration| (duration / 2.0).min(MAX_POSTER_SECONDS))
}

/// Why a poster frame attempt failed.
enum FrameError {
  /// ffmpeg ran but yielded no usable frame; another position may still work.
  NoFrame(String),
  /// The executable is missing, timed out, or overflowed; retrying cannot help.
  Process(String),
}

impl FrameError {
  fn message(self) -> String {
    match self {
      FrameError::NoFrame(message) | FrameError::Process(message) => message,
    }
  }
}

/// One frame of `stream_index` at `seconds`, autorotated by ffmpeg, as PNG on stdout.
fn decode_frame(
  tool: &Tool,
  file_path: &str,
  stream_index: u64,
  seconds: f64,
) -> Result<DynamicImage, FrameError> {
  let url = input_url(file_path);
  let position = format!("{seconds:.3}");
  let map = format!("0:{stream_index}");
  let mut argv: Vec<&OsStr> = ["-nostdin", "-v", "error"].map(OsStr::new).to_vec();
  if seconds > 0.0 {
    // Input seeking: demux from the preceding keyframe, decode only up to the position.
    argv.extend([OsStr::new("-ss"), OsStr::new(&position)]);
  }
  argv.extend([OsStr::new("-i"), &url]);
  argv.extend(
    [
      "-map",
      map.as_str(),
      "-frames:v",
      "1",
      // 8-bit RGB and fast deflate: the poster is resized to WebP thumbnails anyway.
      "-pix_fmt",
      "rgb24",
      "-compression_level",
      "1",
      "-f",
      "image2pipe",
      "-vcodec",
      "png",
      "-",
    ]
    .map(OsStr::new),
  );
  let output = tool
    .run(&argv, POSTER_STDOUT_CAP)
    .map_err(FrameError::Process)?;
  if output.stdout.is_empty() {
    return Err(FrameError::NoFrame(format!(
      "ffmpeg produced no frame at {position} s: {}",
      diagnostic(&output.stderr)
    )));
  }
  // Decode errors near the tail can make ffmpeg exit nonzero after a complete frame.
  image::load_from_memory_with_format(&output.stdout, ImageFormat::Png).map_err(|error| {
    FrameError::NoFrame(format!(
      "Invalid ffmpeg poster frame at {position} s: {error}"
    ))
  })
}

fn poster_with(tool: &Tool, file_path: &str, probe: &VideoProbe) -> Result<DynamicImage, String> {
  let seconds = poster_seconds(probe.duration);
  match decode_frame(tool, file_path, probe.stream_index, seconds) {
    Ok(image) => Ok(image),
    Err(FrameError::NoFrame(error)) if seconds > 0.0 => {
      decode_frame(tool, file_path, probe.stream_index, 0.0)
        .map_err(|retry| format!("{error}; retry at 0 s: {}", retry.message()))
    }
    Err(error) => Err(error.message()),
  }
}

pub(crate) struct VideoPoster {
  pub probe: VideoProbe,
  pub image: DynamicImage,
}

impl VideoPoster {
  pub fn duration_ms(&self) -> Option<i64> {
    self
      .probe
      .duration
      .map(|seconds| (seconds * 1000.0).round() as i64)
  }
}

/// Probes `file_path` and decodes its poster frame with the configured executables.
pub(crate) fn load_video(file_path: &str) -> Result<VideoPoster, String> {
  let probe = probe_with(&Tool::ffprobe(), file_path)?;
  let image = poster_with(&Tool::ffmpeg(), file_path, &probe)?;
  Ok(VideoPoster { probe, image })
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use image::GenericImageView;
  use serde_json::json;
  use std::path::{Path, PathBuf};

  /// Runs ffmpeg to build a fixture. Video tests require ffmpeg and fail rather than skip.
  pub(crate) fn ffmpeg(args: &[&str]) {
    let output = Command::new("ffmpeg")
      .args(["-nostdin", "-v", "error", "-y"])
      .args(args)
      .output()
      .expect("ffmpeg must be installed to run video tests (brew install ffmpeg)");
    assert!(
      output.status.success(),
      "ffmpeg {args:?} failed: {}",
      String::from_utf8_lossy(&output.stderr)
    );
  }

  /// `testsrc2` H.264 MP4 of the given size and duration.
  pub(crate) fn h264_clip(dir: &Path, name: &str, size: &str, seconds: f64) -> PathBuf {
    let path = dir.join(name);
    let source = format!("testsrc2=size={size}:rate=30:duration={seconds}");
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      &source,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path.to_str().unwrap(),
    ]);
    path
  }

  fn str(path: &Path) -> &str {
    path.to_str().unwrap()
  }

  /// A clip whose luma rises with time, encoded losslessly, so a pixel identifies its frame.
  fn ramp_clip(dir: &Path, name: &str, seconds: f64, luma_per_second: u32) -> PathBuf {
    let path = dir.join(name);
    let source = format!(
      "color=c=black:s=64x64:r=20:d={seconds},format=yuv444p,geq=lum='16+T*{luma_per_second}':cb=128:cr=128"
    );
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      &source,
      "-c:v",
      "libx264",
      "-qp",
      "0",
      "-pix_fmt",
      "yuv444p",
      str(&path),
    ]);
    path
  }

  fn luma_at(dir: &Path, clip: &Path, seconds: f64) -> u8 {
    let frame = dir.join(format!("reference-{seconds}.png"));
    ffmpeg(&[
      "-ss",
      &format!("{seconds:.3}"),
      "-i",
      str(clip),
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      str(&frame),
    ]);
    image::open(frame).unwrap().to_rgb8().get_pixel(32, 32)[0]
  }

  #[test]
  fn probes_h264_mp4_with_audio_and_hevc_mov() {
    let temp = tempfile::tempdir().unwrap();
    let mp4 = temp.path().join("clip.mp4");
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c:a",
      "aac",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      str(&mp4),
    ]);
    let mov = temp.path().join("clip.MOV");
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=256x144:rate=30:duration=1",
      "-c:v",
      "libx265",
      "-x265-params",
      "log-level=error",
      "-tag:v",
      "hvc1",
      str(&mov),
    ]);

    let video = load_video(str(&mp4)).unwrap();
    // The audio stream is first; the video stream index is used for the poster.
    assert_eq!(video.probe.stream_index, 1);
    assert_eq!((video.probe.width, video.probe.height), (320, 180));
    assert_eq!(video.probe.codec.as_deref(), Some("h264"));
    let duration = video.duration_ms().unwrap();
    assert!((1950..=2100).contains(&duration), "{duration}");
    assert_eq!(video.image.dimensions(), (320, 180));

    let video = load_video(str(&mov)).unwrap();
    assert_eq!((video.probe.width, video.probe.height), (256, 144));
    assert_eq!(video.probe.codec.as_deref(), Some("hevc"));
    assert_eq!(video.duration_ms(), Some(1000));
    assert_eq!(video.image.dimensions(), (256, 144));
  }

  #[test]
  fn rotation_swaps_display_dimensions_and_poster_is_portrait() {
    let temp = tempfile::tempdir().unwrap();
    let source = h264_clip(temp.path(), "source.mp4", "320x180", 1.0);
    let rotated = temp.path().join("rotated.mov");
    ffmpeg(&[
      "-display_rotation",
      "90",
      "-i",
      str(&source),
      "-c",
      "copy",
      str(&rotated),
    ]);
    let video = load_video(str(&rotated)).unwrap();
    assert_eq!((video.probe.width, video.probe.height), (180, 320));
    assert_eq!(video.image.dimensions(), (180, 320));
  }

  #[test]
  fn rotation_sources_and_angles() {
    let probe = |stream: serde_json::Value| {
      let mut stream = stream;
      stream["index"] = json!(0);
      stream["codec_type"] = json!("video");
      stream["width"] = json!(1920);
      stream["height"] = json!(1080);
      parse_probe(&serde_json::to_vec(&json!({"streams": [stream], "format": {}})).unwrap())
        .map(|probe| (probe.width, probe.height))
        .unwrap()
    };
    let portrait = (1080, 1920);
    let landscape = (1920, 1080);
    for rotation in [90.0, -90.0, 270.0, -270.0, 450.0, 89.7] {
      assert_eq!(
        probe(
          json!({"side_data_list": [{"side_data_type": "Display Matrix", "rotation": rotation}]})
        ),
        portrait,
        "{rotation}"
      );
    }
    for rotation in [0.0, 180.0, -180.0, 360.0] {
      assert_eq!(
        probe(json!({"side_data_list": [{"rotation": rotation}]})),
        landscape
      );
    }
    assert_eq!(probe(json!({"tags": {"rotate": "270"}})), portrait);
    assert_eq!(probe(json!({"tags": {"rotate": "180"}})), landscape);
    // Side data is authoritative over the legacy tag.
    assert_eq!(
      probe(json!({"side_data_list": [{"rotation": 0}], "tags": {"rotate": "90"}})),
      landscape
    );
    assert_eq!(probe(json!({"tags": {"rotate": "sideways"}})), landscape);
  }

  #[test]
  fn probe_selects_video_and_validates_duration_and_streams() {
    let parse = |value: serde_json::Value| parse_probe(&serde_json::to_vec(&value).unwrap());
    let video = json!({"index": 2, "codec_type": "video", "codec_name": "hevc",
      "width": 64, "height": 48, "duration": "3.5"});
    let cover = json!({"index": 1, "codec_type": "video", "codec_name": "mjpeg",
      "width": 600, "height": 600, "disposition": {"attached_pic": 1}});
    let audio = json!({"index": 0, "codec_type": "audio", "duration": "9.0"});

    let probe =
      parse(json!({"streams": [audio, cover, video], "format": {"duration": "4.25"}})).unwrap();
    assert_eq!(probe.stream_index, 2);
    assert_eq!(probe.codec.as_deref(), Some("hevc"));
    assert_eq!(probe.duration, Some(4.25));
    // Missing, zero, negative, or non-numeric format durations fall back to the stream.
    for format in [
      json!({}),
      json!({"duration": "0.000000"}),
      json!({"duration": "-1"}),
      json!({"duration": "N/A"}),
    ] {
      assert_eq!(
        parse(json!({"streams": [video], "format": format}))
          .unwrap()
          .duration,
        Some(3.5)
      );
    }
    let mut no_duration = video.clone();
    no_duration["duration"] = json!("0");
    assert_eq!(
      parse(json!({"streams": [no_duration], "format": {}}))
        .unwrap()
        .duration,
      None
    );

    let error = parse(json!({"streams": [audio, cover], "format": {}})).unwrap_err();
    assert!(error.contains("no video stream"), "{error}");
    let mut sizeless = video.clone();
    sizeless["width"] = json!(0);
    assert!(parse(json!({"streams": [sizeless], "format": {}})).is_err());
    assert!(
      parse_probe(b"not json")
        .unwrap_err()
        .contains("invalid JSON")
    );
  }

  #[test]
  fn poster_time_is_half_the_duration_capped_at_one_second() {
    assert_eq!(poster_seconds(None), 0.0);
    assert_eq!(poster_seconds(Some(0.5)), 0.25);
    assert_eq!(poster_seconds(Some(2.0)), 1.0);
    assert_eq!(poster_seconds(Some(600.0)), 1.0);

    let temp = tempfile::tempdir().unwrap();
    let short = ramp_clip(temp.path(), "short.mp4", 0.5, 400);
    let poster = load_video(str(&short)).unwrap();
    let luma = poster.image.to_rgb8().get_pixel(32, 32)[0];
    assert_eq!(luma, luma_at(temp.path(), &short, 0.25));
    assert_ne!(luma, luma_at(temp.path(), &short, 0.2));
    assert_ne!(luma, luma_at(temp.path(), &short, 0.3));

    let long = ramp_clip(temp.path(), "long.mov", 4.0, 50);
    let poster = load_video(str(&long)).unwrap();
    let luma = poster.image.to_rgb8().get_pixel(32, 32)[0];
    assert_eq!(luma, luma_at(temp.path(), &long, 1.0));
    assert_ne!(luma, luma_at(temp.path(), &long, 2.0));
  }

  #[test]
  fn corrupt_tail_falls_back_to_the_first_frame() {
    let temp = tempfile::tempdir().unwrap();
    let complete = temp.path().join("complete.mp4");
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      str(&complete),
    ]);
    // The index (moov) still claims 2 s, but media data after ~30% is gone, so the
    // 1 s seek finds nothing and the poster comes from the retry at 0 s.
    let bytes = std::fs::read(&complete).unwrap();
    let truncated = temp.path().join("truncated.mp4");
    std::fs::write(&truncated, &bytes[..bytes.len() * 3 / 10]).unwrap();
    let probe = probe_with(&Tool::ffprobe(), str(&truncated)).unwrap();
    assert_eq!(probe.duration, Some(2.0));
    assert!(decode_frame(&Tool::ffmpeg(), str(&truncated), probe.stream_index, 1.0).is_err());
    let video = load_video(str(&truncated)).unwrap();
    assert_eq!(video.image.dimensions(), (320, 180));
  }

  #[test]
  fn frameless_and_audio_only_files_fail() {
    let temp = tempfile::tempdir().unwrap();
    // Fragmented MP4 with a video track but zero duration and no frames.
    let empty = temp.path().join("empty.mp4");
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=30",
      "-frames:v",
      "0",
      "-c:v",
      "libx264",
      "-movflags",
      "frag_keyframe+empty_moov",
      str(&empty),
    ]);
    let probe = probe_with(&Tool::ffprobe(), str(&empty)).unwrap();
    assert_eq!(probe.duration, None);
    let error = load_video(str(&empty)).err().unwrap();
    assert!(error.contains("no frame"), "{error}");

    let audio = temp.path().join("audio.mp4");
    ffmpeg(&[
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "aac",
      str(&audio),
    ]);
    let error = load_video(str(&audio)).err().unwrap();
    assert!(error.contains("no video stream"), "{error}");

    let garbage = temp.path().join("garbage.mov");
    std::fs::write(&garbage, b"definitely not a movie").unwrap();
    let error = load_video(str(&garbage)).err().unwrap();
    assert!(error.starts_with("ffprobe failed:"), "{error}");
  }

  #[test]
  fn missing_executables_report_the_override_variable() {
    let temp = tempfile::tempdir().unwrap();
    let clip = h264_clip(temp.path(), "clip.mp4", "64x64", 0.2);
    let missing = |name, env| Tool {
      name,
      env,
      program: "/nonexistent".into(),
    };
    let error = probe_with(&missing("ffprobe", "FFPROBE_BIN"), str(&clip)).unwrap_err();
    assert_eq!(
      error,
      "ffprobe executable `/nonexistent` not found; install ffmpeg or set FFPROBE_BIN"
    );
    let probe = probe_with(&Tool::ffprobe(), str(&clip)).unwrap();
    let error = poster_with(&missing("ffmpeg", "FFMPEG_BIN"), str(&clip), &probe).unwrap_err();
    // Not retried at 0 s: a missing binary is not a seek problem.
    assert_eq!(
      error,
      "ffmpeg executable `/nonexistent` not found; install ffmpeg or set FFMPEG_BIN"
    );
  }

  /// Runs only in the child process spawned below, where `FFPROBE_BIN` is set without
  /// racing other tests that read the environment.
  #[test]
  #[ignore = "spawned by ffprobe_bin_environment_override_is_used"]
  fn ffprobe_bin_environment_child() {
    let clip = std::env::var("VIDEO_TEST_CLIP").unwrap();
    let error = load_video(&clip).err().unwrap();
    assert_eq!(
      error,
      "ffprobe executable `/nonexistent` not found; install ffmpeg or set FFPROBE_BIN"
    );
  }

  #[test]
  fn ffprobe_bin_environment_override_is_used() {
    let temp = tempfile::tempdir().unwrap();
    let clip = h264_clip(temp.path(), "clip.mp4", "64x64", 0.2);
    let output = Command::new(std::env::current_exe().unwrap())
      .args([
        "--ignored",
        "--exact",
        "video::tests::ffprobe_bin_environment_child",
      ])
      .env("FFPROBE_BIN", "/nonexistent")
      .env("VIDEO_TEST_CLIP", &clip)
      .output()
      .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
      output.status.success() && stdout.contains("1 passed"),
      "{stdout}{}",
      String::from_utf8_lossy(&output.stderr)
    );
  }

  #[test]
  fn timeout_kills_and_reaps_promptly() {
    let started = Instant::now();
    let error = run_with_timeout(
      Command::new("sleep").arg("5"),
      Duration::from_millis(200),
      1024,
    )
    .unwrap_err();
    let elapsed = started.elapsed();
    assert!(matches!(error, RunError::TimedOut(_)), "{error:?}");
    assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
  }

  #[test]
  fn stdout_cap_is_inclusive_and_runaway_output_is_killed() {
    let exact = run_with_timeout(
      Command::new("head").args(["-c", "1024", "/dev/zero"]),
      Duration::from_secs(5),
      1024,
    )
    .unwrap();
    assert!(exact.status.success());
    assert_eq!(exact.stdout.len(), 1024);

    let error = run_with_timeout(
      Command::new("head").args(["-c", "1025", "/dev/zero"]),
      Duration::from_secs(5),
      1024,
    )
    .unwrap_err();
    assert!(matches!(error, RunError::StdoutLimit(1024)), "{error:?}");

    // Endless output must be stopped by the cap, not the 5 s deadline.
    let started = Instant::now();
    let error =
      run_with_timeout(&mut Command::new("yes"), Duration::from_secs(5), 4096).unwrap_err();
    assert!(matches!(error, RunError::StdoutLimit(4096)), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
  }

  #[test]
  fn nonzero_exit_returns_output_and_stderr_is_bounded() {
    let output = run_with_timeout(
      Command::new("sh").args([
        "-c",
        "printf out; head -c 200000 /dev/zero | tr '\\0' e >&2; exit 3",
      ]),
      Duration::from_secs(5),
      1024,
    )
    .unwrap();
    assert_eq!(output.status.code(), Some(3));
    assert_eq!(output.stdout, b"out");
    assert_eq!(output.stderr.len(), STDERR_CAP);
    let error =
      run_with_timeout(&mut Command::new("/nonexistent"), Duration::from_secs(1), 1).unwrap_err();
    assert!(matches!(&error, RunError::Spawn(e) if e.kind() == io::ErrorKind::NotFound));
  }
}
