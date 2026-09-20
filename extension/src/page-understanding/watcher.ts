import { HOST_ID } from "./extract";

export type ChangeReason = "mutation" | "url" | "load" | "visibility" | "manual";

export interface PageWatcherOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  urlPollMs?: number;
}

/** Where pages announce outcomes: graded feedback, validation errors, status messages. */
const LIVE_REGION = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]';

/**
 * Coalesces DOM mutations, SPA navigations and load events into a debounced "page changed" signal.
 * Guarantees a trailing call. Fires at most once per debounce window, plus at most one immediate
 * delivery per window when a live region changes (see {@link PageWatcher.schedule}).
 */
export class PageWatcher {
  private observer: MutationObserver | null = null;
  private timer: number | null = null;
  private firstPendingAt = 0;
  private lastUrgentAt = 0;
  private pendingReason: ChangeReason | null = null;
  private lastUrl = location.href;
  private urlTimer: number | null = null;
  private readonly onChange: (reason: ChangeReason) => void;
  private readonly opts: Required<PageWatcherOptions>;
  private listeners: Array<() => void> = [];
  /** Timestamp of the last DOM mutation, used by action verification. */
  lastMutationAt = 0;
  mutationCount = 0;

  constructor(onChange: (reason: ChangeReason) => void, opts: PageWatcherOptions = {}) {
    this.onChange = onChange;
    this.opts = { debounceMs: opts.debounceMs ?? 300, maxWaitMs: opts.maxWaitMs ?? 1500, urlPollMs: opts.urlPollMs ?? 500 };
  }

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver((records) => {
      let relevant = false;
      let announcement = false;
      for (const r of records) {
        const t = r.target as Node;
        if ((t as Element).id === HOST_ID || (t.parentElement && t.parentElement.closest(`#${HOST_ID}`))) continue;
        relevant = true;
        if ((t.nodeType === Node.ELEMENT_NODE ? (t as Element) : t.parentElement)?.closest(LIVE_REGION)) {
          announcement = true;
          break;
        }
      }
      if (!relevant) return;
      this.lastMutationAt = Date.now();
      this.mutationCount++;
      this.schedule("mutation", announcement);
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "disabled", "aria-hidden", "aria-invalid", "aria-selected", "aria-expanded", "aria-checked", "aria-disabled", "open", "value", "checked", "src", "href"],
    });
    const onUrl = () => this.checkUrl();
    window.addEventListener("popstate", onUrl);
    window.addEventListener("hashchange", onUrl);
    const onLoad = () => this.schedule("load");
    window.addEventListener("load", onLoad);
    const onVis = () => {
      if (document.visibilityState === "visible") this.schedule("visibility");
    };
    document.addEventListener("visibilitychange", onVis);
    const nav = (window as unknown as { navigation?: EventTarget }).navigation;
    const onNavSuccess = () => this.checkUrl();
    nav?.addEventListener("navigatesuccess", onNavSuccess);
    this.urlTimer = window.setInterval(() => this.checkUrl(), this.opts.urlPollMs);
    this.listeners.push(
      () => window.removeEventListener("popstate", onUrl),
      () => window.removeEventListener("hashchange", onUrl),
      () => window.removeEventListener("load", onLoad),
      () => document.removeEventListener("visibilitychange", onVis),
      () => nav?.removeEventListener("navigatesuccess", onNavSuccess),
    );
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer) window.clearTimeout(this.timer);
    if (this.urlTimer) window.clearInterval(this.urlTimer);
    this.timer = null;
    this.urlTimer = null;
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  /** Forces a change notification (e.g. after our own action). */
  poke(reason: ChangeReason = "manual"): void {
    this.schedule(reason);
  }

  private checkUrl(): void {
    if (location.href !== this.lastUrl) {
      this.lastUrl = location.href;
      this.schedule("url");
    }
  }

  /**
   * Deliver a pending change right now instead of after the debounce. For `pagehide`: feedback
   * that appears just before an unload (a quiz that auto-advances, a tab closed on "Correct!")
   * would otherwise never be observed, and the attempt it graded would be lost from memory.
   */
  flush(): void {
    if (!this.timer) return;
    window.clearTimeout(this.timer);
    this.timer = null;
    const r = this.pendingReason ?? "mutation";
    this.pendingReason = null;
    this.onChange(r);
  }

  /**
   * `urgent` skips the debounce: a live region changing is the page announcing something (graded
   * feedback, a validation error), and pages often unload right after — a quiz auto-advancing, a
   * tab closed on "Correct!". At most one urgent delivery per debounce window, so a chatty live
   * region can't turn into an extraction storm.
   */
  private schedule(reason: ChangeReason, urgent = false): void {
    const now = Date.now();
    if (urgent && now - this.lastUrgentAt < this.opts.debounceMs) urgent = false;
    if (urgent) this.lastUrgentAt = now;
    if (!this.pendingReason) this.firstPendingAt = now;
    // URL changes outrank mutations for the reason label.
    if (reason === "url" || reason === "load" || !this.pendingReason) this.pendingReason = reason;
    if (this.timer) window.clearTimeout(this.timer);
    const waited = now - this.firstPendingAt;
    const delay = urgent ? 0 : Math.max(0, Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const r = this.pendingReason ?? "mutation";
      this.pendingReason = null;
      this.onChange(r);
    }, delay);
  }
}
