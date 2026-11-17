'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { Store } = require('../src/store');
const { startServer } = require('../src/server');
const hooks = require('../src/hooks-config');

const PORT = 47999;

function post(event, payload) {
  return fetch(`http://127.0.0.1:${PORT}/hook/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (r) => {
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  });
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('hook bridge', async (t) => {
  const store = new Store();
  const server = await startServer(store, { port: PORT });
  t.after(() => server.close());
  const sid = 'sess-1';
  const base = { session_id: sid, cwd: '/home/du/projects/reel-kit', transcript_path: '/tmp/x.jsonl' };

  await t.test('prompt creates a running session with a title', async () => {
    assert.deepStrictEqual(await post('UserPromptSubmit', { ...base, prompt: 'Polish the watch videos and render all animations' }), {});
    const s = store.snapshot()[0];
    assert.strictEqual(s.project, 'reel-kit');
    assert.strictEqual(s.status, 'running');
    assert.match(s.title, /^Polish the watch videos/);
  });

  await t.test('TodoWrite drives steps and progress label', async () => {
    const todos = [
      { content: 'Read transcript', activeForm: 'Reading transcript', status: 'completed' },
      { content: 'Render 01-hook.mp4', activeForm: 'Rendering 01-hook.mp4', status: 'in_progress' },
      { content: 'Build project', activeForm: 'Building project', status: 'pending' },
    ];
    await post('PreToolUse', { ...base, tool_name: 'TodoWrite', tool_input: { todos } });
    await post('PostToolUse', { ...base, tool_name: 'TodoWrite', tool_input: { todos }, tool_response: {} });
    const s = store.snapshot()[0];
    assert.strictEqual(s.steps.length, 3);
    assert.strictEqual(s.activity, 'Rendering 01-hook.mp4');
    await post('PreToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npx motion render . -o 01-hook.mp4' } });
    assert.strictEqual(store.snapshot()[0].lastCommand, 'npx motion render . -o 01-hook.mp4');
  });

  await t.test('permission request waits for the user, then allows', async () => {
    const pending = post('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'python scripts/score.py --videos 140' } });
    await tick();
    const s = store.snapshot()[0];
    assert.strictEqual(s.status, 'permission');
    assert.strictEqual(s.request.preview, 'python scripts/score.py --videos 140');
    store.respondPermission(s.request.id, 'allow');
    const out = await pending;
    assert.deepStrictEqual(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.strictEqual(store.snapshot()[0].status, 'running');
  });

  await t.test('deny returns a deny decision', async () => {
    const pending = post('PermissionRequest', { ...base, tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } });
    await tick();
    store.respondPermission(store.snapshot()[0].request.id, 'deny');
    const out = await pending;
    assert.strictEqual(out.hookSpecificOutput.decision.behavior, 'deny');
  });

  await t.test('"Always allow" auto-approves the same command next time', async () => {
    const first = post('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await tick();
    store.respondPermission(store.snapshot()[0].request.id, 'always');
    await first;
    const second = await post('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test -- --watch' } });
    assert.strictEqual(second.hookSpecificOutput.decision.behavior, 'allow');
    assert.strictEqual(store.snapshot()[0].status, 'running');
  });

  await t.test('"answer in terminal" returns no decision', async () => {
    const pending = post('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    await tick();
    store.respondPermission(store.snapshot()[0].request.id, 'terminal');
    assert.deepStrictEqual(await pending, {});
  });

  await t.test('AskUserQuestion is answered from the widget', async () => {
    const questions = [
      {
        question: 'Which hook should open the reel?',
        header: 'Hook',
        multiSelect: false,
        options: [{ label: 'The pain point', description: 'Juggling agents' }, { label: 'The number' }],
      },
    ];
    const pending = post('PreToolUse', { ...base, tool_name: 'AskUserQuestion', tool_input: { questions } });
    await tick();
    const s = store.snapshot()[0];
    assert.strictEqual(s.status, 'question');
    assert.strictEqual(s.request.questions[0].options.length, 2);
    store.respondQuestion(s.request.id, ['The number']);
    const out = await pending;
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /The number/);
  });

  await t.test('a killed hook clears the card', async () => {
    const ctrl = new AbortController();
    const pending = fetch(`http://127.0.0.1:${PORT}/hook/PermissionRequest`, {
      method: 'POST',
      body: JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' } }),
      signal: ctrl.signal,
    }).catch(() => 'aborted');
    await tick();
    assert.strictEqual(store.snapshot()[0].status, 'permission');
    ctrl.abort();
    assert.strictEqual(await pending, 'aborted');
    await tick();
    assert.strictEqual(store.snapshot()[0].status, 'running');
    assert.strictEqual(store.snapshot()[0].request, null);
  });

  await t.test('Stop marks done, dismiss hides, next prompt brings it back', async () => {
    await post('Stop', { ...base, stop_hook_active: false });
    assert.strictEqual(store.snapshot()[0].status, 'done');
    store.dismiss(sid);
    assert.strictEqual(store.snapshot().length, 0);
    await post('UserPromptSubmit', { ...base, prompt: 'one more thing' });
    assert.strictEqual(store.snapshot().length, 1);
    assert.strictEqual(store.snapshot()[0].status, 'running');
  });

  await t.test('idle notification shows waiting', async () => {
    await post('Notification', { ...base, message: 'Claude is waiting for your input' });
    assert.strictEqual(store.snapshot()[0].status, 'waiting');
  });

  await t.test('SessionEnd removes the session', async () => {
    await post('SessionEnd', { ...base, reason: 'exit' });
    assert.strictEqual(store.snapshot().length, 0);
  });

  await t.test('the real hook command (curl) round-trips through the server', async () => {
    const cmd = hooks.EVENTS.find((e) => e.event === 'PermissionRequest');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
    const file = path.join(tmp, 'settings.json');
    hooks.install(PORT, file);
    const command = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PermissionRequest[0].hooks[0].command;
    assert.ok(cmd);
    const env = { ...process.env, CLAUDE_CODE_HOST_SESSION_ID: 'local_1234abcd-5678' };
    const child = execFile('bash', ['-c', command], { env }, (err, stdout) => {
      child.result = { err, stdout };
    });
    child.stdin.end(JSON.stringify({ ...base, session_id: 'curl-sess', tool_name: 'Bash', tool_input: { command: 'echo hi' } }));
    await new Promise((r) => setTimeout(r, 300));
    const s = store.snapshot().find((x) => x.id === 'curl-sess');
    assert.strictEqual(s.status, 'permission');
    assert.strictEqual(s.hostId, 'local_1234abcd-5678'); // lets the open button go to this exact chat
    store.respondPermission(s.request.id, 'allow');
    await new Promise((r) => child.on('exit', r));
    await tick();
    assert.ok(!child.result.err, String(child.result.err));
    assert.strictEqual(JSON.parse(child.result.stdout).hookSpecificOutput.decision.behavior, 'allow');
  });
});

test('hook command is silent and exits 0 when Glance is not running', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
  const file = path.join(tmp, 'settings.json');
  hooks.install(47998, file);
  const command = JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop[0].hooks[0].command;
  const res = await new Promise((resolve) => {
    const c = execFile('bash', ['-c', command], (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    c.stdin.end('{}');
  });
  assert.strictEqual(res.err, null);
  assert.strictEqual(res.stdout, '');
});

test('settings.json: install keeps other settings and hooks, uninstall restores', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
  const file = path.join(tmp, 'settings.json');
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
  };
  fs.writeFileSync(file, JSON.stringify(original));
  hooks.install(47821, file);
  assert.ok(hooks.isInstalled(47821, file));
  assert.ok(hooks.isCurrent(47821, file));
  hooks.install(47821, file); // idempotent
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.Stop.length, 2);
  assert.strictEqual(s.hooks.PermissionRequest.length, 1);
  assert.strictEqual(s.hooks.PermissionRequest[0].hooks[0].timeout, 600);
  assert.ok(fs.existsSync(file + '.glance-backup'));
  hooks.uninstall(47821, file);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  assert.ok(!hooks.isInstalled(47821, file));
});

test('settings.json: refuses to overwrite a file it cannot parse', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
  const file = path.join(tmp, 'settings.json');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => hooks.install(47821, file));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken');
});

test('settings.json: older Glance hooks are reported as outdated until updated', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glance-'));
  const file = path.join(tmp, 'settings.json');
  hooks.install(47821, file);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const groups of Object.values(s.hooks)) for (const g of groups) for (const h of g.hooks) h.command = h.command.replace(/-H "X-Glance-Host: [^"]*" /, '');
  fs.writeFileSync(file, JSON.stringify(s));
  assert.ok(hooks.isInstalled(47821, file));
  assert.ok(!hooks.isCurrent(47821, file));
  hooks.install(47821, file);
  assert.ok(hooks.isCurrent(47821, file));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.length, 1);
});
