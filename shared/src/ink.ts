/**
 * The tablet watcher's judge contract. The background sends a fresh frame of the kid's ink plus a
 * picture of their main screen; the judge reads the ink, says whether the work is on the right
 * path for the task on that screen, and says WHERE: the wrong line and the exact part of it to
 * circle, as fractions of the frame, so the rabbit can go and stand beside the mistake. On a stall
 * (the pen has been still for a while) it may also hand back a small chalk note in the sketch
 * language. The server validates whatever the model returns with `validateInkJudgement`, and
 * `judgeInkMock` keeps the beat rehearsable without a key.
 */
export type InkReason = "ink" | "pause" | "stall";

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
  /** Why the watcher asked: new ink, a short pause with a little ink, or a long stall. */
  reason: InkReason;
  /** Nudge number on the line last judged wrong, 1 to 3: how much the nudge may give away. */
  rung: number;
  /** The line last judged wrong, as read, so the rung only applies while that same line is still wrong. */
  lastWrongLine: string | null;
}

export type InkStatus = "ok" | "off" | "unclear";

/** A region of the tablet frame, as fractions of its width and height. */
export interface InkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InkJudgement {
  /** Every written line as text, top to bottom. */
  lines: string[];
  status: InkStatus;
  /** 1-based line holding the first mistake, when status is "off". */
  line: number | null;
  /** Where that whole line is in the frame. Null unless "off". */
  box: InkBox | null;
  /** The exact part of the line to circle: the wrong sign, number or symbol. Null unless "off". */
  mark: InkBox | null;
  /** What is wrong, in kid words. Empty unless "off". */
  issue: string;
  /** One short spoken sentence, never the fix. Empty unless "off" or a note is present. */
  nudge: string;
  /** 0..1, how sure the judge is about "off". */
  confidence: number;
  /** The work ends in a correct final answer for the task on screen. */
  solved: boolean;
  /** A stall's chalk note in the sketch language (text lines and shape lines), empty otherwise. */
  note: string[];
  /** The largest empty area of the frame, where the rabbit can stand with his board. */
  space: InkBox | null;
}

export interface InkJudgeOutput {
  judgement: InkJudgement;
  provider: string;
  degraded: boolean;
  latencyMs: number;
}

export const MAX_RUNG = 3;
const STATUS = new Set<string>(["ok", "off", "unclear"]);
const MIN_BOX = 0.002;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * A box in either form: the model's `[ymin, xmin, ymax, xmax]` on 0..1000 (fractions 0..1 are
 * accepted too), or an `{x, y, w, h}` of fractions, so a judgement survives a round trip through
 * the validator. Empty or degenerate boxes are null.
 */
export function parseInkBox(raw: unknown): InkBox | null {
  if (isObj(raw)) {
    const n = [raw.x, raw.y, raw.w, raw.h].map(Number);
    if (n.some((v) => !Number.isFinite(v))) return null;
    const x = clamp01(n[0]);
    const y = clamp01(n[1]);
    const w = Math.min(1 - x, Math.max(0, n[2]));
    const h = Math.min(1 - y, Math.max(0, n[3]));
    return w >= MIN_BOX && h >= MIN_BOX ? { x, y, w, h } : null;
  }
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const n = raw.map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;
  const scale = n.every((v) => v >= 0 && v <= 1) ? 1 : 1000;
  const [y1, x1, y2, x2] = n.map((v) => clamp01(v / scale));
  const w = x2 - x1;
  const h = y2 - y1;
  return w >= MIN_BOX && h >= MIN_BOX ? { x: x1, y: y1, w, h } : null;
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
  const confidence = clamp01(rawConfidence);
  const issue = typeof raw.issue === "string" ? raw.issue.trim().slice(0, 200) : "";
  const nudge = typeof raw.nudge === "string" ? raw.nudge.trim().slice(0, 200) : "";
  const note = Array.isArray(raw.note)
    ? raw.note
        .filter((l): l is string => typeof l === "string")
        .map((l) => l.trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 12)
    : [];
  if (status === "off" && !nudge) return { ok: false, error: "off requires a nudge" };
  const off = status === "off";
  const box = off ? parseInkBox(raw.box) : null;
  return {
    ok: true,
    judgement: {
      lines,
      status: status as InkStatus,
      line: off ? line : null,
      box,
      // A mark without its line is still a place to circle; a line without a mark is circled whole.
      mark: off ? (parseInkBox(raw.mark) ?? box) : null,
      issue: off ? issue : "",
      nudge: off || note.length ? nudge : "",
      confidence,
      solved: status === "ok" && raw.solved === true,
      note,
      space: parseInkBox(raw.space),
    },
  };
}

/** Where the mock's lines sit on a 1280 x 800 board: "3x + 5 = 20" then "3x = 25", the 25 marked, empty space below. */
const MOCK_BOX: InkBox = { x: 0.248, y: 0.398, w: 0.064, h: 0.027 };
const MOCK_MARK: InkBox = { x: 0.287, y: 0.398, w: 0.025, h: 0.026 };
const MOCK_SPACE: InkBox = { x: 0.224, y: 0.465, w: 0.576, h: 0.452 };
const MOCK_NUDGES = ["What happens to the 5 when it crosses the equals sign?", "Look at the sign in front of the 5 as it moves across.", "With y plus 2 equals 9 you take 2 away from both sides."];
const MOCK_NOTE = ["A similar one:", "y + 2 = 9", "take 2 from both sides", "y = 7"];

/**
 * Scripted verdicts for rehearsals without a key: the first line is fine, the second slips (the
 * nudge climbs with the rung), then it is fixed. A stall hands back the chalk note.
 */
export function judgeInkMock(input: InkJudgeInput): InkJudgement {
  const blank = { box: null, mark: null, note: [] as string[], space: MOCK_SPACE };
  if (input.reason === "stall") {
    return {
      lines: ["3x + 5 = 20", "3x = 25"],
      status: "off",
      line: 2,
      box: MOCK_BOX,
      mark: MOCK_MARK,
      issue: "the 5 was added instead of taken away",
      nudge: "Here is a similar one to try.",
      confidence: 0.9,
      solved: false,
      note: MOCK_NOTE,
      space: MOCK_SPACE,
    };
  }
  const step = input.seq % 3;
  if (step === 0) return { lines: ["3x + 5 = 20"], status: "ok", line: null, issue: "", nudge: "", confidence: 0.9, solved: false, ...blank };
  if (step === 1) {
    const rung = Math.min(MAX_RUNG, Math.max(1, Math.floor(input.rung) || 1));
    return {
      lines: ["3x + 5 = 20", "3x = 25"],
      status: "off",
      line: 2,
      box: MOCK_BOX,
      mark: MOCK_MARK,
      issue: "the 5 was added instead of taken away",
      nudge: MOCK_NUDGES[rung - 1],
      confidence: 0.9,
      solved: false,
      note: [],
      space: MOCK_SPACE,
    };
  }
  return { lines: ["3x + 5 = 20", "3x = 15", "x = 5"], status: "ok", line: null, issue: "", nudge: "", confidence: 0.95, solved: true, ...blank };
}
