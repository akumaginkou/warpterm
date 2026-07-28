//! Persisted user settings (font size, theme, default transparent mode, pooled
//! account count). Loading is infallible — a missing or corrupt file yields
//! defaults — so the app always starts.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// User-configurable settings, saved as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Terminal font size in px.
    pub font_size: u16,
    /// Theme name: `"dark"` or `"light"`.
    pub theme: String,
    /// Whether new shells default to transparent (proxychains) routing.
    pub transparent_default: bool,
    /// How many WARP accounts to pool (applied on next launch).
    pub accounts: usize,
    /// Auto-copy the selection to the clipboard when the mouse is released.
    pub copy_on_select: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_size: 13,
            theme: "dark".to_string(),
            transparent_default: false,
            accounts: 2,
            copy_on_select: false,
        }
    }
}

impl Settings {
    /// Load settings from `path`, falling back to defaults if absent/invalid.
    pub fn load(path: &Path) -> Settings {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .map(|s: Settings| s.sanitized())
            .unwrap_or_default()
    }

    /// Write settings to `path` (creating the parent dir), as pretty JSON.
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        std::fs::write(path, serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }

    /// Clamp values to sane ranges.
    fn sanitized(mut self) -> Settings {
        self.font_size = self.font_size.clamp(6, 48);
        self.accounts = self.accounts.clamp(1, 8);
        if self.theme != "light" {
            self.theme = "dark".to_string();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_and_defaults() {
        let dir = std::env::temp_dir().join(format!("warpterm-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        // Missing file => defaults.
        let d = Settings::load(&path);
        assert_eq!(d.font_size, 13);
        assert_eq!(d.accounts, 2);
        assert!(!d.copy_on_select);

        // Save + reload, with clamping applied.
        let s = Settings {
            font_size: 999,
            accounts: 99,
            theme: "neon".into(),
            ..d
        };
        s.save(&path).unwrap();
        let back = Settings::load(&path);
        assert_eq!(back.font_size, 48); // clamped
        assert_eq!(back.accounts, 8); // clamped
        assert_eq!(back.theme, "dark"); // unknown -> dark

        std::fs::remove_dir_all(&dir).ok();
    }
}
