// esbuild-based build for the Chrome MV3 extension.
// Usage: node extension/build.mjs [--watch]
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outdir = join(here, "dist");
const isWatch = process.argv.includes("--watch");
const isProd = process.argv.includes("--prod");

const entryPoints = {
  content: join(here, "src/content/index.tsx"),
  background: join(here, "src/background/index.ts"),
  offscreen: join(here, "src/offscreen/index.ts"),
  "pcm-worklet": join(here, "src/offscreen/pcm-worklet.ts"),
  onboarding: join(here, "src/onboarding/index.tsx"),
  popup: join(here, "src/popup/index.tsx"),
};

function copyStatic() {
  mkdirSync(outdir, { recursive: true });
  cpSync(join(here, "manifest.json"), join(outdir, "manifest.json"));
  const pub = join(here, "public");
  if (existsSync(pub)) cpSync(pub, outdir, { recursive: true });
  for (const html of ["offscreen", "onboarding", "popup"]) {
    const src = join(here, `src/${html}/${html}.html`);
    if (existsSync(src)) cpSync(src, join(outdir, `${html}.html`));
  }
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints,
  bundle: true,
  outdir,
  format: "iife",
  target: ["chrome116"],
  platform: "browser",
  sourcemap: isProd ? false : "inline",
  minify: isProd,
  logLevel: "info",
  legalComments: "none",
  jsx: "automatic",
  loader: { ".css": "text", ".svg": "text" },
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development"),
    __PIP_VERSION__: JSON.stringify(JSON.parse(readFileSyncSafe(join(here, "manifest.json")) || "{}").version || "0.0.0"),
  },
  alias: { "@shared": join(root, "shared/src") },
};

function readFileSyncSafe(p) {
  try {
    return require_fs().readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function require_fs() {
  return { readFileSync: (p, enc) => readFileSyncImpl(p, enc) };
}
import { readFileSync as readFileSyncImpl } from "node:fs";

if (existsSync(outdir)) rmSync(outdir, { recursive: true, force: true });
copyStatic();

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  // Re-copy static assets when they change.
  const watchDirs = [join(here, "public"), join(here, "src")];
  for (const d of watchDirs) {
    if (!existsSync(d)) continue;
    watch(d, { recursive: true }, (_evt, file) => {
      if (file && /\.(html|json|png|svg)$/.test(file)) {
        try {
          copyStatic();
          console.log(`[build] static asset updated: ${file}`);
        } catch (e) {
          console.error("[build] static copy failed", e);
        }
      }
    });
  }
  watch(join(here, "manifest.json"), () => copyStatic());
  console.log("[build] watching for changes…");
} else {
  await esbuild.build(options);
  const size = (f) => (statSync(join(outdir, f)).size / 1024).toFixed(1) + " KB";
  for (const f of readdirSync(outdir).filter((f) => f.endsWith(".js"))) console.log(`  ${f.padEnd(18)} ${size(f)}`);
  console.log("[build] extension written to extension/dist");
}
