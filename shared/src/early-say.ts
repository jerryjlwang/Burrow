/**
 * Speaking before the decision has finished arriving.
 *
 * A decision streams out as JSON in schema order — `action`, then `say`, then a dozen fields that
 * are mostly null plus an internal `reason`. Measured on the production model, the spoken
 * sentence is complete 2–3 seconds before the object closes. For turns that are only talk there
 * is no reason to hold the sentence back until the boilerplate lands.
 *
 * Only actions that are valid with nothing but a `say` qualify: nothing later in the object can
 * invalidate them, no policy gate can turn them into a confirmation, and they do nothing on the
 * page. Anything that points, clicks, types or navigates waits for the whole decision as before.
 */
export const EARLY_SAY_ACTIONS: ReadonlySet<string> = new Set(["speak", "explain", "finish", "ask_user", "show_plan"]);

const PREFIX_RE = /^\s*\{\s*"action"\s*:\s*"([a-z_]+)"\s*,\s*"say"\s*:\s*(null|"(?:[^"\\]|\\.)*")\s*[,}]/;

/**
 * The action and spoken sentence from the front of a partially streamed decision, or null while
 * `say` is still incomplete. Relies on `action` and `say` being the first two keys; if a provider
 * orders keys differently this simply never matches and nothing is spoken early.
 */
export function earlySayFrom(partialJson: string): { action: string; say: string | null } | null {
  const m = PREFIX_RE.exec(partialJson);
  if (!m) return null;
  try {
    const say = JSON.parse(m[2]) as string | null;
    return { action: m[1], say: typeof say === "string" && say.trim() ? say : null };
  } catch {
    return null;
  }
}

/**
 * Pointing at something and saying the hint ("Right here — what did that move do?") is the most
 * common tutoring turn, and it isn't talk-only: it is only valid once it names its target. The
 * target is the third key, so the wait is a few tokens rather than the whole object. With a
 * non-negative elementId these actions are valid, ungated by policy, and change nothing on the page.
 */
export const EARLY_SAY_POINTING: ReadonlySet<string> = new Set(["point_to", "highlight", "scroll_to"]);

const TARGET_RE = /^\s*\{\s*"action"\s*:\s*"[a-z_]+"\s*,\s*"say"\s*:\s*(?:null|"(?:[^"\\]|\\.)*")\s*,\s*"elementId"\s*:\s*(null|-?\d+)\s*[,}]/;

/** The sentence to speak now, if this partial decision qualifies; null otherwise (including "not yet"). */
export function speakableEarly(partialJson: string): string | null {
  const head = earlySayFrom(partialJson);
  if (!head || !head.say) return null;
  const say = head.say.trim().slice(0, 400);
  if (EARLY_SAY_ACTIONS.has(head.action)) return say;
  if (!EARLY_SAY_POINTING.has(head.action)) return null;
  const target = TARGET_RE.exec(partialJson);
  return target && target[1] !== "null" && Number(target[1]) >= 0 ? say : null;
}
