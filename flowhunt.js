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
export async function pollTask(apiKey, flowId, taskId, { workspaceId, timeoutMs = 120000, intervalMs = 1500 } = {}) {
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
