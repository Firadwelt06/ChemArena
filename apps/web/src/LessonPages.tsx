import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LessonContentSchema, type LessonContent } from "@chemarena/shared";
import { api } from "./api";
import { LessonContentView } from "./LessonContentView";

type Topic = { id: string; title: string; description: string; parentId: string | null };
type ClassRecord = { id: string; name: string; status: string };
type StudentRecord = { id: string; username: string; displayName: string; status: string };
type LessonStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type AdminLesson = {
  id: string;
  title: string;
  topicId: string;
  topic: Topic;
  status: LessonStatus;
  currentVersion: number;
  publishedVersion: number | null;
  content: LessonContent | null;
  classAssignments: Array<{ id: string; name: string }>;
  studentAssignments: Array<{ id: string; username: string; displayName: string }>;
  updatedAt: string;
};
type LessonSummary = {
  id: string;
  title: string;
  topic: Topic;
  version: number;
  completedAt: string | null;
};
type StudentLesson = {
  id: string;
  title: string;
  topicId: string;
  version: number;
  content: LessonContent;
  completedAt: string | null;
};
type GenerationStatus = { configured: boolean; model: string };

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function readJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

export function AdminLessonsPage() {
  const client = useQueryClient();
  const topics = useQuery({ queryKey: ["topics"], queryFn: () => api<Topic[]>("/api/topics") });
  const lessons = useQuery({ queryKey: ["admin-lessons"], queryFn: () => api<AdminLesson[]>("/api/admin/lessons") });
  const classes = useQuery({ queryKey: ["classes"], queryFn: () => api<ClassRecord[]>("/api/admin/classes") });
  const students = useQuery({ queryKey: ["students"], queryFn: () => api<StudentRecord[]>("/api/admin/students") });
  const [editing, setEditing] = useState<AdminLesson | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const save = useMutation({
    mutationFn: (payload: { id?: string; data: unknown }) => api<{ id: string }>(payload.id
      ? `/api/admin/lessons/${payload.id}`
      : "/api/admin/lessons", { method: payload.id ? "PUT" : "POST", body: JSON.stringify(payload.data) }),
    onSuccess: () => {
      setEditing(undefined); setError(""); setMessage("Lesson saved as a draft. Review its content, then publish it to assigned learners.");
      void client.invalidateQueries({ queryKey: ["admin-lessons"] });
      void client.invalidateQueries({ queryKey: ["coverage"] });
    },
    onError: (cause: Error) => { setMessage(""); setError(cause.message); }
  });
  const publish = useMutation({
    mutationFn: (lesson: AdminLesson) => api(`/api/admin/lessons/${lesson.id}/publish`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      setError(""); setMessage("Lesson published to its assigned learners.");
      void client.invalidateQueries({ queryKey: ["admin-lessons"] });
      void client.invalidateQueries({ queryKey: ["coverage"] });
    },
    onError: (cause: Error) => { setMessage(""); setError(cause.message); }
  });
  const archive = useMutation({
    mutationFn: (lesson: AdminLesson) => api(`/api/admin/lessons/${lesson.id}/archive`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      setError(""); setMessage("Lesson archived.");
      void client.invalidateQueries({ queryKey: ["admin-lessons"] });
      void client.invalidateQueries({ queryKey: ["coverage"] });
    },
    onError: (cause: Error) => { setMessage(""); setError(cause.message); }
  });

  return <div className="page-stack">
    <div className="page-header"><div><span className="eyebrow">LESSON LIBRARY</span><h1>Lessons</h1><p>Write, review, version, assign, and publish syllabus-aligned lessons.</p></div><button className="button button-primary" onClick={() => setEditing(null)}>Create lesson</button></div>
    {error && <div role="alert" className="notice notice-error">{error}</div>}
    {message && <div role="status" className="notice notice-success">{message}</div>}
    {editing !== undefined && topics.data && classes.data && students.data && <LessonEditor
      key={editing?.id ?? "new"}
      lesson={editing ?? undefined}
      topics={topics.data}
      classes={classes.data.filter((item) => item.status === "ACTIVE")}
      students={students.data.filter((item) => item.status === "ACTIVE")}
      onCancel={() => setEditing(undefined)}
      onSave={(id, data) => save.mutate({ id, data })}
      busy={save.isPending}
    />}
    {lessons.isError && <div role="alert" className="notice notice-error">{(lessons.error as Error).message}</div>}
    <section className="lesson-admin-list">
      {lessons.data?.map((lesson) => <article className="card lesson-admin-card" key={lesson.id}>
        <div className="lesson-admin-title"><div><span className="topic-chip">{lesson.topic.title}</span><h2>{lesson.title}</h2>
          <p>Version {lesson.currentVersion}{lesson.publishedVersion !== null ? ` · learner version ${lesson.publishedVersion}` : ""} · {lesson.classAssignments.length} class{lesson.classAssignments.length === 1 ? "" : "es"} · {lesson.studentAssignments.length} individual student{lesson.studentAssignments.length === 1 ? "" : "s"}</p>
        </div><span className={`status-pill ${lesson.status === "PUBLISHED" ? "status-good" : "status-muted"}`}>{lesson.status.toLowerCase()}</span></div>
        <div className="lesson-admin-actions">
          <button className="button button-outline button-small" onClick={() => setEditing(lesson)}>Edit / preview</button>
          {lesson.status !== "ARCHIVED" && <button className="button button-primary button-small" disabled={publish.isPending || (lesson.publishedVersion === lesson.currentVersion && lesson.status === "PUBLISHED")} onClick={() => publish.mutate(lesson)}>{lesson.status === "PUBLISHED" ? "Publish latest version" : "Publish"}</button>}
          {lesson.status !== "ARCHIVED" && <button className="button button-outline button-small" onClick={() => {
            if (window.confirm(`Archive "${lesson.title}"? It will no longer be visible to students.`)) archive.mutate(lesson);
          }}>Archive</button>}
        </div>
      </article>)}
      {!lessons.data?.length && <div className="card empty-state"><strong>{lessons.isLoading ? "Loading lessons…" : "No lessons yet"}</strong><p>Create a lesson, tag it to a syllabus topic, and assign learners before publishing.</p></div>}
    </section>
  </div>;
}

function LessonEditor({ lesson, topics, classes, students, onCancel, onSave, busy }: {
  lesson?: AdminLesson;
  topics: Topic[];
  classes: ClassRecord[];
  students: StudentRecord[];
  onCancel: () => void;
  onSave: (id: string | undefined, data: unknown) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState(lesson?.title ?? "");
  const [topicId, setTopicId] = useState(lesson?.topicId ?? topics.find((topic) => topic.parentId)?.id ?? "");
  const [objectivesText, setObjectivesText] = useState((lesson?.content?.objectives ?? []).join("\n"));
  const [explanationMarkdown, setExplanationMarkdown] = useState(lesson?.content?.explanationMarkdown ?? "");
  const [examplesText, setExamplesText] = useState(JSON.stringify(lesson?.content?.workedExamples ?? [], null, 2));
  const [handsOnActivity, setHandsOnActivity] = useState(lesson?.content?.handsOnActivity ?? "");
  const [quizText, setQuizText] = useState(JSON.stringify(lesson?.content?.quiz ?? [], null, 2));
  const [homework, setHomework] = useState(lesson?.content?.homework ?? "");
  const [classIds, setClassIds] = useState(lesson?.classAssignments.map(({ id }) => id) ?? []);
  const [studentIds, setStudentIds] = useState(lesson?.studentAssignments.map(({ id }) => id) ?? []);
  const [pasteText, setPasteText] = useState("");
  const [reviewWarnings, setReviewWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const aiStatus = useQuery({ queryKey: ["ai-status"], queryFn: () => api<GenerationStatus>("/api/admin/ai/status") });
  const generate = useMutation({
    mutationFn: () => api<{ title: string; topicId: string; content: LessonContent; reviewWarnings: string[] }>("/api/admin/ai/lessons", {
      method: "POST", body: JSON.stringify({ topicId })
    }),
    onSuccess: (generated) => {
      setTitle(generated.title);
      setTopicId(generated.topicId);
      loadContent(generated.content);
      setReviewWarnings(generated.reviewWarnings);
      setError("");
      setPreview(true);
    },
    onError: (cause: Error) => setError(cause.message)
  });
  const loadContent = (content: LessonContent) => {
    setObjectivesText(content.objectives.join("\n"));
    setExplanationMarkdown(content.explanationMarkdown);
    setExamplesText(JSON.stringify(content.workedExamples, null, 2));
    setHandsOnActivity(content.handsOnActivity);
    setQuizText(JSON.stringify(content.quiz, null, 2));
    setHomework(content.homework);
  };
  const buildContent = (): LessonContent => {
    const parsed = LessonContentSchema.safeParse({
      objectives: splitLines(objectivesText),
      explanationMarkdown,
      workedExamples: readJson(examplesText, "Worked examples"),
      handsOnActivity,
      quiz: readJson(quizText, "Quiz questions"),
      homework
    });
    if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "content"}: ${issue.message}`).join(" "));
    return parsed.data;
  };
  const contentPreview = useMemo(() => {
    if (!preview) return null;
    try { return { content: buildContent(), error: "" }; }
    catch (cause) { return { content: null, error: cause instanceof Error ? cause.message : "Complete all required lesson sections to preview." }; }
  }, [preview, objectivesText, explanationMarkdown, examplesText, handsOnActivity, quizText, homework]);

  const applyPastedJson = () => {
    try {
      const parsed = LessonContentSchema.safeParse(readJson(pasteText, "Lesson JSON"));
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "content"}: ${issue.message}`).join(" "));
      loadContent(parsed.data);
      setReviewWarnings(["Pasted content has not been checked for scientific accuracy. Review every answer before publishing."]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the pasted lesson JSON.");
    }
  };

  return <section className="card lesson-editor">
    <div className="table-title"><div><span className="eyebrow">{lesson ? `VERSION ${lesson.currentVersion}` : "DRAFT LESSON"}</span><h2>{lesson ? "Edit lesson" : "Create lesson"}</h2></div><button className="button button-outline button-small" onClick={onCancel}>Close</button></div>
    {error && <div role="alert" className="notice notice-error">{error}</div>}
    {reviewWarnings.map((warning) => <div className="notice notice-warning" key={warning}>{warning}</div>)}
    <div className="editor-row"><label className="grow">Lesson title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} required /></label><label>Syllabus topic<select value={topicId} onChange={(event) => setTopicId(event.target.value)} required><option value="">Choose a topic</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.parentId ? "— " : ""}{topic.title}</option>)}</select></label></div>
    <div className="lesson-generation card">
      <div><strong>AI lesson generator</strong><p>{aiStatus.data?.configured ? `Server-side ${aiStatus.data.model} is configured. Generated lessons always need teacher review.` : "Optional OpenAI integration is not configured. You can use the paste-JSON workflow below."}</p></div>
      <button className="button button-outline" disabled={!aiStatus.data?.configured || !topicId || generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? "Generating lesson…" : "Generate from topic"}</button>
    </div>
    <section className="lesson-fields">
      <label>Learning objectives (one per line)<textarea rows={4} value={objectivesText} onChange={(event) => setObjectivesText(event.target.value)} /></label>
      <label>Lesson explanation (Markdown, LaTeX with $...$ or $$...$$, and SMILES code fences)<textarea rows={14} value={explanationMarkdown} onChange={(event) => setExplanationMarkdown(event.target.value)} placeholder={"# Example\n\nAn alkane has the general formula $C_nH_{2n+2}$.\n\n```smiles\nCCO\n```"} /></label>
      <details><summary>Worked examples (JSON array)</summary><textarea rows={7} value={examplesText} onChange={(event) => setExamplesText(event.target.value)} placeholder={'[{"problem":"...","solution":"..."}]'} /></details>
      <label>Hands-on activity<textarea rows={5} value={handsOnActivity} onChange={(event) => setHandsOnActivity(event.target.value)} /></label>
      <details><summary>Ten-question quiz (JSON array)</summary><p className="helper-text">Each question needs stem, type, options, correctOptionIds, explanation, difficulty, tags, and smiles. Use exactly ten questions. Answer keys remain part of the lesson for practice, not CBT exams.</p><textarea rows={12} value={quizText} onChange={(event) => setQuizText(event.target.value)} placeholder='[{"stem":"...","type":"SINGLE","options":[{"id":"a","text":"..."},{"id":"b","text":"..."}],"correctOptionIds":["a"],"explanation":"...","difficulty":1,"tags":[],"smiles":null}]' /></details>
      <label>Homework<textarea rows={5} value={homework} onChange={(event) => setHomework(event.target.value)} /></label>
      <details><summary>Paste validated lesson JSON</summary><textarea rows={8} value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder='{"objectives":[...],"explanationMarkdown":"...","workedExamples":[...],"handsOnActivity":"...","quiz":[10 questions],"homework":"..."}' /><button className="button button-outline button-small" type="button" onClick={applyPastedJson} disabled={!pasteText.trim()}>Validate and use JSON</button></details>
    </section>
    <fieldset className="choice-field"><legend>Assign to classes</legend><div className="check-list">{classes.map((record) => <label className="check-row" key={record.id}><input type="checkbox" checked={classIds.includes(record.id)} onChange={(event) => setClassIds((current) => event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id))} /><span>{record.name}</span></label>)}{!classes.length && <p className="helper-text">Create an active class before assigning this lesson.</p>}</div></fieldset>
    <fieldset className="choice-field"><legend>Assign to individual students</legend><div className="check-list">{students.map((record) => <label className="check-row" key={record.id}><input type="checkbox" checked={studentIds.includes(record.id)} onChange={(event) => setStudentIds((current) => event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id))} /><span>{record.displayName}</span><small>{record.username}</small></label>)}{!students.length && <p className="helper-text">Create an active student before assigning individually.</p>}</div></fieldset>
    <div className="editor-actions"><button className="button button-outline" onClick={() => setPreview((value) => !value)}>{preview ? "Hide preview" : "Preview lesson"}</button><button className="button button-outline" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy || !title.trim() || !topicId} onClick={() => {
      try {
        const content = buildContent();
        setError("");
        onSave(lesson?.id, { title, topicId, content, classIds, studentIds });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Lesson content is invalid.");
      }
    }}>{busy ? "Saving…" : "Save as draft"}</button></div>
    {preview && <section className="lesson-live-preview card"><span className="eyebrow">PREVIEW</span><h2>{title || "Untitled lesson"}</h2>{contentPreview?.error ? <div className="notice notice-warning">{contentPreview.error}</div> : contentPreview?.content && <LessonContentView content={contentPreview.content} />}</section>}
  </section>;
}

export function StudentLessonsPage() {
  const client = useQueryClient();
  const lessons = useQuery({ queryKey: ["student-lessons"], queryFn: () => api<LessonSummary[]>("/api/student/lessons") });
  const [selectedId, setSelectedId] = useState("");
  const lesson = useQuery({
    queryKey: ["student-lesson", selectedId],
    queryFn: () => api<StudentLesson>(`/api/student/lessons/${selectedId}`),
    enabled: Boolean(selectedId)
  });
  const complete = useMutation({
    mutationFn: () => api<{ completedAt: string }>(`/api/student/lessons/${selectedId}/complete`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["student-lessons"] });
      void client.invalidateQueries({ queryKey: ["student-lesson", selectedId] });
    }
  });
  return <div className="page-stack">
    <div className="page-header"><div><span className="eyebrow">YOUR LEARNING</span><h1>Assigned lessons</h1><p>Study your published lessons and mark each one complete when you are ready.</p></div></div>
    {lessons.isError && <div role="alert" className="notice notice-error">{(lessons.error as Error).message}</div>}
    {lesson.isError && <div role="alert" className="notice notice-error">{(lesson.error as Error).message}</div>}
    <section className="student-lesson-list">
      {lessons.data?.map((item) => <button className={`card student-lesson-card ${selectedId === item.id ? "student-lesson-selected" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)}>
        <span className="topic-chip">{item.topic.title}</span><strong>{item.title}</strong><small>Version {item.version}{item.completedAt ? " · Completed" : " · Not completed"}</small>
      </button>)}
      {!lessons.data?.length && <div className="card empty-state"><strong>{lessons.isLoading ? "Loading lessons…" : "No lessons assigned yet"}</strong><p>Your teacher will publish lessons for your class or assign them directly to you.</p></div>}
    </section>
    {lesson.data && <article className="card student-lesson-detail">
      <div className="lesson-detail-header"><div><span className="eyebrow">{lessons.data?.find((item) => item.id === lesson.data?.id)?.topic.title}</span><h2>{lesson.data.title}</h2><small>Published version {lesson.data.version}</small></div>
        {lesson.data.completedAt ? <span className="status-pill status-good">completed</span> : <button className="button button-primary" disabled={complete.isPending} onClick={() => complete.mutate()}>{complete.isPending ? "Saving…" : "Mark lesson complete"}</button>}
      </div>
      {complete.isError && <div role="alert" className="notice notice-error">{(complete.error as Error).message}</div>}
      {complete.isSuccess && <div role="status" className="notice notice-success">Lesson progress saved.</div>}
      <LessonContentView content={lesson.data.content} />
    </article>}
  </div>;
}
