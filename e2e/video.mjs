/**
 * End-to-end check of watching a video along with the student (demo mode, no model, no network):
 *   1. the rabbit says nothing while the lesson plays, then asks ONCE whether it may watch along
 *   2. with that standing permission it stays silent until the idea the lesson hangs on — then
 *      pauses the video itself and says it
 *   3. the bubble holds long enough to read; "Got it" resumes playback
 *   4. a question about the video is answered from the transcript, with the exact frame attached,
 *      and never with "let me look at the frame"
 * Usage: npm run build && node e2e/video.mjs   (E2E_PORT to run beside a live server)
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extPath = resolve(root, "extension/dist");
const shots = resolve(here, "screenshots");
mkdirSync(shots, { recursive: true });
const PORT = Number(process.env.E2E_PORT) || 8798;
const HEADLESS = process.env.HEADED ? false : true;

if (!existsSync(resolve(extPath, "manifest.json"))) {
  console.error("extension/dist not found — run `npm run build` first");
  process.exit(1);
}

const serverLog = [];
const serverProc = spawn(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "server/src/index.ts")], {
  env: { ...process.env, DEMO_MODE: "1", PORT: String(PORT), DEEPGRAM_API_KEY: "", SUPADATA_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [serverProc.stdout, serverProc.stderr]) stream.on("data", (d) => serverLog.push(String(d)));
for (let i = 0; i < 60; i++) {
  if (await fetch(`http://localhost:${PORT}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 250));
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const profileDir = resolve(here, ".profile-video");
rmSync(profileDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: HEADLESS,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--no-first-run", "--mute-audio", "--autoplay-policy=no-user-gesture-required"],
  viewport: { width: 1280, height: 800 },
});

const browserLog = [];
context.on("console", (m) => browserLog.push(`[page] ${m.text()}`));
context.on("weberror", (e) => browserLog.push(`[page error] ${e.error()}`));
context.on("serviceworker", (w) => w.on("console", (m) => browserLog.push(`[sw] ${m.text()}`)));

const video = (page) => page.evaluate(() => { const v = document.getElementById("lesson"); return { t: v.currentTime, paused: v.paused, ready: v.readyState, duration: v.duration }; });
const bubble = (page) => page.evaluate(() => { const b = document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pip-bubble"); return b ? { text: b.querySelector(".pip-bubble-text")?.textContent ?? "", buttons: [...b.querySelectorAll(".pip-btn")].map((x) => x.textContent) } : null; });
const turns = (sw) => sw.evaluate(async () => { const all = await chrome.storage.session.get(null); return Object.values(all).flatMap((s) => s?.conversation ?? []).filter((t) => t.role === "companion").map((t) => t.text); });
const until = async (fn, ms, every = 250) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, every)); } };

try {
  let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null));
  check("extension service worker started", !!sw);
  await sw.evaluate(() => chrome.storage.local.remove("pip.graph"));
  await new Promise((r) => setTimeout(r, 1200));
  for (const p of context.pages()) if (p.url().includes("onboarding.html")) await p.close();
  // Written only after the first-install onboarding tab is gone: it saves settings of its own, and
  // a clobbered serverUrl silently points the extension at whatever is running on the default port.
  await sw.evaluate((url) => chrome.storage.local.set({ "pip.settings": { serverUrl: url, ttsEnabled: false, onboarded: true } }), `http://localhost:${PORT}`);
  const pointed = await sw.evaluate(async () => (await chrome.storage.local.get("pip.settings"))["pip.settings"]?.serverUrl);
  check("extension is pointed at this test's server", pointed === `http://localhost:${PORT}`, String(pointed));

  // ---- 1. First video ever: silent, then one ask for standing permission ----
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`http://localhost:${PORT}/demo/video.html`, { waitUntil: "load" });
  await page.locator("#pip-companion-host").waitFor({ state: "attached", timeout: 15000 });
  await page.evaluate(() => { const v = document.getElementById("lesson"); v.muted = true; return v.play(); });
  const playing = await until(async () => (await video(page)).t > 1, 10_000);
  check("the demo lesson plays", !!playing, JSON.stringify(await video(page)));

  await until(async () => (await video(page)).t >= 17, 25_000);
  const early = await bubble(page);
  check("says nothing while the lesson is simply playing", early === null, early ? `bubble: ${early.text}` : `t=${(await video(page)).t.toFixed(1)}`);

  const consent = await until(async () => { const b = await bubble(page); return b && /watch along/i.test(b.text) ? b : null; }, 12_000);
  check("asks once for standing permission to watch along", !!consent, consent ? consent.buttons.join(" | ") : "no consent bubble");
  check("does not pause the video without that permission", !(await video(page)).paused);
  await page.screenshot({ path: resolve(shots, "20-video-consent.png") });
  await page.locator(".pip-bubble .pip-btn", { hasText: "Sure" }).click();
  const setting = await until(() => sw.evaluate(async () => (await chrome.storage.local.get("pip.settings"))["pip.settings"]?.videoCompanion === "on"), 4000);
  check("'Sure' becomes a standing permission", !!setting);

  // ---- 2. With permission: silent until the crucial idea, then the rabbit pauses the video itself ----
  await page.reload({ waitUntil: "load" });
  await page.locator("#pip-companion-host").waitFor({ state: "attached", timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2500)); // captions load + the one-time analysis
  await page.evaluate(() => { const v = document.getElementById("lesson"); v.muted = true; return v.play(); });
  await until(async () => (await video(page)).t >= 16, 25_000);
  const quiet = await bubble(page);
  check("stays silent through the ordinary part of the lesson", quiet === null, quiet ? `bubble: ${quiet.text}` : "");

  const paused = await until(async () => { const v = await video(page); return v.paused && v.t > 5 ? v : null; }, 15_000);
  check("pauses the video right after the idea the lesson hangs on", !!paused && paused.t >= 19.5 && paused.t <= 22, paused ? `paused at ${paused.t.toFixed(1)}s` : `still playing at ${(await video(page)).t.toFixed(1)}s`);
  const said = await until(async () => { const b = await bubble(page); return b && /one side/i.test(b.text) ? b : null; }, 5000);
  check("says the idea itself, with a way to carry on and a way to go deeper", !!said && said.buttons.length === 2, said ? `"${said.text}" [${said.buttons.join(" | ")}]` : "no bubble");
  await page.screenshot({ path: resolve(shots, "21-video-interrupt.png") });

  // ---- 3. The bubble holds; "Got it" resumes ----
  await new Promise((r) => setTimeout(r, 4000));
  const still = await bubble(page);
  check("the bubble stays up long enough to read", !!still && /one side/i.test(still.text));
  check("the video stays paused while it does", (await video(page)).paused);
  await page.locator(".pip-bubble .pip-btn", { hasText: "Got it" }).click();
  const resumed = await until(async () => !(await video(page)).paused, 4000);
  check("'Got it' resumes the video", !!resumed);
  check("and the bubble is gone", (await bubble(page)) === null);

  // ---- 4. A question about the video: answered from the transcript, frame attached, no "analyzing" ----
  await until(async () => (await video(page)).t >= 29, 15_000);
  await page.evaluate(() => document.getElementById("pip-companion-host").shadowRoot.querySelector(".pip-char-btn").click());
  await page.locator(".pip-input").fill("wait what did he just say");
  await page.locator(".pip-input").press("Enter");
  const answer = await until(async () => (await turns(sw)).find((t) => /divide both sides|take away three/i.test(t)), 10_000);
  check("answers from what was just said in the video", !!answer, answer ?? (await turns(sw)).slice(-2).join(" / "));
  check("never narrates looking at the frame", !(await turns(sw)).some((t) => /analy[sz]|looking at the (frame|video)|screenshot/i.test(t)));
  const decideLine = serverLog.join("").split("\n").find((l) => l.includes("decide") && l.includes("videoAt"));
  check("the agent was given the video position, transcript and exact frame", !!decideLine && /"transcript":true/.test(decideLine) && /"frame":true/.test(decideLine), decideLine?.slice(0, 200) ?? "no decide log with video context");
  const analysed = serverLog.join("").split("\n").filter((l) => l.includes("analyzed"));
  check("the video was analysed once, from the page's own captions, across both loads", analysed.length === 1 && /"transcript":"page"/.test(analysed[0]), `${analysed.length} analyses`);
} catch (e) {
  check("video e2e ran to completion", false, String(e).slice(0, 300));
} finally {
  await context.close().catch(() => undefined);
  serverProc.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log([...serverLog.join("").split("\n"), ...browserLog].filter((l) => /video|decide|error|fail/i.test(l)).slice(-25).join("\n"));
process.exit(failed.length ? 1 : 0);
