use raw_develop::{DevelopSettings, Engine, Negative, Options, Prepared, prepare};
fn main() -> Result<(), Box<dyn std::error::Error>> {
  let args: Vec<_> = std::env::args().collect();
  let neg = Negative::open(&args[1])?;
  let opts = Options {
    engine: if args.iter().any(|a| a == "--adobe") {
      Engine::Adobe
    } else {
      Engine::Apple
    },
    ..Options::default()
  };
  let prepared = prepare(&neg, &DevelopSettings::default(), &opts)?.with_max_edge(2048)?;
  let bytes = prepared.clone().encode_smart_preview(&opts.cancel)?;
  std::fs::write(&args[2], &bytes)?;
  let portable = Prepared::decode_smart_preview(&bytes)?;
  for (exposure, tone) in [
    (0.0, [0; 5]),
    (1.25, [20, -30, 45, 15, -10]),
    (-0.7, [-20, 35, -40, -15, 20]),
  ] {
    let mut settings = DevelopSettings {
      exposure,
      ..DevelopSettings::default()
    };
    if opts.engine == Engine::Adobe {
      settings.adobe_tone = Some(raw_develop::settings::AdobeTone {
        contrast: tone[0],
        highlights: tone[1],
        shadows: tone[2],
        whites: tone[3],
        blacks: tone[4],
      });
    }
    let a = prepared.render(&settings, &opts)?.image;
    let b = portable.render(&settings, &opts)?.image;
    assert_eq!(a.data, b.data, "portable render changed");
  }
  eprintln!(
    "{} bytes; exact portable renders at {:?}",
    bytes.len(),
    portable.dimensions()
  );
  Ok(())
}
