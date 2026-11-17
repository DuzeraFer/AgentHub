'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');

const entry = { '/t/app.jsonl': 'claude-desktop', '/t/cli.jsonl': 'cli' };
const mtimes = {};
const mk = (o = {}) => new Store({ elsewhereDelay: 0, ...o, readEntrypoint: (p) => entry[p] || '', statMtime: (p) => (p in mtimes ? mtimes[p] : undefined) });

test('Claude app sessions are never held, but still show the request', async () => {
  const store = mk();
  const base = { session_id: 'app-1', cwd: 'C:/AgentHub', transcript_path: '/t/app.jsonl' };
  store.handle('UserPromptSubmit', { ...base, prompt: 'hi' });
  let attention = 0;
  store.on('attention', () => attention++);
  const out = store.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.deepStrictEqual(out, {}); // answered at once, so the app shows its own prompt
  assert.strictEqual(attention, 1);
  let s = store.snapshot()[0];
  assert.strictEqual(s.status, 'permission');
  assert.ok(s.request.elsewhere);
  assert.ok(s.inApp);
  // Once the app handles it, the card clears.
  store.handle('PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'npm test' } });
  s = store.snapshot()[0];
  assert.strictEqual(s.status, 'running');
  assert.strictEqual(s.request, null);

  const q = store.handle('PreToolUse', { ...base, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }] }] } });
  assert.deepStrictEqual(q, {});
  assert.strictEqual(store.snapshot()[0].status, 'question');
});

test('terminal sessions are still held for an answer', async () => {
  const store = mk();
  const base = { session_id: 'cli-1', cwd: '/x', transcript_path: '/t/cli.jsonl' };
  const p = store.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.ok(typeof p.then === 'function');
  store.respondPermission(p.requestId, 'allow');
  const out = await p;
  assert.strictEqual(out.hookSpecificOutput.decision.behavior, 'allow');
});

test('subagents do not overwrite the plan or finish the session', () => {
  const store = mk();
  const base = { session_id: 'p-1', cwd: '/x', transcript_path: '/t/cli.jsonl' };
  const sub = { ...base, transcript_path: '/t/p-1/subagents/agent-abc.jsonl' };
  store.handle('PostToolUse', { ...base, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Main step', status: 'in_progress' }] } });
  store.handle('PostToolUse', { ...sub, tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'Sub step', status: 'pending' }] } });
  store.handle('PreToolUse', { ...sub, tool_name: 'Read', tool_input: { file_path: '/a/b.js' } });
  store.handle('Stop', sub);
  const s = store.snapshot()[0];
  assert.strictEqual(s.steps[0].text, 'Main step');
  assert.strictEqual(s.status, 'running');
  assert.match(s.activity, /^Subagent: Reading b\.js/);
  assert.strictEqual(s.transcript, '/t/cli.jsonl');
});

test('anything waiting on you is listed first', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { session_id: 'a', cwd: '/a', transcript_path: '/t/app.jsonl', prompt: 'a' });
  store.handle('UserPromptSubmit', { session_id: 'b', cwd: '/b', transcript_path: '/t/app.jsonl', prompt: 'b' });
  store.handle('UserPromptSubmit', { session_id: 'c', cwd: '/c', transcript_path: '/t/app.jsonl', prompt: 'c' });
  store.handle('PermissionRequest', { session_id: 'c', transcript_path: '/t/app.jsonl', tool_name: 'Bash', tool_input: { command: 'x' } });
  assert.deepStrictEqual(store.snapshot().map((s) => s.id), ['c', 'a', 'b']);
});

test('quiet and vanished sessions are cleaned up', () => {
  const store = mk();
  const now = Date.now();
  store.handle('UserPromptSubmit', { session_id: 'q', cwd: '/q', transcript_path: '/t/q.jsonl', prompt: 'q' });
  store.handle('UserPromptSubmit', { session_id: 'g', cwd: '/g', transcript_path: '/t/g.jsonl', prompt: 'g' });
  store.handle('UserPromptSubmit', { session_id: 'demo', cwd: '/d', prompt: 'no transcript' });
  mtimes['/t/q.jsonl'] = now - 20 * 60 * 1000;
  mtimes['/t/g.jsonl'] = null; // file deleted
  store.sessions.get('q').updatedAt = now - 20 * 60 * 1000;
  store.sessions.get('demo').updatedAt = now - 4 * 60 * 60 * 1000;
  store.sweep(now);
  const ids = store.snapshot().map((s) => s.id);
  assert.deepStrictEqual(ids, ['q']);
  assert.strictEqual(store.snapshot()[0].status, 'waiting');
  // New activity wakes it back up.
  store.handle('PreToolUse', { session_id: 'q', transcript_path: '/t/q.jsonl', tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.strictEqual(store.snapshot()[0].status, 'running');
});

test('Claude app requests answered within a moment never pop the widget', async () => {
  const store = mk({ elsewhereDelay: 40 });
  const base = { session_id: 'auto-1', cwd: '/a', transcript_path: '/t/app.jsonl' };
  let attention = 0;
  store.on('attention', () => attention++);
  store.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  store.handle('PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' } });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(attention, 0);
  assert.strictEqual(store.snapshot()[0].request, null);
  // One that stays open does show up.
  store.handle('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(attention, 1);
  assert.strictEqual(store.snapshot()[0].status, 'permission');
});
