import Papa from "papaparse";
import { QuestionSchema, type QuestionInput } from "@chemarena/shared";

export type ImportTopic = {
  id: string;
  title: string;
  parentId: string | null;
};

export type QuestionImportRow = {
  rowNumber: number;
  question?: QuestionInput;
  issues: string[];
  warnings: string[];
};

function normalizeTitle(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function resolveTopic(record: Record<string, unknown>, topics: ImportTopic[]): string | undefined {
  if (typeof record.topicId === "string") return topics.some((topic) => topic.id === record.topicId) ? record.topicId : undefined;
  const children = topics.filter((topic) => topic.parentId);
  const chapterValue = typeof record.chapter === "string" ? normalizeTitle(record.chapter) : "";
  const outcomeValue = typeof record.outcome === "string"
    ? normalizeTitle(record.outcome)
    : typeof record.topic === "string" ? normalizeTitle(record.topic) : "";

  const exactMatches = children.filter((child) => {
    const parent = topics.find((topic) => topic.id === child.parentId);
    return normalizeTitle(child.title) === outcomeValue
      && (!chapterValue || (parent !== undefined && normalizeTitle(parent.title) === chapterValue));
  });
  if (exactMatches.length === 1) return exactMatches[0]!.id;

  if (!outcomeValue && chapterValue) {
    const parentMatches = topics.filter((topic) => !topic.parentId && normalizeTitle(topic.title) === chapterValue);
    if (parentMatches.length === 1) return parentMatches[0]!.id;
  }
  return undefined;
}

function parseQuestionRecord(
  candidate: unknown,
  index: number,
  topics: ImportTopic[],
  forceDraft: boolean
): QuestionImportRow {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { rowNumber: index + 1, issues: ["Question must be a JSON object."], warnings: [] };
  }
  const record = candidate as Record<string, unknown>;
  const topicId = resolveTopic(record, topics);
  if (!topicId) {
    return { rowNumber: index + 1, issues: ["Chapter/outcome did not match a syllabus topic. Choose an exact topic name."], warnings: [] };
  }
  const shouldForceDraft = forceDraft || (typeof record.topicId !== "string" && record.status === "APPROVED");
  const data = {
    ...record,
    topicId,
    explanation: record.explanation ?? "",
    difficulty: record.difficulty ?? 1,
    tags: record.tags ?? [],
    smiles: record.smiles ?? null,
    imageDataUrl: record.imageDataUrl ?? null,
    status: shouldForceDraft ? "DRAFT" : (record.status ?? "DRAFT")
  };
  const parsed = QuestionSchema.safeParse(data);
  if (!parsed.success) {
    return {
      rowNumber: index + 1,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "question"}: ${issue.message}`),
      warnings: []
    };
  }
  return {
    rowNumber: index + 1,
    question: parsed.data,
    issues: [],
    warnings: shouldForceDraft && record.status === "APPROVED" ? ["Imported as Draft; AI-generated questions are never auto-approved."] : []
  };
}

export function parseQuestionJson(input: string, topics: ImportTopic[], forceDraft = false): QuestionImportRow[] {
  const trimmed = input.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const payload: unknown = JSON.parse(trimmed);
  const candidates = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && "questions" in payload
      ? (payload as { questions: unknown }).questions
      : null;
  if (!Array.isArray(candidates)) throw new Error('JSON must be an array of questions or an object containing a "questions" array.');
  if (!candidates.length) throw new Error("The question list is empty.");
  if (candidates.length > 500) throw new Error("Import a maximum of 500 questions at a time.");
  return candidates.map((candidate, index) => parseQuestionRecord(candidate, index, topics, forceDraft));
}

function parseJsonCell(value: string, column: string, rowNumber: number): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`CSV row ${rowNumber}: "${column}" must contain valid JSON.`);
  }
}

export function parseQuestionCsv(input: string, topics: ImportTopic[]): QuestionImportRow[] {
  const parsed = Papa.parse<string[]>(input.replace(/^\uFEFF/, ""), { skipEmptyLines: true });
  if (parsed.errors.length) throw new Error(parsed.errors[0]?.message ?? "Could not parse the CSV file.");
  const [rawHeaders, ...rows] = parsed.data;
  const headers = rawHeaders?.map((header) => header.trim().toLowerCase()) ?? [];
  if (!headers.length || !rows.length) throw new Error("The CSV must include a header row and at least one question.");
  if (rows.length > 500) throw new Error("Import a maximum of 500 questions at a time.");
  const indexOf = (name: string) => headers.indexOf(name.toLowerCase());
  const cell = (row: string[], name: string) => {
    const index = indexOf(name);
    return index < 0 ? "" : row[index]?.trim() ?? "";
  };

  if (indexOf("topicid") >= 0) {
    const required = ["stem", "options", "correctoptionids", "topicid"];
    const missing = required.filter((name) => indexOf(name) < 0);
    if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(", ")}.`);
    return rows.map((row, index) => {
      const rowNumber = index + 2;
      try {
        const tagsText = cell(row, "tags");
        return parseQuestionRecord({
          stem: cell(row, "stem"),
          type: cell(row, "type") || "SINGLE",
          options: parseJsonCell(cell(row, "options"), "options", rowNumber),
          correctOptionIds: parseJsonCell(cell(row, "correctoptionids"), "correctOptionIds", rowNumber),
          explanation: cell(row, "explanation"),
          topicId: cell(row, "topicid"),
          difficulty: Number(cell(row, "difficulty") || 1),
          tags: tagsText ? parseJsonCell(tagsText, "tags", rowNumber) : [],
          smiles: cell(row, "smiles") || null,
          status: cell(row, "status") || "DRAFT"
        }, rowNumber - 1, topics, false);
      } catch (error) {
        return { rowNumber, issues: [error instanceof Error ? error.message : "Invalid CSV row."], warnings: [] };
      }
    });
  }

  const required = ["chapter", "outcome", "stem", "optiona", "optionb", "correctanswers"];
  const missing = required.filter((name) => indexOf(name) < 0);
  if (missing.length) {
    throw new Error(`CSV needs readable columns: ${required.join(", ")}. Download the question template for an example.`);
  }
  return rows.map((row, index) => {
    const rowNumber = index + 2;
    const options = ["a", "b", "c", "d", "e", "f", "g", "h"]
      .map((id, optionIndex) => ({ id, text: cell(row, `option${String.fromCharCode(97 + optionIndex)}`) }))
      .filter((option) => option.text);
    const answerLetters = cell(row, "correctanswers").split(/[;,|]/).map((answer) => answer.trim().toLowerCase()).filter(Boolean);
    const candidate = {
      chapter: cell(row, "chapter"),
      outcome: cell(row, "outcome"),
      stem: cell(row, "stem"),
      type: cell(row, "type").toUpperCase() || "SINGLE",
      options,
      correctOptionIds: answerLetters,
      explanation: cell(row, "explanation"),
      difficulty: Number(cell(row, "difficulty") || 1),
      tags: cell(row, "tags").split(",").map((tag) => tag.trim()).filter(Boolean),
      smiles: cell(row, "smiles") || null,
      status: "DRAFT"
    };
    return parseQuestionRecord(candidate, rowNumber - 1, topics, true);
  });
}

export function findDuplicateWarnings(
  rows: QuestionImportRow[],
  existingStems: string[]
): QuestionImportRow[] {
  const known = new Set(existingStems.map(normalizeTitle).filter(Boolean));
  const seenInBatch = new Set<string>();
  return rows.map((row) => {
    if (!row.question) return row;
    const stem = normalizeTitle(row.question.stem);
    const warnings = [...row.warnings];
    if (known.has(stem)) warnings.push("Possible duplicate: this question matches a question already in the bank.");
    if (seenInBatch.has(stem)) warnings.push("Possible duplicate: this stem appears earlier in this import batch.");
    seenInBatch.add(stem);
    return { ...row, warnings };
  });
}

export function createQuestionPrompt(topics: ImportTopic[]): string {
  const chapters = topics.filter((topic) => !topic.parentId);
  const syllabus = chapters.map((chapter) => {
    const outcomes = topics.filter((topic) => topic.parentId === chapter.id).map((topic) => `  - ${topic.title}`);
    return `${chapter.title}\n${outcomes.join("\n")}`;
  }).join("\n");
  return `Create a batch of 10 original, accurate, beginner-friendly organic chemistry multiple-choice questions for SS1-SS3 students. Use only the syllabus topics below. Vary difficulty from 1 to 5. Every question must have one clearly defensible correct answer, three plausible but unambiguously incorrect distractors, and a concise explanation. Avoid near-duplicates and trick wording. Do not invent syllabus topics. Return only valid JSON with this exact shape (no markdown):\n{"questions":[{"chapter":"exact chapter title","outcome":"exact learning outcome title","stem":"Question text","type":"SINGLE","options":[{"id":"a","text":"Option A"},{"id":"b","text":"Option B"},{"id":"c","text":"Option C"},{"id":"d","text":"Option D"}],"correctOptionIds":["a"],"explanation":"Why the answer is correct","difficulty":2,"tags":["topic tag"],"smiles":null}]}\nUse exact chapter and outcome wording from this syllabus. For multi-answer questions use type MULTI and list all correct option IDs. Use type TRUE_FALSE only with exactly two options. Questions will be imported as Draft for teacher review.\n\nSYLLABUS:\n${syllabus}`;
}
