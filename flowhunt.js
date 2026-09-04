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

  const urls = extractUrls(text);

  /* Prefer matching a URL to its page by the words around it — the model labels
     them ("about us page URL: ..."), and that survives a missing entry, which
     position alone does not: if a site has no About page, the services URL
     would otherwise silently land in the about_us column. Position is the
     fallback, in the order the system message specifies. */
  /* Returns the URL on the labelled line, '' if that line exists but names no
     URL ("about us page URL: not available"), or null if no such line at all.
     The distinction matters: an explicit "not available" is an answer, and must
     NOT fall through to the positional guess — otherwise a site with no About
     page gets its services URL filed under about_us, which looks like real data
     and is wrong. Only a genuinely absent label falls back to position. */
  const near = (labels) => {
    let sawLabel = false;
    for (const line of text.split(/\r?\n/)) {
      if (!labels.test(line)) continue;
      sawLabel = true;
      const found = extractUrls(line);
      if (found.length) return found[0];
    }
    return sawLabel ? '' : null;
  };

  const pick = (labelled, positional) => (labelled === null ? (positional || '') : labelled);

  const homepage = pick(near(/home\s*page|homepage/i), urls[0]);
  const aboutUs = pick(
    near(/about\s*[-_ ]?us|about\b/i),
    urls[1] !== homepage ? urls[1] : ''
  );
  const services = pick(
    near(/services?|products?|goods|shop|catalog|solutions|offerings/i),
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
