import { describe, expect, it } from "vitest";
import { decideMock, interveneMock, pickLookupResult } from "../mock-agent";
import { emptySignals, emptyStudentState, type AgentInput, type PageSummary, type PageElement } from "../types";
import { validateDecision } from "../validate";

const el = (id: number, role: string, name: string, extra: Partial<PageElement> = {}): PageElement => ({ id, role, name, tag: role === "link" ? "a" : "button", inViewport: true, rect: { x: 0, y: 0, width: 10, height: 10 }, ...extra });

const page: PageSummary = {
  url: "http://localhost:8787/demo/algebra.html",
  title: "Practice: Linear Equations",
  headings: ["Practice: Linear Equations", "Question 1 of 2"],
  textSummary: "Solve for x:\n3x + 5 = 20\nWhatever you do to one side of an equation, do to the other side too.",
  elements: [el(1, "link", "Dashboard"), el(2, "link", "Sign in"), el(3, "textbox", "Your answer", { placeholder: "x = ?" }), el(4, "button", "Check answer"), el(5, "link", "Take the quiz", { inViewport: false })],
  errors: [],
  successes: [],
  dialogs: [],
  forms: 0,
  landmarks: ["main"],
  isPdf: false,
  hasQuizUi: true,
  scroll: { x: 0, y: 0, maxY: 800 },
  viewport: { width: 1200, height: 800 },
  capturedAt: Date.now(),
  truncatedElements: 0,
};

function input(utterance: string, extra: Partial<AgentInput> = {}): AgentInput {
  return { utterance, goal: utterance, conversation: [], page, history: [], signals: emptySignals(), student: emptyStudentState(), pendingOffer: null, lastReferencedElementId: null, step: 0, maxSteps: 6, ...extra };
}

describe("mock agent: the visible surface", () => {
  it("hovers, double-clicks and right-clicks a named element", () => {
    for (const [said, action] of [["hover over the dashboard", "hover"], ["Double-click the dashboard", "double_click"], ["right click on Dashboard", "right_click"]] as const) {
      const dec = decideMock(input(said));
      expect(dec.action, said).toBe(action);
      expect(dec.elementId, said).toBe(1);
      expect(validateDecision(dec).ok, said).toBe(true);
    }
  });
  it("drags one named element onto another", () => {
    const dec = decideMock(input("drag the dashboard to sign in"));
    expect(dec).toMatchObject({ action: "drag", elementId: 1, toElementId: 2 });
    expect(validateDecision(dec).ok).toBe(true);
  });
  it("aims at spoken coordinates", () => {
    expect(decideMock(input("click at 300, 200"))).toMatchObject({ action: "click", x: 300, y: 200, elementId: null });
    const drag = decideMock(input("drag from 100, 400 to 380, 400"));
    expect(drag).toMatchObject({ action: "drag", x: 100, y: 400, toX: 380, toY: 400 });
    expect(validateDecision(drag).ok).toBe(true);
  });
  it("presses a named key rather than hunting for a button called that", () => {
    expect(decideMock(input("press escape"))).toMatchObject({ action: "press_key", text: "escape" });
    const arrow = decideMock(input("hit the arrow down"));
    expect(arrow).toMatchObject({ action: "press_key", text: "down" });
    expect(validateDecision(arrow).ok).toBe(true);
  });
});

describe("mock agent", () => {
  it("points at the element the student asks for", () => {
    const d = decideMock(input("Where is the sign in button?"));
    expect(d.action).toBe("point_to");
    expect(d.elementId).toBe(2);
    expect(d.done).toBe(true);
    expect(validateDecision(d).ok).toBe(true);
  });
  it("clicks the last referenced element on 'click it'", () => {
    const d = decideMock(input("Click it", { lastReferencedElementId: 2 }));
    expect(d.action).toBe("click");
    expect(d.elementId).toBe(2);
  });
  it("navigates via links for 'take me to the quiz'", () => {
    const d = decideMock(input("Take me to the quiz"));
    expect(d.action).toBe("click");
    expect(d.elementId).toBe(5);
  });
  it("summarises the page", () => {
    const d = decideMock(input("What's on this page?"));
    expect(d.action).toBe("explain");
    expect(d.say).toMatch(/Practice: Linear Equations/);
  });
  it("gives a teaching hint that does not reveal the answer", () => {
    const d = decideMock(input("Give me a hint"));
    expect(d.action).toBe("point_to");
    expect(d.elementId).toBe(3);
    expect(d.say).toMatch(/both sides/i);
    expect(d.say).not.toMatch(/\b5\b.*\bx\s*=\s*5|x = 5/);
  });
  it("escalates hints based on the student model", () => {
    const later = decideMock(input("hint", { student: { ...emptyStudentState(), hintsForCurrentProblem: 2 } }));
    expect(later.say).toMatch(/3x = 15|undoes multiplying/);
  });
  it("coaches instead of answering when asked for the answer", () => {
    const d = decideMock(input("Just tell me the answer"));
    expect(d.say).toMatch(/help you get there/i);
    expect(d.taskType).toBe("assessment");
  });
  it("turns an accepted offer into a hint pointing at the answer box", () => {
    const d = decideMock(input("Yeah", { pendingOffer: { type: "hint", message: "Want a hint?", elementId: 3, at: Date.now() } }));
    expect(d.action).toBe("point_to");
    expect(d.elementId).toBe(3);
    expect(d.say).toMatch(/5/);
  });
  it("respects a decline", () => {
    const d = decideMock(input("I'm good", { pendingOffer: { type: "hint", message: "Want a hint?", elementId: 3, at: Date.now() } }));
    expect(d.action).toBe("finish");
  });
  it("types into a named field", () => {
    const d = decideMock(input("type 5 into your answer"));
    expect(d.action).toBe("type");
    expect(d.elementId).toBe(3);
    expect(d.text).toBe("5");
  });
  it("refuses to type into sensitive fields", () => {
    const p = { ...page, elements: [...page.elements, el(9, "textbox", "Password", { sensitive: true })] };
    const d = decideMock(input("type hunter2 into password", { page: p }));
    expect(d.action).not.toBe("type");
    expect(d.say).toMatch(/private/i);
  });
  it("finishes after a click that navigated", () => {
    const d = decideMock(input("open it", { step: 1, resumedAfterNavigation: true, history: [{ step: 0, decision: { ...decideMock(input("click it", { lastReferencedElementId: 2 })) }, result: { ok: true, message: "clicked", urlChanged: true }, at: Date.now() }] }));
    expect(d.action).toBe("finish");
    expect(d.say).toMatch(/open/i);
  });
});

describe("mock intervention", () => {
  it("offers a hint after repeated incorrect attempts", () => {
    const d = interveneMock({ page, signals: { ...emptySignals(), incorrectAttempts: 2, summary: ["2 incorrect attempts"], strength: 0.75 }, student: emptyStudentState(), conversation: [], level: 3 });
    expect(d.intervene).toBe(true);
    expect(d.type).toBe("hint");
    expect(d.message).toMatch(/hint/i);
    expect(d.elementId).toBe(3);
  });
  it("points at unanswered options when a disabled button is hammered", () => {
    const p = { ...page, elements: [el(10, "radio", "Add 3 to both sides", { checked: false, context: "Question 1" }), el(11, "button", "Continue", { disabled: true })] };
    const d = interveneMock({ page: p, signals: { ...emptySignals(), repeatedClicks: 3, failedUiAction: true, lastClickedName: "Continue", summary: [], strength: 0.85 }, student: emptyStudentState(), conversation: [], level: 4 });
    expect(d.intervene).toBe(true);
    expect(d.elementId).toBe(10);
    expect(d.message).toMatch(/unlocks/);
  });
  it("stays quiet without signals", () => {
    const d = interveneMock({ page, signals: emptySignals(), student: emptyStudentState(), conversation: [], level: 0 });
    expect(d.intervene).toBe(false);
  });
});

describe("path playbook and learning plans", () => {
  const RESULTS = [
    '1. [article] Axial tilt (Wikipedia) — https://en.wikipedia.org/wiki/Axial_tilt — the angle',
    '2. [lesson] Khan Academy search for "axial tilt" — https://www.khanacademy.org/search?page_search_query=axial%20tilt',
    '3. [video] YouTube search for "axial tilt" — https://www.youtube.com/results?search_query=axial%20tilt',
  ].join("\n");

  it("pickLookupResult honours the preferred modality and falls back to the first", () => {
    expect(pickLookupResult(RESULTS, "video")?.url).toContain("youtube.com");
    expect(pickLookupResult(RESULTS, "practice")?.url).toContain("wikipedia.org");
    expect(pickLookupResult("No results for \"x\".")).toBeNull();
  });

  it("runs look_up → open_tab for a resource-backed path suggestion, then stops", () => {
    const path = { kind: "reconcile", conceptLabel: "Axial tilt", query: "Axial tilt explained", prefer: "video" };
    const base = { ...input("Yes please"), path };
    const first = decideMock(base);
    expect(first).toMatchObject({ action: "look_up", text: "Axial tilt explained", done: false });
    const looked = { step: 0, decision: first, result: { ok: true, message: "ok" }, at: 0 };
    const second = decideMock({ ...base, step: 1, history: [looked], lookupResults: RESULTS });
    expect(second.action).toBe("open_tab");
    expect(second.url).toContain("youtube.com");
    const opened = { step: 1, decision: second, result: { ok: true, message: "ok" }, at: 0 };
    expect(decideMock({ ...base, step: 2, history: [looked, opened], resumedAfterNavigation: true }).action).toBe("finish");
  });

  it("turns 'I want to learn about X' into make_plan, without hijacking help requests", () => {
    expect(decideMock(input("I want to learn more about geology"))).toMatchObject({ action: "make_plan", text: "geology" });
    expect(decideMock(input("teach me about volcanoes"))).toMatchObject({ action: "make_plan", text: "volcanoes" });
    expect(decideMock(input("help me, I'm stuck")).action).not.toBe("make_plan");
  });
});

describe("asking about plans", () => {
  it("opens the plan map instead of reciting, for the ways a kid might ask", () => {
    for (const q of ["what's my plan?", "what are my plans", "show me our plan", "what's next in my plan?", "where am I in the plan", "what are the steps"]) {
      expect(decideMock(input(q)), q).toMatchObject({ action: "show_plan", done: true });
    }
    expect(validateDecision(decideMock(input("what's my plan?"))).ok).toBe(true);
  });

  it("does not hijack unrelated requests", () => {
    expect(decideMock(input("where is the sign in button")).action).not.toBe("show_plan");
    expect(decideMock(input("give me a hint")).action).not.toBe("show_plan");
  });
});

describe("watching a video", () => {
  const video = { t: 22, duration: 48, paused: false, heard: "An equation is like a balance scale. Whatever you do to one side, you must do to the other side too.", understanding: "", behaviour: [], hasTranscript: true };

  it("answers from what was just said instead of asking to look at the frame", () => {
    const dec = decideMock(input("what did he just mean", { video }));
    expect(validateDecision(dec).ok).toBe(true);
    expect(dec.action).toBe("speak");
    expect(dec.say).toContain("Whatever you do to one side");
    expect(dec.say).not.toMatch(/analy|look|frame|screenshot/i);
  });

  it("is honest when the video has no transcript, and stays out of the way of page requests", () => {
    expect(decideMock(input("can you explain that", { video: { ...video, heard: "", hasTranscript: false } })).say).toMatch(/can't hear/);
    expect(decideMock(input("where is the sign in button", { video })).action).not.toBe("speak");
  });
});

describe("region reading (observe with a target)", () => {
  it("observes with a quote first, then answers from the full readout", () => {
    const first = decideMock(input("What does the description say?"));
    expect(first).toMatchObject({ action: "observe", quote: "description", done: false });
    expect(validateDecision(first).ok).toBe(true);

    const readout = `region containing "description":\nThis assignment closes the unit. ${"More context. ".repeat(30)}Spotting it earns a golden ratio bonus.`;
    const second = decideMock(input("What does the description say?", { step: 1, history: [{ step: 0, decision: first, result: { ok: true, message: "read" }, at: 0 }], readout }));
    expect(second.action).toBe("explain");
    expect(second.done).toBe(true);
    expect(second.text).toMatch(/golden ratio bonus/);
    expect(second.text).not.toMatch(/region containing/); // label line stripped
  });

  it("gives up honestly when the region was not found", () => {
    const first = decideMock(input("read the fine print"));
    expect(first).toMatchObject({ action: "observe", quote: "fine print" });
    const second = decideMock(input("read the fine print", { step: 1, history: [{ step: 0, decision: first, result: { ok: false, message: "not found" }, at: 0 }] }));
    expect(second.action).toBe("speak");
    expect(second.done).toBe(true);
  });

  it("does not hijack page summaries or clicks", () => {
    expect(decideMock(input("What's on this page?")).action).toBe("explain");
    expect(decideMock(input("click the check answer button")).action).toBe("click");
  });
});
