use fastembed::{
  EmbeddingModel, ImageEmbedding, ImageEmbeddingModel, ImageInitOptions, InitOptions,
  TextEmbedding,
};
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
pub fn clip_embedding(file_path: String) -> napi::Result<Vec<f64>> {
  let model = create_clip_image_model()?;

  let embeddings = model
    .embed(vec![file_path], None)
    .map_err(|e| napi::Error::from_reason(format!("Failed to generate CLIP embedding: {}", e)))?;

  let embedding = embeddings
    .first()
    .ok_or_else(|| napi::Error::from_reason("No embedding generated"))?;

  // Convert f32 to f64 for JavaScript compatibility
  Ok(embedding.iter().map(|&f| f as f64).collect())
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

pub fn generate_clip_embedding(file_path: &str) -> Option<Vec<f32>> {
  match create_clip_image_model() {
    Ok(model) => match model.embed(vec![file_path.to_string()], None) {
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
