import { describe, expect, it } from "vitest";
import { describeSketch, eraseFromSketch, parseSketch } from "./sketch";

describe("parseSketch", () => {
  it("splits a titled spec into text lines and strokes, in order", () => {
    const sk = parseSketch("A right triangle:\nline 20 80 80 80\nlabel 12 58 a\nThe square corner is at the bottom left.");
    expect(sk.title).toBe("A right triangle");
    expect(sk.items.map((i) => i.kind)).toEqual(["stroke", "stroke", "text"]);
    expect(sk.items[0]).toEqual({ kind: "stroke", stroke: { kind: "line", n: [20, 80, 80, 80] } });
    expect(sk.items[1]).toEqual({ kind: "stroke", stroke: { kind: "label", n: [12, 58], text: "a" } });
  });

  it("keeps plain worked examples working as pure text", () => {
    const sk = parseSketch("A similar one:\n2x + 4 = 10\n− 4 from both sides\n2x = 6");
    expect(sk.title).toBe("A similar one");
    expect(sk.items.every((i) => i.kind === "text")).toBe(true);
  });

  it("treats a command line that doesn't parse as text, never dropping it", () => {
    const sk = parseSketch("circle the correct answer\nline 10 20 30\nrect 5 5 0 10\ndot 50 fifty");
    expect(sk.items.every((i) => i.kind === "text")).toBe(true);
  });

  it("clamps coordinates to the 0-100 board and caps label length", () => {
    const sk = parseSketch(`line -20 50 250 50\nlabel 10 10 ${"long ".repeat(20)}`);
    expect(sk.items[0]).toEqual({ kind: "stroke", stroke: { kind: "line", n: [0, 50, 100, 50] } });
    const label = sk.items[1];
    expect(label.kind === "stroke" && label.stroke.text!.length).toBeLessThanOrEqual(40);
  });

  it("strips quotes from labels and rejects empty ones", () => {
    expect(parseSketch(`label 10 90 "rise"`).items[0]).toEqual({ kind: "stroke", stroke: { kind: "label", n: [10, 90], text: "rise" } });
    expect(parseSketch("label 10 90").items[0].kind).toBe("text");
  });
});

describe("describeSketch / eraseFromSketch", () => {
  const sk = parseSketch("A right triangle:\nline 20 80 80 80\nline 20 80 20 30\nline 20 30 80 80\nlabel 12 58 a\nlabel 48 92 b\nThe square corner is between a and b.");

  it("lists the drawing by number, in lines the model could have written itself", () => {
    expect(describeSketch(sk).split("\n")).toEqual(["1. line 20 80 80 80", "2. line 20 80 20 30", "3. line 20 30 80 80", "4. label 12 58 a", "5. label 48 92 b", "6. The square corner is between a and b."]);
    // Round trip: what is listed parses back to the same items.
    expect(parseSketch(describeSketch(sk).replace(/^\d+\. /gm, "")).items).toEqual(sk.items);
  });

  it("erases just the named parts, by number, list or range, and leaves the rest as it was", () => {
    const some = eraseFromSketch(sk.items, "4, 5");
    expect(some.erased).toBe(2);
    expect(some.items.map((i) => (i.kind === "stroke" ? i.stroke.kind : "text"))).toEqual(["line", "line", "line", "text"]);
    expect(eraseFromSketch(sk.items, "2-3 6").items).toHaveLength(3);
    expect(eraseFromSketch(sk.items, "6-4").erased).toBe(3);
  });

  it("erases everything on 'all', and ignores numbers that are not on the board", () => {
    expect(eraseFromSketch(sk.items, "all")).toEqual({ items: [], erased: 6 });
    expect(eraseFromSketch(sk.items, "9 0 -1 x")).toEqual({ items: sk.items, erased: 0 });
    expect(eraseFromSketch(sk.items, "5-40").erased).toBe(2);
  });
});
