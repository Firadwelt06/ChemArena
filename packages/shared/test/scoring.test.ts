import { describe, expect, it } from "vitest";
import {
  AnswerSubmissionSchema,
  ExamInputSchema,
  FinalExamSubmissionSchema,
  hasRole,
  isSameIdempotentPayload,
  isWithinSubmissionWindow,
  scoreAnswer,
  StudentImportSchema,
  TopicInputSchema
} from "../src/index.js";

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

  describe("permissions and idempotency", () => {
    it("allows only matching roles through role guards", () => {
      expect(hasRole("ADMIN", "ADMIN")).toBe(true);
      expect(hasRole("STUDENT", "ADMIN")).toBe(false);
      expect(hasRole(undefined, "STUDENT")).toBe(false);
    });

    it("treats only the same payload as an idempotent replay", () => {
      expect(isSameIdempotentPayload("hash-1", "hash-1")).toBe(true);
      expect(isSameIdempotentPayload("hash-1", "hash-2")).toBe(false);
    });

    it("validates unique CSV usernames before importing", () => {
      const row = { displayName: "Ada Example", username: "ada", classId: "class-1" };
      expect(StudentImportSchema.safeParse({ students: [row] }).success).toBe(true);
      expect(StudentImportSchema.safeParse({ students: [row, row] }).success).toBe(false);
    });

    it("requires exam assignments and exact topic-weight totals", () => {
      const valid = {
        title: "Mock exam", durationMinutes: 30, questionCount: 2,
        manualQuestionIds: [], topicWeights: [{ topicId: "topic-1", count: 2 }], classIds: ["class-1"]
      };
      expect(ExamInputSchema.safeParse(valid).success).toBe(true);
      expect(ExamInputSchema.safeParse({ ...valid, topicWeights: [{ topicId: "topic-1", count: 1 }] }).success).toBe(false);
      expect(ExamInputSchema.safeParse({ ...valid, classIds: [] }).success).toBe(false);
    });

    it("rejects duplicate options in answer submissions", () => {
      const result = AnswerSubmissionSchema.safeParse({
        attemptId: "attempt-1", questionId: "question-1", selectedOptionIds: ["a", "a"],
        idempotencyKey: "ff201d54-7f3b-4c1a-9f3e-34c937ec5320", changedAt: 1
      });
      expect(result.success).toBe(false);
    });

    it("validates frozen final exam snapshots", () => {
      const snapshot = {
        idempotencyKey: "ff201d54-7f3b-4c1a-9f3e-34c937ec5320",
        answers: { "question-1": ["a"], "question-2": [] }
      };
      expect(FinalExamSubmissionSchema.safeParse(snapshot).success).toBe(true);
      expect(FinalExamSubmissionSchema.safeParse({
        ...snapshot,
        answers: { "question-1": ["a", "a"] }
      }).success).toBe(false);
    });

    it("accepts top-level syllabus chapters and child outcomes", () => {
      expect(TopicInputSchema.safeParse({ title: "Hydrocarbons", parentId: null }).success).toBe(true);
      expect(TopicInputSchema.safeParse({ title: "Alkenes", parentId: "chapter-1" }).success).toBe(true);
      expect(TopicInputSchema.safeParse({ title: "  ", parentId: null }).success).toBe(false);
    });
  });
});
