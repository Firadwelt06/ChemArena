import Dexie, { type Table } from "dexie";

export type ExamQuestion = {
  id: string;
  stem: string;
  type: string;
  smiles: string | null;
  imageDataUrl: string | null;
  options: Array<{ id: string; text: string }>;
};

export type ExamPackage = {
  attemptId: string;
  exam: { id: string; title: string; durationMinutes: number; marksPerQuestion: number };
  startedAt: string;
  deadline: string;
  serverTime: string;
  graceSeconds: number;
  questions: ExamQuestion[];
  answers: Record<string, string[]>;
};

export type CachedExamAttempt = {
  attemptId: string;
  userId: string;
  examPackage: ExamPackage;
  answers: Record<string, string[]>;
  cachedAt: number;
  serverTimeCachedAt: number;
  frozenSubmission: FrozenSubmission | null;
};

export type FrozenSubmission = {
  idempotencyKey: string;
  answers: Record<string, string[]>;
  frozenAt: number;
};

export type AnswerOutboxEntry = {
  key: string;
  attemptId: string;
  questionId: string;
  selectedOptionIds: string[];
  idempotencyKey: string;
  changedAt: number;
};

class ChemArenaExamDatabase extends Dexie {
  attempts!: Table<CachedExamAttempt, string>;
  outbox!: Table<AnswerOutboxEntry, string>;

  constructor() {
    super("chemarena-exams");
    this.version(1).stores({
      attempts: "attemptId, userId, cachedAt",
      outbox: "key, attemptId, [attemptId+changedAt]"
    });
  }
}

const database = new ChemArenaExamDatabase();
const flushes = new Map<string, Promise<void>>();

function createIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function cacheExamPackage(userId: string, examPackage: ExamPackage): Promise<void> {
  await database.attempts.put({
    attemptId: examPackage.attemptId,
    userId,
    examPackage,
    answers: examPackage.answers,
    cachedAt: Date.now(),
    serverTimeCachedAt: Date.now(),
    frozenSubmission: null
  });
}

export async function getLatestCachedAttempt(userId: string): Promise<CachedExamAttempt | undefined> {
  const attempts = await database.attempts.where("userId").equals(userId).toArray();
  return attempts.sort((left, right) => right.cachedAt - left.cachedAt)[0];
}

export async function getCachedAttempt(attemptId: string): Promise<CachedExamAttempt | undefined> {
  return database.attempts.get(attemptId);
}

export async function updateCachedServerTime(attemptId: string, serverTime: string): Promise<void> {
  const attempt = await database.attempts.get(attemptId);
  if (!attempt) return;
  await database.attempts.update(attemptId, {
    examPackage: { ...attempt.examPackage, serverTime },
    serverTimeCachedAt: Date.now()
  });
}

export async function saveAnswerLocally(
  attemptId: string,
  questionId: string,
  selectedOptionIds: string[],
  idempotencyKey: string
): Promise<void> {
  const changedAt = Date.now();
  await database.transaction("rw", database.attempts, database.outbox, async () => {
    const attempt = await database.attempts.get(attemptId);
    if (!attempt) throw new Error("This exam is not saved on this device.");
    if (attempt.frozenSubmission) throw new Error("This exam has already been submitted on this device.");
    await database.attempts.update(attemptId, {
      answers: { ...attempt.answers, [questionId]: selectedOptionIds },
      cachedAt: changedAt
    });
    await database.outbox.put({
      key: `${attemptId}:${questionId}`,
      attemptId,
      questionId,
      selectedOptionIds,
      idempotencyKey,
      changedAt
    });
  });
}

export async function freezeSubmission(attemptId: string): Promise<FrozenSubmission> {
  return database.transaction("rw", database.attempts, database.outbox, async () => {
    const attempt = await database.attempts.get(attemptId);
    if (!attempt) throw new Error("This exam is not saved on this device.");
    if (attempt.frozenSubmission) return attempt.frozenSubmission;
    const frozenSubmission: FrozenSubmission = {
      idempotencyKey: createIdempotencyKey(),
      answers: Object.fromEntries(attempt.examPackage.questions.map(({ id }) => [id, attempt.answers[id] ?? []])),
      frozenAt: Date.now()
    };
    await database.attempts.update(attemptId, { frozenSubmission });
    return frozenSubmission;
  });
}

export async function removeCachedAttempt(attemptId: string): Promise<void> {
  await database.transaction("rw", database.attempts, database.outbox, async () => {
    await database.attempts.delete(attemptId);
    await database.outbox.where("attemptId").equals(attemptId).delete();
  });
}

export async function flushAnswerOutbox(
  attemptId: string,
  send: (entry: AnswerOutboxEntry) => Promise<void>
): Promise<void> {
  const existingFlush = flushes.get(attemptId);
  if (existingFlush) return existingFlush;
  const flush = (async () => {
    const entries = await database.outbox.where("attemptId").equals(attemptId).sortBy("changedAt");
    for (const entry of entries) {
      await send(entry);
      const current = await database.outbox.get(entry.key);
      if (current?.idempotencyKey === entry.idempotencyKey) await database.outbox.delete(entry.key);
    }
  })().finally(() => {
    if (flushes.get(attemptId) === flush) flushes.delete(attemptId);
  });
  flushes.set(attemptId, flush);
  return flush;
}

export async function getPendingAnswerCount(attemptId: string): Promise<number> {
  return database.outbox.where("attemptId").equals(attemptId).count();
}
