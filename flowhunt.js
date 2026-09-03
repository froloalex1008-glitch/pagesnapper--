/* Thin wrapper around FlowHunt's REST API (api.flowhunt.io).
 *
 * There is no official Node/JS SDK — only Python (flowhunt-python-sdk) and PHP.
 * These calls are hand-rolled HTTP requests reverse-engineered from the Python
 * SDK's generated client, since FlowHunt's public docs don't spell out the raw
 * REST shape. That means two things here are informed guesses, not confirmed
 * facts, and are exactly where to look first if a call comes back 401 or 404
 * once tested against a real account:
 *
 *   1. Auth header — using `Authorization: Bearer <key>`, which matches the
 *      SDK's `access_token` config option. If that 401s, the key may instead
 *      need to go in a custom header (the SDK also supports an "APIKeyHeader"
 *      scheme whose exact header name wasn't recoverable from the source).
 *   2. Poll-completion detection — `status` is read as a loose string match
 *      for "success"/"complete"/"done" vs "fail"/"error", since the exact
 *      TaskStatus enum values aren't documented anywhere I could find.
 *
 * Everything else (endpoint paths, request/response field names) comes
 * directly from the SDK's generated API classes.
 */

const BASE = 'https://api.flowhunt.io';

function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
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
 *  flow itself produces. Tries a JSON array first, then falls back to
 *  scanning free text for anything URL-shaped (one per line, comma-separated,
 *  or embedded in prose) — whichever "Screenshoting pages" flow actually
 *  returns, this should recover the list either way. */
export function extractUrls(result) {
  if (Array.isArray(result)) return [...new Set(result.filter((u) => typeof u === 'string'))];
  const text = String(result ?? '');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return [...new Set(parsed.filter((u) => typeof u === 'string'))];
  } catch { /* not JSON — fall through to text scanning */ }
  const matches = text.match(/https?:\/\/[^\s,"'\]\)]+/g) || [];
  // Strip trailing sentence/list punctuation a URL embedded in prose can pick
  // up ("see https://example.com." or "https://example.com,") — the URL
  // itself basically never ends in one of these characters.
  const cleaned = matches.map((u) => u.replace(/[.,;:!?)]+$/, ''));
  return [...new Set(cleaned)];
}
