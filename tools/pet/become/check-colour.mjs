// Colour by numbers: loads tools/pet/become/cat-drawing.png as a photo on the "Become a character"
// page, says who it is, clicks "Colour it in" and checks the sprite came out coloured. Talks to the
// real server at localhost:8787 when it is up (set MOCK=1 to answer the paint call here instead).
// Usage: node extension/build.mjs && node tools/pet/become/check-colour.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const extPath = resolve(root, "extension/dist");
const out = resolve(here, "shots");
const profileDir = resolve(out, ".profile-colour");
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (!existsSync(resolve(extPath, "manifest.json"))) {
  console.error("extension/dist not found. Run node extension/build.mjs first.");
  process.exit(1);
}
const hint = process.env.HINT ?? "Pikachu";
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
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--no-first-run", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  viewport: { width: 1280, height: 1000 },
});
context.setDefaultTimeout(60000);
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent("serviceworker");
const extId = new URL(worker.url()).host;

try {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  if (process.env.MOCK) {
    await page.route("http://localhost:8787/api/character/paint", async (route) => {
      const body = route.request().postDataJSON();
      const colors = {};
      body.regions.forEach((r, i) => (colors[r.id] = i === 0 ? "#f2c14e" : i % 2 ? "#ffffff" : "#d9534f"));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ name: "Mock Cat", colors, provider: "openai" }) });
    });
  }
  await page.goto(`chrome-extension://${extId}/become.html`);
  await page.waitForSelector("text=Use a photo instead");
  await page.setInputFiles("input[type=file]", resolve(here, "cat-drawing.png"));
  await page.waitForSelector("canvas.sprite");
  await wait(600);
  const note = await page.textContent(".paint .note").catch(() => "");
  check("a drawing is recognised as black and white", (note ?? "").includes("black and white"), note ?? "");
  await page.screenshot({ path: resolve(out, "c1-drawing.png") });

  const yellowish = async () => {
    return page.evaluate(() => {
      const c = document.querySelector("canvas.sprite");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      let y = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        n++;
        if (d[i] > 180 && d[i + 1] > 140 && d[i + 2] < 120) y++;
      }
      return { n, y };
    });
  };
  const before = await yellowish();
  await page.fill(".paint .who input", hint);
  const t0 = Date.now();
  await page.click("text=Colour it in");
  await page.waitForFunction(() => /Coloured|Could not/.test(document.querySelector(".paint .note")?.textContent ?? ""), null, { timeout: 90000 });
  const after = await page.textContent(".paint .note");
  console.log(`  paint took ${((Date.now() - t0) / 1000).toFixed(1)} s: ${after}`);
  check("the model coloured it", (after ?? "").startsWith("Coloured as"), after ?? "");
  await wait(500);
  const painted = await yellowish();
  check(`the sprite is mostly yellow now (hint: ${hint})`, painted.y > painted.n * 0.3 && painted.y > before.y, `${painted.y} of ${painted.n} pixels, was ${before.y}`);
  const name = await page.inputValue(".name input");
  check("the name was filled in from the model", name.length > 0, name);
  await page.screenshot({ path: resolve(out, "c2-coloured.png") });
  const spriteShot = await page.$("canvas.sprite");
  await spriteShot.screenshot({ path: resolve(out, "c3-sprite.png") });

  await page.click("text=Undo colour");
  await wait(300);
  const undone = await yellowish();
  check("undo brings the drawing back", undone.y === before.y, `${undone.y}`);
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await context.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks pass`);
process.exit(failed ? 1 : 0);
