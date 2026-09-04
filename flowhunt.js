/* Thin wrapper around FlowHunt's REST API (api.flowhunt.io).
 *
 * There is no official Node/JS SDK — only Python (flowhunt-python-sdk) and PHP.
 * These calls are hand-rolled HTTP requests based on the Python SDK's
 * generated client, since FlowHunt's public docs don't spell out the raw REST
 * shape.
 *
 * The auth header was confirmed against a real account: an API key from
 * workspace settings goes in `Api-Key`, not `Authorization: Bearer` (see
 * authHeaders below). Still unconfirmed and the first place to look if a call
 * misbehaves once a flow actually runs:
 *
 *   - Poll-completion detection — `status` is read as a loose string match
 *     for "success"/"complete"/"done" vs "fail"/"error", since the exact
 *     TaskStatus enum values aren't documented anywhere I could find.
 *
 * Everything else (endpoint paths, request/response field names) comes
 * directly from the SDK's generated API classes.
 */

const BASE = 'https://api.flowhunt.io';

/* FlowHunt accepts two auth schemes (both are listed on every endpoint in its
   OpenAPI spec): "APIKeyHeader" and "HTTPBearer". An API key created in
   workspace settings goes in the APIKeyHeader one, whose literal header name
   is `Api-Key` — confirmed from the Python SDK's own auth_settings(). Sending
   it as `Authorization: Bearer` instead returns
   401 {"error_code":401,"message":"Authentication required"}; the Bearer
   scheme is for OAuth-style access tokens, not for these keys. */
function authHeaders(apiKey) {
  return {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

async function asError(res) {
  const body = await res.text().catch(() => '');
  return new Error(`FlowHunt HTTP ${res.status}${body ? ` — ${body.slice(0, 300)}` : ''}`);
}

/** Lists flows available to this API key, for a picker in the UI. */
export async function listFlows(apiKey, { workspaceId } = {}) {
  const url = new URL('/v2/flows/', BASE);
  if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({}),
  });
  if (!res.ok) throw await asError(res);
  const data = await res.json();
  // The SDK's FlowResponse list — normalise to {id, name} in case the field
  // names differ slightly from what's assumed here.
  const flows = Array.isArray(data) ? data : data.flows || data.items || [];
  return flows.map((f) => ({
    id: f.id || f.flow_id,
    name: f.name || f.title || f.id || f.flow_id,
  }));
}

/** Starts a flow run. FlowHunt's invoke is asynchronous — it returns a task
 *  that may already be finished (small/fast flows) or may need polling. */
export async function invokeFlow(apiKey, flowId, humanInput, { workspaceId } = {}) {
  const url = new URL(`/v2/flows/${encodeURIComponent(flowId)}/invoke`, BASE);
  if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify({ human_input: humanInput }),
  });
  if (!res.ok) throw await asError(res);
  return res.json(); // { id, status, result, error_message }
}

/** Polls a flow task until it finishes, fails, or times out. */
/* 5 minutes, not 2. One company took ~40s in testing, but the agent does a
   Google search, fetches several pages and then summarises them, so a slow or
   large site can run well past two minutes. On a 181-company batch a timeout
   that is merely "usually enough" turns into a handful of lost rows, and
   waiting longer costs nothing when the flow is quick. */
export async function pollTask(apiKey, flowId, taskId, { workspaceId, timeoutMs = 300000, intervalMs = 1500 } = {}) {
  const url = new URL(`/v2/flows/${encodeURIComponent(flowId)}/${encodeURIComponent(taskId)}`, BASE);
  if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: authHeaders(apiKey) });
    if (!res.ok) throw await asError(res);
    const task = await res.json();
    const status = String(task.status || '').toLowerCase();
    if (status.includes('success') || status.includes('complete') || status.includes('done')) return task;
    if (status.includes('fail') || status.includes('error')) {
      throw new Error(`FlowHunt task failed: ${task.error_message || status}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`FlowHunt task ${taskId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
}

/** Runs a flow for one input to completion and returns its raw `result`. */
export async function runFlow(apiKey, flowId, humanInput, opts = {}) {
  const task = await invokeFlow(apiKey, flowId, humanInput, opts);
  const status = String(task.status || '').toLowerCase();
  if (task.result !== undefined && task.result !== null && (!status || status.includes('success') || status.includes('complete'))) {
    return task.result; // already finished synchronously
  }
  const finished = await pollTask(apiKey, flowId, task.id, opts);
  return finished.result;
}

/** The flow's output shape isn't fixed by FlowHunt — it's whatever text the
 *  flow itself produces. The "Screenshoting pages" agent returns a structured
 *  summary ending in a urls list (homepage / about us / services), written as
 *  prose-with-markdown, so the text scan below is the path that actually runs.
 *  A JSON array is still handled first in case a flow returns one. */
export function extractUrls(result) {
  /* Trailing characters a URL picks up from the text around it, none of which
     can end a real URL:
       . , ; : ! ? )  — sentence and list punctuation ("see https://x.com.")
       \              — markdown escaping. The agent writes URLs inside a
                        markdown list and escapes them, so its output contains
                        "https://www.flowhunt.io/\". Left in place this is
                        genuinely dangerous rather than merely untidy: the URL
                        parser silently rewrites a backslash to a forward
                        slash, turning that into "https://www.flowhunt.io//",
                        which 404s on most servers — so every capture fails
                        with an error that looks like the site's fault. */
  const clean = (u) => String(u).trim().replace(/[.,;:!?)\\]+$/, '');
  const uniq = (list) => [...new Set(list.map(clean).filter(Boolean))];

  if (Array.isArray(result)) return uniq(result.filter((u) => typeof u === 'string'));
  const text = String(result ?? '');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return uniq(parsed.filter((u) => typeof u === 'string'));
  } catch { /* not JSON — fall through to text scanning */ }
  // Backslash is excluded from the match itself too, so an escaped URL ends at
  // the escape rather than swallowing it and whatever follows.
  const matches = text.match(/https?:\/\/[^\s,"'\]\)\\]+/g) || [];
  return uniq(matches);
}

/* Reads a genuinely structured reply — an object, or a JSON string — rather
   than guessing at prose. Returns null when the input isn't structured (or
   carries none of the fields we need), so the caller falls back to the text
   parser. Field names are matched loosely because nothing here is contractual
   yet: FlowHunt may name them status/status_code, reasoning/summary, and the
   urls may be an object keyed by page or a plain ordered array. */
/* Did unwrapping actually reach the agent's answer, or just another wrapper? */
const hasContent = (r) => !!(r && (r.urls.homepage || r.urls.aboutUs || r.urls.services || r.reasoning));

function readStructured(result) {
  let obj = result;
  if (typeof result === 'string') {
    const s = result.trim();
    // Both shapes appear: an object envelope, and a bare array of results.
    if (!s.startsWith('{') && !s.startsWith('[')) return null;
    try { obj = JSON.parse(s); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  /* A bare array — the agent's own reply is `[ { status_code, reasoning, … } ]`.
     Take the first element that actually carries an answer. */
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item == null || item === '') continue;
      const got = parseAgentResult(item);
      if (hasContent(got)) return got;
    }
    return null;
  }

  /* FlowHunt wraps the agent's answer several layers deep. The real shape, from
     a live run, is:
         { "outputs": [ "[\n  {\n  \"status_code\": …  }\n]" ] }
     — an object, holding an ARRAY, holding a STRING, holding JSON, holding an
     array, holding the object we actually want. An envelope's own `status`
     describes whether the task ran, not whether the business was verified, so
     taking it at face value produced eight rows reading "success" with every
     column empty. Unwrap anything that looks like a payload, arrays included
     (an earlier version skipped arrays and so never got past `outputs`), and
     only accept the result if it genuinely carries an answer. */
  const NESTED = ['result', 'results', 'output', 'outputs', 'message', 'content', 'text', 'answer', 'response', 'data', 'human_output', 'human_input'];
  for (const key of Object.keys(obj)) {
    if (!NESTED.includes(key.toLowerCase())) continue;
    const inner = obj[key];
    if (inner == null || inner === '') continue;
    for (const candidate of (Array.isArray(inner) ? inner : [inner])) {
      if (candidate == null || candidate === '') continue;
      if (typeof candidate !== 'string' && typeof candidate !== 'object') continue;
      const got = parseAgentResult(candidate);
      if (hasContent(got)) return got;
    }
  }

  /* An empty value is the single most useful thing this diagnostic can show, so
     render it as a visible marker rather than as nothing after the "=". */
  const describeFields = (source) => {
    if (!source || typeof source !== 'object') return [];
    return Object.entries(source).map(([k, v]) => {
      if (/reason|summar|descript|analys/i.test(k)) return `${k}=<${String(v ?? '').length} chars of prose>`;
      if (v == null || v === '') return `${k}=<empty>`;
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k}=${s.length > 70 ? s.slice(0, 70) + '…' : s}`;
    });
  };

  const get = (...names) => {
    for (const n of names) {
      const hit = Object.keys(obj).find((k) => k.toLowerCase().replace(/[_\s-]/g, '') === n);
      if (hit && obj[hit] != null && obj[hit] !== '') return obj[hit];
    }
    return '';
  };

  /* Match a key by what it MEANS, not by an exact spelling. The agent names
     these fields differently from run to run — homepage_url, about_us_page_url,
     services_page_url, url_of_services_page — and an exact-match list silently
     misses anything not on it. That is not a harmless miss: a live run returned
     "pages found: homepage" only, because "homepageurl" happened to be in the
     list while "aboutuspageurl" was not, so two real pages were dropped and the
     spreadsheet looked like the sites had no About or Services page.
     Substring matching on the normalised key is both shorter and safer here —
     the three concepts don't overlap, and homepage is tested first so a key
     like "homepage_url" can never be mistaken for the services one. */
  const norm = (k) => k.toLowerCase().replace(/[^a-z]/g, '');
  /* Returns EVERY url in the matched field, not just the first. The agent
     sometimes lists several in one value — a live run sent
     "services_page_url": "https://ag-motors.pl/?lang=en#offer_b2b | https://…"
     — and the first one happened to be the homepage with a fragment on it, so
     taking only the first meant screenshotting the homepage twice and never
     reaching the real services page. The caller walks the list and takes the
     first that isn't already captured. */
  const bySense = (source, test) => {
    if (!source || typeof source !== 'object') return [];
    const hit = Object.keys(source).find((k) => test(norm(k)));
    if (!hit) return [];
    const v = source[hit];
    if (typeof v !== 'string') return [];
    return extractUrls(v);
  };

  /* When a url field holds no url, it usually holds the agent's explanation.
     Its prompt tells it to write things like "not available", "failed to
     capture" or "failed to capture — certificate error" in that field, and a
     certificate error is worth surfacing to whoever reviews the spreadsheet:
     it says the site exists but could not be read, which is a different
     problem from a company having no About page. Previously all of these were
     discarded as "no url" and the distinction was lost. */
  const noteFor = (source, test) => {
    if (!source || typeof source !== 'object') return '';
    const hit = Object.keys(source).find((k) => test(norm(k)));
    if (!hit) return '';
    const v = source[hit];
    if (typeof v !== 'string' || !v.trim()) return '';
    if (extractUrls(v).length) return '';          // it was a url after all
    if (/^(not available|none|n\/a|-)$/i.test(v.trim())) return '';  // plain absence, not a problem
    return v.trim().slice(0, 120);
  };
  const IS_HOME = (k) => k.includes('homepage') || k === 'home' || k === 'homeurl';
  const IS_ABOUT = (k) => k.includes('about') || k.includes('chisiamo') || k.includes('uberuns');
  const IS_SERVICES = (k) => k.includes('service') || k.includes('product') || k.includes('shop')
    || k.includes('catalog') || k.includes('solution') || k.includes('offering') || k.includes('prodotti');

  const rawUrls = get('urls', 'url', 'links', 'pages');
  let homepageList = [], aboutUsList = [], servicesList = [];
  if (Array.isArray(rawUrls)) {
    const [h = '', a = '', s = ''] = extractUrls(rawUrls);
    homepageList = h ? [h] : [];
    aboutUsList = a ? [a] : [];
    servicesList = s ? [s] : [];
  } else {
    // Nested under "urls", or flat alongside status/reasoning.
    const source = (rawUrls && typeof rawUrls === 'object') ? rawUrls : obj;
    homepageList = bySense(source, IS_HOME);
    aboutUsList = bySense(source, IS_ABOUT);
    servicesList = bySense(source, IS_SERVICES);
  }
  const homepage = homepageList[0] || '';
  const aboutUs = aboutUsList[0] || '';
  const services = servicesList[0] || '';

  const noteSource = (rawUrls && typeof rawUrls === 'object' && !Array.isArray(rawUrls)) ? rawUrls : obj;
  const urlNotes = {
    homepage: homepage ? '' : noteFor(noteSource, IS_HOME),
    aboutUs: aboutUs ? '' : noteFor(noteSource, IS_ABOUT),
    services: services ? '' : noteFor(noteSource, IS_SERVICES),
  };

  const statusRaw = String(get('statuscode', 'status') || '');
  /* Prefer a field that is actually a business summary over the agent's
     reasoning. Today the flow ships only "reasoning" — which exists to justify
     the Verified/Unverified verdict, not to describe the business — and we
     have been putting that in KPMG's business_summarization column for want of
     anything better. The moment the flow gains a real summary field this picks
     it up with no change here; until then the fallback keeps the column
     populated. Order matters: most specific first. */
  const reasoningRaw = String(
    get('businesssummarization', 'businesssummary', 'summary', 'businessdescription', 'description', 'reasoning') || ''
  );

  /* A status on its own is NOT enough to claim this object as the agent's
     answer — that is precisely what an envelope looks like. Require some
     actual content (a URL or the summary), otherwise hand back null so the
     text parser gets its turn. Getting this wrong silently empties every
     column while still looking like a successful run. */
  if (!homepage && !aboutUs && !services && !reasoningRaw) return null;

  const status = /unverified/i.test(statusRaw) ? 'Unverified'
    : /verified/i.test(statusRaw) ? 'Verified'
    : /fail/i.test(statusRaw) ? 'Failed'
    : statusRaw;

  return {
    status,
    businessType: String(get('businesstypeclassification', 'businesstype') || ''),
    reasoning: reasoningRaw,
    urls: { homepage, aboutUs, services },
    /* Every url the agent offered per page, in the order it listed them. The
       caller falls back down this list when the first one turns out to be a
       page it has already captured. */
    urlOptions: { homepage: homepageList, aboutUs: aboutUsList, services: servicesList },
    /* What the agent wrote in a url field when it wasn't a url — its own
       explanation of why that page is missing, e.g. a certificate error. */
    urlNotes,
    allUrls: [homepage, aboutUs, services].filter(Boolean),
    /* The field names the agent actually used, and their values. Without this
       there is no way to tell "the agent reported no About page" apart from
       "the agent reported one and we failed to match its key" — the log looks
       identical either way, and the second is a bug while the first is normal.
       Logged by the caller whenever fewer than three pages come back.

       The flat-object case used to print bare key NAMES, which defeated the
       whole point: a live run showed "aboutus_page_url" in this list with no
       About screenshot, and there was no way to tell whether the agent had sent
       an empty value or we had failed to read a real one. Print values in both
       shapes; skip the prose fields, which are hundreds of characters of
       summary and would bury the URLs they sit next to. */
    sourceKeys: describeFields(
      (rawUrls && typeof rawUrls === 'object' && !Array.isArray(rawUrls)) ? rawUrls : obj
    ),
    raw: typeof result === 'string' ? result : JSON.stringify(result),
  };
}

/* The agent's reply is a fixed structure (see its system message): a status
 * code, a business type, a multi-sentence summary under "Reasoning", then a
 * urls list in a fixed order — homepage, about us, services/products. KPMG's
 * requested output needs each of those in its own spreadsheet column, and each
 * screenshot filed under the page it came from, so a flat list of URLs isn't
 * enough any more.
 *
 * Everything here is best-effort: a heading may be missing, a page may be
 * "not available", the model may reword a label. Nothing throws — a field that
 * can't be found comes back empty and the caller decides what that means.
 */
export function parseAgentResult(result) {
  /* If the flow ever returns real structured data rather than prose — which is
     the direction FlowHunt's own "Batch Structured Output" component points —
     read the fields directly. Falling through to the text parser would be
     actively wrong here: JSON.stringify puts the whole object on one line, so
     every label ("about", "services") matches that same line and each column
     ends up holding the first URL in the object. */
  const structured = readStructured(result);
  if (structured) return structured;

  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');

  /* Headings arrive as "**Status Code**: x", "Status Code: x", or "- status: x"
     depending on how the model formats that run, so match the label loosely and
     take the rest of the line. */
  const field = (label) => {
    const re = new RegExp(`^[\\s*\\-#>]*\\**\\s*${label}\\s*\\**\\s*[:\\-]\\s*(.+)$`, 'im');
    const m = text.match(re);
    return m ? m[1].replace(/\*+/g, '').trim() : '';
  };

  const statusRaw = field('status[ _]?code') || field('status');
  const status = /verified/i.test(statusRaw) && !/unverified/i.test(statusRaw) ? 'Verified'
    : /unverified/i.test(statusRaw) ? 'Unverified'
    : /fail/i.test(statusRaw) ? 'Failed'
    : statusRaw;

  /* The summary runs for several sentences and ends where the urls list starts,
     so take everything between the two headings rather than a single line. */
  let reasoning = '';
  /* End the block at the next heading or at end-of-input. JS has no \z, and
     using it literally matches the letter "z" — which silently cut the summary
     off at the first word containing one ("Organi|zation"). */
  const reasoningBlock = text.match(
    /^[\s*\-#>]*\**\s*(?:reasoning|business[_ ]summari[sz]ation|summary)\s*\**\s*[:\-]\s*([\s\S]*?)(?=^[\s*\-#>]*\**\s*(?:urls?|status|business[_ ]type)\b|(?![\s\S]))/im
  );
  if (reasoningBlock) reasoning = reasoningBlock[1].replace(/\*+/g, '').trim();
  if (!reasoning) reasoning = field('reasoning');

  /* Positional fallback must only ever consider URLs from the urls section, not
     the whole reply. The summary often cites a source ("According to
     https://news-site.com/article, the firm expanded…"), and taking URLs
     document-wide made that citation the first URL — so the homepage column
     pointed at a news article and we screenshotted the wrong site entirely.
     Nothing in the output looked broken, which is what made it dangerous.
     When there is no urls heading, the whole reply is the only thing to go on. */
  const urlSection = text.match(
    /^[\s*\-#>]*\**\s*urls?\s*\**\s*[:\-]?\s*([\s\S]*)$/im
  );
  const urls = extractUrls(urlSection ? urlSection[1] : text);

  /* Prefer matching a URL to its page by the words around it — the model labels
     them ("about us page URL: ..."), and that survives a missing entry, which
     position alone does not: if a site has no About page, the services URL
     would otherwise silently land in the about_us column. Position is the
     fallback, in the order the system message specifies. */
  /* Returns the URL belonging to a label, '' if the label is present but names
     no URL ("about us page URL: not available"), or null if the label is absent
     entirely. That three-way distinction matters: an explicit "not available"
     is an answer and must NOT fall through to the positional guess, or a site
     with no About page gets its services URL filed under about_us — data that
     looks real and is wrong.

     Works by POSITION, not by line. An earlier version scanned line by line,
     which quietly collapsed when the agent returned its whole reply on a single
     line: every label then matched that same line and each page got the first
     URL on it, so homepage, aboutus and product were all the homepage. Three
     identical screenshots per company, and a spreadsheet that looked complete.
     Searching from each label up to the next one is immune to how the reply
     happens to be wrapped. */
  const LABELS = [
    { key: 'homepage', re: /home\s*[-_ ]?page|homepage/gi },
    { key: 'aboutUs', re: /about\s*[-_ ]?us|\babout\b|chi\s+siamo|über\s+uns|o\s+n[aá]s/gi },
    { key: 'services', re: /\bservices?\b|\bproducts?\b|goods|shop|catalog|solutions|offerings|prodotti|dienstleistungen/gi },
  ];

  /* Search for labels in a copy where every URL has been blanked out, keeping
     the original offsets. URLs routinely contain the very words we are looking
     for — https://a.com/about/ has "about" in it, /shop/ has "shop" — and
     matching those turns a URL into its own label, which then steals the next
     page's link. Blanking them means only real prose labels count, while the
     slices below still read from the untouched text. */
  const masked = text.replace(/https?:\/\/[^\s,"'\]\)\\]+/g, (m) => ' '.repeat(m.length));

  // Where each label first appears, so we can bound one label's text at the next.
  const positions = LABELS.map(({ key, re }) => {
    re.lastIndex = 0;
    const m = re.exec(masked);
    return { key, at: m ? m.index : -1 };
  });
  const found = positions.filter((p) => p.at >= 0).sort((a, b) => a.at - b.at);

  const near = (key) => {
    const idx = found.findIndex((p) => p.key === key);
    if (idx === -1) return null;                       // label absent entirely
    const start = found[idx].at;
    const end = idx + 1 < found.length ? found[idx + 1].at : text.length;
    const [url] = extractUrls(text.slice(start, end)); // first URL after this label
    return url || '';                                  // present but no URL -> ''
  };

  const pick = (labelled, positional) => (labelled === null ? (positional || '') : labelled);

  const homepage = pick(near('homepage'), urls[0]);
  const aboutUs = pick(near('aboutUs'), urls[1] !== homepage ? urls[1] : '');
  const services = pick(
    near('services'),
    urls.find((u) => u !== homepage && u !== aboutUs)
  );

  return {
    status,
    businessType: field('business[_ ]type[_ ]classification') || field('business[_ ]type'),
    reasoning,
    urls: { homepage, aboutUs, services },
    allUrls: urls,
    raw: text,
  };
}
