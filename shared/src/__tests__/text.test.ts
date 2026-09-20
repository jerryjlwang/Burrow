import { describe, expect, it } from "vitest";
import { extractTarget, findBestElement, isAffirmative, isNegative, isStopCommand, scoreMatch } from "../text";
import type { PageElement } from "../types";

const el = (id: number, role: string, name: string, extra: Partial<PageElement> = {}): PageElement => ({ id, role, name, tag: "button", inViewport: true, rect: { x: 0, y: 0, width: 10, height: 10 }, ...extra });

describe("text matching", () => {
  it("extracts the target phrase from natural requests", () => {
    expect(extractTarget("Where is the sign in button?")).toBe("sign in");
    expect(extractTarget("can you click the submit button please")).toBe("submit");
    expect(extractTarget("Open Assignment 4")).toBe("assignment 4");
    expect(extractTarget("take me to the quiz")).toBe("quiz");
  });
  it("scores synonyms and partial matches", () => {
    expect(scoreMatch("sign in", "Log in")).toBeGreaterThan(0.6);
    expect(scoreMatch("assignment", "Open Assignment 4")).toBeGreaterThan(0.6);
    expect(scoreMatch("quiz", "Dashboard")).toBe(0);
  });
  it("finds the best element for a phrase", () => {
    const elements = [el(1, "link", "Dashboard"), el(2, "link", "Modules"), el(3, "button", "Sign in"), el(4, "link", "Open Assignment 4"), el(5, "link", "Take the quiz", { inViewport: false })];
    expect(findBestElement(elements, "sign in")?.id).toBe(3);
    expect(findBestElement(elements, "assignment")?.id).toBe(4);
    expect(findBestElement(elements, "quiz")?.id).toBe(5);
    expect(findBestElement(elements, "purple elephant")).toBeNull();
  });
  it("recognises yes / no / stop", () => {
    expect(isAffirmative("Yeah")).toBe(true);
    expect(isAffirmative("sure, go ahead")).toBe(true);
    expect(isAffirmative("yes but what is a derivative and why does it matter")).toBe(false);
    expect(isNegative("I'm good")).toBe(true);
    expect(isNegative("no thanks")).toBe(true);
    expect(isStopCommand("stop")).toBe(true);
    expect(isStopCommand("wait")).toBe(true);
    expect(isStopCommand("stop the quiz for me")).toBe(false);
  });
});
