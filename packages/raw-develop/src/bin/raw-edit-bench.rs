//! Decode/prepare once, then measure repeated exposure renders without encoding or I/O.

use raw_develop::{DevelopSettings, Negative, Options, Quality, prepare};
use serde::Serialize;
use std::hint::black_box;
use std::process::ExitCode;
use std::time::Instant;

#[derive(Serialize)]
struct Record {
  file: String,
  quality: &'static str,
  threads: usize,
  source_dimensions: [usize; 2],
  working_dimensions: [usize; 2],
  working_pixel_bytes: usize,
  decode_ms: f64,
  prepare_ms: f64,
  resize_ms: f64,
  iterations: usize,
  render_p50_ms: f64,
  render_p95_ms: f64,
  render_max_ms: f64,
  final_digest: String,
}

struct Config {
  max_edge: usize,
  iterations: usize,
  threads: usize,
  settings: DevelopSettings,
  full: bool,
  files: Vec<String>,
}

fn config() -> Result<Config, String> {
  let mut cfg = Config {
    max_edge: 2048,
    iterations: 30,
    threads: std::thread::available_parallelism().map_or(1, usize::from),
    settings: DevelopSettings::default(),
    full: false,
    files: Vec::new(),
  };
  let mut args = std::env::args().skip(1);
  while let Some(arg) = args.next() {
    match arg.as_str() {
      "--max-edge" | "--iterations" | "--threads" => {
        let value: usize = args
          .next()
          .and_then(|a| a.parse().ok())
          .filter(|&n| n > 0)
          .ok_or_else(|| format!("{arg} needs a positive integer"))?;
        match arg.as_str() {
          "--max-edge" => cfg.max_edge = value,
          "--iterations" => cfg.iterations = value,
          _ => cfg.threads = value,
        }
      }
      "--settings" => {
        let path = args.next().ok_or("--settings needs a path")?;
        cfg.settings = serde_json::from_str(
          &std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?,
        )
        .map_err(|e| format!("{path}: {e}"))?;
      }
      "--full" => cfg.full = true,
      "--" => {
        cfg.files.extend(args);
        break;
      }
      _ if arg.starts_with('-') => return Err(format!("unknown option {arg}")),
      _ => cfg.files.push(arg),
    }
  }
  if cfg.files.is_empty() {
    return Err(
      "usage: raw-edit-bench [--max-edge 2048] [--iterations 30] [--threads N] [--full] [--settings s.json] FILE..."
        .into(),
    );
  }
  cfg.settings.validate().map_err(|e| e.to_string())?;
  Ok(cfg)
}

fn run(cfg: &Config, file: &str) -> raw_develop::Result<Record> {
  let opts = Options {
    quality: if cfg.full {
      Quality::Full
    } else {
      Quality::Preview
    },
    ..Options::default()
  };
  let t = Instant::now();
  let negative = Negative::open(file)?;
  let decode_ms = t.elapsed().as_secs_f64() * 1000.0;
  let source_dimensions = [negative.meta.crop_width, negative.meta.crop_height];
  let t = Instant::now();
  let prepared = prepare(&negative, &cfg.settings, &opts)?;
  let prepare_ms = t.elapsed().as_secs_f64() * 1000.0;
  drop(negative);
  let t = Instant::now();
  let prepared = prepared.with_max_edge(cfg.max_edge)?;
  let resize_ms = t.elapsed().as_secs_f64() * 1000.0;
  let (width, height) = prepared.dimensions();
  let mut settings = cfg.settings.clone();
  // Warm the repeated path before timing. Exposure varies around the requested
  // baseline (clamped to its validated range) rather than re-rendering one value.
  for _ in 0..3 {
    black_box(prepared.render(&settings, &opts)?);
  }
  let mut times = Vec::with_capacity(cfg.iterations);
  let mut digest = 0u64;
  for i in 0..cfg.iterations {
    settings.exposure = (cfg.settings.exposure + (i % 21) as f64 * 0.1 - 1.0).clamp(-10.0, 10.0);
    let t = Instant::now();
    let out = prepared.render(&settings, &opts)?;
    times.push(t.elapsed().as_secs_f64() * 1000.0);
    black_box(&out);
    if i + 1 == cfg.iterations {
      // Outside the timed interval. Fingerprint all pixels to catch accidental
      // benchmark changes and make the final sample observable.
      digest = 0xcbf29ce484222325;
      for p in &out.image.data {
        for b in p.to_bits().to_le_bytes() {
          digest = (digest ^ b as u64).wrapping_mul(0x100000001b3);
        }
      }
    }
  }
  times.sort_by(f64::total_cmp);
  let percentile = |p: f64| times[((times.len() as f64 * p).ceil() as usize).saturating_sub(1)];
  Ok(Record {
    file: file.into(),
    quality: if cfg.full { "full" } else { "preview" },
    threads: cfg.threads,
    source_dimensions,
    working_dimensions: [width, height],
    working_pixel_bytes: prepared.pixel_bytes(),
    decode_ms,
    prepare_ms,
    resize_ms,
    iterations: cfg.iterations,
    render_p50_ms: percentile(0.5),
    render_p95_ms: percentile(0.95),
    render_max_ms: *times.last().unwrap(),
    final_digest: format!("{digest:016x}"),
  })
}

fn main() -> ExitCode {
  let result = (|| -> Result<(), String> {
    let cfg = config()?;
    let pool = rayon::ThreadPoolBuilder::new()
      .num_threads(cfg.threads)
      .build()
      .map_err(|e| e.to_string())?;
    for file in &cfg.files {
      let record = pool
        .install(|| run(&cfg, file))
        .map_err(|e| format!("{file}: {e}"))?;
      println!(
        "{}",
        serde_json::to_string(&record).map_err(|e| e.to_string())?
      );
    }
    Ok(())
  })();
  match result {
    Ok(()) => ExitCode::SUCCESS,
    Err(e) => {
      eprintln!("error: {e}");
      ExitCode::FAILURE
    }
  }
}
