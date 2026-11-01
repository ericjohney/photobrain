use raw_develop::{DevelopSettings, Negative, Options, Quality, develop};
use raw_develop_ffi::*;
use std::ffi::CString;
use std::ptr;

fn fixture() -> CString {
  CString::new(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../tests/fixtures/synthetic.ARW"
  ))
  .unwrap()
}

#[test]
fn c_pixels_match_rust_render_and_session_survives_repeated_edits() {
  unsafe {
    let mut error = PBRAWError {
      code: 0,
      message: ptr::null_mut(),
    };
    let cancel = pbraw_cancel_new();
    let session = pbraw_open(fixture().as_ptr(), cancel, &mut error);
    assert!(!session.is_null());
    let negative = Negative::open(fixture().to_str().unwrap()).unwrap();
    for exposure in [0.0, 1.0, -1.0, 0.0] {
      for refined in [0, 1] {
        let image = pbraw_render(session, exposure, refined, cancel, &mut error);
        assert!(!image.is_null());
        let direct = develop(
          &negative,
          &DevelopSettings {
            exposure,
            ..DevelopSettings::default()
          },
          &Options {
            quality: Quality::Preview,
            ..Options::default()
          },
        )
        .unwrap()
        .image;
        assert_eq!(
          (pbraw_image_width(image), pbraw_image_height(image)),
          (direct.width, direct.height)
        );
        // The fixture is smaller than either limit; both use the same pixels.
        let expected: Vec<u8> = direct
          .data
          .as_chunks::<3>()
          .0
          .iter()
          .flat_map(|p| {
            [
              (p[0] * 255.0).round() as u8,
              (p[1] * 255.0).round() as u8,
              (p[2] * 255.0).round() as u8,
              255,
            ]
          })
          .collect();
        let pixels = std::slice::from_raw_parts(pbraw_image_pixels(image), pbraw_image_len(image));
        assert_eq!(pixels, expected);
        pbraw_image_free(image);
      }
    }
    assert!(pbraw_render(session, f64::NAN, 0, cancel, &mut error).is_null());
    assert_eq!(error.code, 3);
    pbraw_error_clear(&mut error);
    pbraw_cancel_request(cancel);
    assert!(pbraw_render(session, 0.0, 0, cancel, &mut error).is_null());
    assert_eq!(error.code, 4);
    pbraw_error_clear(&mut error);
    pbraw_session_free(session);
    assert!(pbraw_open(fixture().as_ptr(), cancel, &mut error).is_null());
    assert_eq!(error.code, 4);
    pbraw_error_clear(&mut error);
    pbraw_cancel_free(cancel);
  }
}

#[test]
fn null_inputs_and_invalid_files_report_owned_errors() {
  unsafe {
    let mut error = PBRAWError {
      code: 0,
      message: ptr::null_mut(),
    };
    assert!(pbraw_open(ptr::null(), ptr::null(), &mut error).is_null());
    assert_eq!(error.code, 3);
    assert!(!error.message.is_null());
    pbraw_error_clear(&mut error);
    assert_eq!(error.code, 0);
    assert!(error.message.is_null());
    let missing = CString::new("/no-such-raw-file").unwrap();
    assert!(pbraw_open(missing.as_ptr(), ptr::null(), &mut error).is_null());
    assert_eq!(error.code, 1);
    pbraw_error_clear(&mut error);
    assert!(pbraw_render(ptr::null(), 0.0, 1, ptr::null(), &mut error).is_null());
    assert_eq!(error.code, 3);
    pbraw_error_clear(&mut error);
    pbraw_image_free(ptr::null_mut());
    pbraw_session_free(ptr::null_mut());
    pbraw_cancel_free(ptr::null_mut());
  }
}

#[test]
fn portable_session_matches_native_pixels_and_owns_its_download() {
  let negative = Negative::open(fixture().to_str().unwrap()).unwrap();
  let opts = Options::default();
  let prepared = raw_develop::prepare(&negative, &DevelopSettings::default(), &opts).unwrap();
  let bytes = prepared
    .clone()
    .encode_smart_preview(&raw_develop::Cancel::never())
    .unwrap();
  unsafe {
    let mut error = PBRAWError {
      code: 0,
      message: ptr::null_mut(),
    };
    let session = pbraw_open_smart_preview(bytes.as_ptr(), bytes.len(), ptr::null(), &mut error);
    assert!(!session.is_null());
    drop(bytes);
    for exposure in [0.0, 1.25, -1.5, 0.0] {
      let image = pbraw_render_basic(session, exposure, 0, 0, 0, 0, 0, 1, ptr::null(), &mut error);
      assert!(!image.is_null());
      let direct = prepared
        .render(
          &DevelopSettings {
            exposure,
            ..Default::default()
          },
          &opts,
        )
        .unwrap()
        .image;
      let expected: Vec<u8> = direct
        .data
        .chunks_exact(3)
        .flat_map(|p| {
          [
            (p[0].clamp(0.0, 1.0) * 255.0).round() as u8,
            (p[1].clamp(0.0, 1.0) * 255.0).round() as u8,
            (p[2].clamp(0.0, 1.0) * 255.0).round() as u8,
            255,
          ]
        })
        .collect();
      assert_eq!(
        std::slice::from_raw_parts(pbraw_image_pixels(image), pbraw_image_len(image)),
        expected
      );
      pbraw_image_free(image);
    }
    assert!(
      pbraw_render_basic(session, 0.0, 101, 0, 0, 0, 0, 1, ptr::null(), &mut error).is_null()
    );
    pbraw_error_clear(&mut error);
    pbraw_session_free(session);
    assert!(pbraw_open_smart_preview(b"bad".as_ptr(), 3, ptr::null(), &mut error).is_null());
    pbraw_error_clear(&mut error);
  }
}
