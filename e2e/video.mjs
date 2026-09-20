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
  // Own process group: tsx runs the server in a child, and killing only the wrapper leaves that
  // child listening, so the next run would silently talk to a stale server.
  detached: true,
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

  // ---- 4b. The answered question earns ONE related-video banner with a working link ----
  const reco = await until(async () => { const b = await bubble(page); return b && /another video/i.test(b.text) ? b : null; }, 12_000);
  check("a question about the video earns a related-video banner", !!reco && reco.buttons.includes("Watch"), reco ? `"${reco.text}" [${reco.buttons.join(" | ")}]` : "no banner");
  if (reco) await page.locator(".pip-bubble .pip-btn", { hasText: "No thanks" }).click().catch(() => null);
  await until(async () => (await bubble(page)) === null, 4000);

  // ---- 5. A drawing on a video page goes INTO the picture's empty space, solid and legible ----
  await page.evaluate(() => document.getElementById("lesson").pause());
  await page.locator(".pip-input").fill("can you draw a right triangle?");
  await page.locator(".pip-input").press("Enter");
  await page.locator(".pip-sketch").waitFor({ timeout: 12_000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 6500)); // staged reveal (650ms per item) + draw-in
  const drawn = await page.evaluate(() => {
    const root = document.getElementById("pip-companion-host").shadowRoot;
    const board = root.querySelector(".pip-sketch");
    const v = document.getElementById("lesson").getBoundingClientRect();
    if (!board) return null;
    const b = board.getBoundingClientRect();
    const strokes = [...root.querySelectorAll(".pip-sketch-canvas path, .pip-sketch-canvas circle, .pip-sketch-canvas rect")];
    return {
      placement: board.getAttribute("data-placement"),
      inside: b.left >= v.left - 1 && b.top >= v.top - 1 && b.right <= v.right + 1 && b.bottom <= v.bottom + 1,
      cover: +((b.width * b.height) / (v.width * v.height)).toFixed(2),
      strokes: strokes.length,
      dashed: strokes.filter((el) => getComputedStyle(el).strokeDasharray !== "none").length,
      longest: Math.round(Math.max(0, ...strokes.map((el) => el.getTotalLength?.() ?? 0))),
      labels: [...root.querySelectorAll(".pip-sketch-label")].map((l) => l.textContent).join(" "),
    };
  });
  check("the drawing lands inside the video picture, not in the corner", !!drawn && drawn.placement === "video" && drawn.inside, JSON.stringify(drawn));
  check("strokes are solid once drawn: none left dashed, even ones longer than 100px", !!drawn && drawn.strokes >= 6 && drawn.dashed === 0 && drawn.longest > 100, drawn ? `${drawn.strokes} strokes, ${drawn.dashed} dashed, longest ${drawn.longest}px` : "");
  await page.screenshot({ path: resolve(shots, "22-video-sketch.png") });

  // ---- 6. The drawing is the student's: it survives the video resuming, moves when dragged, and goes only when asked ----
  const boardState = () => page.evaluate(() => {
    const root = document.getElementById("pip-companion-host").shadowRoot;
    const board = root.querySelector(".pip-sketch");
    if (!board) return null;
    const b = board.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), strokes: root.querySelectorAll(".pip-sketch-canvas path, .pip-sketch-canvas circle, .pip-sketch-canvas rect").length, labels: root.querySelectorAll(".pip-sketch-label").length, hot: root.querySelector(".pip-sketch-box")?.getAttribute("data-hot") };
  });
  await page.evaluate(() => document.getElementById("lesson").play());
  await new Promise((r) => setTimeout(r, 3000));
  const afterResume = await boardState();
  check("resuming the video does not erase the drawing", !!afterResume && afterResume.strokes >= 6 && !(await video(page)).paused, JSON.stringify(afterResume));

  // Click-through: a click in the middle of the drawing reaches the video underneath (native controls toggle play).
  const before = await boardState();
  const mid = await page.evaluate(() => { const b = document.getElementById("pip-companion-host").shadowRoot.querySelector(".pip-sketch").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.click(mid.x, mid.y);
  const toggled = await until(async () => (await video(page)).paused, 3000);
  check("the inside of the drawing is click-through: the video underneath still pauses", !!toggled);

  await page.locator(".pip-input").fill("get rid of the labels");
  await page.locator(".pip-input").press("Enter");
  const partial = await until(async () => { const b = await boardState(); return b && b.labels === 0 ? b : null; }, 10_000);
  check("'get rid of the labels' erases just the labels and leaves the rest where it was", !!partial && partial.strokes === before.strokes && partial.x === before.x && partial.y === before.y, JSON.stringify({ before, partial }));

  const grip = await page.locator(".pip-sketch-grip").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  const hovered = await until(async () => (await boardState())?.hot === "true", 2000);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 150, grip.y + grip.height / 2 + 60, { steps: 8 });
  await page.screenshot({ path: resolve(shots, "23-video-sketch-dragging.png") });
  await page.mouse.up();
  const moved = await boardState();
  check("hovering the grip shows the bounding box", !!hovered);
  check("dragging the box moves the whole drawing", !!moved && Math.abs(moved.x - (before.x - 150)) <= 2 && Math.abs(moved.y - (before.y + 60)) <= 2, JSON.stringify({ from: { x: before.x, y: before.y }, to: moved && { x: moved.x, y: moved.y } }));

  await page.locator(".pip-input").fill("ok erase the drawing");
  await page.locator(".pip-input").press("Enter");
  const gone = await until(async () => (await boardState()) === null, 10_000);
  check("'erase the drawing' removes it", !!gone);

  // ---- 7. Working the player: the whole transcript is searchable (ahead of the student too), and "pause" needs no model ----
  const say = async (text) => {
    await page.locator(".pip-input").fill(text);
    await page.locator(".pip-input").press("Enter");
  };
  await say("skip to 0:05");
  const jumped = await until(async () => { const v = await video(page); return v.t >= 4.5 && v.t < 12 ? v : null; }, 10_000);
  check("'skip to 0:05' seeks the video there", !!jumped, JSON.stringify(await video(page)));
  await say("skip to where he says divide both sides");
  const found = await until(async () => { const v = await video(page); return v.t >= 19.5 && v.t < 30 ? v : null; }, 10_000);
  check("a part of the video still ahead is found in the transcript and jumped to", !!found, JSON.stringify(await video(page)));
  const landed = await until(async () => (await turns(sw)).find((t) => /that's at 0:20/i.test(t)), 6000);
  check("and the rabbit says where it landed", !!landed, landed ?? (await turns(sw)).slice(-2).join(" / "));
  await page.evaluate(() => document.getElementById("lesson").play());
  await until(async () => !(await video(page)).paused, 4000);
  const decidesBefore = serverLog.join("").split("\n").filter((l) => l.includes("decide")).length;
  await say("pause");
  const paused2 = await until(async () => ((await video(page)).paused ? true : null), 4000);
  check("'pause' over a playing video pauses it", !!paused2);
  check("without a model round trip", serverLog.join("").split("\n").filter((l) => l.includes("decide")).length === decidesBefore);
  await say("play");
  check("'play' resumes it", !!(await until(async () => (!(await video(page)).paused ? true : null), 8000)));
} catch (e) {
  check("video e2e ran to completion", false, String(e).slice(0, 300));
} finally {
  await context.close().catch(() => undefined);
  try {
    process.kill(-serverProc.pid);
  } catch {
    serverProc.kill();
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log([...serverLog.join("").split("\n"), ...browserLog].filter((l) => /video|decide|error|fail/i.test(l)).slice(-25).join("\n"));
process.exit(failed.length ? 1 : 0);
