import { describe, it, expect } from "vitest";
import { formatResults, rankResults, youtubeSearch } from "./lookup";

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

describe("youtubeSearch", () => {
  const video = (videoId: string, length: string | null) => ({ videoRenderer: { videoId, title: { runs: [{ text: `Lesson ${videoId}` }] }, ownerText: { runs: [{ text: "Mr. Chen" }] }, ...(length ? { lengthText: { simpleText: length } } : {}) } });
  const resultsPage = (items: unknown[]) => `<html><script>var ytInitialData = ${JSON.stringify({ contents: { sections: [{ items }, { shelf: { items: [] } }] } })};</script></html>`;
  const respond = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;

  it("returns watchable lessons only: no Shorts, no live streams, at most three", async () => {
    const out = await youtubeSearch("two-step equations", respond(resultsPage([video("short", "0:40"), video("live", null), { channelRenderer: {} }, video("a", "10:29"), video("b", "1:30"), video("c", "1:02:03"), video("d", "5:00")])));
    expect(out.map((r) => r.url)).toEqual(["a", "b", "c"].map((id) => `https://www.youtube.com/watch?v=${id}`));
    expect(out[0].title).toBe("Lesson a (YouTube · Mr. Chen · 10:29)");
  });

  it("asks for captioned videos in Restricted Mode, without anyone's cookies", async () => {
    let asked: { url: string; headers: Record<string, string> } | null = null;
    await youtubeSearch("x", (async (url: string, init: RequestInit) => ((asked = { url, headers: init.headers as Record<string, string> }), new Response(resultsPage([])))) as unknown as typeof fetch);
    expect(asked!.url).toContain("sp=EgQQASgB");
    expect(asked!.headers.cookie).toBe("PREF=f2=8000000");
  });

  it("fails loudly when the page changes shape, so lookUp falls back to the search link", async () => {
    await expect(youtubeSearch("x", respond("<html>consent wall</html>"))).rejects.toThrow("ytInitialData");
    await expect(youtubeSearch("x", respond("", 429))).rejects.toThrow("429");
  });
});

describe("rankResults", () => {
  const results = [
    { title: "Axial tilt (Wikipedia)", url: "https://en.wikipedia.org/wiki/Axial_tilt" },
    { title: "Khan search", url: "https://www.khanacademy.org/search?page_search_query=axial%20tilt" },
    { title: "A video", url: "https://www.youtube.com/watch?v=abc" },
  ];

  it("tags each result with its modality and lists the preferred one first, otherwise stable", () => {
    const ranked = rankResults(results, "video");
    expect(ranked.map((r) => r.kind)).toEqual(["video", "article", "lesson"]);
    expect(rankResults(results).map((r) => r.kind)).toEqual(["article", "lesson", "video"]);
    expect(formatResults("q", ranked).split("\n")[0]).toMatch(/^1\. \[video\] A video — https:\/\/www\.youtube\.com/);
  });
});
