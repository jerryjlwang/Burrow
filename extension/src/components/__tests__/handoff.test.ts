import { describe, expect, it } from "vitest";
import { newlyGranted, summarize } from "../handoff";
import type { GraphSnapshot } from "@shared/graph";

const node = (label: string, lastSeenAt: number) =>
  ({ id: label, label, aliases: [], state: { lastSeenAt } as never, sources: [], misconceptions: [] }) as GraphSnapshot["nodes"][number];

describe("handoff helpers", () => {
  it("reports only skills that flipped to granted", () => {
    const before = { use_voice: { granted: false, at: 1 }, read_pages: { granted: true, at: 1 } };
    const after = { use_voice: { granted: true, at: 2 }, read_pages: { granted: true, at: 1 }, remember: { granted: false, at: 2 } };
    expect(newlyGranted(before, after)).toEqual(["use_voice"]);
    expect(newlyGranted(undefined, after)).toEqual(["use_voice", "read_pages"]);
  });

  it("summarizes the most recent concepts in his own words", () => {
    const now = 1_000_000_000_000;
    const day = 24 * 3600 * 1000;
    const graph: GraphSnapshot = { version: 1, updatedAt: now, edges: [], nodes: [node("moats", now - 1000), node("drawbridges", now - 2000), node("fractions", now - 3 * day)] };
    expect(summarize(graph, now)).toBe("Today I learned about moats and drawbridges.");
    expect(summarize({ version: 1, updatedAt: 0, edges: [], nodes: [] }, now)).toMatch(/Teach me something/);
    expect(summarize(null, now)).toMatch(/Teach me something/);
  });
});
