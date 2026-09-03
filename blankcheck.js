/* Automated validation: reports blank horizontal bands as a % of page height.
   Draws the tall PNG scaled-down into a small canvas so we never hit canvas limits. */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

export async function blankCheck(file) {
  const abs = path.resolve(file);
  // Pass as a data URL: file:// images taint the canvas and block getImageData.
  const dataUrl = 'data:image/png;base64,' + (await fs.readFile(abs)).toString('base64');
  const b = await chromium.launch();
  const p = await b.newPage();
  const r = await p.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const W = 120, H = Math.min(4000, img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const flat = [];
    for (let y = 0; y < H; y++) {
      let min = 255, max = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
        if (v < min) min = v; if (v > max) max = v;
      }
      flat.push(max - min < 4);
    }
    const bands = []; let start = null;
    flat.forEach((f, y) => {
      if (f && start === null) start = y;
      if ((!f || y === H - 1) && start !== null) {
        const pct = ((y - start) / H) * 100;
        if (pct > 3) bands.push({
          fromPct: +((start / H) * 100).toFixed(1),
          toPct: +((y / H) * 100).toFixed(1),
          heightPct: +pct.toFixed(1),
        });
        start = null;
      }
    });
    const blankPct = bands.reduce((a, x) => a + x.heightPct, 0);
    return { imgH: img.naturalHeight, bands, blankPct: +blankPct.toFixed(1) };
  }, dataUrl);
  await b.close();
  return r;
}

/* CLI entry point. Guarded on being the *entry* module — without this, any file
   that imports blankCheck also executes this line and misreads that program's
   own argv as a filename. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2]) {
  console.log(JSON.stringify(await blankCheck(process.argv[2]), null, 2));
}
