// Turns a claude.ai /usage payload into weekly series samples.
// Shape (per claude-monitor source, 2026-09): limits[] = { kind, percent, resets_at, scope }
// kind: "session" | "weekly_all" | "weekly_scoped"; scoped entries carry scope.model.display_name.
// Older accounts only have flat buckets: seven_day, seven_day_opus, seven_day_sonnet.

function parseWeeklyUsage(usage) {
  const out = {};
  const add = (name, pct, reset) => {
    const p = Number(pct);
    if (pct === null || pct === undefined || !Number.isFinite(p) || !reset) return;
    const r = Date.parse(reset);
    if (!Number.isFinite(r)) return;
    out[name] = { pct: Math.max(0, p), reset: r };
  };

  if (Array.isArray(usage?.limits)) {
    for (const l of usage.limits) {
      if (!l || typeof l !== 'object') continue;
      if (l.kind === 'weekly_all') add('All models', l.percent, l.resets_at);
      else if (l.kind === 'weekly_scoped') {
        const name = l.scope?.model?.display_name;
        if (name) add(String(name), l.percent, l.resets_at);
      }
    }
  }

  const flat = { 'All models': usage?.seven_day, Opus: usage?.seven_day_opus, Sonnet: usage?.seven_day_sonnet };
  for (const [name, b] of Object.entries(flat)) {
    if (!out[name] && b) add(name, b.utilization, b.resets_at);
  }
  return out;
}

// Monthly $ spend limit, for accounts without weekly limits (e.g. Enterprise seats with a spend cap).
// usage.extra_usage = { is_enabled, used_credits, monthly_limit, currency }, amounts in cents (per the
// claude-monitor extension's source). The payload has no period timestamps; claude-monitor notes the limit
// resets on the 1st of next month, so the period is taken as the calendar month in UTC.
function parseMonthlySpend(usage, now) {
  const x = usage?.extra_usage;
  if (!x || x.used_credits == null || x.monthly_limit == null) return null;
  const used = Number(x.used_credits) / 100;
  const limit = Number(x.monthly_limit) / 100;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0 || used < 0) return null;
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return {
    pct: used / limit * 100, used, limit, start, reset,
    currency: typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency) ? x.currency : 'USD',
  };
}

// The signed-in person's name from GET /api/account: "What should Claude call you?" (display_name), else the full
// name, else the email. Field names are not confirmed against a live response; every one is optional.
// orgIds = the orgs this account belongs to (memberships), empty when the payload has none.
function accountLabel(account) {
  const pick = v => (typeof v === 'string' ? v.trim() : '');
  const name = pick(account?.display_name) || pick(account?.full_name) || pick(account?.email_address) || pick(account?.email);
  const orgIds = (Array.isArray(account?.memberships) ? account.memberships : [])
    .map(m => m?.organization?.uuid).filter(id => typeof id === 'string');
  return name ? { name: name.slice(0, 60), orgIds } : null;
}

// Plan label from an /api/organizations entry: rate_limit_tier (e.g. "default_claude_max_20x") and capabilities
// (e.g. ["chat", "claude_max"]). Mapping follows the claude-monitor extension's source; null when unknown.
function planLabel(org) {
  const t = String(org?.rate_limit_tier || '').toLowerCase();
  const caps = Array.isArray(org?.capabilities) ? org.capabilities : [];
  if (t.includes('max_20x')) return 'Max 20x';
  if (t.includes('max_5x')) return 'Max 5x';
  if (t.includes('max')) return 'Max';
  if (t.includes('team')) return 'Team';
  if (t.includes('enterprise')) return 'Enterprise';
  if (t.includes('pro')) return 'Pro';
  if (caps.includes('claude_max')) return 'Max';
  if (caps.includes('claude_pro')) return 'Pro';
  if (t.includes('free') || t === 'default') return 'Free';
  return null;
}

// Merges imported points into the stored list, in place: malformed entries (including ones without an account)
// and duplicates (same account, series and time) are dropped, the list ends sorted by time. Returns the number added.
function mergePoints(points, incoming) {
  const id = p => `${p.org}|${p.key}|${p.t}`;
  const seen = new Set(points.map(id));
  let n = 0;
  for (const p of Array.isArray(incoming) ? incoming : []) {
    if (!p || typeof p.org !== 'string' || !p.org || typeof p.key !== 'string' || !Number.isFinite(p.t)
        || !Number.isFinite(p.pct) || !Number.isFinite(p.reset)) continue;
    if (seen.has(id(p))) continue;
    seen.add(id(p));
    const q = { t: p.t, org: p.org, key: p.key, pct: p.pct, reset: p.reset };
    for (const k of ['start', 'used', 'limit']) if (Number.isFinite(p[k])) q[k] = p[k];
    if (typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency)) q.currency = p.currency;
    points.push(q);
    n++;
  }
  points.sort((a, b) => a.t - b.t);
  return n;
}

// Claude Code transcripts (~/.claude/projects/**/*.jsonl): every API call is an "assistant" line with the model and
// a usage block. A streamed reply repeats it over several lines (same message id and request id); the one with the
// most output is the final count. Priced at API list prices per million tokens (input, output, cache read); cache
// writes cost 1.25x input for 5 minutes and 2x for an hour, fast mode doubles everything. Longer names come first,
// so "opus-5-5" is not read as "opus-5".
const LOG_PRICES = [
  ['claude-fable-5-1', 10, 50, 0.25], ['claude-fable-5', 10, 50, 1], ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5], ['claude-opus-4-8', 5, 25, 0.5], ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5], ['claude-sonnet-5-5', 2, 10, 0.2], ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3], ['claude-haiku-4-5', 1, 5, 0.1],
];

// API-price dollars of one call, or null when its model has no price here.
function logCallCost(model, u) {
  const p = LOG_PRICES.find(([m]) => String(model).startsWith(m));
  if (!p || !u) return null;
  const [, inp, out, read] = p;
  const n = v => Number(v) || 0;
  const w1h = n(u.cache_creation?.ephemeral_1h_input_tokens);
  const w5m = Math.max(0, n(u.cache_creation_input_tokens) - w1h);
  const usd = (n(u.input_tokens) * inp + n(u.output_tokens) * out + n(u.cache_read_input_tokens) * read
    + w5m * inp * 1.25 + w1h * inp * 2) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd;
}

// Adds one transcript's calls to `calls` (Map of message id + request id to { t, model, usage }). The same call in
// another file (a resumed or forked session) lands on the same key.
function readTranscript(text, calls) {
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d?.message, u = m?.usage;
    const t = Date.parse(d?.timestamp);
    if (d?.type !== 'assistant' || !u || !m.id || !Number.isFinite(t)) continue;
    const key = `${m.id}|${d.requestId ?? ''}`;
    const prev = calls.get(key);
    if (prev && (Number(prev.usage.output_tokens) || 0) >= (Number(u.output_tokens) || 0)) continue;
    calls.set(key, { t: prev ? prev.t : t, model: m.model, usage: u });
  }
}

// The transcripts in the connected folder: its "projects" folder when it is the .claude folder, or the projects
// folder itself. Anything else is refused, so a wrong pick never walks a whole drive.
async function logFiles(root) {
  try { await root.entries().next(); } catch {
    throw new Error('it was moved or deleted: connect it again');
  }
  let dir = root;
  if (root.name !== 'projects') {
    try { dir = await root.getDirectoryHandle('projects'); } catch {
      throw new Error(`"${root.name}" is not the Claude folder: pick the .claude folder in your user folder (with "projects" inside)`);
    }
  }
  const out = [];
  const walk = async (d, path) => {
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, `${path}${name}/`);
      else if (name.endsWith('.jsonl')) out.push([path + name, h]);
    }
  };
  await walk(dir, '');
  return out;
}

// Reads the connected folder. scan = what the last read left (null: read everything): how far it got in each file,
// when, and the calls of the last LOG_KEEP with what each was counted at. A line still being written is read next
// time. After the first read, only calls from LOG_MARGIN before the last read on count, so the history a resumed
// session copies into a new file is not counted again, and a call whose output grew since adds only the difference.
// Returns { full, minutes: [minute, usd] pairs, unpriced, scan }: totals to merge (mergeMinutes) on a full read,
// else what to add (addMinutes).
const LOG_MARGIN = 15 * 6e4;
const LOG_KEEP = 30 * 6e4;
async function scanLogs(root, scan, now) {
  const full = !scan;
  const offsets = {}, calls = new Map();
  for (const [path, handle] of await logFiles(root)) {
    const file = await handle.getFile();
    let from = full ? 0 : scan.offsets?.[path] ?? 0;
    if (from > file.size) from = 0; // rewritten
    offsets[path] = from;
    if (from === file.size) continue;
    const bytes = new Uint8Array(await file.slice(from).arrayBuffer());
    const end = bytes.lastIndexOf(10) + 1;
    if (!end) continue;
    readTranscript(new TextDecoder().decode(bytes.subarray(0, end)), calls);
    offsets[path] = from + end;
  }
  const since = full ? -Infinity : scan.at - LOG_MARGIN;
  const recent = new Map(full ? [] : Object.entries(scan.recent || {}));
  const add = new Map(), unpriced = {};
  for (const [key, c] of calls) {
    if (c.t < since || c.model === '<synthetic>') continue;
    const usd = logCallCost(c.model, c.usage);
    if (usd === null) { unpriced[c.model] = (unpriced[c.model] || 0) + 1; continue; }
    const before = recent.get(key)?.[1] ?? 0;
    if (usd <= before) continue;
    const k = Math.floor(c.t / 6e4);
    add.set(k, (add.get(k) || 0) + usd - before);
    recent.set(key, [c.t, usd]);
  }
  for (const [key, [t]] of recent) if (t < now - LOG_KEEP) recent.delete(key);
  return { full, minutes: [...add].sort((a, b) => a[0] - b[0]), unpriced, scan: { at: now, offsets, recent: Object.fromEntries(recent) } };
}

// A full read over the stored minutes: each minute keeps the larger total, so transcripts deleted since do not lower
// what was seen, and reading the same files again counts nothing twice.
function mergeMinutes(stored, fresh) {
  const by = new Map(Array.isArray(stored) ? stored : []);
  for (const [k, v] of fresh) by.set(k, Math.max(by.get(k) || 0, v));
  return [...by].sort((a, b) => a[0] - b[0]);
}

// What a later read found since the last one, added to the stored minutes.
function addMinutes(stored, fresh) {
  const by = new Map(Array.isArray(stored) ? stored : []);
  for (const [k, v] of fresh) by.set(k, (by.get(k) || 0) + v);
  return [...by].sort((a, b) => a[0] - b[0]);
}

// The connected folder's handle, kept in IndexedDB (chrome.storage cannot hold one): the chart page stores it, the
// background worker reads with it. logHandle() reads it, logHandle(h) stores h, logHandle(null) forgets it.
async function logHandle(h) {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('claude-logs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction('handles', h === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('handles');
      const q = h === undefined ? store.get('dir') : h === null ? store.delete('dir') : store.put(h, 'dir');
      tx.oncomplete = () => res(h === undefined ? q.result ?? null : h);
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

if (typeof module !== 'undefined') {
  module.exports = { parseWeeklyUsage, parseMonthlySpend, accountLabel, planLabel, mergePoints, logCallCost, readTranscript,
                     logFiles, scanLogs, mergeMinutes, addMinutes, LOG_MARGIN };
}
