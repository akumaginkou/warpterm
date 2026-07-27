//! Cross-platform PTY sessions via `portable-pty` (Unix pty + Windows ConPTY).
//!
//! A [`PtySession`] owns the master side (for resize/kill); the reader and writer
//! are handed to the caller, who pumps bytes to/from the terminal UI.

use std::io::{Read, Write};
use std::path::PathBuf;

use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

/// How to start a shell session.
#[derive(Debug, Clone)]
pub struct PtyConfig {
    /// Program to run (defaults to the user's shell when `None`).
    pub shell: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Extra environment variables to set on the child (e.g. proxy vars).
    pub env: Vec<(String, String)>,
    pub rows: u16,
    pub cols: u16,
}

impl Default for PtyConfig {
    fn default() -> Self {
        Self { shell: None, args: Vec::new(), cwd: None, env: Vec::new(), rows: 24, cols: 80 }
    }
}

/// A live PTY + its child process. Keep it alive for the session; drop to close.
pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtySession {
    /// Spawn a shell in a new PTY. Returns the session plus the master reader
    /// (PTY output) and writer (keystrokes to the shell).
    pub fn spawn(
        cfg: &PtyConfig,
    ) -> Result<(PtySession, Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize {
            rows: cfg.rows.max(1),
            cols: cfg.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = cfg.shell.clone().unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(shell);
        for a in &cfg.args {
            cmd.arg(a);
        }
        if let Some(cwd) = &cfg.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd)?;
        // Drop the slave so the PTY reports EOF once the child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        Ok((PtySession { master: pair.master, child }, reader, writer))
    }

    /// Resize the PTY (rows × cols); the shell receives SIGWINCH.
    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Kill the child process.
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill()?;
        Ok(())
    }

    /// Reap the child, returning whether it exited successfully.
    pub fn try_wait(&mut self) -> Result<Option<bool>> {
        Ok(self.child.try_wait()?.map(|s| s.success()))
    }
}

/// The user's default shell for this platform.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("ComSpec").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}
