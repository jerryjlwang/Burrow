import { describe, expect, it } from "vitest";
import { parseKeyChord } from "./keys";

describe("parseKeyChord", () => {
  it("parses named keys and their aliases", () => {
    expect(parseKeyChord("Escape")).toMatchObject({ key: "Escape", code: "Escape", keyCode: 27, text: null });
    expect(parseKeyChord("esc")?.key).toBe("Escape");
    expect(parseKeyChord("down")).toMatchObject({ key: "ArrowDown", keyCode: 40 });
    expect(parseKeyChord(" Enter ")).toMatchObject({ key: "Enter", keyCode: 13, text: "\r" });
    expect(parseKeyChord("F11")).toMatchObject({ key: "F11", code: "F11", keyCode: 122 });
  });
  it("parses modifiers, and a command chord inserts no text", () => {
    expect(parseKeyChord("Control+a")).toMatchObject({ key: "a", code: "KeyA", keyCode: 65, ctrl: true, text: null });
    expect(parseKeyChord("Cmd+Shift+z")).toMatchObject({ key: "Z", meta: true, shift: true, text: null });
    expect(parseKeyChord("Shift+Tab")).toMatchObject({ key: "Tab", shift: true });
    expect(parseKeyChord("a")).toMatchObject({ key: "a", text: "a" });
  });
  it("treats a trailing plus as the plus key", () => {
    expect(parseKeyChord("+")).toMatchObject({ key: "+", text: "+" });
    expect(parseKeyChord("Control++")).toMatchObject({ key: "+", ctrl: true, text: null });
  });
  it("returns null for keys and modifiers it does not know", () => {
    for (const bad of ["", "  ", "Hyper+x", "SuperJump", "Control+", "F13"]) expect(parseKeyChord(bad), bad).toBeNull();
  });
});
