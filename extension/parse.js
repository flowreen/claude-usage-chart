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

if (typeof module !== 'undefined') module.exports = { parseWeeklyUsage, parseMonthlySpend, accountLabel, planLabel, mergePoints };
