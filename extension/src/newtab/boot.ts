// The boot: the world is dug out of dark earth when a new tab opens. The full choreography runs on the
// first new tab of a browser session (chrome.storage.session, which lives exactly that long; the
// per-tab sessionStorage is only a fallback), later tabs get a quick dissolve, reduced motion skips it.
// Whatever happens, "burrow:enter" is dispatched exactly once so the rabbit can pop out of his hole.

export type BootMode = "full" | "quick" | "none";

/** When the world is complete in the full boot; the boot line lingers a beat longer. */
export const BOOT_FULL_MS = 2200;
export const BOOT_QUICK_MS = 600;
/** Whatever the scene does, the rabbit is asked in by this time. */
export const ENTER_DEADLINE_MS = 2900;
const FLAG = "burrow.booted";

let entered = false;

export function enter(): void {
  if (entered) return;
  entered = true;
  window.dispatchEvent(new CustomEvent("burrow:enter"));
}

export function hasEntered(): boolean {
  return entered;
}

export async function decideBootMode(reducedMotion: boolean): Promise<BootMode> {
  if (reducedMotion) return "none";
  try {
    const got = await chrome.storage.session.get(FLAG);
    if (got?.[FLAG]) return "quick";
    await chrome.storage.session.set({ [FLAG]: true });
    return "full";
  } catch {
    try {
      if (sessionStorage.getItem(FLAG)) return "quick";
      sessionStorage.setItem(FLAG, "1");
    } catch {
      /* no storage: run the full boot */
    }
    return "full";
  }
}

/** What the boot line says at each phase of the full sequence. */
export function bootLabel(elapsed: number): string {
  if (elapsed < 400) return "digging up...";
  if (elapsed < 1000) return "sky";
  if (elapsed < 1400) return "hills";
  if (elapsed < 1600) return "planting";
  if (elapsed < 1900) return "signs";
  if (elapsed < BOOT_FULL_MS) return "waking the rabbit";
  return "ready.";
}

/** The three step drop of a sign: hidden, then -60, -30, -9, a 3px squash, and in place. */
export function dropClass(elapsed: number, start: number): string {
  if (elapsed < start) return "offstage";
  const step = Math.floor((elapsed - start) / 80);
  return ["drop-1", "drop-2", "drop-3", "squash"][step] ?? "";
}
