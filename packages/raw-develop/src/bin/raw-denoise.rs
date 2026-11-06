//! Inspect or execute a caller-supplied denoise model on a prepared tensor.
use raw_develop::{
  Cancel, Negative,
  adobe::denoise::{
    Backend, DecodedMosaic, Model, MosaicTilePlan, Tensor, Variant, border::TileTraversal,
    partial::predict_partial_raw_tiles, tiles::Rect,
  },
};
use sha2::{Digest, Sha256};
use std::{
  ffi::OsString,
  path::{Path, PathBuf},
  process::ExitCode,
  time::Instant,
};

fn main() -> ExitCode {
  match run() {
    Ok(()) => ExitCode::SUCCESS,
    Err(e) => {
      eprintln!("{e}");
      ExitCode::FAILURE
    }
  }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
  let mut args = std::env::args_os().skip(1);
  let command = args
    .next()
    .ok_or("usage: raw-denoise info MODEL | predict MODEL INPUT OUTPUT [--trace DIR] | raw-tiles MODEL RAW NEW_DIR [--rect top,left,bottom,right] [--dump-input] [--amount 1..100] [--details MODEL] | render-tiles EXPORT_DIR RAW OUTPUT.png --no-post-nr [--adobe-profiles DIR] [--settings JSON]")?;
  if command == "render-tiles" {
    return render_tiles(args);
  }
  let model_path = args.next().ok_or("missing model path")?;
  let backend = if command == "info" || command == "onnx" {
    Backend::Cpu
  } else {
    Backend::from_env()?
  };
  let model = Model::load_with_backend(model_path, backend)?;
  #[cfg(feature = "adobe-denoise-cuda")]
  if command == "onnx" {
    let path = args.next().ok_or("missing ONNX output path")?;
    if args.next().is_some() {
      return Err("unexpected argument".into());
    }
    use std::io::Write;
    std::fs::OpenOptions::new()
      .write(true)
      .create_new(true)
      .open(path)?
      .write_all(&model.to_onnx())?;
    return Ok(());
  }
  if command == "info" {
    if args.next().is_some() {
      return Err("unexpected argument".into());
    }
    println!("{}", serde_json::to_string_pretty(&model.info())?);
    return Ok(());
  }
  if command == "raw-tiles" {
    return raw_tiles(&model, args);
  }
  if command != "predict" {
    return Err("expected info, predict, raw-tiles or render-tiles".into());
  }
  let input_path = args.next().ok_or("missing input tensor")?;
  let output_path = args.next().ok_or("missing output tensor")?;
  let trace = match args.next() {
    None => None,
    Some(flag) if flag == "--trace" => {
      Some(PathBuf::from(args.next().ok_or("missing trace directory")?))
    }
    _ => return Err("unexpected argument".into()),
  };
  if args.next().is_some() {
    return Err("unexpected argument".into());
  }
  if let Some(dir) = &trace {
    std::fs::create_dir_all(dir)?;
  }
  let input = Tensor::read(input_path)?;
  let start = Instant::now();
  let output = if let Some(dir) = trace {
    // Full-resolution traces can occupy many GiB; explicitly requested only.
    model.predict_observed(
      &input,
      &Cancel::never(),
      |_, _| true,
      |i, _, tensor| tensor.write(dir.join(format!("{i:03}.f32"))),
    )?
  } else {
    model.predict(&input, &Cancel::never())?
  };
  let seconds = start.elapsed().as_secs_f64();
  output.write(output_path)?;
  println!(
    "{}",
    serde_json::json!({"model":model.info(),"seconds":seconds,"output_shape":output.shape()})
  );
  Ok(())
}

/// Experimental display render of a complete, source-matched raw-tiles export.
fn render_tiles(
  mut args: impl Iterator<Item = OsString>,
) -> Result<(), Box<dyn std::error::Error>> {
  use raw_develop::{
    DevelopSettings, Engine, Options, Quality, encode, image::RgbImage,
    settings::AdobeNoiseReduction,
  };
  let directory = PathBuf::from(
    args
      .next()
      .ok_or("missing complete tile export directory")?,
  );
  let raw = PathBuf::from(args.next().ok_or("missing original RAW")?);
  let destination = PathBuf::from(args.next().ok_or("missing output PNG")?);
  let mut profiles = None;
  let mut settings_path = None;
  let mut no_post_nr = false;
  while let Some(flag) = args.next() {
    if flag == "--adobe-profiles" && profiles.is_none() {
      profiles = Some(PathBuf::from(
        args.next().ok_or("missing Adobe profile directory")?,
      ));
    } else if flag == "--settings" && settings_path.is_none() {
      settings_path = Some(PathBuf::from(args.next().ok_or("missing settings JSON")?));
    } else if flag == "--no-post-nr" && !no_post_nr {
      no_post_nr = true;
    } else {
      return Err("unexpected or duplicate render-tiles option".into());
    }
  }
  if !no_post_nr {
    return Err("experimental render-tiles requires --no-post-nr; native post-AI conventional NR defaults are not yet established".into());
  }
  if destination.exists() {
    return Err("render output must be a new file".into());
  }
  if destination
    .extension()
    .and_then(|s| s.to_str())
    .is_none_or(|s| !s.eq_ignore_ascii_case("png"))
  {
    return Err("render output must have .png extension".into());
  }
  let settings = if let Some(path) = settings_path {
    serde_json::from_slice::<DevelopSettings>(&std::fs::read(path)?)?
  } else {
    DevelopSettings {
      adobe_noise_reduction: Some(AdobeNoiseReduction {
        color: 0,
        luminance: 0,
        ..Default::default()
      }),
      ..Default::default()
    }
  };
  settings.validate()?;
  if !settings
    .adobe_noise_reduction
    .as_ref()
    .is_some_and(|n| n.color == 0 && n.luminance == 0)
  {
    return Err(
      "render settings must explicitly set adobe_noise_reduction color and luminance to zero"
        .into(),
    );
  }
  let start = Instant::now();
  let bytes = std::fs::read(&raw)?;
  let source_sha256 = format!("{:x}", Sha256::digest(&bytes));
  let negative = Negative::from_bytes(&bytes)?;
  drop(bytes);
  let manifest: serde_json::Value =
    serde_json::from_slice(&std::fs::read(directory.join("manifest.json"))?)?;
  let mosaic = DecodedMosaic::new(&negative)?;
  let bounds = mosaic.bounds();
  let strength = manifest["strength"]
    .as_u64()
    .ok_or("missing export strength")?;
  if manifest["format_version"] != 1
    || manifest["complete"] != true
    || manifest["source_sha256"] != source_sha256
    || !(1..=100).contains(&strength)
    || manifest["image_bounds"] != serde_json::json!(bounds.as_array())
    || manifest["active_crop"] != serde_json::json!(mosaic.active_crop().as_array())
    || manifest["camera"] != negative.meta.model
    || manifest["preserved_black"].as_f64() != Some(mosaic.preserved_black())
    || manifest["model"]["variant"] != serde_json::to_value(mosaic.variant())?
  {
    return Err("export is incomplete or does not match this RAW calibration".into());
  }
  let rectangles: Vec<_> = TileTraversal::new(mosaic.variant(), bounds).collect();
  let records = manifest["tiles"].as_array().ok_or("missing export tiles")?;
  if records.len() != rectangles.len()
    || manifest["tiles_expected"].as_u64() != Some(records.len() as u64)
  {
    return Err("render-tiles requires a complete full-image export".into());
  }
  let [height, width] = bounds.size();
  let mut image = RgbImage {
    width,
    height,
    data: vec![0.0; 3 * height * width],
  };
  for (index, (record, rect)) in records.iter().zip(&rectangles).enumerate() {
    let file = format!("tile-{index:04}.f32");
    if record["file"] != file || record["rect"] != serde_json::json!(rect.as_array()) {
      return Err("export tiles do not cover the original full-image grid in order".into());
    }
    let tensor = Tensor::read(directory.join(file))?;
    let [h, w] = rect.size();
    if tensor.shape() != [3, h, w] || record["shape"] != serde_json::json!([3, h, w]) {
      return Err("export tensor geometry mismatch".into());
    }
    for y in 0..h {
      for x in 0..w {
        for c in 0..3 {
          let row = (rect.top() - bounds.top()) as usize + y;
          let col = (rect.left() - bounds.left()) as usize + x;
          image.data[(row * width + col) * 3 + c] = tensor.data()[(c * h + y) * w + x];
        }
      }
    }
  }
  drop(mosaic);
  let options = Options {
    engine: Engine::Adobe,
    quality: Quality::Full,
    adobe_profile_dir: profiles,
    ..Default::default()
  };
  let prepared =
    raw_develop::adobe::denoise::render::prepare_camera_rgb(&negative, image, &settings, &options)?;
  let developed = prepared.render(&settings, &options)?;
  encode::write(&developed.image, &destination, encode::Format::Png16)?;
  println!(
    "{}",
    serde_json::json!({"output":destination,"width":developed.image.width,"height":developed.image.height,"strength":strength,"source_sha256":source_sha256,"post_noise_reduction":"explicitly disabled","native_final_render_parity":false,"seconds":start.elapsed().as_secs_f64()})
  );
  Ok(())
}

fn write_manifest(directory: &Path, manifest: &serde_json::Value) -> std::io::Result<()> {
  let temporary = directory.join("manifest.json.tmp");
  std::fs::write(
    &temporary,
    serde_json::to_vec_pretty(manifest).map_err(std::io::Error::other)?,
  )?;
  std::fs::rename(temporary, directory.join("manifest.json"))?;
  Ok(())
}

fn raw_tiles(
  model: &Model,
  mut args: impl Iterator<Item = OsString>,
) -> Result<(), Box<dyn std::error::Error>> {
  let input = PathBuf::from(args.next().ok_or("missing RAW input")?);
  let output = PathBuf::from(args.next().ok_or("missing new output directory")?);
  let mut requested = None;
  let mut dump_input = false;
  let mut amount = None;
  let mut details_path = None;
  while let Some(flag) = args.next() {
    if flag == "--rect" && requested.is_none() {
      let value = args.next().ok_or("missing rectangle")?;
      let values: Vec<i32> = value
        .to_str()
        .ok_or("rectangle must be UTF-8")?
        .split(',')
        .map(str::parse)
        .collect::<Result<_, _>>()?;
      let [top, left, bottom, right]: [i32; 4] = values
        .try_into()
        .map_err(|_| "expected four rectangle coordinates")?;
      requested = Some(Rect::new(top, left, bottom, right)?);
    } else if flag == "--dump-input" && !dump_input {
      dump_input = true;
    } else if flag == "--amount" && amount.is_none() {
      amount = Some(
        args
          .next()
          .ok_or("missing amount")?
          .to_str()
          .ok_or("invalid amount")?
          .parse::<u32>()?,
      );
    } else if flag == "--details" && details_path.is_none() {
      details_path = Some(PathBuf::from(
        args.next().ok_or("missing Enhance Details model")?,
      ));
    } else {
      return Err("unexpected or duplicate raw-tiles option".into());
    }
  }
  let amount = amount.unwrap_or(100);
  if !(1..=100).contains(&amount) {
    return Err("amount must be 1..100".into());
  }
  if amount < 100 && dump_input {
    return Err("--dump-input currently requires amount 100".into());
  }
  let details = details_path
    .map(|p| Model::load_with_backend(p, Backend::from_env()?))
    .transpose()?;
  if details.is_some() && (amount == 100 || model.info().variant != Variant::Xtrans) {
    return Err("--details is only used for partial-strength X-Trans denoise".into());
  }
  if amount < 100
    && model.info().variant == Variant::Xtrans
    && !details
      .as_ref()
      .is_some_and(|m| m.info().variant == Variant::XtransDetails)
  {
    return Err("partial X-Trans denoise requires --details MODEL".into());
  }
  let start = Instant::now();
  let raw_bytes = std::fs::read(&input)?;
  let source_sha256 = format!("{:x}", Sha256::digest(&raw_bytes));
  let negative = Negative::from_bytes(&raw_bytes)?;
  drop(raw_bytes);
  let mosaic = DecodedMosaic::new(&negative)?;
  if model.info().variant != mosaic.variant() {
    return Err("model variant does not match decoded RAW mosaic".into());
  }
  if requested.is_some_and(|rect| !mosaic.bounds().contains(rect)) {
    return Err("rectangle exceeds canonical image bounds".into());
  }
  let rectangles: Vec<Rect> = if amount < 100 {
    TileTraversal::new(mosaic.variant(), mosaic.bounds())
      .filter_map(|tile| {
        let r = requested.unwrap_or(mosaic.bounds());
        Rect::new(
          tile.top().max(r.top()),
          tile.left().max(r.left()),
          tile.bottom().min(r.bottom()),
          tile.right().min(r.right()),
        )
        .ok()
      })
      .collect()
  } else {
    match requested {
      Some(rect) => {
        if !mosaic.bounds().contains(rect) {
          return Err("rectangle exceeds canonical image bounds".into());
        }
        MosaicTilePlan::new(mosaic.variant(), rect, mosaic.preserved_black())?;
        vec![rect]
      }
      None => TileTraversal::new(mosaic.variant(), mosaic.bounds()).collect(),
    }
  };
  if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
    std::fs::create_dir_all(parent)?;
  }
  // A fresh directory prevents replacing an earlier export or mixing its tiles.
  std::fs::create_dir(&output)?;
  let mut manifest = serde_json::json!({
    "format_version":1,"complete":false,"model":model.info(),
    "camera":negative.meta.model,"source":input,"source_sha256":source_sha256,
    "image_bounds":mosaic.bounds().as_array(),"active_crop":mosaic.active_crop().as_array(),
    "preserved_black":mosaic.preserved_black(),"strength":amount,
    "baseline_model":details.as_ref().map(Model::info),
    "output_space":if amount == 100 {"unblended preserved-black camera RGB; before lens and color rendering"} else {"partial-strength preserved-black camera RGB after u16 blend and inverse-gain commits; before lens and color rendering"},
    "tiles_expected":rectangles.len(),"tiles":[]
  });
  write_manifest(&output, &manifest)?;
  let cancel = Cancel::never();
  if amount < 100 {
    // The partial composer prepares its source once and retains bounded model
    // tiles. Release the preliminary adapter used to validate export metadata.
    drop(mosaic);
    let mut index = 0;
    predict_partial_raw_tiles(
      &negative,
      model,
      details.as_ref(),
      amount,
      requested,
      &cancel,
      |rect, result| {
        let file = format!("tile-{index:04}.f32");
        result.write(output.join(&file))?;
        let record = serde_json::json!({"file":file,"rect":rect.as_array(),"shape":result.shape()});
        manifest["tiles"]
          .as_array_mut()
          .unwrap()
          .push(record.clone());
        write_manifest(&output, &manifest)?;
        eprintln!("{record}");
        index += 1;
        Ok(())
      },
    )?;
  } else {
    for (index, rectangle) in rectangles.into_iter().enumerate() {
      let tile_start = Instant::now();
      let plan = MosaicTilePlan::new(mosaic.variant(), rectangle, mosaic.preserved_black())?;
      let source = mosaic.source_tile(rectangle, &cancel)?;
      let tensor = plan.prepare_input(plan.geometry().source, &source, &cancel)?;
      if dump_input {
        tensor.write(output.join(format!("tile-{index:04}.input.f32")))?;
      }
      let predicted = model.predict(&tensor, &cancel)?;
      let result = plan.finish_output(&predicted, &cancel)?;
      let file = format!("tile-{index:04}.f32");
      result.write(output.join(&file))?;
      let record = serde_json::json!({"file":file,"rect":rectangle.as_array(),"shape":result.shape(),"seconds":tile_start.elapsed().as_secs_f64()});
      manifest["tiles"]
        .as_array_mut()
        .unwrap()
        .push(record.clone());
      write_manifest(&output, &manifest)?;
      eprintln!("{}", record);
    }
  }
  manifest["complete"] = true.into();
  manifest["seconds"] = start.elapsed().as_secs_f64().into();
  write_manifest(&output, &manifest)?;
  println!(
    "{}",
    serde_json::json!({"directory":output,"tiles":manifest["tiles_expected"],"seconds":manifest["seconds"],"complete":true})
  );
  Ok(())
}
