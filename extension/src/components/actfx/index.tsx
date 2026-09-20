import { useEffect, useRef, type RefObject } from "react";
import type { PetController } from "../pet";
import { store, useStore } from "../../content/store";
import { petRectFrom, type ActDetail, type PieceContext, type VideoDetail } from "./common";
import { TAB_ACTIONS, anticipateTabPiece, playTabPiece } from "./tabs";
import { HAND_ACTIONS, playHandsPiece } from "./hands";
import { playVideoPiece } from "./video";

/**
 * The rabbit acts out what the agent does. "burrow:act" arrives from the executor before each action
 * and "burrow:video" from the video watcher; each picks a set piece by action. A piece's promise is
 * handed back through detail.hold and the executor waits for it (at most 900 ms) so his tap and the
 * click land together. Everything here is show: no piece changes what an action does.
 */
/** What a request probably is, from its words alone; only the tab actions for now. */
function guessAction(text: string): "open_tab" | null {
  const s = text.toLowerCase();
  if (/\b(new|another|separate) tab\b/.test(s) || /\bin a tab\b/.test(s) || /\b(open|launch|pull) up\b.*\btab\b/.test(s)) return "open_tab";
  return null;
}

export function ActionFx({ pet }: { pet: RefObject<PetController | null> }) {
  const reduced = useStore((s) => s.reducedMotion);
  const layer = useRef<HTMLDivElement>(null);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  useEffect(() => {
    const ctx = (): PieceContext | null => {
      const el = layer.current;
      if (!el) return null;
      return { pet: pet.current, layer: el, reduced: reducedRef.current, petRect: () => petRectFrom(el) };
    };
    const onAct = (e: Event) => {
      const d = (e as CustomEvent<ActDetail>).detail;
      const c = ctx();
      if (!d || !c) return;
      const piece = TAB_ACTIONS.has(d.action) ? playTabPiece : HAND_ACTIONS.has(d.action) ? playHandsPiece : null;
      if (!piece) return;
      try {
        const p = piece(d, c);
        if (p) d.hold = p.catch(() => undefined);
      } catch {
        // A broken piece must never break the action.
      }
    };
    // A companion pause fires the DOM pause too: the "them" that follows an "us" within a beat is the same moment.
    let ours: { kind: string; at: number } | null = null;
    const onVideo = (e: Event) => {
      const d = (e as CustomEvent<VideoDetail>).detail;
      const c = ctx();
      if (!d || !c) return;
      if (d.by === "us") ours = { kind: d.kind, at: Date.now() };
      else if (ours && ours.kind === d.kind && Date.now() - ours.at < 400) return;
      try {
        void playVideoPiece(d, c);
      } catch {
        // as above
      }
    };
    // Anticipation: the model takes a second or two to decide. When a new user turn reads like a tab
    // request, he goes up to the strip now and taps the moment the decision lands, so the wait is his trip.
    let lastTurnAt = store.getState().conversation.at(-1)?.at ?? 0;
    const unsub = store.subscribe(() => {
      const turn = store.getState().conversation.at(-1);
      if (!turn || turn.role !== "user" || turn.at <= lastTurnAt) return;
      lastTurnAt = turn.at;
      const c = ctx();
      const guess = guessAction(turn.text);
      if (c && guess) void anticipateTabPiece(guess, c);
    });
    window.addEventListener("burrow:act", onAct);
    window.addEventListener("burrow:video", onVideo);
    return () => {
      unsub();
      window.removeEventListener("burrow:act", onAct);
      window.removeEventListener("burrow:video", onVideo);
    };
  }, [pet]);
  return <div className="pip-actfx" ref={layer} aria-hidden="true" />;
}
