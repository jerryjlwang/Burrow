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
  ttsExpressivity: number;
  sttModel: string;
  demoMode: boolean;
  /** Optional: lets look_up return actual videos instead of a YouTube search link. */
  youtubeApiKey: string;
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
    ttsExpressivity: num(env.DEEPGRAM_TTS_EXPRESSIVITY, 0),
    sttModel: env.DEEPGRAM_STT_MODEL || "flux-general-en",
    demoMode,
    youtubeApiKey: env.YOUTUBE_API_KEY || "",
    transcriptApiKey: env.SUPADATA_API_KEY || "",
  };
}
