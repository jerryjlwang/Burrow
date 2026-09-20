import { describe, expect, it } from "vitest";
import { classifyTask, isForbidden, requiresConfirmation } from "../policy";
import type { PageElement } from "@shared/types";
import { DECISION_DEFAULTS, type AgentDecision } from "@shared/actions";

const el = (name: string, extra: Partial<PageElement> = {}): PageElement => ({ id: 1, role: "button", name, tag: "button", inViewport: true, rect: { x: 0, y: 0, width: 1, height: 1 }, ...extra });
const click = (elementId = 1): AgentDecision => ({ ...DECISION_DEFAULTS, action: "click", elementId, reason: "t" });
const type = (text: string): AgentDecision => ({ ...DECISION_DEFAULTS, action: "type", elementId: 1, text, reason: "t" });

describe("requiresConfirmation", () => {
  it("requires confirmation for submitting work, sending, purchases and deletes", () => {
    for (const name of ["Submit assignment", "Submit quiz", "Turn in", "Send message", "Buy now", "Checkout", "Delete account", "Publish post", "Sign out"]) {
      expect(requiresConfirmation(click(), { element: el(name) }).required, name).toBe(true);
    }
  });
  it("does not require confirmation for ordinary navigation or checking an answer", () => {
    for (const name of ["Modules", "Open Assignment 4", "Check answer", "Next problem", "Save draft", "Search", "Continue", "Cancel"]) {
      expect(requiresConfirmation(click(), { element: el(name) }).required, name).toBe(false);
    }
  });
  it("treats input[type=submit] as consequential", () => {
    expect(requiresConfirmation(click(), { element: el("Go", { tag: "input", inputType: "submit" }) }).required).toBe(true);
  });
  it("produces a human message", () => {
    const v = requiresConfirmation(click(), { element: el("Submit quiz") });
    expect(v.message).toMatch(/submit your work/i);
  });
});

describe("isForbidden", () => {
  it("never types into sensitive fields", () => {
    expect(isForbidden(type("hunter2"), { element: el("Password", { role: "textbox", sensitive: true }) }).forbidden).toBe(true);
  });
  it("never types card-like numbers", () => {
    expect(isForbidden(type("4111 1111 1111 1111"), { element: el("Card", { role: "textbox" }) }).forbidden).toBe(true);
  });
  it("blocks credential typing requested by voice", () => {
    expect(isForbidden(type("abc"), { element: el("Field", { role: "textbox" }), utterance: "type my password" }).forbidden).toBe(true);
  });
  it("allows ordinary typing", () => {
    expect(isForbidden(type("Sam"), { element: el("First name", { role: "textbox" }) }).forbidden).toBe(false);
  });
});

describe("classifyTask", () => {
  it("classifies common requests", () => {
    expect(classifyTask("Where is my assignment?")).toBe("navigation");
    expect(classifyTask("What's on this page?")).toBe("accessibility");
    expect(classifyTask("How do I solve this derivative?")).toBe("learning");
    expect(classifyTask("Answer question five on my quiz")).toBe("assessment");
    expect(classifyTask("Type my name into this field")).toBe("administrative");
  });
});
