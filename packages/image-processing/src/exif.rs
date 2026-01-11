use napi_derive::napi;
use std::process::Command;

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

/// Internal function to extract EXIF data using exiftool
pub fn extract_exif_internal(file_path: &str) -> Option<ExifData> {
	// Run exiftool with specific tags we need
	// Using -n for numeric values, -s3 for bare tag values
	let output = Command::new("exiftool")
		.args([
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
			"-n", // Numeric output for GPS, orientation, etc.
			file_path,
		])
		.output()
		.ok()?;

	if !output.status.success() {
		return None;
	}

	let json_str = String::from_utf8_lossy(&output.stdout);

	// Parse JSON array (exiftool returns an array with one object)
	let json: serde_json::Value = serde_json::from_str(&json_str).ok()?;
	let obj = json.as_array()?.first()?.as_object()?;

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

	let get_u32 = |key: &str| -> Option<u32> {
		obj.get(key).and_then(|v| v.as_u64()).map(|n| n as u32)
	};

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

/// Extract EXIF data from an image file
/// Returns None if the file has no EXIF data or cannot be read
#[napi]
pub fn extract_exif(file_path: String) -> Option<ExifData> {
	extract_exif_internal(&file_path)
}
