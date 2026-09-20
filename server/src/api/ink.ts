import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeInkMock, validateInkJudgement, type InkJudgeInput, type InkJudgeOutput, type InkJudgement } from "@shared/ink";
import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("ink");

/**
 * The tablet judge. One plain Gemini call per check: the kid's main screen (the task) and the
 * tablet frame go in, one JSON verdict comes out. Text only; the rabbit speaks the nudge through
 * the voice pipeline like every other line. Without a key the scripted mock keeps the beat
 * rehearsable, and any model failure degrades to the same mock rather than staying silent.
 */
const SYSTEM = `You are a quiet tutor watching a kid's tablet over their shoulder.
Image 1 is the kid's main screen: the task they are working on (a practice problem, a worksheet, a page). It may be missing.
The last image is the kid's rough work on the tablet right now, as ink. Ignore any app toolbars, menus or cursors in it.
Read the ink top to bottom and judge whether the work is on the right path for the task on the main screen.
Reply with ONE JSON object and nothing else:
{"lines":["each written line as text, top to bottom"],
 "status":"ok"|"off"|"unclear",
 "line":<1-based number of the first line with a mistake, or null>,
 "issue":"<what is wrong, in words a ten year old gets, or empty>",
 "nudge":"<one short spoken sentence that names the step to look at again, never the fix and never the answer, or empty>",
 "confidence":<0 to 1, how sure you are about off>,
 "solved":<true only when the work ends in a correct final answer for the task>}
Rules:
- "off" only when you can read a specific mistake with confidence: a wrong operation, a wrong number carried over, a setup that does not match the task, a misread of the task.
- Being slow, messy, unfinished or mid-step is "ok". Blank, unreadable or unrelated ink is "unclear".
- Never state the answer, the corrected line, or the missing number. Name the step, like "Look again at how you moved the 5."
- Keep the nudge under 15 words. Warm and plain. No praise words, no exclamation marks.`;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

function imagePart(dataUrl: string): GeminiPart | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
}

/** With INK_DEBUG_DIR set, every judged frame, its context and the verdict land on disk for tuning. */
const DEBUG_DIR = process.env.INK_DEBUG_DIR || "";
function dumpForDebug(input: InkJudgeInput, judgement: InkJudgement): void {
  if (!DEBUG_DIR) return;
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const tag = String(input.seq).padStart(3, "0");
    const frame = imagePart(input.frame);
    if (frame?.inlineData) writeFileSync(join(DEBUG_DIR, `ink-${tag}-frame.jpg`), Buffer.from(frame.inlineData.data, "base64"));
    const ctx = input.context ? imagePart(input.context) : null;
    if (ctx?.inlineData) writeFileSync(join(DEBUG_DIR, `ink-${tag}-context.jpg`), Buffer.from(ctx.inlineData.data, "base64"));
    writeFileSync(join(DEBUG_DIR, `ink-${tag}-verdict.json`), JSON.stringify({ title: input.contextTitle, url: input.contextUrl, previousLines: input.previousLines, judgement }, null, 2));
  } catch {
    /* debug aid only */
  }
}

export class InkService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(cfg: Config) {
    this.apiKey = cfg.geminiApiKey;
    this.model = cfg.inkModel;
  }

  get providerName(): string {
    return this.apiKey ? `gemini:${this.model}` : "mock";
  }

  async judge(input: InkJudgeInput): Promise<InkJudgeOutput> {
    const started = Date.now();
    if (this.apiKey) {
      try {
        const judgement = await this.callGemini(input);
        logger.info("judge", { status: judgement.status, line: judgement.line, confidence: judgement.confidence, lines: judgement.lines.length, solved: judgement.solved, ms: Date.now() - started });
        dumpForDebug(input, judgement);
        return { judgement, provider: this.providerName, degraded: false, latencyMs: Date.now() - started };
      } catch (e) {
        logger.warn("gemini judge failed; using the mock", { error: e instanceof Error ? e.message : String(e) });
        return { judgement: judgeInkMock(input), provider: "mock-fallback", degraded: true, latencyMs: Date.now() - started };
      }
    }
    return { judgement: judgeInkMock(input), provider: "mock", degraded: false, latencyMs: Date.now() - started };
  }

  private async callGemini(input: InkJudgeInput): Promise<InkJudgement> {
    const frame = imagePart(input.frame);
    if (!frame) throw new Error("frame is not an image data URL");
    const context = input.context ? imagePart(input.context) : null;
    const parts: GeminiPart[] = [];
    if (context) {
      parts.push({ text: `Image 1, the kid's main screen (title: ${input.contextTitle || "unknown"}; url: ${input.contextUrl || "unknown"}):` }, context);
    } else {
      parts.push({ text: `The kid's main screen could not be captured. Its title is: ${input.contextTitle || "unknown"}.` });
    }
    const memory = input.previousLines.length ? ` Last time you read these lines: ${JSON.stringify(input.previousLines.slice(-12))}.` : "";
    parts.push({ text: `The tablet now.${memory}` }, frame);
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2, thinkingConfig: { thinkingLevel: "low" } },
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`gemini returned non-JSON: ${text.slice(0, 120)}`);
    }
    const v = validateInkJudgement(raw);
    if (!v.ok) throw new Error(`invalid judgement: ${v.error}`);
    return v.judgement;
  }
}
