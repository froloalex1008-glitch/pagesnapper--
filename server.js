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

/* Cookie-session login instead of HTTP Basic Auth. Basic Auth shows the browser's
   own credential dialog and, once dismissed, a bare "Authentication required."
   page with no way back in short of reloading. A real form is clearer and can be
   signed out of. Enabled only when PAGESNAP_PASSWORD is set. */
const PASSWORD = process.env.PAGESNAP_PASSWORD;
const COOKIE = 'pagesnap_session';

/* Constant-time compare. A naive === leaks the password one character at a time
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

/* Derived from the password rather than random, so sessions survive a restart or
   redeploy — and are invalidated automatically if the password is ever changed. */
const sessionToken = () =>
  PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('pagesnap-session-v1').digest('hex') : '';

const readCookie = (req, name) =>
  (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1];

if (PASSWORD) {
  app.use(express.urlencoded({ extended: false })); // parses the login form POST

  app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

  app.post('/login', (req, res) => {
    if (safeEqual(req.body?.password || '', PASSWORD)) {
      res.cookie(COOKIE, sessionToken(), {
        httpOnly: true,                                  // not readable by JS, blunts XSS
        sameSite: 'lax',                                 // blunts CSRF
        secure: process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_PROJECT_ID),
        maxAge: 7 * 24 * 60 * 60 * 1000,                 // one week
      });
      return res.redirect('/');
    }
    // Generic message, and no hint about which part was wrong.
    return res.redirect('/login?error=1');
  });

  app.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/login');
  });

  // Guard everything else. Registered after the /login routes so they stay reachable.
  app.use((req, res, next) => {
    if (safeEqual(readCookie(req, COOKIE) || '', sessionToken())) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login');
  });

  console.log('  auth: enabled (login page at /login)');
} else {
  console.log('  auth: DISABLED (set PAGESNAP_PASSWORD to require a login)');
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
app.post('/api/flowhunt/flows', async (req, res) => {
  const { apiKey, workspaceId } = req.body || {};
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
  const { apiKey, flowId, urls, width, workspaceId } = req.body || {};
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

  const homepages = Array.isArray(urls) ? urls.map((u) => String(u).trim()).filter(Boolean) : [];
  if (!apiKey || !flowId || !homepages.length) {
    send({ type: 'error', message: 'Missing apiKey, flowId, or urls' });
    return res.end();
  }

  try {
    const result = await runBatch({
      apiKey,
      flowId,
      homepages,
      width: Number(width) || 1440,
      workspaceId: workspaceId || undefined,
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
