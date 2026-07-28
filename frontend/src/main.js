import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
// ---- terminal --------------------------------------------------------------
const term = new Terminal({
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: { background: "#14161b", foreground: "#d7dae0" },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));
try {
    term.loadAddon(new WebglAddon());
}
catch {
    /* fall back to canvas/DOM renderer */
}
fit.fit();
let ptyId = null;
async function startPty() {
    ptyId = await invoke("open_pty", { rows: term.rows, cols: term.cols });
    // PTY output -> terminal.
    await listen(`pty://${ptyId}`, (e) => {
        term.write(new Uint8Array(e.payload));
    });
    await listen(`pty-exit://${ptyId}`, () => {
        term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    });
    // Keystrokes -> PTY.
    const encoder = new TextEncoder();
    term.onData((data) => {
        if (ptyId !== null) {
            invoke("write_pty", { id: ptyId, data: Array.from(encoder.encode(data)) });
        }
    });
}
// Keep the PTY sized to the window.
function doFit() {
    fit.fit();
    if (ptyId !== null) {
        invoke("resize_pty", { id: ptyId, rows: term.rows, cols: term.cols });
    }
}
window.addEventListener("resize", doFit);
// ---- WARP control bar ------------------------------------------------------
const $toggle = document.getElementById("warp-toggle");
const $egress = document.getElementById("egress");
const $account = document.getElementById("account");
const $rotate = document.getElementById("rotate");
function renderStatus(s) {
    const enabled = !!s.enabled;
    $toggle.textContent = enabled ? "WARP on" : "WARP off";
    $toggle.classList.toggle("on", enabled);
    const active = s.mode === "pinned" ? s.accounts?.find((a) => a.id === s.pinned) : s.accounts?.find((a) => a.ready);
    const t = active?.trace;
    $egress.textContent = t?.ip ? `egress: ${t.ip}${t.colo ? " · " + t.colo : ""}` : "egress: —";
    const want = (s.accounts ?? []).map((a) => a.id).join(",");
    if ($account.dataset.ids !== want) {
        $account.dataset.ids = want;
        $account.innerHTML =
            `<option value="0">auto</option>` +
                (s.accounts ?? []).map((a) => `<option value="${a.id}">#${a.id}</option>`).join("");
    }
    $account.value = String(s.pinned ?? 0);
}
async function refresh() {
    try {
        renderStatus(JSON.parse(await invoke("warp_status")));
    }
    catch {
        /* ignore transient errors */
    }
}
$toggle.onclick = async () => {
    const enabled = $toggle.classList.contains("on");
    await invoke("warp_toggle", { on: !enabled });
    refresh();
};
$account.onchange = async () => {
    await invoke("warp_select", { id: Number($account.value) });
    refresh();
};
$rotate.onclick = async () => {
    $rotate.disabled = true;
    try {
        await invoke("warp_rotate", { id: Number($account.value) });
        await invoke("warp_trace", { id: 0 });
    }
    finally {
        $rotate.disabled = false;
        refresh();
    }
};
// ---- boot ------------------------------------------------------------------
// Open the shell only once WARP is up, so it inherits the proxy env. (WARP
// on/off is still live thereafter via the pool.) Returns whether it came up.
async function waitForWarp(timeoutMs = 40000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const s = JSON.parse(await invoke("warp_status"));
            if (s.ready !== false)
                return true; // controller up => SOCKS port available
        }
        catch {
            /* retry */
        }
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}
// Focus the terminal when the pane is clicked (so keystrokes land in the shell).
document.getElementById("terminal").addEventListener("mousedown", () => term.focus());
(async () => {
    term.writeln("\x1b[90mStarting WARP…\x1b[0m");
    const up = await waitForWarp();
    if (up) {
        await invoke("warp_trace", { id: 0 }).catch(() => { });
    }
    else {
        term.writeln("\x1b[33mWARP didn't come up in time — starting the shell without a proxy. Toggle WARP from the bar once it's ready.\x1b[0m");
    }
    await startPty();
    term.focus();
    refresh();
})();
refresh();
setInterval(refresh, 4000);
