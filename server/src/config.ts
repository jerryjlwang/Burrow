import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

export interface Config {
  port: number;
  deepgramApiKey: string;
  llmProvider: "anthropic" | "mock";
  llmApiKey: string;
  llmModel: string;
  llmEffort: "low" | "medium" | "high";
  ttsModel: string;
  ttsSpeed: number;
  ttsExpressivity: number;
  sttModel: string;
  demoMode: boolean;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const llmApiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY || "";
  const requested = (env.LLM_PROVIDER || "").toLowerCase();
  const demoMode = env.DEMO_MODE === "1" || env.DEMO_MODE === "true";
  let llmProvider: Config["llmProvider"] = requested === "mock" ? "mock" : "anthropic";
  if (requested !== "anthropic" && requested !== "mock" && !llmApiKey && !env.ANTHROPIC_AUTH_TOKEN) llmProvider = "mock";
  if (demoMode) llmProvider = "mock";
  const effortRaw = (env.LLM_EFFORT || "low").toLowerCase();
  return {
    port: num(env.PORT, 8787),
    deepgramApiKey: env.DEEPGRAM_API_KEY || "",
    llmProvider,
    llmApiKey,
    llmModel: env.LLM_MODEL || "claude-opus-5",
    llmEffort: effortRaw === "medium" || effortRaw === "high" ? effortRaw : "low",
    ttsModel: env.DEEPGRAM_TTS_MODEL || "flux-rufus-en",
    ttsSpeed: num(env.DEEPGRAM_TTS_SPEED, 1),
    ttsExpressivity: num(env.DEEPGRAM_TTS_EXPRESSIVITY, 0),
    sttModel: env.DEEPGRAM_STT_MODEL || "flux-general-en",
    demoMode,
  };
}
