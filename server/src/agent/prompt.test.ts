import { describe, expect, it } from "vitest";
import { formatDecisionContext, formatPage, formatVideoReference } from "./prompt";
import { emptySignals, emptyStudentState, type AgentInput, type PageElement, type PageSummary } from "@shared/types";

const el = (id: number, name: string, extra: Partial<PageElement> = {}): PageElement => ({ id, role: "button", name, tag: "button", inViewport: true, rect: { x: 100, y: 40, width: 80, height: 20 }, ...extra });

const page = (over: Partial<PageSummary> = {}): PageSummary => ({
  url: "https://example.com/lesson",
  title: "Lesson",
  headings: [],
  textSummary: "",
  elements: [],
  errors: [],
  successes: [],
  dialogs: [],
  forms: 0,
  landmarks: [],
  isPdf: false,
  hasQuizUi: false,
  scroll: { x: 0, y: 0, maxY: 0 },
  viewport: { width: 1440, height: 900 },
  capturedAt: 0,
  truncatedElements: 0,
  ...over,
});

describe("formatPage", () => {
  it("passes the page text through uncut", () => {
    const text = `${"lorem ipsum ".repeat(2000)}THE LAST LINE`;
    expect(formatPage(page({ textSummary: text }))).toContain("THE LAST LINE");
  });
  it("gives on-screen elements a click point and tells the model the viewport size", () => {
    const out = formatPage(page({ elements: [el(1, "Play"), el(2, "Footer link", { inViewport: false, rect: { x: 0, y: 2400, width: 50, height: 10 } })] }));
    expect(out).toContain('[1] button "Play" @140,50');
    expect(out).toMatch(/\[2\] button "Footer link" \[below viewport\]$/m);
    expect(out).toContain("viewport 1440x900 CSS px");
  });
  it("lists every element the extractor sent", () => {
    const out = formatPage(page({ elements: Array.from({ length: 300 }, (_, i) => el(i + 1, `b${i + 1}`)) }));
    expect(out).toContain('[300] button "b300"');
    expect(out).not.toContain("more not shown");
  });
});

describe("the video in the prompt", () => {
  const video = { t: 95, duration: 600, paused: true, heard: "so the three moves across", transcript: "[0:00] intro\n[9:30] the answer is x equals four", understanding: "[0:00] Sets up the equation.", behaviour: [], hasTranscript: true };
  const input = (over: Partial<typeof video> = {}): AgentInput => ({ utterance: "where does he finish?", goal: "where does he finish?", conversation: [], page: page(), history: [], signals: emptySignals(), student: emptyStudentState(), pendingOffer: null, lastReferencedElementId: null, step: 0, maxSteps: 6, video: { ...video, ...over } });

  it("carries the whole video as its own part, identical wherever the student is, so it caches", () => {
    const ref = formatVideoReference(input());
    expect(ref).toContain("[9:30] the answer is x equals four");
    expect(ref).toContain("Sets up the equation.");
    expect(formatVideoReference(input({ t: 400, heard: "later words", paused: false }))).toBe(ref);
  });

  it("keeps position and what was just said in the per-step context, and sends no reference without a transcript", () => {
    const context = formatDecisionContext(input());
    expect(context).toContain("the student is at 1:35 of 10:00, paused");
    expect(context).toContain("so the three moves across");
    expect(context).not.toContain("x equals four");
    expect(formatVideoReference(input({ hasTranscript: false, transcript: "" }))).toBeNull();
  });
});
