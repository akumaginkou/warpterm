import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- model -----------------------------------------------------------------
//
// A tab holds a binary *split tree* of panes. A leaf is one pane (xterm + PTY);
// a split node divides its area into two children (side-by-side or stacked) with
// a draggable ratio. One pane per tab is focused.

interface Pane {
  id: number; // unique, for focus tracking
  host: HTMLDivElement; // the element xterm renders into (reparented on relayout)
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  ptyId: number | null;
  unlisten: UnlistenFn[];
  title: string; // shell-reported title (OSC 0/2), if any
}

type Node =
  | { kind: "leaf"; pane: Pane }
  | { kind: "split"; dir: "row" | "col"; a: Node; b: Node; ratio: number };

interface Tab {
  n: number; // display number
  root: Node;
  container: HTMLDivElement; // tab-level wrapper in #panes
  focused: Pane;
}

const tabs: Tab[] = [];
let active = -1;
let counter = 0; // tab display number
let paneCounter = 0;
const panes = document.getElementById("panes") as HTMLDivElement;
const tabbar = document.getElementById("tabs") as HTMLElement;
const encoder = new TextEncoder();

function transparentEnabled(): boolean {
  return (document.getElementById("transparent") as HTMLInputElement)?.checked ?? false;
}

// ---- tree helpers ----------------------------------------------------------

function leaves(node: Node): Pane[] {
  return node.kind === "leaf" ? [node.pane] : [...leaves(node.a), ...leaves(node.b)];
}

function firstLeaf(node: Node): Pane {
  return node.kind === "leaf" ? node.pane : firstLeaf(node.a);
}

/** Replace the leaf holding `target` with `make(leaf)`; returns the new tree. */
function replaceLeaf(node: Node, target: Pane, make: (leaf: Node) => Node): Node {
  if (node.kind === "leaf") return node.pane === target ? make(node) : node;
  return { ...node, a: replaceLeaf(node.a, target, make), b: replaceLeaf(node.b, target, make) };
}

/** Drop the leaf holding `target`, collapsing its parent split; null if gone. */
function removeLeaf(node: Node, target: Pane): Node | null {
  if (node.kind === "leaf") return node.pane === target ? null : node;
  const a = removeLeaf(node.a, target);
  const b = removeLeaf(node.b, target);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

// ---- settings --------------------------------------------------------------

interface AppSettings {
  font_size: number;
  theme: string;
  transparent_default: boolean;
  accounts: number;
  copy_on_select: boolean;
}
let settings: AppSettings = {
  font_size: 13,
  theme: "dark",
  transparent_default: false,
  accounts: 2,
  copy_on_select: false,
};

function themeFor(name: string) {
  return name === "light"
    ? { background: "#f7f7f8", foreground: "#1c1e24", cursor: "#1c1e24" }
    : { background: "#14161b", foreground: "#d7dae0" };
}

/** Apply font size + theme to every pane and the app chrome. */
function applySettings() {
  document.body.classList.toggle("light", settings.theme === "light");
  for (const t of tabs) {
    for (const p of leaves(t.root)) {
      p.term.options.fontSize = settings.font_size;
      p.term.options.theme = themeFor(settings.theme);
    }
  }
  fitActive();
}

// ---- panes -----------------------------------------------------------------

function newPane(): Pane {
  const host = document.createElement("div");
  host.className = "pane";
  const term = new Terminal({
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    fontSize: settings.font_size,
    cursorBlink: true,
    theme: themeFor(settings.theme),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  // Ctrl/Cmd+click a URL -> open it in the system browser (vetted backend side).
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      invoke("open_url", { url: uri }).catch(() => {});
    }),
  );
  term.open(host);
  try {
    term.loadAddon(new WebglAddon());
  } catch {
    /* fall back to the DOM/canvas renderer */
  }

  const pane: Pane = { id: ++paneCounter, host, term, fit, search, ptyId: null, unlisten: [], title: "" };

  // Auto-copy on select, when enabled.
  term.onSelectionChange(() => {
    if (!settings.copy_on_select) return;
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });
  // Reflect the shell-set window title (OSC 0/2) on the owning tab.
  term.onTitleChange((title) => {
    pane.title = title;
    renderTabs();
  });
  term.attachCustomKeyEventHandler(handleChords);
  host.addEventListener("mousedown", () => focusPane(pane));
  // Right-click pastes into the pane (a common terminal convention).
  host.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    focusPane(pane);
    pasteInto(pane);
  });
  return pane;
}

/** Spawn a shell for a pane and wire the PTY <-> terminal streams. */
async function openShell(pane: Pane) {
  const id = await invoke<number>("open_pty", {
    rows: pane.term.rows,
    cols: pane.term.cols,
    transparent: transparentEnabled(),
  });
  pane.ptyId = id;
  pane.unlisten.push(
    await listen<number[]>(`pty://${id}`, (e) => pane.term.write(new Uint8Array(e.payload))),
  );
  pane.unlisten.push(
    await listen(`pty-exit://${id}`, () =>
      pane.term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"),
    ),
  );
  pane.term.onData((d) => {
    if (pane.ptyId !== null) {
      invoke("write_pty", { id: pane.ptyId, data: Array.from(encoder.encode(d)) });
    }
  });
}

function disposePane(pane: Pane) {
  if (pane.ptyId !== null) invoke("close_pty", { id: pane.ptyId });
  pane.unlisten.forEach((u) => u());
  pane.term.dispose();
  pane.host.remove();
}

function resizePty(p: Pane) {
  if (p.ptyId !== null) invoke("resize_pty", { id: p.ptyId, rows: p.term.rows, cols: p.term.cols });
}

function focusPane(pane: Pane, doFocus = true) {
  const t = tabs[active];
  if (t) t.focused = pane;
  const all = leaves(t?.root ?? { kind: "leaf", pane });
  const multi = all.length > 1; // no border when a tab is a single pane
  for (const p of all) p.host.classList.toggle("focused", multi && p === pane);
  if (doFocus) pane.term.focus();
  renderTabs();
}

// ---- layout ----------------------------------------------------------------

/** Build the DOM for a subtree, reparenting each pane's (persistent) host. */
function buildTree(node: Node): HTMLElement {
  if (node.kind === "leaf") return node.pane.host;

  const box = document.createElement("div");
  box.className = "split " + node.dir;
  const aEl = buildTree(node.a);
  const bEl = buildTree(node.b);
  aEl.style.flex = `${node.ratio} 1 0`;
  bEl.style.flex = `${1 - node.ratio} 1 0`;

  const divider = document.createElement("div");
  divider.className = "divider " + node.dir;
  divider.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = box.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const r =
        node.dir === "row"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      node.ratio = Math.min(0.9, Math.max(0.1, r));
      aEl.style.flex = `${node.ratio} 1 0`;
      bEl.style.flex = `${1 - node.ratio} 1 0`;
      for (const p of leaves(node)) {
        p.fit.fit();
        resizePty(p);
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  box.append(aEl, divider, bEl);
  return box;
}

function layoutTab(tab: Tab) {
  tab.container.textContent = "";
  const tree = buildTree(tab.root);
  tree.style.flex = "1 1 0";
  tab.container.appendChild(tree);
  const all = leaves(tab.root);
  for (const p of all) {
    p.fit.fit();
    resizePty(p);
  }
  const multi = all.length > 1;
  for (const p of all) p.host.classList.toggle("focused", multi && p === tab.focused);
}

function fitActive() {
  const t = tabs[active];
  if (!t) return;
  for (const p of leaves(t.root)) {
    p.fit.fit();
    resizePty(p);
  }
}

// ---- splits ----------------------------------------------------------------

async function splitFocused(dir: "row" | "col") {
  const tab = tabs[active];
  if (!tab) return;
  const pane = newPane();
  tab.root = replaceLeaf(tab.root, tab.focused, (leaf) => ({
    kind: "split",
    dir,
    a: leaf,
    b: { kind: "leaf", pane },
    ratio: 0.5,
  }));
  layoutTab(tab);
  focusPane(pane);
  await openShell(pane);
}

function closeFocusedPane() {
  const tab = tabs[active];
  if (!tab) return;
  if (tab.root.kind === "leaf") {
    closeTab(active); // last pane -> close the whole tab
    return;
  }
  const gone = tab.focused;
  const next = removeLeaf(tab.root, gone);
  if (!next) return;
  tab.root = next;
  tab.focused = firstLeaf(next);
  disposePane(gone);
  layoutTab(tab);
  focusPane(tab.focused);
}

/** Move focus to the nearest pane in a direction (Ctrl+Shift+Arrow). */
function focusDir(dx: number, dy: number) {
  const tab = tabs[active];
  if (!tab) return;
  const cur = tab.focused.host.getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  const cy = cur.top + cur.height / 2;
  let best: Pane | null = null;
  let bestScore = Infinity;
  for (const p of leaves(tab.root)) {
    if (p === tab.focused) continue;
    const r = p.host.getBoundingClientRect();
    const ex = r.left + r.width / 2 - cx;
    const ey = r.top + r.height / 2 - cy;
    if (dx !== 0 && Math.sign(ex) !== dx) continue;
    if (dy !== 0 && Math.sign(ey) !== dy) continue;
    const score = dx !== 0 ? Math.abs(ex) + Math.abs(ey) * 3 : Math.abs(ey) + Math.abs(ex) * 3;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (best) focusPane(best);
}

// ---- tabs ------------------------------------------------------------------

/** Create a tab (with one pane). If `openNow`, also spawn the shell. */
async function newTab(openNow = true): Promise<Tab> {
  const container = document.createElement("div");
  container.className = "tabpane";
  panes.appendChild(container);
  const pane = newPane();

  const tab: Tab = { n: ++counter, root: { kind: "leaf", pane }, container, focused: pane };
  tabs.push(tab);
  setActive(tabs.length - 1);
  if (openNow) await openShell(pane);
  return tab;
}

function setActive(i: number) {
  active = i;
  tabs.forEach((t, idx) => (t.container.style.display = idx === i ? "flex" : "none"));
  const t = tabs[i];
  if (t) {
    layoutTab(t);
    focusPane(t.focused);
  } else {
    renderTabs();
  }
}

async function closeTab(i: number) {
  const t = tabs[i];
  if (!t) return;
  for (const p of leaves(t.root)) disposePane(p);
  t.container.remove();
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
    const title = t.focused.title;
    const label = title ? (title.length > 20 ? title.slice(0, 19) + "…" : title) : String(t.n);
    el.textContent = label;
    el.title = title || `tab ${t.n}`;
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

// App-level keyboard shortcuts, kept out of the shell (return false = swallow).
//   Ctrl+Shift+T          new tab
//   Ctrl+Shift+W          close pane (or tab, if it's the last pane)
//   Ctrl+Shift+D / E      split the focused pane right / down
//   Ctrl+Shift+Arrow      move focus between panes
//   Ctrl+Shift+C/V        copy selection / paste
//   Ctrl+Shift+F          scrollback search
//   Ctrl +/-/0            font zoom in / out / reset
function handleChords(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return true;

  if (e.ctrlKey && e.shiftKey) {
    switch (e.key) {
      case "ArrowLeft":
        focusDir(-1, 0);
        return false;
      case "ArrowRight":
        focusDir(1, 0);
        return false;
      case "ArrowUp":
        focusDir(0, -1);
        return false;
      case "ArrowDown":
        focusDir(0, 1);
        return false;
    }
    switch (e.key.toLowerCase()) {
      case "t":
        newTab();
        return false;
      case "w":
        closeFocusedPane();
        return false;
      case "d":
        splitFocused("row");
        return false;
      case "e":
        splitFocused("col");
        return false;
      case "c": {
        // Only intercept when there's a selection; otherwise let the shell see it.
        const sel = tabs[active]?.focused.term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        return true;
      }
      case "v":
        if (tabs[active]) pasteInto(tabs[active].focused);
        return false;
      case "f":
        openSearch();
        return false;
    }
  }

  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    if (e.key === "+" || e.key === "=") {
      zoomFont(1);
      return false;
    }
    if (e.key === "-" || e.key === "_") {
      zoomFont(-1);
      return false;
    }
    if (e.key === "0") {
      zoomFont(0);
      return false;
    }
  }
  return true;
}

async function pasteInto(pane: Pane) {
  try {
    const text = await navigator.clipboard.readText();
    if (text) pane.term.paste(text);
  } catch {
    /* clipboard unavailable */
  }
}

// dir > 0 zoom in, < 0 out, 0 reset to default. Persists like the settings panel.
function zoomFont(dir: number) {
  settings.font_size = dir === 0 ? 13 : clamp(settings.font_size + dir, 6, 48);
  populatePanel();
  applySettings();
  saveSettings();
}

(document.getElementById("split-right") as HTMLButtonElement).onclick = () => splitFocused("row");
(document.getElementById("split-down") as HTMLButtonElement).onclick = () => splitFocused("col");

window.addEventListener("resize", fitActive);

// ---- scrollback search -----------------------------------------------------

const $search = document.getElementById("search") as HTMLDivElement;
const $searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchOpts = {
  decorations: {
    matchBackground: "#5c3a00",
    activeMatchBackground: "#f6821f",
    matchOverviewRuler: "#f6821f",
    activeMatchColorOverviewRuler: "#ffffff",
  },
};

function activeSearch(): SearchAddon | undefined {
  return tabs[active]?.focused.search;
}

function openSearch() {
  $search.hidden = false;
  $searchInput.focus();
  $searchInput.select();
  if ($searchInput.value) activeSearch()?.findNext($searchInput.value, searchOpts);
}

function closeSearch() {
  $search.hidden = true;
  activeSearch()?.clearDecorations();
  tabs[active]?.focused.term.focus();
}

$searchInput.addEventListener("keydown", (e) => {
  const s = activeSearch();
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) s?.findPrevious($searchInput.value, searchOpts);
    else s?.findNext($searchInput.value, searchOpts);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});
$searchInput.addEventListener("input", () => {
  activeSearch()?.findNext($searchInput.value, searchOpts);
});
(document.getElementById("search-next") as HTMLButtonElement).onclick = () =>
  activeSearch()?.findNext($searchInput.value, searchOpts);
(document.getElementById("search-prev") as HTMLButtonElement).onclick = () =>
  activeSearch()?.findPrevious($searchInput.value, searchOpts);
(document.getElementById("search-close") as HTMLButtonElement).onclick = closeSearch;

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
const $copyOnSelect = document.getElementById("set-copy-on-select") as HTMLInputElement;
const $accounts = document.getElementById("set-accounts") as HTMLInputElement;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n || lo));

function populatePanel() {
  $font.value = String(settings.font_size);
  $theme.value = settings.theme;
  $defTransparent.checked = settings.transparent_default;
  $copyOnSelect.checked = settings.copy_on_select;
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
$copyOnSelect.onchange = () => {
  settings.copy_on_select = $copyOnSelect.checked;
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
  first.focused.term.writeln("\x1b[90mStarting WARP…\x1b[0m");
  const up = await waitForWarp();
  if (up) {
    await invoke("warp_trace", { id: 0 }).catch(() => {});
  } else {
    first.focused.term.writeln(
      "\x1b[33mWARP didn't come up in time — starting the shell without a proxy.\x1b[0m",
    );
  }
  await openShell(first.focused);
  first.focused.term.focus();
  refresh();
})();

refresh();
setInterval(refresh, 4000);
