// Scratch: launch Chromium with the built extension, serve a light and a dark page, drive the pet
// Drives the built extension in Playwright Chromium on a light and a dark page, forces every pet state
// through the debug panel, checks the sprite rules on a real page, and saves screenshots to tools/pet/shots.
// Usage: node extension/build.mjs && node tools/pet/check.mjs
import { chromium } from "file:///C:/Users/nqrdy/dev/Human-eval/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = "C:/Users/nqrdy/dev/Human-eval";
const extPath = resolve(root, "extension/dist");
const out = resolve(root, "tools/pet/shots");
const profileDir = resolve(out, ".profile");
mkdirSync(out, { recursive: true });

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
  viewport: { width: 1280, height: 800 },
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
    const shot = async (name) => {
      const file = resolve(out, `${theme}-${name}.png`);
      await page.screenshot({ path: file });
      const box = await page.locator(".pet-canvas").boundingBox();
      if (box) {
        const clip = { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 60), width: Math.min(1280, box.width + 120), height: Math.min(800, box.height + 120) };
        if (clip.x + clip.width > 1280) clip.width = 1280 - clip.x;
        if (clip.y + clip.height > 800) clip.height = 800 - clip.y;
        await page.screenshot({ path: resolve(out, `${theme}-${name}-zoom.png`), clip });
      }
      return file;
    };

    const canvas = await page.locator(".pet-canvas").boundingBox();
    const hit = await page.locator(".pet-hit").boundingBox();
    check(`${theme}: canvas is a whole multiple of the cell`, canvas && canvas.width === 192 && canvas.height === 174, JSON.stringify(canvas));
    const attrs = await page.locator(".pet-canvas").evaluate((c) => ({ w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, cssH: c.getBoundingClientRect().height, smoothing: c.getContext("2d").imageSmoothingEnabled, rendering: getComputedStyle(c).imageRendering }));
    check(`${theme}: canvas backing store equals its CSS size, smoothing off, pixelated`, attrs.w === attrs.cssW && attrs.h === attrs.cssH && attrs.smoothing === false && attrs.rendering === "pixelated", JSON.stringify(attrs));
    check(`${theme}: hit area is the body box`, hit && Math.round(hit.width) === 93 && Math.round(hit.height) === 159, JSON.stringify(hit));
    check(`${theme}: rabbit sits 18px from the right edge`, hit && Math.round(1280 - (hit.x + hit.width)) === 18, JSON.stringify({ right: 1280 - (hit.x + hit.width) }));

    await shot("01-idle");
    await btn("listening").click();
    await wait(700);
    await shot("02-listening");
    await btn("thinking").click();
    await wait(700);
    await shot("03-thinking");
    await btn("speaking loud").click();
    await wait(1100); // thinking exits through aha first
    await shot("04-speaking-loud");
    await btn("celebrating").click();
    await wait(260);
    await shot("05-celebrate");
    await wait(1400);
    await btn("confused").click();
    await wait(500);
    await shot("06-confused");
    await btn("sleeping").click();
    await wait(700);
    await shot("07-sleepy");
    await btn("idle").click();
    await wait(500);

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
    const hitNow = await page.locator(".pet-hit").boundingBox();
    check(`${theme}: panel sits above the rabbit without overlap`, panelBox && hitNow && panelBox.y + panelBox.height <= hitNow.y + 1 && panelBox.x + panelBox.width <= 1280 && panelBox.y >= 0, JSON.stringify({ panelBox, hitNow }));
    await shot("08-panel-open");
    await page.keyboard.press("Escape");
    await wait(300);
    check(`${theme}: escape closes the panel`, (await page.locator(".pip-panel").count()) === 0);

    // Drag: pointer capture on the body, dragged strip while moving, no panel toggle on release.
    const h0 = await page.locator(".pet-hit").boundingBox();
    await page.mouse.move(h0.x + h0.width / 2, h0.y + h0.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(h0.x + h0.width / 2 - 30 * i, h0.y + h0.height / 2 - 20 * i);
    await wait(350);
    await shot("09-dragging");
    const dragClass = await page.locator(".pet").getAttribute("class");
    await page.mouse.up();
    await wait(400);
    const h1 = await page.locator(".pet-hit").boundingBox();
    const moved = h1 && Math.round(h0.x - h1.x) === 360 && Math.round(h0.y - h1.y) === 240;
    check(`${theme}: drag moved the rabbit by the pointer delta and showed the dragged strip`, moved && /dragging/.test(dragClass ?? ""), JSON.stringify({ h0, h1, dragClass }));
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

    // Drag to the far left: the panel must stay on screen.
    const h2 = await page.locator(".pet-hit").boundingBox();
    await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(h2.x + h2.width / 2 - 200 * i, h2.y + h2.height / 2 - 30 * i);
    await page.mouse.up();
    await wait(400);
    const h3 = await page.locator(".pet-hit").boundingBox();
    check(`${theme}: drag clamps the body inside the viewport`, h3 && h3.x >= 0 && h3.y + h3.height <= 800, JSON.stringify(h3));
    await page.mouse.click(h3.x + h3.width / 2, h3.y + h3.height / 2);
    await page.locator(".pip-panel").waitFor({ timeout: 5000 });
    await wait(400);
    const pb3 = await page.locator(".pip-panel").boundingBox();
    const onOneSide = pb3 && h3 && (pb3.y + pb3.height <= h3.y + 1 || pb3.y >= h3.y + h3.height - 1);
    check(`${theme}: panel stays on screen and clear of the rabbit at the top-left`, pb3 && pb3.x >= 0 && pb3.y >= 0 && pb3.y + pb3.height <= 800 && onOneSide, JSON.stringify({ pb3, h3 }));
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
    const h4 = await page.locator(".pet-hit").boundingBox();
    check(`${theme}: moveTo landed on the right side`, h4 && h4.x + h4.width / 2 > 640, JSON.stringify(h4));

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
    await wait(500);
    await shot("19-attention-2-reduced");
    await btn("attention 0").click();
    await btn("reduced motion").click();
    await btn("wave").click();
    await wait(350);
    await shot("20-wave");
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
