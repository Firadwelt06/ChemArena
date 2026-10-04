import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  cacheExamPackage,
  flushAnswerOutbox,
  freezeSubmission,
  getCachedAttempt,
  getPendingAnswerCount,
  saveAnswerLocally,
  type ExamPackage
} from "../src/examStore";

function examPackage(attemptId: string): ExamPackage {
  return {
    attemptId,
    exam: { id: `exam-${attemptId}`, title: "Offline test", durationMinutes: 10, marksPerQuestion: 1 },
    startedAt: new Date(0).toISOString(),
    deadline: new Date(600_000).toISOString(),
    serverTime: new Date(0).toISOString(),
    graceSeconds: 60,
    questions: [
      { id: "question-1", stem: "Question", type: "SINGLE", smiles: null, imageDataUrl: null, options: [{ id: "a", text: "Option A" }] },
      { id: "question-2", stem: "Question 2", type: "SINGLE", smiles: null, imageDataUrl: null, options: [{ id: "b", text: "Option B" }] }
    ],
    answers: {}
  };
}

describe("exam answer storage", () => {
  it("persists a package and answer locally before the network is available", async () => {
    const attemptId = "local-first";
    await cacheExamPackage("student-1", examPackage(attemptId));
    await saveAnswerLocally(attemptId, "question-1", ["a"], "00112233-4455-4677-8899-aabbccddeeff");

    const cached = await getCachedAttempt(attemptId);
    expect(cached?.answers).toEqual({ "question-1": ["a"] });
    expect(cached?.examPackage.questions.map(({ id }) => id)).toEqual(["question-1", "question-2"]);
    expect(await getPendingAnswerCount(attemptId)).toBe(1);
  });

  it("retains failed outbox entries and reuses their idempotency key on retry", async () => {
    const attemptId = "retry-outbox";
    await cacheExamPackage("student-1", examPackage(attemptId));
    await saveAnswerLocally(attemptId, "question-1", ["a"], "10112233-4455-4677-8899-aabbccddeeff");
    const sentKeys: string[] = [];

    await expect(flushAnswerOutbox(attemptId, async (entry) => {
      sentKeys.push(entry.idempotencyKey);
      throw new Error("network lost");
    })).rejects.toThrow("network lost");
    expect(await getPendingAnswerCount(attemptId)).toBe(1);

    await flushAnswerOutbox(attemptId, async (entry) => { sentKeys.push(entry.idempotencyKey); });
    expect(sentKeys).toEqual([
      "10112233-4455-4677-8899-aabbccddeeff",
      "10112233-4455-4677-8899-aabbccddeeff"
    ]);
    expect(await getPendingAnswerCount(attemptId)).toBe(0);
  });

  it("freezes one complete final snapshot, including unanswered questions", async () => {
    const attemptId = "frozen-final";
    await cacheExamPackage("student-1", examPackage(attemptId));
    await saveAnswerLocally(attemptId, "question-1", ["a"], "20112233-4455-4677-8899-aabbccddeeff");

    const first = await freezeSubmission(attemptId);
    const retry = await freezeSubmission(attemptId);
    expect(first).toEqual(retry);
    expect(first.answers).toEqual({ "question-1": ["a"], "question-2": [] });
    await expect(saveAnswerLocally(attemptId, "question-1", [], "30112233-4455-4677-8899-aabbccddeeff"))
      .rejects.toThrow("already been submitted");
  });
});
