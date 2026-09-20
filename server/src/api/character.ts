import OpenAI from "openai";
import type { Config } from "../config";
import { log } from "../util/logger";

const logger = log("character");

/**
 * Colour by numbers for the "Become a character" page. The page cuts a drawing out of a photo,
 * numbers the regions between its lines, and sends the numbered picture (plus the original photo
 * and the kid's one line about who it is). One vision call names the character and gives each
 * region a flat colour; the page fills them in and pixelizes as usual. Without an OpenAI key a
 * mock hands back a bright palette so the page still works.
 */
export interface PaintInput {
  /** The cut-out with region numbers drawn on, as a data URL. */
  numbered: string;
  /** The photo as taken, as a data URL. Optional. */
  photo?: string;
  /** What the kid said the character is. Optional. */
  hint?: string;
  regions: { id: number; size: number }[];
}

export interface PaintOutput {
  name: string;
  /** Region id to "#rrggbb". */
  colors: Record<string, string>;
  provider: "openai" | "mock";
  /** Why the stand-in palette was used, when it was. */
  reason?: string;
}

const SYSTEM = `You colour in a kid's drawing so it becomes a small pixel-art character.
Image 1 is the drawing, cut out, with a number written on each region between its lines. Image 2, if present, is the photo it came from.
Work out who or what the character is (the kid's own words, when given, win) and pick the flat colour every numbered region should be, the way that character really looks: Pikachu is yellow with red cheeks and black eye regions, a frog is green, a fire truck is red.
Reply with ONE JSON object and nothing else:
{"name":"<the character's name, two or three words at most>","colors":{"1":"#rrggbb","2":"#rrggbb",...}}
Rules: a colour for every number you can see; bold saturated colours that read at 40 pixels tall; eyes usually white with a black pupil region; skin, fur and clothes as the character has them; no greys unless the character is grey.`;

const MOCK_PALETTE = ["#f2c14e", "#2f8f83", "#d9534f", "#ffffff", "#3b2a23", "#6fb7e8", "#e884b7", "#8fd16a"];

export function paintMock(input: PaintInput, reason = "no model key on the server"): PaintOutput {
  const colors: Record<string, string> = {};
  input.regions.forEach((r, i) => {
    colors[String(r.id)] = MOCK_PALETTE[i % MOCK_PALETTE.length];
  });
  return { name: input.hint?.trim() || "Mystery friend", colors, provider: "mock", reason };
}

export function validatePaint(raw: unknown, regions: { id: number }[]): { name: string; colors: Record<string, string> } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { name?: unknown; colors?: unknown };
  const colors: Record<string, string> = {};
  const given = (o.colors && typeof o.colors === "object" ? o.colors : {}) as Record<string, unknown>;
  for (const r of regions) {
    const v = given[String(r.id)];
    if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim())) colors[String(r.id)] = v.trim().toLowerCase();
  }
  if (!Object.keys(colors).length) return null;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 40) : "";
  return { name: name || "My character", colors };
}

export class CharacterService {
  private client: OpenAI | null;
  private model: string;

  constructor(cfg: Config) {
    this.client = cfg.llmProvider === "openai" && cfg.llmApiKey ? new OpenAI({ apiKey: cfg.llmApiKey, timeout: 30_000, maxRetries: 0 }) : null;
    this.model = cfg.llmModel;
  }

  get providerName(): PaintOutput["provider"] {
    return this.client ? "openai" : "mock";
  }

  async paint(input: PaintInput): Promise<PaintOutput> {
    if (!this.client) return paintMock(input);
    const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    const words = input.hint?.trim();
    parts.push({ type: "text", text: `${words ? `The kid says this is: "${words.slice(0, 200)}".` : "The kid did not say who it is."} Regions by size: ${input.regions.map((r) => `${r.id} (${r.size}px)`).join(", ")}.` });
    parts.push({ type: "image_url", image_url: { url: input.numbered, detail: "high" } });
    if (input.photo) parts.push({ type: "image_url", image_url: { url: input.photo, detail: "low" } });
    try {
      const started = Date.now();
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: parts },
        ],
        response_format: { type: "json_object" },
        // A reasoning model spends some of this thinking before the JSON.
        max_completion_tokens: 6000,
      });
      const text = res.choices[0]?.message?.content ?? "";
      const parsed = validatePaint(JSON.parse(text), input.regions);
      logger.info("painted", { ms: Date.now() - started, model: this.model, regions: input.regions.length, coloured: parsed ? Object.keys(parsed.colors).length : 0, name: parsed?.name });
      if (!parsed) {
        logger.warn("paint reply had no usable colours", { text: text.slice(0, 300) });
        return paintMock(input, "the model's reply had no usable colours");
      }
      return { ...parsed, provider: "openai" };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logger.warn("paint failed, using mock", { model: this.model, error });
      return paintMock(input, `the model call failed (${error.slice(0, 120)})`);
    }
  }
}
