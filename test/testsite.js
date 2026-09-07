/* A fake company website served on localhost, so the batch pipeline can be
 * tested end to end without calling FlowHunt or hitting anyone's real site.
 *
 * Shaped to exercise the things that actually went wrong in live runs:
 *   - four genuine product pages behind a /products/ index, plus a services
 *     page, so "capture every product" has something to get right or wrong
 *   - decoys that sit next to products in a real nav and must NOT be captured:
 *     about, contact, careers, news, privacy, an off-site link, a PDF
 *   - an about page reachable at a second URL, to exercise deduplication
 *   - a second site, shaped like admatis.com: product pages named after the
 *     products themselves ("/thermal-vacuum-chamber/", not "/products/x"), so
 *     no keyword can find them and only sibling-matching works
 *   - a Hungarian cookie banner, because adexgo.hu's "Elfogadom / Elutasítom"
 *     matched nothing and sat across every screenshot of that company
 */
import http from 'node:http';

/* Hungarian, and deliberately worded like the real adexgo.hu banner: the
   privacy-notice link sits next to the buttons and must NOT be clicked. */
const HU_CONSENT = `
<div id="cookie-consent" style="position:fixed;bottom:0;left:0;right:0;background:#333;color:#fff;padding:16px;z-index:9999;text-align:center">
  Kedves Látogató! Honlapunk statisztikai célból Google Analytics sütiket használ.
  <button type="button" onclick="document.getElementById('cookie-consent').remove()">Elfogadom</button>
  <button type="button" onclick="document.getElementById('cookie-consent').remove()">Elutasítom</button>
  <a href="/privacy/">Adatvédelmi tájékoztató</a>
</div>`;

const NAV = `
<nav>
  <a href="/">Home</a>
  <a href="/about-us/">About Us</a>
  <a href="/products/">Products</a>
  <a href="/services/calibration/">Calibration services</a>
  <a href="/news/">News</a>
  <a href="/careers/">Careers</a>
  <a href="/privacy/">Privacy</a>
  <a href="/contact/">Contact</a>
  <a href="https://supplier-example.com/products/">Supplier products</a>
  <a href="/brochure.pdf">Product brochure (PDF)</a>
</nav>`;

const PRODUCT_INDEX_LINKS = `
<ul>
  <li><a href="/products/pumps/">Pumps</a></li>
  <li><a href="/products/valves/">Valves</a></li>
  <li><a href="/products/sensors/">Sensors</a></li>
  <li><a href="/products/controllers/">Controllers</a></li>
</ul>`;

const PAGES = {
  '/': 'Testco Home',
  '/about-us/': 'About Testco',
  '/products/': 'Our Products',
  '/products/pumps/': 'Pumps',
  '/products/valves/': 'Valves',
  '/products/sensors/': 'Sensors',
  '/products/controllers/': 'Controllers',
  '/services/calibration/': 'Calibration Services',
  '/news/': 'News',
  '/careers/': 'Careers',
  '/privacy/': 'Privacy Policy',
  '/contact/': 'Contact',
};

/* activoris.com's shape: a German site whose nav carries careers, privacy and
   legal pages, an RSS feed, an EU grant notice and the homepage in two other
   languages — every one of which a live run captured as a product. Plus one
   real product, which must survive. */
const REJECT_LINKS = [
  '/widgets/', '/karriere/', '/datenschutz/', '/rechtliches/', '/feed/',
  '/lavora-con-noi/', '/rassegna-stampa/', '/certificazione-ce/',
  '/4-workshop-purification-therapies/', '/grant-1-2-4-25-2025-01916/',
  '/en/', '/de/',
];
const REJECT_NAV = `<nav>${REJECT_LINKS.map((x) => `<a href="${x}">${x}</a>`).join(' ')}</nav>`;

/* adexgo.hu's shape: every product exists twice, once in the site's own
   language and once under /en/. Both scored the same, so both were captured —
   two slots, one page. */
const BILINGUAL_LINKS = ['/termekek/', '/szolgaltatasok/', '/en/products/', '/en/services/'];
const BILINGUAL_NAV = `<nav>${BILINGUAL_LINKS.map((x) => `<a href="${x}">${x}</a>`).join(' ')}</nav>`;

/* Each of these lives at the ROOT of its own port, because that is where a
   company website lives. Serving them under /reject/ and /bilingual/ on the
   shared port made "/en/" look like "/reject/en/" — not a language-only path —
   and the language rules under test never fired. The harness was wrong, not
   the code, and it took two red tests to notice. */
function serveShape(port, title, nav) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(render(new URL(req.url, 'http://x').pathname, title, { nav }));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

/* A site whose product pages are named after the products. Nothing in these
   paths contains "product" or "service" — exactly admatis.com's shape. */
const NAMED_PRODUCTS = [
  '/thermal-vacuum-chamber/', '/conversion-coating/', '/3d-measurement/',
  '/thermo-optical-painting/', '/satellite-radiator/',
];
const NAMED_NAV = `
<nav>
  <a href="/">Home</a> <a href="/about-us/">About Us</a>
  ${NAMED_PRODUCTS.map((p) => `<a href="${p}">${p.replace(/\//g, '').replace(/-/g, ' ')}</a>`).join(' ')}
  <a href="/news/">News</a> <a href="/contact/">Contact</a>
</nav>`;

function render(pathname, title, opts = {}) {
  const extra = pathname === '/products/' ? PRODUCT_INDEX_LINKS : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0}section{height:800px;padding:40px}
h1{font-size:38px;padding:40px;margin:0}</style></head><body>
${opts.nav ?? NAV}<h1>${title}</h1>${extra}
<section><h2>${title}</h2><p>Test content for ${pathname}</p></section>
${opts.consent ? HU_CONSENT : ''}
</body></html>`;
}

/**
 * Starts the test site. Returns { url, namedUrl, close() }.
 *
 * `url` is the keyword-friendly site; `namedUrl` (same server, under /named/)
 * is the admatis-shaped one whose products can only be found by sibling
 * matching. Pages under /named/ also carry the Hungarian consent banner.
 */
export function startTestSite(port = 8099) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (pathname.startsWith('/named')) {
      const rest = pathname.slice('/named'.length) || '/';
      const key = rest.endsWith('/') ? rest : rest + '/';
      const known = key === '/' || key === '/about-us/' || key === '/news/'
        || key === '/contact/' || key === '/privacy/' || NAMED_PRODUCTS.includes(key);
      if (!known) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      const nav = NAMED_NAV.replace(/href="\//g, 'href="/named/');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(render(key, key === '/' ? 'Named Co' : key, { nav, consent: true }));
    }

    const key = pathname.endsWith('/') || pathname === '' ? pathname || '/' : pathname + '/';
    const title = PAGES[key] ?? PAGES[pathname];
    if (!title) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(render(key, title));
  });
  return new Promise((resolve) => {
    server.listen(port, async () => resolve({
      extraServers: [
        await serveShape(port + 1, 'Reject Co', REJECT_NAV),
        await serveShape(port + 2, 'Bilingual Co', BILINGUAL_NAV),
      ],
      url: `http://localhost:${port}/`,
      namedUrl: `http://localhost:${port}/named/`,
      rejectUrl: `http://localhost:${port + 1}/`,
      bilingualUrl: `http://localhost:${port + 2}/`,
      namedProducts: NAMED_PRODUCTS.map((p) => `/named${p}`),
      close: async function () {
        for (const s of this.extraServers) await new Promise((r) => s.close(r));
        await new Promise((r) => server.close(r));
      },
    }));
  });
}
