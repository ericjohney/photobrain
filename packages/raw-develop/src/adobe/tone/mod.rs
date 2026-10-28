//! Pointwise Camera Raw 18.7 Process Version 2012 tone primitives.
//!
//! These functions are reconstructed from the ARM64 DNG Converter's named CPU
//! routines. They are separate from the public DNG SDK baseline renderer. Image
//! statistics and profile selection are explicit inputs; this module does not
//! substitute a fixed curve for the statistics-dependent rendering pipeline.

pub mod blacks;
pub mod composition;
pub mod curves;
pub mod exposure;
mod laplacian;
pub(crate) mod mask;
pub(crate) mod mask_upsample;
pub(crate) mod post_map;
pub(crate) mod post_stats;
mod resample;
pub(crate) mod scene;
pub(crate) mod setup;
pub(crate) mod spatial;
pub mod spline;
pub(crate) mod statistics;
pub(crate) mod stats_image;

#[cfg(test)]
mod captured_tests;

#[cfg(test)]
mod scalar_tests;
