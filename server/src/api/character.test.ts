import { describe, expect, it } from "vitest";
import { paintMock, validatePaint } from "./character";

const regions = [
  { id: 1, size: 900 },
  { id: 2, size: 120 },
  { id: 3, size: 40 },
];

describe("validatePaint", () => {
  it("keeps well formed colours for known regions only", () => {
    const v = validatePaint({ name: "  Pikachu ", colors: { "1": "#F2C14E", "2": "yellow", "9": "#000000" } }, regions);
    expect(v).toEqual({ name: "Pikachu", colors: { "1": "#f2c14e" } });
  });
  it("rejects a reply with no usable colour", () => {
    expect(validatePaint({ name: "x", colors: { "1": "gold" } }, regions)).toBeNull();
    expect(validatePaint("nope", regions)).toBeNull();
  });
});

describe("paintMock", () => {
  it("colours every region and uses the kid's words as the name", () => {
    const m = paintMock({ numbered: "data:image/png;base64,", hint: " my frog ", regions });
    expect(Object.keys(m.colors)).toEqual(["1", "2", "3"]);
    expect(m.name).toBe("my frog");
    expect(m.provider).toBe("mock");
  });
});
