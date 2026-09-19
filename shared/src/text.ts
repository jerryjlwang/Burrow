import type { PageElement } from "./types";

const STOP_WORDS = new Set([
  "the", "a", "an", "to", "of", "on", "in", "for", "my", "me", "is", "it", "this", "that", "please", "can", "you",
  "where", "which", "what", "do", "i", "find", "show", "open", "click", "press", "tap", "go", "take", "button",
  "link", "there", "here", "at", "with", "and", "up", "down", "into", "want", "would", "like", "need", "could",
  "hit", "select", "choose", "one", "thing", "page", "s", "should", "be", "are", "let", "lets",
]);

const SYNONYMS: Record<string, string[]> = {
  "sign in": ["log in", "login", "signin", "sign-in", "log-in"],
  "log in": ["sign in", "login", "signin"],
  "sign up": ["register", "create account", "join", "signup"],
  "sign out": ["log out", "logout", "signout"],
  submit: ["turn in", "send", "hand in", "check", "check answer", "finish"],
  search: ["find", "look up"],
  assignment: ["homework", "task", "work", "assignments"],
  quiz: ["test", "exam", "assessment", "quizzes"],
  menu: ["navigation", "nav", "hamburger"],
  next: ["continue", "forward", "proceed"],
  back: ["previous", "prev", "return"],
  answer: ["response", "solution"],
  grades: ["marks", "scores", "results"],
  modules: ["units", "lessons", "chapters", "module"],
  home: ["dashboard", "start"],
};

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeText(s)
    .split(/[\s-]+/)
    .map(stem)
    .filter((t) => t.length > 0);
}

export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function contentTokens(s: string): string[] {
  return tokenize(s).filter((t) => !STOP_WORDS.has(t));
}

function expandQuery(query: string): string[] {
  const q = normalizeText(query);
  const variants = new Set<string>([q]);
  for (const [key, syns] of Object.entries(SYNONYMS)) {
    if (q.includes(key)) for (const s of syns) variants.add(q.replace(key, s));
    for (const s of syns) if (q.includes(s)) variants.add(q.replace(s, key));
  }
  return [...variants];
}

/** 0..1 similarity between a query phrase and a candidate label. */
export function scoreMatch(query: string, candidate: string): number {
  const cand = normalizeText(candidate);
  if (!cand) return 0;
  let best = 0;
  for (const q of expandQuery(query)) {
    if (!q) continue;
    if (cand === q) return 1;
    let s = 0;
    if (cand.includes(q) || q.includes(cand)) s = Math.max(s, 0.85 * Math.min(1, cand.length / Math.max(q.length, 1)));
    const qt = contentTokens(q);
    const ct = new Set(tokenize(cand));
    if (qt.length) {
      const hits = qt.filter((t) => ct.has(t)).length;
      s = Math.max(s, (hits / qt.length) * 0.8 + (hits === qt.length ? 0.15 : 0));
    }
    best = Math.max(best, s);
  }
  return best;
}

export interface ElementMatch {
  element: PageElement;
  score: number;
}

export interface FindOptions {
  /** Prefer these roles (score bonus). */
  preferRoles?: string[];
  /** Only consider these roles. */
  onlyRoles?: string[];
  minScore?: number;
}

const ROLE_GROUPS: Record<string, string[]> = {
  clickable: ["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option"],
  typeable: ["textbox", "searchbox", "combobox", "spinbutton", "textarea"],
};

export function findElements(elements: PageElement[], query: string, opts: FindOptions = {}): ElementMatch[] {
  const minScore = opts.minScore ?? 0.45;
  const only = opts.onlyRoles?.flatMap((r) => ROLE_GROUPS[r] ?? [r]);
  const prefer = opts.preferRoles?.flatMap((r) => ROLE_GROUPS[r] ?? [r]);
  const out: ElementMatch[] = [];
  for (const el of elements) {
    if (only && !only.includes(el.role)) continue;
    const label = [el.name, el.text, el.placeholder, el.context].filter(Boolean).join(" ");
    let score = scoreMatch(query, el.name || "");
    if (label !== el.name) score = Math.max(score, scoreMatch(query, label) * 0.9);
    // The user often says the role: "the submit button" → the role word itself should not penalize.
    if (score < minScore) continue;
    if (prefer?.includes(el.role)) score += 0.08;
    if (el.inViewport) score += 0.03;
    if (el.disabled) score -= 0.05;
    out.push({ element: el, score: Math.min(score, 1) });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function findBestElement(elements: PageElement[], query: string, opts: FindOptions = {}): PageElement | null {
  return findElements(elements, query, opts)[0]?.element ?? null;
}

/** Strips leading verbs like "click the" / "where is my" to get the object phrase. */
export function extractTarget(utterance: string): string {
  let s = normalizeText(utterance);
  const patterns = [
    /^(hey|hi|ok|okay|pip|please|um|uh|so|yeah)\s+/,
    /^(can|could|would|will) (you|u)\s+/,
    /^(please\s+)?(click|press|tap|hit|open|select|choose|go to|take me to|navigate to|show me|find|where is|where s|wheres|where are|where can i find|where do i|how do i|point to|point at|highlight|locate|bring me to)\s+/,
    /^(on|the|my|a|an|this|that)\s+/,
    /\s+(please|for me|now|pip)$/,
    /\s+(button|link|thing|field|box|input)$/,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const next = s.replace(p, "").trim();
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return s;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function isAffirmative(s: string): boolean {
  const n = normalizeText(s);
  return /^(yes|yeah|yep|yup|ya|sure|ok|okay|please|go ahead|do it|go for it|yes please|sounds good|alright|absolutely|definitely|of course|i d like that|that would be great|why not|let s do it|fine|mm hmm|uh huh|yeah please|yes do it|confirm|correct|right)\b/.test(n) && n.split(" ").length <= 6;
}

export function isNegative(s: string): boolean {
  const n = normalizeText(s);
  return /^(no|nope|nah|not now|i m good|im good|i m fine|im fine|no thanks|no thank you|don t|dont|stop|cancel|never mind|nevermind|leave it|not yet|i got it|i ve got it|ive got it|i m okay|im okay|later|no need)\b/.test(n) && n.split(" ").length <= 6;
}

export function isStopCommand(s: string): boolean {
  const n = normalizeText(s);
  return /^(stop|wait|hold on|hang on|pause|shush|shh|quiet|be quiet|shut up|enough|okay stop|ok stop|stop talking|that s enough|thats enough|never mind|nevermind)\b/.test(n) && n.split(" ").length <= 4;
}
