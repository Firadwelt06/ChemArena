import { describe, expect, it } from "vitest";
import { isWithinSubmissionWindow, scoreAnswer } from "../src/index.js";

describe("scoreAnswer", () => {
  it("awards marks only for an exact match", () => {
    expect(scoreAnswer(["a"], ["a"], 2)).toBe(2);
    expect(scoreAnswer(["a", "b"], ["a"], 2)).toBe(0);
    expect(scoreAnswer(["a"], [], 2)).toBe(0);
  });

  it("applies negative marks only to incorrect non-empty answers", () => {
    expect(scoreAnswer(["a"], ["b"], 2, 0.5)).toBe(-0.5);
    expect(scoreAnswer(["a"], [], 2, 0.5)).toBe(0);
  });
});

describe("isWithinSubmissionWindow", () => {
  const deadline = new Date("2026-01-01T00:00:00.000Z");

  it("accepts the deadline and configured grace boundary", () => {
    expect(isWithinSubmissionWindow(deadline, deadline, 60)).toBe(true);
    expect(isWithinSubmissionWindow(new Date(deadline.getTime() + 60_000), deadline, 60)).toBe(true);
    expect(isWithinSubmissionWindow(new Date(deadline.getTime() + 60_001), deadline, 60)).toBe(false);
  });
});
