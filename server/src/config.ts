import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

export interface Config {
  port: number;
  deepgramApiKey: string;
  llmProvider: "openai" | "mock";
  llmApiKey: string;
  llmModel: string;
  llmEffort: "none" | "minimal" | "low" | "medium" | "high";
  ttsModel: string;
  ttsSpeed: number;
  /** 1 = the voice as Deepgram made it; 1.15 is about two and a half semitones up. Played faster by the browser, spoken slower by Deepgram, so the pace stays the same. */
  ttsPitch: number;
  ttsExpressivity: number;
  sttModel: string;
  /** Flux eager end-of-turn confidence (0.3–0.9, at most the end-of-turn threshold of 0.7); 0 turns speculation off. */
  sttEagerEotThreshold: number;
  demoMode: boolean;
  /** Gemini key for the tablet judge; without it the judge runs its scripted mock. */
  geminiApiKey: string;
  inkModel: string;
  /** Optional: Supadata key. Lets the rabbit read along with YouTube videos; without it only pages with their own captions work. */
  transcriptApiKey: string;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llmApiKey = env.LLM_API_KEY || env.OPENAI_API_KEY || "";
  const requested = (env.LLM_PROVIDER || "").toLowerCase();
  const demoMode = env.DEMO_MODE === "1" || env.DEMO_MODE === "true";
  // Provider: explicit LLM_PROVIDER wins; otherwise any usable OpenAI key turns the real agent on.
  let llmProvider: Config["llmProvider"];
  if (requested === "mock" || requested === "openai") llmProvider = requested;
  else if (llmApiKey.startsWith("sk-") || env.OPENAI_API_KEY) llmProvider = "openai";
  else llmProvider = "mock";
  if (demoMode) llmProvider = "mock";
  const effortRaw = (env.LLM_EFFORT || "low").toLowerCase();
  return {
    port: num(env.PORT, 8787),
    deepgramApiKey: env.DEEPGRAM_API_KEY || "",
    llmProvider,
    llmApiKey,
    llmModel: env.LLM_MODEL || "gpt-6-astra",
    llmEffort: effortRaw === "medium" || effortRaw === "high" || effortRaw === "minimal" || effortRaw === "none" ? effortRaw : "low",
    ttsModel: env.DEEPGRAM_TTS_MODEL || "flux-rufus-en",
    ttsSpeed: num(env.DEEPGRAM_TTS_SPEED, 1),
    ttsPitch: Math.min(1.5, Math.max(0.75, num(env.DEEPGRAM_TTS_PITCH, 1))),
    ttsExpressivity: num(env.DEEPGRAM_TTS_EXPRESSIVITY, 0),
    sttModel: env.DEEPGRAM_STT_MODEL || "flux-general-en",
    sttEagerEotThreshold: Math.min(0.7, Math.max(0, num(env.DEEPGRAM_EAGER_EOT, 0.4))),
    demoMode,
    geminiApiKey: env.GEMINI_API_KEY || "",
    inkModel: env.INK_MODEL || "gemini-3.8-flash",
    transcriptApiKey: env.SUPADATA_API_KEY || "",
  };
}
