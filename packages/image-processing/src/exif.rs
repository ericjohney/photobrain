use exif::{In, Reader, Tag, Value};
use napi_derive::napi;
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

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
  pub aperture: Option<String>,       // e.g., "f/2.8"
  pub shutter_speed: Option<String>,  // e.g., "1/250"
  pub exposure_bias: Option<String>,  // e.g., "+0.3 EV"

  // DateTime
  pub date_taken: Option<String>, // ISO 8601 format

  // GPS coordinates
  pub gps_latitude: Option<f64>,
  pub gps_longitude: Option<f64>,
  pub gps_altitude: Option<f64>,

  // Orientation (1-8, EXIF standard)
  pub orientation: Option<u32>,
}

/// Extract EXIF data from an image file
/// Returns None if the file has no EXIF data or cannot be read
#[napi]
pub fn extract_exif(file_path: String) -> Option<ExifData> {
  let path = Path::new(&file_path);

  // Open file and create EXIF reader
  let file = File::open(path).ok()?;
  let mut bufreader = BufReader::new(file);
  let exif_reader = Reader::new().read_from_container(&mut bufreader).ok()?;

  // Helper function to get string field
  let get_string = |tag: Tag| -> Option<String> {
    exif_reader
      .get_field(tag, In::PRIMARY)
      .and_then(|field| field.display_value().to_string().into())
  };

  // Helper function to get rational as decimal
  let get_rational_decimal = |tag: Tag| -> Option<f64> {
    exif_reader.get_field(tag, In::PRIMARY).and_then(|field| {
      if let Value::Rational(ref rationals) = field.value {
        if let Some(rational) = rationals.first() {
          return Some(rational.num as f64 / rational.denom as f64);
        }
      }
      None
    })
  };

  // Helper function to get unsigned integer
  let get_uint = |tag: Tag| -> Option<u32> {
    exif_reader.get_field(tag, In::PRIMARY).and_then(|field| {
      match &field.value {
        Value::Short(shorts) => shorts.first().map(|&v| v as u32),
        Value::Long(longs) => longs.first().copied(),
        _ => None,
      }
    })
  };

  // Extract camera make and model
  let camera_make = get_string(Tag::Make);
  let camera_model = get_string(Tag::Model);

  // Extract lens information
  let lens_make = get_string(Tag::LensMake);
  let lens_model = get_string(Tag::LensModel);

  // Focal length (convert from rational to mm)
  let focal_length = get_rational_decimal(Tag::FocalLength).map(|f| f as u32);

  // ISO speed
  let iso = get_uint(Tag::PhotographicSensitivity);

  // Aperture (F-number)
  let aperture = get_rational_decimal(Tag::FNumber).map(|f| format!("f/{:.1}", f));

  // Shutter speed (exposure time)
  let shutter_speed = get_rational_decimal(Tag::ExposureTime).map(|exposure| {
    if exposure >= 1.0 {
      format!("{:.1}s", exposure)
    } else {
      // Convert to fraction (e.g., 1/250)
      let denominator = (1.0 / exposure).round() as u32;
      format!("1/{}", denominator)
    }
  });

  // Exposure bias
  let exposure_bias = get_rational_decimal(Tag::ExposureBiasValue).map(|bias| {
    if bias > 0.0 {
      format!("+{:.1} EV", bias)
    } else if bias < 0.0 {
      format!("{:.1} EV", bias)
    } else {
      "0 EV".to_string()
    }
  });

  // Date taken (DateTimeOriginal)
  let date_taken = get_string(Tag::DateTimeOriginal);

  // GPS coordinates
  let gps_latitude = extract_gps_coordinate(&exif_reader, Tag::GPSLatitude, Tag::GPSLatitudeRef);
  let gps_longitude = extract_gps_coordinate(&exif_reader, Tag::GPSLongitude, Tag::GPSLongitudeRef);
  let gps_altitude = get_rational_decimal(Tag::GPSAltitude);

  // Orientation (1-8)
  let orientation = get_uint(Tag::Orientation);

  Some(ExifData {
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
  })
}

/// Helper function to extract GPS coordinates from degrees, minutes, seconds
fn extract_gps_coordinate(
  reader: &exif::Exif,
  coord_tag: Tag,
  ref_tag: Tag,
) -> Option<f64> {
  // Get the coordinate values (degrees, minutes, seconds)
  let coord_field = reader.get_field(coord_tag, In::PRIMARY)?;
  let ref_field = reader.get_field(ref_tag, In::PRIMARY)?;

  // Extract degrees, minutes, seconds
  if let Value::Rational(ref rationals) = coord_field.value {
    if rationals.len() >= 3 {
      let degrees = rationals[0].num as f64 / rationals[0].denom as f64;
      let minutes = rationals[1].num as f64 / rationals[1].denom as f64;
      let seconds = rationals[2].num as f64 / rationals[2].denom as f64;

      // Convert to decimal degrees
      let mut decimal = degrees + (minutes / 60.0) + (seconds / 3600.0);

      // Apply direction (N/S for latitude, E/W for longitude)
      if let Value::Ascii(ref ascii_vec) = ref_field.value {
        if let Some(direction) = ascii_vec.first() {
          let dir_str = String::from_utf8_lossy(direction);
          if dir_str == "S" || dir_str == "W" {
            decimal = -decimal;
          }
        }
      }

      return Some(decimal);
    }
  }

  None
}
