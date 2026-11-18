'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Store } = require('../src/store');

const entry = { '/t/app.jsonl': 'claude-desktop', '/t/cli.jsonl': 'cli' };
const mtimes = {};
const mk = () => new Store({ elsewhereDelay: 0, readEntrypoint: (p) => entry[p] || '', statMtime: (p) => (p in mtimes ? mtimes[p] : undefined) });

const base = { session_id: 's-1', cwd: '/x/proj', transcript_path: '/t/app.jsonl' };
const subOf = (id, type = 'Explore') => ({ ...base, agent_id: id, agent_type: type, transcript_path: `/t/s-1/subagents/agent-${id}.jsonl` });

function spawn(store, id, { type = 'Explore', description = 'Look around', background = false } = {}) {
  store.handle('PreToolUse', { ...base, tool_name: 'Agent', tool_input: { description, subagent_type: type, prompt: 'go', run_in_background: background } });
  store.handle('SubagentStart', { ...base, agent_id: `agent-${id}`, agent_type: type });
}

test('subagents are listed under their session with their own activity', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Audit the repo' });
  spawn(store, 'a1', { description: 'Find hooks' });
  spawn(store, 'b2', { type: 'general-purpose', description: 'Read tests' });
  store.handle('PreToolUse', { ...subOf('a1'), tool_name: 'Grep', tool_input: { pattern: 'SubagentStart' } });
  store.handle('PreToolUse', { ...subOf('b2', 'general-purpose'), tool_name: 'Read', tool_input: { file_path: '/x/proj/test/a.test.js' } });
  const s = store.snapshot()[0];
  assert.strictEqual(s.children.length, 2);
  const a = s.children.find((c) => c.id === 'a1');
  assert.strictEqual(a.label, 'Find hooks');
  assert.strictEqual(a.type, 'Explore');
  assert.strictEqual(a.activity, 'Searching SubagentStart');
  assert.strictEqual(s.children.find((c) => c.id === 'b2').activity, 'Reading a.test.js');
  assert.strictEqual(s.activity, '2 subagents working');
  assert.strictEqual(s.busy, 2);
  assert.strictEqual(s.status, 'running');
});

test('a reply that ends while background work runs is not done until it all finishes', () => {
  const store = mk();
  let chimes = 0;
  store.handle('UserPromptSubmit', { ...base, prompt: 'Ship it' });
  spawn(store, 'bg1', { description: 'Run the long audit', background: true });
  spawn(store, 'fg1', { description: 'Quick look' });
  store.handle('SubagentStop', { ...subOf('fg1'), agent_id: 'fg1', agent_transcript_path: '/t/s-1/subagents/agent-fg1.jsonl', transcript_path: '/t/app.jsonl' });
  store.handle('Stop', {
    ...base,
    background_tasks: [
      { id: 't1', type: 'subagent', status: 'running', description: 'Run the long audit', agent_type: 'Explore' },
      { id: 't2', type: 'shell', status: 'running', description: 'npm run build', command: 'npm run build' },
    ],
  });
  let s = store.snapshot()[0];
  assert.strictEqual(s.status, 'background');
  assert.strictEqual(s.busy, 2, 'the background subagent is counted once, plus the shell');
  assert.match(s.activity, /Reply done · 2 still working/);
  assert.strictEqual(s.finishedAt, undefined);

  // The background subagent keeps working: the session stays in the background state.
  store.handle('PreToolUse', { ...subOf('bg1'), tool_name: 'Bash', tool_input: { command: 'ls', description: 'List files' } });
  s = store.snapshot()[0];
  assert.strictEqual(s.status, 'background');
  assert.strictEqual(s.children.find((c) => c.id === 'bg1').activity, 'List files');

  // It finishes; Claude Code reports only the shell is left.
  store.handle('SubagentStop', {
    ...base,
    agent_id: 'bg1',
    agent_type: 'Explore',
    background_tasks: [{ id: 't2', type: 'shell', status: 'running', description: 'npm run build' }],
  });
  s = store.snapshot()[0];
  assert.strictEqual(s.status, 'background');
  assert.strictEqual(s.busy, 1);

  // The shell ends, Claude Code wakes the session, and the follow-up reply ends with nothing left.
  store.handle('UserPromptSubmit', { ...base, prompt: '' });
  assert.strictEqual(store.snapshot()[0].status, 'running');
  store.handle('Stop', { ...base, background_tasks: [] });
  s = store.snapshot()[0];
  assert.strictEqual(s.status, 'done');
  assert.ok(s.finishedAt);
  assert.strictEqual(s.busy, 0);
  assert.ok(s.children.every((c) => c.status === 'done'));
  void chimes;
});

test('foreground subagents end with the reply, internal helpers are ignored', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Hi' });
  spawn(store, 'f1');
  // A /btw or prompt-suggestion helper that never had a SubagentStart.
  store.handle('SubagentStop', { ...base, agent_id: 'helper', agent_type: '' });
  store.handle('Stop', { ...base, background_tasks: [] });
  const s = store.snapshot()[0];
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.children.length, 1);
  assert.strictEqual(s.children[0].status, 'done');
});

test('older Claude Code without background_tasks still finishes', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Hi' });
  store.handle('Stop', base);
  assert.strictEqual(store.snapshot()[0].status, 'done');
});

test('a subagent starting after the reply ended puts the session back to working', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Hi' });
  store.handle('Stop', { ...base, background_tasks: [] });
  store.handle('SubagentStart', { ...base, agent_id: 'r1', agent_type: 'Plan' });
  let s = store.snapshot()[0];
  assert.strictEqual(s.status, 'background');
  assert.strictEqual(s.busy, 1);
  store.handle('SubagentStop', { ...base, agent_id: 'r1', agent_type: 'Plan', background_tasks: [] });
  s = store.snapshot()[0];
  assert.strictEqual(s.status, 'done');
});

test('the idle prompt does not hide background work', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Hi' });
  spawn(store, 'bg', { background: true });
  store.handle('Stop', { ...base, background_tasks: [{ id: 't', type: 'subagent', status: 'running', description: 'Look around' }] });
  store.handle('Notification', { ...base, message: 'Claude is waiting for your input', notification_type: 'idle_prompt' });
  assert.strictEqual(store.snapshot()[0].status, 'background');
});

test('a subagent permission in the Claude app is labelled and survives other subagents', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Hi' });
  spawn(store, 'p1', { description: 'Fix build' });
  spawn(store, 'p2', { description: 'Write docs' });
  store.handle('PermissionRequest', { ...subOf('p1'), tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  let s = store.snapshot()[0];
  assert.strictEqual(s.status, 'permission');
  assert.strictEqual(s.request.from, 'Fix build');
  // Another subagent keeps working: the first one's request is still open.
  store.handle('PreToolUse', { ...subOf('p2'), tool_name: 'Read', tool_input: { file_path: '/x/a.md' } });
  s = store.snapshot()[0];
  assert.strictEqual(s.status, 'permission');
  // The same subagent moves on: it was answered in the app.
  store.handle('PostToolUse', { ...subOf('p1'), tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
  s = store.snapshot()[0];
  assert.strictEqual(s.request, null);
  assert.strictEqual(s.status, 'running');
});

test('a subagent that went silent stops counting as busy', () => {
  const store = mk();
  store.handle('UserPromptSubmit', { ...base, prompt: 'Hi' });
  spawn(store, 'z', { background: true });
  store.handle('PreToolUse', { ...subOf('z'), tool_name: 'Read', tool_input: { file_path: '/a' } });
  store.handle('Stop', { ...base });
  assert.strictEqual(store.snapshot()[0].status, 'background');
  const later = Date.now() + 31 * 60 * 1000;
  mtimes['/t/app.jsonl'] = later;
  store.sweep(later);
  const s = store.snapshot()[0];
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.children[0].activity, 'Stopped responding');
});
