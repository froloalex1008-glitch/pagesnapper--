/* Finds a company's product / service pages by reading its own website.
 *
 * Why this exists: the FlowHunt agent reports at most a handful of URLs in its
 * services field — in a live 8-company run it gave one URL for seven of them
 * and two for the eighth. KPMG asked for every product page, so "capture what
 * the agent sent" cannot satisfy the requirement no matter how carefully it is
 * implemented. The only way to find four product pages on a site with four
 * product pages is to open the site and look.
 *
 * This deliberately reads the DOM only — no screenshots, no scrolling, no
 * consent handling. Links are in the markup whether or not a cookie banner is
 * covering them, so this stays fast (a couple of seconds) next to a capture
 * (twenty to thirty).
 */
import { chromium } from 'playwright';

/* Words that mark a link as a product/service page, across the languages in
   KPMG's list — English, German, Italian, Hungarian, Polish, Czech, Slovak,
   Spanish, French, Romanian. Matched against both the href and the link text,
   because plenty of sites use /p/12 as the path and put the meaning in the
   label. */
const WANT = new RegExp([
  'product', 'service', 'solution', 'offering', 'portfolio', 'catalog', 'catalogue', 'shop', 'store',
  'prodotti', 'servizi', 'soluzioni',            // it
  'produkt', 'produkte', 'dienstleistung', 'leistungen', 'angebot', 'loesungen', 'lösungen',  // de
  'termek', 'termékek', 'szolgaltat', 'szolgáltat',   // hu
  'produkty', 'uslugi', 'usługi', 'oferta',      // pl / cz / sk
  'sluzby', 'služby',                            // cz / sk
  'servicios', 'productos',                      // es
  'produits', 'prestations',                     // fr
  'servicii', 'produse',                         // ro
].join('|'), 'i');

/* Pages that often sit right next to the product links in a nav and would
   otherwise be captured as products. Checked first — a URL matching both
   (e.g. /about/our-services/) is judged by intent, and "about" wins for a
   path segment while a deeper /services/ segment is handled below. */
const REJECT = new RegExp([
  'about', 'contact', 'career', 'job', 'vacanc', 'news', 'blog', 'press', 'event',
  'privacy', 'cookie', 'terms', 'legal', 'imprint', 'impressum', 'disclaimer', 'gdpr',
  'login', 'signin', 'register', 'account', 'cart', 'checkout', 'basket', 'wishlist',
  'sitemap', 'search', 'faq', 'support', 'help', 'download', 'investor', 'sustainab',
  'chi-siamo', 'chisiamo', 'ueber-uns', 'uber-uns', 'rolunk', 'o-nas', 'onas', 'qui-sommes',
  'kontakt', 'contatti', 'kapcsolat', 'despre',
  // People and company-information pages, which sit in the same nav as products.
  'leadership', 'management', 'our-team', '/team', 'staff', 'board-of', 'our-people',
  'history', 'mission', 'vision', 'award', 'certificat',
  /* Booking and enquiry FORMS. These live under the services path and match
     every product keyword, so they sailed straight through: a live run filed
     aisico.com/servizi/principale/prenota-crash-test/prove-fia/ as a product
     when the page is a form asking for company name, address, VAT number and
     a submit button. A reviewer opening that screenshot sees empty input
     boxes, not what the company does. */
  'prenota', 'prenotazione', 'booking', 'book-a', 'reserve', 'reservation',
  'richiedi', 'request-a', 'preventivo', 'quote', 'iscriviti', 'newsletter',
  'buchen', 'anfrage', 'reserva', 'reserver', 'r[ée]server', 'devis',
  'foglal', 'rezerw', 'rezerv', 'objednat', 'objednavka',

  /* ── Everything above this line is English, and that was fine while
     discovery matched product KEYWORDS: a German privacy page was never going
     to contain the word "product". Sibling matching changed the rules — it
     takes a page because of WHERE it sits, not what it is called — and a live
     run against activoris.com returned six "products" of which five were
     /karriere/, /datenschutz/, /rechtliches/, /feed/ and the site's own
     English homepage. product_6.jpg was a screenshot of raw RSS XML.

     So the same categories, in the languages KPMG's list actually contains. */
  // careers
  'karriere', 'stellenangebote', 'lavora-con-noi', 'lavora-con', 'praca', 'kariera',
  'allas', 'álláss', 'empleo', 'emploi', 'locuri-de-munca', 'kariéra',
  // privacy, legal and terms
  'datenschutz', 'rechtliches', 'agb', 'nutzungsbedingungen',
  'note-legali', 'informativa', 'privacidad', 'aviso-legal', 'mentions-legales',
  'ochrana-osobnych', 'ochrana-udaju', 'adatvedelmi', 'polityka-prywatnosci',
  // press, media and complaints
  'rassegna-stampa', 'comunicati', 'medien', 'aktualnosci', 'hirek', 'novinky',
  'ricorsi', 'reclami', 'segnalazioni', 'complaint', 'whistleblow',
  // certifications and accreditations — company credentials, not offerings
  'certifica', 'accredit', 'zertifiz', 'tanusit',
  /* Events and publications. The list had "news" but not "workshop", so
     aferetica.com/4-workshop-purification-therapies-…-transplant-international-journal/
     — a conference paper announcement — was captured as product_4. */
  'workshop', 'convegno', 'congress', 'webinar', 'seminar', 'evento', 'konferen',
  'white-paper', 'whitepaper', 'publication', 'pubblicazioni', 'brochure',
  // machine-readable endpoints that render as source code in a screenshot
  '/feed', '/rss', '/amp', '/wp-json', '/sitemap',
].join('|'), 'i');

/* A path segment that is a reference number rather than a name. EU grant
   disclosures are the case that made this necessary — admatis.com carries
   /ginop_plusz-1-2-4-25-2025-01916/ and /ginop_plusz-2-1-1-21-2022-00132/,
   mandatory funding notices that sibling matching filed as products. Rather
   than hardcode the Hungarian programme names (every country has its own:
   GINOP, EFOP, POIR, POIG…), reject any segment carrying three or more
   separate number groups. A product page is essentially never named that way,
   while "/cheops-2/" and "/karba-go-88-b/" have one group and survive. */
const REFERENCE_CODE = /(?:\d+[-_]){3,}\d*/;

/* A path that is nothing but a language code: /en/, /de/, /en-us/. This is the
   homepage in another language, not a product — activoris.com/?lang=en and
   aisico.com/en/ were both captured as products in a live run, duplicating a
   homepage screenshot we already had. */
const LANGUAGE_ONLY_PATH = /^\/[a-z]{2}(?:[-_][a-z]{2})?\/?$/i;

/** The leading language segment of a path, or '' when there isn't one. */
export function languagePrefix(pathname) {
  const first = String(pathname || '').split('/').filter(Boolean)[0] || '';
  return /^[a-z]{2}(?:[-_][a-z]{2})?$/i.test(first) ? first.toLowerCase().replace('_', '-') : '';
}

/* A deliberately NARROW test for pages that cannot be a product no matter what
   any source claims. Used on the agent's own URLs, which are otherwise trusted
   — a live run had the agent offer accelsiors.com/leadership/ as a services
   page, and it was captured and filed as product_2, a page of staff portraits
   sitting in a KPMG deliverable labelled as an offering.

   Kept much smaller than REJECT above on purpose. REJECT includes "about",
   which is right when ranking links scraped off a nav but would throw away a
   genuine "/about/our-services/" that the agent had actually verified. */
const NEVER_A_PRODUCT = new RegExp(
  '/(leadership|management|our-team|team|staff|board|our-people|careers?|jobs?'
  + '|contact|kontakt|contatti|privacy|cookies?|terms|imprint|impressum|sitemap|login'
  + ')(/|$)', 'i');

/* Booking and enquiry forms, matched ANYWHERE inside a path segment rather
   than as a whole segment — the live examples are "prenota-crash-test" and
   "prenota-crash-test/prove-fia", where the giveaway word is glued to the
   thing being booked. Whole-segment matching missed all three.

   Kept separate from the list above, which stays strict on purpose: matching
   "team" loosely would throw away "/steam-boilers/". The words here are
   specific enough to be safe as substrings, which is why "reserve" and
   "reserva" are absent — a reservoir is a real product. */
const BOOKING_FORM = new RegExp(
  '/[^/]*(prenota|booking|book-a-|request-a|get-a-quote|reservation|richiedi|preventivo|iscriviti'
  + '|newsletter|buchen|anfrage|devis|foglal[aá]s|rezerwacja|rezerv[aá]c|objednat'
  + ')[^/]*(/|$)', 'i');

/* Shop plumbing that lives under a catalogue path and so inherits its product
   keywords. Live example (Distrame): /catalog/product_compare/ was filed as
   product_3 — an empty "you have no items to compare" page in a KPMG
   deliverable. Whole segments only; "cart" as a substring would drop
   "/cartridges/", and "compare" inside a longer word is rare enough that the
   segment form is what actually occurs in practice (Magento, WooCommerce,
   PrestaShop all use it as its own segment). */
const SHOP_UTILITY = new RegExp(
  '/(product_compare|compare|wishlist|cart|basket|checkout|customer|account|my-account'
  + '|search|catalogsearch|quickorder|advanced-search)(/|$)', 'i');

/** True when a URL's path is one of those pages, a booking/enquiry form, or a
    shop utility page (compare, cart, wishlist, checkout). */
export function neverAProduct(url) {
  try {
    const p = new URL(url).pathname;
    return NEVER_A_PRODUCT.test(p) || BOOKING_FORM.test(p) || SHOP_UTILITY.test(p);
  } catch { return false; }
}

/* Non-page links that look like links. */
const NOT_A_PAGE = /\.(jpe?g|png|gif|svg|webp|pdf|docx?|xlsx?|pptx?|zip|rar|mp4|mp3|css|js)(\?|$)/i;

/** Same document? Fragments never load a different page; a trailing slash and
    a www. prefix never change one either. Kept identical in spirit to the
    dedup key batch.js uses, so the two agree about what "already have it" means. */
function docKey(u) {
  try {
    const p = new URL(u);
    p.hash = '';
    p.hostname = p.hostname.toLowerCase().replace(/^www\./, '');
    p.pathname = p.pathname.replace(/\/+$/, '') || '/';
    return p.toString();
  } catch { return String(u); }
}

/* Rank candidates so that, when there are more than the cap allows, the ones
   we keep are the most likely to be real product pages:
   - a hint word in the URL path beats one only in the link text, because a
     path is chosen by the site's own information architecture and link text
     is often marketing copy ("See what we can do for you")
   - shallower paths beat deeper ones: /products/pumps is a product category,
     /products/pumps/xr200/spec-sheet/downloads is a leaf detail page
   - a link that appears in a <nav> beats one from the page body or footer */
function score(c) {
  let s = 0;
  if (WANT.test(c.pathAndQuery)) s += 100;
  if (WANT.test(c.text)) s += 40;
  if (c.inNav) s += 30;
  s -= Math.max(0, c.depth - 1) * 8;
  s -= Math.min(20, Math.floor(c.pathAndQuery.length / 20));
  return s;
}

/** Collects product-ish links from one already-loaded page. */
async function harvest(page, originHost, seen) {
  /* Anchors as the browser resolved them: href is already absolute here, so
     relative paths and <base> tags are handled for free.

     Retried once because a page that redirects or rewrites itself just after
     load destroys the execution context mid-evaluate ("Execution context was
     destroyed, most likely because of a navigation"). That happened live on
     adexgo.hu and cost that company its product discovery entirely. Settling
     first and asking again is enough — by then the navigation has landed. */
  const readAnchors = () => page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.href;
      if (!href) continue;
      out.push({
        href,
        text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        inNav: !!a.closest('nav, header, [role="navigation"], .nav, .menu, #menu, .navbar'),
      });
    }
    return out;
  });

  let raw;
  try {
    raw = await readAnchors();
  } catch (err) {
    if (!/execution context was destroyed|navigation/i.test(String(err?.message))) throw err;
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    raw = await readAnchors();
  }

  /* Two lists come out of this. `candidates` are links that look like product
     pages by their wording. `all` is every same-site content page, keyword or
     not — needed because plenty of sites name product pages after the product
     itself. admatis.com is the case in point: 120 links on the homepage, not
     one containing "product" or "service", because the pages are called
     /3d-measurement/, /conversion-coating/, /thermal-vacuum-chamber/. Keyword
     matching cannot find those, but they are recognisable another way: they sit
     alongside a page the agent already told us is a product. */
  const candidates = [];
  const all = [];
  for (const a of raw) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    // Same site only — an outbound link to a supplier is not this company's product page.
    if (u.hostname.replace(/^www\./, '') !== originHost) continue;
    if (NOT_A_PAGE.test(u.pathname)) continue;

    const pathAndQuery = u.pathname + u.search;
    /* The homepage in each of its disguises. Matching the bare string "/"
       missed two of them: a query makes it "/?lang=en" and a language prefix
       makes it "/en/", and both were captured as products in a live run. */
    if (u.pathname === '/' || u.pathname === '') continue;
    if (LANGUAGE_ONLY_PATH.test(u.pathname) && !u.search) continue;
    if (REFERENCE_CODE.test(u.pathname)) continue;
    if (REJECT.test(pathAndQuery)) continue;

    const key = docKey(u.toString());
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = {
      url: u.toString(),
      text: a.text,
      inNav: a.inNav,
      pathAndQuery,
      depth: pathAndQuery.split('/').filter(Boolean).length,
    };
    all.push(entry);
    if (WANT.test(pathAndQuery) || WANT.test(a.text)) candidates.push(entry);
  }
  return { candidates, all, linkCount: raw.length };
}

/** The path a page sits under: "/servizi/prove/x" -> "/servizi/prove". */
function parentPath(pathname) {
  const parts = String(pathname).split('?')[0].split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

/**
 * Opens `homepageUrl` and returns same-site product/service URLs.
 *
 * Never throws — a site that refuses to load simply yields no extra pages,
 * which leaves the agent's own URLs as the result rather than failing the row.
 *
 * @param {string} homepageUrl
 * @param {{limit?: number, seeds?: string[], timeoutMs?: number, onLog?: (m: string) => void}} opts
 *   `seeds` are product URLs the agent already confirmed. Pages sitting
 *   alongside one of them are treated as products too, which is the only way
 *   to find pages a site names after the product rather than after the word
 *   "product".
 * @returns {Promise<{links: string[], found: number}>} `found` is how many
 *   candidates existed before the limit was applied, so the caller can say
 *   "5 of 12" rather than implying the company has five products.
 */
export async function discoverProductLinks(homepageUrl, { limit = 5, seeds = [], timeoutMs = 25000, onLog = () => {} } = {}) {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(homepageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const originHost = new URL(homepageUrl).hostname.replace(/^www\./, '');
    const seen = new Set([docKey(homepageUrl)]);
    let { candidates, all, linkCount } = await harvest(page, originHost, seen);
    candidates.sort((x, y) => score(y) - score(x));

    onLog(candidates.length
      ? `read ${linkCount} link(s) on the homepage — ${candidates.length} look like product pages`
      : `read ${linkCount} link(s) on the homepage — none look like product pages`);

    /* Plenty of sites put a single "Products" entry in the nav and list the
       actual products one level down. Screenshotting the index in that case
       yields one picture of a menu instead of four pictures of products, which
       is precisely what KPMG asked us not to do. So when the homepage did not
       yield enough on its own, follow the single most index-looking candidate
       and harvest its children too.
       Bounded to ONE extra page load per company: enough to turn a products
       index into its products, cheap enough not to matter next to a capture,
       and no risk of wandering off into a crawl. */
    const index = candidates.find((c) => c.depth <= 2 && WANT.test(c.pathAndQuery));
    /* Count what we have EXCLUDING the index itself. A homepage that links
       straight to four product pages needs no expansion; one that links only
       to "Products" needs it even when the cap is small, because otherwise the
       single screenshot we take is of a menu. Judging by candidates.length
       alone conflated the two and left small caps stuck on the index page. */
    const realProducts = candidates.filter((c) => c !== index).length;
    if (realProducts < limit) {
      if (index) {
        try {
          await page.goto(index.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          const deeper = await harvest(page, originHost, seen);
          /* Only children of the index — a link back up to /about/ from that
             page is not a product, and the nav is repeated on every page. */
          const children = deeper.candidates.filter((c) => c.pathAndQuery.startsWith(index.pathAndQuery.replace(/\/$/, '') + '/'));
          if (children.length) {
            onLog(`followed ${index.pathAndQuery} — ${children.length} product page(s) listed there`);
            /* The index itself is no longer worth a screenshot once we have
               the things it indexes. */
            candidates = candidates.filter((c) => c.url !== index.url);
            candidates.push(...children);
            candidates.sort((x, y) => score(y) - score(x));
          }
          all.push(...deeper.all);
        } catch { /* the index would not load — keep what the homepage gave */ }
      }
    }

    /* ── Siblings of a page the agent vouched for ────────────────────────
       The remaining blind spot, and the one that made admatis.com return a
       different four products on every run: its pages are named after the
       products, so no keyword matches and discovery contributed nothing while
       the agent supplied whichever handful it happened to pick that time.

       But the agent does hand us at least one real product URL, and a site
       keeps its products together. /3d-measurement/ sits at the root next to
       /conversion-coating/ and /thermal-vacuum-chamber/; /servizi/crash-test/
       sits next to /servizi/prove-statiche/. So take each confirmed product,
       and treat any page under the same parent path as a product too.

       REJECT has already removed about/contact/news/careers/legal from `all`,
       which is what keeps this from turning a flat site's whole root into
       "products". */
    const seedInfo = seeds.map((s) => {
      try {
        const p = new URL(s);
        return { parent: parentPath(p.pathname), depth: p.pathname.split('/').filter(Boolean).length };
      } catch { return null; }
    }).filter(Boolean);

    if (seedInfo.length) {
      const known = new Set(candidates.map((c) => docKey(c.url)));
      const siblings = all.filter((c) => {
        if (known.has(docKey(c.url))) return false;
        return seedInfo.some((s) => s.depth === c.depth && parentPath(c.pathAndQuery) === s.parent);
      });
      if (siblings.length) {
        onLog(`${siblings.length} page(s) sit alongside a product the agent named — treating those as products too`);
        candidates.push(...siblings);
        candidates.sort((x, y) => score(y) - score(x));
      }
    }

    /* ── One language per company ──────────────────────────────────────────
       A bilingual site offers every product twice, and both copies score the
       same, so both get captured. adexgo.hu came back with exactly two product
       pages — /termekek/ and /en/products/ — which are one page in Hungarian
       and English, with identical photographs. aferetica.com spent two of its
       four slots the same way. On a six-page cap that is half the budget gone
       to duplicates.

       Path comparison cannot see it: the slug is translated too, so
       "/termekek/" and "/en/products/" share no characters. What they do share
       is that one carries a language prefix and the other doesn't. So: keep
       the language the HOMEPAGE is in. advantech-time.com/it/ is itself
       prefixed, so its /it/ pages are the ones kept and /en/ dropped; adexgo.hu
       has no prefix, so /termekek/ stays and /en/products/ goes.

       The guard matters — if a company's only product pages live under a
       foreign prefix, dropping them all would leave nothing, and one language
       of a product beats none. */
    const homeLang = languagePrefix(new URL(homepageUrl).pathname);
    const sameLanguage = candidates.filter((c) => languagePrefix(c.pathAndQuery) === homeLang);
    if (sameLanguage.length && sameLanguage.length < candidates.length) {
      onLog(`dropped ${candidates.length - sameLanguage.length} page(s) that are other-language copies`);
      candidates = sameLanguage;
    }

    const links = candidates.slice(0, limit).map((c) => c.url);
    return { links, found: candidates.length };
  } catch (err) {
    /* Discovery is an enhancement, never a reason to fail a company. */
    onLog(`could not read the homepage for product links (${String(err.message || err).split('\n')[0].slice(0, 120)})`);
    return { links: [], found: 0 };
  } finally {
    await browser?.close().catch(() => {});
  }
}
