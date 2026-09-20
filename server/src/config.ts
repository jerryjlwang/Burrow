import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env"), quiet: true });

export interface Config {
  port: number;
  deepgramApiKey: string;
  llmProvider: "anthropic" | "openai" | "mock";
  llmApiKey: string;
  llmModel: string;
  llmEffort: "minimal" | "low" | "medium" | "high";
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
  const llmApiKey = env.LLM_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || "";
  const requested = (env.LLM_PROVIDER || "").toLowerCase();
  const demoMode = env.DEMO_MODE === "1" || env.DEMO_MODE === "true";
  // Provider: explicit LLM_PROVIDER wins; otherwise sniff the key format (sk-ant-… = Anthropic, sk-… = OpenAI).
  let llmProvider: Config["llmProvider"];
  if (requested === "mock" || requested === "openai" || requested === "anthropic") llmProvider = requested;
  else if (llmApiKey.startsWith("sk-ant-") || (!llmApiKey && env.ANTHROPIC_AUTH_TOKEN)) llmProvider = "anthropic";
  else if (llmApiKey.startsWith("sk-") || env.OPENAI_API_KEY) llmProvider = "openai";
  else llmProvider = "mock";
  if (demoMode) llmProvider = "mock";
  const effortRaw = (env.LLM_EFFORT || "low").toLowerCase();
  return {
    port: num(env.PORT, 8787),
    deepgramApiKey: env.DEEPGRAM_API_KEY || "",
    llmProvider,
    llmApiKey,
    llmModel: env.LLM_MODEL || (llmProvider === "openai" ? "gpt-5.4-mini" : "claude-opus-5"),
    llmEffort: effortRaw === "medium" || effortRaw === "high" || effortRaw === "minimal" ? effortRaw : "low",
    ttsModel: env.DEEPGRAM_TTS_MODEL || "flux-rufus-en",
    ttsSpeed: num(env.DEEPGRAM_TTS_SPEED, 1),
    ttsExpressivity: num(env.DEEPGRAM_TTS_EXPRESSIVITY, 0),
    sttModel: env.DEEPGRAM_STT_MODEL || "flux-general-en",
    demoMode,
  };
}
