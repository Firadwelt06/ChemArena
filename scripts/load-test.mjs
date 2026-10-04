import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const baseUrl = (process.env.CHEMARENA_URL ?? "http://127.0.0.1:4174").replace(/\/$/, "");
const examId = process.env.LOAD_TEST_EXAM_ID;
const usersFile = process.env.LOAD_TEST_USERS;

if (!examId || !usersFile) {
  throw new Error("Set LOAD_TEST_EXAM_ID and LOAD_TEST_USERS to a dedicated exam and a JSON file with 60 student credentials.");
}

const users = JSON.parse(await readFile(usersFile, "utf8"));
if (!Array.isArray(users) || users.length !== 60 || users.some((user) => !user.username || !user.password)) {
  throw new Error("LOAD_TEST_USERS must contain exactly 60 objects with username and password fields.");
}

async function requestJson(path, { method = "GET", body, cookie, csrfToken } = {}) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseBody.error ?? "Request failed."}`);
  return responseBody;
}

async function runWithConcurrency(items, concurrency, action) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: "fulfilled", value: await action(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

async function measure(name, operation) {
  const started = performance.now();
  const results = await operation();
  const elapsedMs = performance.now() - started;
  const timings = results.filter((result) => result.status === "fulfilled").map((result) => result.value.elapsedMs).sort((a, b) => a - b);
  const failures = results.filter((result) => result.status === "rejected");
  const percentile95 = timings.length ? timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)] : 0;
  console.log(`${name}: ${results.length - failures.length}/${results.length} succeeded; wall ${Math.round(elapsedMs)} ms; p95 ${Math.round(percentile95)} ms`);
  failures.slice(0, 10).forEach((failure, index) => console.error(`  failure ${index + 1}: ${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`));
  return { results, failed: failures.length > 0 };
}

console.log(`ChemArena 60-student load test against ${baseUrl}`);
console.log("Use only disposable student accounts and a dedicated exam; successful submissions consume those attempts.");

const login = await measure("Login (6 at a time)", () => runWithConcurrency(users, 6, async (user) => {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: user.username, password: user.password })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error ?? "Login failed."}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || !body.csrfToken) throw new Error("Login did not return a session cookie and CSRF token.");
  return { username: user.username, cookie, csrfToken: body.csrfToken, elapsedMs: performance.now() - started };
}));
if (login.failed) throw new Error("Login failures prevent a valid 60-student load test.");
const sessions = login.results.filter((result) => result.status === "fulfilled").map((result) => result.value);

const start = await measure("Start attempts (60 concurrently)", () => runWithConcurrency(sessions, 60, async (session) => {
  const started = performance.now();
  const examPackage = await requestJson(`/api/student/exams/${encodeURIComponent(examId)}/start`, {
    method: "POST", body: {}, cookie: session.cookie, csrfToken: session.csrfToken
  });
  return { ...session, examPackage, elapsedMs: performance.now() - started };
}));
if (start.failed) process.exitCode = 1;
const attempts = start.results.filter((result) => result.status === "fulfilled").map((result) => result.value);

const saves = await measure("Autosave answers (60 concurrently)", () => runWithConcurrency(attempts, 60, async (session) => {
  const question = session.examPackage.questions[0];
  if (!question?.options[0]) throw new Error("The exam package contains no answerable questions.");
  const started = performance.now();
  await requestJson("/api/student/answers", {
    method: "POST",
    body: {
      attemptId: session.examPackage.attemptId,
      questionId: question.id,
      selectedOptionIds: [question.options[0].id],
      idempotencyKey: crypto.randomUUID(),
      changedAt: Date.now()
    },
    cookie: session.cookie,
    csrfToken: session.csrfToken
  });
  return { ...session, elapsedMs: performance.now() - started };
}));
if (saves.failed) process.exitCode = 1;
const savedAttempts = saves.results.filter((result) => result.status === "fulfilled").map((result) => result.value);

const submissions = await measure("Submit exams (60 concurrently)", () => runWithConcurrency(savedAttempts, 60, async (session) => {
  const answers = Object.fromEntries(session.examPackage.questions.map((question, index) => [
    question.id,
    index === 0 ? [question.options[0].id] : []
  ]));
  const started = performance.now();
  await requestJson(`/api/student/attempts/${encodeURIComponent(session.examPackage.attemptId)}/submit`, {
    method: "POST",
    body: { idempotencyKey: crypto.randomUUID(), answers },
    cookie: session.cookie,
    csrfToken: session.csrfToken
  });
  return { elapsedMs: performance.now() - started };
}));
if (submissions.failed) process.exitCode = 1;
