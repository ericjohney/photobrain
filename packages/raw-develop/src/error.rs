use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
  #[error("io: {0}")]
  Io(#[from] std::io::Error),
  #[error("not a Fujifilm RAF file")]
  NotRaf,
  #[error("not a supported RAW file (RAF, ARW or DNG)")]
  NotRaw,
  #[error("malformed RAW: {0}")]
  Malformed(String),
  #[error("unsupported: {0}")]
  Unsupported(String),
  #[error("corrupt compressed data: {0}")]
  Corrupt(String),
  #[error("invalid settings: {0}")]
  Settings(String),
  #[error("encode: {0}")]
  Encode(String),
  #[error("cancelled")]
  Cancelled,
}

pub type Result<T> = std::result::Result<T, Error>;

pub(crate) fn malformed<T>(msg: impl Into<String>) -> Result<T> {
  Err(Error::Malformed(msg.into()))
}
