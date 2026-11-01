use raw_develop::{Cancel, DevelopSettings, Negative, Options, Prepared, prepare};

#[test]
fn portable_state_replays_exactly_and_rejects_corrupt_or_incompatible_downloads() {
  let neg = Negative::open(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/synthetic.ARW"
  ))
  .unwrap();
  let opts = Options::default();
  let original = prepare(&neg, &DevelopSettings::default(), &opts).unwrap();
  let bytes = original
    .clone()
    .encode_smart_preview(&Cancel::never())
    .unwrap();
  let portable = Prepared::decode_smart_preview(&bytes).unwrap();
  for exposure in [0.0, -2.0, 1.25, 0.0] {
    let settings = DevelopSettings {
      exposure,
      ..Default::default()
    };
    assert_eq!(
      original.render(&settings, &opts).unwrap().image.data,
      portable.render(&settings, &opts).unwrap().image.data
    );
  }
  for n in [0, 4, 19, 20, bytes.len() / 2, bytes.len() - 1] {
    assert!(Prepared::decode_smart_preview(&bytes[..n]).is_err());
  }
  for offset in [0, 4, 8, 12, bytes.len() - 1] {
    let mut bad = bytes.clone();
    bad[offset] ^= 255;
    assert!(Prepared::decode_smart_preview(&bad).is_err());
  }
  let mut bad = bytes;
  bad.push(0);
  assert!(Prepared::decode_smart_preview(&bad).is_err());
  let cancel = Cancel::new();
  cancel.cancel();
  assert!(original.encode_smart_preview(&cancel).is_err());
}
