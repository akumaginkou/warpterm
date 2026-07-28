//! Headless PTY round-trip: spawn a shell, type a command, and see it both
//! echoed by the tty and executed. Proves the terminal core works without a GUI.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use warpterm_core::pty::{PtyConfig, PtySession};

#[test]
fn shell_echo_roundtrip() {
    let cfg = PtyConfig {
        rows: 24,
        cols: 80,
        ..Default::default()
    };
    let (mut session, mut reader, mut writer) = PtySession::spawn(&cfg).expect("spawn pty");

    // Pump PTY output off the blocking reader onto a channel.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut tmp = [0u8; 4096];
        while let Ok(n) = reader.read(&mut tmp) {
            if n == 0 || tx.send(tmp[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    writer
        .write_all(b"echo wt_marker_42\n")
        .expect("write to pty");
    writer.flush().ok();

    // The marker should appear at least twice: the tty echo of the typed line
    // and the output of `echo` — i.e. the shell actually ran our input.
    let mut acc = String::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(chunk) => {
                acc.push_str(&String::from_utf8_lossy(&chunk));
                if acc.matches("wt_marker_42").count() >= 2 {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
    }

    session.kill().ok();
    assert!(
        acc.matches("wt_marker_42").count() >= 2,
        "shell did not echo + run the command; captured: {acc:?}"
    );
}

#[test]
fn resize_does_not_error() {
    let (session, _reader, _writer) = PtySession::spawn(&PtyConfig::default()).expect("spawn");
    session.resize(40, 120).expect("resize");
}
