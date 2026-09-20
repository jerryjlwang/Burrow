import { describe, it, expect } from "vitest";
import { formatResults } from "./lookup";

describe("formatResults", () => {
  it("renders numbered, citable lines with snippets capped", () => {
    const out = formatResults("axial tilt", [
      { title: "Axial tilt (Wikipedia)", url: "https://en.wikipedia.org/wiki/Axial_tilt", snippet: "x".repeat(300) },
      { title: 'Khan Academy search for "axial tilt"', url: "https://www.khanacademy.org/search?page_search_query=axial%20tilt" },
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1\. Axial tilt \(Wikipedia\) — https:\/\//);
    expect(lines[0].length).toBeLessThan(260);
    expect(lines[1]).toContain("khanacademy.org");
  });

  it("says so plainly when there is nothing", () => {
    expect(formatResults("zzz", [])).toContain('No results for "zzz"');
  });
});
