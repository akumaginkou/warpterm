//! Persisted user settings (font size, theme, default transparent mode, pooled
//! account count). Loading is infallible — a missing or corrupt file yields
//! defaults — so the app always starts.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Default terminal font stack (matches the frontend's).
const DEFAULT_FONT: &str = "ui-monospace, Menlo, Consolas, monospace";

/// A launch profile: a named shell/command (with optional working directory)
/// that a new tab can be opened with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    /// Display name shown in the profile picker.
    pub name: String,
    /// Program to run (e.g. `/bin/zsh`).
    pub program: String,
    /// Arguments passed to the program.
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional starting directory (overrides cwd inheritance).
    #[serde(default)]
    pub cwd: Option<String>,
}

/// User-configurable settings, saved as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Terminal font size in px.
    pub font_size: u16,
    /// Terminal font family (CSS font stack).
    pub font_family: String,
    /// Cursor style: `"bar"`, `"block"`, or `"underline"`.
    pub cursor_style: String,
    /// Scrollback buffer size in lines.
    pub scrollback: u32,
    /// Theme name: `"dark"` or `"light"`.
    pub theme: String,
    /// Whether new shells default to transparent (proxychains) routing.
    pub transparent_default: bool,
    /// How many WARP accounts to pool (applied on next launch).
    pub accounts: usize,
    /// Auto-copy the selection to the clipboard when the mouse is released.
    pub copy_on_select: bool,
    /// Named launch profiles (shell/command presets) for new tabs.
    pub profiles: Vec<Profile>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_size: 13,
            font_family: DEFAULT_FONT.to_string(),
            cursor_style: "bar".to_string(),
            scrollback: 1000,
            theme: "dark".to_string(),
            transparent_default: false,
            accounts: 2,
            copy_on_select: false,
            profiles: Vec::new(),
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
        self.scrollback = self.scrollback.clamp(100, 100_000);
        if self.theme != "light" {
            self.theme = "dark".to_string();
        }
        if !matches!(self.cursor_style.as_str(), "bar" | "block" | "underline") {
            self.cursor_style = "bar".to_string();
        }
        if self.font_family.trim().is_empty() {
            self.font_family = DEFAULT_FONT.to_string();
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
        assert_eq!(d.scrollback, 1000);
        assert_eq!(d.cursor_style, "bar");
        assert!(d.profiles.is_empty());

        // Save + reload, with clamping applied.
        let s = Settings {
            font_size: 999,
            accounts: 99,
            scrollback: 5,
            theme: "neon".into(),
            cursor_style: "wiggle".into(),
            font_family: "  ".into(),
            profiles: vec![Profile {
                name: "zsh".into(),
                program: "/bin/zsh".into(),
                args: vec![],
                cwd: None,
            }],
            ..d
        };
        s.save(&path).unwrap();
        let back = Settings::load(&path);
        assert_eq!(back.font_size, 48); // clamped
        assert_eq!(back.accounts, 8); // clamped
        assert_eq!(back.scrollback, 100); // clamped
        assert_eq!(back.theme, "dark"); // unknown -> dark
        assert_eq!(back.cursor_style, "bar"); // unknown -> bar
        assert_eq!(back.font_family, DEFAULT_FONT); // blank -> default
        assert_eq!(back.profiles.len(), 1);
        assert_eq!(back.profiles[0].program, "/bin/zsh");

        std::fs::remove_dir_all(&dir).ok();
    }
}
