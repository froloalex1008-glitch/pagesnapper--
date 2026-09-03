/* Validation helper: renders N evenly-spaced crops of a capture so you can eyeball
   whether the page is genuinely complete top-to-bottom. */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

const file = path.resolve(process.argv[2]);
const n = Number(process.argv[3]) || 4;
const tag = path.basename(file).split('-')[0];

const html = path.join(os.tmpdir(), `pagesnap-verify-${tag}.html`);
await fs.writeFile(html, `<body style="margin:0;background:#333">
  <img id="i" src="file://${file}" style="width:1000px;display:block">
</body>`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
await page.goto('file://' + html);
await page.waitForFunction(() => { const i = document.getElementById('i'); return i.complete && i.naturalHeight > 0; }, { timeout: 60000 });

const h = await page.evaluate(() => document.getElementById('i').getBoundingClientRect().height);
console.log(`rendered height at 1000px wide: ${Math.round(h)}px`);

// Same fix as batch.mjs: '/tmp' is Unix-only and resolves to a nonexistent
// drive-relative path on Windows. os.tmpdir() works on every platform.
const cropPath = (i) => path.join(os.tmpdir(), `${tag}_crop${i}.png`);
for (let i = 0; i < n; i++) {
  const y = Math.round((h - 720) * (i / (n - 1)));
  await page.evaluate((y) => window.scrollTo(0, y), y);
  await page.waitForTimeout(250);
  await page.screenshot({ path: cropPath(i) });
}
await browser.close();
console.log(`crops → ${cropPath(0)} .. ${cropPath(n - 1)}`);
