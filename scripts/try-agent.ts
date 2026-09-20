/**
 * Exercise the configured agent provider against the demo scenarios without a browser.
 *   npx tsx scripts/try-agent.ts                 # runs the built-in scenario set
 *   npx tsx scripts/try-agent.ts "open the quiz" # one custom utterance on the dashboard page
 * Uses .env (LLM_MODEL / LLM_EFFORT overridable via env vars).
 */
import { loadConfig } from "../server/src/config";
import { AgentService } from "../server/src/api/agent";
import { emptySignals, emptyStudentState, type AgentInput, type PageElement, type PageSummary } from "../shared/src/types";

const el = (id: number, role: string, name: string, extra: Partial<PageElement> = {}): PageElement => ({ id, role, name, tag: role === "link" ? "a" : role === "textbox" ? "input" : "button", inViewport: true, rect: { x: 0, y: 0, width: 100, height: 30 }, ...extra });

const dashboard: PageSummary = {
  url: "http://localhost:8787/demo/index.html",
  title: "Dashboard · Riverside Learning",
  headings: ["Welcome back, Sam", "Up next", "This week", "Ready to be assessed?", "Announcements"],
  textSummary: "Algebra I · Period 3 · Ms. Alvarez\nModule 3 Linear Equations. Balancing equations, isolating the variable, and checking your answer.\nDue Friday Assignment 4: Solving Linear Equations. Practice set with instant feedback. Complete all problems, then submit.\nOffice hours moved. Thursday office hours are now 3:30–4:15 in room 204.\nModule 3 Quiz 5 questions · 15 minutes · one attempt",
  elements: [el(1, "link", "Riverside Learning"), el(2, "link", "Dashboard", { current: true }), el(3, "link", "Modules"), el(4, "link", "Assignments"), el(5, "link", "Grades"), el(6, "link", "Sign in"), el(7, "link", "Continue module", { context: "Up next" }), el(8, "link", "Open Assignment 4", { context: "Up next" }), el(9, "link", "Read more"), el(10, "link", "Practice", { context: "This week" }), el(11, "link", "Open", { context: "This week" }), el(12, "link", "Take the quiz", { context: "Ready to be assessed?", inViewport: false, rect: { x: 0, y: 1400, width: 100, height: 30 } })],
  errors: [], successes: [], dialogs: [], forms: 0, landmarks: ["banner", "navigation: Main", "main", "contentinfo"], isPdf: false, hasQuizUi: false,
  scroll: { x: 0, y: 0, maxY: 900 }, viewport: { width: 1280, height: 800 }, capturedAt: Date.now(), truncatedElements: 0,
};

const algebra: PageSummary = {
  url: "http://localhost:8787/demo/algebra.html",
  title: "Practice: Linear Equations · Riverside Learning",
  headings: ["Practice: Linear Equations", "Question 1 of 2", "Reminder"],
  textSummary: "Module 3 · Practice\nSolve for x. Type just the number.\nSolve for x:\n3x + 5 = 20\nNot quite — try again.\nAttempts: 2\nWhatever you do to one side of an equation, do to the other side too.",
  elements: [el(1, "link", "Dashboard"), el(2, "link", "Modules", { current: true }), el(3, "link", "Sign in"), el(4, "textbox", "Your answer", { placeholder: "x = ?", value: "7", context: "Question 1 of 2" }), el(5, "button", "Check answer", { context: "Question 1 of 2" })],
  errors: ["Not quite — try again."], successes: [], dialogs: [], forms: 0, landmarks: ["main"], isPdf: false, hasQuizUi: true,
  scroll: { x: 0, y: 0, maxY: 400 }, viewport: { width: 1280, height: 800 }, capturedAt: Date.now(), truncatedElements: 0,
};

function input(utterance: string, page: PageSummary, extra: Partial<AgentInput> = {}): AgentInput {
  return { utterance, goal: utterance, conversation: [], page, history: [], signals: emptySignals(), student: emptyStudentState(), pendingOffer: null, lastReferencedElementId: null, step: 0, maxSteps: 6, ...extra };
}

const cfg = loadConfig();
const service = new AgentService(cfg);
console.log(`provider: ${service.providerName} · effort: ${cfg.llmEffort}\n`);

const custom = process.argv.slice(2).join(" ").trim();
const scenarios: Array<{ label: string; run: () => Promise<unknown> }> = custom
  ? [{ label: custom, run: () => service.decide(input(custom, dashboard)) }]
  : [
      { label: "Where is the sign in button?", run: () => service.decide(input("Where is the sign in button?", dashboard)) },
      { label: "Click it (after pointing at Sign in)", run: () => service.decide(input("Click it", dashboard, { lastReferencedElementId: 6, conversation: [{ role: "user", text: "Where is the sign in button?", at: 1 }, { role: "companion", text: "Right here—this link.", at: 2 }] })) },
      { label: "Take me to the quiz", run: () => service.decide(input("Take me to the quiz", dashboard)) },
      { label: "What's on this page?", run: () => service.decide(input("What's on this page?", dashboard)) },
      { label: "Yeah (accepting a hint offer, 2 wrong attempts)", run: () => service.decide(input("Yeah", algebra, { goal: "The student accepted your offer of help. Give ONE small, teaching hint about the current problem (do not reveal the final answer) and point to the relevant part of the page.", pendingOffer: { type: "hint", message: "Looks like this one's being stubborn. Want a hint?", elementId: 4, at: Date.now() }, signals: { ...emptySignals(), incorrectAttempts: 2, summary: ["2 incorrect attempts on the current problem"], strength: 0.75 } })) },
      { label: "Just tell me the answer", run: () => service.decide(input("Just tell me the answer", algebra, { student: { ...emptyStudentState(), hintsForCurrentProblem: 1 } })) },
      { label: "intervene: 2 incorrect attempts", run: () => service.intervene({ page: algebra, signals: { ...emptySignals(), incorrectAttempts: 2, summary: ["2 incorrect attempts on the current problem"], strength: 0.75 }, student: emptyStudentState(), conversation: [], level: 3 }) },
    ];

for (const s of scenarios) {
  const t0 = Date.now();
  try {
    const out = (await s.run()) as { decision: Record<string, unknown>; provider: string; degraded: boolean };
    const d = out.decision;
    const brief = "action" in d ? `${d.action}${d.elementId != null ? ` #${d.elementId}` : ""} done=${d.done} say=${JSON.stringify(d.say)}${d.text ? ` text=${JSON.stringify(String(d.text).slice(0, 80))}` : ""}` : `intervene=${d.intervene} type=${d.type} #${d.elementId} msg=${JSON.stringify(d.message)}`;
    console.log(`▶ ${s.label}\n   ${brief}\n   [${out.provider}${out.degraded ? " DEGRADED" : ""} · ${Date.now() - t0}ms · ${d.reason}]\n`);
  } catch (e) {
    console.log(`▶ ${s.label}\n   ERROR ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
