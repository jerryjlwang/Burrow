import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config";
import { AgentService } from "./api/agent";
import { ExtractService } from "./api/extract";
import { lookUp } from "./api/lookup";
import { InkService } from "./api/ink";
import { StepService, type JudgeRequest, type PlanRequest } from "./api/steps";
import { VideoService, type VideoAnalyzeRequest } from "./api/video";
import { OpenAIProvider } from "./agent/openai";
import { attachSttSession } from "./voice/stt";
import { attachTtsSession } from "./voice/tts";
import { serveStatic } from "./util/static";
import { log } from "./util/logger";
import type { AgentInput, InterventionInput } from "@shared/types";
import type { ExtractionInput } from "@shared/concepts";
import type { InkJudgeInput } from "@shared/ink";

const logger = log("server");
const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const llm = cfg.llmProvider === "openai" ? new OpenAIProvider({ apiKey: cfg.llmApiKey, model: cfg.llmModel, effort: cfg.llmEffort }) : null;
const steps = new StepService(llm);
const video = new VideoService(llm, cfg.transcriptApiKey);
const agent = new AgentService(cfg, steps);
const extract = new ExtractService(cfg);
const ink = new InkService(cfg);
const demoRoot = resolve(here, "../../demo-pages");
const VERSION = "0.1.0";

function readJson(req: http.IncomingMessage, limit = 3_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, version: VERSION, llm: agent.providerName, deepgram: !!cfg.deepgramApiKey, transcripts: video.transcriptsEnabled, demoMode: cfg.demoMode, ink: ink.providerName, tts: { model: cfg.ttsModel, speed: cfg.ttsSpeed, expressivity: cfg.ttsExpressivity }, stt: cfg.sttModel });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent/decide") {
      const input = (await readJson(req)) as AgentInput;
      if (!input || typeof input.utterance !== "string" || !input.page) {
        json(res, 400, { error: "invalid input" });
        return;
      }
      json(res, 200, await agent.decide({ ...input, demoMode: cfg.demoMode }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent/intervene") {
      const input = (await readJson(req)) as InterventionInput;
      if (!input || !input.page || !input.signals) {
        json(res, 400, { error: "invalid input" });
        return;
      }
      json(res, 200, await agent.intervene({ ...input, demoMode: cfg.demoMode }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ink/judge") {
      const input = (await readJson(req, 6_000_000)) as InkJudgeInput;
      if (!input || typeof input.frame !== "string" || !input.frame.startsWith("data:image/")) {
        json(res, 400, { error: "invalid input" });
        return;
      }
      json(res, 200, await ink.judge({ ...input, previousLines: Array.isArray(input.previousLines) ? input.previousLines : [], seq: Number(input.seq) || 0 }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lookup") {
      const body = (await readJson(req)) as { query?: string; prefer?: string };
      if (!body || typeof body.query !== "string" || !body.query.trim()) {
        json(res, 400, { error: "invalid query" });
        return;
      }
      json(res, 200, { ok: true, results: await lookUp(body.query, { prefer: typeof body.prefer === "string" ? body.prefer : undefined, youtubeApiKey: cfg.youtubeApiKey }) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/steps/plan") {
      const body = (await readJson(req)) as PlanRequest;
      if (!body || (typeof body.topic !== "string" && typeof body.key !== "string")) {
        json(res, 400, { error: "plan needs a topic or a problem key" });
        return;
      }
      json(res, 200, { plan: await steps.plan(body) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/steps/judge") {
      const body = (await readJson(req)) as JudgeRequest;
      if (!body || typeof body.working !== "string" || !body.plan || !Array.isArray(body.plan.steps) || typeof body.plan.key !== "string") {
        json(res, 400, { error: "invalid input" });
        return;
      }
      json(res, 200, await steps.judge(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/video/analyze") {
      const body = (await readJson(req)) as VideoAnalyzeRequest;
      if (!body || typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) {
        json(res, 400, { error: "invalid input" });
        return;
      }
      json(res, 200, await video.analyze(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/extract") {
      const input = (await readJson(req)) as ExtractionInput;
      if (!input || typeof input.url !== "string" || typeof input.title !== "string") {
        json(res, 400, { error: "invalid input" });
        return;
      }
      json(res, 200, await extract.extract(input));
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/demo")) {
      res.writeHead(302, { location: "/demo/" }).end();
      return;
    }
    if (req.method === "GET" && serveStatic(req, res, "/demo/", demoRoot)) return;
    json(res, 404, { error: "not found" });
  } catch (e) {
    logger.error("request failed", { path: url.pathname, error: e instanceof Error ? e.message : String(e) });
    json(res, 500, { error: e instanceof Error ? e.message : "internal error" });
  }
});

const sttServer = new WebSocketServer({ noServer: true });
const ttsServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws/stt") {
    sttServer.handleUpgrade(req, socket, head, (ws) => void attachSttSession(ws, cfg));
  } else if (url.pathname === "/ws/tts") {
    ttsServer.handleUpgrade(req, socket, head, (ws) => attachTtsSession(ws, cfg));
  } else {
    socket.destroy();
  }
});

server.listen(cfg.port, () => {
  logger.info(`Pip server listening on http://localhost:${cfg.port}`);
  logger.info(`agent provider: ${agent.providerName}${cfg.demoMode ? " (demo mode)" : ""} · deepgram: ${cfg.deepgramApiKey ? "configured" : "NOT configured (voice disabled)"} · tts: ${cfg.ttsModel} speed=${cfg.ttsSpeed} expressivity=${cfg.ttsExpressivity} · stt: ${cfg.sttModel} · tablet judge: ${ink.providerName}`);
  logger.info(`demo pages: http://localhost:${cfg.port}/demo/`);
});
