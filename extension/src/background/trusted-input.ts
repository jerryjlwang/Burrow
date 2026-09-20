import type { InputOp } from "../shared/messages";
import type { KeyChord } from "@shared/keys";
import { log } from "../shared/logger";

const logger = log("bg");

/**
 * Real mouse and keyboard input for a tab, through chrome.debugger (DevTools protocol).
 * Events a content script dispatches are untrusted: they never trigger :hover, native
 * drag-and-drop, or the many widgets that check isTrusted. These are indistinguishable from
 * the student's own hands.
 */

const attached = new Set<number>();
const detachTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** Chrome shows a "started debugging" bar while attached, so let go soon after the rabbit stops acting. */
const IDLE_DETACH_MS = 25_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

chrome.debugger?.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

async function ensureAttached(tabId: number): Promise<void> {
  const pending = detachTimers.get(tabId);
  if (pending) clearTimeout(pending);
  detachTimers.set(
    tabId,
    setTimeout(() => {
      detachTimers.delete(tabId);
      if (attached.delete(tabId)) void chrome.debugger.detach({ tabId }).catch(() => {});
    }, IDLE_DETACH_MS),
  );
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // A restarted service worker forgets sessions the browser still holds.
    if (!/already attached/i.test(String(e))) throw e;
  }
  attached.add(tabId);
}

const modifiers = (c: KeyChord): number => (c.alt ? 1 : 0) | (c.ctrl ? 2 : 0) | (c.meta ? 4 : 0) | (c.shift ? 8 : 0);

async function drag(send: (method: string, params: Record<string, unknown>) => Promise<unknown>, tabId: number, op: Extract<InputOp, { kind: "drag" }>): Promise<void> {
  // A native HTML5 drag would hand the mouse to the OS drag loop and never return it; intercepting
  // it lets us finish the gesture with drag events. Pointer-driven widgets (sliders, canvases,
  // sortable lists) never start a native drag and just see the mouse moves.
  let dragData: unknown = null;
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId === tabId && method === "Input.dragIntercepted") dragData = (params as { data: unknown }).data;
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: op.x, y: op.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: op.x, y: op.y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.setInterceptDrags", { enabled: true });
    const steps = Math.min(30, Math.max(8, Math.round(Math.hypot(op.toX - op.x, op.toY - op.y) / 25)));
    let entered = false;
    for (let i = 1; i <= steps; i++) {
      const x = op.x + ((op.toX - op.x) * i) / steps;
      const y = op.y + ((op.toY - op.y) * i) / steps;
      if (dragData) {
        await send("Input.dispatchDragEvent", { type: entered ? "dragOver" : "dragEnter", x, y, data: dragData });
        entered = true;
      } else {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      }
      await sleep(16);
    }
    if (dragData) {
      if (!entered) await send("Input.dispatchDragEvent", { type: "dragEnter", x: op.toX, y: op.toY, data: dragData });
      await send("Input.dispatchDragEvent", { type: "dragOver", x: op.toX, y: op.toY, data: dragData });
      await send("Input.dispatchDragEvent", { type: "drop", x: op.toX, y: op.toY, data: dragData });
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: op.toX, y: op.toY, button: "left", buttons: 0, clickCount: 1 });
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}

export async function runInput(tabId: number, ops: InputOp[]): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureAttached(tabId);
    const send = (method: string, params: Record<string, unknown>) => chrome.debugger.sendCommand({ tabId }, method, params);
    for (const op of ops) {
      switch (op.kind) {
        case "move":
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: op.x, y: op.y });
          break;
        case "click": {
          const buttons = op.button === "right" ? 2 : 1;
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: op.x, y: op.y });
          for (let n = 1; n <= op.count; n++) {
            await send("Input.dispatchMouseEvent", { type: "mousePressed", x: op.x, y: op.y, button: op.button, buttons, clickCount: n });
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: op.x, y: op.y, button: op.button, buttons: 0, clickCount: n });
          }
          break;
        }
        case "drag":
          await drag(send, tabId, op);
          break;
        case "wheel":
          await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: op.x, y: op.y, deltaX: 0, deltaY: op.deltaY });
          break;
        case "key": {
          const c = op.chord;
          const base = { key: c.key, code: c.code, windowsVirtualKeyCode: c.keyCode, nativeVirtualKeyCode: c.keyCode, modifiers: modifiers(c) };
          await send("Input.dispatchKeyEvent", { type: c.text ? "keyDown" : "rawKeyDown", ...base, ...(c.text ? { text: c.text, unmodifiedText: c.text } : {}) });
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
          break;
        }
        case "text":
          await send("Input.insertText", { text: op.text });
          break;
      }
    }
    return { ok: true };
  } catch (e) {
    logger.warn("trusted input failed", { error: String(e) });
    attached.delete(tabId);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Resamples a capture to the viewport's CSS size, so a pixel the model sees is the point to click. */
export async function fitToViewport(dataUrl: string, viewport: { width: number; height: number }): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  if (bitmap.width === viewport.width && bitmap.height === viewport.height) return dataUrl;
  const canvas = new OffscreenCanvas(viewport.width, viewport.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, viewport.width, viewport.height);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(binary)}`;
}
