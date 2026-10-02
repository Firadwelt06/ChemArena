import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import argon2 from "argon2";
import { PrismaClient, Role, RecordStatus } from "@prisma/client";
import { AnswerSubmissionSchema, BrandingSchema, ExamInputSchema, hasRole, isSameIdempotentPayload, LoginSchema, QuestionSchema, scoreAnswer, StudentImportSchema, TopicInputSchema } from "@chemarena/shared";

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

app.get("/api/health", async () => ({ ok: true }));

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
    prisma.exam.count({ where: { status: "ACTIVE" } }),
    prisma.examAttempt.count({ where: { status: "IN_PROGRESS" } })
  ]);
  return { studentCount, classCount, questionCount, activeExams, attempts };
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
      prisma.lesson.count({ where: { topicId: topic.id, status: "PUBLISHED" } })
    ]);
    return { ...topic, approvedQuestions: questions, publishedLessons: lessons };
  }));
  return coverage;
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
      smiles: q.smiles, imageDataUrl: q.imageDataUrl, status: q.status
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
      status: question.status
    }
  })));
  await audit(request.auth!.userId, "questions.imported", "Question", undefined, { count: parsed.length });
  return reply.code(201).send({ imported: parsed.length });
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

app.put("/api/admin/questions/:id", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const parsed = QuestionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid question." });
  const q = parsed.data;
  const updated = await prisma.question.update({
    where: { id },
    data: {
      stem: q.stem, type: q.type, options: JSON.stringify(q.options), correctOptionIds: JSON.stringify(q.correctOptionIds),
      explanation: q.explanation, topicId: q.topicId, difficulty: q.difficulty, tags: JSON.stringify(q.tags),
      smiles: q.smiles, imageDataUrl: q.imageDataUrl, status: q.status
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
    orderBy: { createdAt: "desc" },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
      items: { select: { id: true } },
      _count: { select: { attempts: true } }
    }
  })
);

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
  const [attempts, sessions] = await Promise.all([
    prisma.examAttempt.findMany({
      where: { examId: id },
      include: { _count: { select: { answers: true } } },
      orderBy: { startedAt: "asc" }
    }),
    prisma.session.findMany({ where: { userId: { in: userIds }, expiresAt: { gt: new Date() } }, select: { userId: true, lastSeenAt: true } })
  ]);
  const attemptByUser = new Map(attempts.map((attempt) => [attempt.userId, attempt]));
  const recentSessions = new Set(sessions.filter((session) => now - session.lastSeenAt.getTime() < 45_000).map(({ userId }) => userId));
  return [...assignedUsers.values()].map((user) => {
    const attempt = attemptByUser.get(user.id);
    const active = attempt?.status === "IN_PROGRESS";
    return {
      id: attempt?.id ?? null,
      user,
      status: attempt?.status ?? "NOT_STARTED",
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

app.post("/api/admin/backup", { preHandler: [requireCsrf, requireAdmin] }, async (request: AuthenticatedRequest) => {
  const source = process.env.DATABASE_URL?.replace(/^file:/, "");
  if (!source) throw new Error("DATABASE_URL is not configured.");
  const sourcePath = path.resolve("apps/server", source);
  const backupDirectory = path.resolve("backups");
  await mkdir(backupDirectory, { recursive: true });
  const filename = `chemarena-manual-${new Date().toISOString().replaceAll(":", "-")}.db`;
  await copyFile(sourcePath, path.join(backupDirectory, filename));
  await audit(request.auth!.userId, "backup.created", "Backup", filename);
  return { filename };
});

app.get("/api/student/exams", { preHandler: requireStudent }, async (request: AuthenticatedRequest) => {
  const enrollments = await prisma.enrollment.findMany({ where: { userId: request.auth!.userId }, select: { classId: true } });
  const classIds = enrollments.map(({ classId }) => classId);
  const now = new Date();
  return prisma.exam.findMany({
    where: {
      status: { in: ["SCHEDULED", "ACTIVE"] },
      AND: [{ OR: [{ opensAt: null }, { opensAt: { lte: now } }] }, { OR: [{ closesAt: null }, { closesAt: { gte: now } }] }],
      OR: [{ classes: { some: { classId: { in: classIds } } } }, { students: { some: { userId: request.auth!.userId } } }]
    },
    select: { id: true, title: true, description: true, durationMinutes: true, opensAt: true, closesAt: true }
  });
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
  let attempt = await prisma.examAttempt.findUnique({ where: { examId_userId: { examId: id, userId: request.auth!.userId } } });
  if (attempt && attempt.status !== "IN_PROGRESS") return reply.code(409).send({ error: "This exam attempt has already been submitted." });
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
  if (!attempt) {
    const ordered = exam.shuffleQuestions ? shuffleArray(selectedQuestions) : selectedQuestions;
    const questionOrder = ordered.map(({ id: questionId }) => questionId);
    const optionOrders = Object.fromEntries(ordered.map((question) => {
      const options = JSON.parse(question.options) as Array<{ id: string; text: string }>;
      return [question.id, (exam.shuffleOptions ? shuffleArray(options) : options).map((option) => option.id)];
    }));
    attempt = await prisma.examAttempt.create({
      data: {
        examId: id,
        userId: request.auth!.userId,
        deadline: new Date(now.getTime() + exam.durationMinutes * 60_000),
        questionOrder: JSON.stringify(questionOrder),
        optionOrders: JSON.stringify(optionOrders)
      }
    });
    await prisma.exam.update({ where: { id }, data: { status: "ACTIVE" } });
    await audit(request.auth!.userId, "exam_attempt.started", "ExamAttempt", attempt.id, { examId: id });
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

app.post("/api/student/attempts/:id/submit", { preHandler: [requireCsrf, requireStudent] }, async (request: AuthenticatedRequest, reply) => {
  const { id } = request.params as { id: string };
  const attempt = await prisma.examAttempt.findFirst({
    where: { id, userId: request.auth!.userId },
    include: { exam: true, answers: true }
  });
  if (!attempt) return reply.code(404).send({ error: "Attempt not found." });
  if (attempt.status === "GRADED") return { id: attempt.id, status: attempt.status, score: attempt.score };
  if (attempt.status !== "IN_PROGRESS") return reply.code(409).send({ error: "Attempt cannot be submitted." });
  const questionIds = JSON.parse(attempt.questionOrder) as string[];
  const questions = await prisma.question.findMany({ where: { id: { in: questionIds } } });
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const answerMap = new Map(attempt.answers.map((answer) => [answer.questionId, JSON.parse(answer.selectedOptionIds) as string[]]));
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
    where: { id, userId: request.auth!.userId, status: "IN_PROGRESS" },
    data: { status: "GRADED", score, submittedAt, lastSeenAt: submittedAt }
  });
  if (!updated.count) return reply.code(409).send({ error: "Attempt was already submitted." });
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
});

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
  const answers = new Map(attempt.answers.map((answer) => [answer.questionId, JSON.parse(answer.selectedOptionIds) as string[]]));
  return {
    examTitle: attempt.exam.title,
    score: attempt.score,
    questions: questionIds.map((questionId) => {
      const question = questionMap.get(questionId)!;
      return {
        id: question.id,
        stem: question.stem,
        options: JSON.parse(question.options),
        correctOptionIds: JSON.parse(question.correctOptionIds),
        selectedOptionIds: answers.get(questionId) ?? [],
        explanation: question.explanation,
        topic: question.topic
      };
    })
  };
});

app.get("/api/student/results", { preHandler: requireStudent }, async (request: AuthenticatedRequest) =>
  prisma.examAttempt.findMany({
    where: { userId: request.auth!.userId, status: "GRADED" },
    select: { id: true, status: true, score: true, submittedAt: true, exam: { select: { title: true } } },
    orderBy: { submittedAt: "desc" }
  })
);

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
}

const shutdown = async () => {
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
