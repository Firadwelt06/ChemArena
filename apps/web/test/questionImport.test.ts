import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import {
  createQuestionPrompt,
  findDuplicateWarnings,
  parseQuestionCsv,
  parseQuestionJson,
  type ImportTopic
} from "../src/questionImport.js";

const topics: ImportTopic[] = [
  { id: "chapter-1", title: "Hydrocarbons and Crude Oil", parentId: null },
  { id: "outcome-1", title: "Origin of crude oil and natural gas", parentId: "chapter-1" },
  { id: "chapter-2", title: "Organic Chemistry", parentId: null },
  { id: "outcome-2", title: "Definition and importance", parentId: "chapter-2" }
];

function question(chapter = "Hydrocarbons and Crude Oil", outcome = "Origin of crude oil and natural gas") {
  return {
    chapter,
    outcome,
    stem: "Which product forms during complete combustion of methane?",
    type: "SINGLE",
    options: [
      { id: "a", text: "Carbon dioxide and water" },
      { id: "b", text: "Carbon and hydrogen" },
      { id: "c", text: "Nitrogen and water" },
      { id: "d", text: "Methanol only" }
    ],
    correctOptionIds: ["a"],
    explanation: "Complete combustion produces carbon dioxide and water.",
    difficulty: 2,
    tags: ["combustion"],
    smiles: null
  };
}

describe("question batch import", () => {
  it("resolves human-readable syllabus paths and stages JSON as Draft", () => {
    const rows = parseQuestionJson(JSON.stringify({ questions: [question()] }), topics, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rowNumber).toBe(1);
    expect(rows[0]?.issues).toEqual([]);
    expect(rows[0]?.question?.topicId).toBe("outcome-1");
    expect(rows[0]?.question?.status).toBe("DRAFT");
  });

  it("reports an unresolved topic without dropping the rest of a batch", () => {
    const rows = parseQuestionJson(JSON.stringify({ questions: [
      question(),
      question("Made-up chapter", "Made-up topic")
    ] }), topics, true);
    expect(rows[0]?.question).toBeDefined();
    expect(rows[1]?.question).toBeUndefined();
    expect(rows[1]?.issues[0]).toContain("did not match");
  });

  it("imports the spreadsheet format with quoted cells and answer letters", () => {
    const csv = Papa.unparse([{
      chapter: "Hydrocarbons and Crude Oil",
      outcome: "Origin of crude oil and natural gas",
      stem: "Which product forms during complete combustion of methane?",
      type: "SINGLE",
      optionA: "Carbon dioxide and water",
      optionB: "Carbon and hydrogen",
      optionC: "Nitrogen and water",
      optionD: "Methanol only",
      correctAnswers: "A",
      explanation: "Complete combustion produces carbon dioxide and water.",
      difficulty: 2,
      tags: "combustion, methane",
      smiles: ""
    }]);
    const rows = parseQuestionCsv(csv, topics);
    expect(rows[0]?.rowNumber).toBe(2);
    expect(rows[0]?.issues).toEqual([]);
    expect(rows[0]?.question?.topicId).toBe("outcome-1");
    expect(rows[0]?.question?.correctOptionIds).toEqual(["a"]);
    expect(rows[0]?.question?.tags).toEqual(["combustion", "methane"]);
    expect(rows[0]?.question?.status).toBe("DRAFT");
  });

  it("supports exact-matching legacy topic IDs from existing CSV exports", () => {
    const csv = Papa.unparse([{
      stem: question().stem,
      type: "SINGLE",
      options: JSON.stringify(question().options),
      correctOptionIds: JSON.stringify(["a"]),
      explanation: question().explanation,
      topicId: "outcome-1",
      difficulty: 2,
      tags: JSON.stringify(["combustion"]),
      smiles: "",
      status: "APPROVED"
    }]);
    const rows = parseQuestionCsv(csv, topics);
    expect(rows[0]?.question?.status).toBe("APPROVED");
  });

  it("flags exact duplicates in the current bank and within the batch", () => {
    const first = parseQuestionJson(JSON.stringify([question(), question()]), topics, true);
    const warnings = findDuplicateWarnings(first, [question("Organic Chemistry", "Definition and importance").stem]);
    expect(warnings[0]?.warnings[0]).toContain("already in the bank");
    expect(warnings[1]?.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("already in the bank"),
      expect.stringContaining("earlier in this import batch")
    ]));
  });

  it("creates an AI prompt using official topic names rather than internal IDs", () => {
    const prompt = createQuestionPrompt(topics);
    expect(prompt).toContain("Hydrocarbons and Crude Oil");
    expect(prompt).toContain("Origin of crude oil and natural gas");
    expect(prompt).not.toContain("chapter-1");
    expect(prompt).toContain("Questions will be imported as Draft");
  });
});
