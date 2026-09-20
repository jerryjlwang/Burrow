/**
 * End-to-end check of the visible-surface actions against demo-pages/surface.html, in a real
 * Chromium with the built extension. The page logs event.isTrusted, so the suite can tell the
 * two input paths apart and proves both halves of the design:
 *   1. by default everything runs on page events and no debugger session is ever opened;
 *   2. with real input switched on, the rabbit escalates only where page events cannot work
 *      (a CSS :hover menu) or where it is explicitly asked to.
 * Usage: npm run build && node e2e/surface.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extPath = resolve(root, "extension/dist");
const PORT = Number(process.env.E2E_PORT) || 8861;

if (!existsSync(resolve(extPath, "manifest.json"))) {
  console.error("extension/dist not found — run `npm run build` first");
  process.exit(1);
}

// Never share: a server already on this port is someone else's (a live LLM, another suite run
// from another checkout), and these assertions are only meaningful against this tree's pages.
if (await fetch(`http://localhost:${PORT}/health`).then(() => true).catch(() => false)) {
  console.error(`port ${PORT} is already serving something — set E2E_PORT to a free port`);
  process.exit(1);
}
const serverProc = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "server/src/index.ts")], {
  env: { ...process.env, DEMO_MODE: "1", PORT: String(PORT), DEEPGRAM_API_KEY: "e2e-placeholder-key" },
  stdio: "ignore",
});
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://localhost:${PORT}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const profileDir = resolve(here, ".profile-surface");
rmSync(profileDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: !process.env.HEADED,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--no-first-run", "--silent-debugger-extension-api"],
  viewport: { width: 1280, height: 800 },
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  await new Promise((r) => setTimeout(r, 1200));
  for (const p of context.pages()) if (p.url().includes("onboarding.html")) await p.close();
  // After the install handler has settled: it read-modify-writes settings, and an earlier write
  // loses that race — leaving the rabbit talking to whatever live server owns the default port.
  const serverUrl = await sw.evaluate(async (url) => {
    const current = (await chrome.storage.local.get("pip.settings"))["pip.settings"] ?? {};
    await chrome.storage.local.set({ "pip.settings": { ...current, serverUrl: url } });
    return (await chrome.storage.local.get("pip.settings"))["pip.settings"].serverUrl;
  }, `http://localhost:${PORT}`);
  check("extension points at this suite's demo-mode server", serverUrl === `http://localhost:${PORT}`, serverUrl);

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://localhost:${PORT}/demo/surface.html`, { waitUntil: "load" });
  await page.locator("#pip-companion-host").waitFor({ state: "attached", timeout: 15000 });
  await page.evaluate(() => document.getElementById("pip-companion-host").shadowRoot.querySelector(".pip-char-btn").click());
  await page.locator(".pip-panel").waitFor({ timeout: 5000 });

  const ask = async (text) => {
    await page.locator(".pip-input").fill(text);
    await page.locator(".pip-send").click();
  };
  /** Waits for a log entry the page wrote in response to input. */
  const logged = async (name, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const hit = await page.evaluate((n) => window.__log.find((e) => e.name === n) ?? null, name);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  const idle = () => page.waitForFunction(() => !document.getElementById("pip-companion-host").shadowRoot.querySelector(".pip-send")?.disabled, null, { timeout: 15000 }).catch(() => null);

  // getTargets().attached is no use here: the test harness itself is attached to every tab. An
  // extension may hold only one debugger session per tab, so a second attach is refused exactly
  // when the rabbit is already holding one.
  const rabbitHoldsDebugger = () =>
    sw.evaluate(async () => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes("surface.html"));
      try {
        await chrome.debugger.attach({ tabId: tab.id }, "1.3");
        await chrome.debugger.detach({ tabId: tab.id });
        return false;
      } catch (e) {
        return /already attached/i.test(String(e)) ? true : `probe failed: ${e}`;
      }
    });
  const menuOpen = (timeout) => page.waitForFunction(() => getComputedStyle(document.querySelector("#menu .items")).display === "block", null, { timeout }).then(() => true).catch(() => false);

  // ---- Default: page events only. Real input is off, so no debugger session may ever open. ----
  await ask("double-click the word card");
  const dbl = await logged("dblclick");
  check("double_click works with page events", dbl?.trusted === false, JSON.stringify(dbl));
  await idle();

  await ask("right-click the word card");
  const ctx = await logged("contextmenu");
  check("right_click works with page events", ctx?.trusted === false, JSON.stringify(ctx));
  await idle();

  await ask("drag the blue chip to the answer box");
  const drop = await logged("drop");
  check("drag completes an HTML5 drag-and-drop with page events, data intact", drop?.data === "chip" && drop.trusted === false, JSON.stringify(drop));
  await idle();

  await ask("drag from 56, 392 to 356, 392");
  const knob = await logged("knob-up");
  check("drag by coordinates moves a pointer-driven slider with page events", knob?.trusted === false && Math.abs(knob.left - 302) <= 3, JSON.stringify(knob));
  await idle();

  await ask("click at 700, 150");
  const canvasClick = await logged("canvas-click");
  check("click by coordinates lands on the canvas at that exact pixel with page events", canvasClick?.trusted === false && Math.abs(canvasClick.x - 98) <= 1 && Math.abs(canvasClick.y - 108) <= 1, JSON.stringify(canvasClick));
  await idle();

  await ask("press escape");
  const key = await logged("keydown");
  check("press_key reaches page listeners with page events", key?.trusted === false && key.key === "Escape", JSON.stringify(key));
  await idle();

  await ask("hover over the tools menu");
  check("a CSS :hover menu stays shut under page events (the known limit)", !(await menuOpen(3000)));
  await idle();
  const heldWhileOff = await rabbitHoldsDebugger();
  check("no debugger session was opened while real input is off", heldWhileOff === false, String(heldWhileOff));

  // ---- Opt-in: the student switches real input on; the rabbit escalates only where needed. ----
  await sw.evaluate(async () => {
    const current = (await chrome.storage.local.get("pip.settings"))["pip.settings"] ?? {};
    await chrome.storage.local.set({ "pip.settings": { ...current, trustedInput: true } });
  });
  await page.evaluate(() => (window.__log.length = 0));
  await new Promise((r) => setTimeout(r, 400));

  await ask("hover over the tools menu");
  check("with real input on, an unanswered hover escalates by itself and opens the CSS :hover menu", await menuOpen(12000));
  await idle();

  const heldAfterEscalation = await rabbitHoldsDebugger();
  check("the probe does see the session once the rabbit has escalated", heldAfterEscalation === true, String(heldAfterEscalation));

  await ask("click at 700, 150");
  const plainClick = await logged("canvas-click");
  check("a click that works stays on page events even with real input on", plainClick?.trusted === false, JSON.stringify(plainClick));
  await idle();
  await page.evaluate(() => (window.__log.length = 0));

  await ask("click at 700, 150 for real");
  const realClick = await logged("canvas-click");
  check("an explicit escalation arrives as a trusted click at the same pixel", realClick?.trusted === true && Math.abs(realClick.x - 98) <= 1 && Math.abs(realClick.y - 108) <= 1, JSON.stringify(realClick));
  await idle();

  await ask("drag the blue chip to the answer box for real");
  const realDrop = await logged("drop");
  check("an escalated drag completes a native drag-and-drop", realDrop?.trusted === true && realDrop.data === "chip", JSON.stringify(realDrop));
  await idle();

  await ask("press escape for real");
  const realKey = await logged("keydown");
  check("an escalated key press arrives as a trusted keydown", realKey?.trusted === true && realKey.key === "Escape", JSON.stringify(realKey));
  if (results.includes(false)) console.log("conversation:", await page.evaluate(() => [...document.getElementById("pip-companion-host").shadowRoot.querySelectorAll(".pip-msg")].map((m) => m.textContent)));

  // The screenshot the model aims by must be exactly the viewport's CSS size, whatever the
  // capture's native resolution — that is what makes a pixel it sees the point to click.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  const dims = await ext.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({ type: "screenshot", viewport: { width: 640, height: 400 } });
    if (!r?.ok) return { error: r?.error ?? "no response" };
    const img = new Image();
    img.src = r.dataUrl;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  });
  check("screenshot is resampled to the requested viewport size", dims.width === 640 && dims.height === 400, JSON.stringify(dims));
} catch (e) {
  check("suite ran to completion", false, String(e));
} finally {
  await context.close();
  serverProc.kill();
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
