/* A fake company website served on localhost, so the batch pipeline can be
 * tested end to end without calling FlowHunt or hitting anyone's real site.
 *
 * Shaped to exercise the things that actually went wrong in live runs:
 *   - four genuine product pages behind a /products/ index, plus a services
 *     page, so "capture every product" has something to get right or wrong
 *   - decoys that sit next to products in a real nav and must NOT be captured:
 *     about, contact, careers, news, privacy, an off-site link, a PDF
 *   - an about page reachable at a second URL, to exercise deduplication
 */
import http from 'node:http';

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

function render(pathname, title) {
  const extra = pathname === '/products/' ? PRODUCT_INDEX_LINKS : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:0}section{height:800px;padding:40px}
h1{font-size:38px;padding:40px;margin:0}</style></head><body>
${NAV}<h1>${title}</h1>${extra}
<section><h2>${title}</h2><p>Test content for ${pathname}</p></section>
</body></html>`;
}

/** Starts the test site. Returns { url, close() }. */
export function startTestSite(port = 8099) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
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
    server.listen(port, () => resolve({
      url: `http://localhost:${port}/`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
