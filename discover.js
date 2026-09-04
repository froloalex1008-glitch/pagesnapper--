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
].join('|'), 'i');

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
     relative paths and <base> tags are handled for free. */
  const raw = await page.evaluate(() => {
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

  const candidates = [];
  for (const a of raw) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    // Same site only — an outbound link to a supplier is not this company's product page.
    if (u.hostname.replace(/^www\./, '') !== originHost) continue;
    if (NOT_A_PAGE.test(u.pathname)) continue;

    const pathAndQuery = u.pathname + u.search;
    if (pathAndQuery === '/' || pathAndQuery === '') continue;   // that's the homepage
    if (REJECT.test(pathAndQuery)) continue;
    if (!WANT.test(pathAndQuery) && !WANT.test(a.text)) continue;

    const key = docKey(u.toString());
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      url: u.toString(),
      text: a.text,
      inNav: a.inNav,
      pathAndQuery,
      depth: pathAndQuery.split('/').filter(Boolean).length,
    });
  }
  return { candidates, linkCount: raw.length };
}

/**
 * Opens `homepageUrl` and returns same-site product/service URLs.
 *
 * Never throws — a site that refuses to load simply yields no extra pages,
 * which leaves the agent's own URLs as the result rather than failing the row.
 *
 * @param {string} homepageUrl
 * @param {{limit?: number, timeoutMs?: number, onLog?: (m: string) => void}} opts
 * @returns {Promise<{links: string[], found: number}>} `found` is how many
 *   candidates existed before the limit was applied, so the caller can say
 *   "5 of 12" rather than implying the company has five products.
 */
export async function discoverProductLinks(homepageUrl, { limit = 5, timeoutMs = 25000, onLog = () => {} } = {}) {
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
    let { candidates, linkCount } = await harvest(page, originHost, seen);
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
        } catch { /* the index would not load — keep what the homepage gave */ }
      }
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
