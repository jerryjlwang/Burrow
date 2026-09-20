import { describe, it, expect } from "vitest";
import { HINT_RUNGS, finalAnswersFor, leakedAnswer, rungConstraint, rungForStudent } from "./ladder";
import { detectProblem } from "./hints";
import type { PageSummary } from "./types";

const student = (hints: number) => ({ hintsForCurrentProblem: hints });
const signals = (incorrect: number) => ({ incorrectAttempts: incorrect });

describe("rungForStudent", () => {
  it("climbs one rung per hint already given, capped at 5", () => {
    expect(rungForStudent(student(0)).rung).toBe(1);
    expect(rungForStudent(student(1)).rung).toBe(2);
    expect(rungForStudent(student(4)).rung).toBe(5);
    expect(rungForStudent(student(9)).rung).toBe(5);
  });

  it("boosts one rung when the student is visibly thrashing", () => {
    expect(rungForStudent(student(0), signals(3)).rung).toBe(2);
    expect(rungForStudent(student(0), signals(2)).rung).toBe(1);
  });
});

describe("rungConstraint", () => {
  it("names the rung and forbids the final answer at every rung", () => {
    for (const rung of HINT_RUNGS) {
      const block = rungConstraint(rung);
      expect(block).toContain(`rung ${rung.rung} of 5 — ${rung.name}`);
      expect(block).toMatch(/NEVER state the final answer/);
    }
  });
});

describe("finalAnswersFor", () => {
  const page = (text: string) => ({ textSummary: text, headings: [], elements: [] }) as unknown as PageSummary;
  it("computes the answer for detected linear equations", () => {
    expect(finalAnswersFor(detectProblem(page("Solve for x: 3x + 5 = 20")))).toEqual(["5"]);
    expect(finalAnswersFor(detectProblem(page("Solve: 2x − 4 = 10")))).toEqual(["7"]);
  });
  it("returns nothing for generic problems (no computable answer)", () => {
    expect(finalAnswersFor(detectProblem(page("What causes the seasons?")))).toEqual([]);
  });
});

describe("leakedAnswer", () => {
  const answers = ["5"];
  it("catches the final answer tied to the unknown or answer nouns", () => {
    expect(leakedAnswer("So x = 5.", answers).leaked).toBe(true);
    expect(leakedAnswer("x=5", answers).leaked).toBe(true);
    expect(leakedAnswer("The answer is 5!", answers).leaked).toBe(true);
    expect(leakedAnswer("the solution: 5", answers).leaked).toBe(true);
    expect(leakedAnswer("divide both sides by 3 and it equals 5", answers).leaked).toBe(true);
  });

  it("catches the bare value as the entire message", () => {
    expect(leakedAnswer("5", answers).leaked).toBe(true);
    expect(leakedAnswer(" 5. ", answers).leaked).toBe(true);
  });

  it("allows problem constants that coincide with the answer value", () => {
    // 3x + 5 = 20 → answer 5, but the 5 here is the constant being moved, not the answer.
    expect(leakedAnswer("Try subtracting 5 from both sides first.", answers).leaked).toBe(false);
    expect(leakedAnswer("What could you do to get rid of the +5?", answers).leaked).toBe(false);
  });

  it("allows intermediate values and different numbers", () => {
    expect(leakedAnswer("After that step you'd have 3x = 15.", answers).leaked).toBe(false);
    expect(leakedAnswer("x = -5 would be wrong here", answers).leaked).toBe(false);
    expect(leakedAnswer("In 2x + 3 = 11 you'd get x = 4.", answers).leaked).toBe(false); // analogous example
  });

  it("stays quiet with no computable answer", () => {
    expect(leakedAnswer("x = 5", []).leaked).toBe(false);
  });

  it("catches leak-by-confirmation of a correct guess, but allows normal tutoring replies", () => {
    expect(leakedAnswer("Yes! Nice work.", answers, { utterance: "is the answer 5? yes or no" }).leaked).toBe(true);
    expect(leakedAnswer("That's right.", answers, { utterance: "so x is 5?" }).leaked).toBe(true);
    // Wrong guess: affirmation can't match (only correct values count) and "not quite" is fine.
    expect(leakedAnswer("Not quite — check your subtraction.", answers, { utterance: "is it 4?" }).leaked).toBe(false);
    expect(leakedAnswer("Yes, that's the right approach.", answers, { utterance: "should I subtract first?" }).leaked).toBe(false);
    // Affirmation without a guessed number in the utterance is not a leak.
    expect(leakedAnswer("Yes, exactly—do both sides.", answers, { utterance: "do I do it to both sides?" }).leaked).toBe(false);
  });
});

describe("worded answers from the step planner", () => {
  it("flags the whole answer phrase, not words that merely overlap with it", () => {
    expect(leakedAnswer("It's called photosynthesis!", ["photosynthesis"]).leaked).toBe(true);
    expect(leakedAnswer("Try this: Add 3 to both sides, then divide by 4.", ["add 3 to both sides, then divide by 4"]).leaked).toBe(true);
    expect(leakedAnswer("What could you add to both sides first?", ["add 3 to both sides, then divide by 4"]).leaked).toBe(false);
    expect(leakedAnswer("What do plants need light for?", ["photosynthesis"]).leaked).toBe(false);
  });
});
