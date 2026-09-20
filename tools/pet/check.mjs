// Drives the built extension in Playwright Chromium on a light and a dark page, forces every pet state
// through the debug panel, checks the sprite and movement rules on a real page, and saves screenshots
// to tools/pet/shots. Usage: node extension/build.mjs && node tools/pet/check.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extPath = resolve(root, "extension/dist");
const out = resolve(root, "tools/pet/shots");
const profileDir = resolve(out, ".profile");
mkdirSync(out, { recursive: true });
if (!existsSync(resolve(extPath, "manifest.json"))) {
  console.error("extension/dist not found. Run node extension/build.mjs first.");
  process.exit(1);
}

const VW = 1280;
const VH = 800;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` : ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function pageHtml(theme) {
  const dark = theme === "dark";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${theme} page</title>
<style>
  body { margin: 0; font: 16px/1.5 Georgia, serif; background: ${dark ? "#0f1115" : "#ffffff"}; color: ${dark ? "#e8e8ee" : "#1a1a1a"}; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
  h1 { font-size: 34px; margin: 0 0 12px; }
  p { margin: 0 0 14px; }
  #count { position: fixed; left: 16px; top: 16px; font: 14px monospace; padding: 6px 10px; border: 1px solid ${dark ? "#444" : "#ccc"}; border-radius: 6px; }
  #corner { position: fixed; right: 0; bottom: 0; width: 420px; height: 320px; background: ${dark ? "#1b2030" : "#eef2ff"}; z-index: 0; }
</style></head><body>
<div id="corner"></div>
<main>
<h1>Why did castles have moats?</h1>
<p>A moat is a deep, wide ditch dug around a castle. Many were filled with water, but plenty were dry.</p>
<p>Attackers wanted to dig tunnels under the walls to make them collapse. A moat made that nearly impossible.</p>
<p>It also kept siege towers and battering rams away from the gate.</p>
<p>This is the ${theme} test page for the White Rabbit sprite player.</p>
</main>
<div id="count">page clicks: 0</div>
<script>
  let n = 0;
  document.addEventListener("click", () => { n++; document.getElementById("count").textContent = "page clicks: " + n; window.__clicks = n; });
  window.__clicks = 0;
</script>
</body></html>`;
}

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--no-first-run", "--disable-features=DialMediaRouteProvider"],
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 1,
});

const consoleLines = [];
try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
  check("service worker started", !!sw, sw?.url() ?? "none");
  await wait(1200);
  for (const p of context.pages()) if (p.url().includes("onboarding.html")) await p.close();
  // Debug mode shows the panel with the pet buttons; onboarded stops the first-run tab.
  await sw.evaluate(() => chrome.storage.local.set({ "pip.settings": { debugMode: true, onboarded: true, proactiveEnabled: false, voiceAutoResume: false } }));
  const extId = new URL(sw.url()).host;

  await context.route("http://pet.test/**", (route) => {
    const theme = route.request().url().includes("dark") ? "dark" : "light";
    route.fulfill({ status: 200, contentType: "text/html", body: pageHtml(theme) });
  });

  for (const theme of ["light", "dark"]) {
    const page = await context.newPage();
    page.on("console", (m) => consoleLines.push(`[${theme}] ${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => consoleLines.push(`[${theme}] pageerror: ${e.message}`));
    await page.goto(`http://pet.test/${theme}`, { waitUntil: "load" });
    await page.locator("#pip-companion-host").waitFor({ state: "attached", timeout: 15000 });
    await page.locator(".pet-canvas").waitFor({ state: "attached", timeout: 15000 });
    await page.locator(".pip-debug-pet").first().waitFor({ timeout: 10000 });
    await wait(600);

    const btn = (label) => page.getByRole("button", { name: label, exact: true });
    const hitBox = () => page.locator(".pet-hit").boundingBox();
    const petBox = () => page.locator(".pet").boundingBox();
    const canvasBox = () => page.locator(".pet-canvas").boundingBox();
    const phase = () => page.locator(".pet").getAttribute("data-phase");
    const waitPhase = (want, timeout = 6000) => page.waitForFunction((w) => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet")?.dataset.phase === w, want, { timeout }).then(() => true, () => false);
    /** Poll the phase until it returns to "", recording every value seen. */
    const watchPhases = async (timeout = 6000) => {
      const seen = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const ph = await phase();
        seen.add(ph);
        if (ph === "" && seen.size > 1) break;
        await wait(40);
      }
      return seen;
    };
    const shot = async (name) => {
      const file = resolve(out, `${theme}-${name}.png`);
      await page.screenshot({ path: file });
      const box = await canvasBox();
      if (box) {
        const clip = { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 60), width: Math.min(VW, box.width + 120), height: Math.min(VH, box.height + 120) };
        if (clip.x + clip.width > VW) clip.width = VW - clip.x;
        if (clip.y + clip.height > VH) clip.height = VH - clip.y;
        await page.screenshot({ path: resolve(out, `${theme}-${name}-zoom.png`), clip });
      }
      return file;
    };

    const canvas = await canvasBox();
    const hit = await hitBox();
    check(`${theme}: canvas is a whole multiple of the cell`, canvas && canvas.width === 192 && canvas.height === 174, JSON.stringify(canvas));
    const attrs = await page.locator(".pet-canvas").evaluate((c) => ({ w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, cssH: c.getBoundingClientRect().height, smoothing: c.getContext("2d").imageSmoothingEnabled, rendering: getComputedStyle(c).imageRendering }));
    check(`${theme}: canvas backing store equals its CSS size, smoothing off, pixelated`, attrs.w === attrs.cssW && attrs.h === attrs.cssH && attrs.smoothing === false && attrs.rendering === "pixelated", JSON.stringify(attrs));
    check(`${theme}: hit area is the body box`, hit && Math.round(hit.width) === 93 && Math.round(hit.height) === 159, JSON.stringify(hit));
    check(`${theme}: rabbit sits 18px from the right edge`, hit && Math.round(VW - (hit.x + hit.width)) === 18, JSON.stringify({ right: VW - (hit.x + hit.width) }));

    await shot("01-idle");
    await btn("listening").click();
    await wait(700);
    await shot("02-listening");
    await btn("thinking").click();
    await wait(1100); // from_listening then to_thinking first
    await shot("03-thinking");
    await btn("speaking loud").click();
    await wait(1100); // thinking exits through aha first
    await shot("04-speaking-loud");
    await btn("celebrating").click();
    await wait(260);
    await shot("05-celebrate");
    await wait(1400);
    await btn("confused").click();
    await wait(700);
    await shot("06-confused");
    await btn("sleeping").click();
    await wait(1200);
    await shot("07-sleepy");
    await btn("idle").click();
    await wait(800);

    // Clicks in the transparent margin of the canvas must reach the page.
    const before = await page.evaluate(() => window.__clicks);
    await page.mouse.click(canvas.x + 20, hit.y + hit.height / 2);
    await wait(200);
    const after = await page.evaluate(() => window.__clicks);
    const panelAfterMargin = await page.locator(".pip-panel").count();
    check(`${theme}: click in the transparent margin reaches the page and does not open the panel`, after === before + 1 && panelAfterMargin === 0, `clicks ${before} -> ${after}, panels ${panelAfterMargin}`);

    // Click on the body opens the panel.
    await page.mouse.click(hit.x + hit.width / 2, hit.y + hit.height / 2);
    await page.locator(".pip-panel").waitFor({ timeout: 5000 });
    await wait(400);
    const panelBox = await page.locator(".pip-panel").boundingBox();
    const hitNow = await hitBox();
    check(`${theme}: panel sits above the rabbit without overlap`, panelBox && hitNow && panelBox.y + panelBox.height <= hitNow.y + 1 && panelBox.x + panelBox.width <= VW && panelBox.y >= 0, JSON.stringify({ panelBox, hitNow }));
    await shot("08-panel-open");
    await page.keyboard.press("Escape");
    await wait(300);
    check(`${theme}: escape closes the panel`, (await page.locator(".pip-panel").count()) === 0);

    // The speech bubble with its pixel frame, tail and buttons.
    await btn("show bubble").click();
    await page.locator(".pip-bubble").waitFor({ timeout: 3000 });
    await wait(400);
    const bubbleBox = await page.locator(".pip-bubble").boundingBox();
    const hitB = await hitBox();
    check(`${theme}: bubble sits above the rabbit with whole-pixel frame width`, bubbleBox && hitB && bubbleBox.y + bubbleBox.height <= hitB.y + 30 && Math.round(bubbleBox.width) % 3 === 0, JSON.stringify({ bubbleBox, hitB }));
    await shot("29-bubble");
    await btn("hide bubble").click();
    await wait(300);
    check(`${theme}: bubble can be cleared`, (await page.locator(".pip-bubble").count()) === 0);

    // Drag: pointer capture on the body, dragged strip while moving, no panel toggle on release.
    // Slow moves so the release is a drop, not a throw.
    const h0 = await hitBox();
    await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(h0.x + h0.width / 2 - 30 * i, h0.y + h0.height / 2 - 20 * i);
      await wait(40);
    }
    await wait(350);
    await shot("09-dragging");
    const dragClass = await page.locator(".pet").getAttribute("class");
    await page.mouse.up();
    await wait(400);
    const h1 = await hitBox();
    const moved = h1 && Math.round(h0.x - h1.x) === 360 && Math.round(h0.y - h1.y) === 240;
    check(`${theme}: a slow drag moves the rabbit by the pointer delta and showed the dragged strip`, moved && /dragging/.test(dragClass ?? ""), JSON.stringify({ h0, h1, dragClass }));
    check(`${theme}: releasing a drag does not open the panel`, (await page.locator(".pip-panel").count()) === 0);
    await shot("10-after-drag");
    // Panel opens where the rabbit now is.
    await page.mouse.click(h1.x + h1.width / 2, h1.y + h1.height / 2);
    await page.locator(".pip-panel").waitFor({ timeout: 5000 });
    await wait(400);
    const pb2 = await page.locator(".pip-panel").boundingBox();
    check(`${theme}: panel follows the dragged rabbit`, pb2 && pb2.y + pb2.height <= h1.y + 1 && Math.abs(pb2.x + pb2.width - (h1.x + h1.width)) < 2, JSON.stringify({ pb2, h1 }));
    await shot("11-panel-after-drag");
    await page.keyboard.press("Escape");
    await wait(300);

    // Drag to the top-left: the panel must stay on screen and clear of the rabbit.
    const h2 = await hitBox();
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(h2.x + h2.width / 2 - 200 * i, h2.y + h2.height / 2 - 30 * i);
      await wait(40);
    }
    await wait(250);
    await page.mouse.up();
    await wait(400);
    const h3 = await hitBox();
    check(`${theme}: drag clamps the body inside the viewport`, h3 && h3.x >= 0 && h3.y + h3.height <= VH, JSON.stringify(h3));
    await page.mouse.click(h3.x + h3.width / 2, h3.y + h3.height / 2);
    await page.locator(".pip-panel").waitFor({ timeout: 5000 });
    await wait(400);
    const pb3 = await page.locator(".pip-panel").boundingBox();
    const onOneSide = pb3 && h3 && (pb3.y + pb3.height <= h3.y + 1 || pb3.y >= h3.y + h3.height - 1);
    check(`${theme}: panel stays on screen and clear of the rabbit at the top-left`, pb3 && pb3.x >= 0 && pb3.y >= 0 && pb3.y + pb3.height <= VH && onOneSide, JSON.stringify({ pb3, h3 }));
    await shot("12-panel-left-edge");
    await page.keyboard.press("Escape");
    await wait(300);

    // Hole travel back to the right through the imperative API (debug button).
    await btn("hop across").click();
    await wait(520);
    await shot("13-hole-dive");
    await wait(1250);
    await shot("14-hole-wait");
    await wait(1800);
    await shot("15-after-moveto");
    const h4 = await hitBox();
    check(`${theme}: moveTo landed on the right side`, h4 && h4.x + h4.width / 2 > VW / 2, JSON.stringify(h4));

    // Jump out then jump in.
    await btn("jump out").click();
    await wait(1600);
    const goneClass = await page.locator(".pet").getAttribute("class");
    const hitHidden = await page.locator(".pet-hit").evaluate((el) => getComputedStyle(el).display === "none");
    check(`${theme}: jumpOut hides the rabbit and its hit area`, /gone/.test(goneClass ?? "") && hitHidden, goneClass ?? "");
    await shot("16-jumped-out");
    await btn("jump in (1.5 s)").click();
    await wait(900);
    await shot("17-jump-in-waiting");
    await wait(2200);
    await shot("18-jumped-in");
    check(`${theme}: jumpIn restores the hit area`, !/gone/.test((await page.locator(".pet").getAttribute("class")) ?? ""));

    // Reduced motion and attention still change states.
    await btn("reduced motion").click();
    await btn("attention 2").click();
    await wait(700);
    await shot("19-attention-2-reduced");
    await btn("attention 0").click();
    await btn("reduced motion").click();
    await wait(600);
    await btn("wave").click();
    await wait(350);
    await shot("20-wave");
    await wait(900);

    /* ---------- movement ---------- */

    // Hops: whole multiples of the scale on the way, exact landing, then land.
    const g0 = await hitBox();
    const startCenter = g0.x + g0.width / 2;
    await btn("hop left").click();
    const seenX = [];
    let midShot = false;
    for (let i = 0; i < 14; i++) {
      await wait(50);
      const b = await hitBox();
      seenX.push(b.x);
      if (!midShot && i === 4) {
        await shot("21-hop-mid");
        midShot = true;
      }
    }
    const hopPhases = await watchPhases();
    const g1 = await hitBox();
    const deltas = seenX.map((x) => Math.round(x - g0.x));
    const wholeSteps = deltas.every((d) => d % 3 === 0);
    const landedLeft = Math.abs(g1.x + g1.width / 2 - (startCenter - 150)) <= 1;
    check(`${theme}: hop left moves in whole multiples of the scale and lands within 1px of the target`, wholeSteps && landedLeft && hopPhases.has("hop") && hopPhases.has("land"), JSON.stringify({ deltas, landedAt: g1.x + g1.width / 2, wanted: startCenter - 150, phases: [...hopPhases] }));
    await shot("22-after-hop");
    await btn("hop right").click();
    await watchPhases();
    const g2 = await hitBox();
    check(`${theme}: hop right lands back within 1px of the start`, Math.abs(g2.x + g2.width / 2 - startCenter) <= 1, JSON.stringify({ landedAt: g2.x + g2.width / 2, wanted: startCenter }));

    // Throw: simulated fling to the left ends on the floor, inside the viewport, after land.
    await btn("throw").click();
    await wait(300);
    const flyPhase = await phase();
    await shot("23-flight-mid");
    const flightPhases = await watchPhases(6000);
    const g3 = await hitBox();
    const petAfterFlight = await petBox();
    const onFloor = petAfterFlight && Math.round(petAfterFlight.y + petAfterFlight.height) === VH - 18;
    check(`${theme}: a fling flies, lands with the feet on the resting line inside the viewport, and plays land`, flyPhase === "fly" && onFloor && g3.x >= 0 && g3.x + g3.width <= VW && flightPhases.has("land") && (await phase()) === "", JSON.stringify({ flyPhase, g3, petBottom: petAfterFlight?.y + petAfterFlight?.height, phases: [...flightPhases] }));
    await shot("24-after-landing");

    // A real fling with the mouse: fast release.
    const f0 = await hitBox();
    await page.mouse.move(f0.x + f0.width / 2, f0.y + f0.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(f0.x + f0.width / 2 - 40 * i, f0.y + f0.height / 2 - 30 * i);
    await page.mouse.up();
    await wait(120);
    const mousePhase = await phase();
    await watchPhases(6000);
    check(`${theme}: a fast mouse release becomes a throw`, mousePhase === "fly" || mousePhase === "land", `phase after release: ${mousePhase}`);

    // Slow-drag him back to the right so he does not sit on the debug panel for the rest of the run.
    const d0 = await hitBox();
    await page.mouse.move(d0.x + d0.width / 2, d0.y + d0.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(d0.x + d0.width / 2 + ((1000 - (d0.x + d0.width / 2)) * i) / 10, d0.y + d0.height / 2 + ((693 - (d0.y + d0.height / 2)) * i) / 10);
      await wait(30);
    }
    await wait(300);
    await page.mouse.up();
    await wait(500);

    // Resize through the hole keeps the feet line.
    const s0 = await petBox();
    await btn("grow 4x").click();
    await page.waitForFunction(() => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet")?.dataset.scale === "4", null, { timeout: 8000 }).catch(() => null);
    await wait(2600);
    const s4 = await petBox();
    const c4 = await canvasBox();
    check(`${theme}: grow 4x keeps the feet line and draws a 256 x 232 canvas`, c4 && c4.width === 256 && c4.height === 232 && s0 && s4 && Math.round(s0.y + s0.height) === Math.round(s4.y + s4.height), JSON.stringify({ c4, before: s0.y + s0.height, after: s4.y + s4.height }));
    await shot("25-scale-4x");
    await btn("shrink 2x").click();
    await page.waitForFunction(() => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet")?.dataset.scale === "2", null, { timeout: 8000 }).catch(() => null);
    await wait(2600);
    const s2 = await petBox();
    const c2 = await canvasBox();
    check(`${theme}: shrink 2x keeps the feet line and draws a 128 x 116 canvas`, c2 && c2.width === 128 && c2.height === 116 && s2 && Math.round(s0.y + s0.height) === Math.round(s2.y + s2.height), JSON.stringify({ c2, before: s0.y + s0.height, after: s2.y + s2.height }));
    await shot("26-scale-2x");
    await btn("normal 3x").click();
    await page.waitForFunction(() => document.getElementById("pip-companion-host")?.shadowRoot?.querySelector(".pet")?.dataset.scale === "3", null, { timeout: 8000 }).catch(() => null);
    await wait(2600);
    const c3 = await canvasBox();
    check(`${theme}: normal 3x restores a 192 x 174 canvas`, c3 && c3.width === 192 && c3.height === 174, JSON.stringify(c3));

    // Wander: nothing while the panel is open, a few hops when quiet.
    const w0 = await hitBox();
    await page.mouse.click(w0.x + w0.width / 2, w0.y + w0.height / 2);
    await page.locator(".pip-panel").waitFor({ timeout: 5000 });
    await wait(300);
    await btn("wander now").click();
    await wait(1500);
    const w1 = await hitBox();
    check(`${theme}: wander now does nothing while the panel is open`, w1 && Math.round(w1.x) === Math.round(w0.x), JSON.stringify({ w0: w0.x, w1: w1.x }));
    await page.keyboard.press("Escape");
    await wait(500);
    await btn("wander now").click();
    await wait(250);
    await shot("27-wander-mid");
    const wanderPhases = await watchPhases(6000);
    const w2 = await hitBox();
    const wandered = w2 && Math.abs(w2.x - w0.x) >= 42 && w2.x >= 40 && w2.x + w2.width <= VW - 40;
    check(`${theme}: wander now moves him when the panel is closed, inside the margins`, wandered && wanderPhases.has("hop"), JSON.stringify({ from: w0.x, to: w2.x, phases: [...wanderPhases] }));

    // Go to the headline: stands beside it without overlapping its rect.
    await btn("go to headline").click();
    await wait(3800);
    const hb = await hitBox();
    const h1Rect = await page.locator("h1").boundingBox();
    const overlaps = hb.x < h1Rect.x + h1Rect.width && hb.x + hb.width > h1Rect.x && hb.y < h1Rect.y + h1Rect.height && hb.y + hb.height > h1Rect.y;
    const gapLeft = h1Rect.x - (hb.x + hb.width);
    const gapRight = hb.x - (h1Rect.x + h1Rect.width);
    check(`${theme}: go to headline stands beside the heading with a 16px gap and no overlap`, !overlaps && (Math.abs(gapLeft - 16) <= 1 || Math.abs(gapRight - 16) <= 1), JSON.stringify({ hb, h1Rect, gapLeft, gapRight }));
    await shot("28-beside-headline");

    await page.close();
  }

  // Onboarding page renders the rabbit at 2x.
  const ob = await context.newPage();
  await ob.goto(`chrome-extension://${extId}/onboarding.html`);
  await ob.locator(".pet-canvas").waitFor({ timeout: 8000 });
  await wait(500);
  const obCanvas = await ob.locator(".pet-canvas").boundingBox();
  check("onboarding renders the rabbit at a whole scale", obCanvas && obCanvas.width === 128 && obCanvas.height === 116, JSON.stringify(obCanvas));
  await ob.screenshot({ path: resolve(out, "onboarding.png") });
  await ob.close();

  // The extension's own pages wear the same frames and font.
  const nt = await context.newPage();
  await nt.setViewportSize({ width: 1280, height: 800 });
  await nt.goto(`chrome-extension://${extId}/newtab.html`);
  await nt.locator(".pet-canvas").waitFor({ timeout: 8000 }).catch(() => null);
  await wait(800);
  const ntFont = await nt.evaluate(() => document.fonts.check('17px "Burrow Pixel"'));
  check("new tab page loads the Burrow font", ntFont);
  check("new tab page has the rabbit", (await nt.locator(".pet-canvas").count()) > 0);
  await nt.screenshot({ path: resolve(out, "newtab.png") });
  await nt.close();
  const pp = await context.newPage();
  await pp.setViewportSize({ width: 360, height: 520 });
  await pp.goto(`chrome-extension://${extId}/popup.html`);
  await wait(800);
  await pp.screenshot({ path: resolve(out, "popup.png") });
  await pp.close();

  // Parent view: sample rooms render, a grant toggle lands in chrome.storage.local, the rabbit is mounted.
  // The profile persists between runs, so clear the three handoff keys first and hide the debug panel.
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.remove(["burrow.grants", "burrow.jump", "burrow.graph"]));
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ "pip.settings": { debugMode: false, onboarded: true, proactiveEnabled: false, voiceAutoResume: false } }));
  const pr = await context.newPage();
  await pr.setViewportSize({ width: 1280, height: 800 });
  await pr.goto(`chrome-extension://${extId}/parent.html`);
  await pr.locator(".pet-canvas").waitFor({ timeout: 8000 }).catch(() => null);
  await pr.locator(".room").first().waitFor({ timeout: 8000 }).catch(() => null);
  await wait(800);
  check("parent view has the rabbit", (await pr.locator(".pet-canvas").count()) > 0);
  const roomCount = await pr.locator(".room").count();
  check("parent view renders the sample rooms", roomCount > 0, `${roomCount} rooms`);
  await pr.locator('input[name="read_pages"]').click();
  await wait(500);
  const grants = await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.get("burrow.grants"));
  check("toggling a grant writes burrow.grants", grants?.["burrow.grants"]?.read_pages?.granted === true, JSON.stringify(grants));
  await pr.evaluate(() => window.scrollTo(0, 0));
  await wait(200);
  await pr.screenshot({ path: resolve(out, "parent.png") });
  await pr.screenshot({ path: resolve(out, "parent-full.png"), fullPage: true });
  await pr.close();
} catch (e) {
  check("run completed without exceptions", false, String(e?.stack ?? e));
} finally {
  await context.close().catch(() => undefined);
}

const petLines = consoleLines.filter((l) => /\[pet\]|pageerror|error/i.test(l));
console.log(`\nconsole lines of interest (${petLines.length}):`);
for (const l of petLines.slice(0, 30)) console.log("  " + l);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
