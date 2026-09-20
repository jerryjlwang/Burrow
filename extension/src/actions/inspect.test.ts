// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { quoteRegion, regionText } from "./inspect";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("quoteRegion", () => {
  it("climbs from a short heading to the section around it", () => {
    const body = mount(`
      <nav>Dashboard Modules Assignments</nav>
      <section id="target">
        <h3>Description</h3>
        <p>${"This assignment closes out the equations unit. ".repeat(8)}Spotting it earns a golden ratio bonus.</p>
      </section>`);
    const region = quoteRegion(body, "description");
    expect(region?.id).toBe("target");
    expect(regionText(region!)).toContain("golden ratio bonus");
  });

  it("matches quotes case- and whitespace-insensitively", () => {
    // The paragraph is long enough to stand alone, so it IS the region — no climb to the article.
    const body = mount(`<article><p id="a">${"Filler sentence to make the region long enough to stand alone. ".repeat(5)}The GOLDEN\n  ratio appears here.</p></article>`);
    expect(quoteRegion(body, "the golden ratio appears")?.id).toBe("a");
  });

  it("returns null when the quote is nowhere under the root (no hallucinated regions)", () => {
    const body = mount(`<p>The seasons come from axial tilt.</p>`);
    expect(quoteRegion(body, "closer to the sun")).toBeNull();
  });

  it("finds quotes in field values and reads the field's full value", () => {
    const body = mount(`<textarea></textarea>`);
    const field = body.querySelector("textarea")!;
    field.value = "3x + 5 = 20\n3x = 15\nx = 5";
    const region = quoteRegion(body, "3x = 15");
    expect(region).toBe(field);
    expect(regionText(region!)).toBe("3x + 5 = 20\n3x = 15\nx = 5");
  });

  it("stays at the matched block instead of swallowing a page-scale container", () => {
    const filler = `<p>${"Unrelated filler text to inflate the container far past the climb budget. ".repeat(15)}</p>`.repeat(10);
    const body = mount(`<div>${filler}<p id="small">The needle sentence lives here.</p>${filler}</div>`);
    expect(quoteRegion(body, "needle sentence")?.id).toBe("small");
  });
});

describe("regionText", () => {
  it("normalizes runs of whitespace but keeps line structure", () => {
    const body = mount(`<div id="d"><p>first   line</p><p>second\n\n\n\nline</p></div>`);
    const text = regionText(body.querySelector("#d")!);
    expect(text).toContain("first line");
    expect(text).not.toMatch(/\n{3,}/);
  });
});
