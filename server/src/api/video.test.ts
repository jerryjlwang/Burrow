import { describe, it, expect, vi } from "vitest";
import { VideoService, fetchServiceTranscript, youtubeId } from "./video";
import type { OpenAIProvider } from "../agent/openai";

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const chunk = (offset: number, text: string) => ({ text, offset, duration: 5000, lang: "en" });

describe("youtubeId", () => {
  it("reads the id from every watch-page shape and nothing else", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=NybHckSEQBI&t=20s")).toBe("NybHckSEQBI");
    expect(youtubeId("https://youtu.be/NybHckSEQBI?si=x")).toBe("NybHckSEQBI");
    expect(youtubeId("https://www.youtube.com/embed/NybHckSEQBI")).toBe("NybHckSEQBI");
    expect(youtubeId("https://www.youtube.com/results?search_query=algebra")).toBeNull();
    expect(youtubeId("https://www.khanacademy.org/v/x")).toBeNull();
    expect(youtubeId("not a url")).toBeNull();
  });
});

describe("fetchServiceTranscript", () => {
  it("asks the transcript service (never YouTube) and converts ms chunks to second segments", async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => ok({ content: [chunk(5000, "second  line"), chunk(0, "<i>first</i> line")], lang: "en" }));
    const segs = await fetchServiceTranscript("NybHckSEQBI", "key-123", fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://api.supadata.ai/v1/youtube/transcript?videoId=NybHckSEQBI&lang=en");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("key-123");
    expect(segs).toEqual([{ start: 0, end: 5, text: "first line" }, { start: 5, end: 10, text: "second line" }]);
  });

  it("treats 'no transcript for this video' as empty, and real failures as errors", async () => {
    expect(await fetchServiceTranscript("x", "k", (() => ok({ error: "transcript-unavailable" }, 206)) as unknown as typeof fetch)).toEqual([]);
    await expect(fetchServiceTranscript("x", "k", (() => ok({ error: "unauthorized" }, 401)) as unknown as typeof fetch)).rejects.toThrow("transcript service 401");
  });
});

describe("VideoService", () => {
  const lecture = Array.from({ length: 24 }, (_, i) => chunk(i * 10_000, i === 9 ? "Remember this: whatever you do to one side, do to the other." : `Here is example number ${i}.`));

  it("analyzes a video once however many tabs ask, and without a model still flags what the speaker flags", async () => {
    const fetchImpl = vi.fn(() => ok({ content: lecture }));
    const svc = new VideoService(null, "k", fetchImpl as unknown as typeof fetch);
    const [a, b] = await Promise.all([svc.analyze({ url: "https://www.youtube.com/watch?v=abcdef12345" }), svc.analyze({ url: "https://youtu.be/abcdef12345" })]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(a).toMatchObject({ key: "abcdef12345", transcript: "service", notesBy: "heuristic" });
    expect(a.notes.filter((n) => n.raise).map((n) => n.raise!.kind)).toEqual(["crucial"]);
  });

  it("prefers captions the page already has, and needs no key or network for them", async () => {
    const fetchImpl = vi.fn();
    const svc = new VideoService(null, "", fetchImpl as unknown as typeof fetch);
    const r = await svc.analyze({ url: "http://localhost:8787/demo/video.html", segments: [{ start: 0, end: 4, text: "Hello." }, { start: NaN, end: 1, text: "junk" }] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toMatchObject({ transcript: "page", segments: [{ start: 0, end: 4, text: "Hello." }] });
  });

  it("is honest when there is nothing to read", async () => {
    const svc = new VideoService(null, "", vi.fn() as unknown as typeof fetch);
    expect(await svc.analyze({ url: "https://www.youtube.com/watch?v=abcdef12345" })).toMatchObject({ transcript: "none", notes: [], notesBy: "none" });
  });

  it("uses the model's notes when there is one, dropping malformed ones, and falls back if it fails", async () => {
    const complete = vi.fn().mockResolvedValueOnce({ notes: [{ start: 0, end: 90, gist: "Sets up the balance idea.", concepts: ["Equations"], assumes: [], raise: null }, { start: 90, end: 80, gist: "bad span", concepts: [], assumes: [], raise: null }] });
    const svc = new VideoService({ complete } as unknown as OpenAIProvider, "k", (() => ok({ content: lecture })) as unknown as typeof fetch);
    const r = await svc.analyze({ url: "https://www.youtube.com/watch?v=abcdef12345", title: "Algebra basics" });
    expect(r.notesBy).toBe("llm");
    expect(r.notes).toHaveLength(1);
    expect(String(complete.mock.calls[0][1][0].text)).toContain("[0:00] Here is example number 0.");

    const failing = new VideoService({ complete: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as OpenAIProvider, "k", (() => ok({ content: lecture })) as unknown as typeof fetch);
    expect((await failing.analyze({ url: "https://www.youtube.com/watch?v=zzzzzz12345" })).notesBy).toBe("heuristic");
  });

  it("forgets a failed analysis so the next visit can retry", async () => {
    const fetchImpl = vi.fn().mockImplementationOnce(() => ok({}, 500)).mockImplementationOnce(() => ok({ content: lecture }));
    const svc = new VideoService(null, "k", fetchImpl as unknown as typeof fetch);
    await expect(svc.analyze({ url: "https://youtu.be/abcdef12345" })).rejects.toThrow();
    expect((await svc.analyze({ url: "https://youtu.be/abcdef12345" })).transcript).toBe("service");
  });
});
