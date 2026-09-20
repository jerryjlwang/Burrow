import type { PageSummary, StruggleSignals } from "@shared/types";
import { detectProblem, problemKey } from "@shared/hints";
import type { WorkingJudgement } from "@shared/steps";

export const THRESHOLDS = {
  repeatedClickWindowMs: 20_000,
  repeatedClicksMin: 3,
  rapidWindowMs: 10_000,
  rapidClicksMin: 6,
  incorrectMin: 2,
  validationMin: 2,
  hesitationMs: 90_000,
  oscillationWindowMs: 90_000,
  /** How long after a user action an appearing error is attributed to that action. */
  attributionMs: 4_000,
  /** A wrong working step younger than this gets only a silent cue; older earns the bubble. */
  wrongStepBubbleMs: 8_000,
  cooldownMs: 45_000,
  declineCooldownMs: 180_000,
  dismissCooldownMs: 60_000,
};

export interface ClickRecord {
  at: number;
  key: string;
  name: string;
  disabled: boolean;
  /** Set once we know whether the page changed after the click. */
  changed?: boolean;
}

const INCORRECT_RE = /\b(incorrect|not quite|try again|wrong|not right|nope|not correct|almost)\b/i;
const DEAD_END_RE = /\b(404|page not found|not found|access denied|forbidden|you don.?t have permission|permission denied|unavailable|something went wrong|error 5\d\d)\b/i;

/**
 * Cheap, local behavioural signal tracker. No model calls happen here; it only
 * accumulates evidence that a student may be stuck so the engine can decide whether
 * to *consider* an intervention.
 */
export class SignalTracker {
  private clicks: ClickRecord[] = [];
  private urls: { url: string; at: number }[] = [];
  private lastActionAt = 0;
  private lastCountedActionAt = 0;
  private knownErrors = new Set<string>();
  private knownSuccesses = new Set<string>();
  private incorrectAt: number[] = [];
  private validationAt: number[] = [];
  private problem: string | null = null;
  private problemStartedAt = 0;
  private deadEnd = false;
  private lastErrorText: string | undefined;
  private hasQuizUi = false;
  private successSinceHint = false;
  private wrongStep: { step: number; category: string; firstAt: number } | null = null;

  recordClick(rec: ClickRecord): ClickRecord {
    this.clicks.push(rec);
    this.lastActionAt = rec.at;
    if (this.clicks.length > 50) this.clicks.splice(0, this.clicks.length - 50);
    return rec;
  }

  recordKeySubmit(at: number): void {
    this.lastActionAt = at;
  }

  recordUrl(url: string, at: number): void {
    const last = this.urls[this.urls.length - 1];
    if (last?.url === url) return;
    this.urls.push({ url, at });
    if (this.urls.length > 20) this.urls.splice(0, this.urls.length - 20);
  }

  /** Feed each fresh page model. Returns what newly appeared, so the engine can react (e.g. celebrate). */
  recordPage(page: PageSummary, now: number): { newErrors: string[]; newSuccesses: string[]; problemChanged: boolean } {
    this.hasQuizUi = page.hasQuizUi;
    const key = problemKey(detectProblem(page), page);
    let problemChanged = false;
    if (key !== this.problem) {
      this.problem = key;
      this.problemStartedAt = now;
      this.incorrectAt = [];
      this.validationAt = [];
      this.knownErrors.clear();
      this.knownSuccesses.clear();
      this.successSinceHint = false;
      this.wrongStep = null;
      problemChanged = true;
    }
    const newErrors = page.errors.filter((e) => !this.knownErrors.has(e));
    const newSuccesses = page.successes.filter((s) => !this.knownSuccesses.has(s));
    // Forget errors that disappeared so the same message can count again next time.
    for (const e of [...this.knownErrors]) if (!page.errors.includes(e)) this.knownErrors.delete(e);
    for (const s of [...this.knownSuccesses]) if (!page.successes.includes(s)) this.knownSuccesses.delete(s);
    for (const e of page.errors) this.knownErrors.add(e);
    for (const s of page.successes) this.knownSuccesses.add(s);

    // Attribute errors to the student's most recent action, at most once per action. This also
    // counts pages that keep showing the same "try again" message after every attempt.
    const attributable = now - this.lastActionAt <= THRESHOLDS.attributionMs && this.lastActionAt > this.lastCountedActionAt;
    const incorrectShown = page.errors.find((e) => INCORRECT_RE.test(e));
    const newIncorrect = newErrors.find((e) => INCORRECT_RE.test(e));
    if (attributable && incorrectShown) {
      this.incorrectAt.push(now);
      this.lastCountedActionAt = this.lastActionAt;
      this.lastErrorText = incorrectShown;
    } else if (newIncorrect && page.hasQuizUi) {
      this.incorrectAt.push(now);
      this.lastCountedActionAt = this.lastActionAt;
      this.lastErrorText = newIncorrect;
    } else if (attributable && newErrors.length) {
      this.validationAt.push(now);
      this.lastCountedActionAt = this.lastActionAt;
      this.lastErrorText = newErrors[0];
    } else if (newErrors.length) {
      this.lastErrorText = newErrors[0];
    }
    if (newSuccesses.length) {
      this.incorrectAt = [];
      this.validationAt = [];
      this.successSinceHint = true;
    }
    // A page model arriving shortly after a click means that click did something.
    const lastClick = this.clicks[this.clicks.length - 1];
    if (lastClick && lastClick.changed === undefined && now - lastClick.at < 2500 && (newErrors.length > 0 || newSuccesses.length > 0)) {
      lastClick.changed = true;
    }
    const corpus = `${page.title} ${page.headings.join(" ")} ${page.textSummary.slice(0, 400)}`;
    this.deadEnd = DEAD_END_RE.test(corpus) && page.elements.length < 40;
    return { newErrors, newSuccesses, problemChanged };
  }

  /**
   * Feed each step-judge verdict on the student's written working. A wrong step arms the signal
   * (keeping its first-seen time while the SAME step stays wrong, so escalation can grow with
   * persistence); a clean or newly-correct working disarms it.
   */
  recordWorkingJudgement(j: WorkingJudgement, now: number): void {
    if (!j.judged) return;
    if (j.firstWrongStep === null) {
      this.wrongStep = null;
      return;
    }
    const category = j.steps.find((s) => s.step === j.firstWrongStep)?.category ?? "unknown";
    if (this.wrongStep?.step !== j.firstWrongStep) this.wrongStep = { step: j.firstWrongStep, category, firstAt: now };
  }

  /** Called by the engine when it verified a click produced no DOM change. */
  markLastClickUnchanged(): void {
    const last = this.clicks[this.clicks.length - 1];
    if (last && last.changed === undefined) last.changed = false;
  }

  /** Resolves whether a specific click record produced a change (engine checks mutation counts). */
  resolveClick(rec: ClickRecord, changed: boolean): void {
    if (rec.changed === undefined) rec.changed = changed;
  }

  clearAfterHelp(): void {
    this.incorrectAt = [];
    this.validationAt = [];
    this.clicks = [];
    this.problemStartedAt = Date.now();
    // The wrong line is still on screen; keep the signal armed but restart the escalation clock.
    if (this.wrongStep) this.wrongStep = { ...this.wrongStep, firstAt: Date.now() };
  }

  get currentProblemKey(): string | null {
    return this.problem;
  }

  snapshot(now: number): StruggleSignals {
    const recentClicks = this.clicks.filter((c) => now - c.at <= THRESHOLDS.repeatedClickWindowMs);
    const byKey = new Map<string, ClickRecord[]>();
    for (const c of recentClicks) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
    let repeatedClicks = 0;
    let lastClickedName: string | undefined;
    let failedUiAction = false;
    for (const [, list] of byKey) {
      const unproductive = list.filter((c) => c.changed === false || c.disabled).length;
      if (list.length >= 2 && unproductive >= 2 && list.length > repeatedClicks) {
        repeatedClicks = list.length;
        lastClickedName = list[list.length - 1].name;
        failedUiAction = unproductive >= 2 && (list.some((c) => c.disabled) || unproductive >= 3);
      }
    }
    const rapidClicks = this.clicks.filter((c) => now - c.at <= THRESHOLDS.rapidWindowMs).length;
    const incorrectAttempts = this.incorrectAt.length;
    const validationErrors = this.validationAt.filter((t) => now - t <= 120_000).length;
    const recentUrls = this.urls.filter((u) => now - u.at <= THRESHOLDS.oscillationWindowMs).map((u) => u.url);
    let navigationOscillation = false;
    if (recentUrls.length >= 4) {
      const last4 = recentUrls.slice(-4);
      navigationOscillation = last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1];
    }
    const timeOnCurrentProblemMs = this.hasQuizUi && this.problemStartedAt ? now - this.problemStartedAt : 0;

    const summary: string[] = [];
    if (incorrectAttempts) summary.push(`${incorrectAttempts} incorrect attempt${incorrectAttempts > 1 ? "s" : ""} on the current problem`);
    if (validationErrors) summary.push(`${validationErrors} form validation error${validationErrors > 1 ? "s" : ""}`);
    if (repeatedClicks >= 2) summary.push(`clicked "${lastClickedName}" ${repeatedClicks}× without progress${failedUiAction ? " (control seems not to work / disabled)" : ""}`);
    if (rapidClicks >= THRESHOLDS.rapidClicksMin) summary.push(`${rapidClicks} clicks in the last 10s`);
    if (navigationOscillation) summary.push("bouncing back and forth between the same pages");
    if (this.deadEnd) summary.push("landed on an error / not-found page");
    if (timeOnCurrentProblemMs > THRESHOLDS.hesitationMs) summary.push(`on this problem for ${Math.round(timeOnCurrentProblemMs / 1000)}s`);
    const wrongStep = this.wrongStep ? { step: this.wrongStep.step, category: this.wrongStep.category, ageMs: now - this.wrongStep.firstAt } : undefined;
    if (wrongStep) summary.push(`step ${wrongStep.step} of their written working doesn't check out`);

    const strength = Math.min(
      1,
      (incorrectAttempts >= 3 ? 0.85 : incorrectAttempts >= THRESHOLDS.incorrectMin ? 0.75 : incorrectAttempts * 0.3) +
        (failedUiAction ? (repeatedClicks >= 3 ? 0.85 : 0.7) : repeatedClicks >= THRESHOLDS.repeatedClicksMin ? 0.55 : repeatedClicks * 0.15) +
        (validationErrors >= THRESHOLDS.validationMin ? 0.5 : validationErrors * 0.2) +
        (rapidClicks >= THRESHOLDS.rapidClicksMin ? 0.35 : 0) +
        (navigationOscillation ? 0.6 : 0) +
        (this.deadEnd ? 0.7 : 0) +
        (timeOnCurrentProblemMs > THRESHOLDS.hesitationMs ? 0.45 : 0) +
        // Graded escalation: a fresh wrong step earns a silent glance (level 2); one that
        // persists past the grace window earns the bubble (level 3).
        (wrongStep ? (wrongStep.ageMs >= THRESHOLDS.wrongStepBubbleMs ? 0.7 : 0.5) : 0),
    );

    return {
      repeatedClicks,
      validationErrors,
      incorrectAttempts,
      timeOnCurrentProblemMs,
      navigationOscillation,
      rapidClicks,
      deadEnd: this.deadEnd,
      failedUiAction,
      lastClickedName,
      lastErrorText: this.lastErrorText,
      wrongStep,
      summary,
      strength,
    };
  }

  reset(): void {
    this.clicks = [];
    this.incorrectAt = [];
    this.validationAt = [];
    this.knownErrors.clear();
    this.knownSuccesses.clear();
    this.deadEnd = false;
    this.problem = null;
    this.problemStartedAt = 0;
  }
}

export interface LevelContext {
  proactiveEnabled: boolean;
  cooldownUntil: number;
  declinedCount: number;
  lastDeclineAt: number;
  now: number;
}

/** Maps signal strength to an intervention intensity level 0..4 (see product spec §36). */
export function computeLevel(signals: StruggleSignals, ctx: LevelContext): 0 | 1 | 2 | 3 | 4 {
  if (!ctx.proactiveEnabled) return 0;
  const strong =
    signals.incorrectAttempts >= THRESHOLDS.incorrectMin ||
    signals.failedUiAction ||
    signals.deadEnd ||
    (signals.wrongStep !== undefined && signals.wrongStep.ageMs >= THRESHOLDS.wrongStepBubbleMs);
  let level: 0 | 1 | 2 | 3 | 4;
  if (signals.strength < 0.25) level = 0;
  else if (signals.strength < 0.45) level = 1;
  else if (signals.strength < 0.6) level = 2;
  else if (signals.strength < 0.8) level = 3;
  else level = 4;
  if (strong && level < 3) level = 3;
  // Cooldown: only silent visual cues are allowed while cooling down.
  if (ctx.now < ctx.cooldownUntil) level = Math.min(level, 1) as 0 | 1;
  // Recent declines lower the intensity: respect "I'm good".
  if (ctx.declinedCount > 0 && ctx.now - ctx.lastDeclineAt < THRESHOLDS.declineCooldownMs) level = Math.max(0, level - ctx.declinedCount) as 0 | 1 | 2 | 3 | 4;
  return level;
}
