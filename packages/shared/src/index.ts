import { z } from "zod";

export const RoleSchema = z.enum(["ADMIN", "STUDENT"]);
export type Role = z.infer<typeof RoleSchema>;

export function hasRole(actualRole: Role | undefined, requiredRole: Role): boolean {
  return actualRole === requiredRole;
}

export const LoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256)
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const StudentImportSchema = z.object({
  students: z.array(z.object({
    displayName: z.string().trim().min(1).max(120),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/),
    classId: z.string().min(1)
  })).min(1).max(500)
}).superRefine(({ students }, context) => {
  const usernames = students.map(({ username }) => username);
  if (new Set(usernames).size !== usernames.length) {
    context.addIssue({ code: "custom", message: "The CSV contains duplicate usernames.", path: ["students"] });
  }
});

export const BrandingSchema = z.object({
  schoolName: z.string().trim().min(1).max(120),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  footerLine: z.string().max(240),
  logoDataUrl: z.string().max(1_000_000).nullable()
});
export type Branding = z.infer<typeof BrandingSchema>;

export const TopicInputSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().max(2_000).default(""),
  parentId: z.string().min(1).nullable().default(null)
});

export const QuestionOptionSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().trim().min(1).max(2_000)
});

export const QuestionSchema = z.object({
  stem: z.string().trim().min(1).max(10_000),
  type: z.enum(["SINGLE", "MULTI", "TRUE_FALSE"]),
  options: z.array(QuestionOptionSchema).min(2).max(8),
  correctOptionIds: z.array(z.string().min(1)).min(1).max(8),
  explanation: z.string().max(10_000),
  topicId: z.string().min(1),
  difficulty: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  smiles: z.string().max(2_000).nullable(),
  imageDataUrl: z.string().max(1_000_000).nullable().default(null),
  status: z.enum(["DRAFT", "APPROVED"]),
  source: z.enum(["manual", "imported", "AI"]).default("manual")
}).superRefine((question, context) => {
  const optionIds = question.options.map((option) => option.id);
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: "custom", message: "Option IDs must be unique.", path: ["options"] });
  }
  if (question.correctOptionIds.some((id) => !optionIds.includes(id))) {
    context.addIssue({ code: "custom", message: "Correct answers must reference an option.", path: ["correctOptionIds"] });
  }
  if (question.type !== "MULTI" && question.correctOptionIds.length !== 1) {
    context.addIssue({ code: "custom", message: "This question type requires exactly one correct answer.", path: ["correctOptionIds"] });
  }
  if (question.type === "TRUE_FALSE" && question.options.length !== 2) {
    context.addIssue({ code: "custom", message: "True/false questions require exactly two options.", path: ["options"] });
  }
});
export type QuestionInput = z.infer<typeof QuestionSchema>;

export const GeneratedQuestionSchema = z.object({
  stem: z.string().trim().min(1).max(10_000),
  type: z.enum(["SINGLE", "MULTI", "TRUE_FALSE"]),
  options: z.array(QuestionOptionSchema).min(2).max(8),
  correctOptionIds: z.array(z.string().min(1)).min(1).max(8),
  explanation: z.string().max(10_000),
  difficulty: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(40)).max(20),
  smiles: z.string().max(2_000).nullable()
}).superRefine((question, context) => {
  const optionIds = question.options.map(({ id }) => id);
  if (new Set(optionIds).size !== optionIds.length) {
    context.addIssue({ code: "custom", message: "Option IDs must be unique.", path: ["options"] });
  }
  if (question.correctOptionIds.some((id) => !optionIds.includes(id)) || new Set(question.correctOptionIds).size !== question.correctOptionIds.length) {
    context.addIssue({ code: "custom", message: "Correct answers must reference distinct options.", path: ["correctOptionIds"] });
  }
  if (question.type !== "MULTI" && question.correctOptionIds.length !== 1) {
    context.addIssue({ code: "custom", message: "This question type requires exactly one correct answer.", path: ["correctOptionIds"] });
  }
  if (question.type === "TRUE_FALSE" && question.options.length !== 2) {
    context.addIssue({ code: "custom", message: "True/false questions require exactly two options.", path: ["options"] });
  }
});

export const GeneratedQuestionBatchSchema = z.object({
  questions: z.array(GeneratedQuestionSchema).min(1).max(20)
});
export type GeneratedQuestion = z.infer<typeof GeneratedQuestionSchema>;

export const LessonQuizQuestionSchema = GeneratedQuestionSchema;

export const LessonContentSchema = z.object({
  objectives: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  explanationMarkdown: z.string().trim().min(1).max(30_000),
  workedExamples: z.array(z.object({
    problem: z.string().trim().min(1).max(4_000),
    solution: z.string().trim().min(1).max(8_000)
  })).min(1).max(8),
  handsOnActivity: z.string().trim().min(1).max(8_000),
  quiz: z.array(LessonQuizQuestionSchema).length(10),
  homework: z.string().trim().min(1).max(8_000)
});
export type LessonContent = z.infer<typeof LessonContentSchema>;

export const LessonSaveSchema = z.object({
  title: z.string().trim().min(1).max(180),
  topicId: z.string().min(1),
  content: LessonContentSchema,
  classIds: z.array(z.string().min(1)).max(100),
  studentIds: z.array(z.string().min(1)).max(500)
}).superRefine((lesson, context) => {
  if (new Set(lesson.classIds).size !== lesson.classIds.length) {
    context.addIssue({ code: "custom", message: "Class assignments must be unique.", path: ["classIds"] });
  }
  if (new Set(lesson.studentIds).size !== lesson.studentIds.length) {
    context.addIssue({ code: "custom", message: "Student assignments must be unique.", path: ["studentIds"] });
  }
});

export const LessonGenerationRequestSchema = z.object({
  topicId: z.string().min(1)
});

export const QuestionGenerationRequestSchema = z.object({
  topicId: z.string().min(1),
  count: z.number().int().min(1).max(20)
});

export function inspectSmiles(smiles: string | null): string[] {
  if (!smiles) return [];
  const warnings: string[] = [];
  let parentheses = 0;
  let brackets = 0;
  const ringCounts = new Map<string, number>();
  for (let index = 0; index < smiles.length; index += 1) {
    const character = smiles[index]!;
    if (character === "(") parentheses += 1;
    if (character === ")" && --parentheses < 0) {
      warnings.push("SMILES has an unmatched closing parenthesis.");
      break;
    }
    if (character === "[") brackets += 1;
    if (character === "]" && --brackets < 0) {
      warnings.push("SMILES has an unmatched closing bracket.");
      break;
    }
    if (brackets > 0) continue;
    if (character === "%" && /^\d{2}/.test(smiles.slice(index + 1, index + 3))) {
      const ring = smiles.slice(index + 1, index + 3);
      ringCounts.set(ring, (ringCounts.get(ring) ?? 0) + 1);
      index += 2;
    } else if (/\d/.test(character)) {
      ringCounts.set(character, (ringCounts.get(character) ?? 0) + 1);
    } else if (!/[A-Za-z0-9()\[\]@+\-\\/=.#:*%]/.test(character)) {
      warnings.push("SMILES contains an unexpected character.");
      break;
    }
  }
  if (parentheses > 0) warnings.push("SMILES has an unmatched opening parenthesis.");
  if (brackets > 0) warnings.push("SMILES has an unmatched opening bracket.");
  if ([...ringCounts.values()].some((count) => count !== 2)) warnings.push("SMILES ring labels should each occur exactly twice.");
  if (!/(?:Cl|Br|[BCNOFPSI]|[bcnops]|\[[^\]]+\]|\*)/.test(smiles)) {
    warnings.push("SMILES may not contain a recognizable atom.");
  }
  return [...new Set(warnings)];
}

export const AnswerSubmissionSchema = z.object({
  attemptId: z.string().min(1),
  questionId: z.string().min(1),
  selectedOptionIds: z.array(z.string().min(1)).max(8),
  idempotencyKey: z.string().uuid(),
  changedAt: z.number().int().nonnegative()
}).superRefine(({ selectedOptionIds }, context) => {
  if (new Set(selectedOptionIds).size !== selectedOptionIds.length) {
    context.addIssue({ code: "custom", message: "Selected options must be unique.", path: ["selectedOptionIds"] });
  }
});

export const FinalExamSubmissionSchema = z.object({
  idempotencyKey: z.string().uuid(),
  answers: z.record(z.string(), z.array(z.string().min(1)).max(8))
}).superRefine(({ answers }, context) => {
  if (Object.keys(answers).length > 200) {
    context.addIssue({ code: "custom", message: "An exam submission cannot contain more than 200 answers.", path: ["answers"] });
  }
  for (const [questionId, selectedOptionIds] of Object.entries(answers)) {
    if (!questionId || new Set(selectedOptionIds).size !== selectedOptionIds.length) {
      context.addIssue({ code: "custom", message: "Answer question IDs and selected options must be unique and valid.", path: ["answers", questionId] });
    }
  }
});

export function isSameIdempotentPayload(existingHash: string, requestHash: string): boolean {
  return existingHash === requestHash;
}

export const ExamInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2_000).default(""),
  durationMinutes: z.number().int().min(1).max(480),
  questionCount: z.number().int().min(1).max(200),
  manualQuestionIds: z.array(z.string().min(1)).max(200).default([]),
  topicWeights: z.array(z.object({
    topicId: z.string().min(1),
    count: z.number().int().min(1).max(200)
  })).max(100).default([]),
  difficultyMin: z.number().int().min(1).max(5).default(1),
  difficultyMax: z.number().int().min(1).max(5).default(5),
  shuffleQuestions: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  marksPerQuestion: z.number().min(0).max(100).default(1),
  negativeMarking: z.boolean().default(false),
  negativeMarks: z.number().min(0).max(100).default(0),
  opensAt: z.string().datetime().nullable().default(null),
  closesAt: z.string().datetime().nullable().default(null),
  classIds: z.array(z.string().min(1)).max(100).default([]),
  studentIds: z.array(z.string().min(1)).max(500).default([])
}).superRefine((exam, context) => {
  if (exam.difficultyMin > exam.difficultyMax) {
    context.addIssue({ code: "custom", message: "Minimum difficulty cannot exceed maximum difficulty.", path: ["difficultyMin"] });
  }
  if (exam.manualQuestionIds.length > 0 && exam.manualQuestionIds.length !== exam.questionCount) {
    context.addIssue({ code: "custom", message: "Manual question selection must match the requested question count.", path: ["manualQuestionIds"] });
  }
  if (exam.manualQuestionIds.length === 0 && exam.topicWeights.length === 0) {
    context.addIssue({ code: "custom", message: "Select questions manually or set topic weights.", path: ["topicWeights"] });
  }
  if (exam.topicWeights.length > 0 && exam.topicWeights.reduce((total, item) => total + item.count, 0) !== exam.questionCount) {
    context.addIssue({ code: "custom", message: "Topic weights must add up to the question count.", path: ["topicWeights"] });
  }
  if (exam.opensAt && exam.closesAt && new Date(exam.opensAt) >= new Date(exam.closesAt)) {
    context.addIssue({ code: "custom", message: "The exam closing time must be after its opening time.", path: ["closesAt"] });
  }
  if (!exam.classIds.length && !exam.studentIds.length) {
    context.addIssue({ code: "custom", message: "Assign the exam to at least one class or student.", path: ["classIds"] });
  }
});

export function scoreAnswer(correctOptionIds: string[], selectedOptionIds: string[], marks: number, negativeMarks = 0): number {
  const correct = new Set(correctOptionIds);
  const selected = new Set(selectedOptionIds);
  const isExactMatch = correct.size === selected.size && [...correct].every((id) => selected.has(id));
  if (isExactMatch) return marks;
  if (selected.size === 0 || negativeMarks <= 0) return 0;
  return -negativeMarks;
}

export function isWithinSubmissionWindow(now: Date, deadline: Date, graceSeconds: number): boolean {
  return now.getTime() <= deadline.getTime() + graceSeconds * 1_000;
}
