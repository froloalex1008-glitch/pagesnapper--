/* End-to-end checks for the batch pipeline, run against a local fake site and
 * a stubbed FlowHunt so nothing here touches the network or costs API credits.
 *
 *   npm test
 *
 * Every case below exists because the corresponding bug reached a live run.
 * The comments say which, so a future change that breaks one shows what it is
 * breaking rather than just going red.
 */
import './env.js'; // must stay first — see the note inside
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import { openZip } from './unzip.js';
import { startTestSite } from './testsite.js';
import { parseAgentResult } from '../flowhunt.js';
import { discoverProductLinks, neverAProduct } from '../discover.js';
import { folderNameFor, domainFromCompany, sameSite, BATCH_DIR, pruneBatchDir, MAX_PRODUCTS_PER_COMPANY } from '../batch.js';

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

await test('splits urls joined by a pipe with no spaces', () => {
  /* Live bug (the biomedical site): the agent wrote two urls separated by "|" and no
     spaces. Both were read as one address, the browser percent-encoded the
     pipe, and the request came back 403 — which looked like bot protection. */
  const joined = 'https://www.biomed.example/trapianto/sistemi/|https://www.biomed.example/critical-care/sistemi/';
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x',
    homepage_url: 'https://www.biomed.example/', services_page_url: joined,
  }));
  assert.equal(r.urlOptions.services.length, 2, 'both urls should be recovered');
  assert.ok(!r.urls.services.includes('|'), 'no url may contain a pipe');
  assert.equal(r.urls.services, 'https://www.biomed.example/trapianto/sistemi/');
});

await test('reads a list of product urls, not just a string', () => {
  /* The obvious next improvement is on the agent side: return every product
     page instead of one. Before this, a JSON array reached the parser, failed a
     typeof check and was dropped silently — so that improvement would have made
     the output worse with nothing to explain why. */
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x', homepage_url: 'https://a.com/',
    services_page_url: ['https://a.com/p1/', 'https://a.com/p2/', 'https://a.com/p3/'],
  }));
  assert.equal(r.urlOptions.services.length, 3, 'every url in the array must be read');
  assert.equal(r.urls.services, 'https://a.com/p1/');
});

await test('reads several product urls given one per line', () => {
  // The zero-code-change option for the flow: newline-separated text.
  const r = parseAgentResult(envelope({
    status_code: 'Verified', reasoning: 'x', homepage_url: 'https://a.com/',
    services_page_url: 'https://a.com/p1/\nhttps://a.com/p2/\nhttps://a.com/p3/',
  }));
  assert.equal(r.urlOptions.services.length, 3);
});

console.log('\ncompany row parsing');

await test('pulls the website out of a client company row', () => {
  assert.equal(domainFromCompany('EXAMPLE ROWERY SP. Z O.O., PL, 7219, www.cycleshop.example, PL000000000'), 'cycleshop.example');
  assert.equal(domainFromCompany("EXAMPLE SICUREZZA - SOCIETA' A RESPONSABILITA' LIMITATA, IT, 7219, www.roadsafety.example, IT00000000"), 'roadsafety.example');
});

await test('does not mistake a legal-form abbreviation for a domain', () => {
  assert.equal(domainFromCompany('SOME COMPANY A.S., CZ, 7219, , CZ123'), '');
});

await test('spots the agent using a different site than the input named', () => {
  assert.equal(sameSite('cycleshop.example', 'framemaker.example'), false);
  assert.equal(sameSite('cycleshop.example', 'shop.cycleshop.example'), true);
});

await test('builds a Windows-safe folder name from a company row', () => {
  const f = folderNameFor('AB/CD: "X" <Y>, HU, 7219, www.a.hu, HU1', 0);
  assert.doesNotMatch(f, /[<>:"/\\|?*]/);
  assert.doesNotMatch(f, /[. ]$/);   // Windows rejects a trailing dot or space
});

await test('spots a wrong domain even when the homepage field has no url', () => {
  /* Live bug (AG MOTORS): homepage_url was "failed to capture" and the about
     and services pages pointed at cycleshop-it.example — an Italian bike shop, not the
     Polish company in the input. A homepage-only check had nothing to compare
     and stayed silent while two screenshots of the wrong company were filed. */
  const r = parseAgentResult(envelope({
    status_code: 'Unverified', reasoning: 'x',
    homepage_url: 'failed to capture',
    aboutus_page_url: 'https://www.cycleshop-it.example/chi-siamo/',
    services_page_url: 'https://www.cycleshop-it.example/i-nostri-servizi/',
  }));
  const want = domainFromCompany('EXAMPLE ROWERY SP. Z O.O., PL, 7219, www.cycleshop.example, PL000000000');
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const used = [r.urls.homepage, r.urls.aboutUs, ...r.urlOptions.services].map(hostOf).filter(Boolean);
  assert.ok(used.length > 0, 'there are urls to check even without a homepage');
  assert.ok(used.some((h) => !sameSite(want, h)), 'the wrong domain must be detected');
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

await test('never treats a people or contact page as a product', () => {
  // Live bug: the agent offered cro.example/leadership/ as a services page
  // and it was captured and filed as product_2.
  for (const u of [
    'https://cro.example/leadership/',
    'https://a.com/our-team/',
    'https://a.com/management',
    'https://a.com/contact/',
  ]) assert.equal(neverAProduct(u), true, `${u} should be rejected`);

  // …while genuine service pages from the same sites must survive.
  for (const u of [
    'https://cro.example/legal-consulting/',
    'https://spacetech.example/satellite-radiator/',
    'https://www.roadsafety.example/servizi/prove-statiche-e-dinamiche/',
    'https://a.com/about/our-services/',
  ]) assert.equal(neverAProduct(u), false, `${u} should be kept`);
});

await test('rejects shop utility pages (compare, cart, wishlist) as products', () => {
  /* Live bug (Distrame): /catalog/product_compare/ sat under the catalogue path
     and so matched the product keywords; product_3.jpg was an empty "no items
     to compare" page. */
  for (const p of [
    '/catalog/product_compare/', '/en/compare', '/wishlist/', '/cart', '/checkout/onepage/',
    '/customer/account/login/', '/catalogsearch/result/?q=x',
  ]) assert.equal(neverAProduct('https://x.com' + p), true, `${p} should be rejected`);
  /* Real pages that share letters with those words must survive. */
  for (const p of [
    '/products/cartridges/', '/services/accounting-software/', '/comparators/', '/basketball-hoops/',
    '/search-and-rescue-equipment/',
  ]) assert.equal(neverAProduct('https://x.com' + p), false, `${p} should be kept`);
});

await test('rejects booking and enquiry forms as products', () => {
  /* Live bug (the road-safety site): three of the 23 "products" were booking forms living
     under /servizi/ — prenota-crash-test and two forms beneath it. They match
     every product keyword, so nothing stopped them, and the screenshots are
     of empty input boxes asking for a VAT number. */
  for (const p of [
    '/servizi/crash-test/prenota-crash-test/',
    '/servizi/principale/prenota-crash-test/prove-fia/',
    '/servizi/crash-test/prenota-crash-test/barriere-di-sicurezza/',
    '/en/request-a-quote/', '/de/termin-buchen/',
  ]) assert.equal(neverAProduct('https://x.com' + p), true, `${p} should be rejected`);

  /* The other twenty pages on that site are real services and must survive — as must
     a reservoir or a steam boiler, which is why the booking words are specific
     rather than "reserv" and "book". */
  for (const p of [
    '/servizi/infrastrutture/gallerie/',
    '/servizi/rilevi-ad-alto-rendimento/vertras/',
    '/servizi/prove-statiche-e-dinamiche/prove-di-impatto/',
    '/servizi/crash-test/i-nostri-crash-test/',
    '/water-reservoirs/', '/steam-boilers/',
  ]) assert.equal(neverAProduct('https://x.com' + p), false, `${p} should be kept`);
});

await test('rejects careers, privacy, legal, press and feeds in any language', async () => {
  /* Live bug (the German medtech site): the reject list was English-only, and sibling
     matching takes a page for WHERE it sits rather than what it is called. Six
     "products" came back of which five were wrong, and product_6.jpg was a
     screenshot of raw RSS XML. */
  const seed = site.rejectUrl + 'widgets/';
  const { links } = await discoverProductLinks(site.rejectUrl, { limit: 50, seeds: [seed] });
  for (const bad of ['/karriere/', '/datenschutz/', '/rechtliches/', '/feed/',
                     '/lavora-con-noi/', '/rassegna-stampa/', '/certificazione-ce/',
                     '/4-workshop-purification-therapies/', '/grant-1-2-4-25-2025-01916/']) {
    assert.ok(!links.some((u) => u.includes(bad)), `picked up ${bad}`);
  }
  assert.ok(links.some((u) => u.includes('/widgets/')), 'the one real product must survive');
});

await test('does not capture the homepage again in another language', async () => {
  const { links } = await discoverProductLinks(site.rejectUrl, { limit: 50, seeds: [site.rejectUrl + 'widgets/'] });
  assert.ok(!links.some((u) => /\/(en|de)\/?$/.test(u)), 'a language-only path is the homepage');
});

await test('keeps one language when a site publishes every product twice', async () => {
  /* Live bug (the Hungarian feed site): /termekek/ and /en/products/ are the same page in two
     languages, with identical photographs, and both were captured — two of
     two slots for one page. The biomedical site spent two of four the same way. */
  const { links } = await discoverProductLinks(site.bilingualUrl, { limit: 50 });
  assert.ok(links.length > 0, 'the site does have products');
  assert.ok(!links.some((u) => u.includes('/en/')), 'the /en/ copies are translations of what we already have');
  assert.ok(links.some((u) => u.includes('/termekek/')), 'the site-language original must stay');
});

await test('finds products on a site that names pages after the products', async () => {
  /* The spacetech.example shape: no path contains "product" or "service", so keyword
     matching finds nothing and the agent returned a different four every run.
     One confirmed product is enough to recognise its siblings. */
  const seeds = [site.namedUrl.replace(/\/$/, '') + '/3d-measurement/'];
  const { links } = await discoverProductLinks(site.namedUrl, { limit: 20, seeds });
  for (const want of ['/thermal-vacuum-chamber/', '/conversion-coating/', '/thermo-optical-painting/', '/satellite-radiator/']) {
    assert.ok(links.some((u) => u.includes(want)), `missing sibling ${want}`);
  }
  assert.ok(!links.some((u) => /about-us|news|contact/.test(u)), 'siblings must not include about/news/contact');
});

await test('finds nothing on that site without a seed to work from', async () => {
  // Proves the previous test passes because of sibling matching, not by accident.
  const { links } = await discoverProductLinks(site.namedUrl, { limit: 20 });
  assert.equal(links.length, 0, 'keyword matching should find nothing here');
});

console.log('\ncapture locale');

/* QA reproduced a company arriving in two languages at once — English homepage,
   English about-us, Hungarian product page — from URLs the agent had returned
   consistently. The context was pinned to en-US, so the site's own default URLs
   were served in English while a URL naming its language in the path was not. */
const { captureLocale } = await import('../capture.js');

await test('serves a Hungarian site in Hungarian, not English', () => {
  assert.equal(captureLocale('https://example.hu/'), 'hu-HU');
  assert.equal(captureLocale('https://example.hu/rolunk/'), 'hu-HU');
  assert.equal(captureLocale('https://example.hu/termekek/'), 'hu-HU');
  assert.equal(captureLocale('https://www.example.hu/'), 'hu-HU');
});

await test('lets an explicit language path override the domain', () => {
  /* The site itself said which language this URL is. That statement outranks
     any guess made from the hostname, in both directions. */
  assert.equal(captureLocale('https://example.hu/en/'), 'en-US');
  assert.equal(captureLocale('https://example.hu/en/products/'), 'en-US');
  assert.equal(captureLocale('https://example.hu/hu/'), 'hu-HU');
  assert.equal(captureLocale('https://example.com/hu/'), 'hu-HU');
});

await test('reads the path only, so a query or fragment cannot confuse it', () => {
  assert.equal(captureLocale('https://example.hu/en/?lang=hu'), 'en-US');
  assert.equal(captureLocale('https://example.hu/en#hu'), 'en-US');
  assert.equal(captureLocale('https://example.hu/?lang=en'), 'hu-HU');
  assert.equal(captureLocale('https://example.hu/#en'), 'hu-HU');
});

await test('leaves every other site on the previous default', () => {
  /* Deliberately not the start of a country-TLD table: only .hu changes
     behaviour, and only because a live failure was reproduced on one. */
  assert.equal(captureLocale('https://example.com/'), 'en-US');
  assert.equal(captureLocale('https://example.it/prodotti/'), 'en-US');
  assert.equal(captureLocale('https://example.de/'), 'en-US');
  // A hostname that merely ends in the letters "hu" is not a .hu domain.
  assert.equal(captureLocale('https://zhu.example.com/'), 'en-US');
  // Unparseable input keeps the old behaviour rather than throwing.
  assert.equal(captureLocale('not a url'), 'en-US');
});

console.log('\ncollapsed content');

/* biomed.example's About page was captured with Mission, Collaborative Research,
   the Lab section and The team each rendered as a single line with a "+" beside
   it, and feedadditives.example's Products page with one of its three tabs showing. The
   text was in the DOM every time; nothing opened it before the shot. */
const { capture: captureOne } = await import('../capture.js');
const shotDir = path.join(__dirname, '.shots');
await fs.mkdir(shotDir, { recursive: true });
process.on('exit', () => { try { fsSync.rmSync(shotDir, { recursive: true, force: true }); } catch { /* gone */ } });

let collapsedShot;
await test('opens accordions and tab panels before shooting the page', async () => {
  collapsedShot = await captureOne({
    url: site.collapsedUrl, width: 1440, format: 'jpeg',
    outDir: shotDir, fileName: 'collapsed.jpg', onLog: () => {},
  });
  /* Three things must open: the <details>, the ARIA disclosure button, and the
     second tab panel. Anything less means one of the three patterns regressed. */
  assert.ok(collapsedShot.expanded >= 3, `expected 3+ sections opened, got ${collapsedShot.expanded}`);
});

await test('reveals every tab panel rather than clicking through them one by one', async () => {
  /* Clicking each tab in turn shows one panel and hides the previous, so the
     reviewer ends up with the LAST panel instead of the first — worse than
     doing nothing. The panels are revealed directly for that reason. */
  assert.ok(collapsedShot.expanded >= 3);
  assert.equal(collapsedShot.carousels, 1, 'the page has exactly one carousel');
});

await test('reports carousel slides it cannot show instead of hiding the gap', async () => {
  /* spacetech.example's partner strip holds ESA, Airbus, Thales and about twenty
     more, and captured two of them. Nothing in the run said why, so the
     screenshot read as broken rather than as a slider. Sliders are not
     unrolled — their transforms belong to their own script — but the count
     reaches the spreadsheet. */
  assert.equal(collapsedShot.carousels, 1);
  assert.ok(collapsedShot.hiddenSlides >= 3, `expected 3+ off-screen slides, got ${collapsedShot.hiddenSlides}`);
});

await test('leaves navigation menus closed', async () => {
  /* The same aria-expanded pattern drives header dropdowns. Opening those
     drops the whole menu across the top of the capture and reveals nothing
     anyone wanted, so navigation is excluded by design. */
  const shot = await captureOne({
    url: site.navOnlyUrl, width: 1440, format: 'jpeg',
    outDir: shotDir, fileName: 'navonly.jpg', onLog: () => {},
  });
  assert.equal(shot.expanded, 0, 'nothing inside <nav> should have been opened');
});

console.log('\nfull batch');

/* Imported late and with a stub in place of the real FlowHunt client, so no
   API key is needed and the test is deterministic. */
const stubPath = path.join(__dirname, '.flowhunt.stub.mjs');

/* Remove the scratch modules however this process ends — a failing assertion,
   a Ctrl-C, an unhandled rejection. The tidy-up at the bottom of this file
   only runs when everything passes, and one interrupted run left both stubs on
   disk long enough for them to be committed to the repo. Synchronous, because
   'exit' handlers cannot await. */
process.on('exit', () => {
  for (const f of ['.flowhunt.stub.mjs', '.batch.stub.mjs', '.jobs.stub.mjs']) {
    try { fsSync.rmSync(path.join(__dirname, f), { force: true }); } catch { /* nothing to clean */ }
  }
});
process.on('SIGINT', () => process.exit(130));

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

/* Module specifiers must be file:// URLs, not filesystem paths. On Linux the
   two look similar enough that a bare absolute path happens to work; on
   Windows it is "C:\..." and Node rejects it outright as an unknown URL scheme
   ("Received protocol 'c:'"), which is where this first showed up. Backslashes
   would also read as escape characters inside the generated source. */
const asSpecifier = (p) => JSON.stringify(pathToFileURL(p).href);

const batchSrc = (await fs.readFile(path.join(__dirname, '..', 'batch.js'), 'utf8'))
  .replace("from './flowhunt.js'", `from ${asSpecifier(stubPath)}`)
  .replace("from './capture.js'", `from ${asSpecifier(path.join(__dirname, '..', 'capture.js'))}`)
  .replace("from './discover.js'", `from ${asSpecifier(path.join(__dirname, '..', 'discover.js'))}`)
  .replace("from './report.js'", `from ${asSpecifier(path.join(__dirname, '..', 'report.js'))}`);
const batchStub = path.join(__dirname, '.batch.stub.mjs');
await fs.writeFile(batchStub, batchSrc, 'utf8');
const { runBatch } = await import(pathToFileURL(batchStub).href);

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
  // The exact German-medtech / dead-domain case: agent returns no services page,
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

console.log('\nparallel job runner');

/* jobs.js is imported through the same stub trick, so its captureCompany is
   the stubbed batch module's rather than the real FlowHunt-backed one. */
const jobsSrc = (await fs.readFile(path.join(__dirname, '..', 'jobs.js'), 'utf8'))
  .replace("from './batch.js'", `from ${asSpecifier(batchStub)}`);
const jobsStub = path.join(__dirname, '.jobs.stub.mjs');
await fs.writeFile(jobsStub, jobsSrc, 'utf8');
const jobs = await import(pathToFileURL(jobsStub).href);

await test('caps product pages at six and offers no way to change it', () => {
  assert.equal(MAX_PRODUCTS_PER_COMPANY, 6);
  /* The point is that it is not a knob. If a maxProducts option ever comes
     back, a run could quietly document a company as having three products
     because someone typed 3 into a field, and nothing in the spreadsheet would
     say so. */
  const src = fsSync.readFileSync(path.join(__dirname, '..', 'batch.js'), 'utf8');
  assert.ok(!/maxProducts/.test(src), 'batch.js still accepts a maxProducts option');
  for (const f of ['jobs.js', 'server.js', 'public/index.html']) {
    const t = fsSync.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!/maxProducts/i.test(t), `${f} still passes a product-page limit around`);
  }
});

/* A battle test with 51 real companies showed FlowHunt itself returning
   HTTP 500s under that much concurrent load — not a pagesnap bug, but a
   ceiling pagesnap now enforces on FlowHunt's behalf, both server-side and
   in the UI before anyone even clicks Run. */
await test('caps a batch at 50 rows and surfaces it in the UI', () => {
  const serverSrc = fsSync.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /BATCH_MAX_ROWS\s*\|\|\s*50\)/, 'server.js default row cap is not 50');
  assert.ok(/companies\.length > MAX_ROWS/.test(serverSrc), 'server.js no longer rejects an over-limit batch');

  const uiSrc = fsSync.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(uiSrc, /maxRows:\s*50/, 'index.html fallback maxRows is not 50');
  assert.ok(/exceeds the \$\{max\}-row limit/.test(uiSrc), 'index.html does not show an over-limit error message');
  assert.ok(/withinLimit/.test(uiSrc), 'index.html no longer disables Run for an over-limit batch');
});

await test('caps parallelism at 10 however it is asked for', () => {
  assert.equal(jobs.clampConcurrency(50), 10);
  assert.equal(jobs.clampConcurrency('7'), 7);
  assert.equal(jobs.clampConcurrency(0), jobs.DEFAULT_CONCURRENCY);
  assert.equal(jobs.clampConcurrency(-3), 1);
  assert.equal(jobs.clampConcurrency('nonsense'), jobs.DEFAULT_CONCURRENCY);
});

await test('runs companies in parallel and reports per-row detail', async () => {
  const PAR = ['PAR ONE KFT, HU, 7219, localhost, HU1', 'PAR TWO LTD, SK, 6201, localhost, SK2'];
  const job = jobs.createJob({
    companies: PAR,
    headers: ['company_name', 'country', 'nace', 'website', 'vat_id'],
    cells: PAR.map((r) => r.split(',').map((c) => c.trim())),
    settings: { apiKey: 'x', flowId: 'f1', workspaceId: 'w', width: 1440, concurrency: 2 },
  });
  assert.equal(job.settings.concurrency, 2);

  jobs.startJob(job);
  /* startJob returns before the work does — that IS the feature. Wait for the
     job to finish the way the UI does, by asking for its state. */
  let seenParallel = false;
  while (jobs.getJob().running) {
    if (jobs.countRows(jobs.getJob()).running > 1) seenParallel = true;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seenParallel, 'both companies should have been in flight at the same time');

  const pub = jobs.publicJob(jobs.getJob());
  assert.equal(pub.counts.done, 2, JSON.stringify(pub.rows.map((r) => [r.status, r.error])));
  for (const r of pub.rows) {
    assert.ok(r.detail, 'a finished row must carry its detail instead of a log');
    assert.ok(r.detail.homepage, `${r.company} has no homepage screenshot`);
    assert.equal(r.detail.products.length, 5, 'the test site has five product pages, under the cap of six');
  }
  /* The API key must never travel back to the browser. */
  assert.ok(!JSON.stringify(pub).includes('apiKey'), 'publicJob leaked the settings');
});

await test('re-running one row replaces its folder instead of adding to it', async () => {
  const job = jobs.getJob();
  const dir = path.join(BATCH_DIR, 'work', 'export', job.rows[0].folder);
  /* A file left over from an earlier, longer run — product_9 from a run that
     found nine products where this one finds two. Left behind, it ships in the
     zip looking exactly like a real screenshot while no spreadsheet row points
     at it. */
  await fs.writeFile(path.join(dir, 'product_9.jpg'), 'stale', 'utf8');

  jobs.startJob(job, { indexes: [0] });
  while (jobs.getJob().running) await new Promise((r) => setTimeout(r, 100));

  const after = await fs.readdir(dir);
  assert.ok(!after.includes('product_9.jpg'), 'a stale screenshot survived the re-run');
  assert.ok(after.includes('homepage.jpg'), 'the re-run should have recaptured the homepage');
});

await test('exports one zip under a fixed name, overwritten each time', async () => {
  const first = await jobs.exportJob(jobs.getJob());
  const second = await jobs.exportJob(jobs.getJob());
  assert.equal(first.zipFile, second.zipFile, 'the zip name must not change between exports');
  assert.equal(path.basename(second.zipPath), 'batch.zip');
  const zips = (await fs.readdir(BATCH_DIR)).filter((f) => f.endsWith('.zip'));
  assert.deepEqual(zips, ['batch.zip'], `batches dir grew: ${zips.join(', ')}`);
  const { names } = openZip(second.zipPath);
  assert.ok(names.includes('results.xlsx'));
  assert.ok(!names.some((n) => /job\.json|run\.json|rows\.ndjson/.test(n)), 'bookkeeping leaked into the zip');
});

await test('prunes the timestamped zips and run- folders of older versions', async () => {
  await fs.mkdir(path.join(BATCH_DIR, 'run-deadbeef1234'), { recursive: true });
  await fs.writeFile(path.join(BATCH_DIR, 'batch-2026-01-01T00-00-00-000Z.zip'), 'old', 'utf8');
  const removed = await pruneBatchDir();
  assert.equal(removed, 2);
  const left = (await fs.readdir(BATCH_DIR)).sort();
  assert.deepEqual(left, ['batch.zip', 'work'], `unexpected leftovers: ${left.join(', ')}`);
});

await site.close();
await fs.rm(stubPath, { force: true });
await fs.rm(batchStub, { force: true });
await fs.rm(jobsStub, { force: true });
await fs.rm(path.join(BATCH_DIR), { recursive: true, force: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
