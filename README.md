# ChemArena

ChemArena is a LAN-first organic chemistry practice and CBT platform. A teacher's Windows laptop runs the web server; students use a browser on the same school Wi-Fi network or phone hotspot. After the initial installation and build, normal lessons and exams do not need internet access.

## Start on Windows

1. Install Node.js 22 LTS or newer.
2. Double-click [`start.bat`](./start.bat), or run it from PowerShell.
3. Keep the terminal open while students use the platform. The first launch installs dependencies, creates the SQLite database, seeds the syllabus/content, builds the app and starts the server.
4. Open `http://localhost:4174` on the teacher laptop. The one-time admin password and seeded student login slips are printed in the server terminal during first-time setup. Save them and change the admin password after signing in.
5. On the admin dashboard, share a listed LAN URL or its QR code. Students open it while connected to the same Wi-Fi/hotspot.

The Linux/macOS launcher is [`start.sh`](./start.sh). Both launchers use the same default port, `4174`; edit `apps/server/.env` to change `PORT`, `HOST` or `SUBMISSION_GRACE_SECONDS`. The first launcher run creates that file from `apps/server/.env.example`.

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

## Current Phase 1 features

- Argon2 password hashes, HTTP-only same-site session cookies, per-login rate limiting, CSRF headers on mutations, server-side role checks, account deactivation and forced temporary-password changes.
- Editable school name, logo, colors and footer branding.
- Class/student administration and bulk CSV import; generated credentials can be printed with the join URL and QR code.
- Editable syllabus topics, topic coverage counts, question CRUD, approval state, difficulty/tag filters, JSON/CSV import/export, optional image and lazy-loaded SMILES rendering.
- Exam creation by manual question selection or per-topic counts, class assignment, availability window, shuffling, marks and optional negative marking.
- Timed CBT with server-fixed deadlines, saved-answer resume, autosave, question navigation, review flags, full-screen prompt, tab/full-screen event logging and server-side grading. Answer keys and explanations are only returned after grading.
- SQLite in WAL mode with full synchronous writes.

The provided syllabus image does **not** specify exam question count, duration or marking. Those values are chosen for each exam in the builder; ChemArena does not invent official exam-format rules.

### Adding questions in batches

Open **Question bank → Import a batch**:

1. **Spreadsheet/CSV:** download the ChemArena question template, add one question per row, and upload it. Use the exact chapter and learning-outcome names shown on the Syllabus page. Fill `optionA` through `optionD` (optionally `optionE` through `optionH`), and set `correctAnswers` to option letters such as `A` or `A;C` for a multi-answer question. Set `type` to `SINGLE`, `MULTI` or `TRUE_FALSE`, `difficulty` from 1 to 5, and tags as comma-separated text. PapaParse handles quoted commas/newlines in cells.
2. **AI-assisted authoring:** copy the prompt shown in the batch importer, paste it into an AI chat (no ChemArena API key is needed), then paste the returned JSON into the preview. Ask for manageable batches, review chemistry accuracy and distractors yourself, and generate more batches for uncovered syllabus outcomes.
3. **Validate and review:** ChemArena checks the question shape and exact chapter/outcome match, shows invalid rows and warns about exact duplicate stems already in the bank or earlier in the batch. Uncheck anything you do not want. Selected batch imports are always created as **Draft**; then review each question and mark it Approved individually in the question editor before it can appear in exams.

For AI JSON, use `{"questions":[...]}`. Each question has `chapter`, `outcome`, `stem`, `type`, `options` as `{ "id": "a", "text": "..." }` objects, `correctOptionIds` as option IDs, `explanation`, `difficulty`, `tags`, and optional `smiles`. Chapter and outcome must match the Syllabus page. This import process flags exact normalized stem matches; it cannot determine whether two differently worded questions test the same idea or whether an answer is scientifically defensible, so teacher review remains essential. Legacy question CSV exports using internal `topicId` values and JSON-encoded option cells are still accepted.

## Data and security notes

- The SQLite database is at `apps/server/prisma/chemarena.db`. Keep the laptop plugged in during exams and include that directory in normal system backups.
- Sessions and exam answers are stored locally; passwords are hashed. Do not share the `.env` file or database backups.
- The LAN deployment uses plain HTTP as requested. Other people with access to an untrusted Wi-Fi network may be able to observe traffic; use a trusted, isolated school network and do not reuse personal passwords.
- The exam package sent to a student does not contain correct-option IDs or explanations. Students can still inspect the question text and options delivered to their own browser; a client-side exam cannot prevent that.
- **Phase 1 currently requires a working LAN connection for answer autosave and submission.** The resilient IndexedDB outbox, automatic backup schedule/restore and 60-student load test are planned for Phase 2. Do not treat this release as safe for an exam where students may lose connectivity for an extended period.
- ChemArena does not register a service worker and does not claim browser/PWA offline operation over HTTP.

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

## Later phases

- **Phase 2:** offline answer outbox and reconnect sync, deadline/grace handling, student connectivity page, automatic/manual backups and restore, and 60-student load and network-drop tests.
- **Phase 3:** lesson authoring/progress and reviewed, locally stored AI-assisted lesson/question generation.
- **Phase 4:** student/admin analytics, reports, weak-topic practice sets and expanded audit views.
