import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeInkMock, MAX_RUNG, noteReusesNumbers, validateInkJudgement, type InkJudgeInput, type InkJudgeOutput, type InkJudgement } from "@shared/ink";
import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("ink");

/**
 * The tablet judge. One plain Gemini call per check: the kid's main screen (the task) and the
 * tablet frame go in, one JSON verdict comes out, with the wrong line and the part to circle as
 * boxes in the frame (Gemini's native [ymin, xmin, ymax, xmax] on 0..1000, turned into fractions
 * by the validator). The nudge climbs a rung each time the same line stays wrong, and a stall may
 * bring back a small chalk note. Text only; the rabbit speaks the nudge through the voice pipeline
 * like every other line. Without a key the scripted mock keeps the beat rehearsable, and any model
 * failure degrades to the same mock rather than staying silent.
 */
const SYSTEM = `You are a quiet tutor watching a kid's tablet over their shoulder.
Image 1 is the kid's main screen: the task they are working on (a practice problem, a worksheet, a page). It may be missing.
The last image is the kid's rough work on the tablet right now, as ink. Ignore any app toolbars, menus or cursors in it, and ignore the pixel-art rabbit, his speech bubble, his green chalkboard and any teal ring: they are the tutor's, not the kid's.
Read the ink top to bottom and judge whether the work is on the right path for the task on the main screen.
Reply with ONE JSON object and nothing else:
{"lines":["each written line as text, top to bottom"],
 "status":"ok"|"off"|"unclear",
 "line":<1-based number of the first line with a mistake, or null>,
 "box":<[ymin,xmin,ymax,xmax] of that whole wrong line in the tablet image, integers 0 to 1000, or null>,
 "mark":<[ymin,xmin,ymax,xmax] of the exact part of that line to circle: the wrong sign, number or symbol, tight around it; the whole line only when the setup itself is wrong; or null>,
 "issue":"<what is wrong, in words a ten year old gets, or empty>",
 "nudge":"<one short spoken sentence, see RUNG, or empty>",
 "confidence":<0 to 1, how sure you are about off>,
 "solved":<true only when the work ends in a correct final answer for the task>,
 "note":["chalk lines for a small note, see STALL, or an empty list"],
 "space":<[ymin,xmin,ymax,xmax] of the largest empty area of the tablet image, or null>}
Rules:
- "off" only when you can read a specific mistake with confidence: a wrong operation, a wrong number carried over, a setup that does not match the task, a misread of the task.
- Being slow, messy, unfinished or mid-step is "ok". The kid may be mid-word or mid-number on the last line: a line that could still be growing (a cut-off number, a trailing operator, an equals sign with little after it) is unfinished, never "off". Blank, unreadable or unrelated ink is "unclear".
- Never state the answer, the corrected line, or the missing number. Name the step, not the fix.
- Keep the nudge under 15 words. Warm and plain. No praise words, no exclamation marks, no dashes.
RUNG (how much the nudge gives away; the request says which nudge this is on the line that was wrong last time; a different mistake starts at 1):
- 1: ask ONE short question that sends them back to re-check the step, without naming what is wrong. Like "What happens to the 5 when it crosses the equals sign?"
- 2: name the exact part to look at and the kind of thing to check (a sign, an operation, a copied number), still not the correction. Like "Look at the sign in front of the 5 as it moves across."
- 3: a tiny analogous example with different numbers, under 20 words, that shows the kind of move, never their numbers. Like "With y plus 2 equals 9 you take 2 away from both sides."
STALL (only when the request says the reason is "stall": the pen has been still for a while):
- If the work is unfinished, stuck or wrong, fill "note" with a small chalk note that helps them take the next step on their own: an analogous example with different numbers, a question, or a small diagram. Never the corrected line, never their answer.
- Note lines: plain text lines (at most 4, each under 24 characters), and shape lines on a 100 by 100 board: "line x1 y1 x2 y2", "arrow x1 y1 x2 y2", "circle cx cy r", "rect x y w h", "label x y words". At most 6 shapes. An optional first line ending with ":" is the title.
- With a note, "nudge" is the one spoken sentence that goes with it, like "Here is a similar one."
- If a note would not help (the work is solved, or unclear), leave "note" empty.`;

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
        let judgement = await this.callGemini(input);
        // A note in the kid's own numbers is the worked step in disguise: one more try in other numbers, else no note.
        let reused = noteReusesNumbers(judgement.lines, judgement.note);
        if (reused.length) {
          logger.info("note reused the kid's numbers; asking again", { reused });
          judgement = await this.callGemini(input, `Your last note reused the kid's own numbers (${reused.join(", ")}). Write the note again with different numbers, as an analogous example, a question or a diagram, or leave "note" empty.`);
          reused = noteReusesNumbers(judgement.lines, judgement.note);
          if (reused.length) judgement = { ...judgement, note: [] };
        }
        logger.info("judge", { reason: input.reason, rung: input.rung, status: judgement.status, line: judgement.line, mark: !!judgement.mark, note: judgement.note.length, confidence: judgement.confidence, lines: judgement.lines.length, solved: judgement.solved, ms: Date.now() - started });
        dumpForDebug(input, judgement);
        return { judgement, provider: this.providerName, degraded: false, latencyMs: Date.now() - started };
      } catch (e) {
        logger.warn("gemini judge failed; using the mock", { error: e instanceof Error ? e.message : String(e) });
        return { judgement: judgeInkMock(input), provider: "mock-fallback", degraded: true, latencyMs: Date.now() - started };
      }
    }
    return { judgement: judgeInkMock(input), provider: "mock", degraded: false, latencyMs: Date.now() - started };
  }

  private async callGemini(input: InkJudgeInput, correction?: string): Promise<InkJudgement> {
    const frame = imagePart(input.frame);
    if (!frame) throw new Error("frame is not an image data URL");
    const context = input.context ? imagePart(input.context) : null;
    const parts: GeminiPart[] = [];
    if (context) {
      parts.push({ text: `Image 1, the kid's main screen (title: ${input.contextTitle || "unknown"}; url: ${input.contextUrl || "unknown"}):` }, context);
    } else {
      parts.push({ text: `The kid's main screen could not be captured. Its title is: ${input.contextTitle || "unknown"}.` });
    }
    const memory = input.previousLines.length ? ` Last time you read these lines, possibly mid-stroke, so re-read every line from the image and trust the image over this list: ${JSON.stringify(input.previousLines.slice(-12))}.` : "";
    const rung = Math.min(MAX_RUNG, Math.max(1, Math.floor(input.rung) || 1));
    const rungNote = input.lastWrongLine ? ` This is nudge ${rung} on the line "${input.lastWrongLine.slice(0, 60)}" if that line is still wrong; a different mistake is nudge 1.` : " This is nudge 1.";
    parts.push({ text: `The tablet now. Reason for this check: ${input.reason}.${rungNote}${memory}${correction ? ` ${correction}` : ""}` }, frame);
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
    // A note is a stall's answer only; on an ordinary check the nudge alone is the help.
    return input.reason === "stall" ? v.judgement : { ...v.judgement, note: [] };
  }
}
