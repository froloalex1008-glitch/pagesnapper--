/* Batch feature: given a list of homepage URLs, run each through a FlowHunt
 * flow to "expand" it into a list of URLs, screenshot every expanded URL with
 * pagesnap's own capture(), and bundle the results into one ZIP.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { capture } from './capture.js';
import { runFlow, extractUrls } from './flowhunt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BATCH_DIR = process.env.BATCH_DIR || path.join(__dirname, 'batches');

export async function runBatch({ apiKey, flowId, homepages, width, workspaceId, onLog = () => {}, isAborted = () => false }) {
  await fs.mkdir(BATCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = path.join(BATCH_DIR, `batch-${stamp}`);
  await fs.mkdir(workDir, { recursive: true });

  const summary = []; // { homepage, expandedUrls, shots: [{url, file?, error?}], error? }

  for (const [i, homepage] of homepages.entries()) {
    /* The client (browser tab) may have gone away — no point expanding and
       screenshotting the rest of a list nobody's watching anymore. Whatever
       finished before this point still gets zipped up below. */
    if (isAborted()) {
      onLog(`stopping early — client disconnected (${i}/${homepages.length} homepages done)`);
      break;
    }
    onLog(`[${i + 1}/${homepages.length}] expanding ${homepage} via flow…`);
    let expanded = [];
    try {
      const result = await runFlow(apiKey, flowId, homepage, { workspaceId });
      expanded = extractUrls(result);
      onLog(`  → flow returned ${expanded.length} url(s)`);
      if (!expanded.length) {
        onLog(`  WARNING: nothing URL-shaped found in the flow's output — check the flow itself returns a list of URLs`);
      }
    } catch (err) {
      onLog(`  ERROR expanding ${homepage}: ${err.message}`);
      summary.push({ homepage, expandedUrls: [], shots: [], error: err.message });
      continue;
    }

    const shots = [];
    for (const [j, targetUrl] of expanded.entries()) {
      if (isAborted()) {
        onLog(`  stopping early — client disconnected (${j}/${expanded.length} of this homepage's urls done)`);
        break;
      }
      onLog(`  [${j + 1}/${expanded.length}] capturing ${targetUrl}`);
      try {
        const r = await capture({ url: targetUrl, width, onLog: (m) => onLog(`    ${m}`) });
        // capture()'s own filenames are host + second-precision timestamp, so
        // two URLs on the same host captured within the same second (in
        // practice this needs a very fast page — every capture has several
        // seconds of built-in settle time — but it's cheap to rule out) could
        // otherwise collide inside this batch's zip and one screenshot would
        // silently overwrite the other. `file` below still names the copy
        // that lives in the shared screenshots/ folder (used for the "view"
        // link in the UI); only the zip's internal copy gets disambiguated,
        // and only when a collision would actually happen.
        let destName = r.file;
        if (fsSync.existsSync(path.join(workDir, destName))) {
          destName = `${i + 1}-${j + 1}-${r.file}`;
        }
        const dest = path.join(workDir, destName);
        await fs.copyFile(r.path, dest);
        shots.push({ url: targetUrl, file: r.file });
      } catch (err) {
        onLog(`    ERROR capturing ${targetUrl}: ${err.message}`);
        shots.push({ url: targetUrl, error: err.message });
      }
    }
    summary.push({ homepage, expandedUrls: expanded, shots });
  }

  await fs.writeFile(path.join(workDir, 'summary.json'), JSON.stringify(summary, null, 2));

  onLog('zipping results…');
  const zipName = `batch-${stamp}.zip`;
  const zipPath = path.join(BATCH_DIR, zipName);
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(workDir, false); // flatten: zip root = workDir contents
    archive.finalize();
  });

  // The zip is self-contained; the loose working copy isn't needed once it exists.
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});

  const { size } = await fs.stat(zipPath);
  onLog(`done — ${zipName} (${(size / 1024 / 1024).toFixed(2)} MB)`);

  const totalShots = summary.reduce((n, s) => n + s.shots.filter((sh) => sh.file).length, 0);
  return { zipFile: zipName, zipPath, bytes: size, summary, totalHomepages: homepages.length, totalShots };
}
