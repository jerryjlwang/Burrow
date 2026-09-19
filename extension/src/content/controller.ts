import type { PageSummary, PendingOffer } from "@shared/types";
import { isStopCommand, truncate } from "@shared/text";
import { ElementRegistry } from "../page-understanding/registry";
import { extractPage } from "../page-understanding/extract";
import { PageWatcher, type ChangeReason } from "../page-understanding/watcher";
import { OverlayController } from "../actions/overlay";
import { AgentLoop } from "../agent/loop";
import { Session } from "../agent/session";
import { SignalTracker } from "../proactive/signals";
import { ProactiveEngine } from "../proactive/engine";
import { VoiceController } from "../voice/controller";
import { store, type Bubble } from "./store";
import { getSettings, onSettingsChange, setSettings, type Settings } from "../shared/settings";
import { sendToBackground, isExtensionContextValid, type ContentBroadcast } from "../shared/messages";
import { log, onLog, setDebugLogging } from "../shared/logger";

const logger = log("ui");

/** Composes page understanding, actions, the agent loop, voice and proactivity for one tab. */
export class CompanionController {
  readonly registry = new ElementRegistry();
  readonly overlay = new OverlayController(this.registry);
  readonly tracker = new SignalTracker();
  readonly session = new Session();
  readonly watcher: PageWatcher;
  readonly loop: AgentLoop;
  readonly voice: VoiceController;
  readonly engine: ProactiveEngine;
  private page: PageSummary | null = null;
  private pendingConfirmation: { id: string; resolve: (yes: boolean) => void; timer: number } | null = null;
  private pendingOffer: PendingOffer | null = null;
  private bubbleTimer: number | null = null;
  private celebrateTimer: number | null = null;
  private lastMutationSeen = 0;
  private disposed = false;

  constructor() {
    this.watcher = new PageWatcher((reason) => this.handlePageChange(reason));
    this.voice = new VoiceController({
      onFinalTranscript: (text) => void this.handleUserText(text, "voice"),
      onSpeechStart: () => this.handleSpeechStart(),
    });
    this.loop = new AgentLoop({
      executor: {
        registry: this.registry,
        overlay: this.overlay,
        rescan: () => this.observe(),
        waitForChange: (ms) => this.waitForChange(ms),
        navigate: async (url) => {
          try {
            await sendToBackground({ type: "nav.navigate", url }, 3000);
          } catch {
            location.href = url;
          }
        },
        goBack: async () => {
          try {
            await sendToBackground({ type: "nav.back" }, 3000);
          } catch {
            history.back();
          }
        },
        beforeMaybeNavigate: () => this.session.sync(),
      },
      session: this.session,
      signals: this.tracker,
      observe: () => this.observe(),
      speak: (text) => this.voice.speak(text),
      stopSpeaking: () => this.voice.stopSpeaking(),
      confirm: (message) => this.confirm(message),
      onIdle: () => this.afterLoopIdle(),
    });
    this.engine = new ProactiveEngine({
      tracker: this.tracker,
      session: this.session,
      overlay: this.overlay,
      registry: this.registry,
      watcher: this.watcher,
      getPage: () => this.page,
      isBusy: () => this.loop.running || this.pendingConfirmation !== null || this.voice.speaking,
      speak: (text) => this.voice.speak(text),
      onOffer: (offer) => this.showOffer(offer),
      onCelebrate: (say) => this.celebrate(say),
    });
  }

  async init(): Promise<void> {
    const settings = await getSettings();
    this.applySettings(settings);
    if (settings.hiddenOnHosts.includes(location.hostname)) store.setState({ hidden: true });
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const applyMotion = () => store.setState({ reducedMotion: settings.reducedMotion === "on" || (settings.reducedMotion === "auto" && mq.matches) });
    applyMotion();
    mq.addEventListener?.("change", applyMotion);
    onLog((entry) => {
      if (!store.getState().settings.debugMode) return;
      store.setState((s) => ({ logs: [...s.logs.slice(-79), entry] }));
    });
    onSettingsChange((s) => this.applySettings(s));

    const session = await this.session.load();
    this.observe();
    this.watcher.start();
    this.engine.start();
    void this.voice.refreshStatus();
    void this.checkServer();

    chrome.runtime.onMessage.addListener((msg: ContentBroadcast, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (this.voice.handleBroadcast(msg)) {
        sendResponse?.({ ok: true });
        return;
      }
      switch (msg.type) {
        case "command":
          if (msg.name === "toggle-companion") this.togglePanel();
          else if (msg.name === "toggle-voice") void this.voice.toggle();
          break;
        case "ask.selection":
          this.openPanel();
          void this.handleUserText(`${msg.prompt}: "${truncate(msg.text, 600)}"`, "text");
          break;
        case "settings.changed":
          this.applySettings(msg.settings);
          break;
      }
      sendResponse?.({ ok: true });
    });

    // Resume an agent loop interrupted by navigation (e.g. "open it" → click → new page).
    const pending = session?.pendingLoop;
    if (pending && Date.now() - pending.at < 25_000) {
      logger.info("resuming loop after navigation", { utterance: pending.utterance, step: pending.step });
      await this.session.setPendingLoop(null);
      window.setTimeout(() => void this.loop.run(pending.utterance, { source: "resume", resume: pending }), 350);
    } else if (pending) {
      await this.session.setPendingLoop(null);
    }
  }

  destroy(): void {
    this.disposed = true;
    this.watcher.stop();
    this.engine.stop();
    this.overlay.clear();
    this.loop.cancel();
  }

  private applySettings(settings: Settings): void {
    store.setState({ settings });
    setDebugLogging(settings.debugMode);
  }

  async checkServer(): Promise<void> {
    try {
      const h = await sendToBackground({ type: "server.health" }, 6000);
      store.setState((s) => ({ offline: !h.ok, voice: { ...s.voice, serverOk: h.ok } }));
    } catch {
      store.setState((s) => ({ offline: true, voice: { ...s.voice, serverOk: false } }));
    }
  }

  observe(): PageSummary {
    const page = extractPage(document, { registry: this.registry });
    this.page = page;
    store.setState({ page });
    return page;
  }

  private handlePageChange(reason: ChangeReason): void {
    if (this.disposed) return;
    const page = this.observe();
    if (reason === "url") this.overlay.clear();
    this.engine.onPageChange(page, reason);
  }

  waitForChange(timeoutMs: number): Promise<{ changed: boolean; urlChanged: boolean }> {
    const startCount = this.watcher.mutationCount;
    const startUrl = location.href;
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        const urlChanged = location.href !== startUrl;
        const changed = this.watcher.mutationCount !== startCount;
        if (changed || urlChanged) {
          // Give the page a moment to settle after the first mutation.
          window.setTimeout(() => resolve({ changed: this.watcher.mutationCount !== startCount, urlChanged: location.href !== startUrl }), 180);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve({ changed: false, urlChanged: false });
          return;
        }
        window.setTimeout(check, 50);
      };
      check();
    });
  }

  // ---------- User input ----------

  async handleUserText(raw: string, source: "voice" | "text"): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (!isExtensionContextValid()) {
      store.setState({ status: "Pip was updated—reload this page to keep chatting." });
      return;
    }
    const yesNo = AgentLoop.interpretYesNo(text);

    if (this.pendingConfirmation) {
      this.session.addTurn({ role: "user", text, at: Date.now() });
      if (yesNo) {
        this.resolveConfirmation(yesNo === "yes");
        return;
      }
      this.resolveConfirmation(false);
    }

    if (isStopCommand(text)) {
      this.voice.stopSpeaking();
      this.loop.cancel();
      this.overlay.clear();
      this.session.addTurn({ role: "user", text, at: Date.now() });
      this.session.addTurn({ role: "companion", text: "Okay.", at: Date.now(), kind: "status" });
      store.setState({ characterState: this.voice.listening ? "listening" : "idle" });
      return;
    }

    if (this.pendingOffer && yesNo) {
      const offer = this.pendingOffer;
      this.clearOffer();
      this.session.addTurn({ role: "user", text, at: Date.now() });
      if (yesNo === "yes") {
        this.engine.offerResolved("accepted");
        await this.loop.run(text, {
          source,
          pendingOffer: offer,
          goal:
            offer.type === "hint" || offer.type === "nudge" || offer.type === "explain"
              ? "The student accepted your offer of help. Give ONE small, teaching hint about the current problem (do not reveal the final answer) and point to the relevant part of the page."
              : `The student accepted your offer: "${offer.message}". Do the helpful thing you offered.`,
        });
      } else {
        this.engine.offerResolved("declined");
        this.reply("Okay—I'm here if you need me.");
      }
      return;
    }
    if (this.pendingOffer) this.clearOffer(), this.engine.offerResolved("dismissed");

    this.voice.stopSpeaking();
    this.overlay.clear();
    this.session.addTurn({ role: "user", text, at: Date.now() });
    await this.loop.run(text, { source });
  }

  private handleSpeechStart(): void {
    // Barge-in: the student started talking while the character speaks.
    if (this.voice.speaking) {
      logger.info("barge-in: stopping speech");
      this.voice.stopSpeaking();
    }
    store.setState((s) => ({ characterState: s.busy ? s.characterState : "listening" }));
  }

  private reply(text: string, detail?: string): void {
    this.session.addTurn({ role: "companion", text, at: Date.now(), detail });
    void this.voice.speak(text);
  }

  private afterLoopIdle(): void {
    store.setState((s) => ({ characterState: s.characterState === "speaking" ? "speaking" : s.voice.mode === "listening" ? "listening" : "idle" }));
  }

  // ---------- Offers & confirmations ----------

  private showOffer(offer: PendingOffer): void {
    this.pendingOffer = offer;
    this.session.addTurn({ role: "companion", text: offer.message, at: Date.now(), kind: "offer" });
    this.showBubble({
      id: `offer-${offer.at}`,
      text: offer.message,
      kind: "offer",
      actions: [
        { label: "Yes, please", value: "accept", primary: true },
        { label: "I'm good", value: "decline" },
      ],
      expiresAt: Date.now() + 25_000,
    });
    if (this.bubbleTimer) window.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => {
      if (this.pendingOffer === offer) {
        this.clearOffer();
        this.engine.offerResolved("dismissed");
      }
    }, 25_000);
  }

  private clearOffer(): void {
    this.pendingOffer = null;
    store.setState((s) => (s.bubble?.kind === "offer" ? { bubble: null } : {}));
  }

  confirm(message: string): Promise<boolean> {
    this.resolveConfirmation(false);
    return new Promise<boolean>((resolve) => {
      const id = `confirm-${Date.now()}`;
      const timer = window.setTimeout(() => this.resolveConfirmation(false), 45_000);
      this.pendingConfirmation = { id, resolve, timer };
      this.showBubble({
        id,
        text: message,
        kind: "confirmation",
        actions: [
          { label: "Go ahead", value: "accept", primary: true },
          { label: "No", value: "decline" },
        ],
      });
    });
  }

  private resolveConfirmation(yes: boolean): void {
    const pc = this.pendingConfirmation;
    if (!pc) return;
    this.pendingConfirmation = null;
    window.clearTimeout(pc.timer);
    store.setState((s) => (s.bubble?.id === pc.id ? { bubble: null } : {}));
    pc.resolve(yes);
  }

  bubbleAction(value: "accept" | "decline" | "dismiss" | "open"): void {
    const bubble = store.getState().bubble;
    if (!bubble) return;
    if (bubble.kind === "confirmation") {
      if (value === "accept") this.resolveConfirmation(true);
      else this.resolveConfirmation(false);
      return;
    }
    if (bubble.kind === "offer") {
      if (value === "accept") void this.handleUserText("Yes please", "text");
      else if (value === "decline") void this.handleUserText("I'm good", "text");
      else {
        this.clearOffer();
        this.engine.offerResolved("dismissed");
      }
      return;
    }
    if (value === "open") void sendToBackground({ type: "open.onboarding" }).catch(() => undefined);
    store.setState({ bubble: null });
  }

  showBubble(bubble: Bubble): void {
    store.setState({ bubble });
    if (bubble.expiresAt) {
      const ttl = bubble.expiresAt - Date.now();
      window.setTimeout(() => store.setState((s) => (s.bubble?.id === bubble.id ? { bubble: null } : {})), Math.max(500, ttl));
    }
  }

  private celebrate(say: string | null): void {
    store.setState({ characterState: "celebrating" });
    if (say) this.reply(say);
    if (this.celebrateTimer) window.clearTimeout(this.celebrateTimer);
    this.celebrateTimer = window.setTimeout(() => store.setState((s) => (s.characterState === "celebrating" ? { characterState: s.voice.mode === "listening" ? "listening" : "idle" } : {})), 2600);
  }

  // ---------- UI intents ----------

  togglePanel(): void {
    const s = store.getState();
    if (s.minimized) {
      this.session.setPanel(true, false);
      return;
    }
    this.session.setPanel(!s.panelOpen);
  }

  openPanel(): void {
    this.session.setPanel(true, false);
  }

  closePanel(): void {
    this.session.setPanel(false);
  }

  minimize(): void {
    this.session.setPanel(false, true);
    this.overlay.clear();
  }

  restore(): void {
    this.session.setPanel(false, false);
  }

  async toggleVoice(): Promise<void> {
    const s = store.getState();
    if (s.voice.mode === "off" || s.voice.mode === "error") {
      const ok = await this.voice.start();
      if (!ok) {
        const st = store.getState().voice;
        if (st.errorCode === "permission") {
          this.showBubble({
            id: "mic-permission",
            text: "I need microphone access first. Open setup to enable it?",
            kind: "error",
            actions: [{ label: "Open setup", value: "open", primary: true }, { label: "Later", value: "dismiss" }],
          });
        } else {
          this.showBubble({ id: "voice-error", text: st.error ?? "Voice is having trouble connecting. You can still type to me.", kind: "error", expiresAt: Date.now() + 7000 });
        }
      }
    } else {
      await this.voice.stop();
    }
  }

  stopSpeaking(): void {
    this.voice.stopSpeaking();
  }

  async updateSetting(patch: Partial<Settings>): Promise<void> {
    const next = await setSettings(patch);
    this.applySettings(next);
  }

  openOnboarding(): void {
    void sendToBackground({ type: "open.onboarding" }).catch(() => undefined);
  }

  openDemo(): void {
    void sendToBackground({ type: "open.demo" }).catch(() => undefined);
  }
}
