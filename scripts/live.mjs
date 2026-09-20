/**
 * Live test window: headed Chromium with the built extension, a real microphone and a fresh
 * profile (blank learner memory, current service worker). Stays up until the window is closed.
 *
 *   npm run live                      demo dashboard + demo video lesson
 *   npm run live -- <url> [<url>…]    open these instead
 *
 * The browser is spawned directly, NOT through Playwright's launcher. Playwright adds ~40 default
 * flags, and with them YouTube stops every video after 30-45 seconds ("Something went wrong.
 * Refresh or try again later") — with or without the extension, headed or headless. The same
 * binary launched plainly plays indefinitely. Playwright is used here only to locate the binary.
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extPath = join(root, "extension/dist");
if (!existsSync(join(extPath, "manifest.json"))) {
  console.error("extension/dist not found — run `npm run build` first");
  process.exit(1);
}
const port = Number(process.env.PORT) || 8787;
const urls = process.argv.slice(2);
if (!urls.length) urls.push(`http://localhost:${port}/demo/index.html`, `http://localhost:${port}/demo/video.html`);

const profile = join(tmpdir(), "burrow-live-profile");
rmSync(profile, { recursive: true, force: true });

const browser = spawn(
  chromium.executablePath(),
  [`--user-data-dir=${profile}`, `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, "--no-first-run", "--no-default-browser-check", "--start-maximized", ...urls],
  { stdio: "ignore" },
);
console.log("live window up — close it to end");
browser.on("exit", () => process.exit(0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => browser.kill());
