import { describe, expect, it } from "vitest";
import { isVideoQuestion, pickRelated, relatedQuery, videoQuery } from "./related";

describe("isVideoQuestion", () => {
  it("catches question marks and question-word openers, spoken or typed", () => {
    expect(isVideoQuestion("why does he flip the sign?")).toBe(true);
    expect(isVideoQuestion("wait what did he just do")).toBe(true);
    expect(isVideoQuestion("How is that allowed")).toBe(true);
    expect(isVideoQuestion("pause the video")).toBe(false);
    expect(isVideoQuestion("okay")).toBe(false);
    expect(isVideoQuestion("")).toBe(false);
  });
});

describe("videoQuery", () => {
  it("strips site suffixes and caps length", () => {
    expect(videoQuery("Photosynthesis for kids - YouTube")).toBe("Photosynthesis for kids");
    expect(videoQuery("Solving equations | Khan Academy")).toBe("Solving equations");
    expect(videoQuery(`${"long ".repeat(30)}- YouTube`).length).toBeLessThanOrEqual(80);
  });
});

describe("relatedQuery", () => {
  it("searches for what was asked, anchored by the video's topic", () => {
    expect(relatedQuery("Why does the sign flip?", "(3) Solving two-step equations - YouTube")).toBe("sign flip Solving two-step equations");
    expect(relatedQuery("Why does the sign flip?", "Algebra Basics: Solving 2-Step Equations - Math Antics - YouTube")).toBe("sign flip Solving 2-Step Equations");
  });

  it("falls back to the topic when the question only points at the video", () => {
    expect(relatedQuery("wait, what did he just do?", "Solving two-step equations - YouTube")).toBe("Solving two-step equations");
  });
});

describe("pickRelated", () => {
  const results = ["1. [article] Seasons — https://en.wikipedia.org/wiki/Season", "2. [video] Why seasons happen — https://www.youtube.com/watch?v=abc123xyz", "3. [video] Axial tilt explained — https://www.youtube.com/watch?v=def456uvw"].join("\n");

  it("prefers a video that is not the one on screen", () => {
    expect(pickRelated(results, "https://example.com/lesson")).toMatchObject({ title: "Why seasons happen" });
    // The first video IS the current one (same id): pick the next.
    expect(pickRelated(results, "https://www.youtube.com/watch?v=abc123xyz&t=5s")).toMatchObject({ title: "Axial tilt explained" });
  });

  it("falls back to any fresh result, and to null when everything matches the current video", () => {
    expect(pickRelated("1. [article] Seasons — https://en.wikipedia.org/wiki/Season", "https://x.com")).toMatchObject({ url: "https://en.wikipedia.org/wiki/Season" });
    expect(pickRelated("1. [video] Same — https://youtu.be/abc123xyz", "https://www.youtube.com/watch?v=abc123xyz")).toBeNull();
    expect(pickRelated("", "https://x.com")).toBeNull();
  });
});
