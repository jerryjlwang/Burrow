import type { BgRequest, BgResponseMap, ContentBroadcast, OffscreenCommand, OffscreenEvent, ServerHealth, TabSession, VoiceState } from "../shared/messages";
import { getSettings, setSettings, DEFAULT_SETTINGS } from "../shared/settings";
import { emptyStudentState } from "@shared/types";
import type { GraphSnapshot } from "@shared/graph";
import { GraphHost } from "./graph-host";
import { initTablet, openTablet, stopTablet, tabletStatus } from "./tablet";
import type { InkJudgeInput, InkJudgeOutput } from "@shared/ink";
import { log } from "../shared/logger";

const logger = log("bg");

// ---------------- Voice / TTS state ----------------
let voiceState: VoiceState = { mode: "off", ttsPlaying: false, serverOk: null };
let ttsOwnerTab: number | null = null;
let lastHealth: { at: number; value: ServerHealth } | null = null;

// ---------------- Offscreen document ----------------
const OFFSCREEN_URL = "offscreen.html";
let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: "Microphone capture for voice mode and speech playback for the learning companion.",
      })
      .catch((e: unknown) => {
        if (!String(e).toLowerCase().includes("only a single offscreen")) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function sendToOffscreen<T = unknown>(cmd: OffscreenCommand, retries = 2): Promise<T> {
  await ensureOffscreen();
  try {
    const res = await chrome.runtime.sendMessage(cmd);
    if (res === undefined && retries > 0) {
      await new Promise((r) => setTimeout(r, 250));
      return sendToOffscreen(cmd, retries - 1);
    }
    return res as T;
  } catch (e) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 300));
      return sendToOffscreen(cmd, retries - 1);
    }
    throw e;
  }
}

// ---------------- Server client ----------------
async function serverFetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const { serverUrl } = await getSettings();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${serverUrl.replace(/\/$/, "")}${path}`, { ...init, signal: ctrl.signal, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(t);
  }
}

async function health(force = false): Promise<ServerHealth> {
  if (!force && lastHealth && Date.now() - lastHealth.at < 8000) return lastHealth.value;
  let value: ServerHealth;
  try {
    const r = await serverFetch("/health", {}, 4000);
    value = r.ok ? ((await r.json()) as ServerHealth) : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    value = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  lastHealth = { at: Date.now(), value };
  voiceState = { ...voiceState, serverOk: value.ok };
  return value;
}

async function postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const r = await serverFetch(path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`server ${r.status}: ${text.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

// ---------------- Learner knowledge graph (canonical, persisted) ----------------
const GRAPH_KEY = "pip.graph";
const graphHost = new GraphHost({
  async load() {
    const raw = await chrome.storage.local.get(GRAPH_KEY);
    return (raw?.[GRAPH_KEY] as GraphSnapshot | undefined) ?? null;
  },
  async save(snapshot) {
    await chrome.storage.local.set({ [GRAPH_KEY]: snapshot });
  },
});

// ---------------- Tab sessions ----------------
function emptySession(): TabSession {
  return { conversation: [], student: emptyStudentState(), panelOpen: false, minimized: false, pendingLoop: null, proactiveCooldownUntil: 0, urlTrail: [], updatedAt: Date.now() };
}

async function getSession(tabId: number): Promise<TabSession> {
  const key = `tab:${tabId}`;
  const raw = await chrome.storage.session.get(key);
  return { ...emptySession(), ...((raw?.[key] as Partial<TabSession>) ?? {}) };
}

async function setSession(tabId: number, patch: Partial<TabSession>): Promise<void> {
  const key = `tab:${tabId}`;
  const current = await getSession(tabId);
  await chrome.storage.session.set({ [key]: { ...current, ...patch, updatedAt: Date.now() } });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`tab:${tabId}`);
});

// ---------------- Broadcasting to content scripts ----------------
async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

async function sendToTab(tabId: number | null, msg: ContentBroadcast): Promise<void> {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    /* tab has no content script (chrome://, closed, etc.) */
  }
}

async function broadcast(msg: ContentBroadcast): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*", "file://*/*"] });
  await Promise.all(tabs.map((t) => sendToTab(t.id ?? null, msg)));
}

function setVoiceState(patch: Partial<VoiceState>): void {
  voiceState = { ...voiceState, ...patch };
  void broadcast({ type: "voice.state", state: voiceState });
}

// ---------------- Offscreen events ----------------
async function handleOffscreenEvent(event: OffscreenEvent): Promise<void> {
  switch (event.type) {
    case "mic.state":
      if (event.state === "listening") setVoiceState({ mode: "listening", error: undefined, errorCode: undefined });
      else if (event.state === "stopped") setVoiceState({ mode: "off" });
      else if (event.state === "error") setVoiceState({ mode: "error", error: event.error, errorCode: event.code });
      else setVoiceState({ mode: "starting" });
      break;
    case "mic.level":
      await sendToTab(await activeTabId(), { type: "voice.level", level: event.level });
      break;
    case "transcript":
      logger.debug("transcript", { final: event.final, event: event.event, text: event.text });
      await sendToTab(await activeTabId(), { type: "voice.transcript", text: event.text, final: event.final, event: event.event, turnIndex: event.turnIndex });
      break;
    case "tts.state": {
      voiceState = { ...voiceState, ttsPlaying: event.state === "started" };
      const target = ttsOwnerTab ?? (await activeTabId());
      await sendToTab(target, { type: "tts.state", id: event.id, state: event.state, error: event.error });
      if (event.state !== "started" && ttsOwnerTab != null && (await activeTabId()) !== ttsOwnerTab) {
        await sendToTab(await activeTabId(), { type: "tts.state", id: event.id, state: event.state, error: event.error });
      }
      break;
    }
    case "tts.level":
      await sendToTab(ttsOwnerTab ?? (await activeTabId()), { type: "tts.level", level: event.level });
      break;
  }
}

// ---------------- Request handling ----------------
async function handle(msg: BgRequest, sender: chrome.runtime.MessageSender): Promise<BgResponseMap[BgRequest["type"]]> {
  const tabId = sender.tab?.id ?? null;
  const settings = await getSettings();
  switch (msg.type) {
    case "ping":
      return { ok: true, at: Date.now() };
    case "server.health":
      return (await health(true));
    case "agent.decide": {
      // Enrich with live tab context so switch_tab has real targets; content scripts can't see tabs.
      const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
      const openTabs = tabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({ id: t.id!, title: (t.title ?? "").slice(0, 80), url: (t.url ?? "").slice(0, 200), active: t.id === tabId }))
        .slice(0, 12);
      return (await postJson("/api/agent/decide", { ...msg.input, openTabs }, 40_000));
    }
    case "agent.intervene":
      return (await postJson("/api/agent/intervene", msg.input, 15_000));
    case "extract":
      return (await postJson("/api/extract", msg.input, 20_000));
    case "graph.get":
      return (await graphHost.snapshot());
    case "graph.event":
      await graphHost.apply(msg.event);
      return { ok: true };
    case "graph.clear":
      await graphHost.clear();
      return { ok: true };
    case "tts.speak": {
      if (!settings.ttsEnabled) return { ok: false, error: "tts disabled" };
      ttsOwnerTab = tabId;
      try {
        const r = await sendToOffscreen<{ ok: boolean; error?: string }>({ target: "offscreen", type: "tts.speak", id: msg.id, text: msg.text, serverUrl: settings.serverUrl });
        return (r ?? { ok: false, error: "no response from audio" });
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    case "tts.stop": {
      try {
        await sendToOffscreen({ target: "offscreen", type: "tts.stop" }, 0);
      } catch {
        /* nothing playing */
      }
      voiceState = { ...voiceState, ttsPlaying: false };
      return { ok: true };
    }
    case "voice.start": {
      setVoiceState({ mode: "starting", error: undefined, errorCode: undefined });
      try {
        const r = await sendToOffscreen<{ ok: boolean; error?: string; code?: VoiceState["errorCode"] }>({ target: "offscreen", type: "mic.start", serverUrl: settings.serverUrl });
        if (r?.ok) {
          setVoiceState({ mode: "listening" });
          if (!settings.micGranted) await setSettings({ micGranted: true });
        } else {
          setVoiceState({ mode: "error", error: r?.error ?? "Voice is having trouble connecting. You can still type to me.", errorCode: r?.code ?? "unknown" });
        }
        return { ok: !!r?.ok, state: voiceState };
      } catch (e) {
        setVoiceState({ mode: "error", error: "Voice is having trouble connecting. You can still type to me.", errorCode: "server" });
        logger.error("voice.start failed", { error: String(e) });
        return { ok: false, state: voiceState };
      }
    }
    case "voice.stop": {
      try {
        await sendToOffscreen({ target: "offscreen", type: "mic.stop" }, 0);
      } catch {
        /* offscreen gone */
      }
      setVoiceState({ mode: "off", error: undefined, errorCode: undefined });
      return { ok: true, state: voiceState };
    }
    case "voice.status":
      return voiceState;
    case "tab.session.get":
      return (tabId == null ? emptySession() : await getSession(tabId));
    case "tab.session.set":
      if (tabId != null) await setSession(tabId, msg.patch);
      return { ok: true };
    case "tab.session.clear":
      if (tabId != null) await chrome.storage.session.remove(`tab:${tabId}`);
      return { ok: true };
    case "nav.navigate":
      if (tabId == null) throw new Error("no tab");
      if (!/^https?:\/\//i.test(msg.url)) throw new Error("only http(s) urls");
      await chrome.tabs.update(tabId, { url: msg.url });
      return { ok: true };
    case "nav.open":
      if (!/^https?:\/\//i.test(msg.url)) throw new Error("only http(s) urls");
      await chrome.tabs.create({ url: msg.url, active: true });
      return { ok: true };
    case "nav.switch": {
      const target = await chrome.tabs.get(msg.tabId).catch(() => null);
      if (!target?.id) return { ok: false };
      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId !== undefined) await chrome.windows.update(target.windowId, { focused: true }).catch(() => undefined);
      return { ok: true };
    }
    case "lookup":
      return (await postJson("/api/lookup", { query: msg.query }, 15_000));
    case "nav.back":
      if (tabId == null) throw new Error("no tab");
      await chrome.tabs.goBack(tabId);
      return { ok: true };
    case "screenshot": {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: "jpeg", quality: 55 });
        return { ok: true, dataUrl };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    case "tablet.open":
      return openTablet(sender.tab ?? null);
    case "tablet.stop":
      return stopTablet(msg.close === true);
    case "tablet.status":
      return tabletStatus();
    case "open.onboarding":
      await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
      return { ok: true };
    case "open.demo":
      await chrome.tabs.create({ url: `${settings.serverUrl.replace(/\/$/, "")}/demo/` });
      return { ok: true };
    case "offscreen.event":
      await handleOffscreenEvent(msg.event);
      return { ok: true };
    default:
      throw new Error(`unknown message ${(msg as { type: string }).type}`);
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || !("type" in msg)) return;
  if ("target" in msg) return; // commands addressed to the offscreen document
  handle(msg as BgRequest, sender)
    .then((res) => sendResponse(res))
    .catch((e: unknown) => {
      logger.warn("request failed", { type: (msg as { type: string }).type, error: String(e) });
      sendResponse({ __error: e instanceof Error ? e.message : String(e) });
    });
  return true;
});

// ---------------- Commands, context menu, install ----------------
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "open-tablet") {
    try {
      await openTablet(tab ?? null);
    } catch (e) {
      logger.warn("open-tablet failed", { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (command !== "toggle-companion" && command !== "toggle-voice") return;
  await sendToTab(await activeTabId(), { type: "command", name: command });
});

initTablet({ postJudge: (input: InkJudgeInput) => postJson<InkJudgeOutput>("/api/ink/judge", input, 20_000), sendToTab });

const MENU: Array<{ id: string; title: string; prompt: string }> = [
  { id: "pip-explain", title: "Explain this with Pip", prompt: "Explain this to me simply" },
  { id: "pip-summarize", title: "Summarize this with Pip", prompt: "Summarize this" },
  { id: "pip-read", title: "Read this aloud", prompt: "Read this" },
  { id: "pip-hint", title: "Give me a hint about this", prompt: "Give me a hint about this, without giving the answer" },
];

function installMenus(): void {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: "pip-root", title: "Pip", contexts: ["selection"] });
      for (const m of MENU) chrome.contextMenus.create({ id: m.id, parentId: "pip-root", title: m.title, contexts: ["selection"] });
    });
  } catch (e) {
    logger.warn("context menu setup failed", { error: String(e) });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const m = MENU.find((x) => x.id === info.menuItemId);
  if (!m || !tab?.id || !info.selectionText) return;
  void sendToTab(tab.id, { type: "ask.selection", text: info.selectionText, prompt: m.prompt });
});

async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs.map(async (t) => {
      if (!t.id) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] });
      } catch {
        /* protected page */
      }
    }),
  );
}

chrome.runtime.onInstalled.addListener(async (details) => {
  installMenus();
  const current = await getSettings();
  await setSettings({ ...DEFAULT_SETTINGS, ...current });
  await injectIntoOpenTabs();
  if (details.reason === "install") await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
});

chrome.runtime.onStartup.addListener(() => {
  installMenus();
});

logger.info("service worker ready");
