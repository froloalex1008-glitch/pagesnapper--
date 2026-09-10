/* report.js
   Builds the self-contained client-facing report.html shipped inside every
   batch.zip. Same visual language as the standalone "Pagesnap Report"
   artifact shown to KPMG, but driven by this run's actual rows instead of a
   fixed three-batch sample — so the report that goes out with a delivery
   always describes that delivery.

   No cost page here on purpose — Alex asked for cost to stay out of the
   app-shipped report. (It's still on the separate KPMG demo artifact.) */

const SHOT_COLUMNS = ['homepage_screenshot_link', 'about_us_screenshot_link', 'services_screenshot_link'];
const LINK_SEP = '; ';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function shotsForRow(row) {
  let n = 0;
  for (const col of SHOT_COLUMNS) {
    const cell = row[col];
    if (!cell || cell === 'failed to capture') continue;
    n += String(cell).split(LINK_SEP).filter(Boolean).length;
  }
  return n;
}

function causeFromError(err) {
  const e = String(err || '');
  if (/403/.test(e)) return 'Blocked';
  if (/certificate/i.test(e)) return 'Invalid certificate';
  if (/timeout/i.test(e)) return 'Timeout';
  if (/refused/i.test(e)) return 'Connection refused';
  if (/404|not found/i.test(e)) return 'Page not found';
  if (/homepage/i.test(e)) return 'No homepage returned';
  return e ? 'Other' : 'Unknown';
}

/* rows: the array buildExport() already has on disk (flow_input, status,
   homepage_screenshot_link, about_us_screenshot_link,
   services_screenshot_link, product_pages, business_summarization,
   business_type, warnings, error).
   stats: { totalCompanies, totalShots, pagesDocumented, productShots } —
   the same numbers buildExport() already returns, passed straight through so
   the report and results.xlsx can never disagree on the headline figures. */
export function buildReportHtml({ rows = [], stats = {}, generatedAt = new Date(), runLabel = '' } = {}) {
  const ok = [];
  const bad = [];
  for (const r of rows) {
    const k = shotsForRow(r);
    const entry = {
      d: r.flow_input || '',
      s: r.status || '',
      k,
      t: r.business_type || '',
      x: r.error || '',
      c: causeFromError(r.error),
    };
    if (k > 0) ok.push(entry); else bad.push(entry);
  }
  const total = rows.length;
  const capturedPct = total ? (ok.length / total) * 100 : 0;
  const failedPct = total ? (bad.length / total) * 100 : 0;

  const causeCounts = {};
  for (const b of bad) causeCounts[b.c] = (causeCounts[b.c] || 0) + 1;
  const causeRows = Object.entries(causeCounts).sort((a, b) => b[1] - a[1]);
  const maxCause = causeRows.length ? causeRows[0][1] : 1;

  const DATA = { ok, bad, total };
  const dataJson = JSON.stringify(DATA);

  const dateStr = generatedAt.toISOString().slice(0, 10);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagesnap Report${runLabel ? ' — ' + esc(runLabel) : ''}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
  :root{
    --bg:#0b0f14; --surface:#121821; --surface-2:#1a2230; --line:#232d3d;
    --text:#e8edf4; --muted:#8996a6; --accent:#5b8cff; --accent-soft:#5b8cff22;
    --good:#3fb968; --good-soft:#3fb96820; --warn:#e0a83e; --warn-soft:#e0a83e20;
    --critical:#e5595e; --critical-soft:#e5595e20;
    --mono:'JetBrains Mono', SFMono-Regular, Consolas, 'Liberation Mono', monospace;
    --sans:'IBM Plex Sans', -apple-system, 'Segoe UI', sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased}
  code{font-family:var(--mono);font-size:.92em}
  .shell{display:grid;grid-template-columns:250px minmax(0,1fr);max-width:1180px;margin:0 auto;align-items:start}
  .rail{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:28px;padding:36px 22px 28px;border-right:1px solid var(--line);overflow-y:auto}
  .brand{display:flex;gap:11px;align-items:flex-start}
  .mark{flex:none;width:26px;height:26px;margin-top:3px;position:relative}
  .mark i{position:absolute;width:9px;height:9px;border:2px solid var(--accent)}
  .mark i:nth-child(1){top:0;left:0;border-right:none;border-bottom:none}
  .mark i:nth-child(2){top:0;right:0;border-left:none;border-bottom:none}
  .mark i:nth-child(3){bottom:0;left:0;border-right:none;border-top:none}
  .mark i:nth-child(4){bottom:0;right:0;border-left:none;border-top:none}
  .mark b{position:absolute;inset:9px;background:var(--accent);border-radius:50%;opacity:.85}
  .brand-txt .kicker{font-family:var(--mono);font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:var(--accent);margin:0 0 3px;line-height:1.4}
  .brand-txt .nm{font-family:var(--mono);font-size:16px;font-weight:700;margin:0;letter-spacing:-.01em;line-height:1.25}
  .nav{display:flex;flex-direction:column;gap:3px}
  .nav a{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:7px;border:1px solid transparent;text-decoration:none;color:var(--muted);font-size:14px;transition:background .15s,color .15s,border-color .15s}
  .nav a .n{font-family:var(--mono);font-size:11px;color:var(--line);transition:color .15s}
  .nav a:hover{background:var(--surface);color:var(--text)}
  .nav a:hover .n{color:var(--muted)}
  .nav a.on{background:var(--surface);border-color:var(--line);color:var(--text);font-weight:600}
  .nav a.on .n{color:var(--accent)}
  .rail-foot{margin-top:auto;font-family:var(--mono);font-size:10.5px;line-height:1.7;color:var(--muted);border-top:1px solid var(--line);padding-top:16px}
  .rail-foot .cap{color:var(--warn)}
  .main{padding:44px 40px 88px;min-width:0}
  .page[hidden]{display:none}
  .phead{margin-bottom:26px;padding-bottom:22px;border-bottom:1px solid var(--line)}
  .phead .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 9px}
  h1{font-family:var(--mono);font-weight:700;font-size:clamp(23px,3.2vw,31px);margin:0 0 10px;letter-spacing:-.015em}
  .lead{color:var(--muted);font-size:14.5px;max-width:66ch;margin:0}
  h3.rule{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 15px;display:flex;align-items:center;gap:10px}
  h3.rule::after{content:"";flex:1;height:1px;background:var(--line)}
  ul.caps{list-style:none;margin:0;padding:0;display:grid;gap:2px}
  ul.caps li{display:flex;gap:12px;align-items:flex-start;padding:13px 16px;background:var(--surface);border:1px solid var(--line)}
  ul.caps li+li{border-top:none}
  ul.caps li:first-child{border-radius:8px 8px 0 0}
  ul.caps li:last-child{border-radius:0 0 8px 8px}
  .tick{flex:none;width:18px;height:18px;margin-top:2px;border-radius:50%;background:var(--good-soft);color:var(--good);display:flex;align-items:center;justify-content:center;font-size:12px}
  ul.caps p{margin:0;font-size:14.5px}
  ul.caps p b{font-weight:600}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .stats.s3{grid-template-columns:repeat(3,1fr)}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:20px}
  .stat .num{font-family:var(--mono);font-size:36px;font-weight:700;color:var(--accent);line-height:1;font-variant-numeric:tabular-nums}
  .stat.good .num{color:var(--good)}
  .stat.critical .num{color:var(--critical)}
  .stat.warn .num{color:var(--warn)}
  .stat .label{margin-top:8px;font-size:13.5px;color:var(--muted)}
  button.stat{display:block;width:100%;text-align:left;font-family:inherit;cursor:pointer;transition:border-color .15s,background .15s}
  button.stat:hover{background:var(--surface-2)}
  button.stat.good:hover{border-color:var(--good)}
  button.stat.critical:hover{border-color:var(--critical)}
  .stat .open{display:flex;align-items:center;gap:6px;margin-top:12px;font-family:var(--mono);font-size:11.5px;letter-spacing:.04em}
  .stat.good .open{color:var(--good)}
  .stat.critical .open{color:var(--critical)}
  .stat .open .arw{transition:transform .15s}
  button.stat:hover .open .arw{transform:translateX(3px)}
  .propbar{margin-bottom:28px}
  .propbar .track{display:flex;height:32px;border-radius:6px;overflow:hidden;gap:2px}
  .propbar .seg.good{background:var(--good)}
  .propbar .seg.critical{background:var(--critical)}
  .propbar .seg:first-child{border-radius:6px 0 0 6px}
  .propbar .seg:last-child{border-radius:0 6px 6px 0}
  .propbar .keys{display:flex;gap:24px;margin-top:13px;flex-wrap:wrap}
  .propbar .key{display:flex;align-items:baseline;gap:8px;font-size:13.5px}
  .propbar .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
  .propbar .sw.good{background:var(--good)}
  .propbar .sw.critical{background:var(--critical)}
  .propbar .key b{font-family:var(--mono);font-variant-numeric:tabular-nums}
  .propbar .key span.muted{color:var(--muted)}
  .barchart{display:grid;gap:13px;margin-bottom:34px}
  .brow{display:grid;grid-template-columns:180px minmax(0,1fr) 62px;align-items:center;gap:12px}
  .brow .blabel{font-size:13.5px}
  .brow .btrack{height:15px;background:var(--surface-2);border-radius:4px;overflow:hidden}
  .brow .bfill{height:100%;background:var(--critical);border-radius:4px 0 0 4px;min-width:3px}
  .brow .bval{font-family:var(--mono);font-size:13px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
  .brow .bval b{color:var(--text);font-weight:600}
  .exp-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
  .seg-btn{display:flex;align-items:center;gap:9px;font-family:var(--sans);font-size:13.5px;background:var(--surface);color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:9px 14px;cursor:pointer;transition:border-color .15s,color .15s,background .15s}
  .seg-btn:hover{color:var(--text);border-color:var(--muted)}
  .seg-btn .cnt{font-family:var(--mono);font-size:12.5px;font-weight:700;padding:2px 8px;border-radius:20px;font-variant-numeric:tabular-nums}
  .seg-btn[data-m="ok"] .cnt{background:var(--good-soft);color:var(--good)}
  .seg-btn[data-m="bad"] .cnt{background:var(--critical-soft);color:var(--critical)}
  .seg-btn[aria-pressed="true"]{color:var(--text);background:var(--surface-2)}
  .seg-btn[data-m="ok"][aria-pressed="true"]{border-color:var(--good)}
  .seg-btn[data-m="bad"][aria-pressed="true"]{border-color:var(--critical)}
  .tblwrap{overflow:auto;max-height:min(560px,72vh);border:1px solid var(--line);border-radius:10px}
  table.co{width:100%;border-collapse:collapse;font-size:13.5px;min-width:620px}
  table.co th{font-family:var(--mono);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);text-align:left;padding:11px 15px;white-space:nowrap;background:var(--surface-2);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1}
  table.co td{padding:10px 15px;border-bottom:1px solid var(--line);vertical-align:top}
  table.co tr:last-child td{border-bottom:none}
  table.co tr:hover td{background:var(--surface)}
  td.site{font-family:var(--mono);font-size:12.5px;white-space:nowrap}
  td.dim{color:var(--muted)}
  td.mid{text-align:center;font-family:var(--mono);font-variant-numeric:tabular-nums}
  .tag{display:inline-block;font-family:var(--mono);font-size:10.5px;padding:3px 8px;border-radius:20px;white-space:nowrap}
  .tag.v{background:var(--good-soft);color:var(--good)}
  .tag.u{background:var(--warn-soft);color:var(--warn)}
  .tag.f{background:var(--critical-soft);color:var(--critical)}
  .tag.block{background:var(--critical-soft);color:var(--critical)}
  .tag.other{background:var(--warn-soft);color:var(--warn)}
  .shots{display:flex;align-items:center;gap:7px}
  .shots .pips{display:flex;gap:1.5px}
  .shots .pips i{width:4px;height:12px;border-radius:1px;background:var(--good);display:block}
  .shots .pips i.off{background:var(--surface-2)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .col{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px}
  .col h3{font-family:var(--mono);font-size:12px;text-transform:uppercase;letter-spacing:.1em;margin:0 0 14px}
  .col.good h3{color:var(--good)}
  .col.warn h3{color:var(--warn)}
  .col ul{list-style:none;margin:0;padding:0;display:grid;gap:11px}
  .col li{font-size:14px;padding-left:18px;position:relative}
  .col.good li::before{content:"+";position:absolute;left:0;color:var(--good);font-family:var(--mono);font-weight:700}
  .col.warn li::before{content:"–";position:absolute;left:0;color:var(--warn);font-family:var(--mono);font-weight:700}
  .cap-banner{display:flex;gap:16px;align-items:center;background:var(--warn-soft);border:1px solid #e0a83e40;border-radius:10px;padding:18px 20px;margin-bottom:22px}
  .cap-banner .num{font-family:var(--mono);font-size:32px;font-weight:700;color:var(--warn);line-height:1}
  .cap-banner p{margin:0;font-size:14px}
  .cap-banner p span{color:var(--muted)}
  .note-banner{background:var(--accent-soft);border:1px solid #5b8cff40;border-radius:10px;padding:16px 20px;margin-bottom:24px;font-size:13.5px}
  .note-banner b{color:var(--accent)}
  /* Data flow — deliberately bottom-to-top: the capture step is the anchor at
     the bottom of the rail, research and input build up above it. */
  .flow{position:relative;padding-left:36px;display:flex;flex-direction:column-reverse}
  .flow::before{content:"";position:absolute;left:13px;top:6px;bottom:6px;width:2px;background:linear-gradient(var(--line),var(--accent))}
  .fstep{position:relative;padding-bottom:22px}
  .fstep:first-child{padding-bottom:0}
  .fstep .dot{position:absolute;left:-36px;top:1px;width:28px;height:28px;border-radius:50%;background:var(--surface-2);border:1px solid var(--accent);color:var(--accent);font-family:var(--mono);font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
  .fstep b{display:block;font-size:14.5px;margin-bottom:3px}
  .fstep span{font-size:13.5px;color:var(--muted)}
  .flow-short{margin-top:24px;font-family:var(--mono);font-size:13px;color:var(--accent);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;white-space:nowrap}
  .flow-short span{color:var(--muted)}
  footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
  @media (max-width:900px){
    .shell{grid-template-columns:1fr}
    .rail{position:static;height:auto;flex-direction:column;border-right:none;border-bottom:1px solid var(--line);padding:24px 18px 14px;gap:18px}
    .nav{flex-direction:row;overflow-x:auto;gap:6px;padding-bottom:4px}
    .nav a{white-space:nowrap;padding:8px 12px}
    .nav a .n{display:none}
    .rail-foot{display:none}
    .main{padding:28px 18px 64px}
  }
  @media (max-width:620px){
    .stats,.stats.s3,.grid2{grid-template-columns:1fr}
    .brow{grid-template-columns:120px minmax(0,1fr) 52px}
  }
</style>
<div class="shell">
  <aside class="rail">
    <div class="brand">
      <span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i><b></b></span>
      <div class="brand-txt">
        <p class="kicker">KPMG · Pagesnapper<br>by FlowHunt</p>
        <p class="nm">Pagesnap Report</p>
      </div>
    </div>
    <nav class="nav" id="nav">
      <a href="#results" data-page="p-results"><span class="n">01</span>Test results</a>
      <a href="#capabilities" data-page="p-caps"><span class="n">02</span>Capabilities</a>
      <a href="#parameters" data-page="p-params"><span class="n">03</span>Parameters</a>
      <a href="#batch-capacity" data-page="p-cap"><span class="n">04</span>Batch capacity</a>
      <a href="#data-flow" data-page="p-flow"><span class="n">05</span>Data flow</a>
    </nav>
    <div class="rail-foot">
      <div class="cap">50 companies / batch</div>
      <div>${total} companies this run</div>
      <div>${stats.totalShots ?? ''} screenshots</div>
      <div style="margin-top:8px">${esc(dateStr)}${runLabel ? ' · ' + esc(runLabel) : ''}</div>
    </div>
  </aside>
  <main class="main">
    <section class="page" id="p-results">
      <div class="phead">
        <p class="eyebrow">01 / This run</p>
        <h1>Test results</h1>
        <p class="lead">${total} companies from this run, captured end to end. A company counts as captured here if pagesnap actually produced usable screenshots — not whether the agent labeled the row "Verified".</p>
      </div>
      <div class="stats s3" style="margin-bottom:28px">
        <div class="stat"><div class="num">${total}</div><div class="label">companies in this run</div></div>
        <button class="stat good" type="button" data-open="ok">
          <div class="num">${capturedPct.toFixed(1)}%</div>
          <div class="label">${ok.length} compan${ok.length === 1 ? 'y' : 'ies'} — usable content captured</div>
          <div class="open">See them <span class="arw">→</span></div>
        </button>
        <button class="stat critical" type="button" data-open="bad">
          <div class="num">${failedPct.toFixed(1)}%</div>
          <div class="label">${bad.length} compan${bad.length === 1 ? 'y' : 'ies'} — nothing captured</div>
          <div class="open">See them <span class="arw">→</span></div>
        </button>
      </div>
      <div class="propbar">
        <div class="track" role="img" aria-label="${ok.length} of ${total} companies captured, ${bad.length} of ${total} with nothing captured">
          <div class="seg good" style="width:${capturedPct}%"></div>
          <div class="seg critical" style="width:${failedPct}%"></div>
        </div>
        <div class="keys">
          <div class="key"><span class="sw good"></span><b>${ok.length}</b> <span class="muted">captured (${capturedPct.toFixed(1)}%)</span></div>
          <div class="key"><span class="sw critical"></span><b>${bad.length}</b> <span class="muted">nothing captured (${failedPct.toFixed(1)}%)</span></div>
        </div>
      </div>
      ${causeRows.length ? `<h3 class="rule">Why some captured nothing</h3>
      <div class="barchart">
        ${causeRows.map(([label, n]) => `<div class="brow">
          <div class="blabel">${esc(label)}</div>
          <div class="btrack"><div class="bfill" style="width:${(n / maxCause) * 100}%"></div></div>
          <div class="bval"><b>${n}</b>/${bad.length}</div>
        </div>`).join('')}
      </div>` : ''}
      <h3 class="rule" id="explorer">Every company, one by one</h3>
      <div class="exp-controls">
        <button class="seg-btn" data-m="ok" aria-pressed="true" type="button">Captured <span class="cnt">${ok.length}</span></button>
        <button class="seg-btn" data-m="bad" aria-pressed="false" type="button">Nothing captured <span class="cnt">${bad.length}</span></button>
      </div>
      <div class="tblwrap">
        <table class="co" id="coTable"><thead id="coHead"></thead><tbody id="coBody"></tbody></table>
      </div>
      <footer><span>Pagesnap Report · this run's actual results</span><span>01 / 05 · ${total} companies</span></footer>
    </section>

    <section class="page" id="p-caps" hidden>
      <div class="phead">
        <p class="eyebrow">02 / What it does</p>
        <h1>Capabilities</h1>
        <p class="lead">Pagesnap takes a list of companies and returns a finished screenshot package: homepage, about-us and product pages for every company, plus a business summary from the FlowHunt agent.</p>
      </div>
      <ul class="caps">
        <li><span class="tick">✓</span><p><b>Full-page screenshots</b> from a plain URL — clean, even on pages a normal tool would return broken or blank.</p></li>
        <li><span class="tick">✓</span><p><b>Waits for the page to actually finish</b> — fonts, lazy-loaded images, animations settled, cookie banner dismissed — before it shoots.</p></li>
        <li><span class="tick">✓</span><p><b>Slices and stitches long pages</b> instead of one giant shot — Chromium silently returns blank bands past ~16,000px in a single capture; this never does.</p></li>
        <li><span class="tick">✓</span><p><b>Runs as a batch</b> — upload a CSV or Excel file of companies, and for each one it finds the homepage, About Us, and product pages on its own.</p></li>
        <li><span class="tick">✓</span><p><b>Lives on the server, not the tab</b> — close it, reload, come back an hour later, the run is exactly where it left off.</p></li>
        <li><span class="tick">✓</span><p><b>Re-runs selectively</b> — the whole list, just the unfinished rows, or one company on its own.</p></li>
        <li><span class="tick">✓</span><p><b>Ships a finished package</b> — <code>results.xlsx</code>, this report, and a zip of every screenshot, all in one download.</p></li>
        <li><span class="tick">✓</span><p><b>Reports problems honestly</b> — a blocked site or a timeout shows up as a clear warning, never a silent gap or a faked success.</p></li>
        <li><span class="tick">✓</span><p><b>Detects the site's own language</b> — a Hungarian company no longer comes back as a mix of English and Hungarian pages.</p></li>
      </ul>
      <footer><span>Pagesnap Report</span><span>02 / 05 · Capabilities</span></footer>
    </section>

    <section class="page" id="p-params" hidden>
      <div class="phead">
        <p class="eyebrow">03 / Numbers to know</p>
        <h1>Parameters</h1>
        <p class="lead">The settings that shape every export. Both are configurable — these are the values this run used.</p>
      </div>
      <div class="stats" style="margin-bottom:28px">
        <div class="stat"><div class="num">6</div><div class="label">product pages captured per company, fixed — every export is shaped the same way</div></div>
        <div class="stat"><div class="num">1–10</div><div class="label">companies processed in parallel per run, adjustable per batch</div></div>
      </div>
      <h3 class="rule">What each company produces</h3>
      <ul class="caps">
        <li><span class="tick">1</span><p><b>Homepage</b> — the anchor shot; a company counts as captured only when real content came back.</p></li>
        <li><span class="tick">1</span><p><b>About Us</b> — found by the agent, not guessed from a URL pattern.</p></li>
        <li><span class="tick">1</span><p><b>Services</b> — captured where the site has one.</p></li>
        <li><span class="tick">6</span><p><b>Product pages</b> — up to six, so every row in the export lines up.</p></li>
      </ul>
      <footer><span>Pagesnap Report</span><span>03 / 05 · Parameters</span></footer>
    </section>

    <section class="page" id="p-cap" hidden>
      <div class="phead">
        <p class="eyebrow">04 / Scope</p>
        <h1>Batch capacity</h1>
        <p class="lead">How many companies one run takes today, and what that ceiling is actually for.</p>
      </div>
      <div class="cap-banner">
        <div class="num">50</div>
        <p>companies per run, right now. <span>Not the final shape of the tool — a deliberate, temporary ceiling.</span></p>
      </div>
      <div class="grid2" style="margin-bottom:28px">
        <div class="col good">
          <h3>Why it's there</h3>
          <ul>
            <li>Set as a safety margin from early load testing — a full run at 50 companies goes through cleanly every time.</li>
            <li>Enforced twice — a clear message the moment the list loads in the UI, and a second check on the server that can't be bypassed.</li>
            <li>Not hardcoded forever — easy to raise through configuration once a higher volume is verified safe.</li>
          </ul>
        </div>
        <div class="col warn">
          <h3>What it costs</h3>
          <ul>
            <li>A list of 100+ companies has to be split into multiple 50-company runs by hand — no auto-chunking yet.</li>
            <li>50 is a cautious number from load testing, not a precisely measured ceiling — the real limit may be higher.</li>
          </ul>
        </div>
      </div>
      <h3 class="rule">Accepted input</h3>
      <ul class="caps">
        <li><span class="tick">✓</span><p><b>CSV</b> — one company per line, name and/or website.</p></li>
        <li><span class="tick">✓</span><p><b>Excel (.xlsx)</b> — converted to CSV automatically on upload; the first sheet is read, hyperlinked cells included.</p></li>
        <li><span class="tick">✓</span><p><b>Extra columns are welcome</b> — country, VAT, internal ID. The whole row goes to the agent to help it pick the right company.</p></li>
      </ul>
      <footer><span>Pagesnap Report</span><span>04 / 05 · Batch capacity</span></footer>
    </section>

    <section class="page" id="p-flow" hidden>
      <div class="phead">
        <p class="eyebrow">05 / Architecture</p>
        <h1>Data flow</h1>
        <p class="lead">Read bottom to top: the company list goes in at the bottom, screenshots and the export come out at the top. Two systems are involved: pagesnap does the capturing, the FlowHunt agent does the research.</p>
      </div>
      <div class="flow">
        <div class="fstep"><span class="dot">1</span><b>The company list goes into pagesnap</b><span>CSV parsed in the browser, Excel converted on the server first. Nothing sent onward yet.</span></div>
        <div class="fstep"><span class="dot">2</span><b>Pagesnap calls the FlowHunt agent</b><span>Per company: finds the homepage, About Us, and product pages; writes a business summary.</span></div>
        <div class="fstep"><span class="dot">3</span><b>The agent's answer comes back</b><span>A list of exact URLs to capture for that company, plus its own status verdict.</span></div>
        <div class="fstep"><span class="dot">4</span><b>Pagesnap takes the screenshots</b><span>Its own Playwright browser — homepage, about-us, services, up to 6 product pages.</span></div>
        <div class="fstep"><span class="dot">5</span><b>The result is assembled</b><span>A live status table, then <code>results.xlsx</code> + this report + a zip, ready to download.</span></div>
      </div>
      <div class="flow-short">export <span>←</span> screenshots <span>←</span> pagesnap <span>←</span> FlowHunt agent <span>←</span> pagesnap <span>←</span> list</div>
      <footer><span>Pagesnap Report</span><span>05 / 05 · Data flow</span></footer>
    </section>
  </main>
</div>
<script>
const DATA = ${dataJson};
const pages = Array.from(document.querySelectorAll('.page'));
const links = Array.from(document.querySelectorAll('#nav a'));
const byHash = {};
links.forEach((a) => { byHash[a.getAttribute('href').slice(1)] = a.dataset.page; });
function show(hash) {
  const id = byHash[hash] || pages[0].id;
  pages.forEach((p) => { p.hidden = p.id !== id; });
  links.forEach((a) => a.classList.toggle('on', a.dataset.page === id));
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));

const STATUS_CLASS = { Verified: 'v', Unverified: 'u', Failed: 'f' };
const HEADS = {
  ok: '<tr><th>Website</th><th>Agent status</th><th>Pages</th><th>What the business does</th></tr>',
  bad: '<tr><th>Website</th><th>Agent status</th><th>Cause</th><th>What happened</th></tr>',
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let mode = 'ok';
const body = document.getElementById('coBody');
const head = document.getElementById('coHead');
function pips(n) {
  let out = '';
  for (let i = 0; i < 9; i++) out += '<i' + (i < n ? '' : ' class="off"') + '></i>';
  return '<span class="shots"><span class="pips">' + out + '</span>' + n + '</span>';
}
function render() {
  const rows = mode === 'ok' ? DATA.ok : DATA.bad;
  head.innerHTML = HEADS[mode];
  body.innerHTML = rows.map((r) => {
    const site = '<td class="site">' + esc(r.d) + '</td>';
    const status = '<td><span class="tag ' + (STATUS_CLASS[r.s] || 'u') + '">' + esc(r.s || 'Unknown') + '</span></td>';
    if (mode === 'ok') {
      return '<tr>' + site + status + '<td class="mid">' + pips(r.k) + '</td><td class="dim">' + esc(r.t) + '</td></tr>';
    }
    const cls = r.c === 'Blocked' ? 'block' : 'other';
    return '<tr>' + site + status + '<td><span class="tag ' + cls + '">' + esc(r.c) + '</span></td><td class="dim">' + esc(r.x) + '</td></tr>';
  }).join('');
}
function setMode(m) {
  mode = m;
  document.querySelectorAll('.seg-btn').forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.m === m)));
  render();
}
document.querySelectorAll('.seg-btn').forEach((b) => { b.addEventListener('click', () => setMode(b.dataset.m)); });
document.querySelectorAll('[data-open]').forEach((b) => {
  b.addEventListener('click', () => {
    setMode(b.dataset.open);
    location.hash = '#results';
    const anchor = document.getElementById('explorer');
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
render();
</script>
</body></html>`;
}
