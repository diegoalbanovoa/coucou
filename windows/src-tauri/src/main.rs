//! Binary entry point for the Windows/Linux app. All the real work lives in the
//! `coucou_lib` crate (`lib.rs`); this file only calls `run()` so that the same
//! code can also be built as the mobile/library target Tauri expects.

// Coucou runs without a console window: Mochi is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Starts the Tauri application and blocks until it exits.
fn main() {
    coucou_lib::run()
}
