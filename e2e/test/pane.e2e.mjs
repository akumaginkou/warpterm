// End-to-end GUI tests driving the real warpterm binary through tauri-driver
// (WebKitWebDriver). These exercise the keyboard-driven paths that can't be
// tested with xdotool (WebKitGTK ignores synthetic key events from it): split
// panes, focus nav, close pane, new tab, and the search bar.
//
// The app is launched with WARPTERM_NO_WARP=1 so tests need no network — the
// pane/DOM logic under test is independent of the proxy.
import { spawn } from "node:child_process";
import path from "node:path";
import { Builder, By, Key, until } from "selenium-webdriver";
import { strict as assert } from "node:assert";

const application = path.resolve("../src-tauri/target/release/warpterm");
const TAURI_DRIVER = process.env.TAURI_DRIVER || "tauri-driver";
const NATIVE_DRIVER = process.env.NATIVE_DRIVER || "/usr/bin/WebKitWebDriver";

let driver;
let tauriDriver;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Press a chord (modifiers held around `key`) on the focused element. */
async function chord(mods, key) {
  let a = driver.actions({ async: true });
  for (const m of mods) a = a.keyDown(m);
  a = a.sendKeys(key);
  for (const m of [...mods].reverse()) a = a.keyUp(m);
  await a.perform();
}

// Scope to the active tab — hidden tabs keep their panes in the DOM.
const panes = () => driver.findElements(By.css(".tabpane.active .pane"));
const dividers = (dir) => driver.findElements(By.css(`.tabpane.active .divider.${dir}`));
const tabEls = () => driver.findElements(By.css("#tabs .tab:not(.add)"));
const tabsCount = () => tabEls().then((e) => e.length);
// Index of the active tab among the (non-add) tabs.
async function activeTabIndex() {
  const els = await tabEls();
  const classes = await Promise.all(els.map((e) => e.getAttribute("class")));
  return classes.findIndex((c) => /\bactive\b/.test(c));
}

/** Wait until there are exactly `n` panes (splits/closes update the DOM sync). */
async function waitPanes(n) {
  await driver.wait(async () => (await panes()).length === n, 10000, `expected ${n} panes`);
}

async function focusFirstPane() {
  const els = await panes();
  await driver.actions({ async: true }).move({ origin: els[0] }).click().perform();
  await sleep(150);
}

/** Type a line into the focused terminal (with a trailing Enter). */
async function typeLine(s) {
  await driver.actions({ async: true }).sendKeys(s + "\n").perform();
}

describe("warpterm GUI (tauri-driver)", function () {
  this.timeout(120000);

  before(async () => {
    tauriDriver = spawn(TAURI_DRIVER, ["--native-driver", NATIVE_DRIVER], {
      env: {
        ...process.env,
        WARPTERM_NO_WARP: "1",
        // Software-render so the webview initialises under a bare Xvfb (no WM/GPU).
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        LIBGL_ALWAYS_SOFTWARE: "1",
      },
      stdio: [null, process.stdout, process.stderr],
    });
    // Give tauri-driver a moment to bind before connecting.
    await sleep(2500);
    driver = await new Builder()
      .usingServer("http://127.0.0.1:4444/")
      .withCapabilities({ browserName: "wry", "tauri:options": { application } })
      .build();
    // Terminal is rendered once the frontend boots.
    await driver.wait(until.elementLocated(By.css(".pane")), 30000);
    await sleep(500);
  });

  after(async () => {
    if (driver) await driver.quit().catch(() => {});
    if (tauriDriver) tauriDriver.kill();
  });

  it("boots with a single pane and one tab", async () => {
    await waitPanes(1);
    assert.equal(await tabsCount(), 1);
  });

  it("splits right (Ctrl+Shift+D) into a row split", async () => {
    await focusFirstPane();
    await chord([Key.CONTROL, Key.SHIFT], "d");
    await waitPanes(2);
    assert.equal((await dividers("row")).length, 1);
  });

  it("splits down (Ctrl+Shift+E) into a nested column split", async () => {
    await chord([Key.CONTROL, Key.SHIFT], "e");
    await waitPanes(3);
    assert.equal((await dividers("col")).length, 1);
  });

  it("moves focus to the left pane (Ctrl+Shift+ArrowLeft)", async () => {
    await chord([Key.CONTROL, Key.SHIFT], Key.ARROW_LEFT);
    await sleep(200);
    const els = await panes();
    const focused = await els[0].getAttribute("class");
    assert.match(focused, /\bfocused\b/, "leftmost pane should be focused");
  });

  it("closes the focused pane (Ctrl+Shift+W)", async () => {
    await chord([Key.CONTROL, Key.SHIFT], "w");
    await waitPanes(2);
  });

  it("opens a new tab (Ctrl+Shift+T)", async () => {
    await chord([Key.CONTROL, Key.SHIFT], "t");
    await driver.wait(async () => (await tabsCount()) === 2, 10000, "expected 2 tabs");
    await waitPanes(1); // the new tab has a single pane
  });

  it("switches tabs with Ctrl+1 / Ctrl+2 / Ctrl+Tab", async () => {
    await focusFirstPane();
    await chord([Key.CONTROL], "1");
    await driver.wait(async () => (await activeTabIndex()) === 0, 5000, "Ctrl+1 -> tab 1");
    await chord([Key.CONTROL], "2");
    await driver.wait(async () => (await activeTabIndex()) === 1, 5000, "Ctrl+2 -> tab 2");
    await chord([Key.CONTROL], Key.TAB);
    await driver.wait(async () => (await activeTabIndex()) === 0, 5000, "Ctrl+Tab wraps to tab 1");
  });

  it("renames a tab by double-click", async () => {
    const label = (await driver.findElements(By.css("#tabs .tab:not(.add) .tab-label")))[0];
    await driver.actions({ async: true }).doubleClick(label).perform();
    const input = await driver.wait(until.elementLocated(By.css("#tabs .tab-rename")), 5000);
    await input.sendKeys("mytab", Key.ENTER);
    await driver.wait(
      async () => {
        const els = await tabEls();
        return (await els[0].getText()).includes("mytab");
      },
      5000,
      "tab label should update",
    );
  });

  it("toggles the search bar (Ctrl+Shift+F / Escape)", async () => {
    await focusFirstPane();
    await chord([Key.CONTROL, Key.SHIFT], "f");
    const search = await driver.findElement(By.css("#search"));
    await driver.wait(async () => (await search.getAttribute("hidden")) === null, 5000, "search should show");
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await driver.wait(async () => (await search.getAttribute("hidden")) !== null, 5000, "search should hide");
  });

  it("inherits the cwd into a split pane", async () => {
    // Fresh tab (no manual title) so the shell title drives the label.
    await focusFirstPane();
    await chord([Key.CONTROL, Key.SHIFT], "t");
    await sleep(500);
    // cd somewhere, then split — the new pane should start in that directory.
    await typeLine("cd /tmp");
    await sleep(400);
    await chord([Key.CONTROL, Key.SHIFT], "d");
    await waitPanes(2);
    await sleep(600);
    // Have the new (focused) pane advertise its cwd as the window title.
    await typeLine(String.raw`printf '\033]0;CWD:%s\a' "$PWD"`);
    await driver.wait(
      async () => {
        const el = await driver.findElement(By.css("#tabs .tab.active .tab-label"));
        return (await el.getText()).includes("/tmp");
      },
      10000,
      "the split pane's title should report /tmp",
    );
  });
});
