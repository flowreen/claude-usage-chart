// node dev/test_chrome_multi.js : loads extension/ into Chrome for Testing against a fake claude.ai (local HTTPS,
// host-resolver mapping) and checks the multi-account plumbing for real: the saved account's key reaches the
// server through the session rule, a reissued key replaces the saved one, the browser's own login is untouched.
// Needs Chrome for Testing (npx @puppeteer/browsers install chrome@stable, or set CHROME) and openssl on PATH.
const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const ext = path.join(__dirname, '..', 'extension');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuc-'));
const CDP = 9333;
const chrome = process.env.CHROME || (() => {
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const v = fs.readdirSync(base).sort().pop();
  return path.join(base, v, 'chrome-win64', 'chrome.exe');
})();

execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=claude.ai',
  '-addext', 'subjectAltName=DNS:claude.ai', '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')],
  { stdio: 'ignore' });

// Accounts by session key. B is reissued as B2 on its first request and then dies, like claude.ai's rotation.
const accounts = { A: 'a', B: 'b', B2: 'b' };
let rotateB = true;
const log = [];
const logouts = []; // session keys the server ended
const server = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, (req, res) => {
  const url = new URL(req.url, 'https://claude.ai');
  const cookie = req.headers.cookie || '';
  const key = /(?:^|;\s*)sessionKey=([^;]+)/.exec(cookie)?.[1];
  log.push({ path: url.pathname, cookie });
  const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/login' && !url.searchParams.get('k')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<p>login page</p>');
  }
  if (url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [
      `sessionKey=${url.searchParams.get('k')}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      'cf_clearance=cf; Path=/; Secure', 'lastActiveOrg=org-a; Path=/; Secure'] });
    return res.end('<p>logged in</p>');
  }
  // claude.ai's app page: its Log out POSTs /api/auth/logout, which ends the session
  if (url.pathname === '/app') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<p>app</p>');
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    logouts.push(key);
    delete accounts[key];
    return send(200, {}, { 'set-cookie': 'sessionKey=; Path=/; Max-Age=0' });
  }
  const who = accounts[key];
  if (!who) return send(401, { error: 'account_session_invalid' });
  const headers = {};
  if (key === 'B' && rotateB) {
    rotateB = false;
    delete accounts.B;
    headers['set-cookie'] = 'sessionKey=B2; Path=/; Secure; HttpOnly; SameSite=Lax';
  }
  const org = `org-${who}`;
  if (url.pathname === '/api/organizations') return send(200, [{ uuid: org, name: `Org ${who}`, capabilities: ['chat', 'claude_max'] }], headers);
  if (url.pathname === '/api/account') return send(200, { display_name: `User ${who}`, memberships: [{ organization: { uuid: org } }] }, headers);
  if (url.pathname === `/api/organizations/${org}/usage`) {
    return send(200, { limits: [{ kind: 'weekly_all', percent: who === 'a' ? 40 : 10, resets_at: new Date(Date.now() + 3 * 864e5).toISOString() }] }, headers);
  }
  send(404, {}, headers);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const open = new Promise(r => { ws.onopen = r; });
  const eval_ = async expr => {
    await open;
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    const m = await new Promise(r => pending.set(n, r));
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
    return m.result?.result?.value;
  };
  return { eval: eval_, close: () => ws.close() };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const proc = spawn(chrome, ['--headless=new', `--user-data-dir=${path.join(tmp, 'profile')}`, `--remote-debugging-port=${CDP}`,
    `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, `--host-resolver-rules=MAP claude.ai 127.0.0.1:${port}`,
    '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let sw;
  try {
    const targets = () => fetch(`http://127.0.0.1:${CDP}/json/list`).then(r => r.json());
    const swTarget = await waitFor(async () => (await targets()).find(t => t.type === 'service_worker' && t.url.endsWith('/background.js')), 'extension service worker');
    sw = cdp(swTarget.webSocketDebuggerUrl);

    // Log in to account A in a tab: the cookie listener polls at once.
    const loginTab = await fetch(`http://127.0.0.1:${CDP}/json/new?https://claude.ai/login?k=A`, { method: 'PUT' }).then(r => r.json());
    const first = await waitFor(async () => {
      const s = await sw.eval(`chrome.storage.local.get('status').then(x => x.status)`);
      return s?.msg === 'ok' && s;
    }, 'the login to trigger a poll');
    assert(first.ok, JSON.stringify(first));
    // the extension reloads claude.ai tabs on a switch: this one would log A in again
    await fetch(`http://127.0.0.1:${CDP}/json/close/${loginTab.id}`);

    // Account B as a saved session (as if the browser had been signed in to it before).
    await sw.eval(`chrome.storage.local.get('sessions').then(({ sessions = [] }) =>
      chrome.storage.local.set({ sessions: [...sessions, { key: 'B', name: '', orgIds: [] }] }))`);
    log.length = 0;
    const s1 = await sw.eval('poll()');
    assert(s1.ok, JSON.stringify(s1));
    await sleep(300); // the queued key swap
    const bReqs = log.filter(r => /sessionKey=B2?(;|$)/.test(r.cookie));
    assert(bReqs.length >= 3, `saved account requests: ${JSON.stringify(log)}`);
    assert(bReqs.every(r => /cf_clearance=cf/.test(r.cookie) && !/lastActiveOrg/.test(r.cookie) && !/sessionKey=A/.test(r.cookie)),
      JSON.stringify(bReqs));
    assert(/sessionKey=B(;|$)/.test(bReqs[0].cookie) && bReqs.slice(1).every(r => /sessionKey=B2/.test(r.cookie)),
      `after the reissue every request uses B2: ${JSON.stringify(bReqs)}`);
    const aReqs = log.filter(r => /sessionKey=A/.test(r.cookie));
    assert(aReqs.length >= 3 && aReqs.every(r => !/sessionKey=B/.test(r.cookie)), JSON.stringify(aReqs));

    const state = await sw.eval(`(async () => {
      const { sessions, points } = await chrome.storage.local.get(['sessions', 'points']);
      const jar = await chrome.cookies.get({ url: 'https://claude.ai/', name: 'sessionKey' });
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return { keys: sessions.map(s => s.key), orgs: [...new Set(points.map(p => p.org))].sort(), jar: jar && jar.value, rules: rules.length };
    })()`);
    assert.deepStrictEqual(state.keys, ['A', 'B2']);
    assert.deepStrictEqual(state.orgs, ['org-a', 'org-b']);
    assert.strictEqual(state.jar, 'A', 'the browser stays signed in to A');
    assert.strictEqual(state.rules, 0, 'session rule removed');

    // Next poll: B2 keeps working, B is never sent again.
    log.length = 0;
    const s2 = await sw.eval('poll()');
    assert(s2.ok, JSON.stringify(s2));
    assert(log.some(r => /sessionKey=B2/.test(r.cookie)) && !log.some(r => /sessionKey=B(;|$)/.test(r.cookie)), JSON.stringify(log));

    // Add account and Log out drive the real cookie store.
    const jar = () => sw.eval(`chrome.cookies.getAll({ url: 'https://claude.ai/', name: 'sessionKey' })
      .then(cs => cs.map(c => ({ value: c.value, httpOnly: c.httpOnly, secure: c.secure, hostOnly: c.hostOnly })))`);
    const add = await sw.eval('serial(addAccountOnce)');
    assert(add.ok, JSON.stringify(add));
    assert.deepStrictEqual(await jar(), [], 'browser login cleared');
    assert.strictEqual(await sw.eval(`chrome.cookies.get({ url: 'https://claude.ai/', name: 'lastActiveOrg' })`), null);
    const s3 = await sw.eval('poll()');
    assert(s3.ok, JSON.stringify(s3));
    const keys = await sw.eval(`chrome.storage.local.get('sessions').then(x => x.sessions.map(s => s.key))`);
    assert.deepStrictEqual(keys.sort(), ['A', 'B2'], 'both accounts kept after Add account');
    // log in to B in the browser (the server hands out B2 again)
    accounts.B = 'b';
    const bTab = await fetch(`http://127.0.0.1:${CDP}/json/new?https://claude.ai/login?k=B2`, { method: 'PUT' }).then(r => r.json());
    await waitFor(async () => (await jar()).some(c => c.value === 'B2'), 'the B2 login');
    await fetch(`http://127.0.0.1:${CDP}/json/close/${bTab.id}`);
    await sw.eval('poll()');
    const out = await sw.eval(`serial(() => forgetOnce('org-b'))`);
    assert(out.ok, JSON.stringify(out));
    assert.deepStrictEqual(await jar(), [], 'Log out clears the browser login to that account');
    const after = await sw.eval(`chrome.storage.local.get(['sessions', 'hiddenOrgs'])`);
    assert.deepStrictEqual(after.sessions.map(s => s.key), ['A']);
    assert.deepStrictEqual(after.hiddenOrgs, ['org-b']);
    assert.deepStrictEqual(logouts, ['B2'], 'Log out ends the session on claude.ai');
    assert(!accounts.B2);

    // claude.ai's own Log out: the page's POST is blocked, so A's session stays alive and saved, the browser login
    // is cleared and the tab lands on the login page.
    const aTab = await fetch(`http://127.0.0.1:${CDP}/json/new?https://claude.ai/login?k=A`, { method: 'PUT' }).then(r => r.json());
    await waitFor(async () => (await jar()).some(c => c.value === 'A'), 'the A login');
    const page = cdp(aTab.webSocketDebuggerUrl);
    await page.eval(`location.href = 'https://claude.ai/app'`);
    await sleep(500);
    const logout = await page.eval(`fetch('/api/auth/logout', { method: 'POST' }).then(r => 'sent ' + r.status, e => 'failed: ' + e.message)`);
    page.close();
    assert(/^failed/.test(logout), `the page's logout must be blocked: ${logout}`);
    await waitFor(async () => (await jar()).length === 0, 'the switch to clear the login');
    await waitFor(async () => (await targets()).find(t => t.id === aTab.id)?.url === 'https://claude.ai/login', 'the tab on the login page');
    assert.deepStrictEqual(logouts, ['B2'], 'A was not logged out on the server');
    assert.strictEqual(accounts.A, 'a');
    const s4 = await sw.eval('poll()');
    assert(s4.ok, JSON.stringify(s4));
    const keys2 = await sw.eval(`chrome.storage.local.get('sessions').then(x => x.sessions.map(s => s.key))`);
    assert.deepStrictEqual(keys2, ['A'], 'A saved and polled after the switch');
    // the extension's own requests to the logout URL are not blocked (the Log out above reached the server)
    console.log('chrome multi-account test passed');
  } finally {
    sw?.close();
    proc.kill();
    server.close();
    await sleep(500);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
})().catch(e => { console.error(e); process.exit(1); });
