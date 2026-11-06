fn main() {
  println!("cargo:rerun-if-changed=src/adobe/denoise/coreml.m");
  #[cfg(feature = "adobe-denoise-coreml")]
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    cc::Build::new()
      .file("src/adobe/denoise/coreml.m")
      .flag("-fobjc-arc")
      .flag("-fobjc-arc-exceptions")
      .compile("photobrain_coreml");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=CoreML");
    println!("cargo:rustc-link-lib=framework=Metal");
  }
}
