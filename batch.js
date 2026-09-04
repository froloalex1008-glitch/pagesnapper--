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

/* KPMG asked for a screenshot of every product page, not the first one. The
   agent alone cannot deliver that — in a live 8-company run it named one
   services URL for seven companies and two for the eighth — so the product
   list is the agent's URLs first (they are vetted) followed by whatever
   reading the company's own homepage navigation turns up.

   Uncapped by default, because KPMG asked for every product page and a cap
   silently answers a different question — a company with 23 service pages
   would otherwise be documented as having 5. Set MAX_PRODUCTS, or the field in
   the UI, to put a limit back on for a particular run.

   The cost is real and worth stating: each extra page is roughly 20-30 seconds
   and 1.5-2.5 MB, so one catalogue-heavy company can take ten minutes on its
   own and the total for a long list becomes hard to predict in advance. */
const DEFAULT_MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 0);

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

/* Pulls the website out of a company row. KPMG's input rows look like
   "AG MOTORS SP. Z O.O., PL, 7219, www.bike4u.pl, PL180504689" — one field of
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

/* Registrable-ish comparison: bike4u.pl vs www.bike4u.pl vs shop.bike4u.pl all
   count as the same company site, while ag-motors.pl does not. Deliberately
   naive about multi-part TLDs (.co.uk) — it compares the last two labels,
   which for co.uk means "co.uk" on both sides and so still matches only when
   the real domain matches, because the label before it is included too. */
export function sameSite(a, b) {
  if (!a || !b) return true;               // nothing to compare — not a mismatch
  const tail = (h) => h.split('.').slice(-3).join('.');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) || tail(a) === tail(b);
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
  fresh = false,
  maxProducts = DEFAULT_MAX_PRODUCTS,
  onLog = () => {}, isAborted = () => false,
}) {
  /* 0 (or anything not a positive number) means no limit. Infinity rather than
     a large integer so the "capped" reporting below can never fire on it. */
  const MAX_PRODUCTS = Number(maxProducts) > 0 ? Number(maxProducts) : Infinity;

  await fs.mkdir(BATCH_DIR, { recursive: true });

  /* ── Resume ───────────────────────────────────────────────────────────────
     A 181-company run takes hours. Before this, an interruption at company 150
     — a closed laptop, a dropped connection, a FlowHunt blip — threw away
     every screenshot and started from zero, which on a run this long is not a
     hypothetical.

     The working directory is now keyed by the CONTENT of the company list
     rather than by a timestamp, so re-running the same CSV lands in the same
     place and can pick up where it stopped. Each company's row is appended to
     rows.ndjson only once that company is completely finished, so a company
     interrupted halfway is simply redone (its files are overwritten) rather
     than half-recorded. Editing the CSV changes the id and starts a clean run,
     which is the behaviour you want: a different input is a different job. */
  const runId = crypto.createHash('sha1')
    /* maxProducts is part of the identity: raising the cap and re-running must
       start a new run, not resume one whose finished companies were captured
       under the old, smaller limit — those rows would silently keep their
       short product lists while later ones got the longer treatment. */
    .update(JSON.stringify({ companies, width, quality, flowId, maxProducts: MAX_PRODUCTS }))
    .digest('hex').slice(0, 12);
  const workDir = path.join(BATCH_DIR, `run-${runId}`);
  const exportDir = path.join(workDir, 'export');
  const ledgerPath = path.join(workDir, 'rows.ndjson');

  if (fresh) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(exportDir, { recursive: true });

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
  const appendRow = async (r) => {
    await fs.appendFile(ledgerPath, JSON.stringify(r) + '\n', 'utf8');
  };

  const rows = [];   // one per company, in input order — becomes the XLSX
  const usedFolders = new Set();

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
      usedFolders.add(folderNameFor(company, i));
      onLog(`[${i + 1}/${companies.length}] already done on an earlier run — skipping`);
      continue;
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
         different one. A live run had "www.bike4u.pl" in the CSV and
         ag-motors.pl in the reply — plausibly the same company, but nothing in
         the output said the domain had changed. Across 181 rows that is how a
         KPMG deliverable ends up containing screenshots of a company nobody
         asked about, with no way to spot which. Not an error — the agent may
         well be right — so it is recorded, not failed. */
      /* Checked across EVERY url the agent returned, not just the homepage.
         A live run made the reason plain: for "AG MOTORS SP. Z O.O. …
         www.bike4u.pl" the agent reported homepage_url as "failed to capture"
         and then gave about/services pages on www.bike4u.it — an unrelated
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
      rows.push(row);
      /* Deliberately NOT written to the resume ledger. A flow failure is
         usually transient — the whole point of re-running is to give these
         companies another go, so a Failed row must not be treated as done. */
      continue;
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
         link resolves. A live run captured adexgo.hu/rolunk/ at exactly 900px
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
    };

    /* Compare URLs by the DOCUMENT they load, not by their exact spelling. A
       live run captured ag-motors.pl twice — once as "https://ag-motors.pl/"
       and once as "https://ag-motors.pl/?lang=en#offer_b2b" for the services
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
       KPMG asked for a screenshot of every product page a company has, named
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
             after the products (admatis.com) yields nothing from the site and
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
      /* Uncapped runs are the norm now, so a company with a very long product
         list is no longer stopped — but it does deserve a heads-up in the log,
         since it is where an unexpectedly long run comes from. */
      if (MAX_PRODUCTS === Infinity && productUrls.length >= 20) {
        onLog(`  NOTE: ${productUrls.length} product pages — this company alone will take roughly ${Math.round(productUrls.length * 25 / 60)} minute(s)`);
      }

      /* A cap that says nothing is worse than no cap: five screenshots for a
         company with twelve product pages reads, in the spreadsheet, as a
         company with five products. Record the real number so a reviewer can
         tell the difference between "all of them" and "the first five". */
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

      /* One cell, several paths. Keeps KPMG's column layout intact — a column
         per product would break the moment two companies have different
         counts, which is every run. */
      row.services_screenshot_link = productLinks.join(LINK_SEP)
        || (productUrls.length ? 'failed to capture' : '');
      row.product_pages = productLinks.length;
    }

    rows.push(row);
    /* Company finished — record it so an interrupted run does not repeat it.
       Written last, after every capture, so a crash mid-company leaves nothing
       in the ledger and the company is simply redone next time. Aborted runs
       are recorded too: the screenshots taken so far are real and on disk. */
    if (!interrupted) await appendRow(row);
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
  const zipName = `batch-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const zipPath = path.join(BATCH_DIR, zipName);
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    /* The ledger is bookkeeping, not a deliverable — everything it holds is
       already in results.xlsx. */
    archive.glob('**/*', { cwd: workDir, ignore: ['rows.ndjson'] });
    archive.finalize();
  });

  /* Keep the working directory only while it is still worth something. Every
     company finished => the zip is complete and the folder is a duplicate of
     it, costing another gigabyte or two on a full run. Anything missing => it
     is the resume point, and deleting it would throw away exactly what it
     exists to protect. */
  const everyCompanyDone = rows.length === companies.length
    && rows.every((r) => r.status !== 'Failed');
  if (everyCompanyDone) {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  } else {
    onLog(`kept partial results in ${path.basename(workDir)} — re-run the same list to continue from here`);
  }

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
    totalCompanies: companies.length,
    totalShots: files.size,
    pagesDocumented,
    productShots,
  };
}
