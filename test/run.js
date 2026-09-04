/* End-to-end checks for the batch pipeline, run against a local fake site and
 * a stubbed FlowHunt so nothing here touches the network or costs API credits.
 *
 *   npm test
 *
 * Every case below exists because the corresponding bug reached a live run.
 * The comments say which, so a future change that breaks one shows what it is
 * breaking rather than just going red.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { openZip } from './unzip.js';
import { startTestSite } from './testsite.js';
import { parseAgentResult } from '../flowhunt.js';
import { discoverProductLinks } from '../discover.js';
import { folderNameFor, domainFromCompany, sameSite, BATCH_DIR } from '../batch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
    failed++;
  }
}

const site = await startTestSite(8099);
const H = site.url;

/* Wraps a plain object the way FlowHunt actually returns it: an object holding
   an array holding a JSON string holding an array holding the answer. Nothing
   about that is obvious, and getting it wrong is what made the first live run
   report success for every company while producing no screenshots at all. */
const envelope = (obj) => JSON.stringify({ outputs: [JSON.stringify([obj])] });

console.log('\nagent reply parsing');

await test('reads the real FlowHunt envelope rather than claiming it as the answer', () => {
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'A CRO.',
    urls: { homepage_url: 'https://a.com/', about_us_page_url: 'https://a.com/about/', services_page_url: 'https://a.com/s/' },
  }));
  assert.equal(r.urls.homepage, 'https://a.com/');
  assert.equal(r.urls.aboutUs, 'https://a.com/about/');
  assert.equal(r.status, 'Verified');
});

await test('matches url fields by meaning, not by exact spelling', () => {
  // Live bug: "homepageurl" was on the exact-match list and "aboutuspageurl"
  // was not, so two real pages were silently dropped from every row.
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x',
    homepage_url: 'https://a.com/', aboutus_page_url: 'https://a.com/about/', services_page_url: 'https://a.com/s/',
  }));
  assert.equal(r.urls.aboutUs, 'https://a.com/about/');
  assert.equal(r.urls.services, 'https://a.com/s/');
});

await test('treats "not available" as no page, not as a url', () => {
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x',
    homepage_url: 'https://a.com/', aboutus_page_url: 'not available', services_page_url: 'N/A',
  }));
  assert.equal(r.urls.aboutUs, '');
  assert.equal(r.urls.services, '');
});

await test('keeps every url when one field holds several', () => {
  // Live bug (AG MOTORS): the agent put two urls in services_page_url
  // separated by " | " and only the first was ever read.
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x',
    homepage_url: 'https://a.com/',
    services_page_url: 'https://a.com/?lang=en#b2b | https://a.com/oem/',
  }));
  assert.equal(r.urlOptions.services.length, 2);
});

await test('strips the trailing backslash markdown escaping leaves behind', () => {
  // Live bug: "https://site.com/\" became "https://site.com//" and 404'd,
  // so every single capture in that run failed.
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x', homepage_url: 'https://site.com/\\',
  }));
  assert.equal(r.urls.homepage, 'https://site.com/');
});

await test('does not truncate the summary at a "z"', () => {
  // Live bug: \z is not valid in a JS regex and matched a literal "z",
  // cutting summaries off mid-word at "Organi|zation".
  const r = parseAgentResult(envelope({
    status_code: 'Verified', homepage_url: 'https://a.com/',
    reasoning: 'A Clinical Research Organization operating in 40 countries.',
  }));
  assert.match(r.reasoning, /40 countries/);
});

await test('prefers a real summary field over the verdict rationale', () => {
  const r = parseAgentResult(envelope({
    status_code: 'Verified', homepage_url: 'https://a.com/',
    reasoning: 'Verified because the site matches.',
    business_summarization: 'Makes industrial pumps.',
  }));
  assert.equal(r.reasoning, 'Makes industrial pumps.');
});

await test('keeps the agent\'s explanation when a url field is not a url', () => {
  // The agent's prompt tells it to write these in the url field itself.
  // A certificate error means the site exists but could not be read, which is
  // not the same as a company having no About page.
  const r = parseAgentResult(envelope({
    status_code: 'Unverified', reasoning: 'x',
    homepage_url: 'failed to capture — certificate error',
    aboutus_page_url: 'not available',
    services_page_url: 'https://a.com/s/',
  }));
  assert.match(r.urlNotes.homepage, /certificate error/);
  assert.equal(r.urlNotes.aboutUs, '', '"not available" is plain absence, not a problem to report');
});

console.log('\ncompany row parsing');

await test('pulls the website out of a KPMG company row', () => {
  assert.equal(domainFromCompany('AG MOTORS SP. Z O.O., PL, 7219, www.bike4u.pl, PL180504689'), 'bike4u.pl');
  assert.equal(domainFromCompany("AISICO - SOCIETA' A RESPONSABILITA' LIMITATA, IT, 7219, www.aisico.com, IT1"), 'aisico.com');
});

await test('does not mistake a legal-form abbreviation for a domain', () => {
  assert.equal(domainFromCompany('SOME COMPANY A.S., CZ, 7219, , CZ123'), '');
});

await test('spots the agent using a different site than the input named', () => {
  assert.equal(sameSite('bike4u.pl', 'ag-motors.pl'), false);
  assert.equal(sameSite('bike4u.pl', 'shop.bike4u.pl'), true);
});

await test('builds a Windows-safe folder name from a company row', () => {
  const f = folderNameFor('AB/CD: "X" <Y>, HU, 7219, www.a.hu, HU1', 0);
  assert.doesNotMatch(f, /[<>:"/\\|?*]/);
  assert.doesNotMatch(f, /[. ]$/);   // Windows rejects a trailing dot or space
});

console.log('\nproduct discovery');

await test('finds every product page behind a products index', async () => {
  const { links } = await discoverProductLinks(H, { limit: 10 });
  for (const want of ['/products/pumps/', '/products/valves/', '/products/sensors/', '/products/controllers/']) {
    assert.ok(links.some((u) => u.includes(want)), `missing ${want}`);
  }
});

await test('does not capture about, news, careers, privacy or contact as products', async () => {
  const { links } = await discoverProductLinks(H, { limit: 10 });
  for (const decoy of ['/about-us/', '/news/', '/careers/', '/privacy/', '/contact/']) {
    assert.ok(!links.some((u) => u.includes(decoy)), `picked up decoy ${decoy}`);
  }
});

await test('ignores off-site links and non-page files', async () => {
  const { links } = await discoverProductLinks(H, { limit: 10 });
  assert.ok(!links.some((u) => u.includes('supplier-example.com')));
  assert.ok(!links.some((u) => u.endsWith('.pdf')));
});

await test('reports how many it found, so the cap can be explained', async () => {
  const { links, found } = await discoverProductLinks(H, { limit: 2 });
  assert.equal(links.length, 2);
  assert.ok(found > 2, 'found should count candidates before the limit');
});

console.log('\nfull batch');

/* Imported late and with a stub in place of the real FlowHunt client, so no
   API key is needed and the test is deterministic. */
const stubPath = path.join(__dirname, '.flowhunt.stub.mjs');
await fs.writeFile(stubPath, `
export async function listFlows(){ return [{ id:'f1', name:'F' }]; }
const H = ${JSON.stringify(H)};
const CASES = [
  { status_code:'Verified', business_type_classification:'Industrial', reasoning:'Makes pumps.',
    homepage_url:H, aboutus_page_url:H+'about-us/', services_page_url:H+'products/pumps/' },
  { status_code:'Verified', business_type_classification:'Industrial', reasoning:'Second co.',
    urls:{ homepage_url:H, about_us_page_url:H, services_page_url:'not available' } },
];
let i = 0;
export async function runFlow(){ return JSON.stringify({ outputs:[JSON.stringify([CASES[i++ % CASES.length]])] }); }
export { parseAgentResult, extractUrls } from '../flowhunt.js';
`, 'utf8');

const batchSrc = (await fs.readFile(path.join(__dirname, '..', 'batch.js'), 'utf8'))
  .replace("from './flowhunt.js'", `from ${JSON.stringify(stubPath)}`)
  .replace("from './capture.js'", `from ${JSON.stringify(path.join(__dirname, '..', 'capture.js'))}`)
  .replace("from './discover.js'", `from ${JSON.stringify(path.join(__dirname, '..', 'discover.js'))}`);
const batchStub = path.join(__dirname, '.batch.stub.mjs');
await fs.writeFile(batchStub, batchSrc, 'utf8');
const { runBatch } = await import(batchStub);

const COMPANIES = [
  'TESTCO KFT, HU, 7219, localhost, HU1',
  'SECOND CO LTD, SK, 6201, localhost, SK2',
];

let result;
await test('captures homepage, about and every product, numbered', async () => {
  result = await runBatch({
    apiKey: 'x', flowId: 'f1', companies: COMPANIES, width: 1440,
    workspaceId: 'w', fresh: true, onLog: () => {}, isAborted: () => false,
  });
  assert.equal(result.totalCompanies, 2);
  /* The test site has four products plus a services page, so five distinct
     pages qualify — for both companies, giving ten screenshots. */
  assert.equal(result.productShots, 10, `expected 5 product pages per company, got ${result.productShots} in total`);
  for (const r of result.rows) {
    assert.equal(r.product_pages, 5, `${r.flow_input} got ${r.product_pages} product pages`);
  }
});

await test('names product files product_1 … product_n', () => {
  const { names } = openZip(result.zipPath);
  for (const n of [1, 2, 3, 4]) {
    assert.ok(names.some((f) => f.endsWith(`product_${n}.jpg`)), `no product_${n}.jpg in the zip`);
  }
});

await test('every spreadsheet link resolves to a file inside the zip', async () => {
  const zip = openZip(result.zipPath);
  const names = new Set(zip.names);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(zip.read('results.xlsx'));
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values.slice(1).map(String);
  const cols = header.map((h, i) => [h, i + 1]).filter(([h]) => /screenshot_link/.test(h));
  let checked = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    for (const [, i] of cols) {
      const cell = String(row.getCell(i).value ?? '');
      if (!cell || cell === 'failed to capture') continue;
      for (const p of cell.split('; ').filter(Boolean)) {
        assert.ok(names.has(p), `broken link: ${p}`);
        checked++;
      }
    }
  });
  assert.ok(checked > 0, 'no links were checked');
});

await test('reuses one screenshot when two pages are the same document', () => {
  // Second company's about url IS its homepage. Two columns, one file.
  const second = result.rows[1];
  assert.equal(second.about_us_screenshot_link, second.homepage_screenshot_link);
  assert.ok(result.pagesDocumented > result.totalShots, 'reuse should make pages > files');
});

await test('finds products even when the agent says "not available"', () => {
  // The exact ACTIVORIS / AG MOTORS case: agent returns no services page,
  // so every one of these came from reading the site itself.
  assert.equal(result.rows[1].product_pages, 5);
});

await test('resumes an interrupted run instead of repeating it', async () => {
  /* The scenario this exists for: a long run dies partway through. Simulated
     by aborting once the first company's screenshots are on disk, then
     starting the identical list again and checking the second attempt does not
     redo the first company.

     Note the first run above completed cleanly, so its working directory was
     removed — a finished run leaves nothing to resume, by design. This uses a
     different company list so it gets its own run id and starts empty. */
  const LIST = ['INTERRUPTED CO, HU, 7219, localhost, HU9', 'SECOND CO, SK, 6201, localhost, SK9'];

  let saves = 0, abort = false;
  const first = await runBatch({
    apiKey: 'x', flowId: 'f1', companies: LIST, width: 1440, workspaceId: 'w',
    fresh: true,
    // Company one produces homepage + aboutus + five products = seven files.
    onLog: (m) => { if (/saved .*\.jpg/.test(m) && ++saves >= 7) abort = true; },
    isAborted: () => abort,
  });
  assert.equal(first.rows.length, 1, 'the run should have stopped after the first company');

  const t0 = Date.now();
  const second = await runBatch({
    apiKey: 'x', flowId: 'f1', companies: LIST, width: 1440, workspaceId: 'w',
    onLog: () => {}, isAborted: () => false,
  });
  const elapsed = Date.now() - t0;

  assert.equal(second.rows.length, 2, 'the resumed run should finish both companies');
  assert.deepEqual(second.rows.map((r) => r.product_pages), [5, 5]);
  /* Seven captures were already done. Redoing them would roughly double this;
     the point of the assertion is that the first company was skipped, and its
     screenshots still made it into the final zip. */
  assert.ok(elapsed < 100000, `resume took ${elapsed}ms — it looks like it re-captured the first company`);

  const { names } = openZip(second.zipPath);
  const firstFolder = folderNameFor(LIST[0], 0);
  assert.ok(
    names.some((n) => n.startsWith(`export/${firstFolder}/`)),
    'screenshots from before the interruption are missing from the final zip'
  );
});

await site.close();
await fs.rm(stubPath, { force: true });
await fs.rm(batchStub, { force: true });
await fs.rm(path.join(BATCH_DIR), { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
