'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { Usage, fromStatusLine, fromEndpoint, readToken } = require('../src/usage');
const { Store } = require('../src/store');
const { startServer } = require('../src/server');
const hooks = require('../src/hooks-config');

const PORT = 47998;

test('status line rate_limits become usage', () => {
  const u = fromStatusLine({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } } });
  assert.deepStrictEqual(u, { fiveHour: { used: 23.5, resetsAt: 1738425600000 }, sevenDay: { used: 41.2, resetsAt: 1738857600000 } });
  assert.strictEqual(fromStatusLine({ model: { display_name: 'Opus' } }), null, 'API key users have no rate_limits');
  assert.deepStrictEqual(fromStatusLine({ rate_limits: { seven_day: { used_percentage: 5 } } }), { fiveHour: null, sevenDay: { used: 5, resetsAt: null } });
});

test('the usage endpoint response becomes usage', () => {
  const u = fromEndpoint({ five_hour: { utilization: 12, resets_at: '2099-01-01T00:00:00+00:00' }, seven_day: { utilization: 61.5, resets_at: null } });
  assert.strictEqual(u.fiveHour.used, 12);
  assert.strictEqual(u.fiveHour.resetsAt, Date.parse('2099-01-01T00:00:00Z'));
  assert.deepStrictEqual(u.sevenDay, { used: 61.5, resetsAt: null });
  assert.strictEqual(fromEndpoint({ error: 'nope' }), null);
});

test('a window whose reset time passed reads as zero, the other window is kept', () => {
  let now = 1_000_000_000_000;
  const usage = new Usage({ now: () => now });
  usage.ingestStatusLine({ rate_limits: { five_hour: { used_percentage: 90, resets_at: (now + 60_000) / 1000 }, seven_day: { used_percentage: 40, resets_at: (now + 9e8) / 1000 } } });
  assert.strictEqual(usage.snapshot().fiveHour.used, 90);
  now += 120_000;
  assert.deepStrictEqual(usage.snapshot().fiveHour, { used: 0, resetsAt: null, reset: true });
  // Claude Code drops the reset window from the next status line; the weekly one stays.
  usage.ingestStatusLine({ rate_limits: { seven_day: { used_percentage: 41, resets_at: (now + 9e8) / 1000 } } });
  assert.strictEqual(usage.snapshot().sevenDay.used, 41);
  assert.strictEqual(usage.snapshot().source, 'statusline');
});

test('the login fallback is only used when allowed and the status line is quiet', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization, beta: opts.headers['anthropic-beta'] });
    return { ok: true, json: async () => ({ five_hour: { utilization: 33, resets_at: null }, seven_day: { utilization: 70, resets_at: null } }) };
  };
  const usage = new Usage({ fetchImpl, tokenReader: () => 'tok' });
  await usage.poll();
  assert.strictEqual(calls.length, 0, 'off by default');
  usage.fallback = true;
  await usage.poll();
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { url: 'https://api.anthropic.com/api/oauth/usage', auth: 'Bearer tok', beta: 'oauth-2025-04-20' });
  assert.strictEqual(usage.snapshot().source, 'login');
  assert.strictEqual(usage.snapshot().sevenDay.used, 70);
  usage.ingestStatusLine({ rate_limits: { five_hour: { used_percentage: 34 } } });
  await usage.poll();
  assert.strictEqual(calls.length, 1, 'fresh status line data wins');

  const none = new Usage({ fetchImpl, tokenReader: () => null });
  none.fallback = true;
  await none.poll();
  assert.match(none.snapshot().note, /No Claude Code login/);
  assert.strictEqual(none.snapshot().fiveHour, null);
});

test('expired or missing logins are never used', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-cred-'));
  const file = path.join(tmp, '.credentials.json');
  assert.strictEqual(readToken(file), null);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: Date.now() - 1000 } }));
  assert.strictEqual(readToken(file), null);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'b', expiresAt: Date.now() + 3600_000 } }));
  assert.strictEqual(readToken(file), 'b');
});

function run(command, input) {
  return new Promise((resolve) => {
    const child = execFile('bash', ['-c', command], (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    child.stdin.end(input);
  });
}

test('status line: forwards usage to Glance and keeps your own status line output', async (t) => {
  const usage = new Usage();
  const server = await startServer(new Store(), { port: PORT, usage });
  t.after(() => server.close());
  const json = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 34 } } });

  const solo = await run(hooks.statusLineCommand(PORT, ''), json);
  assert.strictEqual(solo.code, 0);
  assert.strictEqual(solo.stdout, '', 'Glance alone prints nothing');
  assert.strictEqual(usage.snapshot().fiveHour.used, 12);

  // A user status line with a trailing comment still runs and prints.
  const wrapped = await run(hooks.statusLineCommand(PORT, `sed -E 's/.*"display_name":"([^"]+)".*/[\\1]/' # mine`), json.replace('12', '15'));
  assert.strictEqual(wrapped.stdout.trim(), '[Opus]');
  assert.strictEqual(usage.snapshot().fiveHour.used, 15);

  // Glance not running: the user's status line still prints.
  server.close();
  const offline = await run(hooks.statusLineCommand(PORT + 1, 'cat | wc -c'), 'abc');
  assert.strictEqual(offline.stdout.trim(), '3');
});

test('settings.json: wraps an existing status line and puts it back on disconnect', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
  const file = path.join(tmp, 'settings.json');
  const original = { statusLine: { type: 'command', command: '~/.claude/statusline.sh', padding: 2 } };
  fs.writeFileSync(file, JSON.stringify(original));
  hooks.install(47821, file);
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.statusLine.padding, 2);
  assert.match(s.statusLine.command, /127\.0\.0\.1:47821\/usage/);
  assert.match(s.statusLine.command, /~\/\.claude\/statusline\.sh/);
  assert.ok(hooks.isCurrent(47821, file));
  hooks.install(47821, file); // reinstalling never wraps Glance's own command twice
  s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.statusLine.command.split('127.0.0.1:47821/usage').length, 2);
  assert.match(s.statusLine.command, /statusline\.sh/);
  assert.strictEqual(s.hooks.SubagentStart.length, 1);
  assert.strictEqual(s.hooks.SubagentStop.length, 1);
  hooks.uninstall(47821, file);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});

test('settings.json: hooks from 1.2 still count as connected but ask for an update', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
  const file = path.join(tmp, 'settings.json');
  hooks.install(47821, file);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete s.hooks.SubagentStart;
  delete s.hooks.SubagentStop;
  delete s.statusLine;
  fs.writeFileSync(file, JSON.stringify(s));
  assert.ok(hooks.isInstalled(47821, file));
  assert.ok(!hooks.isCurrent(47821, file));
  hooks.install(47821, file);
  assert.ok(hooks.isCurrent(47821, file));
});
