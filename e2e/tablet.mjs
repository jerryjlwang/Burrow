/**
 * Tablet coach, end to end: the built extension against the server already running on the port
 * (the live Gemini judge when the server has a key; the scripted mock otherwise, which carries
 * the same boxes). The run opens the show-your-work page as the kid's laptop, opens the drawing
 * board through the watcher's test hook, and then:
 *   1. writes "3x + 5 = 20" and the slip "3x = 25" on the board
 *   2. expects the rabbit to hop to that line, ring the "25", and put up a nudge that never
 *      carries the fix
 *   3. leaves the pen still and expects the stall note to rise on his chalkboard
 *   4. fixes the work and expects the ring to clear and the rabbit to celebrate once
 *   5. stops the watch and expects him back on the laptop page
 * Usage: npm run build && node e2e/tablet.mjs      (E2E_PORT to use another port; HEADED=1 to watch)
 */
import { chromium } from "playwright";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extPath = resolve(root, "extension/dist");
const shots = resolve(here, "screenshots");
mkdirSync(shots, { recursive: true });
const PORT = Number(process.env.E2E_PORT) || 8787;
const HEADLESS = process.env.HEADED ? false : true;
const KID_URL = `http://localhost:${PORT}/demo/working.html`;

const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.error(`no server on :${PORT}; start it first (npm run dev:server)`);
  process.exit(1);
}
const live = /^gemini/.test(health.ink ?? "");
console.log(`server on :${PORT}, ink judge: ${health.ink}${live ? "" : " (mock: scripted verdicts)"}`);

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls `fn` until it returns something truthy or the time runs out. */
async function until(fn, timeout, step = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
}
const inHost = (page, fn, arg) => page.evaluate(fn, arg);
const strip = (page) => inHost(page, () => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet")?.getAttribute("data-strip") ?? null);
const bubble = (page) =>
  inHost(page, () => {
    const sr = document.getElementById("pip-companion-host")?.shadowRoot;
    const b = sr?.querySelector(".pip-bubble");
    return b ? { text: b.querySelector(".pip-bubble-text")?.textContent?.trim() ?? "", actions: b.querySelectorAll(".pip-bubble-actions .pip-btn").length } : null;
  });
const rectOf = (page, sel) =>
  inHost(
    page,
    (sel) => {
      const r = document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(sel)?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    },
    sel,
  );
const petBox = (page) => page.evaluate(() => {
  const r = document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet-hit")?.getBoundingClientRect();
  return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
const markBox = (page) => page.evaluate(() => {
  const r = document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pip-inkmark")?.getBoundingClientRect();
  return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
/** The chalkboard once it is fully written: its lines and labels, or null while it is still being written (or absent). */
const boardDone = (page) =>
  inHost(page, () => {
    const sr = document.getElementById("pip-companion-host")?.shadowRoot;
    const b = sr?.querySelector(".pip-board");
    if (!b || !b.classList.contains("complete")) return null;
    const lines = [...b.querySelectorAll(".pip-board-line")].map((l) => l.textContent?.trim() ?? "");
    const labels = [...b.querySelectorAll(".pip-board-label")].map((l) => l.textContent?.trim() ?? "");
    return [...lines, ...labels].filter(Boolean).join(" | ");
  });
/** Out of the hole and standing: a strip that is not a hole or a dive, with a body that measures. */
const standing = async (page) => {
  const s = await strip(page);
  return !!s && !/hole|dive/.test(s) && !!(await petBox(page));
};
const look = (page) => inHost(page, () => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pip-char-btn")?.getAttribute("aria-label") ?? "");
const LEAK = /\b15\b|x\s*=\s*5\b/;
/** The numbers of the kid's own problem; a note that borrows any of them is the worked step in disguise. */
const THEIRS = new Set(["3", "5", "20", "25"]);
const borrowed = (text) => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))).filter((n) => THEIRS.has(n));
/** Offers the page's own proactive engine would make from excalidraw's DOM; none belong on the board. */
const PAGE_OFFER = /leans on|haven't really touched|want a hint|want a quick look|being stubborn/i;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` : "none");

const profileDir = resolve(here, ".profile-tablet");
rmSync(profileDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: HEADLESS,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--no-first-run", "--disable-features=DialMediaRouteProvider", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  viewport: { width: 1280, height: 800 },
});

// Every bubble the board shows, in order, for the report.
const bubbleLog = [];
let logTimer = null;
const logBubbles = (page) => {
  const t0 = Date.now();
  let last = "";
  logTimer = setInterval(async () => {
    const b = await bubble(page).catch(() => null);
    const key = b ? `${b.text}|${b.actions}` : "";
    if (key === last) return;
    last = key;
    bubbleLog.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${b ? `"${b.text}"${b.actions ? ` [${b.actions} buttons]` : ""}` : "(none)"}`);
  }, 250);
};

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check("extension service worker started", !!sw, sw?.url() ?? "no worker");
  if (!sw) throw new Error("no service worker");
  if (PORT !== 8787) await sw.evaluate((url) => chrome.storage.local.set({ "pip.settings": { serverUrl: url } }), `http://localhost:${PORT}`);
  await sleep(1200);
  for (const p of context.pages()) if (p.url().includes("onboarding.html")) await p.close();
  const status = () => sw.evaluate(() => globalThis.__burrowTablet.status());

  // The kid's laptop: the show-your-work page, in front so it is the visible tab that dives.
  const kid = context.pages()[0] ?? (await context.newPage());
  await kid.goto(KID_URL, { waitUntil: "load" });
  await kid.locator("#pip-companion-host").waitFor({ state: "attached", timeout: 15000 });
  check("rabbit is on the kid's page", !!(await until(() => standing(kid), 8000)));
  await kid.bringToFront();

  // Alt+Shift+D, as the background does it: open the board with this tab as the task.
  const boardPromise = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
  const opened = await sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return globalThis.__burrowTablet.open(tab ?? null, { skipDisplay: true });
  }, KID_URL);
  check("the watcher opens the board and starts watching", !!opened?.watching, JSON.stringify({ watching: opened?.watching, contextTab: opened?.contextTabId }));
  const board = await boardPromise;
  check("a board page opened", !!board && /excalidraw\.com/.test(board.url()), board?.url() ?? "none");
  if (!board) throw new Error("no board page");
  const dove = await until(async () => (/hole|dive/.test((await strip(kid)) ?? "") ? true : null), 8000);
  check("the rabbit dives on the kid's page", !!dove, `kid strip: ${await strip(kid)}`);
  await board.waitForLoadState("domcontentloaded");
  await board.waitForSelector("canvas", { timeout: 20000 });
  await board.locator("#pip-companion-host").waitFor({ state: "attached", timeout: 15000 });
  logBubbles(board);
  // The loop logs every decision and result to the console: kept for the report on a failed step.
  const decisions = [];
  board.on("console", (m) => {
    const t = m.text();
    if (/\b(decision|result|locate|run)\b/.test(t) && /pip:(agent|tablet|ui)/.test(t)) decisions.push(t.replace(/%c|color:[^ ]+;font-weight:600 /g, "").slice(0, 300));
  });

  // He pops out on the board once the laptop says he is gone (the tunnel, then his ears, about four seconds).
  const out = await until(() => standing(board), 20000);
  check("the rabbit pops out on the board", !!out, `strip: ${await strip(board)}, ${await look(board)}`);
  check("he arrives calm, not confused or in error", /: idle/.test(await look(board)), await look(board));
  check("he is gone from the kid's page while on the board", !(await petBox(kid)), `kid strip: ${await strip(kid)}`);
  // His arrival line has its say before the writing starts, so the nudge is not queued behind it.
  await until(async () => ((await bubble(board)) ? null : true), 12000);
  const before = await petBox(board);
  await board.screenshot({ path: resolve(shots, "19-tablet-arrived.png") });

  // Write on the board with excalidraw's text tool: the task's first line, then the slip.
  const write = async (x, y, text) => {
    await board.keyboard.press("t");
    await board.mouse.click(x, y);
    await sleep(200);
    await board.keyboard.type(text, { delay: 40 });
    await board.keyboard.press("Escape");
    await sleep(150);
    await board.keyboard.press("Escape");
  };
  await write(320, 220, "3x + 5 = 20");
  await sleep(2500);
  await write(320, 330, "3x = 25");
  await board.mouse.click(900, 700);

  // The nudge: the ring appears on the part, the rabbit stands by the line, the bubble names the step and never the fix.
  const t0 = Date.now();
  const ring = await until(() => markBox(board), 25000);
  const ringMs = Date.now() - t0;
  check("a chalk ring is drawn on the board after the slip", !!ring, ring ? `${ringMs} ms, at ${fmt(ring)}` : "no ring");
  if (ring) {
    // The "25" of "3x = 25" typed at (320, 330) sits around x 365..400, y 318..342 on this viewport.
    const cx = ring.x + ring.width / 2;
    const cy = ring.y + ring.height / 2;
    check("the ring sits on the wrong number, not the whole line", Math.abs(cx - 383) < 45 && Math.abs(cy - 330) < 30 && ring.width < 120, `center ${Math.round(cx)},${Math.round(cy)}`);
  }
  let st = await status();
  let v = st?.lastVerdict;
  check("the judge read the slip on line 2 with boxes", v?.status === "off" && v?.line === 2 && !!v?.box && !!v?.mark, JSON.stringify({ status: v?.status, line: v?.line, box: v?.box, mark: v?.mark, lines: v?.lines, checks: st?.checks, reason: st?.lastReason, rung: st?.lastRung }));
  check("the first nudge is on rung 1", st?.lastRung === 1, `rung ${st?.lastRung} after ${st?.checks} checks`);
  const after = await until(async () => {
    const b = await petBox(board);
    return b && before && Math.hypot(b.x - before.x, b.y - before.y) > 80 ? b : null;
  }, 6000);
  check("the rabbit moved from his corner to the line", !!after, `now ${fmt(after)} (was ${fmt(before)})`);
  if (after) {
    // Beside the line: his feet on its baseline (about y 342) and his body clear of its left edge (x 317).
    const near = Math.abs(after.y + after.height - 342) < 40 && after.x + after.width <= 317 + 6;
    check("he stands beside the line, feet on its baseline, not over it", near, `body ${fmt(after)}`);
  }
  const said = v?.nudge ?? "";
  const offer = await until(async () => {
    const b = await bubble(board);
    return b && (!said || b.text === said) ? b : null;
  }, 10000);
  check("the judge's nudge is up as a plain bubble beside him, no buttons", !!offer && offer.actions === 0, offer ? `"${offer.text}" [${offer.actions} buttons]` : `judge said "${said}", bubble: ${JSON.stringify(await bubble(board))}`);
  check("the nudge names the step, never the fix", !!offer && !LEAK.test(offer.text), offer?.text ?? "");
  check("the nudge carries the rung: a question first", !live || (!!offer && /\?\s*$/.test(offer.text)), offer?.text ?? "");
  await board.screenshot({ path: resolve(shots, "20-tablet-ring.png") });

  // The stall: the pen stays still after a wrong line, so about twenty seconds later the judge is asked again and the note rises.
  const t1 = Date.now();
  const checksBefore = st?.checks ?? 0;
  const rose = await until(() => rectOf(board, ".pip-board"), 45000);
  const roseS = Math.round((Date.now() - t1) / 1000);
  const note = rose ? await until(() => boardDone(board), 15000) : null;
  st = await status();
  check("the chalkboard rises with a note after the pen stays still", !!note, note ? `${roseS} s: ${note.slice(0, 120)}` : `${rose ? "board never finished writing" : "no board"}; ${st?.checks} checks, last ${st?.lastReason} rung ${st?.lastRung}`);
  check("the note uses other numbers, never the fix", !!note && !LEAK.test(note) && borrowed(note).length === 0, note ? `${note}${borrowed(note).length ? ` (borrows ${borrowed(note).join(", ")})` : ""}` : "");
  check("the stall was the only check while the pen rested", (st?.checks ?? 0) - checksBefore === 1 && st?.lastReason === "stall", `${(st?.checks ?? 0) - checksBefore} checks, last ${st?.lastReason}`);
  v = st?.lastVerdict;
  check("the stall verdict carried the note and a spoken line", (v?.note?.length ?? 0) > 0 && !!v?.nudge, JSON.stringify({ note: v?.note, nudge: v?.nudge }));
  const noteBoard = await rectOf(board, ".pip-board");
  const him = await petBox(board);
  check("the note board stands beside him", !!noteBoard && !!him && Math.abs(noteBoard.y + noteBoard.height - (him.y + him.height)) < 60, `board ${fmt(noteBoard)}, rabbit ${fmt(him)}`);
  await board.screenshot({ path: resolve(shots, "21-tablet-note.png") });

  // The fix: clear the board and write the work through to the answer, a line at a time like a kid does.
  await board.mouse.click(900, 700);
  await board.keyboard.press("Control+a");
  await board.keyboard.press("Delete");
  await sleep(800);
  await write(320, 220, "3x + 5 = 20");
  await sleep(1500);
  await write(320, 300, "3x = 15");
  await sleep(1500);
  await write(320, 380, "x = 5");
  await board.mouse.click(900, 700);
  const cheered = await until(
    async () => {
      const s = await strip(board);
      const b = await bubble(board);
      return s === "celebrate" || /nice|that's it/i.test(b?.text ?? "") ? `${s} / ${b?.text ?? ""}` : null;
    },
    30000,
    150,
  );
  st = await status();
  check("the rabbit celebrates once the work is solved", !!cheered, cheered ?? `strip ${await strip(board)}, bubble ${JSON.stringify(await bubble(board))}, verdict ${JSON.stringify(st?.lastVerdict?.lines)}`);
  const ringGone = await until(async () => ((await markBox(board)) ? null : true), 5000);
  check("the ring is gone once the line is right", !!ringGone);
  check("the note board is gone once the work is solved", !(await rectOf(board, ".pip-board")));
  v = st?.lastVerdict;
  check("the judge saw the work solved", v?.solved === true, JSON.stringify({ status: v?.status, solved: v?.solved, lines: v?.lines }));
  await board.screenshot({ path: resolve(shots, "22-tablet-solved.png") });

  // His own awareness on the board: he knows where he stands and what the laptop shows, without the judge's help.
  {
    const replies = () => inHost(board, () => [...(document.getElementById("pip-companion-host")?.shadowRoot?.querySelectorAll(".pip-msg.companion") ?? [])].map((m) => m.textContent ?? ""));
    const ask = async (text) => {
      const n = (await replies()).length;
      await board.locator(".pip-input").fill(text);
      await board.locator(".pip-send").click();
      const reply = await until(async () => {
        const r = await replies();
        return r.length > n ? r[r.length - 1] : null;
      }, 30000, 400);
      return reply ?? "(no reply)";
    };
    await inHost(board, () => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pip-char-btn")?.click());
    await board.locator(".pip-panel").waitFor({ timeout: 5000 }).catch(() => null);
    const what = await ask("What problem was I working on?");
    check("asked on the board, he names the problem from the laptop page", /3x|\b20\b|equation|solve for x/i.test(what), what);
    check("he does not mistake the drawing app for the task", !/excalidraw|hand tool|keyboard shortcut|toolbar|canvas/i.test(what), what);
    const where = await ask("Where are you right now?");
    check("he knows he is on the tablet", /tablet|drawing board|whiteboard|your board|beside your (work|writing|ink)/i.test(where), where);
    // Circling on request: the model asks the tablet to find the part, and the coach rings it.
    const t2 = Date.now();
    const circled = await ask("Circle my final answer for me.");
    const ringOnAsk = await until(() => markBox(board), 20000);
    check("asked to circle something, he rings it in the handwriting", !!ringOnAsk, ringOnAsk ? `${Math.round((Date.now() - t2) / 1000)} s, ring at ${fmt(ringOnAsk)}; said "${circled}"` : `no ring; said "${circled}"; decisions: ${decisions.slice(-6).join(" || ")}`);
    // "x = 5" was written at (320, 380): its ring should sit around y 380, not on the earlier lines.
    check("the requested ring sits on the final answer's line", !!ringOnAsk && Math.abs(ringOnAsk.y + ringOnAsk.height / 2 - 380) < 40, ringOnAsk ? fmt(ringOnAsk) : "none");
    await inHost(board, () => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pip-char-btn")?.click());
    await board.screenshot({ path: resolve(shots, "24-tablet-aware.png") });
  }

  // Stop: he leaves the board and pops back out on the laptop page.
  await sw.evaluate(() => globalThis.__burrowTablet.stop(true));
  const back = await until(() => standing(kid), 20000);
  check("stopping the watch brings him back to the kid's page", !!back, `kid strip: ${await strip(kid)}`);
  await kid.screenshot({ path: resolve(shots, "23-tablet-back.png") });
} catch (e) {
  check("run completed without an exception", false, String(e?.stack ?? e));
} finally {
  if (logTimer) clearInterval(logTimer);
  await context.close().catch(() => null);
}

check("no page offer from excalidraw's own DOM ever showed on the board", !bubbleLog.some((l) => PAGE_OFFER.test(l)), bubbleLog.filter((l) => PAGE_OFFER.test(l)).join("; "));
if (bubbleLog.length) console.log(`\nbubbles on the board:\n  ${bubbleLog.join("\n  ")}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
