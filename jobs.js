/* Background batch jobs.
 *
 * The old design ran the whole list inside one HTTP request: the browser held
 * a streaming POST open for hours, every company was captured strictly one
 * after another, and the only view of progress was a scrolling log. Closing
 * the tab stopped the run. None of that survives a 181-company list.
 *
 * This module holds the run instead. A job is created once from the CSV, lives
 * in the server process, and is worked through by a pool of at most
 * MAX_CONCURRENCY companies at a time. The browser only polls for state, so
 * closing the tab, reloading, or coming back an hour later all work — and each
 * row can be run, re-run, or skipped on its own.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import {
  captureCompany, buildExport, folderNamesFor, signatureFor, prepareWorkDir,
  WORK_DIR,
} from './batch.js';

/* Ten browsers is already more than most machines want to run at once — each
   company holds a Chromium instance rendering a full-page screenshot, which is
   hundreds of megabytes of RAM apiece. Anything above this is a way to make a
   run slower and less reliable, not faster, so it is a hard ceiling on the
   server as well as a max= on the input. */
export const MAX_CONCURRENCY = 10;
export const DEFAULT_CONCURRENCY = 3;

export const clampConcurrency = (n) =>
  Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(Number(n) || DEFAULT_CONCURRENCY)));

/* One job at a time. A second concurrent job would write into the same fixed
   working directory as the first, and the point of that directory is that disk
   use stays bounded. Loading a new CSV replaces the job. */
let current = null;

const STATE_PATH = path.join(WORK_DIR, 'job.json');

/* Everything the UI needs about one company, kept small enough that polling it
   for 200 rows is cheap. `detail` replaces the log: what the flow found, what
   was captured, and anything worth a reviewer's attention. */
function makeRow(company, cells, index, folder) {
  return {
    index,
    company,
    cells,                 // the CSV row split into columns, for the table
    folder,
    status: 'pending',     // pending | queued | running | done | failed | stopped
    startedAt: null,
    finishedAt: null,
    result: null,          // the spreadsheet row, once finished
    error: '',
  };
}

export function createJob({ companies, headers = [], cells = [], settings }) {
  const concurrency = clampConcurrency(settings.concurrency);
  const folders = folderNamesFor(companies);
  const signature = signatureFor({
    companies,
    width: settings.width,
    quality: settings.quality ?? 82,
    flowId: settings.flowId,
  });

  current = {
    id: crypto.randomUUID(),
    signature,
    headers,
    settings: { ...settings, concurrency },
    rows: companies.map((c, i) => makeRow(c, cells[i] || [c], i, folders[i])),
    running: false,
    stopping: false,
    createdAt: Date.now(),
    exportResult: null,
    exportError: '',
    exporting: false,
  };
  return current;
}

export const getJob = (id) => (current && (!id || current.id === id) ? current : null);

/* Secrets — the FlowHunt API key above all — never leave the server. The UI
   gets the shape of the run and nothing else. */
export function publicJob(job) {
  return {
    id: job.id,
    headers: job.headers,
    running: job.running,
    stopping: job.stopping,
    exporting: job.exporting,
    exportResult: job.exportResult,
    exportError: job.exportError,
    concurrency: job.settings.concurrency,
    width: job.settings.width,
    counts: countRows(job),
    rows: job.rows.map((r) => ({
      index: r.index,
      company: r.company,
      cells: r.cells,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      detail: r.result ? detailOf(r.result) : null,
    })),
  };
}

export function countRows(job) {
  const c = { total: job.rows.length, pending: 0, queued: 0, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const r of job.rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

/* The per-row replacement for the log. Everything a reviewer used to have to
   read a thousand scrolling lines to find out, as fields on one row. */
function detailOf(row) {
  const links = (v) => String(v || '').split('; ').filter(Boolean);
  return {
    status: row.status,
    homepage: row.homepage_screenshot_link || '',
    aboutUs: row.about_us_screenshot_link || '',
    products: links(row.services_screenshot_link),
    productPages: row.product_pages || 0,
    businessType: row.business_type || '',
    summary: row.business_summarization || '',
    warnings: row.warnings || '',
    error: row.error || '',
  };
}

/* Written after every finished company, so a server restart mid-run (a
   redeploy, an OOM kill) comes back to a job whose finished rows are still
   marked finished — their screenshots are on disk either way, and without this
   the UI would offer to redo all of them. */
async function persist(job) {
  try {
    await fs.mkdir(WORK_DIR, { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify({
      id: job.id, signature: job.signature, headers: job.headers, createdAt: job.createdAt,
      /* Deliberately without settings: they hold the FlowHunt API key, and a
         key written to a mounted volume outlives the process that needed it. */
      rows: job.rows.map((r) => ({ ...r, status: r.status === 'running' || r.status === 'queued' ? 'pending' : r.status })),
    }), 'utf8');
  } catch { /* bookkeeping — never fail a run over it */ }
}

/* Restores the rows of the last job on startup, if the working directory still
   holds one. Settings (and so the API key) are not restored — the UI sends
   them again when the user presses Run. */
export async function restoreJob(settings) {
  let saved;
  try { saved = JSON.parse(await fs.readFile(STATE_PATH, 'utf8')); } catch { return null; }
  if (!saved?.rows?.length) return null;
  current = {
    ...saved,
    settings: { ...settings, concurrency: clampConcurrency(settings?.concurrency) },
    running: false, stopping: false, exporting: false,
    exportResult: null, exportError: '',
  };
  return current;
}

/* Runs the given rows (all not-yet-done ones by default) with at most
   `concurrency` companies in flight. Returns immediately: the work continues
   in the background, and the UI polls getJob for progress. */
export function startJob(job, { indexes = null, concurrency, settings } = {}) {
  if (job.running) return job;
  if (settings) job.settings = { ...job.settings, ...settings };
  if (concurrency !== undefined) job.settings.concurrency = clampConcurrency(concurrency);

  const targets = (indexes && indexes.length
    ? indexes.map((i) => job.rows[i]).filter(Boolean)
    : job.rows.filter((r) => r.status !== 'done'));
  if (!targets.length) return job;

  job.running = true;
  job.stopping = false;
  job.exportResult = null;
  job.exportError = '';
  for (const r of targets) { r.status = 'queued'; r.error = ''; }

  /* Not awaited: the HTTP request that started the run returns straight away.
     Failures inside are recorded on the rows, so nothing is lost by not having
     a caller to throw to — but an unhandled rejection would take the whole
     server down, hence the catch. */
  runAll(job, targets).catch((err) => {
    job.running = false;
    console.error('batch job failed:', err);
  });
  return job;
}

async function runAll(job, targets) {
  const { exportDir } = await prepareWorkDir({
    signature: job.signature,
    /* Never wipe on a re-run: the whole point of a fixed directory keyed by
       the company list is that finished companies survive until a different
       list replaces them. prepareWorkDir clears it by itself when the
       signature does not match what is already there. */
    fresh: false,
  });

  const limit = pLimit(job.settings.concurrency);
  const s = job.settings;

  await Promise.all(targets.map((row) => limit(async () => {
    if (job.stopping) { if (row.status === 'queued') row.status = 'pending'; return; }
    row.status = 'running';
    row.startedAt = Date.now();
    row.error = '';
    try {
      const { row: result, interrupted } = await captureCompany({
        apiKey: s.apiKey, flowId: s.flowId, workspaceId: s.workspaceId,
        company: row.company,
        index: row.index, total: job.rows.length,
        folder: row.folder,
        exportDir,
        width: s.width, quality: s.quality ?? 82,
        /* Logs are no longer shown anywhere, but the server console is still
           where you look when a run misbehaves in production. */
        onLog: (m) => { if (process.env.BATCH_VERBOSE) console.log(`  ${m}`); },
        isAborted: () => job.stopping,
      });
      row.result = result;
      row.error = result.error || '';
      row.status = interrupted ? 'stopped' : (result.status === 'Failed' ? 'failed' : 'done');
    } catch (err) {
      row.status = 'failed';
      row.error = err.message;
    }
    row.finishedAt = Date.now();
    await persist(job);
  })));

  job.running = false;
  job.stopping = false;
  await persist(job);
}

export function stopJob(job) {
  if (!job.running) return job;
  job.stopping = true;
  return job;
}

/* Builds results.xlsx and the zip from whatever has finished. Rows that were
   never run are included as empty rows so the spreadsheet still has one line
   per company in the CSV — a missing line reads as a company nobody asked
   about, which is worse than an obviously blank one. */
export async function exportJob(job) {
  if (job.exporting) return job.exportResult;
  job.exporting = true;
  job.exportError = '';
  try {
    const rows = job.rows.map((r) => r.result || {
      flow_input: r.company,
      status: r.status === 'failed' ? 'Failed' : 'not run',
      homepage_screenshot_link: '', about_us_screenshot_link: '', services_screenshot_link: '',
      product_pages: 0, business_summarization: '', business_type: '',
      warnings: '', error: r.error || '',
    });
    job.exportResult = await buildExport({ rows, workDir: WORK_DIR });
    return job.exportResult;
  } catch (err) {
    job.exportError = err.message;
    throw err;
  } finally {
    job.exporting = false;
  }
}
