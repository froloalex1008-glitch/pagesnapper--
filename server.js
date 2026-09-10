import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { capture, SHOTS_DIR } from './capture.js';
import {
  BATCH_DIR, ZIP_NAME, pruneBatchDir, xlsxBufferToCsv,
  uncollectedRun, markDownloaded,
} from './batch.js';
import {
  createJob, getJob, publicJob, startJob, stopJob, exportJob, restoreJob,
  clampConcurrency, MAX_CONCURRENCY, DEFAULT_CONCURRENCY,
} from './jobs.js';
import { listFlows } from './flowhunt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* A hard ceiling on the CSV. Originally just a safety net against a
   mis-pasted file (the client's largest real list is 181 rows); tightened to
   50 after a battle-test run showed FlowHunt itself returning HTTP 500s under
   the concurrent load of a larger batch — this protects FlowHunt's own
   capacity, not just ours. Overridable via .env if that ever changes. */
const MAX_ROWS = Number(process.env.BATCH_MAX_ROWS || 50);

/* Railway (and most container hosts) inject these. When set, the screenshots
   directory is on a remote, ephemeral disk — not the visitor's machine. */
const IS_HOSTED = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.PAGESNAP_HOSTED
);

const app = express();

/* Liveness probe, deliberately registered before the auth middleware so a
   container orchestrator can reach it without credentials. It answers with a
   constant — no version, no configuration, nothing about whether FlowHunt is
   set up — so leaving it unauthenticated gives an anonymous caller nothing
   beyond "this process is up", which the TCP connection already told them. */
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ── Login ──────────────────────────────────────────────────────────────────
   Cookie-session login with a username and password, instead of HTTP Basic
   Auth. Basic Auth shows the browser's own credential dialog and, once
   dismissed, a bare "Authentication required." page with no way back in short
   of reloading. A real form is clearer and can be signed out of.

   Enabled when PAGESNAP_USERNAME and PAGESNAP_PASSWORD are both set. It is
   MANDATORY — the server refuses to start without them — whenever there is
   something behind it worth protecting:
     - FLOWHUNT_API_KEY is configured. The Batch tab then lets anyone who can
       reach the page run the client's flow on our FlowHunt credits, and read
       the resulting exports.
     - the app is running on a host (Railway etc.), where "anyone who can
       reach the page" means the whole internet.
   Locally, with no FlowHunt key, it stays optional so a plain screenshot run
   needs no setup. */
const USERNAME = process.env.PAGESNAP_USERNAME || '';
const PASSWORD = process.env.PAGESNAP_PASSWORD || '';
const AUTH_ENABLED = Boolean(USERNAME && PASSWORD);
const AUTH_REQUIRED = Boolean(process.env.FLOWHUNT_API_KEY) || IS_HOSTED;
const COOKIE = 'pagesnap_session';

if (!AUTH_ENABLED && (USERNAME || PASSWORD)) {
  console.error('\n  ERROR: set BOTH PAGESNAP_USERNAME and PAGESNAP_PASSWORD (only one is set). Refusing to start.\n');
  process.exit(1);
}
if (!AUTH_ENABLED && AUTH_REQUIRED) {
  const why = process.env.FLOWHUNT_API_KEY ? 'FLOWHUNT_API_KEY is configured' : 'this is a hosted deployment';
  console.error(`\n  ERROR: ${why}, so a login is required. Set PAGESNAP_USERNAME and PAGESNAP_PASSWORD. Refusing to start.\n`);
  process.exit(1);
}
if (AUTH_ENABLED && PASSWORD.length < 12) {
  console.error('\n  ERROR: PAGESNAP_PASSWORD must be at least 12 characters. Refusing to start.\n');
  process.exit(1);
}

/* Constant-time compare. A naive === leaks the secret one character at a time
   through response timing. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep the work constant either way
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/* The session cookie value. Derived rather than random, so sessions survive a
   restart or redeploy — and are invalidated automatically if the username or
   password is ever changed. PAGESNAP_SESSION_SECRET can be set to rotate every
   session without changing the password. */
const sessionToken = () =>
  AUTH_ENABLED
    ? crypto.createHmac('sha256', process.env.PAGESNAP_SESSION_SECRET || PASSWORD)
        .update(`pagesnap-session-v2\n${USERNAME}\n${PASSWORD}`).digest('hex')
    : '';

const readCookie = (req, name) =>
  (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

/* Brute-force brake on the login form: after MAX_FAILS wrong attempts from one
   address inside the window, further attempts get a 429 until the window
   passes. In-memory, which is fine for a single-instance app; it exists to
   turn "guessable in an afternoon" into "not worth trying", not to be a
   full account-lockout system. */
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first }
function failuresFor(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) return { count: 0, first: Date.now() };
  return f;
}

if (AUTH_ENABLED) {
  /* Behind Railway's proxy req.ip is the proxy unless Express is told to read
     X-Forwarded-For — without this every visitor shares one rate-limit bucket. */
  if (IS_HOSTED) app.set('trust proxy', 1);

  app.use(express.urlencoded({ extended: false })); // parses the login form POST

  app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

  app.post('/login', (req, res) => {
    const f = failuresFor(req.ip);
    if (f.count >= MAX_FAILS) return res.redirect('/login?error=locked');

    /* Both compared, always, with a bitwise AND rather than && — so a wrong
       username costs the same time as a wrong password and reveals nothing
       about which one it was. */
    const userOk = safeEqual(req.body?.username || '', USERNAME);
    const passOk = safeEqual(req.body?.password || '', PASSWORD);
    if (userOk & passOk) {
      failures.delete(req.ip);
      res.cookie(COOKIE, sessionToken(), {
        httpOnly: true,                                  // not readable by JS, blunts XSS
        sameSite: 'lax',                                 // blunts CSRF
        secure: IS_HOSTED || process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000,                 // one week
      });
      return res.redirect('/');
    }
    failures.set(req.ip, { count: f.count + 1, first: f.first });
    // Generic message, and no hint about which part was wrong.
    return res.redirect('/login?error=1');
  });

  app.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  /* Guard everything else — the UI, every /api route, the saved screenshots
     and the batch exports. Registered after the /login routes so they stay
     reachable. */
  app.use((req, res, next) => {
    if (safeEqual(readCookie(req, COOKIE) || '', sessionToken())) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login');
  });

  console.log(`  auth: enabled — user "${USERNAME}" (login page at /login)`);
} else {
  console.log('  auth: DISABLED (set PAGESNAP_USERNAME and PAGESNAP_PASSWORD to require a login)');
}

/* 15mb, not the 5mb a plain CSV needed — an uploaded .xlsx travels here as
   base64 (~33% larger than the file) and a real client workbook carries
   styles and a header row that a CSV never would. */
app.use(express.json({ limit: '15mb' }));
/* Without this, a body over the limit above returns Express's default HTML
   error page, and the xlsx-upload handler's `res.json()` on the client
   fails to parse it — the user sees "Unexpected token '<'" instead of a
   sentence they can act on. */
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That file is too large to upload (15MB limit).' });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Could not read that upload — the request body was malformed.' });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SHOTS_DIR));
/* Fetching the ZIP is how a run stops being "uncollected". The download itself
   is still plain static serving; this only notes that it happened, so the next
   list can be started without a warning about losing work that is now safe. */
app.get(`/batches/${ZIP_NAME}`, (_req, _res, next) => {
  markDownloaded().catch(() => {});
  next();
});
app.use('/batches', express.static(BATCH_DIR));

/* Streams progress to the browser as newline-delimited JSON, so the UI can show
   each stabilisation step as it happens instead of hanging on a long POST. */
app.post('/api/capture', async (req, res) => {
  const { url, width, deviceScaleFactor } = req.body || {};
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');

  /* If the tab is closed or the connection drops mid-capture, res.write()
     on a dead socket can throw. Guard every write instead of finding out
     the hard way. The capture itself still runs to completion — it isn't
     wired to bail out early — but at least it won't crash the server.
     Deliberately res.on('close'), not req.on('close') — for a POST whose
     body has already been fully read, req's 'close' fires almost
     immediately (as soon as the body stream ends), long before the client
     actually goes away. res only closes when the underlying connection
     really does. */
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (obj) => { if (!closed && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  try {
    const result = await capture({
      url,
      width: Number(width) || 1440,
      deviceScaleFactor: Number(deviceScaleFactor) || 2,
      onLog: (message) => send({ type: 'log', message }),
    });
    /* Tell the UI whether the PNG landed on the user's own disk or on a remote
       container, so it can say something true rather than "saved locally". */
    send({ type: 'done', result: { ...result, hosted: IS_HOSTED } });
  } catch (err) {
    console.error(err);
    send({ type: 'error', message: err.message });
  }
  if (!closed && !res.writableEnded) res.end();
});

/* Proxies FlowHunt's list-flows call so the API key never has to be embedded
   in the frontend — it's typed in, used server-side for this one request, and
   not stored anywhere. */
/* Server-side defaults from .env (FLOWHUNT_API_KEY, FLOWHUNT_WORKSPACE_ID,
   FLOWHUNT_FLOW_ID). Anything typed into the UI wins; a blank field falls back
   to these, so a machine with a configured .env needs nothing pasted in. */
const FH_DEFAULTS = {
  apiKey: process.env.FLOWHUNT_API_KEY || '',
  workspaceId: process.env.FLOWHUNT_WORKSPACE_ID || '',
  flowId: process.env.FLOWHUNT_FLOW_ID || '',
};
/* Tells the UI what is configured without ever sending the key itself. */
app.get('/api/flowhunt/defaults', (_req, res) => {
  res.json({
    hasApiKey: Boolean(FH_DEFAULTS.apiKey),
    hasWorkspaceId: Boolean(FH_DEFAULTS.workspaceId),
    flowId: FH_DEFAULTS.flowId,
    maxConcurrency: MAX_CONCURRENCY,
    defaultConcurrency: DEFAULT_CONCURRENCY,
    maxRows: MAX_ROWS,
  });
});

app.post('/api/flowhunt/flows', async (req, res) => {
  const apiKey = req.body?.apiKey || FH_DEFAULTS.apiKey;
  const workspaceId = req.body?.workspaceId || FH_DEFAULTS.workspaceId;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  try {
    const flows = await listFlows(apiKey, { workspaceId: workspaceId || undefined });
    res.json({ flows });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

/* Same NDJSON-streaming pattern as /api/capture, just longer-running: expands
   every homepage via the chosen flow, screenshots every URL that comes back,
   and finishes with a link to the zipped result. */
/* ── Batch jobs ─────────────────────────────────────────────────────────────
   The CSV is turned into a job once, and the job then lives in the server —
   not in the request. Runs happen in the background at up to MAX_CONCURRENCY
   companies at a time, so the browser can close, reload or come back later,
   and every row can be run or re-run on its own. The UI polls GET
   /api/batch/job for state instead of reading a log. */

/* Every route below merges what the UI sent with the server's own .env
   defaults, in that order — a blank field falls back to .env, a filled one
   wins. The API key never travels back out. */
const fhSettings = (body = {}) => ({
  apiKey: body.apiKey || FH_DEFAULTS.apiKey,
  flowId: body.flowId || FH_DEFAULTS.flowId,
  workspaceId: body.workspaceId || FH_DEFAULTS.workspaceId || undefined,
  width: Number(body.width) || 1440,
  /* Omitted rather than defaulted when the caller says nothing: a /run call
     that does not mention parallelism must leave the job's own setting alone,
     not quietly drop it back to the default. */
  ...(body.concurrency === undefined || body.concurrency === ''
    ? {} : { concurrency: clampConcurrency(body.concurrency) }),
});

/* Creates (or replaces) the job from the parsed CSV. Replacing it is what
   frees the previous run's screenshots: the working directory is keyed by the
   company list, so a different list wipes it. */
/* Turns an uploaded .xlsx into the CSV text the browser's own CSV parser
   already knows how to read (parseCompanyRows in public/index.html) — so an
   Excel list of companies is accepted without teaching the client a second
   parsing path. The file itself is never written to disk or kept past this
   request. */
app.post('/api/batch/xlsx-to-csv', async (req, res) => {
  const b64 = req.body?.file;
  if (!b64 || typeof b64 !== 'string') return res.status(400).json({ error: 'No file' });

  let buffer;
  try {
    buffer = Buffer.from(b64, 'base64');
  } catch {
    return res.status(400).json({ error: 'That did not look like a file upload.' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'That file is empty.' });

  try {
    const csv = await xlsxBufferToCsv(buffer);
    res.json({ csv });
  } catch (err) {
    // A non-.xlsx file (or a corrupt one) fails inside ExcelJS's own parser —
    // its message is technical, so this says plainly what to do instead.
    res.status(400).json({ error: `Could not read that as an Excel file (${err.message}). Try re-saving it as .xlsx, or upload a .csv instead.` });
  }
});

/* What the last finished run left behind, if nobody has downloaded it. The UI
   asks on load so it can keep a reminder in front of you, rather than only
   finding out at the moment the files are about to go. */
app.get('/api/batch/uncollected', async (_req, res) => {
  const stamp = await uncollectedRun().catch(() => null);
  if (!stamp) return res.json({ uncollected: null });
  res.json({
    uncollected: {
      companyCount: stamp.companyCount ?? null,
      totalShots: stamp.totalShots ?? null,
      zipBytes: stamp.zipBytes ?? null,
      exportedAt: stamp.exportedAt ?? null,
      zipFile: ZIP_NAME,
    },
  });
});

app.post('/api/batch/job', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const companies = rows.map((r) => String(r?.raw ?? r ?? '').trim()).filter(Boolean);
  if (!companies.length) return res.status(400).json({ error: 'No company rows' });
  if (companies.length > MAX_ROWS) return res.status(400).json({ error: `Too many rows (max ${MAX_ROWS})` });

  const settings = fhSettings(req.body);
  if (!settings.apiKey || !settings.flowId) return res.status(400).json({ error: 'Missing apiKey or flowId' });

  const existing = getJob();
  if (existing?.running) return res.status(409).json({ error: 'A batch is still running — stop it first' });

  /* Only one run's files fit on disk, so a different list wipes the last one.
     If its export was never downloaded, stop and say so — the caller has to
     ask again with confirmWipe once the person has actually decided. Running
     the SAME list again is a resume, not a loss, so it passes straight through. */
  if (!req.body?.confirmWipe) {
    const stamp = await uncollectedRun().catch(() => null);
    const sameList = stamp
      && Array.isArray(stamp.companies)
      && stamp.companies.length === companies.length
      && stamp.companies.every((c, i) => c === companies[i]);
    if (stamp && !sameList) {
      return res.status(409).json({
        error: 'The last run has not been downloaded yet',
        code: 'uncollected_run',
        uncollected: {
          companyCount: stamp.companyCount ?? null,
          totalShots: stamp.totalShots ?? null,
          zipBytes: stamp.zipBytes ?? null,
          exportedAt: stamp.exportedAt ?? null,
          zipFile: ZIP_NAME,
        },
      });
    }
  }

  const job = createJob({
    companies,
    headers: Array.isArray(req.body?.headers) ? req.body.headers.map(String) : [],
    cells: rows.map((r) => (Array.isArray(r?.cells) ? r.cells.map(String) : [String(r?.raw ?? r ?? '')])),
    settings,
  });
  res.json({ job: publicJob(job) });
});

app.get('/api/batch/job', (_req, res) => {
  const job = getJob();
  if (!job) return res.json({ job: null });
  res.json({ job: publicJob(job) });
});

/* Starts the whole list, or just the rows named in `indexes` — which is how
   the UI's per-row "Run" button works. Returns as soon as the work is queued. */
app.post('/api/batch/job/:id/run', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job — load the CSV again' });
  if (job.running) return res.status(409).json({ error: 'Already running' });

  const settings = fhSettings(req.body);
  if (!settings.apiKey || !settings.flowId) return res.status(400).json({ error: 'Missing apiKey or flowId' });

  const indexes = Array.isArray(req.body?.indexes)
    ? req.body.indexes.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < job.rows.length)
    : null;

  startJob(job, { indexes, concurrency: settings.concurrency, settings });
  res.json({ job: publicJob(job) });
});

app.post('/api/batch/job/:id/stop', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  stopJob(job);
  res.json({ job: publicJob(job) });
});

/* Builds results.xlsx and the zip from whatever has finished so far. Separate
   from running, so a list can be exported, a few failed rows re-run, and the
   export rebuilt without redoing the other two hundred companies. */
app.post('/api/batch/job/:id/export', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  try {
    const result = await exportJob(job);
    res.json({
      /* Deliberately not the full row objects: the UI already has every one of
         them from polling, and a 181-row payload here is pure duplication. */
      zipFile: result.zipFile,
      bytes: result.bytes,
      totalCompanies: result.totalCompanies,
      totalShots: result.totalShots,
      pagesDocumented: result.pagesDocumented,
      productShots: result.productShots,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/shots', async (_req, res) => {
  const names = (await fs.readdir(SHOTS_DIR).catch(() => [])).filter((f) => f.endsWith('.png'));
  const files = [];
  for (const name of names) {
    const st = await fs.stat(path.join(SHOTS_DIR, name)).catch(() => null);
    if (st) files.push({ name, bytes: st.size, mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  res.json({ files: files.slice(0, 200) });
});

/* No explicit host: Node binds dual-stack (both ::1 and 127.0.0.1 locally, and
   all interfaces in a container). Pinning to '0.0.0.0' drops the IPv6 listener,
   which breaks browsers that resolve localhost to ::1 first. */
/* Two pieces of startup tidying, both about not carrying dead weight forever:
   drop the timestamped zips and per-run folders an older version of this app
   left in the batches directory, and pick up the last job's rows so a restart
   mid-run does not offer to redo everything that already finished. */
const removed = await pruneBatchDir();
if (removed) console.log(`  batches: reclaimed ${removed} directory/zip(s) from older runs`);
const restored = await restoreJob({ ...FH_DEFAULTS, width: 1440, concurrency: DEFAULT_CONCURRENCY });
if (restored) console.log(`  batches: restored the last job (${restored.rows.length} row(s))`);

app.listen(PORT, () => {
  console.log(`\n  pagesnap running → http://localhost:${PORT}`);
  console.log(`  screenshots → ${SHOTS_DIR}\n`);
});
