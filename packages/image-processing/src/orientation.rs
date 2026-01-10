use image::DynamicImage;

/// Apply EXIF orientation to an image
/// Orientation values follow EXIF specification:
/// 1 = Normal (no transformation needed)
/// 2 = Flip horizontal
/// 3 = Rotate 180
/// 4 = Flip vertical
/// 5 = Rotate 270 CW + flip horizontal
/// 6 = Rotate 90 CW
/// 7 = Rotate 90 CW + flip horizontal
/// 8 = Rotate 270 CW
pub fn apply_orientation(img: DynamicImage, orientation: Option<u32>) -> DynamicImage {
	match orientation {
		Some(2) => img.fliph(),
		Some(3) => img.rotate180(),
		Some(4) => img.flipv(),
		Some(5) => img.rotate270().fliph(),
		Some(6) => img.rotate90(),
		Some(7) => img.rotate90().fliph(),
		Some(8) => img.rotate270(),
		_ => img,
	}
}
