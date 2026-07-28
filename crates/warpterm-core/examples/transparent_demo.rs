//! Prove transparent routing: with only the proxychains env set (NO proxy env),
//! a plain `curl` — which would otherwise connect directly — still egresses
//! through WARP (`warp=on`), because its `connect()` is hooked and redirected to
//! the WARP SOCKS port.
//!
//! Usage: cargo run -p warpterm-core --example transparent_demo
//! (registers a throwaway WARP account; Linux only.)

use std::io::Read;
use std::time::{Duration, Instant};

use warpterm_core::pty::{PtyConfig, PtySession};
use warpterm_core::{load_or_register, WarpController};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    eprintln!("Registering a WARP account + starting the pool…");
    let configs = load_or_register(None, 1).await?;
    let warp = WarpController::start(configs, false).await?;
    eprintln!(
        "SOCKS port {}. Waiting for a tunnel to come up…",
        warp.socks_port()
    );

    // Wait until an account is ready.
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline {
        let s: serde_json::Value = serde_json::from_str(&warp.status_json()).unwrap_or_default();
        let ready = s["accounts"]
            .as_array()
            .is_some_and(|a| a.iter().any(|x| x["ready"] == true));
        if ready {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    warp.refresh_trace(0).await;

    // Transparent env ONLY (no ALL_PROXY): curl has no proxy configured.
    let conf = std::env::temp_dir().join("warpterm-proxychains-demo.conf");
    let env = warp.transparent_env(&conf)?;

    let cmd = "curl -s --max-time 25 https://www.cloudflare.com/cdn-cgi/trace; echo __EOF__";
    let cfg = PtyConfig {
        shell: Some("bash".into()),
        args: vec!["-lc".into(), cmd.into()],
        env,
        rows: 24,
        cols: 100,
        ..Default::default()
    };
    eprintln!("Running (transparent, no proxy env): {cmd}");
    let (mut session, mut reader, _writer) = PtySession::spawn(&cfg)?;

    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut b = [0u8; 4096];
        while let Ok(n) = reader.read(&mut b) {
            if n == 0 || tx.send(b[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut out = String::new();
    let deadline = Instant::now() + Duration::from_secs(35);
    while Instant::now() < deadline {
        if let Ok(c) = rx.recv_timeout(Duration::from_millis(500)) {
            out.push_str(&String::from_utf8_lossy(&c));
            if out.contains("__EOF__") {
                break;
            }
        }
    }
    session.kill().ok();
    let _ = std::fs::remove_file(&conf);

    let warp_line = out
        .lines()
        .find(|l| l.starts_with("warp="))
        .unwrap_or("(no warp= line)");
    let ip_line = out
        .lines()
        .find(|l| l.starts_with("ip="))
        .unwrap_or("(no ip= line)");
    eprintln!("\n--- trace via transparent routing ---\n{ip_line}\n{warp_line}");
    if warp_line.contains("warp=on") {
        eprintln!("✅ Transparent routing works: a proxy-unaware curl egressed via WARP.");
    } else {
        eprintln!("⚠️  expected warp=on; got: {warp_line}");
    }
    Ok(())
}
