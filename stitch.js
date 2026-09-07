import sharp from 'sharp';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Scroll-and-stitch capture.
 *
 * Playwright's `fullPage: true` asks Chromium to rasterise the entire document in
 * one surface. On tall pages that silently returns blank bands — no error, just
 * missing content — and it also misses anything a site only renders while it is in
 * the viewport. Instead we scroll the page one viewport at a time, capture each
 * screen normally, and join the slices.
 *
 * Two details make it seamless:
 *  - Sticky/fixed chrome is hidden after the first slice, so headers and cookie
 *    bars don't repeat down the image.
 *  - The final slice usually overlaps the previous one (the page rarely divides
 *    evenly), so it is cropped to just the remainder.
 */
export async function scrollAndStitch(page, {
  outPath, viewportHeight, scale = 1, format = 'png', quality = 82, onLog = () => {},
}) {
  const totalHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const slices = [];
  let hiddenChrome = false;
  let totalHiddenEls = 0;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pagesnap-'));
  try {

    for (let y = 0; y < totalHeight; y += viewportHeight) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      // Let lazy content for this screen paint before we shoot it.
      await page.waitForTimeout(320);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      /* Sticky/fixed chrome must be re-detected on EVERY slice: navs commonly start
         as `position: static` and only become fixed once the page is scrolled, so a
         single scan at scrollY=0 misses them and they repeat down the image.
         The first slice keeps them — that's the page's genuine top. */
      if (hiddenChrome) {
        /* Diagnostic only, added after stickyheader.example showed a header repeating at every
           slice boundary despite this logic existing. Without a count, there was no
           way to tell "this only checks position:fixed/sticky, and the header uses
           neither" apart from reading source — same blind spot SLOW_STEP_MS fixed
           for timing. A >0 count here on every slice (not just occasionally, for a
           genuinely late-appearing sticky nav) means something IS being caught but
           not enough; a 0 on every slice for a page that visibly repeats its header
           means the check itself doesn't recognize how that header is positioned. */
        const hiddenNow = await page.evaluate(() => {
          /* Only elements currently intersecting the viewport can appear in this
             slice, so there is no point styling the whole document. Scanning every
             element instead cost ~10k getComputedStyle calls per slice on a news
             homepage, which made tall mobile pages take minutes. */
          const vh = window.innerHeight;
          let n = 0;
          for (const el of document.querySelectorAll('body *')) {
            if (el.hasAttribute('data-pagesnap-hide')) continue;
            const r = el.getBoundingClientRect();
            if (r.bottom < 0 || r.top > vh || r.height === 0 || r.width === 0) continue;
            const s = getComputedStyle(el);
            if (s.position === 'fixed' || s.position === 'sticky') {
              el.setAttribute('data-pagesnap-hide', '');
              n++;
            }
          }
          return n;
        });
        if (hiddenNow) {
          totalHiddenEls += hiddenNow;
          onLog(`slice ${slices.length + 1}: hid ${hiddenNow} more fixed/sticky element(s)`);
        }
      } else {
        await page.addStyleTag({
          content: `[data-pagesnap-hide]{visibility:hidden !important}`,
        }).catch(() => {});
        hiddenChrome = true;
      }

      // The browser clamps scrollTo at the bottom, so track where it actually landed.
      const actualY = await page.evaluate(() => Math.round(window.scrollY));
      const remaining = totalHeight - y;
      const sliceHeight = Math.min(viewportHeight, remaining);
      const overlap = y - actualY; // >0 on the final, clamped slice

      /* Write each slice to disk rather than keeping the Buffer. Holding ~19 decoded
         slices in memory costs several hundred MB at 2x, which is enough to be
         OOM-killed in a memory-capped container. sharp can composite from file
         paths, so nothing is lost by spooling them. */
      const slicePath = path.join(tmpDir, `slice-${String(slices.length).padStart(3, '0')}.png`);
      await page.screenshot({
        path: slicePath,
        animations: 'disabled',
        scale: scale === 1 ? 'css' : 'device',
        clip: { x: 0, y: overlap, width, height: sliceHeight },
      });

      slices.push({ file: slicePath, top: y, height: sliceHeight });
      onLog(`slice ${slices.length} captured at y=${y}`);
    }

    onLog(
      totalHiddenEls
        ? `hid ${totalHiddenEls} fixed/sticky element(s) total across ${slices.length - 1} later slice(s)`
        : `no fixed/sticky elements found on slices after the first — if chrome still repeats in the final image, it isn't using position:fixed/sticky and this check doesn't catch it`
    );

    // Compose every slice onto one tall canvas.
    const px = (n) => Math.round(n * scale);
    const composites = slices.map((s) => ({ input: s.file, top: px(s.top), left: 0 }));

    const canvas = sharp({
      create: {
        width: px(width),
        height: px(totalHeight),
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
      limitInputPixels: false,
    }).composite(composites);

    /* PNG is lossless and right for a single capture you may zoom into, but a
       full-page shot of a real site runs 5-7MB — and a batch of a few hundred
       is a download nobody wants to sit through. JPEG at ~82% is visually
       indistinguishable for reviewing page content and lands roughly an order
       of magnitude smaller. The canvas background is already opaque white, so
       dropping the alpha channel loses nothing. */
    if (format === 'jpeg') {
      await canvas.jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(outPath);
    } else {
      await canvas.png({ compressionLevel: 6 }).toFile(outPath);
    }

    return { width, height: totalHeight, slices: slices.length };
  } finally {
    // Scratch slices must go even if the capture threw part-way through,
    // otherwise every failed run leaks tens of MB into the temp directory.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
