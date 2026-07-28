# warpterm

[![CI](https://github.com/akumaginkou/warpterm/actions/workflows/ci.yml/badge.svg)](https://github.com/akumaginkou/warpterm/actions/workflows/ci.yml)

A cross-platform terminal emulator with **Cloudflare WARP built in**. Every shell
it opens egresses through an embedded [warp-proxy](https://github.com/akumaginkou/warp-proxy)
(`warp-masque`) pool, and you switch/rotate the egress IP or toggle WARP live from
the toolbar — no external proxy, no system VPN, no admin rights.

> Status: **M1 (runs).** The GUI builds and runs: it renders the terminal with a
> live shell and a WARP control bar that shows the current egress IP/colo, with
> the `warp-masque` pool embedded in-process. Verified headlessly under Xvfb —
> shell prompt + live egress (`104.28.x.x · NRT`, WARP on). The terminal core
> (PTY + embedded WARP + proxy-env injection) is unit-tested headlessly.
>
> Known gap: automated keystroke injection into the WebKitGTK terminal (for
> headless E2E tests) needs a WebDriver (`tauri-driver`), not `xdotool`.

## How it works

```
┌──────────────────────── Tauri app (src-tauri) ────────────────────────┐
│  WebView (frontend, xterm.js)          Rust core (warpterm-core)        │
│  ┌───────────────┐   events/invoke  ┌──────────────────────────────┐   │
│  │ terminal      │ <──────────────> │ PTY (portable-pty) → shell    │   │
│  │ WARP bar      │                  │ WarpController: warp-masque    │   │
│  │  (on/off·IP·  │                  │  Pool + front SOCKS5 (loopbk)  │   │
│  │   rotate)     │ <──────────────> │  live controls                 │   │
│  └───────────────┘                  └──────────────────────────────┘   │
│    shell env: ALL_PROXY=socks5h://127.0.0.1:<socks>  (fixed)            │
└─────────────────────────────────────────────────────────────────────────┘
       WARP on/off · pin · rotate  →  live via the pool (no re-spawn)
```

The shell's proxy env is pinned to the front SOCKS port once; WARP on/off, egress
pin, and rotate are applied live through the in-process pool, so a running shell
picks up changes without restarting.

**Tabs.** Multiple shells in tabs — `+` (or `Ctrl+Shift+T`) opens one, `×` (or
`Ctrl+Shift+W`) closes it; every tab shares the same WARP pool.

**Settings (⚙).** Font size, theme (dark/light), default-transparent, and the
pooled account count — persisted under the app data dir (`settings.json`).

**Transparent mode (Linux).** By default only proxy-aware tools (git, curl, npm…)
honour the env. Tick **transparent** in the toolbar and new shells preload
`proxychains`, forcing *every* program's TCP through WARP — even proxy-unaware
ones. Verify the mechanism headlessly:

```sh
cargo run -p warpterm-core --example transparent_demo   # a curl with NO proxy env -> warp=on
```

(Transparent mode is Linux-only for now — it uses `LD_PRELOAD`; macOS/Windows use
the env path.)

## Layout

```
crates/warpterm-core/  # Tauri-independent core: PTY · WARP embed · proxy env (tested headlessly)
src-tauri/             # Tauri v2 app (commands + PTY streaming). Standalone package; needs a desktop.
frontend/              # Vite + xterm.js UI (terminal + WARP control bar)
vendor/h3/             # replicated cf-connect-ip h3 patch required by warp-masque (see PATCH.md)
```

## Install (Linux)

Grab a `.deb` or `.AppImage` from [Releases](https://github.com/akumaginkou/warpterm/releases)
(built by the release workflow on a `v*` tag), or build them yourself:

```sh
cd frontend && npm install && cd ..
cargo tauri build        # -> src-tauri/target/release/bundle/{deb,appimage}/

sudo dpkg -i src-tauri/target/release/bundle/deb/warpterm_*_amd64.deb   # then run: warpterm
# or just run the portable AppImage:
./src-tauri/target/release/bundle/appimage/warpterm_*_amd64.AppImage
```

The `.deb` declares `proxychains4` as a dependency (for transparent mode).

## Build & run

### Core (headless — CI-friendly)

```sh
cargo test -p warpterm-core     # PTY round-trip + proxy-env unit tests
```

### The app (desktop)

Prerequisites: Rust, Node, the [Tauri v2 system deps](https://tauri.app/start/prerequisites/)
(Linux: `webkit2gtk-4.1`, `gtk3`, `libsoup-3.0`; macOS: Xcode CLT; Windows:
WebView2 + MSVC), the Tauri CLI (`cargo install tauri-cli --version '^2'`), and app
icons (`cargo tauri icon path/to/icon.png`).

```sh
cd frontend && npm install && cd ..
cargo tauri dev                       # dev: live-reloads the frontend from Vite

# self-contained production build (embeds the frontend; no dev server needed):
cargo tauri build --no-bundle         # -> src-tauri/target/release/warpterm
# or, without a global CLI: npx @tauri-apps/cli@^2 build --no-bundle
```

Running it registers WARP accounts on first launch (persisted under the app data
dir, so relaunches reuse them); open a shell and
`curl https://www.cloudflare.com/cdn-cgi/trace` should report `warp=on`.

> Note: a plain `cargo build` produces a *dev* binary that loads the frontend
> from the Vite dev server (`devUrl`). Use `cargo tauri build` for a standalone
> app that serves its embedded assets.

## Note on embedding warp-masque

`warp-masque` depends on a one-variant patch to `h3` (the non-standard
`cf-connect-ip` `:protocol` token). Cargo `[patch]` only applies from the building
workspace root, so both the core workspace and `src-tauri` replicate
`[patch.crates-io] h3 = { path = ".../vendor/h3" }`. See `vendor/h3/PATCH.md`.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your
option.
