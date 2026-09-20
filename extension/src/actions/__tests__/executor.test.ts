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
    switchTab: vi.fn(async () => undefined),
    lookup: vi.fn(async () => ""),
    makePlan: vi.fn(async () => null),
    sketch: vi.fn(() => undefined),
    showPlan: vi.fn(() => true),
    input: vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
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
  describe("the visible surface", () => {
    /** jsdom has no layout: say what sits under every point. */
    const under = (el: Element | null) => {
      document.elementFromPoint = () => el;
    };

    it("clicks a raw point with trusted input, without touching the DOM itself", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      const canvas = document.getElementById("c")!;
      under(canvas);
      const seen: string[] = [];
      canvas.addEventListener("click", () => seen.push("click"));
      const r = await executeAction(d({ action: "click", x: 300, y: 200 }), deps);
      expect(r.ok, r.message).toBe(true);
      expect(deps.input).toHaveBeenCalledWith([{ kind: "click", x: 300, y: 200, button: "left", count: 1 }]);
      expect(seen).toEqual([]);
      expect(r.message).toContain("(300, 200)");
    });
    it("falls back to DOM events at the exact point when trusted input is unavailable, and says so", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      const canvas = document.getElementById("c")!;
      under(canvas);
      deps.input.mockResolvedValue({ ok: false, error: "Cannot access a chrome:// URL" });
      const at: number[] = [];
      canvas.addEventListener("mousedown", (e) => at.push(e.clientX, e.clientY));
      const r = await executeAction(d({ action: "click", x: 300, y: 200 }), deps);
      expect(r.ok).toBe(true);
      expect(at).toEqual([300, 200]);
      expect(r.message).toContain("untrusted");
    });
    it("maps double_click, right_click and hover onto the right input ops", async () => {
      const { page, deps } = setup(`<button>Menu</button>`);
      const id = page.elements[0].id;
      await executeAction(d({ action: "double_click", elementId: id }), deps);
      await executeAction(d({ action: "right_click", elementId: id }), deps);
      await executeAction(d({ action: "hover", elementId: id }), deps);
      expect(deps.input.mock.calls.map((c) => (c as unknown as [{ kind: string; button?: string; count?: number }[]])[0][0])).toMatchObject([
        { kind: "click", button: "left", count: 2 },
        { kind: "click", button: "right", count: 1 },
        { kind: "move" },
      ]);
    });
    it("hover fallback fires the enter/over events a JS hover menu listens for", async () => {
      const { page, deps } = setup(`<button id="m">Menu</button>`);
      deps.input.mockResolvedValue({ ok: false });
      const seen: string[] = [];
      for (const t of ["mouseenter", "mouseover"]) document.getElementById("m")!.addEventListener(t, () => seen.push(t));
      const r = await executeAction(d({ action: "hover", elementId: page.elements[0].id }), deps);
      expect(r.ok).toBe(true);
      expect(seen.sort()).toEqual(["mouseenter", "mouseover"]);
    });
    it("refuses points outside the viewport and points on its own UI", async () => {
      const { deps } = setup(`<div id="pip-companion-host"><span id="inner"></span></div>`);
      const off = await executeAction(d({ action: "click", x: 5000, y: 10 }), deps);
      expect(off.ok).toBe(false);
      expect(off.message).toContain("outside the visible page");
      under(document.getElementById("inner"));
      const self = await executeAction(d({ action: "click", x: 10, y: 10 }), deps);
      expect(self.ok).toBe(false);
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("drags between two points, and needs both ends on screen", async () => {
      const { deps } = setup(`<div id="s"></div>`);
      under(document.getElementById("s"));
      const r = await executeAction(d({ action: "drag", x: 100, y: 100, toX: 400, toY: 120 }), deps);
      expect(r.ok, r.message).toBe(true);
      expect(deps.input).toHaveBeenCalledWith([{ kind: "drag", x: 100, y: 100, toX: 400, toY: 120 }]);
      const off = await executeAction(d({ action: "drag", x: 100, y: 100, toX: 400, toY: 9000 }), deps);
      expect(off.ok).toBe(false);
    });
    it("presses a key chord, focusing the named element first", async () => {
      const { page, deps } = setup(`<input id="q" aria-label="Search">`);
      const r = await executeAction(d({ action: "press_key", elementId: page.elements[0].id, text: "Control+a" }), deps);
      expect(r.ok).toBe(true);
      expect(document.activeElement?.id).toBe("q");
      expect(deps.input).toHaveBeenCalledWith([{ kind: "key", chord: expect.objectContaining({ key: "a", ctrl: true, text: null }) }]);
    });
    it("key fallback reaches the focused element's listeners", async () => {
      const { deps } = setup(`<input id="q" aria-label="Search">`);
      deps.input.mockResolvedValue({ ok: false });
      const q = document.getElementById("q")!;
      q.focus();
      const keys: string[] = [];
      q.addEventListener("keydown", (e) => keys.push(e.key));
      await executeAction(d({ action: "press_key", text: "Escape" }), deps);
      expect(keys).toEqual(["Escape"]);
    });
    it("types at the focus, but never into a focused password field", async () => {
      const { deps } = setup(`<input id="a" aria-label="Cell"><input id="p" type="password" aria-label="Password">`);
      const none = await executeAction(d({ action: "type", text: "hi" }), deps);
      expect(none.ok).toBe(false);
      document.getElementById("a")!.focus();
      const ok = await executeAction(d({ action: "type", text: "y = 2x" }), deps);
      expect(ok.ok).toBe(true);
      expect(deps.input).toHaveBeenLastCalledWith([{ kind: "text", text: "y = 2x" }]);
      deps.input.mockClear();
      document.getElementById("p")!.focus();
      const secret = await executeAction(d({ action: "type", text: "hunter2" }), deps);
      expect(secret.ok).toBe(false);
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("wheels over a point instead of scrolling the page", async () => {
      const { deps } = setup(`<div id="map"></div>`);
      under(document.getElementById("map"));
      const r = await executeAction(d({ action: "scroll", direction: "down", amount: 300, x: 50, y: 60 }), deps);
      expect(r.ok).toBe(true);
      expect(deps.input).toHaveBeenCalledWith([{ kind: "wheel", x: 50, y: 60, deltaY: 300 }]);
    });
  });
  it("types into contenteditable", () => {
    document.body.innerHTML = `<div contenteditable="true" id="ce">hi</div>`;
    const el = document.getElementById("ce")!;
    typeInto(el, "hello");
    expect(el.textContent).toBe("hello");
  });
});
