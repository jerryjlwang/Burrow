// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { executeAction, typeInto } from "../executor";
import { ElementRegistry } from "../../page-understanding/registry";
import { extractPage } from "../../page-understanding/extract";
import { DECISION_DEFAULTS, type AgentDecision } from "@shared/actions";

function setup(html: string) {
  document.body.innerHTML = html;
  const registry = new ElementRegistry();
  const rescan = () => extractPage(document, { registry, skipLayout: true });
  const page = rescan();
  const overlay = {
    highlight: vi.fn(() => true),
    pointAt: vi.fn(async () => true),
    scrollIntoViewIfNeeded: vi.fn(async () => false),
    clear: vi.fn(),
  };
  const deps = {
    registry,
    overlay: overlay as unknown as import("../overlay").OverlayController,
    rescan,
    waitForChange: async () => ({ changed: true, urlChanged: false }),
    navigate: vi.fn(async () => undefined),
    openTab: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
  };
  return { page, deps, overlay };
}

const d = (partial: Partial<AgentDecision> & Pick<AgentDecision, "action">): AgentDecision => ({ ...DECISION_DEFAULTS, reason: "t", ...partial });

describe("executor", () => {
  it("clicks a button with a realistic event sequence", async () => {
    const { page, deps } = setup(`<button id="b">Go</button>`);
    const seen: string[] = [];
    document.getElementById("b")!.addEventListener("pointerdown", () => seen.push("pointerdown"));
    document.getElementById("b")!.addEventListener("click", () => seen.push("click"));
    const r = await executeAction(d({ action: "click", elementId: page.elements[0].id }), deps);
    expect(r.ok, r.message).toBe(true);
    expect(seen).toEqual(["pointerdown", "click"]);
  });
  it("refuses to click disabled controls and reports missing elements", async () => {
    const { page, deps } = setup(`<button disabled>Nope</button>`);
    const r = await executeAction(d({ action: "click", elementId: page.elements[0].id }), deps);
    expect(r.ok).toBe(false);
    const gone = await executeAction(d({ action: "click", elementId: 999 }), deps);
    expect(gone.ok).toBe(false);
    expect(gone.elementFound).toBe(false);
  });
  it("types into inputs in a framework-compatible way", async () => {
    const { page, deps } = setup(`<label for="a">Answer</label><input id="a" value="old" />`);
    const input = document.getElementById("a") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    const r = await executeAction(d({ action: "type", elementId: page.elements[0].id, text: "5" }), deps);
    expect(r.ok).toBe(true);
    expect(input.value).toBe("5");
    expect(events).toContain("input");
    expect(events).toContain("change");
  });
  it("never types into password fields", async () => {
    const { page, deps } = setup(`<input type="password" aria-label="Password" />`);
    const r = await executeAction(d({ action: "type", elementId: page.elements[0].id, text: "x" }), deps);
    expect(r.ok).toBe(false);
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
  });
  it("selects options by label", async () => {
    const { page, deps } = setup(`<label for="s">Period</label><select id="s"><option>One</option><option>Two</option></select>`);
    const r = await executeAction(d({ action: "select", elementId: page.elements[0].id, value: "two" }), deps);
    expect(r.ok).toBe(true);
    expect((document.getElementById("s") as HTMLSelectElement).value).toBe("Two");
  });
  it("types into contenteditable", () => {
    document.body.innerHTML = `<div contenteditable="true" id="ce">hi</div>`;
    const el = document.getElementById("ce")!;
    typeInto(el, "hello");
    expect(el.textContent).toBe("hello");
  });
});
