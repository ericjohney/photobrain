use fastembed::{
	EmbeddingModel, ImageEmbedding, ImageEmbeddingModel, ImageInitOptions, InitOptions,
	TextEmbedding,
};
use image::DynamicImage;
use napi_derive::napi;
use once_cell::sync::OnceCell;
use std::path::PathBuf;
use std::sync::Mutex;

/// Global cached CLIP image model - loaded once, reused for all embeddings
static CLIP_IMAGE_MODEL: OnceCell<Mutex<ImageEmbedding>> = OnceCell::new();

/// Global cached CLIP text model - loaded once, reused for all embeddings
static CLIP_TEXT_MODEL: OnceCell<Mutex<TextEmbedding>> = OnceCell::new();

/// Get the cache directory for fastembed models from environment variable
fn get_cache_dir() -> Option<PathBuf> {
	std::env::var("FASTEMBED_CACHE_DIR")
		.ok()
		.map(PathBuf::from)
}

fn get_clip_image_model() -> Result<&'static Mutex<ImageEmbedding>, String> {
	CLIP_IMAGE_MODEL.get_or_try_init(|| {
		let mut options = ImageInitOptions::new(ImageEmbeddingModel::ClipVitB32)
			.with_show_download_progress(true);

		if let Some(cache_dir) = get_cache_dir() {
			options = options.with_cache_dir(cache_dir);
		}

		let model = ImageEmbedding::try_new(options)
			.map_err(|e| format!("Failed to initialize CLIP image model: {}", e))?;
		Ok(Mutex::new(model))
	})
}

fn get_clip_text_model() -> Result<&'static Mutex<TextEmbedding>, String> {
	CLIP_TEXT_MODEL.get_or_try_init(|| {
		let mut options = InitOptions::new(EmbeddingModel::ClipVitB32)
			.with_show_download_progress(true);

		if let Some(cache_dir) = get_cache_dir() {
			options = options.with_cache_dir(cache_dir);
		}

		let model = TextEmbedding::try_new(options)
			.map_err(|e| format!("Failed to initialize CLIP text model: {}", e))?;
		Ok(Mutex::new(model))
	})
}

#[napi]
pub fn clip_text_embedding(text: String) -> napi::Result<Vec<f64>> {
	let model_mutex = get_clip_text_model()
		.map_err(|e| napi::Error::from_reason(e))?;

	let model = model_mutex
		.lock()
		.map_err(|e| napi::Error::from_reason(format!("Failed to lock text model: {}", e)))?;

	let embeddings = model
		.embed(vec![text], None)
		.map_err(|e| napi::Error::from_reason(format!("Failed to generate text embedding: {}", e)))?;

	let embedding = embeddings
		.first()
		.ok_or_else(|| napi::Error::from_reason("No embedding generated"))?;

	// Convert f32 to f64 for JavaScript compatibility
	Ok(embedding.iter().map(|&f| f as f64).collect())
}

// Note: Single-image embedding functions removed as batch processing is now used exclusively.

/// Batch generate CLIP embeddings from multiple image file paths
/// Processes multiple images in a single model inference call for efficiency
/// Returns a Vec with the same length as input - None for failed images
#[napi]
pub fn batch_generate_clip_embeddings(file_paths: Vec<String>) -> Vec<Option<Vec<f64>>> {
	if file_paths.is_empty() {
		return vec![];
	}

	// Load all images, tracking which ones failed
	let mut images: Vec<DynamicImage> = Vec::with_capacity(file_paths.len());
	let mut valid_indices: Vec<usize> = Vec::with_capacity(file_paths.len());

	for (i, path) in file_paths.iter().enumerate() {
		match image::open(path) {
			Ok(img) => {
				images.push(img);
				valid_indices.push(i);
			}
			Err(e) => {
				eprintln!("Failed to load image {}: {}", path, e);
			}
		}
	}

	if images.is_empty() {
		return vec![None; file_paths.len()];
	}

	// Get the model
	let model_mutex = match get_clip_image_model() {
		Ok(m) => m,
		Err(e) => {
			eprintln!("CLIP image model error: {}", e);
			return vec![None; file_paths.len()];
		}
	};

	let model = match model_mutex.lock() {
		Ok(m) => m,
		Err(e) => {
			eprintln!("CLIP model lock error: {}", e);
			return vec![None; file_paths.len()];
		}
	};

	// Batch embed all images at once
	let embeddings = match model.embed_images(images) {
		Ok(embs) => embs,
		Err(e) => {
			eprintln!("CLIP batch embed error: {}", e);
			return vec![None; file_paths.len()];
		}
	};

	// Build result array with embeddings in correct positions
	let mut results: Vec<Option<Vec<f64>>> = vec![None; file_paths.len()];
	for (emb_idx, &orig_idx) in valid_indices.iter().enumerate() {
		if let Some(embedding) = embeddings.get(emb_idx) {
			results[orig_idx] = Some(embedding.iter().map(|&f| f as f64).collect());
		}
	}

	results
}
