import type { PageSummary, PendingOffer } from "@shared/types";
import { isStopCommand, truncate } from "@shared/text";
import { HeuristicConceptExtractor, pageToExtractionInput, type ConceptExtraction, type ExtractionInput } from "@shared/concepts";
import { slugify } from "@shared/graph";
import { parsePlan, topicPlanKey } from "@shared/plan";
import { describeSketch, eraseFromSketch, parseSketch } from "@shared/sketch";
import { validateInkJudgement } from "@shared/ink";
import { pageRole } from "../components/handoff";
import { markInkAt } from "../components/InkCoach";
import { isVideoQuestion, pickRelated, videoQuery } from "@shared/related";
import { planStepSuggestion } from "@shared/path";
import type { PlanRoute } from "./store";
import { classifyTask } from "../actions/policy";
import { quoteRegion } from "../actions/inspect";
import { ElementRegistry } from "../page-understanding/registry";
import { extractPage, HOST_ID } from "../page-understanding/extract";
import { PageWatcher, type ChangeReason } from "../page-understanding/watcher";
import { OverlayController } from "../actions/overlay";
import { isOwnKey } from "../actions/surface";
import { AgentLoop } from "../agent/loop";
import { Session } from "../agent/session";
import { SignalTracker } from "../proactive/signals";
import { ProactiveEngine } from "../proactive/engine";
import { VideoCompanion } from "../proactive/video-companion";
import { VoiceController } from "../voice/controller";
import { store, type Bubble } from "./store";
import { BubbleQueue } from "./bubbles";
import { getSettings, onSettingsChange, setSettings, type Settings } from "../shared/settings";
import { sendToBackground, isExtensionContextValid, type ContentBroadcast, type InkMeta } from "../shared/messages";
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
  readonly video: VideoCompanion;
  private readonly bubbles = new BubbleQueue({ get: () => store.getState().bubble, set: (bubble) => store.setState({ bubble }) });
  private readonly extractor = new HeuristicConceptExtractor();
  /** Topic signature of the last page scheduled for extraction, to skip SPA mutations that change nothing. */
  private extractSig = "";
  private extractTimer: number | null = null;
  private page: PageSummary | null = null;
  private pendingConfirmation: { id: string; resolve: (yes: boolean) => void; timer: number } | null = null;
  private pendingOffer: PendingOffer | null = null;
  private bubbleTimer: number | null = null;
  private celebrateTimer: number | null = null;
  private errorTimer: number | null = null;
  private lastMutationSeen = 0;
  private disposed = false;

  constructor() {
    this.watcher = new PageWatcher((reason) => this.handlePageChange(reason));
    this.voice = new VoiceController({
      onFinalTranscript: (text) => void this.handleUserText(text, "voice"),
      // A pending yes/no or a stop command is answered locally, so there is nothing to get ahead on.
      onProbableEndOfTurn: (text) => {
        // Not on the drawing board: a guess made there would lack the laptop task and the ink.
        if (!this.pendingConfirmation && !this.pendingOffer && !isStopCommand(text) && isExtensionContextValid() && pageRole() !== "board") this.loop.speculate(text);
      },
      // Only while it is actually playing: a paused video says nothing the mic could pick up.
      ambientSpeech: () => {
        const v = this.video.context();
        return v && !v.paused && v.hasTranscript ? v.heard : null;
      },
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
        openTab: async (url, resume) => {
          // The new tab inherits this conversation from the synced session; don't leave it to the debounce.
          if (resume) await this.session.sync();
          try {
            await sendToBackground({ type: "nav.open", url, resume }, 3000);
          } catch {
            window.open(url, "_blank", "noopener");
          }
        },
        switchTab: async (tabId) => {
          await sendToBackground({ type: "nav.switch", tabId }, 3000);
        },
        lookup: async (query, prefer) => {
          const r = await sendToBackground({ type: "lookup", query, prefer }, 15_000);
          return r.results;
        },
        makePlan: async (topic) => {
          const r = await sendToBackground({ type: "steps.plan", request: { topic } }, 25_000);
          return parsePlan(r.plan, { key: topicPlanKey(topic), source: "llm" });
        },
        showPlan: () => this.showPlan(),
        trustedInputEnabled: () => store.getState().settings.trustedInput,
        input: async (ops) => {
          try {
            return await sendToBackground({ type: "input", ops }, 8000);
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        },
        // "Point out where I went wrong" on the drawing board: the watcher finds the part, the coach hops and rings it.
        markInk: async (target) => {
          if (pageRole() !== "board") return { ok: false, error: "not on the drawing board" };
          try {
            const r = await sendToBackground({ type: "tablet.locate", part: target }, 20_000);
            if (!r?.mark) return { ok: false, error: r?.error ?? "not found in the handwriting" };
            await markInkAt(r.mark, r.box);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e).slice(0, 120) };
          }
        },
        sketch: (spec, opts) => {
          const sk = parseSketch(spec);
          if (!sk.items.length) return;
          const named = opts?.elementId != null ? this.registry.get(opts.elementId) : opts?.quote ? quoteRegion(document.body, opts.quote, HOST_ID, { grow: false }) : null;
          const prev = store.getState().board;
          if (opts?.add && prev) {
            // Extend the drawing on screen: same board id so the reveal continues, not restarts.
            store.setState({ board: { ...prev, title: sk.title ?? prev.title, items: [...prev.items, ...sk.items].slice(0, 48), anchor: named ?? prev.anchor, region: named ? null : prev.region }, planView: null });
            return;
          }
          // A video has no element id and no text to quote, so the model can never name it. While one
          // is being watched, an unanchored drawing goes onto the frame's empty space instead of the corner.
          const onVideo = named ? null : this.video.watcher.element;
          store.setState({ board: { id: `${Date.now()}`, title: sk.title, items: sk.items, anchor: named ?? onVideo, region: onVideo ? this.video.watcher.emptyRegion() : null }, planView: null });
        },
        eraseSketch: (spec) => {
          const board = store.getState().board;
          if (!board) return null;
          const { items, erased } = eraseFromSketch(board.items, spec);
          // Same board id and position: what is left stays exactly where it was.
          store.setState({ board: items.length ? { ...board, items } : null });
          return { erased, left: items.length };
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
      onError: (message) => this.showAgentError(message),
      getPlan: () => this.engine.planContext,
      // On the drawing board his page is excalidraw; what he must know is the laptop task and the ink.
      getTablet: async () => (pageRole() === "board" ? await sendToBackground({ type: "tablet.context" }, 2500).catch(() => null) : null),
      onHint: () => this.engine.notePlanEngaged(),
      getBoard: () => {
        const board = store.getState().board;
        return board && board.items.length ? describeSketch(board) : null;
      },
      getVideo: () => {
        const context = this.video.context();
        return context ? { context, frame: () => this.video.watcher.frame() } : null;
      },
      videoInView: () => {
        const r = this.video.watcher.rect;
        return !!r && r.bottom > 80 && r.top < window.innerHeight - 80;
      },
      returnToVideo: () => this.video.watcher.element?.scrollIntoView({ behavior: "smooth", block: "center" }),
    });
    this.video = new VideoCompanion({
      session: this.session,
      isBusy: () => this.loop.running || this.pendingConfirmation !== null || this.pendingOffer !== null || this.voice.speaking,
      speak: (text) => this.voice.speak(text),
      stopSpeaking: () => this.voice.stopSpeaking(),
      showBubble: (bubble) => this.showBubble(bubble),
      clearBubble: (id) => this.bubbles.clear((b) => b.id === id),
      onOffer: (offer) => this.showOffer(offer),
      explain: (goal) => void this.loop.run("Tell me more", { source: "proactive", goal }),
      updateSetting: (patch) => this.updateSetting(patch),
    });
    this.engine = new ProactiveEngine({
      tracker: this.tracker,
      session: this.session,
      overlay: this.overlay,
      registry: this.registry,
      watcher: this.watcher,
      getPage: () => this.page,
      refreshPage: () => this.observe(),
      // A playing video has the student's attention: over it, only the video companion's own gate may surface anything.
      isBusy: () => this.loop.running || this.pendingConfirmation !== null || this.voice.speaking || this.video.watcher.playing,
      speak: (text) => this.voice.speak(text),
      onOffer: (offer) => this.showOffer(offer),
      onPlanProgress: () => this.refreshPlanView(),
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

    // Escape is the universal interrupt: stop talking, stop acting, clear the overlay.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isOwnKey()) return;
      if (!this.voice.speaking && !this.loop.running && !store.getState().board) return;
      this.voice.stopSpeaking();
      this.loop.cancel();
      this.overlay.clear();
      store.setState({ characterState: this.voice.listening ? "listening" : "idle", status: "", board: null });
    };
    document.addEventListener("keydown", onKeydown, true);
    // Observe whatever changed in the last debounce window before this document goes away.
    window.addEventListener("pagehide", () => this.watcher.flush());
    // Rehearsal hook: the developer panel and the tablet e2e fire ink verdicts without a tablet.
    window.addEventListener("burrow:judge", (e) => {
      const d = (e as CustomEvent<{ judgement?: unknown; meta?: InkMeta }>).detail;
      const v = validateInkJudgement(d?.judgement);
      if (v.ok) this.engine.onInkJudgement(v.judgement, d.meta);
    });

    this.session.onRecord = () => this.refreshPlanView();
    const session = await this.session.load();
    this.extractToGraph(this.observe());
    this.watcher.start();
    this.engine.start();
    this.video.watcher.refresh();
    void this.voice.refreshStatus();
    void this.checkServer();

    // Only the background's broadcasts are ours to answer. This same controller runs on the
    // extension's own pages (new tab, parent), where chrome.runtime.onMessage also receives every
    // request other contexts send to the background; answering those would beat the background's
    // reply and hand the caller a bare {ok: true}.
    const BROADCASTS = new Set<string>(["voice.state", "voice.transcript", "voice.level", "tts.state", "tts.level", "command", "ask.selection", "settings.changed", "ink.judgement"]);
    chrome.runtime.onMessage.addListener((msg: ContentBroadcast, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object" || !("type" in msg) || !BROADCASTS.has(msg.type)) return;
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
        case "agent.say":
          this.loop.handleEarlySay(msg.requestId, msg.say);
          break;
        case "ink.judgement":
          this.engine.onInkJudgement(msg.judgement, { reason: msg.reason, rung: msg.rung, task: msg.task });
          break;
      }
      sendResponse?.({ ok: true });
    });

    // Resume an agent loop interrupted by navigation (e.g. "open it" → click → new page).
    const pending = session?.pendingLoop;
    if (pending && Date.now() - pending.at < 25_000) {
      // The pending loop is cleared by the loop itself once it has a decision in hand — not here.
      // Sites that replace their document right after load (redirects, SPA shells) would otherwise
      // eat the handoff in a page that dies before the loop ever runs.
      logger.info("resuming loop after navigation", { utterance: pending.utterance, step: pending.step });
      window.setTimeout(() => void this.loop.run(pending.utterance, { source: "resume", resume: pending }), 350);
    } else if (pending) {
      await this.session.setPendingLoop(null);
    }
  }

  destroy(): void {
    this.disposed = true;
    if (this.extractTimer) window.clearTimeout(this.extractTimer);
    this.watcher.stop();
    this.engine.stop();
    this.video.stop();
    this.bubbles.dispose();
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
      store.setState((s) => ({ offline: !h.ok, voice: { ...s.voice, serverOk: h.ok, deepgram: h.ok ? !!h.deepgram : s.voice.deepgram } }));
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
    this.extractToGraph(page);
    this.engine.onPageChange(page, reason);
    this.video.watcher.refresh();
  }

  /**
   * Schedule a debounced extraction of the current page into the session knowledge graph. Deduped
   * by topic signature so a stream of SPA mutations (or quick page flips) triggers at most one
   * extraction per topic the learner settles on — the main cost lever for the LLM path.
   */
  private extractToGraph(page: PageSummary): void {
    const sig = `${page.title}\0${page.headings.join("|")}`;
    if (sig === this.extractSig) return;
    this.extractSig = sig;
    const input = pageToExtractionInput(page);
    if (this.extractTimer) window.clearTimeout(this.extractTimer);
    this.extractTimer = window.setTimeout(() => void this.runExtract(input, sig), 1500);
  }

  private async runExtract(input: ExtractionInput, sig: string): Promise<void> {
    let extraction: ConceptExtraction;
    try {
      // Server extractor (OpenAI: concepts, prerequisite/related edges, open-ended misconceptions).
      extraction = await sendToBackground({ type: "extract", input }, 25_000);
    } catch {
      // Offline / server down: fall back to the instant heuristic floor.
      extraction = this.extractor.extract(input);
    }
    if (this.disposed || sig !== this.extractSig) return; // a newer topic superseded this one
    if (!extraction?.concepts?.length && !extraction?.misconceptions?.length) return;
    this.session.record({ kind: "extraction", extraction, ctx: { url: input.url, title: input.title, kind: "page" }, at: Date.now() });
    logger.debug("graph updated", { concepts: extraction.concepts.length, size: this.session.graph.size });
    this.surfaceMisconceptions(extraction);
    // Hand the page's top concepts to the path consumer (prerequisite gaps, next-step suggestions).
    const topIds = [...extraction.concepts]
      .sort((a, b) => b.salience - a.salience)
      .map((c) => this.session.graph.resolve(c.label))
      .filter((id): id is string => id !== null)
      .slice(0, 3);
    const missedIds = (extraction.missed ?? []).map((label) => this.session.graph.resolve(label)).filter((id): id is string => id !== null);
    this.engine.onConceptsExtracted(topIds, missedIds);
  }

  /** Hand newly recorded misconceptions to the proactive engine (Socratic nudge). */
  private surfaceMisconceptions(extraction: ConceptExtraction): void {
    for (const em of extraction.misconceptions) {
      const cid = this.session.graph.resolve(em.concept);
      const m = cid ? this.session.graph.get(cid)?.misconceptions.find((x) => x.id === slugify(em.belief)) : undefined;
      if (m) this.engine.onMisconception(m);
    }
  }

  /**
   * What the student asks about in their own words is the cleanest curiosity signal there is.
   * Runs the same extractor over the utterance (kind "query"): concepts get voluntary exposure,
   * the most salient one an ask, and a misconception voiced out loud surfaces like a searched one.
   */
  private async noteQuestion(text: string): Promise<void> {
    const task = classifyTask(text, this.page);
    if (text.length < 12 || (task !== "learning" && task !== "chat")) return;
    // No title/headings: only the student's words count here, not the page they happen to be on.
    const input: ExtractionInput = { url: location.href, title: "", query: text };
    let extraction: ConceptExtraction;
    try {
      extraction = await sendToBackground({ type: "extract", input }, 25_000);
    } catch {
      extraction = this.extractor.extract(input);
    }
    if (this.disposed || (!extraction?.concepts?.length && !extraction?.misconceptions?.length)) return;
    const at = Date.now();
    this.session.record({ kind: "extraction", extraction, ctx: { url: input.url, title: document.title, kind: "query" }, at });
    const top = [...extraction.concepts].sort((a, b) => b.salience - a.salience)[0];
    if (top) this.session.record({ kind: "ask", concept: top.label, at });
    this.surfaceMisconceptions(extraction);
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

    // A spoken yes/no answers a bubble that carries its own buttons (watch-along consent, a video pause).
    const asking = store.getState().bubble;
    if (asking?.onAction && yesNo && !this.pendingConfirmation) {
      this.session.addTurn({ role: "user", text, at: Date.now() });
      this.bubbleAction(yesNo === "yes" ? "accept" : "decline");
      return;
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
          path: offer.path,
          goal:
            offer.goal ??
            (offer.type === "hint" || offer.type === "nudge" || offer.type === "explain"
              ? "The student accepted your offer of help. Give ONE small, teaching hint about the current problem (do not reveal the final answer) and point to the relevant part of the page."
              : `The student accepted your offer: "${offer.message}". Do the helpful thing you offered.`),
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
    void this.noteQuestion(text);
    await this.loop.run(text, { source });
    void this.maybeRecommendVideo(text);
  }

  /** A question asked about a video already answered — track the URL so each video recommends at most once. */
  private recommendedVideoFor = new Set<string>();

  /**
   * After answering a question about a video, offer ONE related video as a small banner. The
   * lookup runs server-side; no result, no banner — a recommendation nobody asked for owes no error.
   */
  private async maybeRecommendVideo(question: string): Promise<void> {
    if (this.disposed || !store.getState().settings.proactiveEnabled) return;
    if (!this.video.context() || !isVideoQuestion(question)) return;
    const href = location.href;
    if (this.recommendedVideoFor.has(href)) return;
    this.recommendedVideoFor.add(href);
    try {
      const r = await sendToBackground({ type: "lookup", query: videoQuery(document.title), prefer: "video" }, 15_000);
      const pick = pickRelated(r.results, href);
      if (!pick || this.disposed) return;
      const id = `video-reco-${Date.now()}`;
      const settle = () => {
        this.bubbles.clear((b) => b.id === id);
        store.setState((s) => (s.attention === 1 ? { attention: 0 } : {}));
      };
      store.setState({ attention: 1 });
      this.showBubble({
        id,
        text: `If it helps, I found another video on this: “${truncate(pick.title, 70)}”`,
        // kind "offer" (with onAction) is the one banner shape that renders beside an open panel too.
        kind: "offer",
        actions: [
          { label: "Watch", value: "open", primary: true },
          { label: "No thanks", value: "dismiss" },
        ],
        onAction: (v) => {
          if (v === "open" || v === "accept") void sendToBackground({ type: "nav.open", url: pick.url }, 3000).catch(() => window.open(pick.url, "_blank", "noopener"));
          settle();
        },
        expiresAt: Date.now() + 25_000,
      });
      window.setTimeout(settle, 25_000);
    } catch {
      /* quiet */
    }
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
    // "error" outlives the loop's finally: showAgentError owns its reset.
    store.setState((s) => ({ characterState: s.characterState === "error" ? "error" : s.characterState === "speaking" ? "speaking" : s.voice.mode === "listening" ? "listening" : "idle" }));
  }

  /** Hard failure presentation: confused rabbit + error bubble. Nothing is spoken — no brain, no words. */
  private showAgentError(message: string): void {
    store.setState({ characterState: "error", busy: false });
    this.showBubble({ id: `agent-error-${Date.now()}`, text: message, kind: "error", expiresAt: Date.now() + 8000 });
    if (this.errorTimer) window.clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => store.setState((s) => (s.characterState === "error" ? { characterState: s.voice.mode === "listening" ? "listening" : "idle" } : {})), 8000);
  }

  // ---------- Offers & confirmations ----------

  private showOffer(offer: PendingOffer): void {
    // A replaced offer's bubble must not linger: its buttons would act on the new offer.
    if (this.pendingOffer) this.clearOffer();
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
    this.bubbles.clear((b) => b.kind === "offer" && !b.onAction);
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
    this.bubbles.clear((b) => b.id === pc.id);
    pc.resolve(yes);
  }

  bubbleAction(value: "accept" | "decline" | "dismiss" | "open"): void {
    const bubble = store.getState().bubble;
    if (!bubble) return;
    if (bubble.onAction) {
      bubble.onAction(value);
      this.bubbles.clear((b) => b.id === bubble.id);
      return;
    }
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
    this.bubbles.clear((b) => b.id === bubble.id);
  }

  showBubble(bubble: Bubble): void {
    this.bubbles.show(bubble);
  }

  private celebrate(say: string | null): void {
    store.setState({ characterState: "celebrating" });
    if (say) this.reply(say);
    if (this.celebrateTimer) window.clearTimeout(this.celebrateTimer);
    this.celebrateTimer = window.setTimeout(() => store.setState((s) => (s.characterState === "celebrating" ? { characterState: s.voice.mode === "listening" ? "listening" : "idle" } : {})), 2600);
  }

  // ---------- Plan map ----------

  /**
   * Everything plan-shaped the rabbit knows, as routes: the problem on screen (progress from the
   * step judge) first, then the learning plans in long-term memory, most recently touched first.
   */
  private planRoutes(): PlanRoute[] {
    const routes: PlanRoute[] = [];
    const { plan, planStep } = this.engine.planContext;
    if (plan?.kind === "problem") {
      const reached = planStep ?? 0;
      routes.push({ key: plan.key, kind: "problem", goal: plan.goal, steps: plan.steps.map((s, i) => ({ title: s.title, state: i < reached ? "done" : i === reached ? "current" : "todo" })) });
    }
    for (const p of this.session.graph.profile.plans.filter((x) => x.kind === "topic").sort((a, b) => b.updatedAt - a.updatedAt)) {
      const next = p.steps.findIndex((s) => !s.done);
      routes.push({ key: p.key, kind: "topic", goal: p.goal, steps: p.steps.map((s, i) => ({ title: s.title, state: s.done ? "done" : i === next ? "current" : "todo" })) });
    }
    return routes;
  }

  /** Open the plan map (it shares the chalkboard's corner). False when there is nothing to show. */
  showPlan(): boolean {
    this.engine.recallPlan();
    const routes = this.planRoutes();
    if (!routes.length) return false;
    store.setState({ planView: { routes }, board: null });
    return true;
  }

  closePlan(): void {
    store.setState({ planView: null });
  }

  /** Keep an open map honest as steps complete (a resource opened, an attempt landed, working advanced). */
  private refreshPlanView(): void {
    if (store.getState().planView) store.setState({ planView: { routes: this.planRoutes() } });
  }

  /** A tap on a learning-plan step: run that step's playbook, exactly as if the offer had been accepted. */
  startPlanStep(planKey: string, index: number): void {
    const plan = this.session.graph.profile.plans.find((p) => p.key === planKey);
    const suggestion = plan ? planStepSuggestion(this.session.graph, plan, index) : null;
    if (!suggestion) return;
    if (this.pendingOffer) this.clearOffer(), this.engine.offerResolved("dismissed");
    this.voice.stopSpeaking();
    this.closePlan();
    const text = `Let's do step ${index + 1}: ${plan!.steps[index].title}`;
    this.session.addTurn({ role: "user", text, at: Date.now() });
    void this.loop.run(text, { source: "text", goal: suggestion.goal, path: { kind: "plan", conceptLabel: suggestion.conceptLabel, query: suggestion.resource?.query, prefer: suggestion.resource?.prefer } });
  }

  // ---------- UI intents ----------

  /**
   * Character click: if the rabbit is talking, the click means "stop" — silence it and open the
   * panel so the student can redirect. Only a quiet rabbit toggles the panel as before.
   */
  charClicked(): void {
    if (this.voice.speaking) {
      this.voice.stopSpeaking();
      if (!store.getState().panelOpen) this.openPanel();
      return;
    }
    this.togglePanel();
  }

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
      if (s.voice.deepgram === false) {
        this.showBubble({ id: "no-deepgram", text: "Voice needs a Deepgram key on the server (see .env). Typing works fine in the meantime.", kind: "error", expiresAt: Date.now() + 8000 });
        return;
      }
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
        } else if (!store.getState().panelOpen) {
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
