import { describe, expect, it } from "vitest";
import { isChapterRequest, parseChapters, pickChapterLexical } from "./chapters";

const YOUTUBE = `What are the neurons, why are there layers, and what is the math underlying it?
Help fund future projects: https://www.patreon.com/3blue1brown

Timestamps
0:00 - Introduction example
1:07 - Series preview
2:42 - What are neurons?
3:35 - Introducing layers
1:02:03 - Closing thoughts

Thanks to these viewers. I first saw this at 0:30 in another video.`;

describe("parseChapters", () => {
  it("reads a description's timestamped lines, in whatever punctuation the uploader used", () => {
    const chapters = parseChapters(YOUTUBE);
    expect(chapters.map((c) => [c.t, c.stamp, c.title])).toEqual([
      [0, "0:00", "Introduction example"],
      [67, "1:07", "Series preview"],
      [162, "2:42", "What are neurons?"],
      [215, "3:35", "Introducing layers"],
      [3723, "1:02:03", "Closing thoughts"],
    ]);
    expect(chapters[2].line).toBe("2:42 - What are neurons?");
    expect(parseChapters("(0:00) Intro\n[4:10] Worked example").map((c) => c.title)).toEqual(["Intro", "Worked example"]);
  });

  it("ignores timestamps that are not a list: out of order, or on their own", () => {
    expect(parseChapters(YOUTUBE).some((c) => c.stamp === "0:30")).toBe(false);
    expect(parseChapters("Great bit at 3:20\n3:20 is where it clicks")).toEqual([]);
  });
});

describe("isChapterRequest", () => {
  it("catches requests to use the chapter list, and leaves ordinary video questions alone", () => {
    for (const yes of ["look at the chapter list and find where he explains layers", "which chapter covers the sign mistake?", "check the description for the part on neurons", "is there a timestamp for edge detection"]) expect(isChapterRequest(yes)).toBe(true);
    for (const no of ["wait what did he just say", "skip to where he explains layers", "pause"]) expect(isChapterRequest(no)).toBe(false);
  });
});

describe("pickChapterLexical", () => {
  const chapters = parseChapters(YOUTUBE);

  it("matches on the words of the request, through simple endings", () => {
    expect(pickChapterLexical("find the chapter where he introduces the layer idea", chapters)).toBe(3);
    expect(pickChapterLexical("look at the chapter list for neurons", chapters)).toBe(2);
  });

  it("can demand a plainer match, which is what lets the chapter path skip the model", () => {
    expect(pickChapterLexical("find the chapter on the series preview", chapters, 2)).toBe(1);
    expect(pickChapterLexical("look at the chapter list for neurons", chapters, 2)).toBeNull();
  });

  it("is null when they named no part, or nothing overlaps", () => {
    expect(pickChapterLexical("show me the chapter list", chapters)).toBeNull();
    expect(pickChapterLexical("which chapter is about logarithms", chapters)).toBeNull();
  });
});
