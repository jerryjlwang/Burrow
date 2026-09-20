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

/** The sentence to speak now, if this partial decision qualifies; null otherwise (including "not yet"). */
export function speakableEarly(partialJson: string): string | null {
  const head = earlySayFrom(partialJson);
  return head && head.say && EARLY_SAY_ACTIONS.has(head.action) ? head.say.trim().slice(0, 400) : null;
}
