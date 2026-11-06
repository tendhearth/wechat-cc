fn main() {
  // Tauri embeds the macOS development Dock icon through a cached OUT_DIR
  // asset. Track the sources too so icon changes invalidate that cache.
  println!("cargo:rerun-if-changed=icons");
  println!("cargo:rerun-if-changed=src/matter_notification.m");
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    cc::Build::new().file("src/matter_notification.m").flag("-fobjc-arc").flag("-fblocks").compile("matter_notification");
    // Keep the existing macOS 10.13 development/plugin fallback loadable.
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,UserNotifications");
    println!("cargo:rustc-link-lib=framework=Foundation");
  }
  tauri_build::build()
}
