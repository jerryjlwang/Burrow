import type { Bubble } from "./store";

/** The Bubble component's typewriter speed; hold times are built on it, so it lives here. */
export const TYPE_CHARS_PER_SECOND = 42;
const READ_MS_PER_CHAR = 55;
const MAX_QUEUED = 3;
/** A queued line this old is about a moment that has passed. */
const STALE_MS = 20_000;

/** How long a bubble must stay up before anything may replace it: typing it out, then a child reading it. */
export function bubbleHoldMs(text: string): number {
  const ms = (text.length / TYPE_CHARS_PER_SECOND) * 1000 + text.length * READ_MS_PER_CHAR;
  return Math.round(Math.min(16_000, Math.max(2_500, ms)));
}

/** A bubble with buttons stays until the student answers it or it expires; clear() and its expiry pump the queue. */
const awaitsAnswer = (bubble: Bubble) => !!bubble.actions?.length || !bubble.expiresAt;

export interface BubbleIo {
  get: () => Bubble | null;
  set: (bubble: Bubble | null) => void;
}

/**
 * Owns what the speech bubble shows. A bubble is guaranteed its hold time: later bubbles queue
 * behind it instead of wiping it mid-sentence, and an expiry shorter than the hold is stretched.
 * Only a confirmation jumps the queue — an action is blocked on it.
 */
export class BubbleQueue {
  private queue: Array<{ bubble: Bubble; at: number }> = [];
  private holdUntil = 0;
  private expireTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private io: BubbleIo) {}

  show(bubble: Bubble): void {
    const current = this.io.get();
    const now = Date.now();
    const free = !current || (now >= this.holdUntil && !awaitsAnswer(current));
    if (free || current?.id === bubble.id || bubble.kind === "confirmation") {
      this.present(bubble);
      return;
    }
    // Latest-wins among plain replies, like the speech queue: only the newest line is still true.
    if (bubble.kind === "reply") this.queue = this.queue.filter((q) => q.bubble.kind !== "reply");
    this.queue.push({ bubble, at: now });
    if (this.queue.length > MAX_QUEUED) this.queue.shift();
    this.schedulePump();
  }

  /** Remove the current bubble (and any queued ones) matching the predicate; everything when omitted. */
  clear(match: (bubble: Bubble) => boolean = () => true): void {
    this.queue = this.queue.filter((q) => !match(q.bubble));
    const current = this.io.get();
    if (current && match(current)) {
      this.io.set(null);
      this.holdUntil = 0;
    }
    this.pump();
  }

  dispose(): void {
    if (this.expireTimer) clearTimeout(this.expireTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.queue = [];
  }

  private present(bubble: Bubble): void {
    if (this.expireTimer) clearTimeout(this.expireTimer);
    const now = Date.now();
    this.holdUntil = now + bubbleHoldMs(bubble.text);
    this.io.set(bubble);
    if (bubble.expiresAt) {
      this.expireTimer = setTimeout(() => {
        if (this.io.get()?.id === bubble.id) this.io.set(null);
        this.pump();
      }, Math.max(bubble.expiresAt, this.holdUntil) - now);
    }
    if (this.queue.length) this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.pump(), Math.max(0, this.holdUntil - Date.now()));
  }

  private pump(): void {
    const now = Date.now();
    this.queue = this.queue.filter((q) => now - q.at <= STALE_MS || q.bubble.kind === "offer");
    if (!this.queue.length) return;
    const current = this.io.get();
    if (current && now < this.holdUntil) return this.schedulePump();
    if (current && awaitsAnswer(current)) return;
    this.present(this.queue.shift()!.bubble);
  }
}
