import { useEffect, useRef, useSyncExternalStore } from "react";
import type { CompanionController } from "../content/controller";
import { store } from "../content/store";
import { plainCopy } from "./copy";

/**
 * The teaching loop made visible. Two page events on window drive it (docs/frontend/KID_UI.md, Events):
 * "burrow:teach" {heard, concept} shows what he thinks he heard with Yes and Not quite, and
 * "burrow:forget" {concept} dissolves a thought bubble pixel by pixel, then offers "Remind me?".
 * The card keeps its own tiny store here; nothing is added to the content store.
 */

/** How long "Got it. I'll remember." stays up. */
const GOT_MS = 2000;
/** The thought bubble sits still for this long before it dissolves. */
const THOUGHT_MS = 1000;
/** The pixel dissolve (pip-dissolve in styles.css) plus a frame, so the last step is seen. */
const DISSOLVE_MS = 760;
/** "Tell me again" leaves the panel's status line after this long if nothing else replaced it. */
const STATUS_MS = 15000;
const TELL_ME_AGAIN = "Tell me again";

type Card =
  | { kind: "teach"; id: number; heard: string; concept: string; phase: "ask" | "got" }
  | { kind: "forget"; id: number; concept: string; phase: "thought" | "dissolve" | "card" };

let card: Card | null = null;
let seq = 0;
let timer = 0;
const listeners = new Set<() => void>();

function set(next: Card | null): void {
  card = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getCard = (): Card | null => card;

/** One pending step at a time; a new event or an answer cancels the old one. */
function later(ms: number, fn: () => void): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(fn, ms);
}

function showTeach(heard: string, concept: string): void {
  window.clearTimeout(timer);
  set({ kind: "teach", id: ++seq, heard: plainCopy(heard).trim(), concept: plainCopy(concept).trim(), phase: "ask" });
}

function showForget(concept: string): void {
  const id = ++seq;
  set({ kind: "forget", id, concept: plainCopy(concept).trim(), phase: "thought" });
  later(THOUGHT_MS, () => {
    const c = card;
    if (!c || c.kind !== "forget" || c.id !== id) return;
    set({ ...c, phase: "dissolve" });
    later(DISSOLVE_MS, () => {
      const d = card;
      if (!d || d.kind !== "forget" || d.id !== id) return;
      set({ ...d, phase: "card" });
    });
  });
}

/** Tells whoever sent burrow:teach what the kid answered. */
function answer(c: Extract<Card, { kind: "teach" }>, yes: boolean): void {
  window.dispatchEvent(new CustomEvent("burrow:taught", { detail: { concept: c.concept, heard: c.heard, yes } }));
}

/**
 * The panel's input belongs to Panel.tsx and keeps its own state, so the text goes in through the DOM
 * the way a paste would: the native value setter, then an input event React listens for.
 */
function fillPanelInput(root: Document | ShadowRoot, text: string, tries = 20): void {
  const input = root.querySelector<HTMLInputElement>(".pip-input");
  if (!input) {
    if (tries > 0) window.setTimeout(() => fillPanelInput(root, text, tries - 1), 50);
    return;
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, text);
  else input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus({ preventScroll: true });
  input.setSelectionRange(text.length, text.length);
  // The caret sits at the end, as after typing; a line wider than the field shows its end.
  input.scrollLeft = input.scrollWidth;
}

function focusPanelInput(root: Document | ShadowRoot, tries = 20): void {
  const input = root.querySelector<HTMLInputElement>(".pip-input");
  if (input) input.focus({ preventScroll: true });
  else if (tries > 0) window.setTimeout(() => focusPanelInput(root, tries - 1), 50);
}

export function TeachCard({ controller }: { controller: CompanionController }) {
  const c = useSyncExternalStore(subscribe, getCard, getCard);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onTeach = (e: Event) => {
      const d = (e as CustomEvent<{ heard?: unknown; concept?: unknown }>).detail;
      if (!d || typeof d.heard !== "string" || !d.heard.trim()) return;
      showTeach(d.heard, typeof d.concept === "string" ? d.concept : "");
    };
    const onForget = (e: Event) => {
      const d = (e as CustomEvent<{ concept?: unknown }>).detail;
      if (!d || typeof d.concept !== "string" || !d.concept.trim()) return;
      showForget(d.concept);
    };
    window.addEventListener("burrow:teach", onTeach);
    window.addEventListener("burrow:forget", onForget);
    return () => {
      window.removeEventListener("burrow:teach", onTeach);
      window.removeEventListener("burrow:forget", onForget);
    };
  }, []);

  /** The shadow root the card lives in, read before the card leaves the DOM. */
  const root = (): Document | ShadowRoot => (wrap.current?.getRootNode() as Document | ShadowRoot | undefined) ?? document;

  const yes = () => {
    const t = card;
    if (!t || t.kind !== "teach" || t.phase !== "ask") return;
    window.dispatchEvent(new CustomEvent("burrow:play", { detail: { state: "celebrate" } }));
    answer(t, true);
    set({ ...t, phase: "got" });
    later(GOT_MS, () => {
      if (card?.id === t.id) set(null);
    });
  };
  const notQuite = () => {
    const t = card;
    if (!t || t.kind !== "teach" || t.phase !== "ask") return;
    const r = root();
    answer(t, false);
    set(null);
    controller.openPanel();
    store.setState({ status: TELL_ME_AGAIN });
    window.setTimeout(() => store.setState((s) => (s.status === TELL_ME_AGAIN ? { status: "" } : {})), STATUS_MS);
    focusPanelInput(r);
  };
  const remind = () => {
    const f = card;
    if (!f || f.kind !== "forget" || f.phase !== "card") return;
    const r = root();
    set(null);
    controller.openPanel();
    fillPanelInput(r, `Remind me about ${f.concept}`);
  };
  const dismiss = () => {
    window.clearTimeout(timer);
    set(null);
  };

  // Enter is Yes (or Remind me?), Escape is Not quite (or puts the card away). A field being typed in
  // and a focused button keep their own keys.
  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      const target = e.composedPath()[0] as HTMLElement | undefined;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target?.isContentEditable;
      if (e.key === "Enter") {
        if (typing || tag === "BUTTON") return;
        if (c.kind === "teach" && c.phase === "ask") yes();
        else if (c.kind === "forget" && c.phase === "card") remind();
        else return;
        e.preventDefault();
      } else if (e.key === "Escape") {
        if (c.kind === "teach" && c.phase === "ask") notQuite();
        else dismiss();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [c, controller]);

  if (!c) return null;

  if (c.kind === "teach") {
    const got = c.phase === "got";
    return (
      <div ref={wrap} className={`pip-teach px-frame${got ? " got" : ""}`} role="status" aria-live="polite">
        <p className="pip-teach-text">{got ? "Got it. I'll remember." : c.heard}</p>
        {!got && (
          <div className="pip-teach-actions">
            <button type="button" className="pip-btn primary" onClick={yes} autoFocus>
              Yes
            </button>
            <button type="button" className="pip-btn" onClick={notQuite}>
              Not quite
            </button>
          </div>
        )}
      </div>
    );
  }

  if (c.phase !== "card") {
    return (
      <div ref={wrap} className={`pip-thought-wrap${c.phase === "dissolve" ? " dissolving" : ""}`} aria-hidden="true">
        <div className="pip-thought px-frame">{c.concept}</div>
      </div>
    );
  }

  return (
    <div ref={wrap} className="pip-teach px-frame kind-forget" role="status" aria-live="polite">
      <p className="pip-teach-text">I forgot about {c.concept}.</p>
      <div className="pip-teach-actions">
        <button type="button" className="pip-btn primary" onClick={remind} autoFocus>
          Remind me?
        </button>
      </div>
      <button type="button" className="pip-teach-close" aria-label="Not now" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
