//! warpterm — a WARP-embedded terminal (Tauri app).
//!
//! Thin GUI shell over `warpterm-core`: it streams PTY bytes to xterm.js and
//! exposes the WARP controls as Tauri commands. The WARP pool + front SOCKS5
//! run in-process; new shells are spawned with the proxy env pointing at it.
//!
//! NOTE: This crate needs the Tauri prerequisites (webkit2gtk-4.1, gtk3,
//! libsoup3) and a display. Build with `cargo tauri dev` on a desktop. The
//! GUI-free logic it relies on lives in `warpterm-core` and is tested headlessly.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use warpterm_core::pty::{PtyConfig, PtySession};
use warpterm_core::{load_or_register, Settings, WarpController};

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

struct AppState {
    warp: AsyncMutex<Option<WarpController>>,
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

struct Session {
    pty: PtySession,
    writer: Box<dyn Write + Send>,
}

// ---- WARP commands ---------------------------------------------------------

#[tauri::command]
async fn warp_status(state: State<'_, AppState>) -> Result<String, String> {
    match &*state.warp.lock().await {
        Some(w) => Ok(w.status_json()),
        None => Ok("{\"ready\":false}".to_string()),
    }
}

#[tauri::command]
async fn warp_toggle(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    if let Some(w) = &*state.warp.lock().await {
        w.set_enabled(on);
    }
    Ok(())
}

#[tauri::command]
async fn warp_select(state: State<'_, AppState>, id: usize) -> Result<(), String> {
    if let Some(w) = &*state.warp.lock().await {
        w.select(id);
    }
    Ok(())
}

#[tauri::command]
async fn warp_rotate(state: State<'_, AppState>, id: usize) -> Result<(), String> {
    if let Some(w) = &*state.warp.lock().await {
        w.rotate(id).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn warp_trace(state: State<'_, AppState>, id: usize) -> Result<String, String> {
    let guard = state.warp.lock().await;
    let Some(w) = &*guard else { return Ok("{}".into()) };
    w.refresh_trace(id).await;
    Ok(w.status_json())
}

// ---- PTY commands ----------------------------------------------------------

/// Open a shell in a new PTY, streaming its output as `pty://<id>` events.
#[tauri::command]
async fn open_pty(
    app: AppHandle,
    state: State<'_, AppState>,
    rows: u16,
    cols: u16,
    transparent: bool,
) -> Result<u32, String> {
    // Point the shell at the WARP front SOCKS port. In transparent mode (Linux),
    // preload proxychains so *all* TCP is forced through WARP, not just
    // proxy-aware tools; otherwise inject the proxy env. WARP on/off stays live
    // via the pool.
    let env = match &*state.warp.lock().await {
        Some(w) => {
            if transparent {
                match app.path().app_data_dir() {
                    Ok(dir) => {
                        std::fs::create_dir_all(&dir).ok();
                        w.transparent_env(&dir.join("proxychains.conf"))
                            .unwrap_or_else(|_| w.proxy_env())
                    }
                    Err(_) => w.proxy_env(),
                }
            } else {
                w.proxy_env()
            }
        }
        None => Vec::new(),
    };

    let cfg = PtyConfig { rows, cols, env, ..Default::default() };
    let (pty, mut reader, writer) = PtySession::spawn(&cfg).map_err(|e| e.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { pty, writer });

    // Pump PTY output to the frontend.
    let app2 = app.clone();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let _ = app2.emit(&format!("pty://{id}"), buf[..n].to_vec());
        }
        let _ = app2.emit(&format!("pty-exit://{id}"), ());
    });

    Ok(id)
}

#[tauri::command]
fn write_pty(state: State<'_, AppState>, id: u32, data: Vec<u8>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        s.writer.write_all(&data).map_err(|e| e.to_string())?;
        s.writer.flush().ok();
    }
    Ok(())
}

#[tauri::command]
fn resize_pty(state: State<'_, AppState>, id: u32, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get(&id) {
        s.pty.resize(rows, cols).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_pty(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        s.pty.kill().ok();
    }
    Ok(())
}

// ---- settings --------------------------------------------------------------

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    settings_path(&app).map(|p| Settings::load(&p)).unwrap_or_default()
}

#[tauri::command]
fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app).ok_or("no app data dir")?;
    settings.save(&path).map_err(|e| e.to_string())
}

/// Open a URL (a clicked terminal link) in the system's default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Only allow web/mail schemes so a hostile sequence can't launch arbitrary
    // programs.
    let ok = ["http://", "https://", "mailto:"].iter().any(|p| url.starts_with(p));
    if !ok {
        return Err("unsupported URL scheme".into());
    }
    open::that(&url).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            warp: AsyncMutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        })
        .setup(|app| {
            // Register (or load persisted) accounts + start the WARP pool in the
            // background; commands report `ready:false` until it comes up.
            let handle = app.handle().clone();
            // Persist accounts under the app data dir so relaunches reuse them.
            let state_dir = handle.path().app_data_dir().ok().map(|d| d.join("warp"));
            let n_accounts = settings_path(&handle).map(|p| Settings::load(&p).accounts).unwrap_or(2);
            tauri::async_runtime::spawn(async move {
                let dir = state_dir.as_deref();
                match load_or_register(dir, n_accounts).await {
                    Ok(configs) => match WarpController::start(configs, false).await {
                        Ok(w) => {
                            let state = handle.state::<AppState>();
                            *state.warp.lock().await = Some(w);
                            let _ = handle.emit("warp://ready", ());
                        }
                        Err(e) => eprintln!("[warpterm] WARP start failed: {e}"),
                    },
                    Err(e) => eprintln!("[warpterm] account registration failed: {e}"),
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            warp_status,
            warp_toggle,
            warp_select,
            warp_rotate,
            warp_trace,
            open_pty,
            write_pty,
            resize_pty,
            close_pty,
            get_settings,
            set_settings,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running warpterm");
}
