/**
 * The tablet watcher's judge contract. The background sends a fresh frame of the kid's ink plus a
 * picture of their main screen; the judge reads the ink and says whether the work is on the right
 * path for the task on that screen. The server validates whatever the model returns with
 * `validateInkJudgement`, and `judgeInkMock` keeps the beat rehearsable without a key.
 */
export interface InkJudgeInput {
  /** JPEG data URL of the tablet screen right now. */
  frame: string;
  /** JPEG data URL of the kid's main screen (the task), or null when it could not be captured. */
  context: string | null;
  contextTitle: string;
  contextUrl: string;
  /** What the judge read last time, so it only has to read what is new. */
  previousLines: string[];
  /** Checks so far this watch session (the mock script keys off it). */
  seq: number;
}

export type InkStatus = "ok" | "off" | "unclear";

export interface InkJudgement {
  /** Every written line as text, top to bottom. */
  lines: string[];
  status: InkStatus;
  /** 1-based line holding the first mistake, when status is "off". */
  line: number | null;
  /** What is wrong, in kid words. Empty unless "off". */
  issue: string;
  /** One short spoken sentence naming the step to look at again, never the fix. Empty unless "off". */
  nudge: string;
  /** 0..1, how sure the judge is about "off". */
  confidence: number;
  /** The work ends in a correct final answer for the task on screen. */
  solved: boolean;
}

export interface InkJudgeOutput {
  judgement: InkJudgement;
  provider: string;
  degraded: boolean;
  latencyMs: number;
}

const STATUS = new Set<string>(["ok", "off", "unclear"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateInkJudgement(raw: unknown): { ok: true; judgement: InkJudgement } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "judgement is not an object" };
  const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  if (!STATUS.has(status)) return { ok: false, error: "invalid status" };
  const lines = Array.isArray(raw.lines)
    ? raw.lines
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 40)
    : [];
  const line = typeof raw.line === "number" && Number.isFinite(raw.line) && raw.line >= 1 ? Math.floor(raw.line) : null;
  const rawConfidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? raw.confidence : status === "off" ? 0.5 : 0;
  const confidence = Math.min(1, Math.max(0, rawConfidence));
  const issue = typeof raw.issue === "string" ? raw.issue.trim().slice(0, 200) : "";
  const nudge = typeof raw.nudge === "string" ? raw.nudge.trim().slice(0, 200) : "";
  if (status === "off" && !nudge) return { ok: false, error: "off requires a nudge" };
  const off = status === "off";
  return {
    ok: true,
    judgement: {
      lines,
      status: status as InkStatus,
      line: off ? line : null,
      issue: off ? issue : "",
      nudge: off ? nudge : "",
      confidence,
      solved: status === "ok" && raw.solved === true,
    },
  };
}

/** Scripted verdicts for rehearsals without a key: the first line is fine, the second slips, then it is fixed. */
export function judgeInkMock(input: InkJudgeInput): InkJudgement {
  const step = input.seq % 3;
  if (step === 0) return { lines: ["3x + 5 = 20"], status: "ok", line: null, issue: "", nudge: "", confidence: 0.9, solved: false };
  if (step === 1) {
    return {
      lines: ["3x + 5 = 20", "3x = 25"],
      status: "off",
      line: 2,
      issue: "the 5 was added instead of taken away",
      nudge: "Look again at how you moved the 5 across.",
      confidence: 0.9,
      solved: false,
    };
  }
  return { lines: ["3x + 5 = 20", "3x = 15", "x = 5"], status: "ok", line: null, issue: "", nudge: "", confidence: 0.95, solved: true };
}
