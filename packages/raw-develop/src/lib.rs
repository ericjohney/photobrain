//! raw-develop: Fujifilm X-Trans RAF, Sony ARW and Apple ProRAW DNG to Display P3,
//! following the stage order of Apple's RawCamera pipeline (decode, linearise, white
//! balance, demosaic, crop, noise reduction, lens correction, highlight recovery, camera to
//! linear colour, exposure, sharpening, look, output). LinearRaw DNGs take RawCamera's
//! "8.dng" variant (no demosaic; colour, exposure and tone from DNG tags).
//!
//! The crate is standalone: it is not yet wired into `image-processing` scans.
//!
//! ```no_run
//! use raw_develop::{Negative, DevelopSettings, Options, develop};
//! let neg = Negative::open("DSCF0970.RAF")?;               // decode once, cache
//! let out = develop(&neg, &DevelopSettings::default(), &Options::default())?;
//! raw_develop::encode::write(&out.image, "out.png".as_ref(), raw_develop::encode::Format::Png16)?;
//! # Ok::<(), raw_develop::Error>(())
//! ```

#![allow(clippy::needless_range_loop)]

pub mod adobe;
pub mod arw;
pub mod cancel;
pub mod cfa;
pub mod dng;
pub mod encode;
pub mod error;
pub mod image;
pub mod math;
pub mod metadata;
pub mod negative;
pub mod pipeline;
pub mod prepared;
pub mod profile;
pub mod raf;
pub mod settings;
pub mod smart_preview;
pub mod stages;
pub mod tiff;
pub mod unpack;

pub use cancel::Cancel;
pub use error::{Error, Result};
pub use negative::Negative;
pub use pipeline::Engine;
pub use pipeline::{Developed, Options, PIPELINE_VERSION, Quality, develop, prepare};
pub use prepared::Prepared;
pub use settings::DevelopSettings;
