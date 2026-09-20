import { useEffect, useRef, type RefObject } from "react";
import type { PetController } from "../pet";
import { useStore } from "../../content/store";
import { petRectFrom, type ActDetail, type PieceContext, type VideoDetail } from "./common";
import { TAB_ACTIONS, playTabPiece } from "./tabs";
import { HAND_ACTIONS, playHandsPiece } from "./hands";
import { playVideoPiece } from "./video";

/**
 * The rabbit acts out what the agent does. "burrow:act" arrives from the executor before each action
 * and "burrow:video" from the video watcher; each picks a set piece by action. A piece's promise is
 * handed back through detail.hold and the executor waits for it (at most 900 ms) so his tap and the
 * click land together. Everything here is show: no piece changes what an action does.
 */
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
    window.addEventListener("burrow:act", onAct);
    window.addEventListener("burrow:video", onVideo);
    return () => {
      window.removeEventListener("burrow:act", onAct);
      window.removeEventListener("burrow:video", onVideo);
    };
  }, [pet]);
  return <div className="pip-actfx" ref={layer} aria-hidden="true" />;
}
