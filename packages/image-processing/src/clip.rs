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

/// Generate CLIP embedding from a DynamicImage
/// Takes ownership of the image to avoid cloning large raw image data
pub fn generate_clip_embedding_from_image(img: DynamicImage) -> Option<Vec<f32>> {
	let model_mutex = match get_clip_image_model() {
		Ok(m) => m,
		Err(e) => {
			eprintln!("CLIP image model error: {}", e);
			return None;
		}
	};

	let model = match model_mutex.lock() {
		Ok(m) => m,
		Err(e) => {
			eprintln!("CLIP model lock error: {}", e);
			return None;
		}
	};

	match model.embed_images(vec![img]) {
		Ok(embeddings) => embeddings.first().cloned(),
		Err(e) => {
			eprintln!("CLIP embed error: {}", e);
			None
		}
	}
}

/// Generate CLIP embedding from JPEG/image bytes
/// Used for RAW files where we already have the embedded preview as bytes
#[napi]
pub fn clip_embedding_from_bytes(image_bytes: napi::bindgen_prelude::Buffer) -> Option<Vec<f64>> {
	// Decode the image bytes
	let img = image::load_from_memory(&image_bytes).ok()?;

	// Generate CLIP embedding
	let embedding = generate_clip_embedding_from_image(img)?;

	// Convert f32 to f64 for JavaScript compatibility
	Some(embedding.iter().map(|&f| f as f64).collect())
}

/// Generate CLIP embedding from an image file path
/// Used for background processing of thumbnails
#[napi]
pub fn generate_clip_embedding(file_path: String) -> Option<Vec<f64>> {
	let img = match image::open(&file_path) {
		Ok(i) => i,
		Err(e) => {
			eprintln!("Failed to open image {}: {}", file_path, e);
			return None;
		}
	};

	// Generate CLIP embedding
	let embedding = generate_clip_embedding_from_image(img)?;

	// Convert f32 to f64 for JavaScript compatibility
	Some(embedding.iter().map(|&f| f as f64).collect())
}
