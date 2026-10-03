import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { QRCodeSVG } from "qrcode.react";
import {
  Activity, BookOpen, Boxes, ChevronRight, CircleHelp, Download, FileUp, FlaskConical, GraduationCap,
  LayoutDashboard, LogOut, Menu, Plus, Printer, RefreshCw, Settings, ShieldCheck, Users, X
} from "lucide-react";
import { api, setCsrfToken, type Branding, type User } from "./api";
import {
  createQuestionPrompt,
  findDuplicateWarnings,
  parseQuestionCsv,
  parseQuestionJson,
  type QuestionImportRow
} from "./questionImport";

type Page = "overview" | "classes" | "students" | "questions" | "syllabus" | "exams" | "settings";
type Dashboard = { studentCount: number; classCount: number; questionCount: number; activeExams: number; attempts: number };
type ClassRecord = { id: string; name: string; status: "ACTIVE" | "INACTIVE"; _count: { enrollments: number } };
type StudentRecord = {
  id: string;
  username: string;
  displayName: string;
  status: "ACTIVE" | "INACTIVE";
  enrollments: Array<{ class: { name: string } }>;
};
type TopicRecord = { id: string; title: string; description: string; parentId: string | null; sourceOrder: number; approvedQuestions?: number; publishedLessons?: number };
type QuestionRecord = {
  id: string;
  stem: string;
  type: string;
  options: Array<{ id: string; text: string }>;
  correctOptionIds: string[];
  explanation: string;
  topicId: string;
  difficulty: number;
  tags: string[];
  smiles: string | null;
  imageDataUrl: string | null;
  status: string;
  topic: TopicRecord;
};
type LoginResult = { user: User; csrfToken: string };

const emptyBranding: Branding = {
  schoolName: "ChemArena",
  primaryColor: "#193b6a",
  accentColor: "#16a085",
  footerLine: "Learn, practise, compete.",
  logoDataUrl: null
};

function ErrorNotice({ message }: { message: string }) {
  return <div role="alert" className="notice notice-error">{message}</div>;
}

function App() {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const [loginError, setLoginError] = useState("");
  const brandingQuery = useQuery({ queryKey: ["branding"], queryFn: () => api<Branding>("/api/settings/branding") });
  const branding = brandingQuery.data ?? emptyBranding;
  const [bootstrapped, setBootstrapped] = useState(false);

  const authQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ user: User | null }>("/api/auth/me"),
    retry: false
  });

  useEffect(() => {
    if (authQuery.data?.user) setUser(authQuery.data.user);
    if (authQuery.isFetched) setBootstrapped(true);
  }, [authQuery.data, authQuery.isFetched]);

  useEffect(() => {
    document.documentElement.style.setProperty("--brand-primary", branding.primaryColor);
    document.documentElement.style.setProperty("--brand-accent", branding.accentColor);
    document.title = branding.schoolName;
  }, [branding]);

  const loginMutation = useMutation({
    mutationFn: (data: { username: string; password: string }) => api<LoginResult>("/api/auth/login", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (result) => {
      setCsrfToken(result.csrfToken);
      setUser(result.user);
      setLoginError("");
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => setLoginError(error.message)
  });

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      setUser(null);
      setCsrfToken("");
      queryClient.clear();
    }
  };

  if (!bootstrapped) return <div className="loading-screen"><FlaskConical className="spin" /> Starting ChemArena…</div>;
  if (!user) return <LoginPage branding={branding} error={loginError} busy={loginMutation.isPending} onLogin={(data) => loginMutation.mutate(data)} />;
  if (user.mustChangePassword) return <ChangePasswordPage user={user} />;
  return (
    <Shell user={user} branding={branding} page={page} onPage={setPage} onLogout={() => void logout()}>
      {user.role === "ADMIN"
        ? <AdminPage page={page} branding={branding} onBrandingSaved={(next) => queryClient.setQueryData(["branding"], next)} />
        : <StudentPage />}
    </Shell>
  );
}

function Brand({ branding, compact = false }: { branding: Branding; compact?: boolean }) {
  return <div className={`brand ${compact ? "brand-compact" : ""}`}>
    {branding.logoDataUrl
      ? <img className="brand-logo" src={branding.logoDataUrl} alt="" />
      : <div className="brand-mark"><FlaskConical size={23} /></div>}
    <div><strong>{branding.schoolName}</strong>{!compact && <span>Organic chemistry learning arena</span>}</div>
  </div>;
}

function LoginPage({ branding, error, busy, onLogin }: {
  branding: Branding;
  error: string;
  busy: boolean;
  onLogin: (data: { username: string; password: string }) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connectivity, setConnectivity] = useState<"idle" | "checking" | "success" | "failed">("idle");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onLogin({ username, password });
  };
  const checkConnection = async () => {
    setConnectivity("checking");
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      setConnectivity(response.ok ? "success" : "failed");
    } catch {
      setConnectivity("failed");
    }
  };
  return <main className="login-page">
    <div className="login-backdrop" />
    <section className="login-card">
      <Brand branding={branding} />
      <div className="login-heading"><span className="eyebrow">WELCOME BACK</span><h1>Sign in to continue</h1><p>Access lessons, practice and computer-based tests.</p></div>
      {error && <ErrorNotice message={error} />}
      <form className="form-stack" onSubmit={submit}>
        <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus /></label>
        <label>Password<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="button button-primary button-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<ChevronRight size={17} /></button>
      </form>
      <div className="connectivity-box">
        <div><ShieldCheck size={17} /><span><strong>Pre-exam connectivity</strong><small>Confirm this device can reach the local server.</small></span></div>
        <button className="button button-outline button-small" onClick={() => void checkConnection()}>{connectivity === "checking" ? "Checking…" : "Test connection"}</button>
        {connectivity !== "idle" && connectivity !== "checking" && <p className={connectivity === "success" ? "connection-ok" : "connection-failed"} role="status">
          {connectivity === "success" ? "Connected to the ChemArena server." : "Cannot reach the server. Check Wi-Fi and ask your administrator."}
        </p>}
      </div>
      <footer>{branding.footerLine}</footer>
    </section>
  </main>;
}

function ChangePasswordPage({ user }: { user: User }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const mutation = useMutation({
    mutationFn: () => api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
    onSuccess: () => setDone(true),
    onError: (e: Error) => setError(e.message)
  });
  return <main className="login-page">
    <section className="login-card">
      <div className="brand-mark"><ShieldCheck /></div><span className="eyebrow">ACCOUNT SECURITY</span>
      <h1>Change your temporary password</h1>
      <p>Welcome, {user.displayName}. Set a new password before continuing.</p>
      {error && <ErrorNotice message={error} />}
      {done ? <div className="notice notice-success">Password changed. Refresh this page to continue.</div> :
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
          <label>Temporary password<input autoComplete="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
          <label>New password (at least 10 characters)<input autoComplete="new-password" type="password" minLength={10} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
          <button className="button button-primary" disabled={mutation.isPending}>Save new password</button>
        </form>}
    </section>
  </main>;
}

const adminNavigation: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "classes", label: "Classes", icon: GraduationCap },
  { id: "students", label: "Students", icon: Users },
  { id: "questions", label: "Question bank", icon: CircleHelp },
  { id: "syllabus", label: "Syllabus", icon: BookOpen },
  { id: "exams", label: "Exams", icon: Boxes },
  { id: "settings", label: "Settings", icon: Settings }
];

function Shell({ user, branding, page, onPage, onLogout, children }: {
  user: User;
  branding: Branding;
  page: Page;
  onPage: (page: Page) => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = user.role === "ADMIN"
    ? adminNavigation
    : [{ id: "overview" as Page, label: "My learning", icon: BookOpen }, { id: "exams" as Page, label: "Exams", icon: Boxes }];
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
      <Brand branding={branding} compact />
      <div className="workspace-label">{user.role === "ADMIN" ? "ADMIN WORKSPACE" : "STUDENT WORKSPACE"}</div>
      <nav aria-label="Main navigation">
        {navigation.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? "nav-active" : ""}`} onClick={() => { onPage(id); setMenuOpen(false); }}>
          <Icon size={18} />{label}{page === id && <span className="nav-indicator" />}
        </button>)}
      </nav>
      <div className="sidebar-bottom"><div className="user-mini"><div className="avatar">{user.displayName.charAt(0).toUpperCase()}</div><div><strong>{user.displayName}</strong><small>{user.role === "ADMIN" ? "Administrator" : user.username}</small></div></div>
        <button className="nav-item nav-logout" onClick={onLogout}><LogOut size={17} />Sign out</button>
      </div>
    </aside>
    {menuOpen && <button aria-label="Close navigation" className="mobile-scrim" onClick={() => setMenuOpen(false)} />}
    <div className="main-column">
      <header className="topbar"><button aria-label="Open navigation" className="icon-button mobile-menu" onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
        <div className="breadcrumb">{navigation.find((item) => item.id === page)?.label ?? "Overview"}<span> / </span>{branding.schoolName}</div>
        <div className="topbar-right"><span className="server-indicator"><i /> Local server</span><span className="topbar-user">{user.displayName}</span></div>
      </header>
      <main className="content-area">{children}</main>
    </div>
  </div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>;
}

function AdminPage({ page, branding, onBrandingSaved }: { page: Page; branding: Branding; onBrandingSaved: (branding: Branding) => void }) {
  switch (page) {
    case "classes": return <ClassesPage />;
    case "students": return <StudentsPage />;
    case "questions": return <QuestionsPage />;
    case "syllabus": return <SyllabusPage />;
    case "exams": return <ExamsPage />;
    case "settings": return <SettingsPage branding={branding} onSaved={onBrandingSaved} />;
    default: return <DashboardPage />;
  }
}

function DashboardPage() {
  const stats = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/api/admin/dashboard") });
  const lan = useQuery({ queryKey: ["lan"], queryFn: () => api<{ addresses: string[]; port: number; joinUrls: string[] }>("/api/admin/lan") });
  const data = stats.data;
  return <div className="page-stack">
    <PageHeader eyebrow="CHEMARENA ADMIN" title="Good day, administrator" description="A quick view of your classes, content and exam activity." />
    {stats.error && <ErrorNotice message={(stats.error as Error).message} />}
    <div className="stats-grid">
      <StatCard label="Active students" value={data?.studentCount ?? "—"} icon={Users} trend="Manage class access" />
      <StatCard label="Classes" value={data?.classCount ?? "—"} icon={GraduationCap} trend="Organize your learners" />
      <StatCard label="Approved questions" value={data?.questionCount ?? "—"} icon={CircleHelp} trend="Across the syllabus" />
      <StatCard label="Active exam attempts" value={data?.attempts ?? "—"} icon={Activity} trend={`${data?.activeExams ?? 0} exams running`} />
    </div>
    <section className="card join-card">
      <div className="join-icon"><Activity size={19} /></div><div className="join-copy"><span className="eyebrow">YOUR LOCAL CLASSROOM</span><h2>Student join address</h2><p>Students must be connected to the same Wi-Fi or hotspot.</p>
        {lan.data?.joinUrls.length ? <><div className="join-addresses">{lan.data.joinUrls.map((url) => <code key={url}>{url}</code>)}</div><div className="join-warning">If a student cannot connect, check Windows Firewall and router/hotspot client isolation. Test from another device before the exam.</div></> : <span className="muted">{lan.isLoading ? "Detecting local network…" : "No LAN address detected. Check that Wi-Fi is connected."}</span>}
      </div>
      {lan.data?.joinUrls[0] && <QRCodeSVG value={lan.data.joinUrls[0]} size={84} level="M" aria-label="Student join QR code" className="join-qr" />}
      <div className="join-status"><span className="status-dot" /> Server ready · port {lan.data?.port ?? "—"}</div>
    </section>
    <section className="quick-actions"><div className="section-heading"><div><span className="eyebrow">GET STARTED</span><h2>Quick actions</h2></div></div>
      <div className="quick-grid">
        <QuickAction icon={Users} title="Add students" text="Create accounts and assign a class." />
        <QuickAction icon={CircleHelp} title="Build your question bank" text="Add and approve syllabus-aligned questions." />
        <QuickAction icon={Boxes} title="Create a mock exam" text="Set duration, marks and question selection." />
      </div>
    </section>
  </div>;
}

function StatCard({ label, value, icon: Icon, trend }: { label: string; value: ReactNode; icon: typeof Users; trend: string }) {
  return <article className="card stat-card"><div className="stat-top"><span>{label}</span><i><Icon size={18} /></i></div><strong className="stat-value">{value}</strong><small>{trend}</small></article>;
}

function QuickAction({ icon: Icon, title, text }: { icon: typeof Users; title: string; text: string }) {
  return <article className="card quick-action"><span className="quick-icon"><Icon size={19} /></span><div><strong>{title}</strong><p>{text}</p></div><ChevronRight className="quick-arrow" size={18} /></article>;
}

function ClassesPage() {
  const client = useQueryClient();
  const classes = useQuery({ queryKey: ["classes"], queryFn: () => api<ClassRecord[]>("/api/admin/classes") });
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const add = useMutation({
    mutationFn: () => api("/api/admin/classes", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => { setName(""); setMessage("Class created."); void client.invalidateQueries({ queryKey: ["classes"] }); },
    onError: (error: Error) => setMessage(error.message)
  });
  const toggle = useMutation({
    mutationFn: (record: ClassRecord) => api(`/api/admin/classes/${record.id}`, {
      method: "PATCH", body: JSON.stringify({ status: record.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })
    }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["classes"] })
  });
  return <div className="page-stack"><PageHeader eyebrow="LEARNER MANAGEMENT" title="Classes" description="Create and manage the groups students are enrolled in." />
    {message && <div className={message.endsWith(".") ? "notice notice-success" : "notice notice-error"}>{message}</div>}
    <section className="card form-card"><h2>Create a class</h2><form className="inline-form" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
      <label className="grow">Class name<input placeholder="e.g. SS1 A" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></label>
      <button className="button button-primary" disabled={add.isPending}><Plus size={17} />Add class</button>
    </form></section>
    <section className="card table-card"><div className="table-title"><h2>All classes</h2><button className="icon-button" onClick={() => void classes.refetch()} title="Refresh"><RefreshCw size={16} /></button></div>
      <div className="table-wrap"><table><thead><tr><th>Class</th><th>Students</th><th>Status</th><th>Action</th></tr></thead><tbody>
        {classes.data?.map((record) => <tr key={record.id}><td className="strong-cell">{record.name}</td><td>{record._count.enrollments}</td><td><StatusPill status={record.status} /></td><td><button className="button button-outline button-small" onClick={() => toggle.mutate(record)}>{record.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></td></tr>)}
        {!classes.data?.length && <EmptyRow columns={4} text={classes.isLoading ? "Loading classes…" : "No classes yet. Create your first class above."} />}
      </tbody></table></div>
    </section>
  </div>;
}

function StudentsPage() {
  const client = useQueryClient();
  const students = useQuery({ queryKey: ["students"], queryFn: () => api<StudentRecord[]>("/api/admin/students") });
  const classes = useQuery({ queryKey: ["classes"], queryFn: () => api<ClassRecord[]>("/api/admin/classes") });
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [classId, setClassId] = useState("");
  const [credentials, setCredentials] = useState<Array<{ name: string; username: string; password: string }>>([]);
  const [error, setError] = useState("");
  const lan = useQuery({ queryKey: ["lan"], queryFn: () => api<{ joinUrls: string[] }>("/api/admin/lan") });
  const add = useMutation({
    mutationFn: () => api<{ student: User; temporaryPassword: string }>("/api/admin/students", {
      method: "POST", body: JSON.stringify({ displayName, username, classId })
    }),
    onSuccess: ({ student, temporaryPassword }) => {
      setCredentials([{ name: student.displayName, username: student.username, password: temporaryPassword }]);
      setDisplayName(""); setUsername(""); setError("");
      void client.invalidateQueries({ queryKey: ["students"] });
    },
    onError: (e: Error) => setError(e.message)
  });
  const importCsv = async (file?: File) => {
    if (!file) return;
    try {
      const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: true, transformHeader: (header) => header.trim().toLowerCase() });
      if (parsed.errors.length) throw new Error(parsed.errors[0]?.message ?? "CSV parsing failed.");
      const rows = parsed.data.map((row) => {
        const className = row.class?.trim();
        const selectedClass = classes.data?.find((record) => record.name.toLowerCase() === className?.toLowerCase());
        return { displayName: row.displayname?.trim(), username: row.username?.trim(), classId: selectedClass?.id ?? row.classid?.trim() };
      });
      if (!rows.length) throw new Error("CSV has no student rows.");
      const result = await api<{ imported: Array<{ username: string; displayName: string; temporaryPassword: string }> }>("/api/admin/students/import", {
        method: "POST", body: JSON.stringify({ students: rows })
      });
      setCredentials(result.imported.map(({ displayName: name, username: studentUsername, temporaryPassword }) => ({ name, username: studentUsername, password: temporaryPassword })));
      setError("");
      await client.invalidateQueries({ queryKey: ["students"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import the student CSV.");
    }
  };
  const setStatus = useMutation({
    mutationFn: (student: StudentRecord) => api(`/api/admin/students/${student.id}/status`, {
      method: "PATCH", body: JSON.stringify({ status: student.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })
    }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["students"] })
  });
  const reset = useMutation({
    mutationFn: (student: StudentRecord) => api<{ student: User; temporaryPassword: string }>(`/api/admin/students/${student.id}/reset-password`, { method: "POST", body: "{}" }),
    onSuccess: ({ student, temporaryPassword }) => setCredentials([{ name: student.displayName, username: student.username, password: temporaryPassword }])
  });
  const printSlip = () => window.print();
  return <div className="page-stack"><PageHeader eyebrow="LEARNER MANAGEMENT" title="Students" description="Issue student accounts, reset passwords and assign classes." action={<button className="button button-outline" onClick={printSlip}><Printer size={16} />Print login slips</button>} />
    {error && <ErrorNotice message={error} />}
    {credentials.length > 0 && <section className="slip-area" role="status"><div className="slip-toolbar"><strong>{credentials.length} login slip{credentials.length === 1 ? "" : "s"} ready to print</strong><button className="icon-button" aria-label="Dismiss" onClick={() => setCredentials([])}><X size={17} /></button></div>
      <div className="slip-grid">{credentials.map((credential) => <article className="credential-slip" key={credential.username}>
        <div><strong>{credential.name}</strong><p>Username: <code>{credential.username}</code><br />Temporary password: <code>{credential.password}</code></p>
          <small>Change your password after signing in.</small><p className="slip-url">{lan.data?.joinUrls[0] ?? "Connect to your school's Wi-Fi"}</p>
        </div>{lan.data?.joinUrls[0] && <QRCodeSVG value={lan.data.joinUrls[0]} size={68} level="M" aria-label="ChemArena join QR code" />}
      </article>)}</div></section>}
    <section className="card form-card"><h2>Add a student</h2><form className="inline-form multi-form" onSubmit={(event) => { event.preventDefault(); add.mutate(); }}>
      <label>Student name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={120} /></label>
      <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required pattern="[a-zA-Z0-9._-]{3,64}" /></label>
      <label>Class<select value={classId} onChange={(event) => setClassId(event.target.value)} required><option value="">Select class</option>{classes.data?.filter((item) => item.status === "ACTIVE").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <button className="button button-primary" disabled={add.isPending || !classId}><Plus size={17} />Add student</button>
    </form><p className="helper-text">A short, randomly generated temporary password will be shown once when the account is created.</p></section>
    <section className="card form-card"><h2>Bulk import students</h2><p className="helper-text">CSV headers: <code>displayName,username,class</code> (use an existing class name) or <code>classId</code>. Passwords are generated once and shown as printable slips.</p>
      <label className="button button-outline file-button"><FileUp size={16} />Choose student CSV<input type="file" accept=".csv,text/csv" onChange={(event) => void importCsv(event.target.files?.[0])} /></label>
      <button className="button button-outline button-small template-button" onClick={() => downloadStudentTemplate()}>Download CSV template</button>
    </section>
    <section className="card table-card"><div className="table-title"><h2>Student accounts</h2><span className="muted">{students.data?.length ?? 0} total</span></div>
      <div className="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Class</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {students.data?.map((student) => <tr key={student.id}><td className="strong-cell">{student.displayName}</td><td><code>{student.username}</code></td><td>{student.enrollments.map((e) => e.class.name).join(", ") || "—"}</td><td><StatusPill status={student.status} /></td><td className="action-cell"><button className="button button-outline button-small" onClick={() => reset.mutate(student)}>Reset password</button><button className="button button-outline button-small" onClick={() => setStatus.mutate(student)}>{student.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></td></tr>)}
        {!students.data?.length && <EmptyRow columns={5} text={students.isLoading ? "Loading students…" : "No student accounts yet."} />}
      </tbody></table></div></section>
  </div>;
}

function StatusPill({ status }: { status: string }) { return <span className={`status-pill ${status === "ACTIVE" || status === "APPROVED" ? "status-good" : "status-muted"}`}>{status.toLowerCase()}</span>; }
function EmptyRow({ columns, text }: { columns: number; text: string }) { return <tr><td colSpan={columns} className="empty-row">{text}</td></tr>; }

function QuestionsPage() {
  const client = useQueryClient();
  const topics = useQuery({ queryKey: ["topics"], queryFn: () => api<TopicRecord[]>("/api/topics") });
  const questions = useQuery({ queryKey: ["questions"], queryFn: () => api<QuestionRecord[]>("/api/admin/questions") });
  const [search, setSearch] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [difficultyFilter, setDifficultyFilter] = useState("");
  const [error, setError] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [importRows, setImportRows] = useState<QuestionImportRow[]>([]);
  const [selectedImportRows, setSelectedImportRows] = useState<number[]>([]);
  const [promptMessage, setPromptMessage] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<QuestionRecord | null>(null);
  const filtered = useMemo(() => questions.data?.filter((question) =>
    question.stem.toLowerCase().includes(search.toLowerCase())
      && (!topicFilter || question.topicId === topicFilter)
      && (!statusFilter || question.status === statusFilter)
      && (!difficultyFilter || question.difficulty === Number(difficultyFilter))
  ) ?? [], [questions.data, search, topicFilter, statusFilter, difficultyFilter]);
  const download = () => {
    if (!questions.data) return;
    const payload = questions.data.map(({ stem, type, options, correctOptionIds, explanation, topicId, difficulty, tags, smiles, imageDataUrl, status }) =>
      ({ stem, type, options, correctOptionIds, explanation, topicId, difficulty, tags, smiles, imageDataUrl, status }));
    const url = URL.createObjectURL(new Blob([JSON.stringify({ questions: payload }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "chemarena-questions.json"; anchor.click(); URL.revokeObjectURL(url);
  };
  const downloadCsv = () => {
    if (!questions.data) return;
    const payload = questions.data.map((question) => {
      const topic = topics.data?.find((item) => item.id === question.topicId);
      const chapter = topic?.parentId ? topics.data?.find((item) => item.id === topic.parentId) : topic;
      return {
        chapter: chapter?.title ?? "",
        outcome: topic?.parentId ? topic.title : "",
        stem: question.stem,
        type: question.type,
        ...Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h"].map((id, index) => [
          `option${id.toUpperCase()}`,
          question.options[index]?.text ?? ""
        ])),
        correctAnswers: question.correctOptionIds
          .map((id) => {
            const optionIndex = question.options.findIndex((option) => option.id === id);
            return optionIndex < 0 ? "" : String.fromCharCode(65 + optionIndex);
          })
          .filter(Boolean)
          .join(";"),
        explanation: question.explanation,
        difficulty: question.difficulty,
        tags: question.tags.join(", "),
        smiles: question.smiles ?? ""
      };
    });
    const url = URL.createObjectURL(new Blob([Papa.unparse(payload)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "chemarena-questions.csv"; anchor.click(); URL.revokeObjectURL(url);
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const text = await file.text();
      const rows = file.name.toLowerCase().endsWith(".csv")
        ? parseQuestionCsv(text, topics.data ?? [])
        : parseQuestionJson(text, topics.data ?? []);
      stageImport(rows);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not import that file."); }
  };
  const stageImport = (rows: QuestionImportRow[]) => {
    const stagedRows = rows.map((row) => {
      if (!row.question) return row;
      const warnings = row.question.status === "APPROVED"
        ? [...row.warnings, "Imported as Draft; review and approve it in the question editor."]
        : row.warnings;
      return { ...row, question: { ...row.question, status: "DRAFT" as const }, warnings };
    });
    const withWarnings = findDuplicateWarnings(stagedRows, questions.data?.map((question) => question.stem) ?? []);
    setImportRows(withWarnings);
    setSelectedImportRows(withWarnings.filter((row) => row.question).map((row) => row.rowNumber));
    setImportMessage("");
  };
  const previewJson = () => {
    try {
      stageImport(parseQuestionJson(jsonText, topics.data ?? [], true));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse the question JSON.");
    }
  };
  const importSelected = async () => {
    const questionsToImport = importRows
      .filter((row) => row.question && selectedImportRows.includes(row.rowNumber))
      .map((row) => ({ ...row.question!, status: "DRAFT" as const }));
    if (!questionsToImport.length) {
      setError("Select at least one valid question to import.");
      return;
    }
    try {
      const result = await api<{ imported: number }>("/api/admin/questions/import", {
        method: "POST",
        body: JSON.stringify({ questions: questionsToImport })
      });
      setImportMessage(`${result.imported} question${result.imported === 1 ? "" : "s"} imported as Draft for review.`);
      setImportRows([]);
      setSelectedImportRows([]);
      setJsonText("");
      setError("");
      await client.invalidateQueries({ queryKey: ["questions"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not import the selected questions.");
    }
  };
  const downloadQuestionTemplate = () => {
    const exampleChapter = topics.data?.find((topic) => !topic.parentId);
    const exampleOutcome = topics.data?.find((topic) => topic.parentId === exampleChapter?.id);
    const example = exampleChapter && exampleOutcome
      ? [{
          chapter: exampleChapter.title,
          outcome: exampleOutcome.title,
          stem: "Which formula represents a saturated acyclic hydrocarbon with three carbon atoms?",
          type: "SINGLE",
          optionA: "C3H8",
          optionB: "C3H6",
          optionC: "C3H4",
          optionD: "C2H6",
          correctAnswers: "A",
          explanation: "Acyclic alkanes have the general formula CnH2n+2.",
          difficulty: 1,
          tags: "alkanes, molecular formula",
          smiles: ""
        }]
      : [];
    const csv = Papa.unparse(example.length ? example : [{
      chapter: "", outcome: "", stem: "", type: "SINGLE", optionA: "", optionB: "", optionC: "", optionD: "",
      correctAnswers: "", explanation: "", difficulty: 1, tags: "", smiles: ""
    }]);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "chemarena-question-template.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(createQuestionPrompt(topics.data ?? []));
      setPromptMessage("Prompt copied. Paste it into your AI chat, then paste its JSON response below.");
    } catch {
      setPromptMessage("Clipboard access is unavailable. Open the prompt below and copy it manually.");
    }
  };
  const deleteQuestion = useMutation({
    mutationFn: (question: QuestionRecord) => api(`/api/admin/questions/${question.id}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["questions"] }),
    onError: (e: Error) => setError(e.message)
  });
  return <div className="page-stack"><PageHeader eyebrow="CONTENT LIBRARY" title="Question bank" description="Browse, write or batch-create syllabus-aligned questions." action={<><button className="button button-outline" onClick={() => { setEditing(null); setEditorOpen(true); }}><Plus size={16} />New question</button><button className="button button-outline" onClick={download}><Download size={16} />Export JSON</button><button className="button button-outline" onClick={downloadCsv}><Download size={16} />Export CSV</button></>} />
    {error && <ErrorNotice message={error} />}{importMessage && <div className="notice notice-success">{importMessage}</div>}
    {editorOpen && topics.data && <QuestionEditor initial={editing} topics={topics.data} onCancel={() => setEditorOpen(false)} onSaved={() => {
      setEditorOpen(false); setError(""); void client.invalidateQueries({ queryKey: ["questions"] });
    }} />}
    <section className="card batch-import">
      <div className="table-title"><div><span className="eyebrow">BUILD YOUR BANK</span><h2>Import a batch</h2></div><button className="button button-outline button-small" onClick={() => void copyPrompt()}>Copy AI prompt</button></div>
      <p className="batch-intro">Fill the spreadsheet template yourself, or use the prompt with an AI chat and paste its JSON response here. Imports are staged for review and created as Draft; nothing is automatically approved.</p>
      <div className="batch-actions"><button className="button button-outline" onClick={downloadQuestionTemplate}><Download size={16} />Download spreadsheet template</button><label className="button button-outline file-button"><FileUp size={16} />Review CSV / JSON file<input type="file" accept=".json,.csv,application/json,text/csv" onChange={(event) => void importFile(event.target.files?.[0])} /></label></div>
      <details className="prompt-details"><summary>View AI prompt and exact JSON format</summary><textarea readOnly rows={10} value={createQuestionPrompt(topics.data ?? [])} /></details>
      {promptMessage && <p className="helper-text" role="status">{promptMessage}</p>}
      <label>Paste an AI-generated JSON batch<textarea className="json-paste" value={jsonText} onChange={(event) => setJsonText(event.target.value)} placeholder={'{"questions":[{"chapter":"exact chapter title","outcome":"exact learning outcome","stem":"...","type":"SINGLE","options":[{"id":"a","text":"..."},{"id":"b","text":"..."},{"id":"c","text":"..."},{"id":"d","text":"..."}],"correctOptionIds":["a"],"explanation":"...","difficulty":2,"tags":["..."],"smiles":null}]}'} rows={5} /></label>
      <div className="batch-actions"><button className="button button-primary" onClick={previewJson} disabled={!jsonText.trim()}>Validate and preview JSON</button></div>
      {importRows.length > 0 && <div className="import-review">
        <div className="table-title"><div><h3>Review import batch</h3><span className="muted">{importRows.filter((row) => row.question).length} valid · {importRows.filter((row) => row.issues.length).length} need fixes · {importRows.filter((row) => row.warnings.length).length} duplicate or review warnings</span></div>
          <button className="button button-primary button-small" onClick={() => void importSelected()} disabled={!selectedImportRows.length}>Import {selectedImportRows.length} as Draft</button>
        </div>
        <div className="import-rows">{importRows.map((row) => <label className={`import-row ${row.issues.length ? "import-row-invalid" : ""}`} key={row.rowNumber}>
          <input type="checkbox" checked={Boolean(row.question && selectedImportRows.includes(row.rowNumber))} disabled={!row.question} onChange={(event) => setSelectedImportRows((current) => event.target.checked ? [...current, row.rowNumber] : current.filter((number) => number !== row.rowNumber))} />
          <span className="import-row-index">#{row.rowNumber}</span>
          <span className="import-row-content">{row.question?.stem ?? row.issues.join(" ")}</span>
          {row.question && <span className="topic-chip">{topics.data?.find((topic) => topic.id === row.question?.topicId)?.title ?? "Topic"}</span>}
          {row.warnings.map((warning) => <small className="import-warning" key={warning}>{warning}</small>)}
          {row.question && <StatusPill status={row.question.status} />}
        </label>)}</div>
      </div>}
    </section>
    <section className="card filter-bar"><label className="grow">Search<input placeholder="Search question text…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>Topic<select value={topicFilter} onChange={(event) => setTopicFilter(event.target.value)}><option value="">All syllabus topics</option>{topics.data?.map((topic) => <option key={topic.id} value={topic.id}>{topic.parentId ? `— ${topic.title}` : topic.title}</option>)}</select></label><label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="DRAFT">Draft</option><option value="APPROVED">Approved</option></select></label><label>Difficulty<select value={difficultyFilter} onChange={(event) => setDifficultyFilter(event.target.value)}><option value="">All</option>{[1,2,3,4,5].map((level) => <option key={level} value={level}>{level}</option>)}</select></label></section>
    <section className="question-list">{filtered.map((question, index) => <article className="card question-card" key={question.id}><div className="question-meta"><span className="question-number">{String(index + 1).padStart(2, "0")}</span><span className="topic-chip">{question.topic.title}</span><StatusPill status={question.status} /><span className="difficulty">Level {question.difficulty}</span><button className="button button-outline button-small" onClick={() => { setEditing(question); setEditorOpen(true); }}>Edit</button><button className="button button-outline button-small" onClick={() => { if (window.confirm("Delete this question? This cannot be undone.")) deleteQuestion.mutate(question); }}>Delete</button></div>
      <h3>{question.stem}</h3><div className="option-preview">{question.options.map((option) => <span className={question.correctOptionIds.includes(option.id) ? "option-correct" : ""} key={option.id}><i>{option.id.toUpperCase()}</i>{option.text}</span>)}</div>
      {question.smiles && <SmilesPreview smiles={question.smiles} />}
      {question.imageDataUrl && <img className="question-image question-list-image" src={question.imageDataUrl} alt="Question structure or image" />}
      {question.explanation && <details><summary>View answer explanation</summary><p>{question.explanation}</p></details>}
    </article>)}{!filtered.length && <div className="card empty-state"><CircleHelp /><strong>{questions.isLoading ? "Loading questions…" : "No questions found"}</strong><p>Try another filter, or import a JSON question set.</p></div>}</section>
  </div>;
}

function QuestionEditor({ initial, topics, onCancel, onSaved }: {
  initial: QuestionRecord | null;
  topics: TopicRecord[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [stem, setStem] = useState(initial?.stem ?? "");
  const [type, setType] = useState(initial?.type ?? "SINGLE");
  const [options, setOptions] = useState(initial?.options ?? [{ id: "a", text: "" }, { id: "b", text: "" }, { id: "c", text: "" }, { id: "d", text: "" }]);
  const [correctOptionIds, setCorrectOptionIds] = useState(initial?.correctOptionIds ?? ["a"]);
  const [explanation, setExplanation] = useState(initial?.explanation ?? "");
  const [topicId, setTopicId] = useState(initial?.topicId ?? topics.find((topic) => topic.parentId)?.id ?? "");
  const [difficulty, setDifficulty] = useState(initial?.difficulty ?? 1);
  const [tags, setTags] = useState(initial?.tags.join(", ") ?? "");
  const [smiles, setSmiles] = useState(initial?.smiles ?? "");
  const [imageDataUrl, setImageDataUrl] = useState(initial?.imageDataUrl ?? null);
  const [status, setStatus] = useState(initial?.status ?? "DRAFT");
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: () => api(initial ? `/api/admin/questions/${initial.id}` : "/api/admin/questions", {
      method: initial ? "PUT" : "POST",
      body: JSON.stringify({
        stem, type, options, correctOptionIds, explanation, topicId, difficulty,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), smiles: smiles.trim() || null, imageDataUrl, status
      })
    }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message)
  });
  const toggleCorrect = (id: string) => {
    setCorrectOptionIds((current) => {
      if (type !== "MULTI") return [id];
      return current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id];
    });
  };
  return <section className="card question-editor"><div className="table-title"><h2>{initial ? "Edit question" : "Create a question"}</h2><button className="icon-button" onClick={onCancel} aria-label="Close editor"><X size={18} /></button></div>
    {error && <ErrorNotice message={error} />}
    <form className="editor-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <label>Question stem<textarea value={stem} onChange={(event) => setStem(event.target.value)} required maxLength={10000} rows={3} /></label>
      <div className="editor-row"><label>Question type<select value={type} onChange={(event) => {
        const nextType = event.target.value;
        setType(nextType);
        if (nextType === "TRUE_FALSE") setOptions([{ id: "a", text: "True" }, { id: "b", text: "False" }]);
        setCorrectOptionIds(["a"]);
      }}><option value="SINGLE">Single answer</option><option value="MULTI">Multiple answers</option><option value="TRUE_FALSE">True / false</option></select></label>
        <label>Syllabus outcome<select value={topicId} onChange={(event) => setTopicId(event.target.value)} required><option value="">Select outcome</option>{topics.filter((topic) => topic.parentId).map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}</select></label>
        <label>Difficulty (1–5)<select value={difficulty} onChange={(event) => setDifficulty(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>{level}</option>)}</select></label>
      </div>
      <fieldset className="option-editor"><legend>Answer options</legend><p className="helper-text">Select the correct answer by checking its box. Select multiple for multi-answer questions.</p>
        {options.map((option, index) => <div className="answer-option-row" key={option.id}><input type={type === "MULTI" ? "checkbox" : "radio"} aria-label={`Mark option ${option.id} correct`} checked={correctOptionIds.includes(option.id)} onChange={() => toggleCorrect(option.id)} name="correctOption" /><span>{option.id.toUpperCase()}</span><input aria-label={`Option ${option.id} text`} value={option.text} onChange={(event) => setOptions((current) => current.map((item) => item.id === option.id ? { ...item, text: event.target.value } : item))} required maxLength={2000} />{options.length > 2 && type !== "TRUE_FALSE" && <button type="button" className="icon-button" onClick={() => { setOptions((current) => current.filter((item) => item.id !== option.id)); setCorrectOptionIds((current) => current.filter((id) => id !== option.id)); }} aria-label="Remove option"><X size={16} /></button>}</div>)}
        {options.length < 8 && type !== "TRUE_FALSE" && <button type="button" className="button button-outline button-small" onClick={() => setOptions((current) => [...current, { id: String.fromCharCode(97 + current.length), text: "" }])}><Plus size={14} />Add option</button>}
      </fieldset>
      <label>Explanation (shown after grading)<textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} maxLength={10000} rows={2} /></label>
      <div className="editor-row"><label>Tags (comma separated)<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="e.g. hydrocarbons, naming" /></label><label>SMILES (optional)<input value={smiles} onChange={(event) => setSmiles(event.target.value)} placeholder="e.g. CCO" /></label></div>
      {smiles && <SmilesPreview smiles={smiles} />}
      <label>Image (optional)<label className="button button-outline file-button logo-upload"><FileUp size={16} />Choose image<input type="file" accept="image/*" onChange={(event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (file.size > 700_000) { setError("Question images must be smaller than 700 KB."); return; }
        const reader = new FileReader();
        reader.onload = () => setImageDataUrl(String(reader.result));
        reader.onerror = () => setError("Could not read that image file.");
        reader.readAsDataURL(file);
      }} /></label></label>
      {imageDataUrl && <div className="image-edit-preview"><img className="question-image" src={imageDataUrl} alt="Question image preview" /><button type="button" className="button button-outline button-small" onClick={() => setImageDataUrl(null)}>Remove image</button></div>}
      <label>Approval status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="DRAFT">Draft — not available in exams</option><option value="APPROVED">Approved</option></select></label>
      <div className="editor-actions"><button type="button" className="button button-outline" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : initial ? "Save changes" : "Create question"}</button></div>
    </form>
  </section>;
}

function SmilesPreview({ smiles }: { smiles: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    void import("smiles-drawer").then((module) => {
      module.default.parse(smiles, (tree) => {
        if (cancelled || !canvasRef.current) return;
        const drawer = new module.default.Drawer({ width: 340, height: 180 });
        drawer.draw(tree, canvasRef.current, "light", false);
        setStatus("ready");
      }, () => { if (!cancelled) setStatus("error"); });
    }).catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, [smiles]);
  return <div className="smiles-preview"><span>Structure preview</span>{status === "loading" && <small>Rendering structure…</small>}{status === "error" && <small role="alert">Could not render this SMILES string.</small>}<canvas ref={canvasRef} width={340} height={180} hidden={status !== "ready"} /></div>;
}

function downloadStudentTemplate(): void {
  const url = URL.createObjectURL(new Blob(["displayName,username,class\nAda Example,ada.example,SS1\n"], { type: "text/csv" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "chemarena-students-template.csv"; anchor.click(); URL.revokeObjectURL(url);
}

function SyllabusPage() {
  const client = useQueryClient();
  const topics = useQuery({ queryKey: ["coverage"], queryFn: () => api<TopicRecord[]>("/api/admin/coverage") });
  const parents = topics.data?.filter((topic) => !topic.parentId) ?? [];
  const [editor, setEditor] = useState<{ topic: TopicRecord | null; parentId: string | null } | null>(null);
  const [error, setError] = useState("");
  const remove = useMutation({
    mutationFn: (topic: TopicRecord) => api(`/api/admin/topics/${topic.id}`, { method: "DELETE" }),
    onSuccess: () => { setError(""); void client.invalidateQueries({ queryKey: ["coverage"] }); void client.invalidateQueries({ queryKey: ["topics"] }); },
    onError: (e: Error) => setError(e.message)
  });
  return <div className="page-stack"><PageHeader eyebrow="SYLLABUS COVERAGE" title="Competition syllabus" description="Edit the 10 official chapters and learning outcomes shown in the supplied syllabus." action={<button className="button button-primary" onClick={() => setEditor({ topic: null, parentId: null })}><Plus size={16} />Add chapter</button>} />
    <div className="coverage-summary card"><BookOpen /><div><strong>{parents.length} chapters in the source syllabus</strong><p>Questions and lessons are tagged to learning-outcome topics beneath each chapter.</p></div></div>
    {topics.isError && <ErrorNotice message={(topics.error as Error).message} />}
    {error && <ErrorNotice message={error} />}
    {editor && <TopicEditor topic={editor.topic} parentId={editor.parentId} parents={parents} onCancel={() => setEditor(null)} onSaved={() => {
      setEditor(null); setError(""); void client.invalidateQueries({ queryKey: ["coverage"] }); void client.invalidateQueries({ queryKey: ["topics"] });
    }} />}
    <div className="coverage-list">{parents.map((parent, index) => {
      const children = topics.data?.filter((topic) => topic.parentId === parent.id) ?? [];
      const questionTotal = children.reduce((sum, topic) => sum + (topic.approvedQuestions ?? 0), 0);
      const lessonTotal = children.reduce((sum, topic) => sum + (topic.publishedLessons ?? 0), 0);
      return <section className="card chapter-card" key={parent.id}><div className="chapter-title"><span className="chapter-index">{String(index + 1).padStart(2, "0")}</span><div><h2>{parent.title}</h2><span>{questionTotal} approved questions · {lessonTotal} published lessons</span></div><span className={`coverage-indicator ${questionTotal ? "coverage-has" : ""}`} /><button className="button button-outline button-small" onClick={() => setEditor({ topic: null, parentId: parent.id })}><Plus size={13} />Outcome</button><button className="button button-outline button-small" onClick={() => setEditor({ topic: parent, parentId: null })}>Edit</button><button className="button button-outline button-small" onClick={() => { if (window.confirm(`Delete chapter "${parent.title}"?`)) remove.mutate(parent); }}>Delete</button></div>
        <div className="outcome-list">{children.map((topic) => <div className="outcome-row" key={topic.id}><span>{topic.title}</span><span>{topic.approvedQuestions ?? 0} questions · {topic.publishedLessons ?? 0} lessons</span><button className="button button-outline button-small" onClick={() => setEditor({ topic, parentId: parent.id })}>Edit</button><button className="button button-outline button-small" onClick={() => { if (window.confirm(`Delete learning outcome "${topic.title}"?`)) remove.mutate(topic); }}>Delete</button></div>)}</div>
      </section>;
    })}</div>
  </div>;
}

function TopicEditor({ topic, parentId, parents, onCancel, onSaved }: {
  topic: TopicRecord | null;
  parentId: string | null;
  parents: TopicRecord[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(topic?.title ?? "");
  const [description, setDescription] = useState(topic?.description ?? "");
  const [selectedParentId, setSelectedParentId] = useState(parentId ?? "");
  const [error, setError] = useState("");
  const mutation = useMutation({
    mutationFn: () => api(topic ? `/api/admin/topics/${topic.id}` : "/api/admin/topics", {
      method: topic ? "PUT" : "POST",
      body: JSON.stringify({ title, description, parentId: selectedParentId || null })
    }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message)
  });
  return <section className="card topic-editor"><div className="table-title"><h2>{topic ? "Edit syllabus topic" : parentId ? "Add learning outcome" : "Add syllabus chapter"}</h2><button className="icon-button" onClick={onCancel} aria-label="Close editor"><X size={17} /></button></div>
    {error && <ErrorNotice message={error} />}
    <form className="editor-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={180} /></label>
      <label>Description / learning outcomes<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={3} /></label>
      {!topic && <label>Parent chapter<select value={selectedParentId} onChange={(event) => setSelectedParentId(event.target.value)}><option value="">Top-level chapter</option>{parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.title}</option>)}</select></label>}
      {topic?.parentId && <p className="helper-text">Learning outcomes cannot be moved between chapters in this editor.</p>}
      <div className="editor-actions"><button type="button" className="button button-outline" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={mutation.isPending}>{mutation.isPending ? "Saving…" : topic ? "Save topic" : "Create topic"}</button></div>
    </form>
  </section>;
}

function SettingsPage({ branding, onSaved }: { branding: Branding; onSaved: (branding: Branding) => void }) {
  const [form, setForm] = useState(branding);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => setForm(branding), [branding]);
  const save = useMutation({
    mutationFn: () => api<Branding>("/api/admin/settings/branding", { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: (saved) => { onSaved(saved); setError(""); setSuccess("Branding settings saved."); },
    onError: (e: Error) => { setSuccess(""); setError(e.message); }
  });
  const uploadLogo = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 700_000) { setError("Choose an image under 700 KB."); return; }
    const reader = new FileReader();
    reader.onload = () => setForm((previous) => ({ ...previous, logoDataUrl: String(reader.result) }));
    reader.onerror = () => setError("Could not read that image file.");
    reader.readAsDataURL(file);
  };
  return <div className="page-stack"><PageHeader eyebrow="SCHOOL IDENTITY" title="Settings" description="Customize the school branding shown across ChemArena." />
    {error && <ErrorNotice message={error} />}{success && <div className="notice notice-success">{success}</div>}
    <section className="card settings-card"><div className="settings-preview"><span className="eyebrow">LIVE PREVIEW</span><Brand branding={form} /><div className="preview-footer">{form.footerLine || "Footer line"}</div></div>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <label>School name<input value={form.schoolName} onChange={(event) => setForm({ ...form, schoolName: event.target.value })} maxLength={120} required /></label>
        <div className="color-row"><label>Primary colour<div className="color-input"><input type="color" value={form.primaryColor} onChange={(event) => setForm({ ...form, primaryColor: event.target.value })} /><code>{form.primaryColor}</code></div></label>
          <label>Accent colour<div className="color-input"><input type="color" value={form.accentColor} onChange={(event) => setForm({ ...form, accentColor: event.target.value })} /><code>{form.accentColor}</code></div></label></div>
        <label>Footer line<input value={form.footerLine} onChange={(event) => setForm({ ...form, footerLine: event.target.value })} maxLength={240} /></label>
        <label>School logo<label className="button button-outline file-button logo-upload"><FileUp size={16} />Upload image<input type="file" accept="image/*" onChange={(event) => void uploadLogo(event.target.files?.[0])} /></label></label>
        {form.logoDataUrl && <button type="button" className="button button-outline button-small" onClick={() => setForm({ ...form, logoDataUrl: null })}>Remove logo</button>}
        <button className="button button-primary" disabled={save.isPending}><Settings size={16} />{save.isPending ? "Saving…" : "Save branding"}</button>
      </form>
    </section>
  </div>;
}

function ExamsPage() {
  const client = useQueryClient();
  const exams = useQuery({ queryKey: ["admin-exams"], queryFn: () => api<ExamRecord[]>("/api/admin/exams") });
  const questions = useQuery({ queryKey: ["questions"], queryFn: () => api<QuestionRecord[]>("/api/admin/questions") });
  const classes = useQuery({ queryKey: ["classes"], queryFn: () => api<ClassRecord[]>("/api/admin/classes") });
  const [selectedExam, setSelectedExam] = useState("");
  const [error, setError] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);
  const monitor = useQuery({
    queryKey: ["exam-monitor", selectedExam],
    queryFn: () => api<AttemptRecord[]>(`/api/admin/exams/${selectedExam}/monitor`),
    enabled: Boolean(selectedExam),
    refetchInterval: 3_000
  });
  const create = useMutation({
    mutationFn: (body: ExamFormData) => api("/api/admin/exams", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { setError(""); setShowBuilder(false); void client.invalidateQueries({ queryKey: ["admin-exams"] }); },
    onError: (e: Error) => setError(e.message)
  });
  const updateAttempt = useMutation({
    mutationFn: ({ attempt, action }: { attempt: AttemptRecord; action: "extend" | "reset" | "void" }) =>
      api(`/api/admin/attempts/${attempt.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "extend" ? { minutes: 5 } : {})
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["exam-monitor", selectedExam] }),
    onError: (e: Error) => setError(e.message)
  });
  const changeExamStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/api/admin/exams/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["admin-exams"] }),
    onError: (e: Error) => setError(e.message)
  });
  const approvedQuestions = questions.data?.filter((question) => question.status === "APPROVED") ?? [];
  return <div className="page-stack"><PageHeader eyebrow="ASSESSMENT" title="Exams" description="Build scheduled computer-based mock exams and monitor student attempts." action={<button className="button button-primary" onClick={() => setShowBuilder(!showBuilder)}><Plus size={16} />{showBuilder ? "Close builder" : "New exam"}</button>} />
    {error && <ErrorNotice message={error} />}
    {showBuilder && <ExamBuilder questions={approvedQuestions} topics={questions.data?.map((q) => q.topic).filter((topic, index, list) => list.findIndex((item) => item.id === topic.id) === index) ?? []} classes={classes.data?.filter((record) => record.status === "ACTIVE") ?? []} onCancel={() => setShowBuilder(false)} onCreate={(body) => create.mutate(body)} busy={create.isPending} />}
    <section className="card table-card"><div className="table-title"><h2>Exam schedule</h2><span className="muted">{exams.data?.length ?? 0} exams</span></div>
      <div className="table-wrap"><table><thead><tr><th>Exam</th><th>Questions</th><th>Duration</th><th>Assigned to</th><th>Status</th><th>Monitor</th></tr></thead><tbody>
        {exams.data?.map((exam) => <tr key={exam.id}><td className="strong-cell">{exam.title}</td><td>{exam.questionCount}</td><td>{exam.durationMinutes} min</td><td>{exam.classes.map(({ class: record }) => record.name).join(", ") || "Individual students"}</td><td><StatusPill status={exam.status} /></td><td className="action-cell"><button className="button button-outline button-small" onClick={() => setSelectedExam(selectedExam === exam.id ? "" : exam.id)}>{selectedExam === exam.id ? "Hide" : "Live monitor"}</button>{exam.status === "SCHEDULED" && <button className="button button-outline button-small" onClick={() => changeExamStatus.mutate({ id: exam.id, status: "CLOSED" })}>Close</button>}</td></tr>)}
        {!exams.data?.length && <EmptyRow columns={6} text={exams.isLoading ? "Loading exams…" : "No exams yet. Create your first mock exam."} />}
      </tbody></table></div>
    </section>
    {selectedExam && <section className="card table-card monitor-card"><div className="table-title"><div><span className="eyebrow">LIVE EXAM MONITOR</span><h2>Student attempts</h2></div><span className="live-label"><i /> Refreshes every 3 seconds</span></div>
      {monitor.error && <ErrorNotice message={(monitor.error as Error).message} />}
      <div className="table-wrap"><table><thead><tr><th>Student</th><th>Joined</th><th>Status</th><th>Progress</th><th>Connection</th><th>Deadline</th><th>Actions</th></tr></thead><tbody>
        {monitor.data?.map((attempt) => <tr key={attempt.user.id}><td className="strong-cell">{attempt.user.displayName}<small className="table-subtitle">{attempt.user.username}</small></td><td>{attempt.joined ? <StatusPill status="ACTIVE" /> : <span className="muted">—</span>}</td><td><StatusPill status={attempt.status} /></td><td>{attempt.answeredCount} / {attempt.questionCount}</td><td><span className={`connection-pill ${attempt.online ? "online" : "offline"}`}><i />{attempt.online ? "Online" : "Offline"}</span></td><td>{attempt.deadline ? new Date(attempt.deadline).toLocaleTimeString() : "—"}</td><td className="action-cell">{attempt.id && attempt.status === "IN_PROGRESS" && <><button className="button button-outline button-small" onClick={() => updateAttempt.mutate({ attempt, action: "extend" })}>+5 min</button><button className="button button-outline button-small" onClick={() => updateAttempt.mutate({ attempt, action: "reset" })}>Reset</button><button className="button button-outline button-small" onClick={() => { if (window.confirm("Void this exam attempt?")) updateAttempt.mutate({ attempt, action: "void" }); }}>Void</button></>}</td></tr>)}
        {!monitor.data?.length && <EmptyRow columns={7} text={monitor.isLoading ? "Loading live attempts…" : "No students are assigned to this exam."} />}
      </tbody></table></div>
    </section>}
  </div>;
}

type ExamRecord = {
  id: string;
  title: string;
  questionCount: number;
  durationMinutes: number;
  status: string;
  classes: Array<{ class: { id: string; name: string } }>;
};
type AttemptRecord = {
  id: string | null;
  user: { id: string; displayName: string; username: string };
  status: string;
  joined: boolean;
  deadline: string | null;
  answeredCount: number;
  questionCount: number;
  online: boolean;
};
type ExamFormData = {
  title: string; description: string; durationMinutes: number; questionCount: number; manualQuestionIds: string[];
  topicWeights: Array<{ topicId: string; count: number }>; difficultyMin: number; difficultyMax: number;
  shuffleQuestions: boolean; shuffleOptions: boolean; marksPerQuestion: number; negativeMarking: boolean;
  negativeMarks: number; opensAt: string | null; closesAt: string | null; classIds: string[]; studentIds: string[];
};

function ExamBuilder({ questions, topics, classes, onCancel, onCreate, busy }: {
  questions: QuestionRecord[]; topics: TopicRecord[]; classes: ClassRecord[];
  onCancel: () => void; onCreate: (data: ExamFormData) => void; busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [manual, setManual] = useState(true);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [topicWeights, setTopicWeights] = useState<Array<{ topicId: string; count: number }>>([]);
  const [difficultyMin, setDifficultyMin] = useState(1);
  const [difficultyMax, setDifficultyMax] = useState(5);
  const [marks, setMarks] = useState(1);
  const [negativeMarking, setNegativeMarking] = useState(false);
  const [negativeMarks, setNegativeMarks] = useState(0.25);
  const [shuffleQuestions, setShuffleQuestions] = useState(true);
  const [shuffleOptions, setShuffleOptions] = useState(true);
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [classIds, setClassIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const leaves = topics.filter((topic) => topic.parentId);
  const count = manual ? manualIds.length : topicWeights.reduce((total, item) => total + item.count, 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (count < 1) { setError("Choose at least one question or add topic weights."); return; }
    if (!classIds.length) { setError("Assign this exam to at least one class."); return; }
    setError("");
    onCreate({
      title, description, durationMinutes, questionCount: count,
      manualQuestionIds: manual ? manualIds : [], topicWeights: manual ? [] : topicWeights,
      difficultyMin, difficultyMax, shuffleQuestions, shuffleOptions, marksPerQuestion: marks,
      negativeMarking, negativeMarks, opensAt: opensAt ? new Date(opensAt).toISOString() : null,
      closesAt: closesAt ? new Date(closesAt).toISOString() : null, classIds, studentIds: []
    });
  };
  const updateWeight = (topicId: string, value: number) => {
    setTopicWeights((current) => {
      const without = current.filter((item) => item.topicId !== topicId);
      return value > 0 ? [...without, { topicId, count: value }] : without;
    });
  };
  return <section className="card exam-builder"><div className="table-title"><h2>Build a mock exam</h2><button className="icon-button" onClick={onCancel} aria-label="Close"><X size={17} /></button></div>
    {error && <ErrorNotice message={error} />}
    <form className="editor-form" onSubmit={submit}>
      <div className="editor-row"><label>Exam title<input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={160} /></label><label>Duration (minutes)<input type="number" min={1} max={480} value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))} required /></label></div>
      <label>Description (optional)<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} rows={2} /></label>
      <fieldset className="choice-field"><legend>Question selection</legend><div className="segmented"><button type="button" className={manual ? "selected" : ""} onClick={() => setManual(true)}>Pick questions manually</button><button type="button" className={!manual ? "selected" : ""} onClick={() => setManual(false)}>Select by topic</button></div>
        {manual ? <div className="manual-question-list">{questions.map((question) => <label className="check-row" key={question.id}><input type="checkbox" checked={manualIds.includes(question.id)} onChange={(event) => setManualIds((current) => event.target.checked ? [...current, question.id] : current.filter((id) => id !== question.id))} /><span>{question.stem}</span><small>{question.topic.title}</small></label>)}{!questions.length && <p className="helper-text">Approve questions in the question bank before creating an exam.</p>}</div>
          : <div className="weight-list">{leaves.map((topic) => <label key={topic.id}>{topic.title}<input type="number" min={0} max={200} value={topicWeights.find((item) => item.topicId === topic.id)?.count ?? 0} onChange={(event) => updateWeight(topic.id, Number(event.target.value))} /></label>)}</div>}
        <p className="helper-text">Question count: <strong>{count}</strong>{!manual && " · set each topic count; totals determine the exam length."}</p>
      </fieldset>
      {!manual && <div className="editor-row"><label>Minimum difficulty<select value={difficultyMin} onChange={(event) => setDifficultyMin(Number(event.target.value))}>{[1,2,3,4,5].map((n) => <option key={n}>{n}</option>)}</select></label><label>Maximum difficulty<select value={difficultyMax} onChange={(event) => setDifficultyMax(Number(event.target.value))}>{[1,2,3,4,5].map((n) => <option key={n}>{n}</option>)}</select></label></div>}
      <fieldset className="choice-field"><legend>Assign to classes</legend><div className="check-list">{classes.map((record) => <label className="check-row" key={record.id}><input type="checkbox" checked={classIds.includes(record.id)} onChange={(event) => setClassIds((current) => event.target.checked ? [...current, record.id] : current.filter((id) => id !== record.id))} /><span>{record.name}</span></label>)}</div></fieldset>
      <div className="editor-row"><label>Available from (optional)<input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} /></label><label>Available until (optional)<input type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} /></label></div>
      <div className="editor-row"><label>Marks per question<input type="number" min={0} max={100} step="0.25" value={marks} onChange={(event) => setMarks(Number(event.target.value))} /></label><label className="check-control"><input type="checkbox" checked={negativeMarking} onChange={(event) => setNegativeMarking(event.target.checked)} />Enable negative marking</label>{negativeMarking && <label>Penalty per wrong answer<input type="number" min={0} max={100} step="0.25" value={negativeMarks} onChange={(event) => setNegativeMarks(Number(event.target.value))} /></label>}</div>
      <div className="check-list horizontal-checks"><label className="check-row"><input type="checkbox" checked={shuffleQuestions} onChange={(event) => setShuffleQuestions(event.target.checked)} />Shuffle question order</label><label className="check-row"><input type="checkbox" checked={shuffleOptions} onChange={(event) => setShuffleOptions(event.target.checked)} />Shuffle option order</label></div>
      <div className="editor-actions"><button type="button" className="button button-outline" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Creating…" : "Create scheduled exam"}</button></div>
    </form>
  </section>;
}

function StudentPage() {
  useEffect(() => {
    const heartbeat = () => void api("/api/auth/heartbeat", { method: "POST", body: "{}" }).catch(() => undefined);
    heartbeat();
    const timer = window.setInterval(heartbeat, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const exams = useQuery({ queryKey: ["student-exams"], queryFn: () => api<Array<{ id: string; title: string; description: string; durationMinutes: number; opensAt: string | null; closesAt: string | null }>>("/api/student/exams") });
  const results = useQuery({ queryKey: ["student-results"], queryFn: () => api<Array<{ id: string; status: string; score: number | null; submittedAt: string | null; exam: { title: string } }>>("/api/student/results") });
  const [player, setPlayer] = useState<ExamPackage | null>(null);
  const [reviewId, setReviewId] = useState("");
  const [startError, setStartError] = useState("");
  const review = useQuery({
    queryKey: ["review", reviewId],
    queryFn: () => api<ReviewData>(`/api/student/results/${reviewId}/review`),
    enabled: Boolean(reviewId)
  });
  const start = useMutation({
    mutationFn: (examId: string) => api<ExamPackage>(`/api/student/exams/${examId}/start`, { method: "POST", body: "{}" }),
    onSuccess: (data) => { setPlayer(data); setStartError(""); },
    onError: (error: Error) => setStartError(error.message)
  });
  if (player) return <CBTPlayer examPackage={player} onExit={() => {
    setPlayer(null);
    void results.refetch();
    void exams.refetch();
  }} />;
  return <div className="page-stack"><PageHeader eyebrow="YOUR LEARNING" title="Welcome to ChemArena" description="Practise organic chemistry and prepare for your next computer-based test." />
    {startError && <ErrorNotice message={startError} />}
    {review.data && <section className="card review-card"><div className="table-title"><div><span className="eyebrow">ANSWER REVIEW</span><h2>{review.data.examTitle} · Score {review.data.score}</h2></div><button className="icon-button" onClick={() => setReviewId("")}><X /></button></div>
      {review.data.questions.map((question, index) => <article key={question.id} className="review-question"><strong>{index + 1}. {question.stem}</strong><div className="option-preview">{question.options.map((option) => <span className={question.correctOptionIds.includes(option.id) ? "option-correct" : question.selectedOptionIds.includes(option.id) ? "option-wrong" : ""} key={option.id}><i>{option.id.toUpperCase()}</i>{option.text}</span>)}</div><p>{question.explanation}</p></article>)}
    </section>}
    {review.isError && <ErrorNotice message={(review.error as Error).message} />}
    <section className="card table-card"><div className="table-title"><h2>Available exams</h2></div><div className="table-wrap"><table><thead><tr><th>Exam</th><th>Duration</th><th>Availability</th><th>Action</th></tr></thead><tbody>
      {exams.data?.map((exam) => <tr key={exam.id}><td className="strong-cell">{exam.title}<small className="table-subtitle">{exam.description}</small></td><td>{exam.durationMinutes} min</td><td>{exam.opensAt ? new Date(exam.opensAt).toLocaleString() : "Open"}</td><td><button className="button button-primary button-small" disabled={start.isPending} onClick={() => start.mutate(exam.id)}>{start.isPending ? "Starting…" : "Start / resume"}</button></td></tr>)}
      {!exams.data?.length && <EmptyRow columns={4} text={exams.isLoading ? "Loading exams…" : "No exams are currently available."} />}
    </tbody></table></div></section>
    <section className="card table-card"><div className="table-title"><h2>My results</h2></div><div className="table-wrap"><table><thead><tr><th>Exam</th><th>Score</th><th>Submitted</th><th>Review</th></tr></thead><tbody>
      {results.data?.map((result) => <tr key={result.id}><td className="strong-cell">{result.exam.title}</td><td>{result.score ?? "—"}</td><td>{result.submittedAt ? new Date(result.submittedAt).toLocaleString() : "—"}</td><td><button className="button button-outline button-small" onClick={() => setReviewId(result.id)}>Review answers</button></td></tr>)}
      {!results.data?.length && <EmptyRow columns={4} text={results.isLoading ? "Loading results…" : "Your graded results will appear here."} />}
    </tbody></table></div></section>
  </div>;
}

type ExamQuestion = { id: string; stem: string; type: string; smiles: string | null; imageDataUrl: string | null; options: Array<{ id: string; text: string }> };
type ExamPackage = {
  attemptId: string;
  exam: { id: string; title: string; durationMinutes: number; marksPerQuestion: number };
  startedAt: string;
  deadline: string;
  serverTime: string;
  graceSeconds: number;
  questions: ExamQuestion[];
  answers: Record<string, string[]>;
};
type ReviewData = {
  examTitle: string;
  score: number | null;
  questions: Array<{
    id: string; stem: string; options: Array<{ id: string; text: string }>;
    correctOptionIds: string[]; selectedOptionIds: string[]; explanation: string; topic: TopicRecord;
  }>;
};

function createIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function CBTPlayer({ examPackage, onExit }: { examPackage: ExamPackage; onExit: () => void }) {
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState(examPackage.answers);
  const answersRef = useRef(answers);
  const [flags, setFlags] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`flags:${examPackage.attemptId}`) ?? "[]") as string[]; } catch { return []; }
  });
  const [remaining, setRemaining] = useState(() => Math.max(0, Date.parse(examPackage.deadline) - Date.parse(examPackage.serverTime)));
  const timerStarted = useRef(performance.now());
  const initialRemaining = useRef(remaining);
  const timeoutIds = useRef(new Map<string, number>());
  const savePromises = useRef(new Map<string, Promise<void>>());
  const [saveState, setSaveState] = useState<"saved" | "saving" | "offline">("saved");
  const [prompt, setPrompt] = useState(true);
  const [fullScreenWarning, setFullScreenWarning] = useState("");
  const [result, setResult] = useState<{ score: number; maxScore: number; topicBreakdown: Array<{ topic: TopicRecord; correct: number; total: number; score: number }> } | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const timerExpiredRef = useRef(false);
  const currentQuestion = examPackage.questions[current]!;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = Math.max(0, initialRemaining.current - (performance.now() - timerStarted.current));
      setRemaining(left);
      if (left === 0 && !timerExpiredRef.current) {
        timerExpiredRef.current = true;
        void submit(true);
      }
    }, 250);
    const visibility = () => {
      void api(`/api/student/attempts/${examPackage.attemptId}/events`, {
        method: "POST",
        body: JSON.stringify({ eventType: document.hidden ? "TAB_HIDDEN" : "TAB_VISIBLE" })
      }).catch(() => undefined);
    };
    const fullscreenchange = () => {
      if (!document.fullscreenElement) {
        void api(`/api/student/attempts/${examPackage.attemptId}/events`, {
          method: "POST",
          body: JSON.stringify({ eventType: "FULLSCREEN_EXIT" })
        }).catch(() => undefined);
      }
    };
    const heartbeat = window.setInterval(() => {
      void api<{ deadline: string; serverTime: string }>(`/api/student/attempts/${examPackage.attemptId}/heartbeat`, { method: "POST", body: "{}" })
        .then(({ deadline, serverTime }) => {
          const serverRemaining = Math.max(0, Date.parse(deadline) - Date.parse(serverTime));
          const localRemaining = Math.max(0, initialRemaining.current - (performance.now() - timerStarted.current));
          if (serverRemaining < localRemaining || serverRemaining - localRemaining > 1_000) {
            initialRemaining.current = serverRemaining;
            timerStarted.current = performance.now();
            setRemaining(serverRemaining);
          }
          setSaveState((state) => state === "offline" ? "saved" : state);
        })
        .catch(() => setSaveState("offline"));
    }, 15_000);
    const onOnline = () => {
      void Promise.all([...savePromises.current.values()]).then(() => setSaveState("saved")).catch(() => setSaveState("offline"));
    };
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreenchange);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreenchange);
      window.removeEventListener("online", onOnline);
      timeoutIds.current.forEach((timeout) => window.clearTimeout(timeout));
    };
  }, [examPackage.attemptId]);

  const saveAnswer = async (questionId: string, selectedOptionIds: string[]) => {
    const previous = savePromises.current.get(questionId);
    const pending = (previous?.catch(() => undefined) ?? Promise.resolve()).then(async () => {
      await api("/api/student/answers", {
        method: "POST",
        body: JSON.stringify({
          attemptId: examPackage.attemptId,
          questionId,
          selectedOptionIds,
          idempotencyKey: createIdempotencyKey(),
          changedAt: Date.now()
        })
      });
      setSaveState(navigator.onLine ? "saved" : "offline");
    }).catch((e: unknown) => {
      setSaveState("offline");
      setError(e instanceof Error ? e.message : "Could not save this answer.");
      throw e;
    }).finally(() => {
      if (savePromises.current.get(questionId) === pending) savePromises.current.delete(questionId);
    });
    savePromises.current.set(questionId, pending);
    await pending;
  };

  const selectOption = (questionId: string, optionId: string) => {
    const prior = answersRef.current[questionId] ?? [];
    const next = currentQuestion.type === "MULTI"
      ? prior.includes(optionId) ? prior.filter((id) => id !== optionId) : [...prior, optionId]
      : [optionId];
    const updated = { ...answersRef.current, [questionId]: next };
    answersRef.current = updated;
    setAnswers(updated);
    setSaveState("saving");
    const existingTimeout = timeoutIds.current.get(questionId);
    if (existingTimeout) window.clearTimeout(existingTimeout);
    timeoutIds.current.set(questionId, window.setTimeout(() => void saveAnswer(questionId, next).catch(() => undefined), 350));
  };

  const submit = async (automatic: boolean) => {
    if (submittedRef.current || submitting) return;
    submittedRef.current = true;
    setSubmitting(true);
    setError("");
    if (automatic) setPrompt(false);
    timeoutIds.current.forEach((timeout) => window.clearTimeout(timeout));
    try {
      await Promise.all(Object.keys(answersRef.current).map((questionId) => {
        const timeout = timeoutIds.current.get(questionId);
        if (timeout) window.clearTimeout(timeout);
        return saveAnswer(questionId, answersRef.current[questionId] ?? []);
      }));
      const graded = await api<{ score: number; maxScore: number; topicBreakdown: Array<{ topic: TopicRecord; correct: number; total: number; score: number }> }>(`/api/student/attempts/${examPackage.attemptId}/submit`, { method: "POST", body: "{}" });
      setResult(graded);
      setSaveState("saved");
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    } catch (e) {
      submittedRef.current = false;
      setError(e instanceof Error ? e.message : "Submission failed. Please retry.");
    } finally {
      setSubmitting(false);
    }
  };

  const startFullScreen = async () => {
    setPrompt(false);
    try {
      await document.documentElement.requestFullscreen();
      setFullScreenWarning("");
    } catch {
      setFullScreenWarning("Full-screen is not available on this device. You can still continue the exam.");
    }
  };
  const toggleFlag = (questionId: string) => {
    setFlags((currentFlags) => {
      const next = currentFlags.includes(questionId) ? currentFlags.filter((id) => id !== questionId) : [...currentFlags, questionId];
      localStorage.setItem(`flags:${examPackage.attemptId}`, JSON.stringify(next));
      return next;
    });
  };
  const formatTime = (milliseconds: number) => {
    const totalSeconds = Math.ceil(milliseconds / 1_000);
    return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
  };
  const onClipboard = (event: ClipboardEvent) => event.preventDefault();
  const onContextMenu = (event: MouseEvent) => event.preventDefault();

  if (result) return <div className="page-stack result-page"><PageHeader eyebrow="EXAM COMPLETE" title="Your result" description={examPackage.exam.title} />
    <section className="card result-score"><span className="eyebrow">TOTAL SCORE</span><strong>{result.score} <small>/ {result.maxScore}</small></strong><p>Your exam has been graded by the server.</p></section>
    <section className="card table-card"><div className="table-title"><h2>Topic breakdown</h2></div><div className="table-wrap"><table><thead><tr><th>Syllabus topic</th><th>Correct</th><th>Score</th></tr></thead><tbody>{result.topicBreakdown.map((entry) => <tr key={entry.topic.id}><td>{entry.topic.title}</td><td>{entry.correct} / {entry.total}</td><td>{entry.score}</td></tr>)}</tbody></table></div></section>
    <button className="button button-primary" onClick={onExit}>Return to my learning</button>
  </div>;

  return <div className="cbt-screen" onCopy={onClipboard} onCut={onClipboard} onPaste={onClipboard} onContextMenu={onContextMenu}>
    {prompt && <div className="exam-prompt"><div className="card exam-prompt-card"><span className="eyebrow">READY TO BEGIN</span><h1>{examPackage.exam.title}</h1><p>This timed exam lasts {examPackage.exam.durationMinutes} minutes. Your deadline is set by the server. Answers are saved as you go.</p><p className="prompt-warning">Do not close this page. If your connection drops, notify the administrator before submitting.</p>{fullScreenWarning && <div className="notice notice-error">{fullScreenWarning}</div>}
      <button className="button button-primary button-full" onClick={() => void startFullScreen()}>Enter full screen and begin</button><button className="button button-outline button-full" onClick={() => setPrompt(false)}>Continue without full screen</button></div></div>}
    <header className="cbt-header"><div><span className="eyebrow">COMPUTER-BASED TEST</span><h1>{examPackage.exam.title}</h1></div><div className="cbt-header-right"><span className={`save-status save-${saveState}`}><i />{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Offline — not synced"}</span><div className={`countdown ${remaining < 60_000 ? "countdown-urgent" : ""}`}><span>TIME LEFT</span><strong>{formatTime(remaining)}</strong></div></div></header>
    {error && <div className="cbt-error"><ErrorNotice message={error} /><button className="button button-outline button-small" onClick={() => void submit(false)}>Retry submit</button></div>}
    {fullScreenWarning && <div className="notice notice-error">{fullScreenWarning}</div>}
    <div className="cbt-layout"><main className="cbt-question-area"><div className="cbt-question-top"><span>QUESTION {current + 1} <span className="muted">OF {examPackage.questions.length}</span></span><button className={`button button-small ${flags.includes(currentQuestion.id) ? "button-flag-active" : "button-outline"}`} onClick={() => toggleFlag(currentQuestion.id)}>{flags.includes(currentQuestion.id) ? "★ Flagged" : "☆ Flag for review"}</button></div>
      <article className="cbt-question"><h2>{currentQuestion.stem}</h2>{currentQuestion.smiles && <SmilesPreview smiles={currentQuestion.smiles} />}{currentQuestion.imageDataUrl && <img className="question-image" src={currentQuestion.imageDataUrl} alt="Question structure" />}
        <div className="cbt-options">{currentQuestion.options.map((option, index) => <button key={option.id} className={`cbt-option ${(answers[currentQuestion.id] ?? []).includes(option.id) ? "cbt-option-selected" : ""}`} onClick={() => selectOption(currentQuestion.id, option.id)}><span className="cbt-option-letter">{String.fromCharCode(65 + index)}</span><span>{option.text}</span><i>{(answers[currentQuestion.id] ?? []).includes(option.id) ? "✓" : ""}</i></button>)}</div>
      </article>
      <div className="cbt-navigation"><button className="button button-outline" disabled={current === 0} onClick={() => setCurrent((index) => index - 1)}>Previous</button><span>{Object.values(answers).filter((selected) => selected.length > 0).length} answered · {flags.length} flagged</span>{current < examPackage.questions.length - 1 ? <button className="button button-primary" onClick={() => setCurrent((index) => index + 1)}>Next question</button> : <button className="button button-primary" onClick={() => void submit(false)} disabled={submitting}>{submitting ? "Submitting…" : "Submit exam"}</button>}</div>
    </main><aside className="cbt-navigator"><h2>Question navigator</h2><p>Select a question to jump to it.</p><div className="navigator-grid">{examPackage.questions.map((question, index) => <button key={question.id} onClick={() => setCurrent(index)} className={`${index === current ? "navigator-current" : ""} ${(answers[question.id] ?? []).length ? "navigator-answered" : ""} ${flags.includes(question.id) ? "navigator-flagged" : ""}`} aria-label={`Question ${index + 1}${(answers[question.id] ?? []).length ? ", answered" : ""}${flags.includes(question.id) ? ", flagged" : ""}`}>{index + 1}</button>)}</div><div className="navigator-legend"><span><i className="legend-answered" />Answered</span><span><i className="legend-flagged" />Flagged</span><span><i className="legend-current" />Current</span></div><button className="button button-danger button-full" onClick={() => { if (window.confirm("Submit your exam now?")) void submit(false); }} disabled={submitting}>Submit exam</button></aside></div>
    <footer className="cbt-footer">Switching tabs is recorded for exam integrity. Please stay on this page.</footer>
  </div>;
}

export default App;
