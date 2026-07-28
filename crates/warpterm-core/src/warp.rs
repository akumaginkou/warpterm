//! Embedded WARP control: start the `warp-masque` pool + front SOCKS5 in-process
//! and expose live controls (on/off, pin, rotate, transport, trace, status).
//!
//! The terminal wires a shell's env to [`WarpController::socks_port`] once; all
//! subsequent WARP changes go through the pool, so a running shell picks them up
//! without re-spawning.

use std::path::Path;
use std::sync::Arc;

use anyhow::Result;
use warp_masque::{socks, Pool, RegisterOptions, RegistrationClient, WarpConfig};

/// Owns the in-process WARP pool and the front SOCKS5 listener.
pub struct WarpController {
    pool: Arc<Pool>,
    socks_port: u16,
}

impl WarpController {
    /// Start the pool from pre-registered configs and bind the front SOCKS5
    /// load-balancer on a loopback port.
    pub async fn start(configs: Vec<WarpConfig>, http2: bool) -> Result<WarpController> {
        let pool = Pool::new(configs, http2).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let socks_port = listener.local_addr()?.port();
        tokio::spawn(socks::serve_pool(listener, pool.clone()));
        Ok(WarpController { pool, socks_port })
    }

    /// The loopback SOCKS5 port a shell should point at.
    pub fn socks_port(&self) -> u16 {
        self.socks_port
    }

    /// The proxy env vars for a shell (pinned to the SOCKS port).
    pub fn proxy_env(&self) -> Vec<(String, String)> {
        crate::env::proxy_env(self.socks_port)
    }

    /// Whether traffic is tunnelled (vs direct).
    pub fn enabled(&self) -> bool {
        self.pool.enabled()
    }

    /// Toggle WARP on/off (off = direct).
    pub fn set_enabled(&self, on: bool) {
        self.pool.set_enabled(on);
    }

    /// Pin egress to an account (0 = auto round-robin).
    pub fn select(&self, id: usize) {
        self.pool.select(id);
    }

    /// Rotate an account to a fresh egress (0 = pinned/first).
    pub async fn rotate(&self, id: usize) -> Result<()> {
        self.pool.rotate(id).await.map_err(anyhow::Error::from)
    }

    /// Reconnect an account (0 = all).
    pub fn reconnect(&self, id: usize) {
        self.pool.reconnect(id);
    }

    /// Switch transport (QUIC ↔ HTTP/2).
    pub fn set_http2(&self, on: bool) {
        self.pool.set_http2(on);
    }

    /// Set the auto-rotate cadence in seconds (0 = off).
    pub fn set_rotate_interval(&self, secs: u64) {
        self.pool.set_rotate_interval(secs);
    }

    /// Refresh a worker's egress trace (0 = all).
    pub async fn refresh_trace(&self, id: usize) {
        self.pool.refresh_trace(id).await;
    }

    /// The current pool status as JSON (for the UI).
    pub fn status_json(&self) -> String {
        serde_json::to_string(&self.pool.status()).unwrap_or_else(|_| "{}".to_string())
    }
}

/// Provision `n` WARP accounts: load `account-<i>.json` from `state_dir` when
/// present (registering + saving any that are missing), or register `n` fresh
/// ephemeral accounts when `state_dir` is `None`. Persisting means relaunches
/// reuse accounts instead of re-registering.
pub async fn load_or_register(state_dir: Option<&Path>, n: usize) -> Result<Vec<WarpConfig>> {
    let mut out = Vec::with_capacity(n);
    for i in 1..=n {
        let opts = RegisterOptions {
            device_name: Some(format!("warpterm-{i}")),
            ..Default::default()
        };
        match state_dir {
            Some(dir) => {
                let path = dir.join(format!("account-{i}.json"));
                if path.exists() {
                    out.push(WarpConfig::load(&path).map_err(anyhow::Error::from)?);
                } else {
                    let cfg = RegistrationClient::register_auto(&opts).await?;
                    std::fs::create_dir_all(dir).ok();
                    cfg.save(&path).map_err(anyhow::Error::from)?;
                    out.push(cfg);
                }
            }
            None => out.push(RegistrationClient::register_auto(&opts).await?),
        }
    }
    Ok(out)
}

/// Register `n` fresh throwaway WARP accounts (no persistence).
pub async fn register_accounts(n: usize) -> Result<Vec<WarpConfig>> {
    load_or_register(None, n).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn loads_persisted_configs_without_network() {
        let dir = std::env::temp_dir().join(format!("warpterm-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = WarpConfig {
            private_key: "persisted".into(),
            ..Default::default()
        };
        cfg.save(dir.join("account-1.json")).unwrap();

        // With the file present, no registration (network) happens.
        let loaded = load_or_register(Some(&dir), 1).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].private_key, "persisted");

        std::fs::remove_dir_all(&dir).ok();
    }
}
