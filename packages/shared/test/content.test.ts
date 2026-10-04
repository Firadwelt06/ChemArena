import { describe, expect, it } from "vitest";
import {
  GeneratedQuestionSchema,
  inspectSmiles,
  LessonContentSchema
} from "../src/index.js";

function sampleQuestion(stem: string) {
  return {
    stem,
    type: "SINGLE",
    options: [{ id: "a", text: "Correct" }, { id: "b", text: "Incorrect" }],
    correctOptionIds: ["a"],
    explanation: "Explanation",
    difficulty: 1,
    tags: [],
    smiles: null
  };
}

const validLesson = {
  objectives: ["Identify alkanes"],
  explanationMarkdown: "Alkanes contain only single bonds.",
  workedExamples: [{ problem: "Name CH4.", solution: "Methane." }],
  handsOnActivity: "Build a model with classroom materials.",
  quiz: Array.from({ length: 10 }, (_, index) => sampleQuestion(`Question ${index + 1}`)),
  homework: "Name three alkanes."
};

describe("Phase 3 content validation", () => {
  it("requires exactly ten structurally valid quiz questions in a lesson", () => {
    expect(LessonContentSchema.safeParse(validLesson).success).toBe(true);
    expect(LessonContentSchema.safeParse({ ...validLesson, quiz: validLesson.quiz.slice(0, 9) }).success).toBe(false);
  });

  it("rejects ambiguous question shapes with duplicate option IDs", () => {
    const invalid = {
      ...sampleQuestion("Which answer?"),
      options: [{ id: "a", text: "First" }, { id: "a", text: "Second" }]
    };
    expect(GeneratedQuestionSchema.safeParse(invalid).success).toBe(false);
  });

  it("warns on obvious malformed SMILES while accepting common structures", () => {
    expect(inspectSmiles("CCO")).toEqual([]);
    expect(inspectSmiles("c1ccccc1")).toEqual([]);
    expect(inspectSmiles("C1CC")).toContain("SMILES ring labels should each occur exactly twice.");
    expect(inspectSmiles("C(C")).toContain("SMILES has an unmatched opening parenthesis.");
    expect(inspectSmiles("?")).toContain("SMILES contains an unexpected character.");
  });
});
