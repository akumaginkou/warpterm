//! `warpterm-core` — the Tauri-independent core of warpterm.
//!
//! - [`pty`]  — cross-platform PTY shell sessions (`portable-pty`).
//! - [`warp`] — embedded WARP pool + front SOCKS5 and live controls
//!   (`warp-masque`).
//! - [`env`]  — proxy environment injection for spawned shells.
//!
//! The Tauri app (`src-tauri`) is a thin shell over this: it shuttles PTY bytes
//! to xterm.js and exposes the WARP controls as Tauri commands. Keeping the core
//! GUI-free lets it build and test headlessly.

pub mod env;
pub mod pty;
pub mod settings;
pub mod transparent;
pub mod warp;

pub use pty::{PtyConfig, PtySession};
pub use settings::Settings;
pub use transparent::transparent_env;
pub use warp::{load_or_register, register_accounts, WarpController};
