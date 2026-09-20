// A phone photo of a pencil drawing (tools/pet/become/pencil-drawing.jpg, or DRAWING=<file>): loads it
// on the "Become a character" page, checks the drawing is cut out by its lines with the inside kept,
// then colours it through the live server. Usage: node extension/build.mjs && node tools/pet/become/check-pencil.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const extPath = resolve(root, "extension/dist");
const out = resolve(here, "shots");
const profileDir = resolve(out, ".profile-pencil");
rmSync(profileDir, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (!existsSync(resolve(extPath, "manifest.json"))) {
  console.error("extension/dist not found. Run node extension/build.mjs first.");
  process.exit(1);
}
const drawing = process.env.DRAWING ? resolve(process.env.DRAWING) : resolve(here, "pencil-drawing.jpg");
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

const stats = (page) =>
  page.evaluate(() => {
    const c = document.querySelector("canvas.sprite");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let ink = 0;
    let white = 0;
    let yellow = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      n++;
      if (d[i] < 90 && d[i + 1] < 80) ink++;
      if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
      if (d[i] > 180 && d[i + 1] > 140 && d[i + 2] < 120) yellow++;
    }
    return { n, ink, white, yellow };
  });

try {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`chrome-extension://${extId}/become.html`);
  await page.waitForSelector("text=Use a photo instead");
  await page.setInputFiles("input[type=file]", drawing);
  await page.waitForSelector("canvas.sprite");
  await wait(800);
  check("recognised as a pencil drawing", await page.isChecked(".paint .mode input"));
  const before = await stats(page);
  check("the sprite is a real cut-out, not a sliver", before.n > 500, `${before.n} opaque pixels`);
  check("its inside is kept as paper", before.white > before.ink, `${before.white} white, ${before.ink} ink`);
  check("its lines are ink", before.ink > 80, `${before.ink} ink pixels`);
  await page.screenshot({ path: resolve(out, "n1-pencil.png") });
  await (await page.$("canvas.sprite")).screenshot({ path: resolve(out, "n2-pencil-sprite.png") });

  await page.fill(".paint .who input", hint);
  const t0 = Date.now();
  await page.click("text=Colour it in");
  await page.waitForFunction(() => /Coloured|Stand-in|Could not/.test(document.querySelector(".paint .note")?.textContent ?? ""), null, { timeout: 90000 });
  const note = await page.textContent(".paint .note");
  console.log(`  paint took ${((Date.now() - t0) / 1000).toFixed(1)} s: ${note}`);
  check("the model coloured it", (note ?? "").startsWith("Coloured as"), note ?? "");
  await wait(500);
  const after = await stats(page);
  check(`coloured as asked (${hint})`, after.yellow > after.n * 0.3, `${after.yellow} of ${after.n} yellow`);
  check("the lines survive the colouring", after.ink > 60, `${after.ink} ink pixels`);
  await page.screenshot({ path: resolve(out, "n3-pencil-coloured.png") });
  await (await page.$("canvas.sprite")).screenshot({ path: resolve(out, "n4-pencil-coloured-sprite.png") });
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await context.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks pass`);
process.exit(failed ? 1 : 0);
