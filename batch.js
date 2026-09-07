/* Batch feature: given a list of companies, run each through a FlowHunt flow
 * to find its homepage / about-us / services pages, screenshot each of those
 * with pagesnap's own capture(), and bundle everything into one ZIP.
 *
 * The output shape is dictated by what the client asked for (see the July feedback
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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { capture } from './capture.js';
import { runFlow, parseAgentResult } from './flowhunt.js';
import { discoverProductLinks, neverAProduct } from './discover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BATCH_DIR = process.env.BATCH_DIR || path.join(__dirname, 'batches');

/* The two single pages every company gets. `key` matches parseAgentResult's
   urls object; `file` is what the reviewer sees in the folder. Product pages
   are handled separately below because there can be several of them. */
const PAGES = [
  { key: 'homepage', file: 'homepage', column: 'homepage_screenshot_link' },
  { key: 'aboutUs', file: 'aboutus', column: 'about_us_screenshot_link' },
];

/* Every column in the XLSX that holds screenshot paths, so counting and
   verification stay correct as the shape changes. The product column holds
   several paths separated by "; ". */
const SHOT_COLUMNS = ['homepage_screenshot_link', 'about_us_screenshot_link', 'services_screenshot_link'];
const LINK_SEP = '; ';

/* Product pages come from the agent's own services URLs first (they are
   vetted) followed by whatever reading the company's homepage navigation turns
   up — the agent alone names one or two, which is not enough.

   Six per company, always. Not a default, not configurable: uncapped runs made
   the total time for a list impossible to predict (each page is 20-30 seconds
   and 1.5-2.5 MB, so one catalogue-heavy company could take ten minutes on its
   own), and a per-run knob only moved that problem into the UI. Six is enough
   to document what a company sells and bounds a 181-company run to something
   you can plan around.

   Where a company has more, the row's warnings column says so — "23 product
   pages found, captured first 6" — so a capped row is never mistaken for a
   company that only sells six things. */
export const MAX_PRODUCTS_PER_COMPANY = 6;

/* Company strings arrive as a whole CSV row — "EXAMPLE KUTATO ES TANACSADO ...,
   HU, 7219, www.cro.example, HU00000000" — including commas, slashes and
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

/* Pulls the website out of a company row. The client's input rows look like
   "EXAMPLE ROWERY SP. Z O.O., PL, 7219, www.cycleshop.example, PL000000000" — one field of
   several is a domain, and which one varies.

   The awkward part is that company names are full of things that look like
   domains: "SP. Z O.O.", "S.R.L.", "A.S.". They are excluded by requiring a
   TLD of at least two letters and no spaces in the token, which no legal-form
   abbreviation satisfies. */
export function domainFromCompany(companyString) {
  const tokens = String(companyString || '').split(/[,;\s]+/).filter(Boolean);
  for (const t of tokens) {
    const cleaned = t.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').replace(/[.,;:]+$/, '');
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}$/i.test(cleaned)) continue;
    if (/^\d+$/.test(cleaned.replace(/\./g, ''))) continue;   // a number, not a host
    return cleaned.toLowerCase().replace(/^www\./, '');
  }
  return '';
}

/* Registrable-ish comparison: cycleshop.example vs www.cycleshop.example vs shop.cycleshop.example all
   count as the same company site, while framemaker.example does not. Deliberately
   naive about multi-part TLDs (.co.uk) — it compares the last two labels,
   which for co.uk means "co.uk" on both sides and so still matches only when
   the real domain matches, because the label before it is included too. */
export function sameSite(a, b) {
  if (!a || !b) return true;               // nothing to compare — not a mismatch
  const tail = (h) => h.split('.').slice(-3).join('.');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) || tail(a) === tail(b);
}

/* One transient blip permanently loses that company's row, and on a long run
   there will be blips — the client's own 181-company run had exactly one failure of
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

/* ── Where a run lives ──────────────────────────────────────────────────────
   ONE fixed working directory, not one per run. The previous scheme keyed the
   folder by a hash of the company list and wrote a timestamped zip beside it,
   so every run — and every re-export of the same run — left another full copy
   on disk. A few 181-company runs is several gigabytes, and on a container
   with a mounted volume that ends as ENOSPC in the middle of a capture.

   Now: `batches/work/` is emptied whenever a different company list is loaded,
   each company's own folder is emptied before that company is captured, and
   the zip has a fixed name that is overwritten. Disk use is bounded by the
   size of one run, whatever happens. */
export const WORK_DIR = path.join(BATCH_DIR, 'work');
export const EXPORT_SUBDIR = 'export';
export const ZIP_NAME = 'batch.zip';

/* Identifies a company list, so loading a different CSV wipes the previous
   run's files instead of mixing two jobs' folders in one directory. */
export function signatureFor({ companies, width, quality, flowId }) {
  return crypto.createHash('sha1')
    .update(JSON.stringify({ companies, width, quality, flowId }))
    .digest('hex').slice(0, 12);
}

/* Prepares the fixed working directory for a run, and reports whether its
   contents belong to the same list (so already-captured companies can be kept)
   or to a previous one (wiped). */
export async function prepareWorkDir({ signature, fresh = false, workDir = WORK_DIR }) {
  await fs.mkdir(BATCH_DIR, { recursive: true });
  const stampPath = path.join(workDir, 'run.json');
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(stampPath, 'utf8')); } catch { /* first run */ }

  const reused = Boolean(previous && previous.signature === signature && !fresh);
  if (!reused) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(workDir, EXPORT_SUBDIR), { recursive: true });
  await fs.writeFile(stampPath, JSON.stringify({ signature, at: Date.now() }), 'utf8');
  return { workDir, exportDir: path.join(workDir, EXPORT_SUBDIR), reused };
}

/* Removes everything in the batches directory that is not the current work
   directory or the current zip — the timestamped zips and `run-<hash>` folders
   an older version of this file left behind. Called once at startup so an
   upgraded deployment reclaims its disk instead of carrying the old copies
   around forever. */
export async function pruneBatchDir() {
  const keep = new Set([path.basename(WORK_DIR), ZIP_NAME]);
  const entries = await fs.readdir(BATCH_DIR).catch(() => []);
  let removed = 0;
  for (const name of entries) {
    if (keep.has(name)) continue;
    if (!/^(run-[0-9a-f]+|batch-.*\.zip)$/.test(name)) continue;  // never touch anything unexpected
    await fs.rm(path.join(BATCH_DIR, name), { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

/* Everything one company needs, isolated so it can run on its own — one row
   re-run from the UI — or several at a time in parallel. It touches nothing
   outside its own folder, which is what makes running ten of these at once
   safe: separate output directory, separate browser, no shared state. */
export async function captureCompany({
  apiKey, flowId, company, workspaceId,
  index = 0, total = 1,
  folder = folderNameFor(company, index),
  exportDir,
  width = 1440,
  quality = 82,
  onLog = () => {}, isAborted = () => false,
}) {
  const MAX_PRODUCTS = MAX_PRODUCTS_PER_COMPANY;
  const i = index;

  /* Re-running a company must replace its screenshots, not add to them.
     Without this, a company that produced product_1…product_9 on one run and
     only product_1…product_3 on the next would keep six stale files in the
     folder, and the zip would ship screenshots that no spreadsheet row points
     at — indistinguishable, to a reviewer, from the real ones. */
  await fs.rm(path.join(exportDir, folder), { recursive: true, force: true }).catch(() => {});

  const label = company.length > 60 ? company.slice(0, 60) + '…' : company;
  onLog(`[${i + 1}/${total}] ${label}`);

  const row = {
    flow_input: company,
    status: '',
    homepage_screenshot_link: '',
    about_us_screenshot_link: '',
    services_screenshot_link: '',
    product_pages: 0,
    business_summarization: '',
    business_type: '',
    /* Things a reviewer needs to know that are not failures: the agent used
       a different website than the input named, the product list was cut off
       at the cap, a page rendered with images missing. Each of these
       previously existed only in the log, or nowhere. */
    warnings: '',
    error: '',
  };
  const warn = (m) => { row.warnings = row.warnings ? `${row.warnings}; ${m}` : m; };

  let parsed;
  try {
    let result = await runFlowWithRetry(
      { apiKey, flowId, company, workspaceId, isAborted },
      (m) => onLog(`  ${m}`)
    );
    parsed = parseAgentResult(result);

    /* The agent is not deterministic. In two runs of the same 8 companies 13
       minutes apart, AG MOTORS came back with no pages at all the first time
       and a homepage plus two more the second; ADVANTECH flipped from
       Unverified to Verified. So "no homepage" is not evidence the company
       has no website — often it is just this attempt. Since no homepage
       means nothing to screenshot AND nothing for product discovery to read,
       an empty answer costs us the entire row, which is worth one more call
       to avoid. */
    if (!parsed?.urls?.homepage && !isAborted()) {
      onLog('  no homepage in the reply — asking the flow once more');
      try {
        const second = await runFlowWithRetry(
          { apiKey, flowId, company, workspaceId, isAborted },
          (m) => onLog(`  ${m}`)
        );
        const reparsed = parseAgentResult(second);
        if (reparsed?.urls?.homepage) {
          onLog('  second attempt returned a homepage — using it');
          result = second;
          parsed = reparsed;
          warn('first attempt returned no homepage; second attempt succeeded');
        } else {
          onLog('  second attempt also returned no homepage');
          warn('no homepage returned on either attempt');
        }
      } catch (err) {
        onLog(`  second attempt failed (${err.message}) — keeping the first reply`);
      }
    }

    row.status = parsed.status || 'success';
    row.business_summarization = parsed.reasoning;
    row.business_type = parsed.businessType;

    /* The input row names a website; the agent sometimes screenshots a
       different one. A live run had "www.cycleshop.example" in the CSV and
       framemaker.example in the reply — plausibly the same company, but nothing in
       the output said the domain had changed. Across 181 rows that is how a
       a client deliverable ends up containing screenshots of a company nobody
       asked about, with no way to spot which. Not an error — the agent may
       well be right — so it is recorded, not failed. */
    /* Checked across EVERY url the agent returned, not just the homepage.
       A live run made the reason plain: for "EXAMPLE ROWERY SP. Z O.O. …
       www.cycleshop.example" the agent reported homepage_url as "failed to capture"
       and then gave about/services pages on www.cycleshop-it.example — an unrelated
       Italian bike shop. Because the homepage field held no url at all,
       a homepage-only check saw nothing to compare and stayed silent, and
       two screenshots of the wrong company went into the spreadsheet looking
       exactly like every correct row. */
    const wantDomain = domainFromCompany(company);
    const hostOf = (u) => {
      try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
      catch { return ''; }
    };
    if (wantDomain) {
      const used = [...new Set(
        [parsed.urls.homepage, parsed.urls.aboutUs, ...(parsed.urlOptions?.services || [])]
          .map(hostOf).filter(Boolean)
      )];
      const wrong = used.filter((h) => !sameSite(wantDomain, h));
      if (wrong.length) {
        onLog(`  NOTE: input names ${wantDomain} but the agent used ${wrong.join(', ')}`);
        warn(`input domain ${wantDomain}, agent used ${wrong.join(', ')}`);
      }
    }

    /* The agent explains a missing page in the url field itself — most
       usefully "failed to capture — certificate error", which means the site
       is there but could not be read. That is a different situation from a
       company simply having no About page, and only this note distinguishes
       them. */
    for (const [key, label] of [['homepage', 'homepage'], ['aboutUs', 'about us'], ['services', 'services']]) {
      const note = parsed.urlNotes?.[key];
      if (note) warn(`${label}: agent reported "${note}"`);
    }
    const found = [...PAGES, { key: 'services', file: 'product' }]
      .filter((p) => parsed.urls[p.key]).map((p) => p.file);
    onLog(`  → ${parsed.status || 'ok'}; pages found: ${found.length ? found.join(', ') : 'none'}`);

    /* When the flow answered but nothing could be read out of it, show what
       actually came back. Without this the run looks successful and produces
       empty columns, and there is no way to tell whether the flow returned
       nothing or the parser failed to understand it — which is exactly the
       hole the first live run fell into. */
    /* Fewer than three pages is often legitimate — plenty of sites have no
       About or Services page. But it is also what a key we failed to match
       looks like, and the two are indistinguishable in the log. Print the
       fields the agent actually sent so the difference is visible. */
    if (found.length < 3 && parsed.sourceKeys?.length) {
      /* One field per line. These now carry values, not just names, and a
         single joined line was truncated before the interesting ones. */
      onLog('  fields the agent sent:');
      for (const f of parsed.sourceKeys) onLog(`    ${f}`);
    }

    if (!found.length && !parsed.reasoning) {
      const raw = typeof result === 'string' ? result : JSON.stringify(result);
      onLog(`  NOTE: nothing readable in the flow's reply. Raw shape: ${
        Array.isArray(result) ? 'array' : typeof result
      }${result && typeof result === 'object' ? ` keys=[${Object.keys(result).join(', ')}]` : ''}`);
      onLog(`  RAW (first 600 chars): ${String(raw).slice(0, 600)}`);
    }
  } catch (err) {
    onLog(`  ERROR from flow: ${err.message}`);
    row.status = 'Failed';
    row.error = err.message;
    /* Deliberately NOT reported as finished. A flow failure is usually
       transient — the whole point of re-running one row is to give that
       company another go, so a Failed row must never count as done. */
    return { row, interrupted: false };
  }

  /* The agent can report Failed/Unverified with no usable homepage — there is
     nothing to screenshot, and the row still belongs in the spreadsheet so
     the reviewer can see why. */
  const companyDir = path.join(exportDir, folder);
  let madeDir = false;
  /* The agent often gives the same URL for more than one page — a site whose
     services are described on the homepage, or where it fell back to the
     homepage for a page it could not find. Capturing that twice costs another
     15-30s and another 2MB, and puts two identical images in the zip under
     different names, which reads as though we screenshotted the wrong page.
     Capture each distinct URL once and point both columns at the one file. */
  const capturedByUrl = new Map();

  /* A screenshot can succeed and still be wrong to look at: a third of the
     images never loaded, or the page uses a lazy-load convention we don't
     recognise and whole blocks came out blank. Both were visible only in the
     log, which nobody reads next to a 181-row spreadsheet. Anything material
     goes in the warnings column instead. */
  const noteQuality = (label, shot) => {
    const total = shot?.images?.total ?? 0;
    const loaded = shot?.images?.loaded ?? 0;
    // Below ~85% is where missing images start being obvious in the picture.
    if (total >= 5 && loaded / total < 0.85) {
      warn(`${label}: only ${loaded}/${total} images loaded`);
    }

    /* A page that never grew past one viewport and contains no images at all
       is almost certainly not the page anyone wanted: an error page, a
       redirect that landed nowhere, or content that failed to render. It is
       invisible in the spreadsheet, where the row looks complete and the
       link resolves. A live run captured feedadditives.example/rolunk/ at exactly 900px
       and 0.03 MB — a blank card where the About page should have been —
       and nothing in the output said so. */
    if (shot?.pageHeight && shot.pageHeight <= 1000 && total === 0) {
      warn(`${label}: page looks empty (${shot.pageHeight}px, no images) — worth checking by hand`);
    }
    if (shot?.placeholders > 0) {
      warn(`${label}: ${shot.placeholders} image(s) may be blank (lazy-load not recognised)`);
    }
    if (shot?.capped) {
      warn(`${label}: page was taller than the capture limit and is truncated`);
    }

    /* A carousel shows one slide and hides the rest behind arrows nobody can
       click in a screenshot. spacetech.example's partners strip holds ESA, Airbus,
       Thales and about twenty more; the capture shows two of them, and looks
       for all the world like a failed screenshot rather than a working one. */
    if (shot?.carousels > 0) {
      warn(`${label}: ${shot.carousels} carousel(s) — ${shot.hiddenSlides} slide(s) sit off-screen and are not in the picture`);
    }
  };

  /* Compare URLs by the DOCUMENT they load, not by their exact spelling. A
     live run captured framemaker.example twice — once as "https://framemaker.example/"
     and once as "https://framemaker.example/?lang=en#offer_b2b" for the services
     page. A fragment never changes the document the browser loads, so those
     two screenshots were the same 11000px page, 2.5MB each. Strip the hash,
     drop a lone trailing slash, and lowercase the host; keep the query,
     which genuinely can select a different page (?lang=en is a translation,
     ?id=42 is a different record). The ORIGINAL url is still what we
     navigate to — this key is only used to decide whether we already have
     the picture. */
  const sameDocKey = (u) => {
    try {
      const p = new URL(u);
      p.hash = '';
      p.hostname = p.hostname.toLowerCase().replace(/^www\./, '');
      p.pathname = p.pathname.replace(/\/+$/, '') || '/';
      return p.toString();
    } catch { return String(u); }
  };

  /* Set when this company was cut short partway through its captures. It is
     the difference between "finished" and "stopped here", and only the first
     may be written to the resume ledger — recording a half-captured company
     as done would leave permanent holes that a re-run silently skips over.
     Checking isAborted() at append time is not equivalent: a company can
     complete every capture and only then have the client disconnect, and
     that one has genuinely finished. */
  let interrupted = false;

  for (const page of PAGES) {
    if (isAborted()) {
      onLog('  stopping early — client disconnected');
      interrupted = true;
      break;
    }
    /* The agent may offer several urls for one page. Prefer the first that
       is a page we have not already captured — otherwise a services field
       that happens to lead with the homepage costs a duplicate capture and
       buries the real services page further down the same list. Falls back
       to the first url when they all point at pages already taken. */
    const options = parsed.urlOptions?.[page.key]?.length
      ? parsed.urlOptions[page.key]
      : [parsed.urls[page.key]].filter(Boolean);
    if (!options.length) continue;

    const fresh = options.find((u) => !capturedByUrl.has(sameDocKey(u)));
    const targetUrl = fresh || options[0];
    const docKey = sameDocKey(targetUrl);

    if (options.length > 1) {
      onLog(`  ${page.file}: agent offered ${options.length} urls — using ${targetUrl}`);
    }

    /* Already shot this page for this company — point at that file rather
       than spending another capture on it. */
    const already = capturedByUrl.get(docKey);
    if (already) {
      row[page.column] = already;
      onLog(`  ${page.file}: same page as already captured (${targetUrl}) — reusing that screenshot`);
      continue;
    }

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
      capturedByUrl.set(docKey, row[page.column]);
      noteQuality(page.file, shot);
    } catch (err) {
      onLog(`    ERROR capturing ${page.file}: ${err.message}`);
      row[page.column] = 'failed to capture';
      row.error = row.error ? `${row.error}; ${page.file}: ${err.message}` : `${page.file}: ${err.message}`;
    }
  }

  /* ── Product pages ────────────────────────────────────────────────────
     The client asked for a screenshot of every product page a company has, named
     product_1, product_2 and so on. Two sources, in this order:
       1. whatever the agent put in its services field — vetted, and often
          the page the company itself considers its main offering
       2. product/service links read off the company's own homepage nav,
          which is the only way to reach four products when the agent named
          one
     Anything already captured for this company (a services field that
     repeats the homepage, a nav link back to the About page) drops out via
     the same document-identity check used above, so the numbering counts
     distinct pages rather than distinct URLs. */
  if (!isAborted()) {
    const productUrls = [];
    const consider = (u) => {
      if (!u || productUrls.length >= MAX_PRODUCTS) return;
      const k = sameDocKey(u);
      if (capturedByUrl.has(k)) return;                       // already shot as homepage/about
      if (productUrls.some((p) => sameDocKey(p) === k)) return;
      productUrls.push(u);
    };

    const fromAgent = parsed.urlOptions?.services?.length
      ? parsed.urlOptions.services
      : [parsed.urls.services].filter(Boolean);
    for (const u of fromAgent) {
      /* The agent is trusted about WHICH service page a company has, but a
         leadership or contact page is not one whatever it says — and one
         came through as product_2 in a live run. */
      if (neverAProduct(u)) {
        onLog(`  skipping ${u} — not a product page`);
        warn(`agent offered ${u} as a product page; skipped`);
        continue;
      }
      consider(u);
    }
    const agentCount = productUrls.length;

    /* Only go to the site when the agent has not already filled the quota.
       Reading the homepage costs a browser launch (a few seconds), which is
       not worth spending to confirm a list we are going to truncate anyway. */
    let siteFound = 0;
    if (productUrls.length < MAX_PRODUCTS && parsed.urls.homepage) {
      const discovered = await discoverProductLinks(parsed.urls.homepage, {
        limit: MAX_PRODUCTS * 3,   // over-fetch: many will collide with what we have
        /* The agent's own product URLs, handed over so discovery can find
           their siblings. Without these, a site that names product pages
           after the products (spacetech.example) yields nothing from the site and
           the row is left with whichever few the agent happened to return
           that run — a different set every time. */
        seeds: productUrls,
        onLog: (m) => onLog(`  ${m}`),
      });
      siteFound = discovered.found;
      for (const u of discovered.links) consider(u);
    }

    if (productUrls.length) {
      onLog(`  ${productUrls.length} product page(s): ${agentCount} from the agent, ${productUrls.length - agentCount} from the site`);
    }
    /* A cap that says nothing is worse than no cap: six screenshots for a
       company with twelve product pages reads, in the spreadsheet, as a
       company with six products. Record the real number so a reviewer can
       tell the difference between "all of them" and "the first six". */
    const totalAvailable = Math.max(agentCount + siteFound, productUrls.length);
    if (productUrls.length >= MAX_PRODUCTS && totalAvailable > productUrls.length) {
      onLog(`  NOTE: ${totalAvailable} product page(s) found, capturing the first ${productUrls.length} (cap)`);
      warn(`${totalAvailable} product pages found, captured first ${productUrls.length}`);
    }

    const productLinks = [];
    for (const [n, targetUrl] of productUrls.entries()) {
      if (isAborted()) { onLog('  stopping early — client disconnected'); interrupted = true; break; }
      if (!madeDir) { await fs.mkdir(companyDir, { recursive: true }); madeDir = true; }

      const label = `product_${n + 1}`;
      onLog(`  capturing ${label}: ${targetUrl}`);
      try {
        const shot = await capture({
          url: targetUrl,
          width,
          format: 'jpeg',
          quality,
          fileName: `${label}.jpg`,
          outDir: companyDir,
          onLog: (m) => onLog(`    ${m}`),
        });
        const link = `export/${folder}/${shot.file}`;
        productLinks.push(link);
        capturedByUrl.set(sameDocKey(targetUrl), link);
        noteQuality(label, shot);
      } catch (err) {
        onLog(`    ERROR capturing ${label}: ${err.message}`);
        row.error = row.error ? `${row.error}; ${label}: ${err.message}` : `${label}: ${err.message}`;
      }
    }

    /* One cell, several paths. Keeps the client's column layout intact — a column
       per product would break the moment two companies have different
       counts, which is every run. */
    row.services_screenshot_link = productLinks.join(LINK_SEP)
      || (productUrls.length ? 'failed to capture' : '');
    row.product_pages = productLinks.length;
  }

  /* A row carrying nothing but a homepage is indistinguishable, in the
     spreadsheet, from a complete one: the status column shows whatever the
     agent said, and the agent's "Verified" only means the homepage returned
     HTTP 200. AG MOTORS came back Verified with a single file in its folder —
     of a company that was not the one in the input — and nothing in the row
     said so. Sorting by status would have put it with the good rows. */
  if (row.homepage_screenshot_link && !row.about_us_screenshot_link && !row.product_pages) {
    warn('only the homepage was captured — no about-us or product pages found');
  }

  return { row, interrupted };
}

/* Builds the deliverable — results.xlsx plus one zip of the whole working
   directory — from rows that are already on disk. Separate from capturing, so
   the export can be rebuilt after re-running a single row without touching the
   other companies. */
export async function buildExport({ rows, workDir = WORK_DIR, onLog = () => {} }) {
  /* ── XLSX index ──────────────────────────────────────────────────────────
     Column order and names follow the sample the client said was "way better", with
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
    /* Holds every product page, separated by "; ". Wider and wrapped, because
       five paths in one cell is unreadable on one line. */
    { header: 'services_screenshot_link', key: 'services_screenshot_link', width: 60 },
    { header: 'product_pages', key: 'product_pages', width: 14 },
    { header: 'business_summarization', key: 'business_summarization', width: 90 },
    { header: 'business_type', key: 'business_type', width: 28 },
    /* Not failures — things a reviewer should see before trusting a row:
       a different domain than the input named, a truncated product list,
       a page that rendered with images missing. */
    { header: 'warnings', key: 'warnings', width: 50 },
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
  ws.getColumn('services_screenshot_link').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('warnings').alignment = { wrapText: true, vertical: 'top' };
  const xlsxName = 'results.xlsx';
  await wb.xlsx.writeFile(path.join(workDir, xlsxName));

  onLog('zipping results…');
  /* One fixed name, overwritten on every export. A timestamped name grew the
     batches directory by the full size of the run every single time it was
     exported — on a host with a 5 GB volume that is a handful of runs before
     the disk is full and captures start failing with ENOSPC. */
  const zipName = ZIP_NAME;
  const zipPath = path.join(BATCH_DIR, zipName);
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    /* The ledger is bookkeeping, not a deliverable — everything it holds is
       already in results.xlsx. */
    archive.glob('**/*', { cwd: workDir, ignore: ['rows.ndjson', 'run.json', 'job.json'] });
    archive.finalize();
  });

  /* The working directory is deliberately kept: it is the single, fixed
     location every run writes into, so it does not accumulate, and holding on
     to it is what lets one row be re-run on its own without redoing the other
     two hundred. It is emptied when a different company list is loaded. */

  const { size } = await fs.stat(zipPath);
  onLog(`done — ${zipName} (${(size / 1024 / 1024).toFixed(2)} MB)`);

  /* Count image FILES, not filled-in columns. Where the agent gave the same URL
     for two pages both columns point at one screenshot, so counting columns
     would promise more files than the zip contains. Pages documented is the
     more useful second number, so report both. */
  const files = new Set();
  let pagesDocumented = 0;
  let productShots = 0;
  for (const r of rows) {
    for (const col of SHOT_COLUMNS) {
      const cell = r[col];
      if (!cell || cell === 'failed to capture') continue;
      // The product column holds several paths; the other two hold one each.
      for (const v of String(cell).split(LINK_SEP).filter(Boolean)) {
        pagesDocumented++;
        files.add(v);
        if (col === 'services_screenshot_link') productShots++;
      }
    }
  }
  return {
    zipFile: zipName,
    zipPath,
    bytes: size,
    rows,
    totalCompanies: rows.length,
    totalShots: files.size,
    pagesDocumented,
    productShots,
  };}

/* Sequential whole-list run: capture every company, then export. Kept for the
   CLI and the test suite; the server drives captureCompany/buildExport
   directly so it can run several companies at once and re-run one on its own.
   Resume works the same way it always did — a company is written to the ledger
   only once it is completely finished. */
export async function runBatch({
  apiKey, flowId, companies, width, workspaceId,
  quality = 82,
  fresh = false,
  onLog = () => {}, isAborted = () => false,
}) {
  const signature = signatureFor({ companies, width, quality, flowId });
  const { workDir, exportDir } = await prepareWorkDir({ signature, fresh });
  const ledgerPath = path.join(workDir, 'rows.ndjson');

  /* One JSON object per finished company. A truncated last line (killed
     mid-write) is dropped rather than failing the resume. */
  const done = new Map();   // company string -> its finished row
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.flow_input === 'string') done.set(r.flow_input, r);
      } catch { /* partial final line — ignore */ }
    }
  } catch { /* no ledger yet: this is a first run */ }

  if (done.size) {
    onLog(`resuming — ${done.size} of ${companies.length} company(ies) already done, continuing with the rest`);
  }

  const rows = [];
  const folders = folderNamesFor(companies);

  for (const [i, company] of companies.entries()) {
    if (isAborted()) {
      onLog(`stopping early — client disconnected (${i}/${companies.length} companies done)`);
      break;
    }

    /* Already captured on an earlier attempt at this same list — its
       screenshots are still on disk under the same run directory. */
    const finished = done.get(company);
    if (finished) {
      rows.push(finished);
      onLog(`[${i + 1}/${companies.length}] already done on an earlier run — skipping`);
      continue;
    }

    const { row, interrupted } = await captureCompany({
      apiKey, flowId, company, workspaceId,
      index: i, total: companies.length, folder: folders[i], exportDir,
      width, quality, onLog, isAborted,
    });
    rows.push(row);
    /* Company finished — record it so an interrupted run does not repeat it.
       Written last, after every capture, so a crash mid-company leaves nothing
       in the ledger and the company is simply redone next time. */
    if (!interrupted && row.status !== 'Failed') {
      await fs.appendFile(ledgerPath, JSON.stringify(row) + '\n', 'utf8');
    }
  }

  return buildExport({ rows, workDir, onLog });
}

/* Folder name per company, de-duplicated across the whole list. Two companies
   can clean down to the same name (long names sharing an 80-character prefix),
   which would silently merge their screenshots. Computed for the list as a
   whole rather than as we go, so a company's folder is the same whether the
   list is run start-to-finish or one row at a time in any order. */
export function folderNamesFor(companies) {
  const used = new Set();
  return companies.map((company, i) => {
    let folder = folderNameFor(company, i);
    if (used.has(folder)) folder = `${folder}_${i + 1}`;
    used.add(folder);
    return folder;
  });
}
