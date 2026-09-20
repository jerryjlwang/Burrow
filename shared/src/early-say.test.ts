import { describe, it, expect } from "vitest";
import { earlySayFrom, speakableEarly } from "./early-say";

const full = '{"action":"speak","say":"In winter your side of Earth tilts away from the Sun.","elementId":null,"text":null,"reason":"answer","done":true}';

describe("earlySayFrom", () => {
  it("returns nothing until the spoken sentence has finished streaming", () => {
    for (const cut of [0, 5, 20, 40, full.indexOf('Sun."') + 3]) expect(earlySayFrom(full.slice(0, cut)), `cut ${cut}`).toBeNull();
  });

  it("returns the sentence as soon as the next key begins, long before the object closes", () => {
    const at = full.indexOf(',"elementId"') + 1;
    expect(earlySayFrom(full.slice(0, at))).toEqual({ action: "speak", say: "In winter your side of Earth tilts away from the Sun." });
  });

  it("decodes escapes and tolerates whitespace", () => {
    expect(earlySayFrom('{ "action" : "explain" , "say" : "It\'s \\"tilt\\" — not distance.\\n" ,')?.say).toBe('It\'s "tilt" — not distance.\n');
  });

  it("does not stop at an escaped quote inside the sentence", () => {
    expect(earlySayFrom('{"action":"speak","say":"She said \\"hi')).toBeNull();
  });

  it("reports a null or empty sentence as nothing to say", () => {
    expect(earlySayFrom('{"action":"finish","say":null,')).toEqual({ action: "finish", say: null });
    expect(earlySayFrom('{"action":"speak","say":"  ",')?.say).toBeNull();
  });

  it("never matches when the keys arrive in another order", () => {
    expect(earlySayFrom('{"say":"hello","action":"speak",')).toBeNull();
  });
});

describe("speakableEarly", () => {
  it("speaks early only for turns that are just talk", () => {
    for (const action of ["speak", "explain", "finish", "ask_user", "show_plan"]) expect(speakableEarly(`{"action":"${action}","say":"Okay.",`), action).toBe("Okay.");
  });

  it("holds back anything that acts on the page or could be gated, invalidated or confirmed", () => {
    for (const action of ["click", "type", "navigate", "open_tab", "press_enter", "point_to", "highlight", "scroll", "look_up", "make_plan", "ask_confirmation", "sketch"]) {
      expect(speakableEarly(`{"action":"${action}","say":"Sure.",`), action).toBeNull();
    }
  });

  it("caps length like the validator does", () => {
    expect(speakableEarly(`{"action":"speak","say":"${"a".repeat(900)}",`)).toHaveLength(400);
  });
});

describe("pointing hints", () => {
  it("speaks once the target element is known, not before", () => {
    expect(speakableEarly('{"action":"point_to","say":"Right here.",')).toBeNull();
    expect(speakableEarly('{"action":"point_to","say":"Right here.","elementId":1')).toBeNull(); // "1" may still become "12"
    expect(speakableEarly('{"action":"point_to","say":"Right here.","elementId":12,')).toBe("Right here.");
    expect(speakableEarly('{"action":"highlight","say":"This part.","elementId":0,"text":null')).toBe("This part.");
    expect(speakableEarly('{"action":"scroll_to","say":"Down here.","elementId":7,')).toBe("Down here.");
  });

  it("stays silent when there is no element target (a quote or a point comes much later, and may be invalid)", () => {
    expect(speakableEarly('{"action":"point_to","say":"Right here.","elementId":null,"text":null,')).toBeNull();
    expect(speakableEarly('{"action":"point_to","say":"Right here.","elementId":-1,')).toBeNull();
  });

  it("still never speaks early for actions that can be gated", () => {
    expect(speakableEarly('{"action":"click","say":"On it.","elementId":4,')).toBeNull();
    expect(speakableEarly('{"action":"type","say":"Sure.","elementId":4,')).toBeNull();
  });
});
