import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- tabs (each = one xterm + one PTY shell) -------------------------------

interface Tab {
  n: number; // display number
  term: Terminal;
  fit: FitAddon;
  ptyId: number | null;
  pane: HTMLDivElement;
  unlisten: UnlistenFn[];
}

const tabs: Tab[] = [];
let active = -1;
let counter = 0;
const panes = document.getElementById("panes") as HTMLDivElement;
const tabbar = document.getElementById("tabs") as HTMLElement;
const encoder = new TextEncoder();

function transparentEnabled(): boolean {
  return (document.getElementById("transparent") as HTMLInputElement)?.checked ?? false;
}

// ---- settings --------------------------------------------------------------

interface AppSettings {
  font_size: number;
  theme: string;
  transparent_default: boolean;
  accounts: number;
}
let settings: AppSettings = { font_size: 13, theme: "dark", transparent_default: false, accounts: 2 };

function themeFor(name: string) {
  return name === "light"
    ? { background: "#f7f7f8", foreground: "#1c1e24", cursor: "#1c1e24" }
    : { background: "#14161b", foreground: "#d7dae0" };
}

/** Apply font size + theme to every tab and the app chrome. */
function applySettings() {
  document.body.classList.toggle("light", settings.theme === "light");
  for (const t of tabs) {
    t.term.options.fontSize = settings.font_size;
    t.term.options.theme = themeFor(settings.theme);
    t.fit.fit();
    if (t.ptyId !== null) invoke("resize_pty", { id: t.ptyId, rows: t.term.rows, cols: t.term.cols });
  }
}

function newTerminal(pane: HTMLDivElement): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: settings.font_size,
    cursorBlink: true,
    theme: themeFor(settings.theme),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    /* fall back to the DOM/canvas renderer */
  }
  fit.fit();
  return { term, fit };
}

/** Spawn a shell for a tab and wire the PTY <-> terminal streams. */
async function openShell(tab: Tab) {
  const id = await invoke<number>("open_pty", {
    rows: tab.term.rows,
    cols: tab.term.cols,
    transparent: transparentEnabled(),
  });
  tab.ptyId = id;
  tab.unlisten.push(
    await listen<number[]>(`pty://${id}`, (e) => tab.term.write(new Uint8Array(e.payload))),
  );
  tab.unlisten.push(
    await listen(`pty-exit://${id}`, () =>
      tab.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"),
    ),
  );
  tab.term.onData((d) => {
    if (tab.ptyId !== null) {
      invoke("write_pty", { id: tab.ptyId, data: Array.from(encoder.encode(d)) });
    }
  });
}

/** Create a tab (and its terminal). If `openNow`, also spawn the shell. */
async function newTab(openNow = true): Promise<Tab> {
  const pane = document.createElement("div");
  pane.className = "pane";
  panes.appendChild(pane);
  const { term, fit } = newTerminal(pane);
  pane.addEventListener("mousedown", () => term.focus());
  term.attachCustomKeyEventHandler(handleChords);

  const tab: Tab = { n: ++counter, term, fit, ptyId: null, pane, unlisten: [] };
  tabs.push(tab);
  setActive(tabs.length - 1);
  if (openNow) await openShell(tab);
  return tab;
}

function setActive(i: number) {
  active = i;
  tabs.forEach((t, idx) => (t.pane.style.display = idx === i ? "block" : "none"));
  renderTabs();
  const t = tabs[i];
  if (t) {
    t.fit.fit();
    if (t.ptyId !== null) invoke("resize_pty", { id: t.ptyId, rows: t.term.rows, cols: t.term.cols });
    t.term.focus();
  }
}

async function closeTab(i: number) {
  const t = tabs[i];
  if (!t) return;
  if (t.ptyId !== null) invoke("close_pty", { id: t.ptyId });
  t.unlisten.forEach((u) => u());
  t.term.dispose();
  t.pane.remove();
  tabs.splice(i, 1);
  if (tabs.length === 0) {
    await newTab();
  } else {
    setActive(Math.min(i, tabs.length - 1));
  }
}

function renderTabs() {
  tabbar.textContent = "";
  tabs.forEach((t, idx) => {
    const el = document.createElement("div");
    el.className = "tab" + (idx === active ? " active" : "");
    el.textContent = String(t.n);
    el.onclick = () => setActive(idx);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    x.title = "close tab";
    x.onclick = (e) => {
      e.stopPropagation();
      closeTab(idx);
    };
    el.appendChild(x);
    tabbar.appendChild(el);
  });
  const add = document.createElement("button");
  add.className = "tab add";
  add.textContent = "+";
  add.title = "new tab (Ctrl+Shift+T)";
  add.onclick = () => newTab();
  tabbar.appendChild(add);
}

// Ctrl+Shift+T new tab · Ctrl+Shift+W close tab (kept out of the shell).
function handleChords(e: KeyboardEvent): boolean {
  if (e.type === "keydown" && e.ctrlKey && e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "t") {
      newTab();
      return false;
    }
    if (k === "w") {
      closeTab(active);
      return false;
    }
  }
  return true;
}

window.addEventListener("resize", () => {
  const t = tabs[active];
  if (t) {
    t.fit.fit();
    if (t.ptyId !== null) invoke("resize_pty", { id: t.ptyId, rows: t.term.rows, cols: t.term.cols });
  }
});

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

  const activeAcct =
    s.mode === "pinned" ? s.accounts?.find((a) => a.id === s.pinned) : s.accounts?.find((a) => a.ready);
  const t = activeAcct?.trace;
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
  await invoke("warp_toggle", { on: !$toggle.classList.contains("on") });
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
// Transparent mode changes the shell's env, so reload to apply it to fresh shells.
(document.getElementById("transparent") as HTMLInputElement).onchange = () => location.reload();

// ---- settings panel --------------------------------------------------------

const $gear = document.getElementById("gear") as HTMLButtonElement;
const $panel = document.getElementById("settings") as HTMLDivElement;
const $font = document.getElementById("set-font") as HTMLInputElement;
const $theme = document.getElementById("set-theme") as HTMLSelectElement;
const $defTransparent = document.getElementById("set-transparent") as HTMLInputElement;
const $accounts = document.getElementById("set-accounts") as HTMLInputElement;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n || lo));

function populatePanel() {
  $font.value = String(settings.font_size);
  $theme.value = settings.theme;
  $defTransparent.checked = settings.transparent_default;
  $accounts.value = String(settings.accounts);
}

async function saveSettings() {
  await invoke("set_settings", { settings }).catch(() => {});
}

$gear.onclick = () => ($panel.hidden = !$panel.hidden);
$font.onchange = () => {
  settings.font_size = clamp(+$font.value, 6, 48);
  $font.value = String(settings.font_size);
  applySettings();
  saveSettings();
};
$theme.onchange = () => {
  settings.theme = $theme.value;
  applySettings();
  saveSettings();
};
$defTransparent.onchange = () => {
  settings.transparent_default = $defTransparent.checked;
  (document.getElementById("transparent") as HTMLInputElement).checked = settings.transparent_default;
  saveSettings();
};
$accounts.onchange = () => {
  settings.accounts = clamp(+$accounts.value, 1, 8);
  $accounts.value = String(settings.accounts);
  saveSettings();
};

// ---- WARP readiness --------------------------------------------------------

async function waitForWarp(timeoutMs = 40000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const s = JSON.parse(await invoke<string>("warp_status"));
      if (s.ready !== false) return true; // controller up => SOCKS port available
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---- boot ------------------------------------------------------------------

(async () => {
  // Load persisted settings before creating any terminal.
  try {
    settings = await invoke<AppSettings>("get_settings");
  } catch {
    /* keep defaults */
  }
  populatePanel();
  document.body.classList.toggle("light", settings.theme === "light");
  (document.getElementById("transparent") as HTMLInputElement).checked = settings.transparent_default;

  const first = await newTab(false); // terminal only; open the shell after WARP is up
  first.term.writeln("\x1b[90mStarting WARP…\x1b[0m");
  const up = await waitForWarp();
  if (up) {
    await invoke("warp_trace", { id: 0 }).catch(() => {});
  } else {
    first.term.writeln(
      "\x1b[33mWARP didn't come up in time — starting the shell without a proxy.\x1b[0m",
    );
  }
  await openShell(first);
  first.term.focus();
  refresh();
})();

refresh();
setInterval(refresh, 4000);
