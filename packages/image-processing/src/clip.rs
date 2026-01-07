use fastembed::{
  EmbeddingModel, ImageEmbedding, ImageEmbeddingModel, ImageInitOptions, InitOptions, TextEmbedding,
};
use image::DynamicImage;
use napi_derive::napi;

fn create_clip_image_model() -> napi::Result<ImageEmbedding> {
  ImageEmbedding::try_new(
    ImageInitOptions::new(ImageEmbeddingModel::ClipVitB32).with_show_download_progress(false),
  )
  .map_err(|e| napi::Error::from_reason(format!("Failed to initialize CLIP image model: {}", e)))
}

fn create_clip_text_model() -> napi::Result<TextEmbedding> {
  TextEmbedding::try_new(
    InitOptions::new(EmbeddingModel::ClipVitB32).with_show_download_progress(false),
  )
  .map_err(|e| napi::Error::from_reason(format!("Failed to initialize CLIP text model: {}", e)))
}

#[napi]
pub fn clip_text_embedding(text: String) -> napi::Result<Vec<f64>> {
  let model = create_clip_text_model()?;

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
  match create_clip_image_model() {
    Ok(model) => match model.embed_images(vec![img]) {
      Ok(embeddings) => {
        if let Some(embedding) = embeddings.first() {
          Some(embedding.clone())
        } else {
          None
        }
      }
      Err(_) => None,
    },
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
