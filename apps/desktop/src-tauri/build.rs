fn main() {
  // Tauri embeds the macOS development Dock icon through a cached OUT_DIR
  // asset. Track the sources too so icon changes invalidate that cache.
  println!("cargo:rerun-if-changed=icons");
  tauri_build::build()
}
