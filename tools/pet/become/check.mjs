// Drives the "Become a character" page in Playwright Chromium with a fake camera that shows
// tools/pet/become/robot-cat.png, snaps it, tunes, becomes it, then opens a page and checks the
// custom character stands in the corner. Screenshots go to tools/pet/become/shots.
// Usage: node extension/build.mjs && node tools/pet/become/check.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const extPath = resolve(root, "extension/dist");
const out = resolve(here, "shots");
const profileDir = resolve(out, ".profile");
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (!existsSync(resolve(extPath, "manifest.json"))) {
  console.error("extension/dist not found. Run node extension/build.mjs first.");
  process.exit(1);
}
if (!existsSync(resolve(here, "robot-cat.y4m"))) {
  console.error("robot-cat.y4m not found. Run python tools/pet/become/make-inputs.py first.");
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` : ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    "--no-first-run",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve(here, "robot-cat.y4m")}`,
  ],
  viewport: { width: 1280, height: 900 },
});
context.setDefaultTimeout(15000);

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent("serviceworker");
const extId = new URL(worker.url()).host;

try {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`chrome-extension://${extId}/become.html`);
  await page.waitForSelector("video");
  await page.waitForFunction(() => {
    const v = document.querySelector("video");
    return v && v.videoWidth > 0;
  });
  await wait(500);
  await page.screenshot({ path: resolve(out, "1-camera.png") });
  check("camera shows a picture", await page.evaluate(() => document.querySelector("video").videoWidth > 0));

  await page.click("text=Take the picture");
  await page.waitForSelector("canvas.sprite");
  await wait(600);
  const spriteAlpha = await page.evaluate(() => {
    const c = document.querySelector("canvas.sprite");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check("a sprite came out of the snapshot", spriteAlpha > 200, `${spriteAlpha} opaque pixels`);
  await page.waitForSelector(".stage .pet canvas");
  await wait(800);
  await page.screenshot({ path: resolve(out, "2-tune.png") });
  const previewStrip = await page.getAttribute(".stage .pet", "data-strip");
  check("the stage plays the preview", previewStrip === "idle", previewStrip ?? "none");

  // Run through the states on the stage.
  for (const s of ["celebrate", "thinking", "confused", "hop", "sleepy"]) {
    await page.click(`.states >> text=${s}`);
    await wait(450);
    const strip = await page.getAttribute(".stage .pet", "data-strip");
    // The strip may still be the way in (to_x) or the way out of the last state (aha, from_x).
    check(`stage shows ${s}`, strip === s || strip === `to_${s}` || strip === "aha" || !!strip?.startsWith("from_"), strip ?? "none");
    await page.screenshot({ path: resolve(out, `3-${s}.png`) });
  }
  await page.click(".states >> text=dive");
  await wait(400);
  const diving = await page.getAttribute(".stage .pet", "data-strip");
  check("dive plays the hole sequence", ["hole_open", "dive", "hole_only", "hole_wait"].includes(diving), diving ?? "none");
  await wait(1800);

  // Tune: more colours, bigger.
  await page.fill("input[aria-label=Colours]", "16");
  await page.fill("input[aria-label=Size]", "40");
  await page.fill(".name input", "Robo Cat");
  await wait(600);
  await page.screenshot({ path: resolve(out, "4-tuned.png") });

  await page.click("text=Become this character");
  await page.waitForSelector("text=Done");
  await page.screenshot({ path: resolve(out, "5-done.png") });
  const saved = await page.evaluate(async () => {
    const raw = await chrome.storage.local.get(["burrow.customCharacter", "pip.settings"]);
    const c = raw["burrow.customCharacter"];
    return { id: c?.id, label: c?.label, states: Object.keys(c?.manifest?.states ?? {}).length, bytes: JSON.stringify(c).length, character: raw["pip.settings"]?.character, name: raw["pip.settings"]?.characterName };
  });
  check("character saved to storage", !!saved.id && saved.states >= 20, `${saved.states} states, ${(saved.bytes / 1024).toFixed(0)} KB`);
  check("setting points at it", saved.character === `custom:${saved.id}` && saved.name === "Robo Cat", `${saved.character} / ${saved.name}`);

  // A real page: he should stand there as the new character.
  const site = await context.newPage();
  site.on("pageerror", (e) => errors.push(String(e)));
  site.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // Any http page gets the content script; this one is served by Playwright so no server is needed.
  await site.route("http://burrow.test/**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><body style="margin:0;background:#fff;font:16px Georgia"><main style="padding:40px"><h1>A page</h1><p>Some text for the corner test.</p></main></body></html>` }));
  await site.goto("http://burrow.test/page");
  await wait(2500);
  const onPage = await site.evaluate(() => {
    const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot);
    for (const h of hosts) {
      const pet = h.shadowRoot.querySelector(".pet");
      if (pet) return { character: pet.getAttribute("data-character"), strip: pet.getAttribute("data-strip"), phase: pet.getAttribute("data-phase") };
    }
    return null;
  });
  check("the page shows the custom character", !!onPage && onPage.character === saved.character, JSON.stringify(onPage));
  await site.screenshot({ path: resolve(out, "6-page.png") });
  const corner = await site.evaluate(() => {
    const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot);
    for (const h of hosts) {
      const pet = h.shadowRoot.querySelector(".pet canvas");
      if (pet) {
        const r = pet.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    return null;
  });
  if (corner) await site.screenshot({ path: resolve(out, "7-page-corner.png"), clip: { x: Math.max(0, corner.x - 20), y: Math.max(0, corner.y - 20), width: corner.w + 40, height: corner.h + 40 } });

  // Back to the rabbit from the maker page.
  await page.click("text=Back to the rabbit");
  await wait(2000);
  const back = await site.evaluate(() => {
    const hosts = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot);
    for (const h of hosts) {
      const pet = h.shadowRoot.querySelector(".pet");
      if (pet) return pet.getAttribute("data-character");
    }
    return null;
  });
  check("back to the rabbit switches the page", back === "rabbit", back ?? "none");
  await site.screenshot({ path: resolve(out, "8-rabbit-back.png") });

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await context.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks pass`);
process.exit(failed ? 1 : 0);
