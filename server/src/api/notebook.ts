import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("notebook");

/**
 * The notebook reader. The notebook page (server/../notebook-page) points the laptop's webcam at
 * a paper notebook and sends a frame here whenever the pen has rested after new writing. Gemini
 * finds the sheet of paper in the frame and reads every written line with its box, and the page
 * lays those lines out on a blank canvas as the kid's handwriting, so the tablet watcher and the
 * judge see a board like any other. No key: a scripted reading, so the page can be rehearsed.
 */

/** Fractions of the frame, 0..1, x and y from the top left. */
export interface NotebookPoint {
  x: number;
  y: number;
}
export interface NotebookBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface NotebookLine {
  text: string;
  box: NotebookBox;
}
export interface NotebookReading {
  /** The sheet of paper's corners, top-left, top-right, bottom-right, bottom-left, or null when no paper is in view. */
  page: [NotebookPoint, NotebookPoint, NotebookPoint, NotebookPoint] | null;
  /** Every written line, top to bottom, boxed in frame fractions. */
  lines: NotebookLine[];
  /** True when a hand or pen covers part of the writing, so the page keeps its last reading of that part. */
  covered: boolean;
}
export interface NotebookReadInput {
  /** The webcam frame as a data URL (jpeg, png or webp). */
  frame: string;
  /** The lines as last read, so a steady reading stays steady. */
  previousLines: string[];
}
export interface NotebookReadOutput {
  reading: NotebookReading;
  provider: string;
  latencyMs: number;
}

const SYSTEM = `You read a paper notebook through a laptop webcam. The laptop lid is tilted down so the camera looks at the desk; the image may be dim, tilted, or partly covered by a hand or pen.
Reply with ONE JSON object and nothing else:
{"page":<[[x,y],[x,y],[x,y],[x,y]] the four corners of the sheet of paper being written on (or, when the writing is on another flat surface such as a whiteboard or a screen, that surface), integers 0 to 1000 across the image, in the order top-left, top-right, bottom-right, bottom-left as the writing reads; or null if nothing to write on is in view>,
 "lines":[{"text":"<one written line, exactly as written, in plain text>","box":[ymin,xmin,ymax,xmax]}],
 "covered":<true when a hand, pen or shadow hides part of the writing>}
Rules:
- One entry per handwritten line, top to bottom. Boxes are integers 0 to 1000 across the whole image, tight around that line's ink.
- Transcribe exactly what is written, including mistakes, crossed-out parts (write them as ~~like this~~) and unfinished numbers. Never correct or complete the work.
- Write fractions as a/b, exponents as x^2, square roots as sqrt(x), and keep = + - x / as written. A long division or a column sum is several lines, one per written row.
- Ignore printed text such as page numbers, ruled lines, headers and anything outside the sheet.
- When the same line was read before (the request lists the last reading), keep the same wording unless the ink clearly changed.
- No paper in view, or nothing written: "page" null or "lines" empty, as it is.`;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

function imagePart(dataUrl: string): GeminiPart | null {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
}

const frac = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n / 1000)) : null);

function parseBox(raw: unknown): NotebookBox | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [y0, x0, y1, x1] = raw.map(frac);
  if (y0 === null || x0 === null || y1 === null || x1 === null) return null;
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function parsePage(raw: unknown): NotebookReading["page"] {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const pts: NotebookPoint[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = frac(p[0]);
    const y = frac(p[1]);
    if (x === null || y === null) return null;
    pts.push({ x, y });
  }
  return [pts[0], pts[1], pts[2], pts[3]];
}

/** What the model returned, checked and clamped; a bad shape is an error, not a silent blank. */
export function validateNotebookReading(raw: unknown): { ok: true; reading: NotebookReading } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.lines)) return { ok: false, error: "lines is not a list" };
  const lines: NotebookLine[] = [];
  for (const l of r.lines.slice(0, 40)) {
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 120) : "";
    const box = parseBox(o.box);
    if (text && box) lines.push({ text, box });
  }
  lines.sort((a, b) => a.box.y - b.box.y);
  return { ok: true, reading: { page: parsePage(r.page), lines, covered: r.covered === true } };
}

const MOCK_LINES: NotebookLine[] = [
  { text: "3x + 5 = 20", box: { x: 0.3, y: 0.3, w: 0.22, h: 0.05 } },
  { text: "3x = 25", box: { x: 0.3, y: 0.4, w: 0.15, h: 0.05 } },
];

/** A scripted reading for rehearsals without a key: the same two lines every time, on a sheet filling most of the frame. */
export function readNotebookMock(): NotebookReading {
  return { page: [{ x: 0.15, y: 0.1 }, { x: 0.85, y: 0.1 }, { x: 0.9, y: 0.95 }, { x: 0.1, y: 0.95 }], lines: MOCK_LINES, covered: false };
}

export class NotebookService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(cfg: Config) {
    this.apiKey = cfg.geminiApiKey;
    this.model = cfg.inkModel;
  }

  get providerName(): string {
    return this.apiKey ? `gemini:${this.model}` : "mock";
  }

  async read(input: NotebookReadInput): Promise<NotebookReadOutput> {
    const started = Date.now();
    if (!this.apiKey) return { reading: readNotebookMock(), provider: "mock", latencyMs: Date.now() - started };
    const frame = imagePart(input.frame);
    if (!frame) throw new Error("frame is not an image data URL");
    const memory = input.previousLines.length ? ` Last reading, top to bottom: ${JSON.stringify(input.previousLines.slice(-20))}.` : "";
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: `The webcam now.${memory}` }, frame] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1, thinkingConfig: { thinkingLevel: "low" } },
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
    const v = validateNotebookReading(raw);
    if (!v.ok) throw new Error(`invalid reading: ${v.error}`);
    logger.info("read", { lines: v.reading.lines.length, page: !!v.reading.page, covered: v.reading.covered, ms: Date.now() - started });
    return { reading: v.reading, provider: this.providerName, latencyMs: Date.now() - started };
  }
}
