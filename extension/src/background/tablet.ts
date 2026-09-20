/**
 * The tablet watcher. Alt+Shift+D (or the popup) opens Excalidraw in a Chrome window on the touch
 * display and starts watching it: the background captures that window's active tab about twice a
 * second, counts changed pixels, and when enough new ink lands (or the pen pauses) sends the frame
 * plus a picture of the kid's main screen to the server's judge. Verdicts go to the main screen's
 * tab, where the rabbit reacts. Nothing here reads the drawing app itself, so any page in that
 * window works, and no screen-share picker is needed.
 */
import { MAX_RUNG, parseInkBox, type InkBox, type InkJudgeInput, type InkJudgeOutput, type InkJudgement } from "@shared/ink";
import type { ContentBroadcast, TabletState } from "../shared/messages";
import { DEFAULT_RULES, InkTrigger, maskedChangedPixels, toGray, type TriggerReason } from "./ink-trigger";
import { log } from "../shared/logger";

const logger = log("tablet");
const BOARD_URL = "https://excalidraw.com/";
/** Chrome allows two captures a second; leave slack for the occasional context capture. */
const SAMPLE_MS = 600;
const CONTEXT_REFRESH_MS = 20_000;
const SMALL_W = 240;
const STATE_KEY = "burrow.tablet";
/** How long the pen may rest before the judge is asked whether the kid is stuck: sooner after a wrong line, never once solved. */
const STALL_MS = 45_000;
const STALL_AFTER_OFF_MS = 20_000;
/** A repeat verdict on the same wrong line inside this window is the same nudge, not the next rung (mirrors the page's cooldown). */
const NUDGE_REPEAT_MS = 20_000;
/** Verdicts below this confidence are not spoken on the page, so they do not climb the rung either. */
const RUNG_CONFIDENCE = 0.6;

interface Deps {
  postJudge: (input: InkJudgeInput) => Promise<InkJudgeOutput>;
  sendToTab: (tabId: number | null, msg: ContentBroadcast) => Promise<void>;
}

interface Watch {
  windowId: number;
  /** The board tab: where the rabbit stands while watching, so verdicts and nudges land beside the ink. */
  boardTabId: number | null;
  contextTabId: number | null;
  contextWindowId: number | null;
  timer: ReturnType<typeof setInterval> | null;
  trigger: InkTrigger | null;
  prev: Uint8Array | null;
  small: { w: number; h: number } | null;
  previousLines: string[];
  seq: number;
  frames: number;
  checks: number;
  lastVerdict: InkJudgement | null;
  lastCheckAt: number | null;
  /** Nudges given per wrong line (keyed by the line as read), so the next nudge on it climbs a rung. */
  nudged: Map<string, { count: number; at: number }>;
  lastWrongLine: string | null;
  lastReason: TriggerReason | null;
  lastRung: number;
  /** The board page's own UI right now, and as it was when `prev` was sampled; both are left out of the diff. */
  mask: InkBox[];
  prevMask: InkBox[];
  /** Until when frame changes are ignored (the rabbit is hopping, drawing or writing). */
  quietUntil: number;
  error?: string;
  context: { dataUrl: string | null; title: string; url: string; at: number } | null;
  busy: boolean;
}

let watch: Watch | null = null;
let deps: Deps | null = null;
/** Chrome allows two tab captures a second across the whole extension; the tick and the context capture share that budget. */
let lastCaptureAt = 0;
let contextCapturing = false;
const CAPTURE_GAP_MS = 520;

export function initTablet(d: Deps): void {
  deps = d;
  // Test hook: lets an automated run drive the watcher from the service worker context.
  (globalThis as unknown as { __burrowTablet?: unknown }).__burrowTablet = { open: openTablet, stop: stopTablet, status: tabletStatus };
  chrome.windows.onRemoved.addListener((windowId) => {
    if (watch && watch.windowId === windowId) void stopTablet(false);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (watch && tabId === watch.contextTabId && info.url) watch.context = null;
  });
  void resume();
}

export function tabletStatus(): TabletState {
  return {
    watching: !!watch?.timer,
    windowId: watch?.windowId ?? null,
    contextTabId: watch?.contextTabId ?? null,
    frames: watch?.frames ?? 0,
    checks: watch?.checks ?? 0,
    lastCheckAt: watch?.lastCheckAt ?? null,
    lastVerdict: watch?.lastVerdict ?? null,
    lastReason: watch?.lastReason ?? null,
    lastRung: watch?.lastRung ?? 1,
    error: watch?.error,
  };
}

/**
 * The display to put the board on: a touch screen that is not the primary, else any secondary, else
 * null. The query is raced against a short timeout because some builds (headless Chromium) never
 * answer it, and the shortcut must never hang on that.
 */
async function pickDisplay(): Promise<chrome.system.display.DisplayUnitInfo | null> {
  try {
    const displays = await new Promise<chrome.system.display.DisplayUnitInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("display query timed out")), 1500);
      try {
        chrome.system.display.getInfo((info) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(info ?? []);
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    const secondary = displays.filter((d) => !d.isPrimary);
    return secondary.find((d) => d.hasTouchSupport) ?? secondary[0] ?? null;
  } catch (e) {
    logger.warn("display query failed", { error: String(e) });
    return null;
  }
}

const JUMP_KEY = "burrow.jump";

/** The rabbit's jump record (docs/frontend/HANDOFF.md): pages watch it and dive or pop out. */
async function writeJump(to: "board" | "kid", from: "board" | "kid", stage: "requested" | "gone"): Promise<void> {
  try {
    await chrome.storage.local.set({ [JUMP_KEY]: { id: `j-${Date.now().toString(36)}`, to, from, stage, at: Date.now() } });
  } catch (e) {
    logger.warn("jump record failed", { error: String(e) });
  }
}

function freshWatch(windowId: number, boardTabId: number | null, contextTabId: number | null, contextWindowId: number | null): Watch {
  return {
    windowId,
    boardTabId,
    contextTabId,
    contextWindowId,
    timer: null,
    trigger: null,
    prev: null,
    small: null,
    previousLines: [],
    seq: 0,
    frames: 0,
    checks: 0,
    lastVerdict: null,
    lastCheckAt: null,
    nudged: new Map(),
    lastWrongLine: null,
    lastReason: null,
    lastRung: 1,
    mask: [],
    prevMask: [],
    quietUntil: 0,
    context: null,
    busy: false,
  };
}

const MAX_MASK_RECTS = 12;
const MAX_QUIET_MS = 12_000;

/**
 * The board page reports where its own UI is, and may ask for a quiet spell while the rabbit
 * hops, draws or writes (changes then go untracked, though the frame keeps being followed so the
 * first diff afterwards is against the latest picture). Only the board tab may, and only while it is watched.
 */
export function setTabletMask(tabId: number | null, rects: unknown, quietMs?: number): boolean {
  if (!watch || tabId == null || tabId !== watch.boardTabId) return false;
  const list = Array.isArray(rects) ? rects.slice(0, MAX_MASK_RECTS).map(parseInkBox).filter((b): b is InkBox => !!b) : [];
  watch.mask = list;
  if (typeof quietMs === "number" && Number.isFinite(quietMs) && quietMs > 0) watch.quietUntil = Math.max(watch.quietUntil, Date.now() + Math.min(MAX_QUIET_MS, quietMs));
  return true;
}

export async function openTablet(contextTab?: chrome.tabs.Tab | null, opts: { skipDisplay?: boolean } = {}): Promise<TabletState> {
  if (!deps) throw new Error("tablet watcher not initialised");
  // Context: the tab the shortcut was pressed in, else the active tab of the last focused window.
  let ctx = contextTab ?? null;
  // A popup opened as a tab, or any of our own pages, is never the task; fall back to the focused window.
  if (ctx?.url?.startsWith("chrome-extension://")) ctx = null;
  if (!ctx) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    ctx = t ?? null;
  }
  if (ctx && watch && ctx.windowId === watch.windowId) ctx = null; // pressed on the board itself
  if (watch) {
    // A board is already open: bring it forward, retarget the context if the kid moved, keep watching.
    try {
      await chrome.windows.update(watch.windowId, { focused: true });
    } catch {
      /* the window is gone; onRemoved already cleared the watch */
    }
    if (watch && ctx?.id != null) {
      watch.contextTabId = ctx.id;
      watch.contextWindowId = ctx.windowId;
      watch.context = null;
    }
    if (watch) {
      startLoop();
      await persist();
      return tabletStatus();
    }
  }
  const display = opts.skipDisplay ? null : await pickDisplay();
  const area = display?.workArea;
  const win = await chrome.windows.create({
    url: BOARD_URL,
    type: "normal",
    focused: true,
    ...(area ? { left: area.left, top: area.top, width: area.width, height: area.height } : {}),
  });
  if (!win?.id) throw new Error("could not open the board window");
  try {
    await chrome.windows.update(win.id, { state: "fullscreen" });
  } catch {
    try {
      await chrome.windows.update(win.id, { state: "maximized" });
    } catch {
      /* leave it as created */
    }
  }
  watch = freshWatch(win.id, win.tabs?.[0]?.id ?? null, ctx?.id ?? null, ctx?.windowId ?? null);
  logger.info("board opened", { window: win.id, display: display?.name ?? "same screen", touch: display?.hasTouchSupport ?? false, contextTab: ctx?.id ?? null });
  startLoop();
  await persist();
  // The rabbit leaves the kid's page and pops out on the board once the page says he is gone.
  await writeJump("board", "kid", "requested");
  return tabletStatus();
}

export async function stopTablet(closeWindow: boolean): Promise<TabletState> {
  const w = watch;
  watch = null;
  if (w?.timer) clearInterval(w.timer);
  let boardAlive = false;
  if (w && !closeWindow) {
    try {
      await chrome.windows.get(w.windowId);
      boardAlive = true;
    } catch {
      boardAlive = false;
    }
  }
  if (w && closeWindow) {
    try {
      await chrome.windows.remove(w.windowId);
    } catch {
      /* already closed */
    }
  }
  // Back to the kid's page: a living board dives first; a closed one cannot, so he is simply gone.
  if (w) await writeJump("kid", "board", boardAlive ? "requested" : "gone");
  try {
    await chrome.storage.session.remove(STATE_KEY);
  } catch {
    /* session storage unavailable */
  }
  if (w) logger.info("watching stopped", { frames: w.frames, checks: w.checks });
  return tabletStatus();
}

function startLoop(): void {
  if (!watch || watch.timer) return;
  watch.timer = setInterval(() => void tick(), SAMPLE_MS);
}

async function persist(): Promise<void> {
  if (!watch) return;
  try {
    await chrome.storage.session.set({ [STATE_KEY]: { windowId: watch.windowId, contextTabId: watch.contextTabId, contextWindowId: watch.contextWindowId } });
  } catch {
    /* session storage unavailable */
  }
}

/** The service worker restarted mid-session: pick the watch back up if the board is still open. */
async function resume(): Promise<void> {
  try {
    const raw = await chrome.storage.session.get(STATE_KEY);
    const saved = raw?.[STATE_KEY] as { windowId: number; contextTabId: number | null; contextWindowId: number | null } | undefined;
    if (!saved || watch) return;
    await chrome.windows.get(saved.windowId);
    const [boardTab] = await chrome.tabs.query({ windowId: saved.windowId, active: true });
    watch = freshWatch(saved.windowId, boardTab?.id ?? null, saved.contextTabId, saved.contextWindowId);
    startLoop();
    logger.info("watch resumed", { window: saved.windowId });
  } catch {
    try {
      await chrome.storage.session.remove(STATE_KEY);
    } catch {
      /* nothing to clean */
    }
  }
}

async function tick(): Promise<void> {
  if (!watch || !deps || watch.busy || contextCapturing || Date.now() - lastCaptureAt < CAPTURE_GAP_MS) return;
  const w = watch;
  w.busy = true;
  try {
    let dataUrl: string;
    try {
      lastCaptureAt = Date.now();
      dataUrl = await chrome.tabs.captureVisibleTab(w.windowId, { format: "jpeg", quality: 70 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no window with id|window not found/i.test(msg)) {
        await stopTablet(false);
        return;
      }
      // Quota bumps (a context capture landed in the same second) and tab drags are transient.
      if (!/MAX_CAPTURE_VISIBLE_TAB|cannot be edited/i.test(msg)) w.error = msg.slice(0, 120);
      return;
    }
    w.error = undefined;
    w.frames++;
    const gray = await downsample(dataUrl);
    if (!gray) return;
    if (!w.trigger || !w.small || w.small.w !== gray.w || w.small.h !== gray.h) {
      w.trigger = new InkTrigger(gray.w * gray.h, DEFAULT_RULES);
      w.small = { w: gray.w, h: gray.h };
      w.prev = gray.data;
      return;
    }
    // The rabbit, his bubble, his board and his rings are on this tab too; wherever they are now or were a frame ago is not the kid's ink.
    const changed = w.prev ? maskedChangedPixels(w.prev, gray.data, gray.w, gray.h, w.prevMask.concat(w.mask)) : 0;
    w.prev = gray.data;
    w.prevMask = w.mask;
    const now = Date.now();
    if (now < w.quietUntil) return;
    const reason = w.trigger.push(changed, now);
    if (reason) void judge(w, dataUrl, reason, now);
  } finally {
    w.busy = false;
  }
}

async function downsample(dataUrl: string): Promise<{ w: number; h: number; data: Uint8Array } | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const w = SMALL_W;
    const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return { w, h, data: toGray(ctx.getImageData(0, 0, w, h).data) };
  } catch (e) {
    logger.warn("downsample failed", { error: String(e) });
    return null;
  }
}

/** The kid's main screen: the active tab of the context window, re-captured every so often. */
async function refreshContext(w: Watch): Promise<Watch["context"]> {
  const now = Date.now();
  if (w.context && now - w.context.at < CONTEXT_REFRESH_MS) return w.context;
  let title = "";
  let url = "";
  let dataUrl: string | null = null;
  if (w.contextTabId != null) {
    try {
      const tab = await chrome.tabs.get(w.contextTabId);
      title = tab.title ?? "";
      url = tab.url ?? "";
      w.contextWindowId = tab.windowId;
    } catch {
      w.contextTabId = null;
    }
  }
  if (w.contextWindowId != null && w.contextWindowId !== w.windowId) {
    try {
      const [active] = await chrome.tabs.query({ active: true, windowId: w.contextWindowId });
      if (active?.id != null && /^https?:|^file:/.test(active.url ?? "")) {
        w.contextTabId = active.id;
        title = active.title ?? title;
        url = active.url ?? url;
        contextCapturing = true;
        const gap = CAPTURE_GAP_MS - (Date.now() - lastCaptureAt);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        lastCaptureAt = Date.now();
        dataUrl = await chrome.tabs.captureVisibleTab(w.contextWindowId, { format: "jpeg", quality: 60 });
      }
    } catch (e) {
      logger.warn("context capture failed", { error: String(e) });
    } finally {
      contextCapturing = false;
    }
  }
  w.context = { dataUrl, title, url, at: now };
  return w.context;
}

/** Nudge number for the line last judged wrong: one more than the nudges it has had, capped. A fresh mistake starts at one. */
function rungFor(w: Watch): number {
  if (!w.lastWrongLine) return 1;
  return Math.min(MAX_RUNG, 1 + (w.nudged.get(w.lastWrongLine)?.count ?? 0));
}

/** Bookkeeping after a verdict: which line is wrong and how often it has been nudged, and how long the pen may now rest. */
function noteVerdict(w: Watch, j: InkJudgement): void {
  const now = Date.now();
  if (j.status === "off" && j.confidence >= RUNG_CONFIDENCE) {
    const key = (j.line != null && j.lines[j.line - 1]) || `#${j.line ?? 0}`;
    const had = w.nudged.get(key);
    if (!had || now - had.at >= NUDGE_REPEAT_MS) w.nudged.set(key, { count: (had?.count ?? 0) + 1, at: now });
    w.lastWrongLine = key;
  } else if (j.status === "ok") {
    w.lastWrongLine = null;
  }
  if (w.trigger) w.trigger.stallMs = j.solved ? Infinity : j.status === "off" ? STALL_AFTER_OFF_MS : STALL_MS;
}

async function judge(w: Watch, frame: string, reason: TriggerReason, now: number): Promise<void> {
  if (!deps || !w.trigger) return;
  w.trigger.checkStarted(now);
  try {
    const context = await refreshContext(w);
    const rung = rungFor(w);
    const input: InkJudgeInput = {
      frame,
      context: context?.dataUrl ?? null,
      contextTitle: context?.title ?? "",
      contextUrl: context?.url ?? "",
      previousLines: w.previousLines,
      seq: w.seq++,
      reason,
      rung,
      lastWrongLine: w.lastWrongLine,
    };
    const out = await deps.postJudge(input);
    if (watch !== w) return;
    const j = out.judgement;
    w.checks++;
    w.lastCheckAt = Date.now();
    w.lastVerdict = j;
    w.lastReason = reason;
    w.lastRung = rung;
    if (j.lines.length) w.previousLines = j.lines;
    noteVerdict(w, j);
    logger.info("verdict", { reason, rung, status: j.status, line: j.line, mark: !!j.mark, note: j.note.length, confidence: j.confidence, provider: out.provider, ms: out.latencyMs });
    // He stands on the board while watching, so the verdict goes there; the kid's page is the fallback.
    await deps.sendToTab(w.boardTabId ?? w.contextTabId, { type: "ink.judgement", judgement: j, reason, rung, task: { title: context?.title ?? "", url: context?.url ?? "" } });
  } catch (e) {
    w.error = `judge: ${String(e).slice(0, 100)}`;
    logger.warn("judge failed", { error: String(e) });
  } finally {
    w.trigger?.checkFinished();
  }
}
