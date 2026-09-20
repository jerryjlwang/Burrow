import type { ConversationTurn, StudentSessionState, PendingOffer } from "@shared/types";
import { emptyStudentState } from "@shared/types";
import { KnowledgeGraph } from "@shared/graph";
import { applyLearnerEvent, type LearnerEvent } from "@shared/events";
import { sendToBackground, type TabSession, type PendingLoop } from "../shared/messages";
import { store } from "../content/store";
import { log } from "../shared/logger";

const logger = log("session");

/**
 * Per-tab session state (conversation, student model, pending agent loop) mirrored to the
 * background so it survives navigations and service-worker restarts.
 */
export class Session {
  student: StudentSessionState = emptyStudentState();
  pendingOffer: PendingOffer | null = null;
  pendingLoop: PendingLoop | null = null;
  proactiveCooldownUntil = 0;
  /**
   * The learner knowledge graph: hydrated from the background's persisted canonical copy on load,
   * then read synchronously in this tab. Writes also go to the background as GraphEvents (see
   * controller/engine), which owns persistence — this copy is a fast local mirror.
   */
  graph = new KnowledgeGraph();
  /** Called after every recorded learner event (the plan map refreshes on it). */
  onRecord: (() => void) | null = null;
  private syncTimer: number | null = null;
  private loaded = false;

  async load(): Promise<TabSession | null> {
    // Hydrate the learner graph alongside the tab session; failure just means a fresh RAM graph.
    const hydrate = sendToBackground({ type: "graph.get" }, 4000)
      .then((snap) => {
        this.graph = KnowledgeGraph.fromJSON(snap);
      })
      .catch((e) => logger.debug("graph hydration skipped", { error: String(e) }));
    try {
      const [, s] = await Promise.all([hydrate, sendToBackground({ type: "tab.session.get" }, 4000)]);
      if (s) {
        this.student = { ...emptyStudentState(), ...(s.student ?? {}) };
        this.pendingLoop = s.pendingLoop ?? null;
        this.proactiveCooldownUntil = s.proactiveCooldownUntil ?? 0;
        store.setState({ conversation: s.conversation ?? [], panelOpen: !!s.panelOpen, minimized: !!s.minimized });
      }
      this.loaded = true;
      return s ?? null;
    } catch (e) {
      logger.warn("could not load session; starting fresh", { error: String(e) });
      this.loaded = true;
      return null;
    }
  }

  /** Apply a learner event to this tab's mirror and forward it to the background's canonical graph. */
  record(event: LearnerEvent): void {
    applyLearnerEvent(this.graph, event);
    this.onRecord?.();
    void sendToBackground({ type: "graph.event", event }, 5000).catch(() => undefined);
  }

  addTurn(turn: ConversationTurn): void {
    store.addTurn(turn);
    if (turn.role === "user") this.student.recentQuestions = [...this.student.recentQuestions.slice(-5), turn.text.slice(0, 120)];
    this.scheduleSync();
  }

  recentTurns(n = 10): ConversationTurn[] {
    return store.getState().conversation.slice(-n);
  }

  updateStudent(patch: Partial<StudentSessionState>): void {
    this.student = { ...this.student, ...patch };
    this.scheduleSync();
  }

  setPanel(open: boolean, minimized?: boolean): void {
    store.setState((s) => ({ panelOpen: open, minimized: minimized ?? s.minimized, unread: open ? 0 : s.unread }));
    this.scheduleSync();
  }

  async setPendingLoop(loop: PendingLoop | null): Promise<void> {
    this.pendingLoop = loop;
    try {
      await sendToBackground({ type: "tab.session.set", patch: { pendingLoop: loop } }, 3000);
    } catch (e) {
      logger.warn("could not persist pending loop", { error: String(e) });
    }
  }

  setCooldown(until: number): void {
    this.proactiveCooldownUntil = until;
    this.scheduleSync();
  }

  scheduleSync(): void {
    if (!this.loaded) return;
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => void this.sync(), 400);
  }

  async sync(): Promise<void> {
    const s = store.getState();
    try {
      await sendToBackground(
        {
          type: "tab.session.set",
          patch: {
            conversation: s.conversation.slice(-40),
            student: this.student,
            panelOpen: s.panelOpen,
            minimized: s.minimized,
            proactiveCooldownUntil: this.proactiveCooldownUntil,
          },
        },
        3000,
      );
    } catch (e) {
      logger.debug("session sync skipped", { error: String(e) });
    }
  }
}
