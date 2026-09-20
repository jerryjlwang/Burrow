/**
 * The kid side and the parent side of docs/frontend/HANDOFF.md, plus the rare "I'm late" vignette.
 * Everything goes through chrome.storage.local so two tabs on one machine already work; the
 * backend relay for two laptops writes the same records.
 */
import type { GraphSnapshot } from "@shared/graph";
import type { CompanionController } from "../content/controller";
import type { PetController } from "./pet";
import { dig, dropNotes, holeOf, journey, tunnelIn, unrollNotes, whoosh } from "./tunnel";
import type { Journey } from "./journey";

/** kid: any page the kid works on; parent: parent.html; board: the drawing board the tablet watcher opens. */
export type Role = "kid" | "parent" | "board";
export type JumpStage = "requested" | "gone" | "arrived";

export interface Grant {
  granted: boolean;
  at: number;
}
export interface Jump {
  id: string;
  to: Role;
  /** Where he is coming from, when the writer knows. */
  from?: Role;
  stage: JumpStage;
  at: number;
  summary?: string;
  graph?: GraphSnapshot;
}

function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (raw) => resolve(raw?.[key] as T | undefined));
    } catch {
      resolve(undefined);
    }
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });
}

export const GRANTS_KEY = "burrow.grants";
export const JUMP_KEY = "burrow.jump";
export const GRAPH_KEY = "burrow.graph";
/** Set just before a page navigation the rabbit escorts: the next page pops him out of a hole. */
export const ARRIVE_KEY = "burrow.arrive";
export interface Arrival {
  at: number;
  url: string;
  /** What he says when he pops out. */
  line?: string;
}
/** An arrival older than this is stale (the navigation never happened). */
const ARRIVE_FRESH_MS = 15_000;

export function readArrival(): Promise<Arrival | null> {
  return storageGet<Arrival>(ARRIVE_KEY).then((a) => (a && Date.now() - a.at < ARRIVE_FRESH_MS ? a : null));
}

/** Escort a navigation: say a line, dive, mark the arrival, then go. Without a pet, just go. */
export async function escort(controller: CompanionController, pet: PetController | null, url: string, line: string, arriveLine: string): Promise<void> {
  if (pet) {
    controller.showBubble({ id: `escort-${Date.now()}`, text: line, kind: "info", expiresAt: Date.now() + 2500 });
    await new Promise((r) => setTimeout(r, 700));
    await pet.jumpOut();
  }
  const arrival: Arrival = { at: Date.now(), url, line: arriveLine };
  await storageSet(ARRIVE_KEY, arrival);
  location.assign(url);
}

/** What each skill lets him do, in his own words. */
export const SKILLS: Record<string, string> = {
  read_pages: "see what is on the page",
  use_voice: "listen and talk out loud",
  browse_links: "click and open things",
  remember: "remember what you teach me between days",
  visit_parent: "visit your parent's laptop",
};

/** If the other side never answers, the receiving hole closes on its own after this long. */
const HANDOFF_TIMEOUT_MS = 12_000;
/** The board: how long he is underground after the other screen says he is gone, before its hole opens. */
const BOARD_TRAVEL_MS = 2_500;
/** The board: how long his ears poke out of the hole before he pops out. */
const BOARD_EARS_MS = 700;
/** The notes he brought stay open beside him this long once typed. */
const NOTES_MS = 9_000;
/** The dirt holds a beat after the hole has closed before it lets go of the page. */
const TUNNEL_HOLD_MS = 200;
/** Quiet minutes before he checks his watch, panics and dives to a new spot. */
const VIGNETTE_GAP_MS: [number, number] = [150_000, 300_000];

export function pageRole(): Role {
  if (/\/parent\.html$/.test(location.pathname)) return "parent";
  if (/(^|\.)excalidraw\.com$/.test(location.hostname)) return "board";
  return "kid";
}

/** A jump aimed at `role` that is still in flight: requested moments ago, or gone and not yet arrived. */
export function pendingJumpTo(role: Role): Promise<boolean> {
  return storageGet<Jump>(JUMP_KEY).then((jump) => {
    if (!jump || jump.to !== role) return false;
    if (jump.stage === "gone") return true;
    return jump.stage === "requested" && Date.now() - jump.at < HANDOFF_TIMEOUT_MS;
  });
}

/** How long a manifest state plays once, so the set piece keeps time with the art. */
function stateMs(pet: PetController, name: string): number {
  const s = pet.manifest.states[name];
  return s ? Math.round((s.frames / Math.max(1, s.fps)) * 1000) : 0;
}

/** Skills that flipped to granted between two maps. */
export function newlyGranted(before: Record<string, Grant> | undefined, after: Record<string, Grant> | undefined): string[] {
  const out: string[] = [];
  for (const [skill, g] of Object.entries(after ?? {})) {
    if (g?.granted && !before?.[skill]?.granted) out.push(skill);
  }
  return out;
}

/** What the rabbit says he learned, from the graph he carries. */
export function summarize(graph: GraphSnapshot | null | undefined, now: number): string {
  const nodes = (graph?.nodes ?? []).slice().sort((a, b) => (b.state?.lastSeenAt ?? 0) - (a.state?.lastSeenAt ?? 0));
  const recent = nodes.filter((n) => now - (n.state?.lastSeenAt ?? 0) < 36 * 3600 * 1000).slice(0, 3);
  const labels = recent.map((n) => n.label);
  if (!labels.length) return "I have not learned anything new yet. Teach me something!";
  if (labels.length === 1) return `Today I learned about ${labels[0]}.`;
  return `Today I learned about ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}.`;
}

export function requestJump(to: Role, from?: Role): Promise<void> {
  const jump: Jump = { id: `j-${Date.now().toString(36)}`, to, from, stage: "requested", at: Date.now() };
  return storageSet(JUMP_KEY, jump);
}

/** What he says as he dives, by where he is going. */
function departLine(role: Role, to: Role): string {
  if (to === "board") return "To your drawing board!";
  if (to === "parent") return "Off to see your parent. Back soon!";
  return role === "board" ? "Back to your page!" : "Off I go, back to my kid!";
}

export function grant(skill: string, granted = true): Promise<void> {
  return storageGet<Record<string, Grant>>(GRANTS_KEY).then((map) => storageSet(GRANTS_KEY, { ...(map ?? {}), [skill]: { granted, at: Date.now() } }));
}

interface Deps {
  controller: CompanionController;
  role: Role;
  getPet: () => PetController | null;
  /** Nothing going on: used to gate the vignette. */
  isQuiet: () => boolean;
  reducedMotion: () => boolean;
}

/**
 * Watches storage and drives the pet. Returns a stop function.
 * Only the visible tab acts on a departure so several kid tabs do not all dive.
 */
export function startHandoff(deps: Deps): () => void {
  const { controller, role, getPet } = deps;
  const handled = new Set<string>();
  const waiting = new Map<string, () => void>();
  let stopped = false;
  // While he is away this page must not offer anything from an empty corner: the proactive
  // engine pauses when he leaves and resumes when he lands, always in matched pairs.
  let enginePaused = false;
  const pauseEngine = () => {
    if (enginePaused) return;
    enginePaused = true;
    controller.engine.stop();
  };
  const resumeEngine = () => {
    if (!enginePaused) return;
    enginePaused = false;
    controller.engine.start();
  };

  const say = (id: string, text: string, ms: number) => controller.showBubble({ id, text, kind: "info", expiresAt: Date.now() + ms });

  /** The pet controller, waiting a little for the art to load on a page that is still booting. */
  const petSoon = async (): Promise<PetController | null> => {
    for (let i = 0; i < 20; i++) {
      const pet = getPet();
      if (pet || stopped) return pet;
      await new Promise((r) => setTimeout(r, 250));
    }
    return getPet();
  };

  const depart = async (jump: Jump) => {
    const pet = getPet();
    if (!pet) return;
    say(`jump-${jump.id}`, departLine(role, jump.to), 2500);
    await new Promise((r) => setTimeout(r, 900));
    // The set piece: the page darkens to dirt around the hole as it opens, the whoosh falls with him
    // once the dive starts, and the notes he carries drop in after him while the hole is still open.
    const reduced = deps.reducedMotion();
    const hole = holeOf(pet);
    const tunnel = hole ? tunnelIn(hole, reduced) : null;
    const diveAt = stateMs(pet, "hole_open");
    // To the board, the trip has its own sound: it starts as he goes under and its burst lands on
    // the moment the board pops him out (its travel, hole and ears are the same constants).
    let trip: Journey | null = null;
    const tripTimer = jump.to === "board" ? window.setTimeout(() => (trip = journey()), diveAt) : 0;
    const timers = [
      window.setTimeout(() => whoosh("down"), diveAt),
      window.setTimeout(() => {
        if (hole) void dropNotes(hole, reduced);
      }, diveAt + Math.round(stateMs(pet, "dive") * 0.6)),
    ];
    await pet.jumpOut();
    for (const t of timers) window.clearTimeout(t);
    pauseEngine();
    const graph = role === "kid" ? controller.session.graph.toJSON() : await storageGet<GraphSnapshot>(GRAPH_KEY);
    const gone: Jump = { ...jump, stage: "gone", at: Date.now(), summary: summarize(graph, Date.now()), graph: graph ?? undefined };
    await storageSet(JUMP_KEY, gone);
    if (jump.to === "board") {
      window.clearTimeout(tripTimer);
      (trip ?? journey())?.emerge(BOARD_TRAVEL_MS + stateMs(pet, "hole_only") + BOARD_EARS_MS + 150);
    }
    if (tunnel) window.setTimeout(() => void tunnel.out(), TUNNEL_HOLD_MS);
  };

  const arrive = async (jump: Jump, alreadyGone: boolean) => {
    const pet = await petSoon();
    if (!pet) return;
    const goneGate = alreadyGone
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, HANDOFF_TIMEOUT_MS);
          waiting.set(jump.id, () => {
            clearTimeout(timer);
            resolve();
          });
        });
    let ready = goneGate;
    let popDelayMs = alreadyGone ? stateMs(pet, "hole_only") : 0;
    if (role === "board") {
      // Nothing shows on the board until he is all the way down on the other screen. Then he is
      // underground for a few seconds, and only then does the hole open here, his ears poke out for
      // a beat, and he pops out. A board that loaded late counts the seconds from when he went.
      await goneGate;
      const sinceGone = alreadyGone ? Math.max(0, Date.now() - jump.at) : 0;
      await new Promise((r) => setTimeout(r, Math.max(0, BOARD_TRAVEL_MS - sinceGone)));
      if (stopped) return;
      ready = new Promise((r) => setTimeout(r, stateMs(pet, "hole_only") + BOARD_EARS_MS));
      popDelayMs = 0;
    }
    // While the other side digs, dirt flies out of the hole here; it stops the moment he is on his way up.
    const reduced = deps.reducedMotion();
    const hole = holeOf(pet);
    const holeOpenMs = stateMs(pet, "hole_only");
    let stopDig: (() => void) | null = null;
    let popping = false;
    const digTimer = window.setTimeout(() => {
      if (!popping && hole) stopDig = dig(hole, reduced);
    }, holeOpenMs);
    void ready.then(() => {
      popping = true;
      window.clearTimeout(digTimer);
      stopDig?.();
      window.setTimeout(() => whoosh("up"), popDelayMs);
    });
    await pet.jumpIn(ready);
    resumeEngine();
    waiting.delete(jump.id);
    const latest = (await storageGet<Jump>(JUMP_KEY)) ?? jump;
    if (latest.id === jump.id && latest.graph && role === "parent") await storageSet(GRAPH_KEY, latest.graph);
    if (latest.id === jump.id && latest.stage !== "arrived") await storageSet(JUMP_KEY, { ...latest, stage: "arrived", at: Date.now(), graph: undefined });
    const text =
      role === "parent"
        ? latest.summary ?? summarize(latest.graph, Date.now())
        : role === "board"
          ? "Here I am. Show me your working!"
          : latest.from === "board"
            ? "I am back on the page."
            : "I am back! Your parent says hi.";
    if (role === "board") {
      say(`arrive-${jump.id}`, text, 6000);
    } else {
      // He is out: a bounce, then the notes unroll beside him and what he learned types out inside.
      pet.play("celebrate");
      unrollNotes(pet, text, { ms: NOTES_MS, reduced });
    }
  };

  const onJump = (jump: Jump | undefined) => {
    if (!jump || stopped) return;
    if (jump.stage === "gone") waiting.get(jump.id)?.();
    if (handled.has(`${jump.id}:${jump.stage}`)) return;
    if (jump.stage === "requested" && jump.to !== role && document.visibilityState === "visible") {
      handled.add(`${jump.id}:requested`);
      void depart(jump);
    } else if (jump.to === role && (jump.stage === "requested" || jump.stage === "gone") && !handled.has(`${jump.id}:arrive`)) {
      handled.add(`${jump.id}:arrive`);
      void arrive(jump, jump.stage === "gone");
    }
  };

  const onGrants = (before: Record<string, Grant> | undefined, after: Record<string, Grant> | undefined) => {
    if (role !== "kid" || stopped) return;
    const fresh = newlyGranted(before, after);
    if (!fresh.length) return;
    const pet = getPet();
    pet?.play("celebrate");
    const what = fresh.map((s) => SKILLS[s] ?? s.replace(/_/g, " "));
    say(`grant-${Date.now()}`, `Your parent said yes. I can ${what.join(" and ")} now.`, 8000);
  };

  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== "local") return;
    if (changes[JUMP_KEY]) onJump(changes[JUMP_KEY].newValue as Jump | undefined);
    if (changes[GRANTS_KEY]) onGrants(changes[GRANTS_KEY].oldValue as Record<string, Grant> | undefined, changes[GRANTS_KEY].newValue as Record<string, Grant> | undefined);
  };
  try {
    chrome.storage.onChanged.addListener(listener);
  } catch {
    /* not an extension context */
  }

  // On load: if he is away from this side, he should not be standing here.
  void storageGet<Jump>(JUMP_KEY).then((jump) => {
    if (!jump || stopped) return;
    if (jump.to !== role && (jump.stage === "gone" || jump.stage === "arrived")) {
      handled.add(`${jump.id}:requested`);
      const tryHide = () => {
        const pet = getPet();
        if (pet) {
          void pet.jumpOut();
          pauseEngine();
        } else if (!stopped) setTimeout(tryHide, 300);
      };
      tryHide();
    } else if (jump.to === role && (jump.stage === "gone" || (jump.stage === "requested" && Date.now() - jump.at < HANDOFF_TIMEOUT_MS))) {
      // He is on his way here (the board opens after the request is written): wait in the hole.
      onJump(jump);
    }
  });

  // The vignette: after a long quiet spell he checks his watch, panics, and dives to a new spot.
  let vignetteTimer = 0;
  const gap = () => VIGNETTE_GAP_MS[0] + Math.random() * (VIGNETTE_GAP_MS[1] - VIGNETTE_GAP_MS[0]);
  const scheduleVignette = () => {
    vignetteTimer = window.setTimeout(async () => {
      const pet = getPet();
      if (!stopped && pet && deps.isQuiet() && !deps.reducedMotion() && document.visibilityState === "visible") {
        const body = pet.getBodyRect();
        if (body) {
          pet.play("panic");
          say(`late-${Date.now()}`, "Oh dear, look at the time!", 2200);
          await new Promise((r) => setTimeout(r, 1400));
          const x = 160 + Math.random() * Math.max(200, window.innerWidth - 320);
          await pet.moveTo(x, body.top + body.height / 2);
        }
      }
      if (!stopped) scheduleVignette();
    }, gap());
  };
  scheduleVignette();

  return () => {
    stopped = true;
    resumeEngine();
    window.clearTimeout(vignetteTimer);
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      /* ignore */
    }
  };
}
