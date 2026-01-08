use fastembed::{
	EmbeddingModel, ImageEmbedding, ImageEmbeddingModel, ImageInitOptions, InitOptions,
	TextEmbedding,
};
use image::DynamicImage;
use napi_derive::napi;
use once_cell::sync::OnceCell;
use std::sync::Mutex;

/// Global cached CLIP image model - loaded once, reused for all embeddings
static CLIP_IMAGE_MODEL: OnceCell<Mutex<ImageEmbedding>> = OnceCell::new();

/// Global cached CLIP text model - loaded once, reused for all embeddings
static CLIP_TEXT_MODEL: OnceCell<Mutex<TextEmbedding>> = OnceCell::new();

fn get_clip_image_model() -> Result<&'static Mutex<ImageEmbedding>, String> {
	CLIP_IMAGE_MODEL.get_or_try_init(|| {
		let model = ImageEmbedding::try_new(
			ImageInitOptions::new(ImageEmbeddingModel::ClipVitB32).with_show_download_progress(false),
		)
		.map_err(|e| format!("Failed to initialize CLIP image model: {}", e))?;
		Ok(Mutex::new(model))
	})
}

fn get_clip_text_model() -> Result<&'static Mutex<TextEmbedding>, String> {
	CLIP_TEXT_MODEL.get_or_try_init(|| {
		let model = TextEmbedding::try_new(
			InitOptions::new(EmbeddingModel::ClipVitB32).with_show_download_progress(false),
		)
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
	let model_mutex = get_clip_image_model().ok()?;

	let model = model_mutex.lock().ok()?;

	match model.embed_images(vec![img]) {
		Ok(embeddings) => embeddings.first().cloned(),
		Err(_) => None,
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
