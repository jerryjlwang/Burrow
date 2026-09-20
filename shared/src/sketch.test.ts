import { describe, expect, it } from "vitest";
import { parseSketch } from "./sketch";

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
