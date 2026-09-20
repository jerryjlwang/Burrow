import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BubbleQueue, bubbleHoldMs } from "./bubbles";
import type { Bubble } from "./store";

const SHORT = "Here we are!";
const LONG = "That step went by fast. He moved the three across, so its sign flipped — that's why it shows up as minus three on the other side of the equals.";

function harness() {
  let current: Bubble | null = null;
  const shown: string[] = [];
  const queue = new BubbleQueue({ get: () => current, set: (b) => { current = b; if (b) shown.push(b.id); } });
  return { queue, shown, current: () => current, userClears: () => { current = null; } };
}
const reply = (id: string, text: string, ttl = 4000): Bubble => ({ id, text, kind: "reply", expiresAt: Date.now() + ttl });

describe("bubbleHoldMs", () => {
  it("scales with the text and stays within sane bounds", () => {
    expect(bubbleHoldMs("Yep.")).toBe(2500);
    expect(bubbleHoldMs(LONG)).toBeGreaterThan(bubbleHoldMs(SHORT));
    expect(bubbleHoldMs(LONG)).toBeGreaterThan(9000);
    expect(bubbleHoldMs("x".repeat(2000))).toBe(16_000);
  });
});

describe("BubbleQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not let a following bubble wipe one that is still being read", () => {
    const h = harness();
    h.queue.show(reply("a", LONG));
    vi.advanceTimersByTime(1000);
    h.queue.show(reply("b", SHORT));
    expect(h.current()?.id).toBe("a");
    vi.advanceTimersByTime(bubbleHoldMs(LONG) - 1001);
    expect(h.current()?.id).toBe("a");
    vi.advanceTimersByTime(2);
    expect(h.current()?.id).toBe("b");
  });

  it("stretches an expiry that is shorter than the time needed to read the text", () => {
    const h = harness();
    h.queue.show(reply("a", LONG, 3000));
    vi.advanceTimersByTime(3500);
    expect(h.current()?.id).toBe("a");
    vi.advanceTimersByTime(bubbleHoldMs(LONG));
    expect(h.current()).toBeNull();
  });

  it("keeps only the newest of several queued replies", () => {
    const h = harness();
    h.queue.show(reply("a", LONG));
    h.queue.show(reply("b", SHORT));
    h.queue.show(reply("c", SHORT));
    vi.advanceTimersByTime(bubbleHoldMs(LONG) + 10);
    expect(h.shown).toEqual(["a", "c"]);
  });

  it("lets a confirmation through at once, and nothing replaces a bubble awaiting an answer", () => {
    const h = harness();
    h.queue.show(reply("a", LONG));
    h.queue.show({ id: "confirm", text: "Submit your quiz?", kind: "confirmation", actions: [{ label: "Go ahead", value: "accept" }] });
    expect(h.current()?.id).toBe("confirm");
    h.queue.show(reply("b", SHORT));
    vi.advanceTimersByTime(15_000);
    expect(h.current()?.id).toBe("confirm");
    h.queue.clear((b) => b.id === "confirm");
    expect(h.current()?.id).toBe("b");
  });

  it("drops a queued line whose moment has passed", () => {
    const h = harness();
    h.queue.show({ id: "offer", text: "Want a hint?", kind: "offer", actions: [{ label: "Yes", value: "accept" }], expiresAt: Date.now() + 25_000 });
    h.queue.show(reply("late", SHORT));
    vi.advanceTimersByTime(25_100);
    expect(h.current()).toBeNull();
    expect(h.shown).toEqual(["offer"]);
  });

  it("moves straight on when the student dismisses a bubble", () => {
    const h = harness();
    h.queue.show(reply("a", LONG));
    h.queue.show({ id: "info", text: SHORT, kind: "info", expiresAt: Date.now() + 6000 });
    h.queue.clear((b) => b.id === "a");
    expect(h.current()?.id).toBe("info");
  });
});
