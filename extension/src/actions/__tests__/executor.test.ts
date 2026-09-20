// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { executeAction, typeInto } from "../executor";
import { isOwnKey } from "../surface";
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
    trustedInputEnabled: vi.fn(() => false),
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
    /** A page that does not visibly react, which is when escalation is on the table. */
    const still = (deps: ReturnType<typeof setup>["deps"]) => {
      deps.waitForChange = async () => ({ changed: false, urlChanged: false });
    };

    it("clicks a raw point with page events at that exact spot, and never opens a debugger session unasked", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      const canvas = document.getElementById("c")!;
      under(canvas);
      const at: number[] = [];
      canvas.addEventListener("mousedown", (e) => at.push(e.clientX, e.clientY));
      const r = await executeAction(d({ action: "click", x: 300, y: 200 }), deps);
      expect(r.ok, r.message).toBe(true);
      expect(at).toEqual([300, 200]);
      expect(deps.input).not.toHaveBeenCalled();
      expect(r.message).toContain("(300, 200)");
    });
    it("an aimed click carries its point on the click event itself, not just on mousedown", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      const canvas = document.getElementById("c")!;
      under(canvas);
      const at: number[] = [];
      canvas.addEventListener("click", (e) => at.push(e.clientX, e.clientY));
      await executeAction(d({ action: "click", x: 300, y: 200 }), deps);
      expect(at).toEqual([300, 200]);
    });
    it("tells the model how to escalate only when a page-event action did not take", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      under(document.getElementById("c"));
      const took = await executeAction(d({ action: "click", x: 300, y: 200 }), deps);
      expect(took.message).not.toContain("trusted");
      still(deps);
      const missed = await executeAction(d({ action: "click", x: 300, y: 200 }), deps);
      expect(missed.message).toContain("trusted:true");
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("uses real input when the model asks for it and the student has switched it on", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      const canvas = document.getElementById("c")!;
      under(canvas);
      const seen: string[] = [];
      canvas.addEventListener("mousedown", () => seen.push("mousedown"));
      const r = await executeAction(d({ action: "click", x: 300, y: 200, trusted: true }), deps);
      expect(deps.input).toHaveBeenCalledWith([{ kind: "click", x: 300, y: 200, button: "left", count: 1 }]);
      expect(seen).toEqual([]);
      expect(r.message).toContain("real input");
    });
    it("stays on page events when real input is switched off, and says so", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      const canvas = document.getElementById("c")!;
      under(canvas);
      const seen: string[] = [];
      canvas.addEventListener("mousedown", () => seen.push("mousedown"));
      const r = await executeAction(d({ action: "click", x: 300, y: 200, trusted: true }), deps);
      expect(deps.input).not.toHaveBeenCalled();
      expect(seen).toEqual(["mousedown"]);
      expect(r.message).toContain("switched off");
    });
    it("falls back to page events when the debugger cannot attach", async () => {
      const { deps } = setup(`<canvas id="c"></canvas>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      deps.input.mockResolvedValue({ ok: false, error: "Cannot access a chrome:// URL" });
      const canvas = document.getElementById("c")!;
      under(canvas);
      const seen: string[] = [];
      canvas.addEventListener("mousedown", () => seen.push("mousedown"));
      await executeAction(d({ action: "click", x: 300, y: 200, trusted: true }), deps);
      expect(seen).toEqual(["mousedown"]);
    });
    it("hover fires the enter/over events a JS hover menu listens for, with no escalation when the page reacts", async () => {
      const { page, deps } = setup(`<button id="m">Menu</button>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      const seen: string[] = [];
      for (const t of ["mouseenter", "mouseover"]) document.getElementById("m")!.addEventListener(t, () => seen.push(t));
      const r = await executeAction(d({ action: "hover", elementId: page.elements[0].id }), deps);
      expect(r.ok).toBe(true);
      expect(seen.sort()).toEqual(["mouseenter", "mouseover"]);
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("a hover nothing answered escalates by itself (CSS :hover), but a click never does", async () => {
      const { page, deps } = setup(`<button id="m">Menu</button>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      still(deps);
      const id = page.elements[0].id;
      const hover = await executeAction(d({ action: "hover", elementId: id }), deps);
      expect(deps.input).toHaveBeenCalledTimes(1);
      expect(deps.input.mock.calls[0]).toMatchObject([[{ kind: "move" }]]);
      expect(hover.message).toContain("real input");
      deps.input.mockClear();
      under(document.getElementById("m"));
      await executeAction(d({ action: "double_click", x: 10, y: 10 }), deps);
      await executeAction(d({ action: "right_click", elementId: id }), deps);
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("maps double_click and right_click onto the right real-input ops", async () => {
      const { page, deps } = setup(`<button>Menu</button>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      const id = page.elements[0].id;
      await executeAction(d({ action: "double_click", elementId: id, trusted: true }), deps);
      await executeAction(d({ action: "right_click", elementId: id, trusted: true }), deps);
      expect(deps.input.mock.calls.map((c) => (c as unknown as [{ kind: string; button?: string; count?: number }[]])[0][0])).toMatchObject([
        { kind: "click", button: "left", count: 2 },
        { kind: "click", button: "right", count: 1 },
      ]);
    });
    it("double_click and right_click reach page listeners by default", async () => {
      const { page, deps } = setup(`<button id="b">Card</button>`);
      const seen: string[] = [];
      for (const t of ["dblclick", "contextmenu"]) document.getElementById("b")!.addEventListener(t, () => seen.push(t));
      await executeAction(d({ action: "double_click", elementId: page.elements[0].id }), deps);
      await executeAction(d({ action: "right_click", elementId: page.elements[0].id }), deps);
      expect(seen).toEqual(["dblclick", "contextmenu"]);
    });
    it("points at a bare spot with a marker centred on it", async () => {
      const { deps, overlay } = setup(`<canvas id="c"></canvas>`);
      const r = await executeAction(d({ action: "point_to", x: 55, y: 392 }), deps);
      expect(r.ok, r.message).toBe(true);
      const opts = (overlay.pointAt.mock.calls[0] as unknown as [number, { locator: () => { x: number; y: number; width: number; height: number } }])[1];
      const rect = opts.locator();
      expect([rect.x + rect.width / 2, rect.y + rect.height / 2]).toEqual([55, 392]);
    });
    it("refuses points outside the viewport and points on its own UI", async () => {
      const { deps } = setup(`<div id="pip-companion-host"><span id="inner"></span></div>`);
      const off = await executeAction(d({ action: "click", x: 5000, y: 10 }), deps);
      expect(off.ok).toBe(false);
      expect(off.message).toContain("outside the visible page");
      under(document.getElementById("inner"));
      const self = await executeAction(d({ action: "click", x: 10, y: 10 }), deps);
      expect(self.ok).toBe(false);
    });
    it("drags between two points with pointer events, and needs both ends on screen", async () => {
      const { deps } = setup(`<div id="s"></div>`);
      const s = document.getElementById("s")!;
      under(s);
      const seen: string[] = [];
      for (const t of ["mousedown", "mousemove", "mouseup"]) s.addEventListener(t, () => seen.includes(t) || seen.push(t));
      const r = await executeAction(d({ action: "drag", x: 100, y: 100, toX: 400, toY: 120 }), deps);
      expect(r.ok, r.message).toBe(true);
      expect(seen).toEqual(["mousedown", "mousemove", "mouseup"]);
      expect(deps.input).not.toHaveBeenCalled();
      const off = await executeAction(d({ action: "drag", x: 100, y: 100, toX: 400, toY: 9000 }), deps);
      expect(off.ok).toBe(false);
    });
    it("sends a drag as real input when asked", async () => {
      const { deps } = setup(`<div id="s"></div>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      under(document.getElementById("s"));
      await executeAction(d({ action: "drag", x: 100, y: 100, toX: 400, toY: 120, trusted: true }), deps);
      expect(deps.input).toHaveBeenCalledWith([{ kind: "drag", x: 100, y: 100, toX: 400, toY: 120 }]);
    });
    it("presses a key chord on the named element with page events", async () => {
      const { page, deps } = setup(`<input id="q" aria-label="Search">`);
      const keys: string[] = [];
      document.getElementById("q")!.addEventListener("keydown", (e) => keys.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`));
      const r = await executeAction(d({ action: "press_key", elementId: page.elements[0].id, text: "Control+a" }), deps);
      expect(r.ok).toBe(true);
      expect(document.activeElement?.id).toBe("q");
      expect(keys).toEqual(["ctrl+a"]);
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("marks a key it presses as its own, so the rabbit's Escape does not trip the student's stop-everything", async () => {
      const { deps } = setup(`<input id="q" aria-label="Search">`);
      let ownAtDispatch: boolean | null = null;
      document.addEventListener("keydown", () => (ownAtDispatch = isOwnKey()), { once: true });
      await executeAction(d({ action: "press_key", text: "Escape" }), deps);
      expect(ownAtDispatch).toBe(true);
    });
    it("sends a key as real input when asked (Tab only moves focus for real)", async () => {
      const { deps } = setup(`<input id="q" aria-label="Search">`);
      deps.trustedInputEnabled.mockReturnValue(true);
      await executeAction(d({ action: "press_key", text: "Tab", trusted: true }), deps);
      expect(deps.input).toHaveBeenCalledWith([{ kind: "key", chord: expect.objectContaining({ key: "Tab" }) }]);
    });
    it("types at the focus, but never into a focused password field, even as real input", async () => {
      const { deps } = setup(`<input id="a" aria-label="Cell"><input id="p" type="password" aria-label="Password">`);
      deps.trustedInputEnabled.mockReturnValue(true);
      const none = await executeAction(d({ action: "type", text: "hi" }), deps);
      expect(none.ok).toBe(false);
      const a = document.getElementById("a") as HTMLInputElement;
      a.focus();
      const ok = await executeAction(d({ action: "type", text: "y = 2x" }), deps);
      expect(ok.ok).toBe(true);
      expect(a.value).toBe("y = 2x");
      expect(deps.input).not.toHaveBeenCalled();
      document.getElementById("p")!.focus();
      const secret = await executeAction(d({ action: "type", text: "hunter2", trusted: true }), deps);
      expect(secret.ok).toBe(false);
      expect(deps.input).not.toHaveBeenCalled();
    });
    it("says a non-text focus needs real keystrokes instead of pretending to type", async () => {
      const { deps } = setup(`<div id="tool" tabindex="0"></div>`);
      document.getElementById("tool")!.focus();
      const r = await executeAction(d({ action: "type", text: "y = 2x" }), deps);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("switched off");
    });
    it("wheels over a point as real input only when asked", async () => {
      const { deps } = setup(`<div id="map"></div>`);
      deps.trustedInputEnabled.mockReturnValue(true);
      under(document.getElementById("map"));
      const plain = await executeAction(d({ action: "scroll", direction: "down", amount: 300, x: 50, y: 60 }), deps);
      expect(deps.input).not.toHaveBeenCalled();
      expect(plain.message).toContain("trusted:true");
      const r = await executeAction(d({ action: "scroll", direction: "down", amount: 300, x: 50, y: 60, trusted: true }), deps);
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
