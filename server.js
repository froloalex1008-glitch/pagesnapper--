import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { capture, SHOTS_DIR } from './capture.js';
import { runBatch, BATCH_DIR } from './batch.js';
import { listFlows } from './flowhunt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

/* Railway (and most container hosts) inject these. When set, the screenshots
   directory is on a remote, ephemeral disk — not the visitor's machine. */
const IS_HOSTED = Boolean(
  process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.PAGESNAP_HOSTED
);

const app = express();

/* ── Login ──────────────────────────────────────────────────────────────────
   Cookie-session login with a username and password, instead of HTTP Basic
   Auth. Basic Auth shows the browser's own credential dialog and, once
   dismissed, a bare "Authentication required." page with no way back in short
   of reloading. A real form is clearer and can be signed out of.

   Enabled when PAGESNAP_USERNAME and PAGESNAP_PASSWORD are both set. It is
   MANDATORY — the server refuses to start without them — whenever there is
   something behind it worth protecting:
     - FLOWHUNT_API_KEY is configured. The Batch tab then lets anyone who can
       reach the page run the KPMG flow on our FlowHunt credits, and read
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

app.use(express.json({ limit: '5mb' })); // raised from the default 100kb — a batch CSV of urls can exceed that
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SHOTS_DIR));
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
  res.json({ hasApiKey: Boolean(FH_DEFAULTS.apiKey), hasWorkspaceId: Boolean(FH_DEFAULTS.workspaceId), flowId: FH_DEFAULTS.flowId });
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
app.post('/api/batch', async (req, res) => {
  const { urls, width, fresh, maxProducts } = req.body || {};
  const apiKey = req.body?.apiKey || FH_DEFAULTS.apiKey;
  const flowId = req.body?.flowId || FH_DEFAULTS.flowId;
  const workspaceId = req.body?.workspaceId || FH_DEFAULTS.workspaceId;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');

  /* A batch can run for a long time — many homepages, each expanded into
     several URLs, each screenshotted in turn. If the browser tab closes
     partway through, two things go wrong without this: res.write() on a
     dead socket can throw, and — worse — the server just keeps capturing
     every remaining URL for a client that's no longer there. isAborted()
     lets runBatch check between iterations and stop early instead.
     Deliberately res.on('close'), not req.on('close') — see the note in
     /api/capture above for why req's version fires too early here. */
  let closed = false;
  res.on('close', () => { closed = true; });
  const send = (obj) => { if (!closed && !res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  /* Each entry is a whole company row from the CSV ("ACME LTD, DE, 7219,
     www.acme.com, DE123456"), not a bare URL — the agent accepts a business
     name or a URL and finds the site itself, and the folder each company's
     screenshots land in is named from this string. */
  const companies = Array.isArray(urls) ? urls.map((u) => String(u).trim()).filter(Boolean) : [];
  if (!apiKey || !flowId || !companies.length) {
    send({ type: 'error', message: 'Missing apiKey, flowId, or company rows' });
    return res.end();
  }

  try {
    const result = await runBatch({
      apiKey,
      flowId,
      companies,
      width: Number(width) || 1440,
      workspaceId: workspaceId || undefined,
      /* Off by default: re-running the same list should continue it, which is
         the whole point of resume. Set only when the user asks for a clean
         run from the UI. */
      fresh: Boolean(fresh),
      /* Undefined leaves batch.js on its own default; 0 means no limit. */
      maxProducts: maxProducts === undefined || maxProducts === '' ? undefined : Number(maxProducts),
      onLog: (message) => send({ type: 'log', message }),
      isAborted: () => closed,
    });
    if (!closed) send({ type: 'done', result });
  } catch (err) {
    console.error(err);
    send({ type: 'error', message: err.message });
  }
  if (!closed && !res.writableEnded) res.end();
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
app.listen(PORT, () => {
  console.log(`\n  pagesnap running → http://localhost:${PORT}`);
  console.log(`  screenshots → ${SHOTS_DIR}\n`);
});
