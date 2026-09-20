import { describe, it, expect } from "vitest";
import { lineSpan, quoteSpan } from "./locate";

describe("lineSpan", () => {
  const working = "3x + 5 = 20\n3x = 15\nx = 5";

  it("maps 1-based lines to character ranges", () => {
    expect(lineSpan(working, 1)).toEqual({ start: 0, end: 11 });
    expect(lineSpan(working, 2)).toEqual({ start: 12, end: 19 });
    expect(lineSpan(working, 3)).toEqual({ start: 20, end: 25 });
  });

  it("refuses out-of-range and blank lines", () => {
    expect(lineSpan(working, 0)).toBeNull();
    expect(lineSpan(working, 4)).toBeNull();
    expect(lineSpan("3x = 15\n\nx = 5", 2)).toBeNull(); // blank line: nothing to point at
  });
});

describe("quoteSpan", () => {
  it("finds a quote and returns raw offsets", () => {
    const raw = "Whatever you do to one side, do to the other side too.";
    const span = quoteSpan(raw, "do to the other side");
    expect(span).not.toBeNull();
    expect(raw.slice(span!.start, span!.end)).toBe("do to the other side");
  });

  it("matches whitespace- and case-insensitively across line breaks", () => {
    const raw = "Whatever you do\n  to ONE side,\ndo to the other.";
    const span = quoteSpan(raw, "you do to one side");
    expect(raw.slice(span!.start, span!.end).replace(/\s+/g, " ")).toBe("you do\n  to ONE side".replace(/\s+/g, " "));
  });

  it("returns null when the quote is not on the page (no pointing at hallucinations)", () => {
    expect(quoteSpan("the seasons come from axial tilt", "closer to the sun")).toBeNull();
    expect(quoteSpan("anything", "")).toBeNull();
  });
});
