/**
 * Head-start for slow work whose input is *probably* known before it is confirmed.
 *
 * The agent's decision takes seconds (the model thinks before it answers), and speech recognition
 * can tell us the student has *probably* finished a beat before it is sure. So the decision starts
 * on "probably", and when "sure" arrives with the same words, the loop picks up the call already
 * in flight instead of starting a new one. If the student kept talking, the guess is dropped and
 * nothing it produced is ever used — a speculation only computes, it never acts or speaks.
 */
export interface HeadStart<T> {
  promise: Promise<T>;
  /** How long the work had already been running when it was claimed. */
  headStartMs: number;
  /** Whatever the starter attached (the request id, so its early sentence can be matched up). */
  tag: string;
}

/** Words only: recognisers re-punctuate and re-case between an interim and the final transcript. */
export function speculationKey(utterance: string, scope: string): string {
  const words = utterance
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${scope}\n${words}`;
}

export class Speculator<T> {
  private current: { key: string; startedAt: number; promise: Promise<T>; tag: string } | null = null;

  constructor(
    private maxAgeMs = 20_000,
    private now: () => number = Date.now,
  ) {}

  /** Begin (or replace) the guess. A guess for the same key already in flight is kept, not restarted. */
  start(key: string, run: () => Promise<T>, tag = ""): void {
    if (this.current?.key === key && this.now() - this.current.startedAt < this.maxAgeMs) return;
    const promise = run();
    promise.catch(() => undefined); // an unclaimed guess that fails must not surface as an unhandled rejection
    this.current = { key, startedAt: this.now(), promise, tag };
  }

  /** Claim the guess if it is for exactly this input and still fresh. Either way, it is spent. */
  take(key: string): HeadStart<T> | null {
    const c = this.current;
    this.current = null;
    if (!c || c.key !== key) return null;
    const headStartMs = this.now() - c.startedAt;
    return headStartMs <= this.maxAgeMs ? { promise: c.promise, headStartMs, tag: c.tag } : null;
  }

  drop(): void {
    this.current = null;
  }

  get pending(): boolean {
    return this.current !== null;
  }
}
