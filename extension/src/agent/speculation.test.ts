import { describe, it, expect, vi } from "vitest";
import { Speculator, speculationKey } from "./speculation";

describe("speculationKey", () => {
  it("ignores the punctuation and casing a recogniser changes between interim and final", () => {
    expect(speculationKey("why is it colder in winter", "u")).toBe(speculationKey("Why is it colder, in winter?", "u"));
  });

  it("differs when the words or the page differ", () => {
    expect(speculationKey("why is it colder", "u")).not.toBe(speculationKey("why is it colder in winter", "u"));
    expect(speculationKey("why is it colder", "page-a")).not.toBe(speculationKey("why is it colder", "page-b"));
  });
});

describe("Speculator", () => {
  it("hands over the call already in flight, with how much of a head start it had", async () => {
    let t = 1000;
    const s = new Speculator<string>(20_000, () => t);
    const run = vi.fn(async () => "decision");
    s.start("k", run);
    t += 900;
    const head = s.take("k");
    expect(head?.headStartMs).toBe(900);
    expect(await head!.promise).toBe("decision");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is spent once claimed, and never serves a different utterance", () => {
    const s = new Speculator<string>();
    s.start("said this", async () => "a");
    expect(s.take("said something else")).toBeNull();
    expect(s.take("said this")).toBeNull(); // the mismatch already spent it
    expect(s.pending).toBe(false);
  });

  it("keeps the in-flight guess when the same words are guessed again, and replaces it for new words", () => {
    const s = new Speculator<string>();
    const first = vi.fn(async () => "a");
    const again = vi.fn(async () => "b");
    const other = vi.fn(async () => "c");
    s.start("k", first);
    s.start("k", again);
    expect(again).not.toHaveBeenCalled();
    s.start("k2", other);
    expect(other).toHaveBeenCalledTimes(1);
    expect(s.take("k")).toBeNull();
  });

  it("refuses a stale guess", () => {
    let t = 0;
    const s = new Speculator<string>(5000, () => t);
    s.start("k", async () => "a");
    t = 5001;
    expect(s.take("k")).toBeNull();
  });

  it("drops on demand, and an unclaimed failing guess does not throw", async () => {
    const s = new Speculator<string>();
    s.start("k", async () => Promise.reject(new Error("boom")));
    s.drop();
    expect(s.take("k")).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
  });
});
