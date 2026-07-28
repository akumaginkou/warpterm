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
const tabsCount = () => driver.findElements(By.css("#tabs .tab:not(.add)")).then((e) => e.length);

/** Wait until there are exactly `n` panes (splits/closes update the DOM sync). */
async function waitPanes(n) {
  await driver.wait(async () => (await panes()).length === n, 10000, `expected ${n} panes`);
}

async function focusFirstPane() {
  const els = await panes();
  await driver.actions({ async: true }).move({ origin: els[0] }).click().perform();
  await sleep(150);
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

  it("toggles the search bar (Ctrl+Shift+F / Escape)", async () => {
    await focusFirstPane();
    await chord([Key.CONTROL, Key.SHIFT], "f");
    const search = await driver.findElement(By.css("#search"));
    await driver.wait(async () => (await search.getAttribute("hidden")) === null, 5000, "search should show");
    await driver.actions({ async: true }).sendKeys(Key.ESCAPE).perform();
    await driver.wait(async () => (await search.getAttribute("hidden")) !== null, 5000, "search should hide");
  });
});
