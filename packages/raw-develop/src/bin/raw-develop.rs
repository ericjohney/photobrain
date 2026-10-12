//! raw-develop CLI.
//!
//!   raw-develop info <file.RAF>
//!   raw-develop cfa <file.RAF> <out.u16>
//!   raw-develop develop <file.RAF> <out.png|out.jpg> [--settings settings.json]
//!                       [--preview] [--dump-linear <out.f32>] [--dump-final <out.f32>]

use raw_develop::{DevelopSettings, Negative, Options, Quality, develop, encode, image::RgbImage};
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

fn usage() -> ExitCode {
  eprintln!(
    "usage:\n  raw-develop info <file.RAF>\n  raw-develop cfa <file.RAF> <out.u16>\n  raw-develop develop <file.RAF> <out.png|jpg> [--settings s.json] [--preview] [--dump-linear f] [--dump-final f]"
  );
  ExitCode::from(2)
}

fn main() -> ExitCode {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let result = match args.first().map(String::as_str) {
    Some("info") if args.len() == 2 => info(&args[1]),
    Some("cfa") if args.len() == 3 => cfa(&args[1], &args[2]),
    Some("develop") if args.len() >= 3 => run_develop(&args[1], &args[2], &args[3..]),
    _ => return usage(),
  };
  match result {
    Ok(()) => ExitCode::SUCCESS,
    Err(e) => {
      eprintln!("error: {e}");
      ExitCode::FAILURE
    }
  }
}

fn info(path: &str) -> raw_develop::Result<()> {
  let data = std::fs::read(path)?;
  let meta = Negative::read_metadata(&data)?;
  println!("{meta:#?}");
  Ok(())
}

fn cfa(path: &str, out: &str) -> raw_develop::Result<()> {
  let t = Instant::now();
  let neg = Negative::open(path)?;
  eprintln!(
    "decoded {}x{} in {:?}",
    neg.meta.raw_width,
    neg.meta.raw_height,
    t.elapsed()
  );
  let bytes: Vec<u8> = neg.mosaic.iter().flat_map(|v| v.to_le_bytes()).collect();
  std::fs::write(out, bytes)?;
  Ok(())
}

/// Same `.f32` layout as tools/apple-reference: "RDF32\0\0\0", u32 w, u32 h, RGB f32 LE.
fn write_f32(img: &RgbImage, path: &str) -> raw_develop::Result<()> {
  let mut b = Vec::with_capacity(16 + img.data.len() * 4);
  b.extend_from_slice(b"RDF32\0\0\0");
  b.extend_from_slice(&(img.width as u32).to_le_bytes());
  b.extend_from_slice(&(img.height as u32).to_le_bytes());
  for v in &img.data {
    b.extend_from_slice(&v.to_le_bytes());
  }
  std::fs::write(path, b)?;
  Ok(())
}

fn run_develop(input: &str, output: &str, rest: &[String]) -> raw_develop::Result<()> {
  let mut settings = DevelopSettings::default();
  let mut opts = Options::default();
  let (mut dump_linear, mut dump_final) = (None, None);
  let mut it = rest.iter();
  while let Some(a) = it.next() {
    match a.as_str() {
      "--settings" => {
        let p = it
          .next()
          .ok_or_else(|| raw_develop::Error::Settings("--settings needs a path".into()))?;
        settings = serde_json::from_str(&std::fs::read_to_string(p)?)
          .map_err(|e| raw_develop::Error::Settings(e.to_string()))?;
      }
      "--preview" => opts.quality = Quality::Preview,
      "--dump-linear" => dump_linear = it.next().cloned(),
      "--dump-final" => dump_final = it.next().cloned(),
      other => {
        return Err(raw_develop::Error::Settings(format!(
          "unknown option {other}"
        )));
      }
    }
  }
  opts.keep_linear = dump_linear.is_some();
  let t0 = Instant::now();
  let neg = Negative::open(input)?;
  let t1 = Instant::now();
  let out = develop(&neg, &settings, &opts)?;
  let t2 = Instant::now();
  encode::write(
    &out.image,
    Path::new(output),
    encode::Format::from_path(Path::new(output)),
  )?;
  eprintln!(
    "{}x{} decode {:?} develop {:?} encode {:?} (cct {:.0} K, exposure {:+.2} EV, luma NR {:.3})",
    out.image.width,
    out.image.height,
    t1 - t0,
    t2 - t1,
    t2.elapsed(),
    out.info.cct,
    out.info.exposure_ev,
    out.info.luma_nr
  );
  if let (Some(p), Some(l)) = (dump_linear, out.linear.as_ref()) {
    write_f32(l, &p)?;
  }
  if let Some(p) = dump_final {
    write_f32(&out.image, &p)?;
  }
  Ok(())
}
