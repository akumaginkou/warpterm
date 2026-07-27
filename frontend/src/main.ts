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
term.open(document.getElementById("terminal")!);
try {
  term.loadAddon(new WebglAddon());
} catch {
  /* fall back to canvas/DOM renderer */
}
fit.fit();

let ptyId: number | null = null;

async function startPty() {
  ptyId = await invoke<number>("open_pty", { rows: term.rows, cols: term.cols });

  // PTY output -> terminal.
  await listen<number[]>(`pty://${ptyId}`, (e) => {
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

const $toggle = document.getElementById("warp-toggle") as HTMLButtonElement;
const $egress = document.getElementById("egress") as HTMLSpanElement;
const $account = document.getElementById("account") as HTMLSelectElement;
const $rotate = document.getElementById("rotate") as HTMLButtonElement;

interface Account {
  id: number;
  ready: boolean;
  ip: string;
  trace?: { ip: string; colo: string; warp: string };
}
interface Status {
  ready?: boolean;
  enabled?: boolean;
  mode?: string;
  pinned?: number;
  accounts?: Account[];
}

function renderStatus(s: Status) {
  const enabled = !!s.enabled;
  $toggle.textContent = enabled ? "WARP on" : "WARP off";
  $toggle.classList.toggle("on", enabled);

  const active =
    s.mode === "pinned" ? s.accounts?.find((a) => a.id === s.pinned) : s.accounts?.find((a) => a.ready);
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
    renderStatus(JSON.parse(await invoke<string>("warp_status")));
  } catch {
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
  } finally {
    $rotate.disabled = false;
    refresh();
  }
};

// ---- boot ------------------------------------------------------------------

startPty();
refresh();
setInterval(refresh, 4000);
listen("warp://ready", () => {
  invoke("warp_trace", { id: 0 }).then(refresh);
});
