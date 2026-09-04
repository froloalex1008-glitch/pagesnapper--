/* Batch feature: given a list of companies, run each through a FlowHunt flow
 * to find its homepage / about-us / services pages, screenshot each of those
 * with pagesnap's own capture(), and bundle everything into one ZIP.
 *
 * The output shape is dictated by what KPMG asked for (see the July feedback
 * mail), and differs from a plain screenshot dump in four ways:
 *   - one folder per company, named after the company, not the domain
 *   - files named for the page they show (homepage / aboutus / product),
 *     so a reviewer can tell them apart without opening them
 *   - JPEG rather than PNG, because a few hundred full-page PNGs is a
 *     multi-gigabyte download
 *   - an XLSX index with the five columns they asked for, alongside the
 *     screenshots
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { capture } from './capture.js';
import { runFlow, parseAgentResult } from './flowhunt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BATCH_DIR = process.env.BATCH_DIR || path.join(__dirname, 'batches');

/* The three pages the flow looks for, in the order the agent reports them.
   `key` matches parseAgentResult's urls object; `file` is what the reviewer
   sees in the folder. */
const PAGES = [
  { key: 'homepage', file: 'homepage', column: 'homepage_screenshot_link' },
  { key: 'aboutUs', file: 'aboutus', column: 'about_us_screenshot_link' },
  { key: 'services', file: 'product', column: 'services_screenshot_link' },
];

/* Company strings arrive as a whole CSV row — "ACCELSIORS KUTATASSZERVEZO ...,
   HU, 7219, www.accelsiors.com, HU13483498" — including commas, slashes and
   accents, none of which belong in a folder name on Windows. Trimmed to 80
   characters because the full string can run past 120 and Windows still has a
   260-character path limit that the folder, filename and wherever the user
   unzips it all have to share. */
export function folderNameFor(companyString, index) {
  const cleaned = String(companyString || '')
    .replace(/https?:\/\//gi, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // illegal on Windows
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\s]+|[_.\s]+$/g, '')            // no leading/trailing dots or underscores
    .slice(0, 80)
    .replace(/[_.\s]+$/, '');
  // A row with nothing usable in it still needs somewhere to put its files.
  return cleaned || `row_${index + 1}`;
}

/* One transient blip permanently loses that company's row, and on a long run
   there will be blips — KPMG's own 181-company run had exactly one failure of
   this kind. So retry once.
 *
 * Only for faults that a second attempt could plausibly fix: network errors,
 * rate limiting, and 5xx from FlowHunt. A 401/403/404/422 means the key,
 * workspace or flow id is wrong — that will fail identically every time, and
 * retrying it just doubles the wait before the user sees the real problem.
 */
function worthRetrying(err) {
  const m = String(err?.message || '');
  if (/HTTP (401|403|404|422)\b/.test(m)) return false;
  return /HTTP (429|5\d\d)\b/.test(m)
    || /did not finish within/i.test(m)
    || /network|fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(m);
}

async function runFlowWithRetry({ apiKey, flowId, company, workspaceId, isAborted }, log) {
  try {
    return await runFlow(apiKey, flowId, company, { workspaceId });
  } catch (err) {
    if (!worthRetrying(err) || isAborted()) throw err;
    log(`flow call failed (${err.message}) — retrying once in 5s`);
    await new Promise((r) => setTimeout(r, 5000));
    if (isAborted()) throw err;
    return runFlow(apiKey, flowId, company, { workspaceId });
  }
}

export async function runBatch({
  apiKey, flowId, companies, width, workspaceId,
  quality = 82,
  onLog = () => {}, isAborted = () => false,
}) {
  await fs.mkdir(BATCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = path.join(BATCH_DIR, `batch-${stamp}`);
  const exportDir = path.join(workDir, 'export');
  await fs.mkdir(exportDir, { recursive: true });

  const rows = [];   // one per company, in input order — becomes the XLSX
  const usedFolders = new Set();

  for (const [i, company] of companies.entries()) {
    if (isAborted()) {
      onLog(`stopping early — client disconnected (${i}/${companies.length} companies done)`);
      break;
    }

    const label = company.length > 60 ? company.slice(0, 60) + '…' : company;
    onLog(`[${i + 1}/${companies.length}] ${label}`);

    /* Two companies can clean down to the same folder name (long names sharing
       an 80-character prefix), which would silently merge their screenshots. */
    let folder = folderNameFor(company, i);
    if (usedFolders.has(folder)) folder = `${folder}_${i + 1}`;
    usedFolders.add(folder);

    const row = {
      flow_input: company,
      status: '',
      homepage_screenshot_link: '',
      about_us_screenshot_link: '',
      services_screenshot_link: '',
      business_summarization: '',
      business_type: '',
      error: '',
    };

    let parsed;
    try {
      const result = await runFlowWithRetry(
        { apiKey, flowId, company, workspaceId, isAborted },
        (m) => onLog(`  ${m}`)
      );
      parsed = parseAgentResult(result);
      row.status = parsed.status || 'success';
      row.business_summarization = parsed.reasoning;
      row.business_type = parsed.businessType;
      const found = PAGES.filter((p) => parsed.urls[p.key]).map((p) => p.file);
      onLog(`  → ${parsed.status || 'ok'}; pages found: ${found.length ? found.join(', ') : 'none'}`);
    } catch (err) {
      onLog(`  ERROR from flow: ${err.message}`);
      row.status = 'Failed';
      row.error = err.message;
      rows.push(row);
      continue;
    }

    /* The agent can report Failed/Unverified with no usable homepage — there is
       nothing to screenshot, and the row still belongs in the spreadsheet so
       the reviewer can see why. */
    const companyDir = path.join(exportDir, folder);
    let madeDir = false;

    for (const page of PAGES) {
      if (isAborted()) {
        onLog('  stopping early — client disconnected');
        break;
      }
      const targetUrl = parsed.urls[page.key];
      if (!targetUrl) continue;

      if (!madeDir) { await fs.mkdir(companyDir, { recursive: true }); madeDir = true; }

      const fileName = `${page.file}.jpg`;
      onLog(`  capturing ${page.file}: ${targetUrl}`);
      try {
        const shot = await capture({
          url: targetUrl,
          width,
          format: 'jpeg',
          quality,
          fileName,
          outDir: companyDir,
          onLog: (m) => onLog(`    ${m}`),
        });
        /* Path as it appears inside the zip, which is what the XLSX must point
           at. Uses the name capture() reports rather than the one requested:
           a page too tall for jpeg comes back as .png, and the spreadsheet has
           to point at the file that actually exists. */
        row[page.column] = `export/${folder}/${shot.file}`;
      } catch (err) {
        onLog(`    ERROR capturing ${page.file}: ${err.message}`);
        row[page.column] = 'failed to capture';
        row.error = row.error ? `${row.error}; ${page.file}: ${err.message}` : `${page.file}: ${err.message}`;
      }
    }

    rows.push(row);
  }

  /* ── XLSX index ──────────────────────────────────────────────────────────
     Column order and names follow the sample KPMG said was "way better", with
     two extras at the end (business_type, error) that cost nothing to include
     and answer the first question anyone asks about a row that went wrong. */
  onLog('building xlsx…');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Results');
  ws.columns = [
    { header: 'flow_input', key: 'flow_input', width: 60 },
    { header: 'status', key: 'status', width: 12 },
    { header: 'homepage_screenshot_link', key: 'homepage_screenshot_link', width: 50 },
    { header: 'about_us_screenshot_link', key: 'about_us_screenshot_link', width: 50 },
    { header: 'services_screenshot_link', key: 'services_screenshot_link', width: 50 },
    { header: 'business_summarization', key: 'business_summarization', width: 90 },
    { header: 'business_type', key: 'business_type', width: 28 },
    { header: 'error', key: 'error', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  /* The summary and error columns hold whatever the model wrote, and Excel is
     strict about two things: a cell caps at 32767 characters, and most control
     characters make the file unopenable. One malformed response would
     otherwise cost the whole spreadsheet for a 200-company run, so clean every
     value on the way in rather than trusting the source. */
  const CELL_MAX = 32767;
  const forCell = (v) => {
    if (v == null) return '';
    /* Strip control characters — Excel refuses to open a file containing them.
       Newline and tab are kept: the summary column is wrapped and renders them
       fine. Carriage returns are normalised so Windows-authored text doesn't
       show up as stray boxes. */
    const s = String(v)
      .replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
      .trim();
    return s.length > CELL_MAX ? s.slice(0, CELL_MAX - 1) + '\u2026' : s;
  };
  for (const r of rows) {
    ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, forCell(v)])));
  }
  // The summary is a paragraph; without wrapping the column is unreadable.
  ws.getColumn('business_summarization').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('flow_input').alignment = { wrapText: true, vertical: 'top' };
  const xlsxName = 'results.xlsx';
  await wb.xlsx.writeFile(path.join(workDir, xlsxName));

  onLog('zipping results…');
  const zipName = `batch-${stamp}.zip`;
  const zipPath = path.join(BATCH_DIR, zipName);
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(workDir, false); // zip root = results.xlsx + export/
    archive.finalize();
  });

  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

  const { size } = await fs.stat(zipPath);
  onLog(`done — ${zipName} (${(size / 1024 / 1024).toFixed(2)} MB)`);

  const totalShots = rows.reduce(
    (n, r) => n + PAGES.filter((p) => r[p.column] && r[p.column] !== 'failed to capture').length,
    0
  );
  return {
    zipFile: zipName,
    zipPath,
    bytes: size,
    rows,
    totalCompanies: companies.length,
    totalShots,
  };
}
