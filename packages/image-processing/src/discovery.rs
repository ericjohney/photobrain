use napi_derive::napi;
use rayon::prelude::*;
use std::path::Path;
use walkdir::{DirEntry, WalkDir};

use crate::batch::is_supported_image;

/// Result of directory discovery
#[napi(object)]
pub struct DiscoveryResult {
	pub file_paths: Vec<String>,
	pub relative_paths: Vec<String>,
	pub total_count: u32,
}

/// Discover all supported image files in a directory (parallel)
#[napi]
pub fn discover_photos(directory: String) -> DiscoveryResult {
	let base_path = Path::new(&directory);

	// Use walkdir for fast directory traversal
	let entries: Vec<DirEntry> = WalkDir::new(&directory)
		.follow_links(true)
		.into_iter()
		.filter_entry(|e: &DirEntry| {
			// Skip hidden directories
			!e.file_name()
				.to_str()
				.map(|s: &str| s.starts_with('.'))
				.unwrap_or(false)
		})
		.filter_map(|e: Result<DirEntry, walkdir::Error>| e.ok())
		.filter(|e: &DirEntry| e.file_type().is_file())
		.collect();

	// Filter for supported images in parallel
	let results: Vec<(String, String)> = entries
		.par_iter()
		.filter_map(|entry: &DirEntry| {
			let path = entry.path();
			let path_str = path.to_string_lossy().to_string();

			if is_supported_image(path_str.clone()) {
				let relative = path
					.strip_prefix(base_path)
					.map(|p: &Path| p.to_string_lossy().to_string())
					.unwrap_or_else(|_| path_str.clone());
				Some((path_str, relative))
			} else {
				None
			}
		})
		.collect();

	let total_count = results.len() as u32;
	let (file_paths, relative_paths): (Vec<_>, Vec<_>) = results.into_iter().unzip();

	DiscoveryResult {
		file_paths,
		relative_paths,
		total_count,
	}
}
