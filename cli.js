import { capture } from './capture.js';

const url = process.argv[2];
if (!url) { console.error('usage: node cli.js <url> [width]'); process.exit(1); }

const r = await capture({ url, width: Number(process.argv[3]) || 1440 });
console.log('\nRESULT', JSON.stringify({
  file: r.file, size: `${r.pageWidth}x${r.pageHeight}`,
  images: r.images, capped: r.capped, secs: (r.durationMs/1000).toFixed(1),
}, null, 2));
