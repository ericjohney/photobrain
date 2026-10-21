use raw_develop::cfa::{CfaPattern, Channel};
use raw_develop::dng::{DngInfo, GainTableMap};
use raw_develop::metadata::{Container, LensSource, RawMetadata, RawStorage};
use raw_develop::settings::{Crop, WhiteBalance};
use raw_develop::{Cancel, DevelopSettings, Error, Negative, Options, Quality, develop, prepare};

fn negative(container: Container) -> Negative {
  let (w, h) = (96, 72);
  let bayer = container != Container::Raf;
  let cfa = if bayer {
    CfaPattern::new(
      2,
      2,
      vec![Channel::Red, Channel::Green, Channel::Green, Channel::Blue],
    )
    .unwrap()
  } else {
    CfaPattern::xtrans_default()
  };
  Negative {
    meta: RawMetadata {
      container,
      make: if bayer { "SONY" } else { "FUJIFILM" }.into(),
      model: if bayer { "ILCE-7CR" } else { "X-E5" }.into(),
      raw_width: w,
      raw_height: h,
      crop_top: 0,
      crop_left: 0,
      crop_width: w,
      crop_height: h,
      bits_per_sample: 14,
      black_levels: vec![1024; if bayer { 4 } else { 36 }],
      white_level: Some(16383),
      as_shot_wb: [1.8, 1.0, 1.6],
      cfa,
      storage: RawStorage::Uncompressed {
        offset: 0,
        length: 0,
      },
      orientation: 6,
      iso: Some(3200),
      raw_exposure_bias: Some(-0.5),
      lens: LensSource::None,
      lens_model: None,
      focal_length: None,
    },
    mosaic: (0..w * h)
      .map(|i| 2000 + ((i * 37 + i / w * 11) % 13000) as u16)
      .collect(),
    dng: (container == Container::Dng).then(|| {
      let identity = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
      (
        DngInfo {
          color_matrix_1: identity,
          color_matrix_2: identity,
          calibration_illuminant_1: 17,
          calibration_illuminant_2: 21,
          analog_balance: [1.0; 3],
          as_shot_neutral: [0.5, 1.0, 0.7],
          baseline_exposure: 1.25,
          linearization: vec![],
          samples_per_pixel: 3,
          tone_curve: vec![(0.0, 0.0), (0.25, 0.45), (1.0, 1.0)],
          gain_table_map: Some(GainTableMap {
            points_v: 2,
            points_h: 2,
            spacing_v: 1.0,
            spacing_h: 1.0,
            origin_v: 0.0,
            origin_h: 0.0,
            points_n: 3,
            weights: [0.3, 0.3, 0.3, 0.0, 0.1],
            gamma: 1.0,
            table: (0..12).map(|i| 0.9 + i as f32 / 30.0).collect(),
          }),
          jxl: false,
        },
        (0..w * h * 3)
          .map(|i| (i * 17 % 500) as f32 / 400.0 - 0.01)
          .collect(),
      )
    }),
  }
}

fn bits(data: &[f32]) -> Vec<u32> {
  data.iter().map(|v| v.to_bits()).collect()
}

#[test]
fn repeated_edits_match_one_shot_for_all_formats_and_qualities() {
  for container in [Container::Raf, Container::Arw, Container::Dng] {
    for quality in [Quality::Full, Quality::Preview] {
      let neg = negative(container);
      let opts = Options {
        quality,
        keep_linear: true,
        ..Options::default()
      };
      // Nonzero exposure at prepare time must not become baked into the cache.
      let mut settings = DevelopSettings {
        exposure: 0.75,
        ..DevelopSettings::default()
      };
      let prepared = prepare(&neg, &settings, &opts).unwrap();
      let original = prepared.render(&settings, &opts).unwrap();
      for exposure in [-1.0, 0.0, 1.5, 0.75] {
        settings.exposure = exposure;
        settings.tone_amount = 0.65;
        settings.crop = Some(Crop {
          x: 0.1,
          y: 0.2,
          width: 0.8,
          height: 0.7,
        });
        settings.quarter_turns = 1;
        let repeated = prepared.render(&settings, &opts).unwrap();
        let direct = develop(&neg, &settings, &opts).unwrap();
        assert_eq!(
          (repeated.image.width, repeated.image.height),
          (direct.image.width, direct.image.height)
        );
        assert_eq!(
          bits(&repeated.image.data),
          bits(&direct.image.data),
          "{container:?} {quality:?} {exposure}"
        );
        assert_eq!(
          bits(&repeated.linear.unwrap().data),
          bits(&direct.linear.unwrap().data)
        );
        assert_eq!(repeated.info.exposure_ev, direct.info.exposure_ev);
        assert_eq!(repeated.info.neutral, direct.info.neutral);
        assert_eq!(repeated.info.cct, direct.info.cct);
        assert_eq!(repeated.info.luma_nr, direct.info.luma_nr);
      }
      settings = DevelopSettings {
        exposure: 0.75,
        ..DevelopSettings::default()
      };
      assert_eq!(
        bits(&original.image.data),
        bits(&prepared.render(&settings, &opts).unwrap().image.data)
      );
      // The prepared image owns everything needed after the decoded file is dropped.
      drop(neg);
      assert_eq!(
        bits(&original.image.data),
        bits(&prepared.render(&settings, &opts).unwrap().image.data)
      );
    }
  }
}

#[test]
fn preparation_changes_are_rejected_and_can_be_prepared_again() {
  let neg = negative(Container::Raf);
  let settings = DevelopSettings::default();
  let opts = Options::default();
  let prepared = prepare(&neg, &settings, &opts).unwrap();
  let mut edits = Vec::new();
  let mut s = settings.clone();
  s.white_balance = WhiteBalance::Temperature {
    kelvin: 5200.0,
    tint: 8.0,
  };
  edits.push(s);
  let mut s = settings.clone();
  s.highlight_recovery = false;
  edits.push(s);
  let mut s = settings.clone();
  s.luma_noise_reduction = Some(0.1);
  edits.push(s);
  let mut s = settings.clone();
  s.chroma_noise_reduction = 0.25;
  edits.push(s);
  let mut s = settings.clone();
  s.sharpening = 0.0;
  edits.push(s);
  let mut s = settings.clone();
  s.lens.distortion = false;
  edits.push(s);
  for edited in edits {
    assert!(matches!(
      prepared.render(&edited, &opts),
      Err(Error::Settings(_))
    ));
    let fresh = prepare(&neg, &edited, &opts).unwrap();
    assert!(fresh.render(&edited, &opts).is_ok());
  }
  assert!(matches!(
    prepared.render(
      &settings,
      &Options {
        quality: Quality::Preview,
        ..Options::default()
      }
    ),
    Err(Error::Settings(_))
  ));
}

#[test]
fn invalid_and_cancelled_renders_do_not_poison_the_cache() {
  let neg = negative(Container::Arw);
  let settings = DevelopSettings::default();
  let opts = Options {
    quality: Quality::Preview,
    ..Options::default()
  };
  let prepared = prepare(&neg, &settings, &opts).unwrap();
  let cancel = Cancel::new();
  cancel.cancel();
  let cancelled = Options { cancel, ..opts };
  assert!(matches!(
    prepare(&neg, &settings, &cancelled),
    Err(Error::Cancelled)
  ));
  assert!(matches!(
    prepared.render(&settings, &cancelled),
    Err(Error::Cancelled)
  ));
  let opts = Options {
    quality: Quality::Preview,
    ..Options::default()
  };
  let bad = DevelopSettings {
    exposure: f64::NAN,
    ..settings.clone()
  };
  assert!(matches!(
    prepared.render(&bad, &opts),
    Err(Error::Settings(_))
  ));
  assert!(prepared.render(&settings, &opts).is_ok());
}

#[test]
fn screen_previews_are_bounded_and_support_tiny_edge_crops() {
  for container in [Container::Raf, Container::Arw, Container::Dng] {
    let settings = DevelopSettings::default();
    let opts = Options {
      quality: Quality::Preview,
      ..Options::default()
    };
    assert!(
      prepare(&negative(container), &settings, &opts)
        .unwrap()
        .with_max_edge(0)
        .is_err()
    );
    let prepared = prepare(&negative(container), &settings, &opts)
      .unwrap()
      .with_max_edge(17)
      .unwrap();
    let (w, h) = prepared.dimensions();
    assert_eq!(w.max(h), 17);
    assert_eq!(prepared.pixel_bytes(), w * h * 3 * 4);
    let rendered = prepared.render(&settings, &opts).unwrap();
    assert!(rendered.image.data.iter().all(|v| v.is_finite()));
    assert_eq!((rendered.image.width, rendered.image.height), (h, w));
    let settings = DevelopSettings {
      crop: Some(Crop {
        x: 0.999,
        y: 0.999,
        width: 0.001,
        height: 0.001,
      }),
      ..settings
    };
    let rendered = prepared.render(&settings, &opts).unwrap();
    assert_eq!((rendered.image.width, rendered.image.height), (1, 1));
  }
}

#[test]
fn proraw_still_rejects_custom_white_balance() {
  let settings = DevelopSettings {
    white_balance: WhiteBalance::Temperature {
      kelvin: 5200.0,
      tint: 0.0,
    },
    ..DevelopSettings::default()
  };
  assert!(matches!(
    prepare(&negative(Container::Dng), &settings, &Options::default()),
    Err(Error::Unsupported(_))
  ));
}
