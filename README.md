# ChemArena

ChemArena is a LAN-first organic chemistry practice and CBT platform. A teacher's Windows laptop runs the web server; students use a browser on the same school Wi-Fi network or phone hotspot. After the initial installation and build, normal lessons and exams do not need internet access.

## Start on Windows

1. Install Node.js 22 LTS or newer.
2. Double-click [`start.bat`](./start.bat), or run it from PowerShell.
3. Keep the terminal open while students use the platform. The first launch installs dependencies, creates the SQLite database, seeds the syllabus/content, builds the app and starts the server.
4. Open `http://localhost:4174` on the teacher laptop. The one-time admin password and seeded student login slips are printed in the server terminal during first-time setup. Save them and change the admin password after signing in.
5. On the admin dashboard, share a listed LAN URL or its QR code. Students open it while connected to the same Wi-Fi/hotspot.

The Linux/macOS launcher is [`start.sh`](./start.sh). Both launchers use the same default port, `4174`; edit `apps/server/.env` to change `PORT`, `HOST`, `SUBMISSION_GRACE_SECONDS` or `AUTO_BACKUP_INTERVAL_MINUTES`. The first launcher run creates that file from `apps/server/.env.example`. Optional AI generation is configured using `OPENAI_API_KEY` and `OPENAI_MODEL` in this server-only file; keep the key private.

### npm install-script approval

Recent npm versions may block native package setup scripts on a new machine. The Windows launcher approves the required Prisma, argon2 and esbuild scripts after install. If setup is run manually and Prisma/argon2 reports a missing native engine, run:

```powershell
npm install-scripts approve @prisma/client @prisma/engines prisma argon2 esbuild
npm run db:generate
```

Do not expose this plain-HTTP server to the public internet.

## LAN access and connectivity

### Windows Firewall

Allow inbound TCP traffic to the configured port on the **Private** network profile. Open PowerShell as Administrator and run:

```powershell
New-NetFirewallRule -DisplayName "ChemArena LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4174 -Profile Private
```

If the port is changed in `.env`, use that port in the firewall rule and join URL. Do not create a public-profile or internet-facing rule for a school server.

### Keep the laptop address stable

The dashboard detects active IPv4 LAN interfaces and shows their join URLs. For a reliable URL:

1. Find the laptop's Wi-Fi MAC address and current LAN IP (`ipconfig`).
2. In the router's DHCP settings, reserve that address for the laptop.
3. Reconnect the laptop and confirm the address shown on the dashboard matches the reservation.

Do not rely on a manually configured static address unless the network administrator has assigned a safe address outside the DHCP pool.

### Phone hotspot caveats

Hotspot behavior varies by phone and carrier. Some hotspots isolate connected clients, change the laptop's IP when recreated, or restrict local traffic. Connect both the teacher laptop and one student device to the hotspot, read the current join URL from the dashboard, and test the student device before class. Keep the hotspot awake and powered during an exam.

The login screen includes a **Test connection** check. Open the join URL from a second phone/tablet/laptop and run that check before exam day. The server cannot reliably detect router client isolation from the teacher laptop alone; if the test fails while both devices show the same Wi-Fi name, check the router/hotspot's AP/client-isolation setting, Windows Private firewall rule and current laptop IP.

## Seed content and accounts

First-time setup seeds:

- One admin account (`admin`, unless `ADMIN_USERNAME` is set before seeding).
- Two classes (`SS1`, `SS2`) and ten sample students.
- The ten official syllabus chapters shown in the attached Prime STEM syllabus image. Each chapter is a parent topic and each listed learning outcome is a child topic.
- Forty approved beginner organic-chemistry MCQs, four per chapter.

Passwords are generated locally and shown once in the terminal. Students must change their temporary password at first sign-in. To issue new student credentials later, use **Students → Reset password** or create accounts in the admin panel. Bulk student CSV headers are `displayName,username,class`; `class` must match an active class name. Download the in-app template for an example.

## Phase 1 features

- Argon2 password hashes, HTTP-only same-site session cookies, per-login rate limiting, CSRF headers on mutations, server-side role checks, account deactivation and forced temporary-password changes.
- Editable school name, logo, colors and footer branding.
- Class/student administration and bulk CSV import; generated credentials can be printed with the join URL and QR code.
- Editable syllabus topics, topic coverage counts, question CRUD, approval state, difficulty/tag filters, JSON/CSV import/export, optional image and lazy-loaded SMILES rendering.
- Exam creation by manual question selection or per-topic counts, class assignment, availability window, shuffling, marks and optional negative marking.
- Timed CBT with server-fixed deadlines, saved-answer resume, autosave, question navigation, review flags, full-screen prompt, tab/full-screen event logging and server-side grading. Answer keys and explanations are only returned after grading.
- SQLite in WAL mode with full synchronous writes.

The provided syllabus image does **not** specify exam question count, duration or marking. Those values are chosen for each exam in the builder; ChemArena does not invent official exam-format rules.

## Phase 2: resilience and LAN operation

- Each started exam package is cached in the student's browser IndexedDB. Answer changes are written there immediately and queued in an idempotent outbox; retries run in the background and after reconnection. A refresh on the same device restores the latest local answers.
- The player uses a monotonic countdown while open and corrects it with the server deadline whenever the server can be reached. At zero, it freezes one complete local answer snapshot and retries submission until the server confirms grading.
- The server grades only after receiving that final snapshot. It accepts exactly one frozen final snapshot per attempt, including after the normal answer grace window, so a disconnected student can finish syncing. The server cannot prove when edits in an unsynced snapshot were made; this is a deliberate availability trade-off, not tamper-proof offline testing.
- The **Saved / Saving / Offline — answers safe on this device** indicator distinguishes server acknowledgement from local-only answers. No service worker is used; students must keep the exam tab open during a network outage. If the browser or device closes while both the app server and LAN are unreachable, the app shell cannot be reopened over plain HTTP until the server is reachable again.
- SQLite uses WAL mode and full synchronous writes. ChemArena makes a timestamped automatic database snapshot every 15 minutes by default and keeps automatic snapshots for 7 days; older automatic snapshots are removed, while manual snapshots are retained. Change the schedule with `AUTO_BACKUP_INTERVAL_MINUTES` in `apps/server/.env`.
- Backups are written to the repository's `backups` folder by default. Set `BACKUP_DIRECTORY` in `apps/server/.env` to use another local folder or drive; keep it on storage with enough free space and include it in normal system backups.
- **Settings → Backups and restore** creates a consistent one-click backup and lists restore points. Restore validates the SQLite database, creates a safety backup of the current database, then restarts the server. The Windows `start.bat` launcher restarts it automatically; sign in again after restore. A server started directly with `npm run start --workspace @chemarena/server` must be started again manually after a restore.
- The login screen's **Test connection** button checks the server from the student's device. It confirms server reachability but cannot diagnose router client isolation from the laptop itself.

### Load and network-drop tests

Run the unit tests and build with:

```powershell
npm test
npm run build
```

The Playwright network-drop test requires a running ChemArena server, Chromium (`npx playwright install chromium` once), a dedicated student account that has already changed its temporary password, and an assigned exam. It submits that account's exam attempt, so do not use a real student's active exam:

```powershell
$env:CHEMARENA_E2E_USERNAME = "offline-test-student"
$env:CHEMARENA_E2E_PASSWORD = "use-a-disposable-password"
npm run test:e2e
```

For the 60-student load test, prepare exactly 60 disposable student credentials and an exam assigned to those students or their class. Save credentials as a JSON array in a private local file (never commit or share it):

```json
[
  { "username": "load-student-01", "password": "..." },
  { "username": "load-student-02", "password": "..." }
]
```

The actual file must contain all 60 accounts. The script limits simultaneous password verification to six logins to avoid a sharp Argon2 memory spike, then starts all attempts, autosaves one answer per student, and submits all attempts concurrently. Successful submissions consume those accounts' attempts; use a dedicated test exam and disposable accounts only.

```powershell
$env:LOAD_TEST_EXAM_ID = "your-dedicated-exam-id"
$env:LOAD_TEST_USERS = ".\load-test-users.json"
npm run load:test
```

### Adding questions in batches

Open **Question bank → Import a batch**:

1. **Spreadsheet/CSV:** download the ChemArena question template, add one question per row, and upload it. Use the exact chapter and learning-outcome names shown on the Syllabus page. Fill `optionA` through `optionD` (optionally `optionE` through `optionH`), and set `correctAnswers` to option letters such as `A` or `A;C` for a multi-answer question. Set `type` to `SINGLE`, `MULTI` or `TRUE_FALSE`, `difficulty` from 1 to 5, and tags as comma-separated text. PapaParse handles quoted commas/newlines in cells.
2. **AI-assisted authoring:** copy the prompt shown in the batch importer, paste it into an AI chat (no ChemArena API key is needed), then paste the returned JSON into the preview. Ask for manageable batches, review chemistry accuracy and distractors yourself, and generate more batches for uncovered syllabus outcomes.
3. **Validate and review:** ChemArena checks the question shape and exact chapter/outcome match, shows invalid rows and warns about exact duplicate stems already in the bank or earlier in the batch. Uncheck anything you do not want. Selected batch imports are always created as **Draft**. In the question list, filter to **Draft**, review questions, select the ones you have checked, and use **Approve selected drafts** to approve them together.

For AI JSON, use `{"questions":[...]}`. Each question has `chapter`, `outcome`, `stem`, `type`, `options` as `{ "id": "a", "text": "..." }` objects, `correctOptionIds` as option IDs, `explanation`, `difficulty`, `tags`, and optional `smiles`. Chapter and outcome must match the Syllabus page. This import process flags exact normalized stem matches; it cannot determine whether two differently worded questions test the same idea or whether an answer is scientifically defensible, so teacher review remains essential. Legacy question CSV exports using internal `topicId` values and JSON-encoded option cells are still accepted.

## Phase 3: lessons and AI assistance

- **Lessons** is available to admins for Markdown lesson editing, syllabus tagging, class and individual-student assignment, version history, draft review and publishing. Editing a published lesson creates a newer version; students continue seeing the last published version until the admin publishes the update.
- Students see only published lessons assigned to one of their classes or directly to them. Their completion marker is private to their account.
- Lesson Markdown supports LaTeX (`$...$` / `$$...$$`) and lazily rendered SMILES diagrams in a fenced code block labelled `smiles`. HTML in Markdown is not enabled.
- The lesson editor accepts validated JSON as well as manual editing. A lesson contains objectives, an explanation, worked examples, a hands-on activity, exactly ten quiz questions and homework.
- The existing question-bank paste-JSON workflow remains available without an API key. Built-in question and lesson generation supports OpenAI and Google Gemini; configure `OPENAI_API_KEY` / `OPENAI_MODEL` and/or `GEMINI_API_KEY` / `GEMINI_MODEL` in `apps/server/.env`. `AI_PROVIDERS` optionally sets provider preference, for example `gemini,openai`; when blank, configured Gemini and OpenAI keys are detected automatically. The server requires internet only while generating; generated content is stored in the local SQLite database and normal lessons, practice and exams do not need internet. Restart the server after editing `.env`.
- AI-generated questions are saved as **Draft** with source `AI`. Generation checks schema and basic SMILES syntax, and warns on exact duplicate stems. It cannot establish chemical truth or prove that an answer is the only defensible one. Review all content and answers yourself before publishing a lesson or approving a question; nothing generated is auto-published or auto-approved.
- Chemistry structures can be included as SMILES text and are rendered for preview; the syntax check is intentionally lightweight and is not a chemistry validator.

## Data and security notes

- The SQLite database is at `apps/server/prisma/chemarena.db`. Keep the laptop plugged in during exams and include that directory in normal system backups.
- Sessions and exam answers are stored locally; passwords are hashed. Do not share the `.env` file or database backups.
- The LAN deployment uses plain HTTP as requested. Other people with access to an untrusted Wi-Fi network may be able to observe traffic; use a trusted, isolated school network and do not reuse personal passwords.
- The exam package sent to a student does not contain correct-option IDs or explanations. Students can still inspect the question text and options delivered to their own browser; a client-side exam cannot prevent that.
- Answers can be changed while the exam is open without a server connection, but local browser storage is not a substitute for a separate laptop/database backup. Students should not clear browser data, use private browsing, switch devices mid-exam, or close the exam tab during a dropout.
- Offline auto-submit stores and retries one frozen final snapshot. The server accepts that snapshot once even after the grace period because it cannot independently verify its client-side freeze time; a student who can modify browser storage or script requests may alter an unsynced snapshot. Answer keys and explanations remain server-side until grading.
- Device clock changes cannot extend an attempt when online because the server deadline is authoritative and the in-page timer uses a monotonic clock. After a full browser restart while disconnected, elapsed-time recovery necessarily relies on the last saved server time and the device clock until reconnection.
- ChemArena does not register a service worker and does not claim full browser/PWA offline operation over HTTP. A network drop during an already-open exam is supported; a disconnected browser cannot reload the app shell from the server.

## Development commands

```powershell
npm install
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

Vite listens on `http://localhost:5173` and proxies `/api` to the Fastify server on `4174`. For a production-style local run, use `npm run build` followed by `npm run start --workspace @chemarena/server`.

### Useful commands

```powershell
npm test
npm run build
npm run db:seed
```

`db:seed` is safe to rerun for the seeded records; it does not reset the database or replace existing passwords. To start over, stop the server and manually preserve or remove the database files only after making a backup.

## Troubleshooting

- **Student page cannot open:** verify both devices are on the same network; use the dashboard URL (not `localhost`) on the student device; check the Windows Private firewall rule; confirm the IP did not change.
- **URL opens on the laptop but not another device:** check AP/client isolation, hotspot client restrictions and VPN settings on the laptop; try the connectivity test from another device.
- **Port is already in use:** set a different `PORT` in `apps/server/.env`, update the Windows firewall rule, then restart ChemArena.
- **Admin terminal closes:** keep the launcher window open while the server is in use.
- **Database/native engine errors on first setup:** rerun the npm install-script approval command above, then run `npm run db:generate`.
- **Lost temporary password:** reset the student's password in the admin panel. Admin credentials cannot be recovered; retain the one-time first-run password securely and make a backup before changing the database.

## Phase 1 manual test checklist

1. Run `start.bat`, sign in as the first-run admin, change the temporary password and confirm the session still works.
2. On a second device on the same Wi-Fi, open the dashboard join URL and verify **Test connection** succeeds.
3. Confirm the dashboard shows 2 classes, 10 students and 40 approved questions; check topic coverage across all 10 chapters.
4. Create a class and student, print the login slip, then sign in as that student and change their temporary password.
5. Import a valid student CSV and a JSON/CSV question set; try a duplicate username and malformed question and confirm the UI reports the error.
6. Create/edit/approve a question, verify the correct option and explanation in admin preview, and verify its SMILES (if provided) renders.
7. Create an exam, assign it to a class, set a short duration and start it from the student account.
8. Change answers, refresh the page and confirm the attempt resumes with saved answers and remaining server time.
9. Submit the exam; confirm grading and topic breakdown appear, then review explanations. Verify a student cannot open admin APIs.
10. In a second attempt, switch tabs and confirm the admin monitor records events without punishing the student.

## Phase 2 manual test checklist

1. On a disposable exam account and test exam, start the exam, answer a question, refresh while the server is reachable, and confirm the latest answer restores.
2. Begin another test attempt, block the `/api/student/answers` request or disconnect Wi-Fi, change answers, and confirm the player shows **Offline — answers safe on this device** while the question navigator continues working.
3. Reconnect before the deadline and confirm pending answers flush and the status returns to **Saved**.
4. In a short-duration test exam, disconnect before the timer expires. Confirm the player freezes the answer snapshot at zero, keeps retrying submission, and displays the graded result after reconnecting—even when reconnection is after the configured grace period.
5. As admin, create a manual backup in **Settings → Backups and restore**. Confirm it appears in the list alongside automatic backups.
6. Restore a test backup. Confirm ChemArena restarts, requires sign-in again, and the database contents match the selected backup. Keep a separate backup of any data that must not be replaced.
7. Open the join URL from a second device and use **Test connection** before an exam. Confirm a blocked firewall or client-isolated hotspot is diagnosed using the LAN troubleshooting steps above.
8. On disposable data only, run the Playwright network-drop test and the 60-student load test. Review all reported failures and response-time percentiles.

## Phase 3 manual test checklist

1. As admin, create a lesson for a syllabus outcome, write Markdown using a LaTeX formula and a `smiles` code fence, and assign it to one class and one individual student.
2. Save the lesson as a draft and confirm students cannot see it. Publish it, then sign in as a learner outside those assignments and confirm it remains hidden.
3. Sign in as an assigned learner; open the lesson, reveal quiz answers, mark it complete, refresh, and confirm completion remains recorded.
4. Edit a published lesson and save a new version. Confirm students still see the old published version until **Publish latest version** is selected.
5. Paste malformed and valid lesson JSON to confirm validation; verify the quiz must contain exactly ten valid MCQs.
6. Use the question-bank prompt/paste path without an OpenAI key. Confirm imported questions remain Draft and review warnings are visible.
7. Optionally configure a server-side OpenAI key, generate a lesson and a small question batch, and verify the content is staged/stored locally, marked AI/Draft, and not automatically published or approved. Do not put the API key in browser code or share it.
8. After these manual checks, Phase 3 is ready for review before beginning Phase 4 analytics.

## Later phases

- **Phase 4:** student/admin analytics, reports, weak-topic practice sets and expanded audit views.
