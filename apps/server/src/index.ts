import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import argon2 from "argon2";
import { PrismaClient, Role, RecordStatus } from "@prisma/client";
import {
  AnswerSubmissionSchema, BrandingSchema, ExamInputSchema, FinalExamSubmissionSchema, GeneratedQuestionBatchSchema,
  hasRole, inspectSmiles, isSameIdempotentPayload, LessonContentSchema, LessonGenerationRequestSchema, LessonSaveSchema,
  LoginSchema, QuestionGenerationRequestSchema, QuestionSchema, scoreAnswer, StudentImportSchema, TopicInputSchema
} from "@chemarena/shared";

const prisma = new PrismaClient();
const app = Fastify({ logger: true, trustProxy: false, bodyLimit: 2_000_000 });
function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return parsed;
}

const port = integerSetting("PORT", 4174, 1, 65_535);
const host = process.env.HOST ?? "0.0.0.0";
const sessionDurationMs = 12 * 60 * 60 * 1_000;
const sessionCookie = "chemarena_session";
const submissionGraceSeconds = integerSetting("SUBMISSION_GRACE_SECONDS", 60, 0, 300);
const automaticBackupIntervalMinutes = integerSetting("AUTO_BACKUP_INTERVAL_MINUTES", 15, 1, 1_440);
const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
const openAiModel = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
const configuredGeminiModel = process.env.GEMINI_MODEL?.trim();
const geminiModel = !configuredGeminiModel
  || ["gemini-1.5", "gemini-2.5-flash", "gemini-2.5-flash-lite"].includes(configuredGeminiModel)
  ? "gemini-flash-lite-latest"
  : configuredGeminiModel;
const configuredAiProviders = process.env.AI_PROVIDERS?.split(",").map((provider) => provider.trim().toLowerCase()).filter(Boolean);
const availableAiProviders = [
  ...(geminiApiKey ? ["gemini"] : []),
  ...(openAiApiKey ? ["openai"] : [])
];
const aiProviders = configuredAiProviders?.length
  ? [...new Set([...configuredAiProviders, ...availableAiProviders])]
  : availableAiProviders;
let automaticBackupTimer: ReturnType<typeof setInterval> | undefined;
let automaticBackupInProgress = false;
let backupQueue: Promise<void> = Promise.resolve();
let finalSubmissionQueue: Promise<void> = Promise.resolve();
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(moduleDirectory, path.basename(path.dirname(moduleDirectory)) === "dist" ? "../.." : "..");
const backupDirectory = process.env.BACKUP_DIRECTORY?.trim()
  ? path.resolve(process.env.BACKUP_DIRECTORY)
  : path.resolve(serverDirectory, "../../backups");

function databaseFilePath(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith("file:")) throw new Error("DATABASE_URL must use a SQLite file: URL.");
  const relativePath = decodeURIComponent(databaseUrl.slice("file:".length).split("?")[0] ?? "");
  return path.isAbsolute(relativePath) ? path.resolve(relativePath) : path.resolve(serverDirectory, "prisma", relativePath);
}

function safeSqliteLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

async function serializeFinalSubmission<T>(submit: () => Promise<T>): Promise<T> {
  const previous = finalSubmissionQueue;
  let release!: () => void;
  finalSubmissionQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await submit();
  } finally {
    release();
  }
}

function backupName(kind: "manual" | "auto"): string {
  return `chemarena-${kind}-${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(3).toString("hex")}.db`;
}

class OpenAiProviderError extends Error {}

const generatedQuestionJsonSchema = {
  type: "object",
  properties: {
    stem: { type: "string" },
    type: { type: "string", enum: ["SINGLE", "MULTI", "TRUE_FALSE"] },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false
      }
    },
    correctOptionIds: { type: "array", items: { type: "string" } },
    explanation: { type: "string" },
    difficulty: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    smiles: { type: ["string", "null"] }
  },
  required: ["stem", "type", "options", "correctOptionIds", "explanation", "difficulty", "tags", "smiles"],
  additionalProperties: false
} as const;

const lessonContentJsonSchema = {
  type: "object",
  properties: {
    objectives: { type: "array", items: { type: "string" } },
    explanationMarkdown: { type: "string" },
    workedExamples: {
      type: "array",
      items: {
        type: "object",
        properties: { problem: { type: "string" }, solution: { type: "string" } },
        required: ["problem", "solution"],
        additionalProperties: false
      }
    },
    handsOnActivity: { type: "string" },
    quiz: {
      type: "array",
      items: generatedQuestionJsonSchema
    },
    homework: { type: "string" }
  },
  required: ["objectives", "explanationMarkdown", "workedExamples", "handsOnActivity", "quiz", "homework"],
  additionalProperties: false
} as const;

async function requestOpenAiJson(
  name: string,
  schema: object,
  instructions: string,
  input: string
): Promise<unknown> {
  if (!openAiApiKey) throw new OpenAiProviderError("OpenAI is not configured. Set OPENAI_API_KEY on the server, or use the paste-JSON workflow.");
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${openAiApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: openAiModel,
        messages: [{ role: "system", content: instructions }, { role: "user", content: input }],
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
      }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "The AI request timed out." : "The AI service could not be reached.";
    app.log.warn({ err: error }, reason);
    throw new OpenAiProviderError(reason);
  }
  const payload = await response.json().catch(() => null) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
  } | null;
  if (!response.ok) {
    const message = payload?.error?.message;
    app.log.warn({ statusCode: response.status, providerMessage: message }, "OpenAI content generation request failed.");
    throw new OpenAiProviderError(message ? `OpenAI rejected the request: ${message}` : `OpenAI returned HTTP ${response.status}.`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new OpenAiProviderError("The AI service returned no structured content.");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new OpenAiProviderError("The AI service returned malformed JSON.");
  }
}

function duplicateQuestionWarnings(stem: string, existingStems: string[], batchStems: Set<string>): string[] {
  const normalized = stem.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const warnings = ["Review chemistry accuracy and confirm there is only one defensible correct answer."];
  if (existingStems.some((existing) => existing.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === normalized)
    || batchStems.has(normalized)) {
    warnings.push("Possible duplicate: this stem matches an existing question or another generated item.");
  }
  batchStems.add(normalized);
  return warnings;
}

// --- Multi-provider AI helpers (OpenAI + Gemini) ---
// requestGeminiJson: best-effort adapter for Google Gemini / Generative Language API
async function requestGeminiJson(name: string, schema: object, instructions: string, input: string): Promise<unknown> {
  if (!geminiApiKey) throw new OpenAiProviderError("Gemini is not configured. Set GEMINI_API_KEY on the server, or use the paste-JSON workflow.");
  const model = geminiModel.replace(/^models\//, "");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
  const prompt = `${instructions}\n\n${input}\n\nReturn only JSON matching this schema named "${name}":\n${JSON.stringify(schema)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
      }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "The AI request timed out." : "The AI service could not be reached.";
    app.log.warn({ err: error }, reason);
    throw new OpenAiProviderError(reason);
  }
  const body = await response.json().catch(() => null) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  } | null;
  if (!response.ok) {
    const message = body?.error?.message;
    app.log.warn({ statusCode: response.status, providerMessage: message }, "Gemini content generation request failed.");
    throw new OpenAiProviderError(message ? `Gemini rejected the request: ${message}` : `Gemini returned HTTP ${response.status}.`);
  }
  const text = body?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new OpenAiProviderError("Gemini returned no structured content.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenAiProviderError("Gemini returned malformed JSON.");
  }
}

// requestAiJson: try configured providers in order
async function requestAiJson(name: string, schema: object, instructions: string, input: string): Promise<unknown> {
  const errors: Array<{ provider: string; message: string }> = [];
  for (const provider of aiProviders) {
    try {
      if (provider === "openai") {
        const result = await requestOpenAiJson(name, schema, instructions, input);
        return result;
      }
      if (provider === "gemini") {
        const result = await requestGeminiJson(name, schema, instructions, input);
        return result;
      }
      app.log.info({ provider }, "Unknown AI provider configured; skipping.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ provider, message: msg });
      app.log.warn({ provider, err: msg }, "AI provider failed; trying next provider if any.");
    }
  }
  if (errors.length) {
    const last = errors.at(-1);
    if (!last) {
      throw new OpenAiProviderError("All AI providers failed, but no provider details were recorded.");
    }
    throw new OpenAiProviderError(`All AI providers failed. Last: ${last.provider}: ${last.message}`);
  }
  throw new OpenAiProviderError("No AI provider configured. Set AI_PROVIDERS and provider API keys in apps/server/.env.");
}

function createSqliteBackup(kind: "manual" | "auto"): Promise<string> {
  const operation = backupQueue.then(async () => {
    await mkdir(backupDirectory, { recursive: true });
    const filename = backupName(kind);
    const destination = path.join(backupDirectory, filename);
    await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(FULL)");
    await prisma.$executeRawUnsafe(`VACUUM INTO '${safeSqliteLiteral(destination)}'`);
    return filename;
  });
  backupQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function pruneAutomaticBackups(): Promise<void> {
  const filenames = await readdir(backupDirectory);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  await Promise.all(filenames
    .filter((filename) => /^chemarena-auto-[0-9T.Za-f-]+\.db$/.test(filename))
    .map(async (filename) => {
      const filePath = path.join(backupDirectory, filename);
      const info = await stat(filePath);
      if (info.mtimeMs < cutoff) await rm(filePath);
    }));
}

type AuthenticatedRequest = FastifyRequest & {
  auth?: { userId: string; role: Role; csrfToken: string; sessionId: string; mustChangePassword: boolean };
};

function publicUser(user: { id: string; username: string; displayName: string; role: Role; mustChangePassword: boolean }) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    mustChangePassword: user.mustChangePassword
  };
}

function readCookie(request: FastifyRequest): string | undefined {
  return request.cookies[sessionCookie];
}

function shuffleArray<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomBytes(4).readUInt32BE(0) % (index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

async function authenticate(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
  const sessionId = readCookie(request);
  if (!sessionId) {
    reply.code(401).send({ error: "Authentication required." });
    return;
  }
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: true }
  });
  if (!session || session.expiresAt <= new Date() || session.user.status !== RecordStatus.ACTIVE) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    reply.clearCookie(sessionCookie, { path: "/" }).code(401).send({ error: "Session expired. Please sign in again." });
    return;
  }
  request.auth = {
    userId: session.userId,
    role: session.user.role,
    csrfToken: session.csrfToken,
    sessionId: session.id,
    mustChangePassword: session.user.mustChangePassword
  };
  if (Date.now() - session.lastSeenAt.getTime() >= 10_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
}

async function requireAdmin(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply);
  if (reply.sent) return;
  const auth = request.auth;
  if (!auth || !hasRole(auth.role, Role.ADMIN)) {
    reply.code(403).send({ error: "Administrator permission required." });
    return;
  }
  if (auth.mustChangePassword) {
    reply.code(403).send({ error: "Change your temporary password before continuing." });
  }
}

async function requireStudent(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply);
  if (reply.sent) return;
  const auth = request.auth;
  if (!auth || !hasRole(auth.role, Role.STUDENT)) {
    reply.code(403).send({ error: "Student permission required." });
    return;
  }
  if (auth.mustChangePassword) {
    reply.code(403).send({ error: "Change your temporary password before continuing." });
  }
}

async function requireCsrf(request: AuthenticatedRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply);
  if (reply.sent) return;
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string" || supplied !== request.auth?.csrfToken) {
    reply.code(403).send({ error: "CSRF validation failed." });
  }
}

async function audit(actorId: string, action: string, entityType: string, entityId?: string, details: unknown = {}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      details: JSON.stringify(details)
    }
  });
}

function captureQuestionSnapshot(question: {
  stem: string;
  options: string;
  correctOptionIds: string;
  explanation: string;
  topic: { id: string; title: string; parentId: string | null };
}): string {
  return JSON.stringify({
    stem: question.stem,
    options: JSON.parse(question.options),
    correctOptionIds: JSON.parse(question.correctOptionIds),
    explanation: question.explanation,
    topicId: question.topic.id,
    topicTitle: question.topic.title,
    topicParentId: question.topic.parentId
  });
}

async function backfillHistoricalQuestionSnapshots(): Promise<void> {
  const answers = await prisma.answer.findMany({
    where: { questionSnapshot: null, attempt: { status: "GRADED" } }
  });
  const questions = await prisma.question.findMany({
    where: { id: { in: [...new Set(answers.map((answer) => answer.questionId))] } },
    include: { topic: { select: { id: true, title: true, parentId: true } } }
  });
  const questionById = new Map(questions.map((question) => [question.id, question]));
  for (let offset = 0; offset < answers.length; offset += 100) {
    const batch = answers.slice(offset, offset + 100);
    const updates = batch.map((answer) => {
      const question = questionById.get(answer.questionId);
      if (!question) throw new Error(`Cannot preserve historical answer ${answer.id}: its question is missing.`);
      return prisma.answer.update({
        where: { id: answer.id },
        data: { questionSnapshot: captureQuestionSnapshot(question) }
      });
    });
    await prisma.$transaction(updates);
  }
}

async function gradedSummary(attemptId: string) {
  const attempt = await prisma.examAttempt.findUnique({
    where: { id: attemptId },
    include: { exam: true, answers: true }
  });
  if (!attempt || attempt.status !== "GRADED") throw new Error("Graded attempt not found.");
  const questionIds = JSON.parse(attempt.questionOrder) as string[];
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, topicId: true, correctOptionIds: true }
  });
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const answerMap = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
  const breakdown = new Map<string, { topicId: string; correct: number; total: number; score: number }>();
  for (const questionId of questionIds) {
    const question = questionMap.get(questionId);
    if (!question) continue;
    const answer = answerMap.get(questionId);
    const snapshot = answer?.questionSnapshot
      ? JSON.parse(answer.questionSnapshot) as { correctOptionIds: string[]; topicId: string }
      : null;
    const earned = scoreAnswer(
      snapshot?.correctOptionIds ?? JSON.parse(question.correctOptionIds) as string[],
      answer ? JSON.parse(answer.selectedOptionIds) as string[] : [],
      attempt.exam.marksPerQuestion,
      attempt.exam.negativeMarking ? attempt.exam.negativeMarks : 0
    );
    const topicId = snapshot?.topicId ?? question.topicId;
    const topicScore = breakdown.get(topicId) ?? { topicId, correct: 0, total: 0, score: 0 };
    topicScore.total += 1;
    topicScore.score += earned;
    if (earned > 0) topicScore.correct += 1;
    breakdown.set(topicId, topicScore);
  }
  const topics = await prisma.topic.findMany({
    where: { id: { in: [...breakdown.keys()] } },
    select: { id: true, title: true, parentId: true }
  });
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  return {
    id: attempt.id,
    status: "GRADED",
    score: attempt.score ?? 0,
    maxScore: questionIds.length * attempt.exam.marksPerQuestion,
    topicBreakdown: [...breakdown.values()].map((entry) => ({ ...entry, topic: topicMap.get(entry.topicId) }))
  };
}

async function ensureBranding(): Promise<void> {
  const defaults = {
    schoolName: "ChemArena",
    primaryColor: "#193b6a",
    accentColor: "#16a085",
    footerLine: "Learn, practise, compete.",
    logoDataUrl: null
  };
  await prisma.setting.upsert({
    where: { key: "branding" },
    update: {},
    create: { key: "branding", value: JSON.stringify(defaults) }
  });
}

app.register(cookie);
app.register(rateLimit, { global: false });

app.get("/api/health", async () => {
  await prisma.$queryRawUnsafe("SELECT 1");
  return { ok: true, serverTime: new Date() };
});

app.get("/api/auth/csrf", async (request, reply) => {
  const sessionId = readCookie(request);
  if (!sessionId) return reply.code(401).send({ error: "Sign in to continue." });
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.expiresAt <= new Date()) return reply.code(401).send({ error: "Session expired." });
  return { csrfToken: session.csrfToken };
});

app.post("/api/auth/login", {
  config: {
    rateLimit: {
      max: 8,
      timeWindow: "15 minutes",
      keyGenerator: (request) => `${request.ip}:${String((request.body as { username?: string })?.username ?? "").toLowerCase()}`
    }
  }
}, async (request, reply) => {
  const parsed = LoginSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid username and password." });
  const user = await prisma.user.findUnique({ where: { username: parsed.data.username.toLowerCase() } });
  if (!user || user.status !== RecordStatus.ACTIVE || !(await argon2.verify(user.passwordHash, parsed.data.password))) {
    return reply.code(401).send({ error: "Incorrect username or password." });
  }
  const sessionId = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDurationMs);
  await prisma.session.create({ data: { id: sessionId, csrfToken, userId: user.id, expiresAt } });
  reply.setCookie(sessionCookie, sessionId, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
    expires: expiresAt
  });
  await audit(user.id, "auth.login", "User", user.id);
  return { user: publicUser(user), csrfToken };
});

app.post("/api/auth/logout", { preHandler: requireCsrf }, async (request: AuthenticatedRequest, reply) => {
  await prisma.session.delete({ where: { id: request.auth!.sessionId } });
  reply.clearCookie(sessionCookie, { path: "/" });
  return { ok: true };
});

app.post("/api/auth/heartbeat", { preHandler: [requireCsrf] }, async (request: AuthenticatedRequest) => {
  const lastSeenAt = new Date();
  await prisma.session.update({ where: { id: request.auth!.sessionId }, data: { lastSeenAt } });
  return { ok: true, lastSeenAt };
});

app.get("/api/auth/me", async (request, reply) => {
  const sessionId = readCookie(request);
  if (!sessionId) return { user: null };
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || session.user.status !== RecordStatus.ACTIVE) {
    if (session) await prisma.session.delete({ where: { id: session.id } });
    reply.clearCookie(sessionCookie, { path: "/" });
    return { user: null };
  }
  return { user: publicUser(session.user) };
});

app.post("/api/auth/change-password", { preHandler: requireCsrf }, async (request: AuthenticatedRequest, reply) => {
  const body = request.body as { currentPassword?: unknown; newPassword?: unknown };
  if (typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 10 || body.newPassword.length > 256) {
    return reply.code(400).send({ error: "New password must be between 10 and 256 characters." });
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: request.auth!.userId } });
  if (!(await argon2.verify(user.passwordHash, body.currentPassword))) {
    return reply.code(400).send({ error: "Current password is incorrect." });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await argon2.hash(body.newPassword), mustChangePassword: false }
  });
  await prisma.session.deleteMany({ where: { userId: user.id, id: { not: request.auth!.sessionId } } });
  await audit(user.id, "auth.password_changed", "User", user.id);
  return { ok: true };
});

app.get("/api/settings/branding", async () => {
  const record = await prisma.setting.findUnique({ where: { key: "branding" } });
  if (!record) throw new Error("Branding setting was not initialized.");
  return JSON.parse(record.value);
});

app.put("/api/admin/settings/branding", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = BrandingSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid branding settings." });
  await prisma.setting.upsert({
    where: { key: "branding" },
    update: { value: JSON.stringify(parsed.data) },
    create: { key: "branding", value: JSON.stringify(parsed.data) }
  });
  await audit(request.auth!.userId, "settings.branding_updated", "Setting", "branding");
  return parsed.data;
});

app.get("/api/admin/dashboard", { preHandler: requireAdmin }, async () => {
  const [studentCount, classCount, questionCount, activeExams, attempts] = await Promise.all([
    prisma.user.count({ where: { role: Role.STUDENT, status: RecordStatus.ACTIVE } }),
    prisma.class.count({ where: { status: RecordStatus.ACTIVE } }),
    prisma.question.count({ where: { status: "APPROVED" } }),
    prisma.exam.count({ where: { status: "ACTIVE", isPractice: false } }),
    prisma.examAttempt.count({ where: { status: "IN_PROGRESS", exam: { isPractice: false } } })
  ]);
  return { studentCount, classCount, questionCount, activeExams, attempts };
});

app.get("/api/admin/analytics", { preHandler: requireAdmin }, async () => {
  const [attempts, auditLog] = await Promise.all([
    prisma.examAttempt.findMany({
      where: { status: "GRADED", exam: { isPractice: false } },
      include: {
        exam: { select: { marksPerQuestion: true } },
        user: { select: { id: true, username: true, displayName: true, enrollments: { select: { class: { select: { id: true, name: true } } } } } },
        answers: true
      },
      orderBy: { submittedAt: "desc" }
    }),
    prisma.auditLog.findMany({
      include: { actor: { select: { username: true, displayName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100
    })
  ]);
  const questionIds = [...new Set(attempts.flatMap((attempt) => JSON.parse(attempt.questionOrder) as string[]))];
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, stem: true, correctOptionIds: true, topic: { select: { id: true, title: true } }, options: true }
  });
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const leaderboard = new Map<string, {
    id: string;
    username: string;
    displayName: string;
    attempts: number;
    totalPercent: number;
    classes: Map<string, string>;
    latestSubmittedAt: Date | null;
  }>();
  const heatmap = new Map<string, {
    classId: string;
    className: string;
    topicId: string;
    topicTitle: string;
    correct: number;
    total: number;
  }>();
  const itemAnalysis = new Map<string, {
    questionId: string;
    stem: string;
    topicTitle: string;
    attempts: number;
    correct: number;
    options: Map<string, number>;
    optionLabels: Record<string, string>;
  }>();
  for (const attempt of attempts) {
    const questionOrder = JSON.parse(attempt.questionOrder) as string[];
    const denominator = questionOrder.length * attempt.exam.marksPerQuestion;
    const percent = denominator > 0 ? Math.max(0, Math.min(100, ((attempt.score ?? 0) / denominator) * 100)) : 0;
    const student = leaderboard.get(attempt.user.id) ?? {
      id: attempt.user.id,
      username: attempt.user.username,
      displayName: attempt.user.displayName,
      attempts: 0,
      totalPercent: 0,
      classes: new Map<string, string>(),
      latestSubmittedAt: attempt.submittedAt
    };
    student.attempts += 1;
    student.totalPercent += percent;
    attempt.user.enrollments.forEach(({ class: record }) => student.classes.set(record.id, record.name));
    leaderboard.set(attempt.user.id, student);
    const answers = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
    for (const questionId of questionOrder) {
      const question = questionById.get(questionId);
      if (!question) continue;
      const answer = answers.get(questionId);
      const selected = answer ? JSON.parse(answer.selectedOptionIds) as string[] : [];
      const snapshot = answer?.questionSnapshot ? JSON.parse(answer.questionSnapshot) as {
        stem: string;
        options: Array<{ id: string; text: string }>;
        correctOptionIds: string[];
        topicId: string;
        topicTitle: string;
      } : null;
      const correctIds = snapshot?.correctOptionIds ?? JSON.parse(question.correctOptionIds) as string[];
      const topicId = snapshot?.topicId ?? question.topic.id;
      const topicTitle = snapshot?.topicTitle ?? question.topic.title;
      const isCorrect = selected.length === correctIds.length && correctIds.every((id) => selected.includes(id));
      const item = itemAnalysis.get(questionId) ?? {
        questionId,
        stem: snapshot?.stem ?? question.stem,
        topicTitle,
        attempts: 0,
        correct: 0,
        options: new Map<string, number>(),
        optionLabels: Object.fromEntries((snapshot?.options ?? JSON.parse(question.options) as Array<{ id: string; text: string }>).map((option) => [option.id, option.text]))
      };
      item.attempts += 1;
      if (isCorrect) item.correct += 1;
      selected.forEach((optionId) => item.options.set(optionId, (item.options.get(optionId) ?? 0) + 1));
      itemAnalysis.set(questionId, item);
      for (const enrollment of attempt.user.enrollments) {
        const record = enrollment.class;
        const key = `${record.id}:${topicId}`;
        const cell = heatmap.get(key) ?? {
          classId: record.id,
          className: record.name,
          topicId,
          topicTitle,
          correct: 0,
          total: 0
        };
        cell.total += 1;
        if (isCorrect) cell.correct += 1;
        heatmap.set(key, cell);
      }
    }
  }
  return {
    leaderboard: [...leaderboard.values()]
      .map(({ totalPercent, classes, ...student }) => ({
        ...student,
        averagePercent: student.attempts ? Math.round(totalPercent / student.attempts) : 0,
        classes: [...classes.values()].sort()
      }))
      .sort((left, right) => right.averagePercent - left.averagePercent || left.displayName.localeCompare(right.displayName)),
    heatmap: [...heatmap.values()].map((cell) => ({ ...cell, accuracy: Math.round((cell.correct / cell.total) * 100) })),
    itemAnalysis: [...itemAnalysis.values()]
      .map(({ options, ...item }) => ({
        ...item,
        accuracy: Math.round((item.correct / item.attempts) * 100),
        optionSelections: Object.fromEntries(options)
      }))
      .sort((left, right) => right.attempts - left.attempts),
    auditLog: auditLog.map((event) => ({
      id: event.id,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      details: event.details,
      createdAt: event.createdAt,
      actor: event.actor
    }))
  };
});

app.get("/api/admin/classes", { preHandler: requireAdmin }, async () =>
  prisma.class.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { enrollments: true } } } })
);

app.post("/api/admin/classes", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const body = request.body as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) return reply.code(400).send({ error: "Class name must be between 1 and 80 characters." });
  try {
    const created = await prisma.class.create({ data: { name } });
    await audit(request.auth!.userId, "class.created", "Class", created.id, { name });
    return reply.code(201).send(created);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) return reply.code(409).send({ error: "A class with that name already exists." });
    throw error;
  }
});

app.patch("/api/admin/classes/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { name?: unknown; status?: unknown };
  const data: { name?: string; status?: RecordStatus } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return reply.code(400).send({ error: "Invalid class name." });
    data.name = body.name.trim();
  }
  if (body.status !== undefined) {
    if (body.status !== "ACTIVE" && body.status !== "INACTIVE") return reply.code(400).send({ error: "Invalid class status." });
    data.status = body.status;
  }
  const updated = await prisma.class.update({ where: { id }, data });
  await audit(request.auth!.userId, "class.updated", "Class", id, data);
  return updated;
});

app.get("/api/admin/students", { preHandler: requireAdmin }, async () =>
  prisma.user.findMany({
    where: { role: Role.STUDENT },
    select: { id: true, username: true, displayName: true, status: true, createdAt: true, enrollments: { include: { class: true } } },
    orderBy: { displayName: "asc" }
  })
);

app.post("/api/admin/students", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const body = request.body as { username?: unknown; displayName?: unknown; classId?: unknown };
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!/^[a-z0-9._-]{3,64}$/.test(username) || !displayName || displayName.length > 120) {
    return reply.code(400).send({ error: "Enter a valid username and display name." });
  }
  if (typeof body.classId !== "string" || !(await prisma.class.findUnique({ where: { id: body.classId, status: "ACTIVE" } }))) {
    return reply.code(400).send({ error: "Choose an active class." });
  }
  const temporaryPassword = randomBytes(6).toString("base64url").slice(0, 8);
  const student = await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash: await argon2.hash(temporaryPassword),
      mustChangePassword: true,
      role: Role.STUDENT,
      enrollments: { create: { classId: body.classId } }
    }
  });
  await audit(request.auth!.userId, "student.created", "User", student.id, { username });
  return reply.code(201).send({ student: publicUser(student), temporaryPassword });
});

app.post("/api/admin/students/import", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = StudentImportSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid student list." });
  const rows = parsed.data.students;
  const existing = await prisma.user.findMany({
    where: { username: { in: rows.map(({ username }) => username) } },
    select: { username: true }
  });
  if (existing.length) return reply.code(409).send({ error: `Username already exists: ${existing[0]!.username}` });
  const classIds = [...new Set(rows.map(({ classId }) => classId))];
  const activeClasses = await prisma.class.findMany({
    where: { id: { in: classIds }, status: RecordStatus.ACTIVE },
    select: { id: true }
  });
  if (activeClasses.length !== classIds.length) return reply.code(400).send({ error: "One or more rows reference an inactive or unknown class." });
  const credentials = await Promise.all(rows.map(async (row) => {
    const temporaryPassword = randomBytes(6).toString("base64url").slice(0, 8);
    return {
      username: row.username,
      displayName: row.displayName,
      classId: row.classId,
      passwordHash: await argon2.hash(temporaryPassword),
      temporaryPassword
    };
  }));
  await prisma.$transaction(credentials.map((credential) => prisma.user.create({
    data: {
      username: credential.username,
      displayName: credential.displayName,
      passwordHash: credential.passwordHash,
      mustChangePassword: true,
      role: Role.STUDENT,
      enrollments: { create: { classId: credential.classId } }
    }
  })));
  await audit(request.auth!.userId, "students.imported", "User", undefined, { count: credentials.length });
  return reply.code(201).send({
    imported: credentials.map(({ username, displayName, classId, temporaryPassword }) => ({ username, displayName, classId, temporaryPassword }))
  });
});

app.patch("/api/admin/students/:id/status", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { status?: unknown };
  if (body.status !== "ACTIVE" && body.status !== "INACTIVE") return reply.code(400).send({ error: "Invalid student status." });
  const student = await prisma.user.update({ where: { id, role: Role.STUDENT }, data: { status: body.status } });
  if (body.status === "INACTIVE") await prisma.session.deleteMany({ where: { userId: id } });
  await audit(request.auth!.userId, "student.status_changed", "User", id, { status: body.status });
  return publicUser(student);
});

app.delete("/api/admin/students/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const student = await prisma.user.findFirst({
    where: { id, role: Role.STUDENT },
    select: { id: true, username: true, displayName: true }
  });
  if (!student) return reply.code(404).send({ error: "Student not found." });
  const deletedAttempts = await prisma.examAttempt.count({ where: { userId: id } });
  await prisma.$transaction(async (transaction) => {
    await transaction.examAttempt.deleteMany({ where: { userId: id } });
    await transaction.user.delete({ where: { id, role: Role.STUDENT } });
  });
  await audit(request.auth!.userId, "student.permanently_deleted", "User", id, {
    username: student.username,
    displayName: student.displayName,
    deletedAttempts
  });
  return { ok: true, deletedAttempts };
});

app.post("/api/admin/students/:id/reset-password", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const temporaryPassword = randomBytes(6).toString("base64url").slice(0, 8);
  const student = await prisma.user.update({
    where: { id, role: Role.STUDENT },
    data: { passwordHash: await argon2.hash(temporaryPassword), mustChangePassword: true }
  });
  await prisma.session.deleteMany({ where: { userId: id } });
  await audit(request.auth!.userId, "student.password_reset", "User", id);
  return { student: publicUser(student), temporaryPassword };
});

app.get("/api/topics", { preHandler: authenticate }, async () => prisma.topic.findMany({ orderBy: [{ sourceOrder: "asc" }, { title: "asc" }] }));

app.post("/api/admin/topics", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = TopicInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid topic." });
  if (parsed.data.parentId) {
    const parent = await prisma.topic.findUnique({ where: { id: parsed.data.parentId } });
    if (!parent || parent.parentId) return reply.code(400).send({ error: "Choose a chapter as the parent topic." });
  }
  const sourceOrder = parsed.data.parentId
    ? (await prisma.topic.aggregate({ where: { parentId: parsed.data.parentId }, _max: { sourceOrder: true } }))._max.sourceOrder ?? 0
    : (await prisma.topic.aggregate({ where: { parentId: null }, _max: { sourceOrder: true } }))._max.sourceOrder ?? 0;
  const topic = await prisma.topic.create({ data: { ...parsed.data, sourceOrder: sourceOrder + 1 } });
  await audit(request.auth!.userId, "topic.created", "Topic", topic.id, { title: topic.title, parentId: topic.parentId });
  return reply.code(201).send(topic);
});

app.put("/api/admin/topics/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const parsed = TopicInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid topic." });
  const existing = await prisma.topic.findUnique({ where: { id } });
  if (!existing) return reply.code(404).send({ error: "Topic not found." });
  if (parsed.data.parentId === id || (parsed.data.parentId && !(await prisma.topic.findFirst({ where: { id: parsed.data.parentId, parentId: null } })))) {
    return reply.code(400).send({ error: "Choose a different chapter as the parent topic." });
  }
  if (existing.parentId === null && parsed.data.parentId) {
    return reply.code(400).send({ error: "A chapter cannot be moved beneath another topic." });
  }
  const topic = await prisma.topic.update({ where: { id }, data: parsed.data });
  await audit(request.auth!.userId, "topic.updated", "Topic", id, { title: topic.title, parentId: topic.parentId });
  return topic;
});

app.delete("/api/admin/topics/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const topic = await prisma.topic.findUnique({ where: { id } });
  if (!topic) return reply.code(404).send({ error: "Topic not found." });
  const [children, questions, lessons] = await Promise.all([
    prisma.topic.count({ where: { parentId: id } }),
    prisma.question.count({ where: { topicId: id } }),
    prisma.lesson.count({ where: { topicId: id } })
  ]);
  if (children || questions || lessons) return reply.code(409).send({ error: "This topic has child topics or tagged content; move or remove them before deleting." });
  await prisma.topic.delete({ where: { id } });
  await audit(request.auth!.userId, "topic.deleted", "Topic", id, { title: topic.title });
  return reply.code(204).send();
});

app.get("/api/admin/coverage", { preHandler: requireAdmin }, async () => {
  const topics = await prisma.topic.findMany({ orderBy: [{ sourceOrder: "asc" }, { title: "asc" }] });
  const coverage = await Promise.all(topics.map(async (topic) => {
    const [questions, lessons] = await Promise.all([
      prisma.question.count({ where: { topicId: topic.id, status: "APPROVED" } }),
      prisma.lesson.count({ where: { topicId: topic.id, publishedVersion: { not: null }, status: { not: "ARCHIVED" } } })
    ]);
    return { ...topic, approvedQuestions: questions, publishedLessons: lessons };
  }));
  return coverage;
});

app.get("/api/admin/ai/status", { preHandler: requireAdmin }, async () => {
  const providers = aiProviders.flatMap((provider) => {
    if (provider === "openai" && openAiApiKey) return [{ id: provider, model: openAiModel }];
    if (provider === "gemini" && geminiApiKey) return [{ id: provider, model: geminiModel }];
    return [];
  });
  const primary = providers[0];
  return {
    configured: providers.length > 0,
    provider: primary?.id ?? null,
    model: primary?.model ?? null,
    providers
  };
});

app.post("/api/admin/ai/lessons", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = LessonGenerationRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid lesson generation request." });
  const topic = await prisma.topic.findUnique({ where: { id: parsed.data.topicId }, include: { parent: true } });
  if (!topic) return reply.code(404).send({ error: "Syllabus topic not found." });
  try {
    const generated = await requestAiJson(
      "beginner_chemistry_lesson",
      lessonContentJsonSchema,
      "You write accurate, beginner-friendly organic chemistry lessons for SS1-SS3 students. Focus on the supplied syllabus topic. Give clear objectives, a structured markdown explanation with safe LaTeX math, worked examples, a low-cost safe classroom activity, exactly ten original four-option MCQ quiz items with one defensible correct answer and explanations, and homework. Avoid unsupported claims or unsafe chemical handling. Every quiz item must have a concise explanation. Return only the requested JSON.",
      `Create a complete lesson for the learning outcome "${topic.title}" under "${topic.parent?.title ?? topic.title}". Topic description: ${topic.description || "No additional description."}`
    );
    const validated = LessonContentSchema.safeParse(generated);
    if (!validated.success) return reply.code(502).send({ error: "The AI response did not match the lesson format. Try again or use the paste-JSON editor.", details: validated.error.issues.slice(0, 8) });
    return {
      title: topic.title,
      topicId: topic.id,
      content: validated.data,
      reviewWarnings: ["AI-generated content may contain errors. Review every explanation and quiz answer before publishing."]
    };
  } catch (error) {
    if (error instanceof OpenAiProviderError) return reply.code(502).send({ error: error.message });
    throw error;
  }
});

app.post("/api/admin/ai/questions", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = QuestionGenerationRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid question generation request." });
  const topic = await prisma.topic.findUnique({ where: { id: parsed.data.topicId }, include: { parent: true } });
  if (!topic) return reply.code(404).send({ error: "Syllabus topic not found." });
  try {
    const generated = await requestAiJson(
      "beginner_chemistry_questions",
      {
        type: "object",
        properties: {
          questions: { type: "array", items: generatedQuestionJsonSchema }
        },
        required: ["questions"],
        additionalProperties: false
      },
      "You write accurate, original, beginner-friendly organic chemistry competition MCQs for SS1-SS3 students. Each single-answer question must have exactly one defensible correct answer and plausible but clearly incorrect distractors. Explain the answer, avoid ambiguous wording and near-duplicates, and do not invent syllabus topics. Return only the requested JSON.",
      `Create exactly ${parsed.data.count} questions for "${topic.title}" under "${topic.parent?.title ?? topic.title}". Topic description: ${topic.description || "No additional description."} Return a mix of useful difficulty levels from 1 to 5.`
    );
    const validated = GeneratedQuestionBatchSchema.safeParse(generated);
    if (!validated.success || validated.data.questions.length !== parsed.data.count) {
      return reply.code(502).send({ error: "The AI response did not match the requested question format. Try again or use the paste-JSON workflow.", details: validated.success ? [] : validated.error.issues.slice(0, 8) });
    }
    const existingStems = (await prisma.question.findMany({ select: { stem: true } })).map(({ stem }) => stem);
    const batchStems = new Set<string>();
    const questions = validated.data.questions.map((item) => {
      const question = QuestionSchema.parse({
        ...item,
        topicId: topic.id,
        imageDataUrl: null,
        status: "DRAFT",
        source: "AI"
      });
      return {
        question,
        warnings: [
          ...duplicateQuestionWarnings(question.stem, existingStems, batchStems),
          ...inspectSmiles(question.smiles)
        ]
      };
    });
    return { questions };
  } catch (error) {
    if (error instanceof OpenAiProviderError) return reply.code(502).send({ error: error.message });
    throw error;
  }
});

app.get("/api/admin/lessons", { preHandler: requireAdmin }, async () => {
  const lessons = await prisma.lesson.findMany({
    include: {
      topic: true,
      versions: { orderBy: { version: "desc" }, take: 1 },
      classAssignments: { include: { class: { select: { id: true, name: true } } } },
      studentAssignments: { include: { user: { select: { id: true, displayName: true, username: true } } } }
    },
    orderBy: { updatedAt: "desc" }
  });
  return lessons.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    topicId: lesson.topicId,
    topic: lesson.topic,
    status: lesson.status,
    currentVersion: lesson.currentVersion,
    publishedVersion: lesson.publishedVersion,
    content: lesson.versions[0] ? JSON.parse(lesson.versions[0].content) : null,
    classAssignments: lesson.classAssignments.map(({ class: classRecord }) => classRecord),
    studentAssignments: lesson.studentAssignments.map(({ user }) => user),
    updatedAt: lesson.updatedAt
  }));
});

app.post("/api/admin/lessons", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = LessonSaveSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid lesson." });
  const data = parsed.data;
  const topic = await prisma.topic.findUnique({ where: { id: data.topicId } });
  if (!topic) return reply.code(400).send({ error: "Choose a valid syllabus topic." });
  const [classes, students] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: data.classIds }, status: "ACTIVE" }, select: { id: true } }),
    prisma.user.findMany({ where: { id: { in: data.studentIds }, role: Role.STUDENT, status: RecordStatus.ACTIVE }, select: { id: true } })
  ]);
  if (classes.length !== data.classIds.length || students.length !== data.studentIds.length) {
    return reply.code(400).send({ error: "Assignments must reference active classes and students." });
  }
  const lesson = await prisma.lesson.create({
    data: {
      title: data.title,
      topicId: data.topicId,
      versions: { create: { version: 1, content: JSON.stringify(data.content) } },
      classAssignments: { create: data.classIds.map((classId) => ({ classId })) },
      studentAssignments: { create: data.studentIds.map((userId) => ({ userId })) }
    }
  });
  await audit(request.auth!.userId, "lesson.created", "Lesson", lesson.id, { topicId: lesson.topicId });
  return reply.code(201).send({ id: lesson.id, currentVersion: lesson.currentVersion, status: lesson.status });
});

app.put("/api/admin/lessons/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const parsed = LessonSaveSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid lesson." });
  const data = parsed.data;
  const [existing, topic, classes, students] = await Promise.all([
    prisma.lesson.findUnique({ where: { id } }),
    prisma.topic.findUnique({ where: { id: data.topicId } }),
    prisma.class.findMany({ where: { id: { in: data.classIds }, status: "ACTIVE" }, select: { id: true } }),
    prisma.user.findMany({ where: { id: { in: data.studentIds }, role: Role.STUDENT, status: RecordStatus.ACTIVE }, select: { id: true } })
  ]);
  if (!existing) return reply.code(404).send({ error: "Lesson not found." });
  if (!topic) return reply.code(400).send({ error: "Choose a valid syllabus topic." });
  if (existing.status === "ARCHIVED") return reply.code(409).send({ error: "Archived lessons cannot be edited." });
  if (classes.length !== data.classIds.length || students.length !== data.studentIds.length) {
    return reply.code(400).send({ error: "Assignments must reference active classes and students." });
  }
  const currentVersion = await prisma.lessonVersion.findUnique({
    where: { lessonId_version: { lessonId: id, version: existing.currentVersion } }
  });
  const content = JSON.stringify(data.content);
  const nextVersion = currentVersion?.content === content ? existing.currentVersion : existing.currentVersion + 1;
  await prisma.$transaction(async (transaction) => {
    if (nextVersion !== existing.currentVersion) {
      await transaction.lessonVersion.create({ data: { lessonId: id, version: nextVersion, content } });
    }
    await transaction.lesson.update({
      where: { id },
      data: {
        title: data.title,
        topicId: data.topicId,
        currentVersion: nextVersion,
        classAssignments: {
          deleteMany: {},
          create: data.classIds.map((classId) => ({ classId }))
        },
        studentAssignments: {
          deleteMany: {},
          create: data.studentIds.map((userId) => ({ userId }))
        }
      }
    });
  });
  await audit(request.auth!.userId, "lesson.updated", "Lesson", id, { topicId: data.topicId, version: nextVersion });
  return { id, currentVersion: nextVersion };
});

app.post("/api/admin/lessons/:id/publish", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const lesson = await prisma.lesson.findUnique({ where: { id }, include: { classAssignments: true, studentAssignments: true } });
  if (!lesson) return reply.code(404).send({ error: "Lesson not found." });
  if (lesson.status === "ARCHIVED") return reply.code(409).send({ error: "Archived lessons cannot be published." });
  if (!lesson.classAssignments.length && !lesson.studentAssignments.length) {
    return reply.code(400).send({ error: "Assign the lesson to at least one class or student before publishing." });
  }
  await prisma.lesson.update({
    where: { id },
    data: { status: "PUBLISHED", publishedVersion: lesson.currentVersion }
  });
  await audit(request.auth!.userId, "lesson.published", "Lesson", id, { version: lesson.currentVersion });
  return { id, status: "PUBLISHED", publishedVersion: lesson.currentVersion };
});

app.post("/api/admin/lessons/:id/archive", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const lesson = await prisma.lesson.update({ where: { id }, data: { status: "ARCHIVED" } });
  await audit(request.auth!.userId, "lesson.archived", "Lesson", id);
  return { id: lesson.id, status: lesson.status };
});

async function findPublishedLessonForStudent(lessonId: string, userId: string) {
  const enrollments = await prisma.enrollment.findMany({ where: { userId }, select: { classId: true } });
  return prisma.lesson.findFirst({
    where: {
      id: lessonId,
      status: "PUBLISHED",
      publishedVersion: { not: null },
      OR: [
        { classAssignments: { some: { classId: { in: enrollments.map(({ classId }) => classId) } } } },
        { studentAssignments: { some: { userId } } }
      ]
    }
  });
}

app.get("/api/student/lessons", { preHandler: requireStudent }, async (request: AuthenticatedRequest) => {
  const enrollments = await prisma.enrollment.findMany({ where: { userId: request.auth!.userId }, select: { classId: true } });
  const lessons = await prisma.lesson.findMany({
    where: {
      status: "PUBLISHED",
      publishedVersion: { not: null },
      OR: [
        { classAssignments: { some: { classId: { in: enrollments.map(({ classId }) => classId) } } } },
        { studentAssignments: { some: { userId: request.auth!.userId } } }
      ]
    },
    include: {
      topic: true,
      progress: { where: { userId: request.auth!.userId }, select: { completedAt: true } }
    },
    orderBy: { updatedAt: "desc" }
  });
  return lessons.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    topic: lesson.topic,
    version: lesson.publishedVersion,
    completedAt: lesson.progress[0]?.completedAt ?? null
  }));
});

app.get("/api/student/lessons/:id", { preHandler: requireStudent }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const lesson = await findPublishedLessonForStudent(id, request.auth!.userId);
  if (!lesson || lesson.publishedVersion === null) return reply.code(404).send({ error: "Lesson not found." });
  const [version, progress] = await Promise.all([
    prisma.lessonVersion.findUnique({ where: { lessonId_version: { lessonId: id, version: lesson.publishedVersion } } }),
    prisma.lessonProgress.findUnique({ where: { lessonId_userId: { lessonId: id, userId: request.auth!.userId } } })
  ]);
  if (!version) return reply.code(500).send({ error: "The published lesson version is missing." });
  return {
    id: lesson.id,
    title: lesson.title,
    topicId: lesson.topicId,
    content: LessonContentSchema.parse(JSON.parse(version.content)),
    version: version.version,
    completedAt: progress?.completedAt ?? null
  };
});

app.post("/api/student/lessons/:id/complete", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const lesson = await findPublishedLessonForStudent(id, request.auth!.userId);
  if (!lesson) return reply.code(404).send({ error: "Lesson not found." });
  const progress = await prisma.lessonProgress.upsert({
    where: { lessonId_userId: { lessonId: id, userId: request.auth!.userId } },
    create: { lessonId: id, userId: request.auth!.userId },
    update: { completedAt: new Date() }
  });
  return { completedAt: progress.completedAt };
});

app.get("/api/admin/questions", { preHandler: requireAdmin }, async (request) => {
  const query = request.query as { topicId?: string; status?: string; difficulty?: string; search?: string };
  const questions = await prisma.question.findMany({
    where: {
      ...(query.topicId ? { topicId: query.topicId } : {}),
      ...(query.status === "DRAFT" || query.status === "APPROVED" ? { status: query.status } : {}),
      ...(query.difficulty && /^[1-5]$/.test(query.difficulty) ? { difficulty: Number(query.difficulty) } : {}),
      ...(query.search ? { stem: { contains: query.search } } : {})
    },
    include: { topic: true },
    orderBy: { updatedAt: "desc" },
    take: 500
  });
  return questions.map((question) => ({
    ...question,
    options: JSON.parse(question.options),
    correctOptionIds: JSON.parse(question.correctOptionIds),
    tags: JSON.parse(question.tags)
  }));
});

app.post("/api/admin/questions", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = QuestionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid question." });
  const q = parsed.data;
  const created = await prisma.question.create({
    data: {
      stem: q.stem, type: q.type, options: JSON.stringify(q.options), correctOptionIds: JSON.stringify(q.correctOptionIds),
      explanation: q.explanation, topicId: q.topicId, difficulty: q.difficulty, tags: JSON.stringify(q.tags),
      smiles: q.smiles, imageDataUrl: q.imageDataUrl, status: q.status, source: q.source
    }
  });
  await audit(request.auth!.userId, "question.created", "Question", created.id, { status: q.status, topicId: q.topicId });
  return reply.code(201).send({ ...created, options: q.options, correctOptionIds: q.correctOptionIds, tags: q.tags });
});

app.post("/api/admin/questions/import", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const body = request.body as { questions?: unknown };
  if (!Array.isArray(body.questions) || body.questions.length > 500) return reply.code(400).send({ error: "Upload a list of at most 500 questions." });
  const records = body.questions.map((candidate) => QuestionSchema.safeParse(candidate));
  const invalid = records.findIndex((record) => !record.success);
  if (invalid !== -1) return reply.code(400).send({ error: `Question ${invalid + 1} is invalid.`, details: records[invalid]?.success === false ? records[invalid].error.issues : [] });
  const parsed = records.map((record) => (record as { success: true; data: typeof QuestionSchema._type }).data);
  const topicIds = new Set((await prisma.topic.findMany({ select: { id: true } })).map(({ id }) => id));
  const unknownTopic = parsed.findIndex(({ topicId }) => !topicIds.has(topicId));
  if (unknownTopic !== -1) return reply.code(400).send({ error: `Question ${unknownTopic + 1} references an unknown topic.` });
  await prisma.$transaction(parsed.map((question) => prisma.question.create({
    data: {
      stem: question.stem,
      type: question.type,
      options: JSON.stringify(question.options),
      correctOptionIds: JSON.stringify(question.correctOptionIds),
      explanation: question.explanation,
      topicId: question.topicId,
      difficulty: question.difficulty,
      tags: JSON.stringify(question.tags),
      smiles: question.smiles,
      imageDataUrl: question.imageDataUrl,
      status: question.status,
      source: question.source
    }
  })));
  await audit(request.auth!.userId, "questions.imported", "Question", undefined, { count: parsed.length });
  return reply.code(201).send({ imported: parsed.length });
});

// Batch approve imported questions (fast path): accepts { ids: string[] } and marks those DRAFT -> APPROVED
app.post("/api/admin/questions/batch-approve", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const body = request.body as { ids?: unknown };
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500
    || body.ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)) {
    return reply.code(400).send({ error: "Provide between 1 and 500 valid question IDs." });
  }
  const ids = [...new Set(body.ids as string[])];
  const updated = await prisma.question.updateMany({ where: { id: { in: ids }, status: "DRAFT" }, data: { status: "APPROVED" } });
  await audit(request.auth!.userId, "questions.batch_approved", "Question", undefined, { count: updated.count });
  return reply.code(200).send({ approved: updated.count });
});

app.get("/api/admin/question-issues", { preHandler: requireAdmin }, async (request) => {
  const query = request.query as { status?: string };
  return prisma.questionIssue.findMany({
    where: query.status === "OPEN" || query.status === "RESOLVED" || query.status === "DISMISSED"
      ? { status: query.status }
      : {},
    include: {
      user: { select: { id: true, username: true, displayName: true } },
      attempt: { select: { exam: { select: { title: true } }, attemptNumber: true } },
      question: { select: { id: true, stem: true, topic: { select: { id: true, title: true } } } }
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 500
  });
});

app.patch("/api/admin/question-issues/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Provide a valid report update." });
  }
  const body = request.body as { status?: unknown; adminNote?: unknown };
  if (body.status !== "OPEN" && body.status !== "RESOLVED" && body.status !== "DISMISSED") {
    return reply.code(400).send({ error: "Choose OPEN, RESOLVED or DISMISSED." });
  }
  if (body.adminNote !== undefined && (typeof body.adminNote !== "string" || body.adminNote.length > 1000)) {
    return reply.code(400).send({ error: "Admin notes must be at most 1000 characters." });
  }
  const issue = await prisma.questionIssue.update({
    where: { id },
    data: { status: body.status, ...(body.adminNote !== undefined ? { adminNote: body.adminNote.trim() } : {}) }
  });
  await audit(request.auth!.userId, "question_issue.status_changed", "QuestionIssue", id, { status: issue.status });
  return issue;
});

app.delete("/api/admin/questions/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const usedByAttempt = await prisma.examItem.count({
    where: { questionId: id, exam: { attempts: { some: {} } } }
  });
  if (usedByAttempt) return reply.code(409).send({ error: "This question is part of an exam attempt and cannot be deleted; archive it instead." });
  const question = await prisma.question.findUnique({ where: { id }, select: { id: true } });
  if (!question) return reply.code(404).send({ error: "Question not found." });
  await prisma.$transaction([
    prisma.examItem.deleteMany({ where: { questionId: id } }),
    prisma.question.delete({ where: { id } })
  ]);
  await audit(request.auth!.userId, "question.deleted", "Question", id);
  return reply.code(204).send();
});

app.get("/api/admin/questions/:id", { preHandler: requireAdmin }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const question = await prisma.question.findUnique({ where: { id }, include: { topic: true } });
  if (!question) return reply.code(404).send({ error: "Question not found." });
  return {
    ...question,
    options: JSON.parse(question.options),
    correctOptionIds: JSON.parse(question.correctOptionIds),
    tags: JSON.parse(question.tags)
  };
});

app.put("/api/admin/questions/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const parsed = QuestionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid question." });
  const activeExamUse = await prisma.examItem.count({
    where: { questionId: id, exam: { attempts: { some: { status: { in: ["IN_PROGRESS", "SUBMITTED"] } } } } }
  });
  if (activeExamUse) {
    return reply.code(409).send({ error: "This question is in an active exam. Wait for its attempts to finish before editing it so grading stays consistent." });
  }
  const q = parsed.data;
  const updated = await prisma.question.update({
    where: { id },
    data: {
      stem: q.stem, type: q.type, options: JSON.stringify(q.options), correctOptionIds: JSON.stringify(q.correctOptionIds),
      explanation: q.explanation, topicId: q.topicId, difficulty: q.difficulty, tags: JSON.stringify(q.tags),
      smiles: q.smiles, imageDataUrl: q.imageDataUrl, status: q.status, source: q.source
    }
  });
  await audit(request.auth!.userId, "question.updated", "Question", id, { status: q.status });
  return { ...updated, options: q.options, correctOptionIds: q.correctOptionIds, tags: q.tags };
});

app.post("/api/admin/exams", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = ExamInputSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid exam settings." });
  const input = parsed.data;
  const questionIds = input.manualQuestionIds;
  if (questionIds.length > 0) {
    const approved = await prisma.question.findMany({ where: { id: { in: questionIds }, status: "APPROVED" }, select: { id: true } });
    if (approved.length !== questionIds.length) return reply.code(400).send({ error: "Manual selection includes a missing or unapproved question." });
  }
  const exam = await prisma.exam.create({
    data: {
      title: input.title,
      description: input.description,
      durationMinutes: input.durationMinutes,
      questionCount: input.questionCount,
      selectionRules: JSON.stringify({
        topicWeights: input.topicWeights,
        difficultyMin: input.difficultyMin,
        difficultyMax: input.difficultyMax
      }),
      shuffleQuestions: input.shuffleQuestions,
      shuffleOptions: input.shuffleOptions,
      marksPerQuestion: input.marksPerQuestion,
      negativeMarking: input.negativeMarking,
      negativeMarks: input.negativeMarking ? input.negativeMarks : 0,
      opensAt: input.opensAt ? new Date(input.opensAt) : null,
      closesAt: input.closesAt ? new Date(input.closesAt) : null,
      status: "SCHEDULED",
      classes: { create: input.classIds.map((classId) => ({ classId })) },
      students: { create: input.studentIds.map((userId) => ({ userId })) },
      items: { create: questionIds.map((questionId, position) => ({ questionId, position })) }
    }
  });
  await audit(request.auth!.userId, "exam.created", "Exam", exam.id, { title: exam.title, questionCount: exam.questionCount });
  return reply.code(201).send(exam);
});

app.get("/api/admin/exams", { preHandler: requireAdmin }, async () =>
  prisma.exam.findMany({
    where: { isPractice: false },
    orderBy: { createdAt: "desc" },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
      items: { select: { id: true } },
      _count: { select: { attempts: true } }
    }
  })
);

app.post("/api/admin/exams/:examId/students/:userId/retakes", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { examId, userId } = request.params as { examId: string; userId: string };
  const [exam, student] = await Promise.all([
    prisma.exam.findUnique({ where: { id: examId }, include: { classes: { select: { classId: true } }, students: { select: { userId: true } } } }),
    prisma.user.findFirst({ where: { id: userId, role: Role.STUDENT, status: RecordStatus.ACTIVE }, select: { id: true } })
  ]);
  if (!exam || !student) return reply.code(404).send({ error: "Exam or active student not found." });
  if (exam.status !== "SCHEDULED" && exam.status !== "ACTIVE") {
    return reply.code(409).send({ error: "Retakes can only be granted while the exam is scheduled or active." });
  }
  if (exam.closesAt && exam.closesAt < new Date()) {
    return reply.code(409).send({ error: "This exam's availability window has ended." });
  }
  const enrollments = await prisma.enrollment.findMany({ where: { userId }, select: { classId: true } });
  const assigned = exam.students.some((record) => record.userId === userId)
    || exam.classes.some(({ classId }) => enrollments.some((enrollment) => enrollment.classId === classId));
  if (!assigned) return reply.code(400).send({ error: "This student is not assigned to the exam." });
  if (!(await prisma.examAttempt.count({ where: { examId, userId } }))) {
    return reply.code(409).send({ error: "A student must complete an attempt before a rewrite can be granted." });
  }
  if (await prisma.examAttempt.findFirst({ where: { examId, userId, status: "IN_PROGRESS" } })) {
    return reply.code(409).send({ error: "This student already has an in-progress attempt." });
  }
  const grant = await prisma.examRetakeGrant.upsert({
    where: { examId_userId: { examId, userId } },
    create: { examId, userId, remainingAttempts: 1 },
    update: { remainingAttempts: { increment: 1 } }
  });
  await audit(request.auth!.userId, "exam_retake.granted", "Exam", examId, { userId, remainingAttempts: grant.remainingAttempts });
  return { remainingAttempts: grant.remainingAttempts };
});

app.delete("/api/admin/exams/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const exam = await prisma.exam.findUnique({
    where: { id },
    select: { id: true, title: true, _count: { select: { attempts: true } } }
  });
  if (!exam) return reply.code(404).send({ error: "Exam not found." });
  await prisma.$transaction(async (transaction) => {
    await transaction.examAttempt.deleteMany({ where: { examId: id } });
    await transaction.exam.delete({ where: { id } });
  });
  await audit(request.auth!.userId, "exam.permanently_deleted", "Exam", id, {
    title: exam.title,
    deletedAttempts: exam._count.attempts
  });
  return { ok: true, deletedAttempts: exam._count.attempts };
});

app.patch("/api/admin/exams/:id/status", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { status?: unknown };
  if (body.status !== "SCHEDULED" && body.status !== "CLOSED" && body.status !== "VOID") {
    return reply.code(400).send({ error: "Choose SCHEDULED, CLOSED or VOID." });
  }
  const exam = await prisma.exam.update({ where: { id }, data: { status: body.status } });
  await audit(request.auth!.userId, "exam.status_changed", "Exam", id, { status: body.status });
  return exam;
});

app.get("/api/admin/exams/:id/monitor", { preHandler: requireAdmin }, async (request, reply) => {
  const { id } = request.params as { id: string };
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      classes: { select: { classId: true } },
      students: { select: { userId: true } }
    }
  });
  if (!exam) return reply.code(404).send({ error: "Exam not found." });
  const assignedUsers = new Map<string, { id: string; username: string; displayName: string }>();
  const classIds = exam.classes.map(({ classId }) => classId);
  const individualUserIds = exam.students.map(({ userId }) => userId);
  const assignedRows = await prisma.user.findMany({
    where: {
      role: Role.STUDENT,
      status: RecordStatus.ACTIVE,
      OR: [
        { enrollments: { some: { classId: { in: classIds } } } },
        { id: { in: individualUserIds } }
      ]
    },
    select: { id: true, username: true, displayName: true }
  });
  assignedRows.forEach((user) => assignedUsers.set(user.id, user));
  const userIds = [...assignedUsers.keys()];
  const now = Date.now();
  const [attempts, sessions, retakeGrants] = await Promise.all([
    prisma.examAttempt.findMany({
      where: { examId: id },
      include: { _count: { select: { answers: true } } },
      orderBy: { attemptNumber: "asc" }
    }),
    prisma.session.findMany({ where: { userId: { in: userIds }, expiresAt: { gt: new Date() } }, select: { userId: true, lastSeenAt: true } }),
    prisma.examRetakeGrant.findMany({ where: { examId: id, userId: { in: userIds } }, select: { userId: true, remainingAttempts: true } })
  ]);
  const attemptByUser = new Map(attempts.map((attempt) => [attempt.userId, attempt]));
  const attemptCountByUser = new Map<string, number>();
  attempts.forEach((attempt) => attemptCountByUser.set(attempt.userId, (attemptCountByUser.get(attempt.userId) ?? 0) + 1));
  const retakesByUser = new Map(retakeGrants.map((grant) => [grant.userId, grant.remainingAttempts]));
  const recentSessions = new Set(sessions.filter((session) => now - session.lastSeenAt.getTime() < 45_000).map(({ userId }) => userId));
  return [...assignedUsers.values()].map((user) => {
    const attempt = attemptByUser.get(user.id);
    const active = attempt?.status === "IN_PROGRESS";
    return {
      id: attempt?.id ?? null,
      user,
      status: attempt?.status ?? "NOT_STARTED",
      attemptNumber: attempt?.attemptNumber ?? null,
      attemptsTaken: attemptCountByUser.get(user.id) ?? 0,
      retakesRemaining: retakesByUser.get(user.id) ?? 0,
      joined: recentSessions.has(user.id) || (active && now - attempt.lastSeenAt.getTime() < 45_000),
      startedAt: attempt?.startedAt ?? null,
      deadline: attempt?.deadline ?? null,
      submittedAt: attempt?.submittedAt ?? null,
      answeredCount: attempt?._count.answers ?? 0,
      questionCount: attempt ? (JSON.parse(attempt.questionOrder) as string[]).length : exam.questionCount,
      online: recentSessions.has(user.id) || (active && now - attempt.lastSeenAt.getTime() < 45_000)
    };
  });
});

app.post("/api/admin/attempts/:id/extend", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { minutes?: unknown };
  if (typeof body.minutes !== "number" || !Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 240) {
    return reply.code(400).send({ error: "Extension must be a whole number of minutes from 1 to 240." });
  }
  const current = await prisma.examAttempt.findUnique({ where: { id } });
  if (!current || current.status !== "IN_PROGRESS") return reply.code(404).send({ error: "Active attempt not found." });
  const attempt = await prisma.examAttempt.update({
    where: { id },
    data: { deadline: new Date(current.deadline.getTime() + body.minutes * 60_000) }
  });
  await audit(request.auth!.userId, "exam_attempt.extended", "ExamAttempt", id, { minutes: body.minutes });
  return { id: attempt.id, deadline: attempt.deadline };
});

app.post("/api/admin/attempts/:id/reset", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const attempt = await prisma.examAttempt.findUnique({ where: { id } });
  if (!attempt) return reply.code(404).send({ error: "Attempt not found." });
  if (attempt.status !== "IN_PROGRESS") return reply.code(409).send({ error: "Only an in-progress attempt can be reset." });
  await prisma.examAttempt.delete({ where: { id } });
  await audit(request.auth!.userId, "exam_attempt.reset", "ExamAttempt", id, { userId: attempt.userId, examId: attempt.examId });
  return { ok: true };
});

app.post("/api/admin/attempts/:id/void", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const attempt = await prisma.examAttempt.update({
    where: { id },
    data: { status: "VOID", score: null, submittedAt: new Date() }
  });
  await audit(request.auth!.userId, "exam_attempt.voided", "ExamAttempt", id);
  return { id: attempt.id, status: attempt.status };
});

app.get("/api/admin/audit", { preHandler: requireAdmin }, async () =>
  prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 500, include: { actor: { select: { username: true, displayName: true } } } })
);

app.get("/api/admin/backups", { preHandler: requireAdmin }, async () => {
  await mkdir(backupDirectory, { recursive: true });
  const filenames = await readdir(backupDirectory);
  const backups = await Promise.all(filenames
    .filter((filename) => /^chemarena-(?:manual|auto)-[0-9T.Za-f-]+\.db$/.test(filename))
    .map(async (filename) => {
      const info = await stat(path.join(backupDirectory, filename));
      return { filename, sizeBytes: info.size, createdAt: info.mtime.toISOString() };
    }));
  return {
    automaticBackupIntervalMinutes,
    backups: backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  };
});

app.post("/api/admin/backup", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest) => {
  const filename = await createSqliteBackup("manual");
  await audit(request.auth!.userId, "backup.created", "Backup", filename);
  return { filename };
});

app.post("/api/admin/restore", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const body = request.body as { filename?: unknown };
  if (typeof body.filename !== "string" || !/^chemarena-(?:manual|auto)-[0-9T.Za-f-]+\.db$/.test(body.filename)) {
    return reply.code(400).send({ error: "Choose a valid ChemArena backup." });
  }
  const filename = path.basename(body.filename);
  const sourcePath = path.resolve(backupDirectory, filename);
  if (path.dirname(sourcePath) !== backupDirectory) return reply.code(400).send({ error: "Invalid backup path." });
  const sourceInfo = await stat(sourcePath).catch(() => null);
  if (!sourceInfo?.isFile() || sourceInfo.size === 0) return reply.code(404).send({ error: "Backup file not found or empty." });

  const validationClient = new PrismaClient({
    datasources: { db: { url: `file:${sourcePath.replaceAll("\\", "/")}` } }
  });
  try {
    const integrity = await validationClient.$queryRawUnsafe<Array<{ integrity_check: string }>>("PRAGMA integrity_check");
    const tables = await validationClient.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('User', 'ExamAttempt', 'Answer')"
    );
    if (integrity[0]?.integrity_check !== "ok" || tables.length !== 3) {
      return reply.code(400).send({ error: "This file is not a valid ChemArena database backup." });
    }
  } finally {
    await validationClient.$disconnect();
  }

  const safetyBackup = await createSqliteBackup("manual");
  await audit(request.auth!.userId, "backup.restore_requested", "Backup", filename, { safetyBackup });
  reply.code(202).send({
    ok: true,
    restarting: true,
    safetyBackup,
    message: "The server will restart and restore this backup. Sign in again when ChemArena is available."
  });
  setTimeout(() => {
    void (async () => {
      const activePath = databaseFilePath();
      const stagedPath = `${activePath}.restore-${process.pid}`;
      const previousPath = `${activePath}.previous-${process.pid}`;
      await copyFile(sourcePath, stagedPath);
      if (automaticBackupTimer) clearInterval(automaticBackupTimer);
      await backupQueue;
      await prisma.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
      await app.close();
      await prisma.$disconnect();
      await rm(`${activePath}-wal`, { force: true });
      await rm(`${activePath}-shm`, { force: true });
      await rename(activePath, previousPath);
      try {
        await rename(stagedPath, activePath);
        await rm(previousPath, { force: true });
        process.exit(75);
      } catch (error) {
        await rename(previousPath, activePath);
        await rm(stagedPath, { force: true });
        throw error;
      }
    })().catch((error: unknown) => {
      app.log.error(error, "ChemArena backup restore failed.");
      process.exit(75);
    });
  }, 500);
  return reply;
});

app.get("/api/student/exams", { preHandler: requireStudent }, async (request: AuthenticatedRequest) => {
  const enrollments = await prisma.enrollment.findMany({ where: { userId: request.auth!.userId }, select: { classId: true } });
  const classIds = enrollments.map(({ classId }) => classId);
  const now = new Date();
  const exams = await prisma.exam.findMany({
    where: {
      status: { in: ["SCHEDULED", "ACTIVE"] },
      AND: [{ OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }],
      OR: [{ classes: { some: { classId: { in: classIds } } } }, { students: { some: { userId: request.auth!.userId } } }]
    },
    include: {
      attempts: {
        where: { userId: request.auth!.userId },
        orderBy: { attemptNumber: "desc" },
        select: { status: true, attemptNumber: true }
      },
      retakeGrants: {
        where: { userId: request.auth!.userId },
        select: { remainingAttempts: true }
      }
    }
  });
  return exams.map(({ attempts, retakeGrants, ...exam }) => ({
    id: exam.id,
    title: exam.title,
    description: exam.description,
    durationMinutes: exam.durationMinutes,
    opensAt: exam.opensAt,
    closesAt: exam.closesAt,
    attemptsTaken: attempts.length,
    latestAttemptStatus: attempts[0]?.status ?? null,
    latestAttemptNumber: attempts[0]?.attemptNumber ?? null,
    retakesRemaining: retakeGrants[0]?.remainingAttempts ?? 0
  }));
});

app.post("/api/student/exams/:id/start", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { classes: { select: { classId: true } }, students: { select: { userId: true } }, items: { orderBy: { position: "asc" }, include: { question: true } } }
  });
  if (!exam || (exam.status !== "SCHEDULED" && exam.status !== "ACTIVE")) return reply.code(404).send({ error: "This exam is not available." });
  const enrollments = await prisma.enrollment.findMany({ where: { userId: request.auth!.userId }, select: { classId: true } });
  const assigned = exam.students.some((student) => student.userId === request.auth!.userId)
    || exam.classes.some(({ classId }) => enrollments.some((enrollment) => enrollment.classId === classId));
  if (!assigned) return reply.code(403).send({ error: "This exam is not assigned to you." });
  const now = new Date();
  if ((exam.opensAt && now < exam.opensAt) || (exam.closesAt && now > exam.closesAt)) {
    return reply.code(403).send({ error: "This exam is outside its availability window." });
  }
  let attempt = await prisma.examAttempt.findFirst({
    where: { examId: id, userId: request.auth!.userId, status: "IN_PROGRESS" },
    orderBy: { attemptNumber: "desc" }
  });
  let selectedQuestions = exam.items.map(({ question }) => question);
  if (!selectedQuestions.length) {
    const rules = JSON.parse(exam.selectionRules) as {
      topicWeights: Array<{ topicId: string; count: number }>;
      difficultyMin: number;
      difficultyMax: number;
    };
    const used = new Set<string>();
    for (const weight of rules.topicWeights) {
      const topic = await prisma.topic.findUnique({ where: { id: weight.topicId }, include: { children: { select: { id: true } } } });
      if (!topic) return reply.code(409).send({ error: "Exam topic rules refer to a topic that no longer exists." });
      const topicIds = [topic.id, ...topic.children.map((child) => child.id)];
      const candidates = await prisma.question.findMany({
        where: {
          topicId: { in: topicIds },
          status: "APPROVED",
          difficulty: { gte: rules.difficultyMin, lte: rules.difficultyMax },
          id: { notIn: [...used] }
        }
      });
      const chosen = shuffleArray(candidates).slice(0, weight.count);
      if (chosen.length < weight.count) return reply.code(409).send({ error: `Not enough approved questions for topic "${topic.title}".` });
      chosen.forEach((question) => used.add(question.id));
      selectedQuestions.push(...chosen);
    }
    if (selectedQuestions.length !== exam.questionCount) return reply.code(409).send({ error: "Exam rules did not select the required number of questions." });
    await prisma.exam.update({ where: { id }, data: { items: { create: selectedQuestions.map((question, position) => ({ questionId: question.id, position })) } } });
  }
  let startedNewAttempt = false;
  if (!attempt) {
    const ordered = exam.shuffleQuestions ? shuffleArray(selectedQuestions) : selectedQuestions;
    const questionOrder = ordered.map(({ id: questionId }) => questionId);
    const optionOrders = Object.fromEntries(ordered.map((question) => {
      const options = JSON.parse(question.options) as Array<{ id: string; text: string }>;
      return [question.id, (exam.shuffleOptions ? shuffleArray(options) : options).map((option) => option.id)];
    }));
    try {
      const result = await prisma.$transaction(async (transaction) => {
        const alreadyStarted = await transaction.examAttempt.findFirst({
          where: { examId: id, userId: request.auth!.userId, status: "IN_PROGRESS" },
          orderBy: { attemptNumber: "desc" }
        });
        if (alreadyStarted) return { attempt: alreadyStarted, created: false };
        const previousAttempts = await transaction.examAttempt.count({ where: { examId: id, userId: request.auth!.userId } });
        if (previousAttempts > 0) {
          const consumed = await transaction.examRetakeGrant.updateMany({
            where: { examId: id, userId: request.auth!.userId, remainingAttempts: { gt: 0 } },
            data: { remainingAttempts: { decrement: 1 } }
          });
          if (!consumed.count) throw new Error("EXAM_RETAKE_NOT_GRANTED");
        }
        const created = await transaction.examAttempt.create({
          data: {
            examId: id,
            userId: request.auth!.userId,
            attemptNumber: previousAttempts + 1,
            deadline: new Date(now.getTime() + exam.durationMinutes * 60_000),
            questionOrder: JSON.stringify(questionOrder),
            optionOrders: JSON.stringify(optionOrders)
          }
        });
        return { attempt: created, created: true };
      });
      attempt = result.attempt;
      startedNewAttempt = result.created;
    } catch (error) {
      if (error instanceof Error && error.message === "EXAM_RETAKE_NOT_GRANTED") {
        return reply.code(403).send({ error: "You have used your attempts for this exam. Ask your teacher to allow a rewrite." });
      }
      throw error;
    }
    if (startedNewAttempt) {
      await prisma.exam.update({ where: { id }, data: { status: "ACTIVE" } });
      await audit(request.auth!.userId, "exam_attempt.started", "ExamAttempt", attempt.id, {
        examId: id,
        attemptNumber: attempt.attemptNumber
      });
    } else {
      await prisma.examAttempt.update({ where: { id: attempt.id }, data: { lastSeenAt: now } });
    }
  } else {
    await prisma.examAttempt.update({ where: { id: attempt.id }, data: { lastSeenAt: now } });
  }

  const questionIds = JSON.parse(attempt.questionOrder) as string[];
  const optionOrders = JSON.parse(attempt.optionOrders) as Record<string, string[]>;
  const questionsById = new Map(selectedQuestions.map((question) => [question.id, question]));
  const savedAnswers = await prisma.answer.findMany({ where: { attemptId: attempt.id } });
  const answers = Object.fromEntries(savedAnswers.map((answer) => [answer.questionId, JSON.parse(answer.selectedOptionIds) as string[]]));
  const examPackage = questionIds.map((questionId) => {
    const question = questionsById.get(questionId)!;
    const optionById = new Map((JSON.parse(question.options) as Array<{ id: string; text: string }>).map((option) => [option.id, option]));
    return {
      id: question.id,
      stem: question.stem,
      type: question.type,
      smiles: question.smiles,
      imageDataUrl: question.imageDataUrl,
      options: (optionOrders[question.id] ?? []).map((optionId) => optionById.get(optionId)!)
    };
  });
  return {
    attemptId: attempt.id,
    exam: { id: exam.id, title: exam.title, durationMinutes: exam.durationMinutes, marksPerQuestion: exam.marksPerQuestion },
    startedAt: attempt.startedAt,
    deadline: attempt.deadline,
    serverTime: new Date(),
    graceSeconds: submissionGraceSeconds,
    questions: examPackage,
    answers
  };
});

app.post("/api/student/attempts/:id/heartbeat", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const updated = await prisma.examAttempt.updateMany({
    where: { id, userId: request.auth!.userId, status: "IN_PROGRESS" },
    data: { lastSeenAt: new Date() }
  });
  if (!updated.count) return reply.code(404).send({ error: "Active attempt not found." });
  const attempt = await prisma.examAttempt.findUniqueOrThrow({ where: { id } });
  return { ok: true, deadline: attempt.deadline, serverTime: new Date() };
});

app.post("/api/student/attempts/:id/events", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { eventType?: unknown };
  if (body.eventType !== "TAB_HIDDEN" && body.eventType !== "TAB_VISIBLE" && body.eventType !== "FULLSCREEN_EXIT") {
    return reply.code(400).send({ error: "Invalid exam event." });
  }
  const attempt = await prisma.examAttempt.findFirst({ where: { id, userId: request.auth!.userId, status: "IN_PROGRESS" } });
  if (!attempt) return reply.code(404).send({ error: "Active attempt not found." });
  await prisma.syncEvent.create({
    data: {
      attemptId: id,
      idempotencyKey: randomBytes(16).toString("hex"),
      eventType: body.eventType,
      payloadHash: createHash("sha256").update(body.eventType).digest("hex")
    }
  });
  await prisma.examAttempt.update({ where: { id }, data: { lastSeenAt: new Date() } });
  return { ok: true };
});

app.post("/api/student/attempts/:id/question-issues", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { id: attemptId } = request.params as { id: string };
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    return reply.code(400).send({ error: "Provide a valid question report." });
  }
  const body = request.body as { questionId?: unknown; category?: unknown; note?: unknown };
  if (typeof body.questionId !== "string" || !body.questionId.trim() || body.questionId.length > 128) {
    return reply.code(400).send({ error: "Choose a question to report." });
  }
  if (body.category !== "AMBIGUOUS" && body.category !== "INCORRECT" && body.category !== "TYPO" && body.category !== "OTHER") {
    return reply.code(400).send({ error: "Choose a valid report category." });
  }
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) {
    return reply.code(400).send({ error: "Report notes must be at most 1000 characters." });
  }
  const attempt = await prisma.examAttempt.findFirst({
    where: { id: attemptId, userId: request.auth!.userId },
    select: { questionOrder: true, status: true }
  });
  if (!attempt || attempt.status === "VOID") return reply.code(404).send({ error: "Attempt not found." });
  if (!(JSON.parse(attempt.questionOrder) as string[]).includes(body.questionId)) {
    return reply.code(400).send({ error: "That question is not part of this attempt." });
  }
  const question = await prisma.question.findUnique({ where: { id: body.questionId }, select: { id: true } });
  if (!question) return reply.code(404).send({ error: "Question not found." });
  const issue = await prisma.questionIssue.upsert({
    where: { attemptId_questionId: { attemptId, questionId: question.id } },
    create: {
      attemptId,
      questionId: question.id,
      userId: request.auth!.userId,
      category: body.category,
      note: typeof body.note === "string" ? body.note.trim() : ""
    },
    update: {
      category: body.category,
      note: typeof body.note === "string" ? body.note.trim() : "",
      status: "OPEN",
      adminNote: ""
    }
  });
  await audit(request.auth!.userId, "question_issue.reported", "QuestionIssue", issue.id, { attemptId, questionId: question.id });
  return reply.code(201).send({ id: issue.id, status: issue.status });
});

app.post("/api/student/answers", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const parsed = AnswerSubmissionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid answer." });
  const submission = parsed.data;
  const attempt = await prisma.examAttempt.findFirst({
    where: { id: submission.attemptId, userId: request.auth!.userId }
  });
  if (!attempt || attempt.status !== "IN_PROGRESS") return reply.code(404).send({ error: "Active attempt not found." });
  if (Date.now() > attempt.deadline.getTime() + submissionGraceSeconds * 1_000) {
    return reply.code(410).send({ error: "The answer submission window has closed." });
  }
  const questionIds = JSON.parse(attempt.questionOrder) as string[];
  if (!questionIds.includes(submission.questionId)) return reply.code(400).send({ error: "Question is not part of this attempt." });
  const question = await prisma.question.findUnique({ where: { id: submission.questionId }, select: { options: true } });
  if (!question) return reply.code(400).send({ error: "Question no longer exists." });
  const validOptionIds = new Set((JSON.parse(question.options) as Array<{ id: string }>).map(({ id: optionId }) => optionId));
  if (submission.selectedOptionIds.some((optionId) => !validOptionIds.has(optionId))) return reply.code(400).send({ error: "Answer contains an invalid option." });
  const payloadHash = createHash("sha256").update(JSON.stringify(submission)).digest("hex");
  const existingEvent = await prisma.syncEvent.findUnique({ where: { idempotencyKey: submission.idempotencyKey } });
  if (existingEvent) {
    if (!isSameIdempotentPayload(existingEvent.payloadHash, payloadHash)) return reply.code(409).send({ error: "Idempotency key was already used for a different answer." });
    return { ok: true, duplicate: true };
  }
  try {
    await prisma.$transaction([
      prisma.syncEvent.create({
        data: {
          attemptId: attempt.id,
          idempotencyKey: submission.idempotencyKey,
          eventType: "ANSWER_UPSERT",
          payloadHash
        }
      }),
      prisma.answer.upsert({
        where: { attemptId_questionId: { attemptId: attempt.id, questionId: submission.questionId } },
        create: { attemptId: attempt.id, questionId: submission.questionId, selectedOptionIds: JSON.stringify(submission.selectedOptionIds) },
        update: { selectedOptionIds: JSON.stringify(submission.selectedOptionIds) }
      }),
      prisma.examAttempt.update({ where: { id: attempt.id }, data: { lastSeenAt: new Date() } })
    ]);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      const racedEvent = await prisma.syncEvent.findUnique({ where: { idempotencyKey: submission.idempotencyKey } });
      if (racedEvent && isSameIdempotentPayload(racedEvent.payloadHash, payloadHash)) return { ok: true, duplicate: true };
      return reply.code(409).send({ error: "Idempotency key was already used for a different answer." });
    }
    throw error;
  }
  return { ok: true, duplicate: false };
});

app.post("/api/student/attempts/:id/submit", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) =>
  serializeFinalSubmission(async () => {
  const { id } = request.params as { id: string };
  const parsed = FinalExamSubmissionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid final answer snapshot." });
  const submission = parsed.data;
  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: request.auth!.userId },
    include: { exam: true, answers: true }
  });
  if (!attempt) return reply.code(404).send({ error: "Attempt not found." });
  if (attempt.status === "GRADED") return gradedSummary(attempt.id);
  if (attempt.status !== "IN_PROGRESS" && attempt.status !== "SUBMITTED") return reply.code(409).send({ error: "Attempt cannot be submitted." });
  const questionIds = JSON.parse(attempt.questionOrder) as string[];
  const submittedQuestionIds = Object.keys(submission.answers);
  if (submittedQuestionIds.length !== questionIds.length || questionIds.some((questionId) => !(questionId in submission.answers))) {
    return reply.code(400).send({ error: "The final snapshot must include every question in this attempt." });
  }
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    include: { topic: { select: { id: true, title: true, parentId: true } } }
  });
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  for (const [questionId, selectedOptionIds] of Object.entries(submission.answers)) {
    const question = questionMap.get(questionId);
    if (!question) return reply.code(400).send({ error: "The snapshot contains a question outside this attempt." });
    const validOptionIds = new Set((JSON.parse(question.options) as Array<{ id: string }>).map(({ id: optionId }) => optionId));
    if (selectedOptionIds.some((optionId) => !validOptionIds.has(optionId))) {
      return reply.code(400).send({ error: "The final snapshot contains an invalid option." });
    }
  }
  const snapshotPayload = JSON.stringify(Object.fromEntries(
    Object.entries(submission.answers).sort(([left], [right]) => left.localeCompare(right))
  ));
  const payloadHash = createHash("sha256").update(snapshotPayload).digest("hex");
  const priorEvent = await prisma.syncEvent.findUnique({ where: { idempotencyKey: submission.idempotencyKey } });
  if (priorEvent && (
    priorEvent.attemptId !== id
    || priorEvent.eventType !== "FINAL_SNAPSHOT"
    || !isSameIdempotentPayload(priorEvent.payloadHash, payloadHash)
  )) {
    return reply.code(409).send({ error: "This submission key was already used for different data." });
  }
  if (attempt.status === "SUBMITTED" && !priorEvent) {
    return reply.code(409).send({ error: "A final answer snapshot has already been accepted for this attempt." });
  }
  if (!priorEvent) {
    try {
      await prisma.$transaction(async (transaction) => {
        const accepted = await transaction.examAttempt.updateMany({
          where: { id, userId: request.auth!.userId, status: "IN_PROGRESS" },
          data: { status: "SUBMITTED" }
        });
        if (!accepted.count) throw new Error("FINAL_SNAPSHOT_ALREADY_ACCEPTED");
        await transaction.syncEvent.create({
          data: {
            attemptId: id,
            idempotencyKey: submission.idempotencyKey,
            eventType: "FINAL_SNAPSHOT",
            payloadHash
          }
        });
        await Promise.all(questionIds.map((questionId) => {
          const question = questionMap.get(questionId)!;
          const questionSnapshot = captureQuestionSnapshot(question);
          return transaction.answer.upsert({
            where: { attemptId_questionId: { attemptId: id, questionId } },
            create: {
              attemptId: id,
              questionId,
              selectedOptionIds: JSON.stringify(submission.answers[questionId]),
              questionSnapshot
            },
            update: { selectedOptionIds: JSON.stringify(submission.answers[questionId]), questionSnapshot }
          });
        }));
      });
    } catch (error) {
      if (error instanceof Error && error.message === "FINAL_SNAPSHOT_ALREADY_ACCEPTED") {
        const acceptedEvent = await prisma.syncEvent.findUnique({ where: { idempotencyKey: submission.idempotencyKey } });
        if (!acceptedEvent || acceptedEvent.attemptId !== id || !isSameIdempotentPayload(acceptedEvent.payloadHash, payloadHash)) {
          return reply.code(409).send({ error: "A different final answer snapshot was already accepted." });
        }
      } else if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        const racedEvent = await prisma.syncEvent.findUnique({ where: { idempotencyKey: submission.idempotencyKey } });
        if (!racedEvent || racedEvent.attemptId !== id || !isSameIdempotentPayload(racedEvent.payloadHash, payloadHash)) {
          return reply.code(409).send({ error: "This submission key was already used for different data." });
        }
      } else {
        throw error;
      }
    }
  }
  const answerMap = new Map(Object.entries(submission.answers));
  let score = 0;
  const breakdown = new Map<string, { topicId: string; correct: number; total: number; score: number }>();
  for (const questionId of questionIds) {
    const question = questionMap.get(questionId);
    if (!question) continue;
    const earned = scoreAnswer(
      JSON.parse(question.correctOptionIds) as string[],
      answerMap.get(questionId) ?? [],
      attempt.exam.marksPerQuestion,
      attempt.exam.negativeMarking ? attempt.exam.negativeMarks : 0
    );
    score += earned;
    const topicScore = breakdown.get(question.topicId) ?? { topicId: question.topicId, correct: 0, total: 0, score: 0 };
    topicScore.total += 1;
    topicScore.score += earned;
    if (earned > 0) topicScore.correct += 1;
    breakdown.set(question.topicId, topicScore);
  }
  const submittedAt = new Date();
  const updated = await prisma.examAttempt.updateMany({
    where: { id, userId: request.auth!.userId, status: "SUBMITTED" },
    data: { status: "GRADED", score, submittedAt, lastSeenAt: submittedAt }
  });
  if (!updated.count) {
    const graded = await prisma.examAttempt.findUnique({ where: { id } });
    if (graded?.status === "GRADED") return gradedSummary(id);
    return reply.code(409).send({ error: "Attempt was already submitted." });
  }
  if (attempt.exam.isPractice) {
    await prisma.exam.update({ where: { id: attempt.examId }, data: { status: "CLOSED" } });
  }
  await audit(request.auth!.userId, "exam_attempt.submitted", "ExamAttempt", id, { score });
  const topics = await prisma.topic.findMany({ where: { id: { in: [...breakdown.keys()] } }, select: { id: true, title: true, parentId: true } });
  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
  return {
    id,
    status: "GRADED",
    score,
    maxScore: questionIds.length * attempt.exam.marksPerQuestion,
    topicBreakdown: [...breakdown.values()].map((entry) => ({ ...entry, topic: topicMap.get(entry.topicId) }))
  };
  })
);

app.get("/api/student/results/:id/review", { preHandler: requireStudent }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: request.auth!.userId },
    include: { exam: true, answers: true }
  });
  if (!attempt) return reply.code(404).send({ error: "Result not found." });
  if (attempt.status !== "GRADED") return reply.code(403).send({ error: "Answers and explanations are available after grading." });
  const questionIds = JSON.parse(attempt.questionOrder) as string[];
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    include: { topic: { select: { id: true, title: true, parentId: true } } }
  });
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const answers = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
  return {
    examTitle: attempt.exam.title,
    score: attempt.score,
    questions: questionIds.map((questionId) => {
      const question = questionMap.get(questionId)!;
      const answer = answers.get(questionId);
      const snapshot = answer?.questionSnapshot
        ? JSON.parse(answer.questionSnapshot) as {
            stem: string;
            options: Array<{ id: string; text: string }>;
            correctOptionIds: string[];
            explanation: string;
            topicId: string;
            topicTitle: string;
            topicParentId: string | null;
          }
        : null;
      return {
        id: question.id,
        stem: snapshot?.stem ?? question.stem,
        options: snapshot?.options ?? JSON.parse(question.options),
        correctOptionIds: snapshot?.correctOptionIds ?? JSON.parse(question.correctOptionIds),
        selectedOptionIds: answer ? JSON.parse(answer.selectedOptionIds) as string[] : [],
        explanation: snapshot?.explanation ?? question.explanation,
        topic: snapshot
          ? { id: snapshot.topicId, title: snapshot.topicTitle, parentId: snapshot.topicParentId }
          : question.topic
      };
    })
  };
});

app.get("/api/student/results", { preHandler: requireStudent }, async (request: AuthenticatedRequest) =>
  prisma.examAttempt.findMany({
    where: { userId: request.auth!.userId, status: "GRADED" },
    select: { id: true, attemptNumber: true, status: true, score: true, submittedAt: true, exam: { select: { title: true } } },
    orderBy: { submittedAt: "desc" }
  })
);

async function studentPerformance(userId: string) {
  const attempts = await prisma.examAttempt.findMany({
    where: { userId, status: "GRADED" },
    include: { exam: { select: { title: true, marksPerQuestion: true } }, answers: true },
    orderBy: { submittedAt: "asc" }
  });
  const questionIds = [...new Set(attempts.flatMap((attempt) => JSON.parse(attempt.questionOrder) as string[]))];
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, correctOptionIds: true, topic: { select: { id: true, title: true } } }
  });
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const topicTotals = new Map<string, { topicId: string; title: string; correct: number; total: number }>();
  const trend = attempts.map((attempt) => {
    const ids = JSON.parse(attempt.questionOrder) as string[];
    const denominator = ids.length * attempt.exam.marksPerQuestion;
    const score = attempt.score ?? 0;
    const percent = denominator > 0 ? Math.max(0, Math.min(100, Math.round((score / denominator) * 100))) : 0;
    const answersByQuestion = new Map(attempt.answers.map((answer) => [answer.questionId, answer]));
    for (const questionId of ids) {
      const question = questionsById.get(questionId);
      if (!question) continue;
      const answer = answersByQuestion.get(questionId);
      const selected = answer ? JSON.parse(answer.selectedOptionIds) as string[] : [];
      const snapshot = answer?.questionSnapshot
        ? JSON.parse(answer.questionSnapshot) as { correctOptionIds: string[]; topicId: string; topicTitle: string }
        : null;
      const correctIds = snapshot?.correctOptionIds ?? JSON.parse(question.correctOptionIds) as string[];
      const isCorrect = selected.length === correctIds.length && correctIds.every((id) => selected.includes(id));
      const topicId = snapshot?.topicId ?? question.topic.id;
      const topicTitle = snapshot?.topicTitle ?? question.topic.title;
      const topicTotal = topicTotals.get(topicId) ?? {
        topicId,
        title: topicTitle,
        correct: 0,
        total: 0
      };
      topicTotal.total += 1;
      if (isCorrect) topicTotal.correct += 1;
      topicTotals.set(topicId, topicTotal);
    }
    return {
      id: attempt.id,
      examTitle: attempt.exam.title,
      attemptNumber: attempt.attemptNumber,
      score,
      maxScore: denominator,
      percent,
      submittedAt: attempt.submittedAt
    };
  });
  const topics = [...topicTotals.values()]
    .map((topic) => ({ ...topic, accuracy: Math.round((topic.correct / topic.total) * 100) }))
    .sort((left, right) => left.accuracy - right.accuracy || left.title.localeCompare(right.title));
  return { trend: trend.slice(-20), topics, weakTopics: topics.filter((topic) => topic.accuracy < 80).slice(0, 3) };
}

app.get("/api/student/analytics", { preHandler: requireStudent }, async (request: AuthenticatedRequest) =>
  studentPerformance(request.auth!.userId)
);

app.post("/api/student/practice-sets", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { weakTopics } = await studentPerformance(request.auth!.userId);
  if (!weakTopics.length) return reply.code(409).send({ error: "Complete a graded exam and have a topic below 80% before generating focused practice." });
  const candidates = await prisma.question.findMany({
    where: { status: "APPROVED", topicId: { in: weakTopics.map((topic) => topic.topicId) } },
    select: { id: true, topicId: true }
  });
  const selected = shuffleArray(candidates).slice(0, 10);
  if (!selected.length) return reply.code(409).send({ error: "No approved questions are available for your current focus topics." });
  const topicNames = weakTopics.map((topic) => topic.title).join(", ");
  const exam = await prisma.exam.create({
    data: {
      title: `Focused practice: ${weakTopics[0]!.title}`,
      description: `Practice based on recent results: ${topicNames}.`,
      durationMinutes: 20,
      questionCount: selected.length,
      selectionRules: JSON.stringify({ topicIds: weakTopics.map((topic) => topic.topicId) }),
      shuffleQuestions: true,
      shuffleOptions: true,
      marksPerQuestion: 1,
      negativeMarking: false,
      negativeMarks: 0,
      isPractice: true,
      status: "ACTIVE",
      students: { create: { userId: request.auth!.userId } },
      items: { create: selected.map(({ id: questionId }, position) => ({ questionId, position })) }
    }
  });
  await audit(request.auth!.userId, "practice_set.generated", "Exam", exam.id, { questionCount: selected.length, topicIds: weakTopics.map((topic) => topic.topicId) });
  return reply.code(201).send({ examId: exam.id, title: exam.title, questionCount: selected.length });
});

app.get("/api/admin/lan", { preHandler: requireAdmin }, async (request) => {
  const interfaces = Object.values((await import("node:os")).networkInterfaces()).flat();
  const addresses = interfaces.filter((item) => item && item.family === "IPv4" && !item.internal).map((item) => item!.address);
  const scheme = request.protocol;
  return { addresses, port, joinUrls: addresses.map((address) => `${scheme}://${address}:${port}`) };
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return reply.code(409).send({ error: "A record with that value already exists." });
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025") return reply.code(404).send({ error: "Record not found." });
  return reply.code(500).send({ error: "An unexpected server error occurred." });
});

async function createFirstAdmin(): Promise<void> {
  const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
  if (adminCount > 0) return;
  const username = (process.env.ADMIN_USERNAME ?? "admin").trim().toLowerCase();
  const temporaryPassword = randomBytes(9).toString("base64url");
  await prisma.user.create({
    data: {
      username,
      displayName: "Administrator",
      passwordHash: await argon2.hash(temporaryPassword),
      mustChangePassword: true,
      role: Role.ADMIN
    }
  });
  app.log.warn({ username, temporaryPassword }, "First-run administrator credentials; change the password after signing in.");
}

async function start(): Promise<void> {
  await prisma.$connect();
  await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL");
  await prisma.$executeRawUnsafe("PRAGMA synchronous=FULL");
  await ensureBranding();
  await backfillHistoricalQuestionSnapshots();
  await createFirstAdmin();
  await app.register(fastifyStatic, {
    root: path.resolve("../web/dist"),
    prefix: "/"
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) return reply.sendFile("index.html");
    return reply.code(404).send({ error: "Route not found." });
  });
  await app.listen({ host, port });
  automaticBackupTimer = setInterval(() => {
    if (automaticBackupInProgress) return;
    automaticBackupInProgress = true;
    void createSqliteBackup("auto")
      .then(() => pruneAutomaticBackups())
      .catch((error: unknown) => app.log.error(error, "Automatic SQLite backup failed."))
      .finally(() => { automaticBackupInProgress = false; });
  }, automaticBackupIntervalMinutes * 60_000);
  automaticBackupTimer.unref();
}

const shutdown = async () => {
  if (automaticBackupTimer) clearInterval(automaticBackupTimer);
  await app.close();
  await prisma.$disconnect();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

start().catch(async (error: unknown) => {
  app.log.error(error, "ChemArena failed to start.");
  await prisma.$disconnect();
  process.exitCode = 1;
});
