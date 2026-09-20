/**
 * The tablet watcher. Alt+Shift+D (or the popup) opens Excalidraw in a Chrome window on the touch
 * display and starts watching it: the background captures that window's active tab about twice a
 * second, counts changed pixels, and when enough new ink lands (or the pen pauses) sends the frame
 * plus a picture of the kid's main screen to the server's judge. Verdicts go to the main screen's
 * tab, where the rabbit reacts. Nothing here reads the drawing app itself, so any page in that
 * window works, and no screen-share picker is needed.
 */
import type { InkJudgeInput, InkJudgeOutput, InkJudgement } from "@shared/ink";
import type { ContentBroadcast, TabletState } from "../shared/messages";
import { changedPixels, DEFAULT_RULES, InkTrigger, toGray, type TriggerReason } from "./ink-trigger";
import { log } from "../shared/logger";

const logger = log("tablet");
const BOARD_URL = "https://excalidraw.com/";
/** Chrome allows two captures a second; leave slack for the occasional context capture. */
const SAMPLE_MS = 600;
const CONTEXT_REFRESH_MS = 20_000;
const SMALL_W = 240;
const STATE_KEY = "burrow.tablet";

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
    context: null,
    busy: false,
  };
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
    const changed = w.prev ? changedPixels(w.prev, gray.data) : 0;
    w.prev = gray.data;
    const now = Date.now();
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

async function judge(w: Watch, frame: string, reason: TriggerReason, now: number): Promise<void> {
  if (!deps || !w.trigger) return;
  w.trigger.checkStarted(now);
  try {
    const context = await refreshContext(w);
    const input: InkJudgeInput = {
      frame,
      context: context?.dataUrl ?? null,
      contextTitle: context?.title ?? "",
      contextUrl: context?.url ?? "",
      previousLines: w.previousLines,
      seq: w.seq++,
    };
    const out = await deps.postJudge(input);
    if (watch !== w) return;
    w.checks++;
    w.lastCheckAt = Date.now();
    w.lastVerdict = out.judgement;
    if (out.judgement.lines.length) w.previousLines = out.judgement.lines;
    logger.info("verdict", { reason, status: out.judgement.status, line: out.judgement.line, confidence: out.judgement.confidence, provider: out.provider, ms: out.latencyMs });
    // He stands on the board while watching, so the verdict goes there; the kid's page is the fallback.
    await deps.sendToTab(w.boardTabId ?? w.contextTabId, { type: "ink.judgement", judgement: out.judgement, reason });
  } catch (e) {
    w.error = `judge: ${String(e).slice(0, 100)}`;
    logger.warn("judge failed", { error: String(e) });
  } finally {
    w.trigger?.checkFinished();
  }
}
