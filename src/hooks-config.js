'use strict';
// Adds / removes Glance's hooks in ~/.claude/settings.json without touching anything else.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MARKER = '127.0.0.1:%PORT%/hook/';

// Events an older Glance already installed: having these counts as "connected".
const CORE = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];

const EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*', timeout: 600 },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*', timeout: 600 },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'SessionEnd' },
];

// The status line is how Claude Code hands out your plan usage (rate_limits).
// Glance's status line only forwards that JSON and prints nothing. If you already have
// a status line, Glance wraps it: yours still runs and prints exactly as before,
// and the original is kept next to settings.json so disconnecting puts it back.
function usageUrl(port) {
  return `http://127.0.0.1:${port}/usage`;
}
function statusLineCommand(port, original) {
  const send =
    `printf '%s' "$input" | curl -s --connect-timeout 1 -m 2 -o /dev/null -X POST ` +
    `-H "Content-Type: application/json" --data-binary @- ${usageUrl(port)}`;
  if (!original) return `input=$(cat); ${send}; exit 0`;
  return `input=$(cat); ${send}; printf '%s' "$input" | { ${original}\n}`;
}
function isGlanceStatusLine(sl, port) {
  return typeof sl?.command === 'string' && sl.command.includes(usageUrl(port));
}
const originalFile = (file) => file + '.glance-statusline';
function readOriginal(file) {
  try {
    return JSON.parse(fs.readFileSync(originalFile(file), 'utf8')).statusLine || null;
  } catch {
    return null;
  }
}

function settingsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'settings.json');
}

// curl ships with Windows 10+, macOS and Linux. If Glance isn't running the
// connection is refused instantly and Claude Code carries on as normal.
// The X-Glance-Host header carries the Claude desktop app's id for the session
// (empty for terminal sessions), so Glance can open that exact conversation.
function commandFor(event, port, timeout) {
  const max = timeout ? timeout - 5 : 10;
  return (
    `curl -s --connect-timeout 1 -m ${max} -X POST -H "Content-Type: application/json" ` +
    `-H "X-Glance-Host: $CLAUDE_CODE_HOST_SESSION_ID" ` +
    `--data-binary @- http://127.0.0.1:${port}/hook/${event} || exit 0`
  );
}

function isGlanceHook(h, port) {
  return typeof h?.command === 'string' && h.command.includes(MARKER.replace('%PORT%', String(port)));
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw); // let a malformed file throw: never overwrite what we can't read
}

function stripGlance(settings, port) {
  if (!settings.hooks) return settings;
  for (const event of Object.keys(settings.hooks)) {
    const groups = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isGlanceHook(h, port)) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function install(port, file = settingsPath()) {
  const settings = stripGlance(readSettings(file), port);
  installStatusLine(settings, port, file);
  settings.hooks = settings.hooks || {};
  for (const { event, matcher, timeout } of EVENTS) {
    const group = {};
    if (matcher) group.matcher = matcher;
    const hook = { type: 'command', command: commandFor(event, port, timeout) };
    if (timeout) hook.timeout = timeout;
    group.hooks = [hook];
    settings.hooks[event] = [...(settings.hooks[event] || []), group];
  }
  write(file, settings);
  return file;
}

function installStatusLine(settings, port, file) {
  let original;
  if (isGlanceStatusLine(settings.statusLine, port)) original = readOriginal(file);
  else {
    original = settings.statusLine && typeof settings.statusLine === 'object' ? settings.statusLine : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (original) fs.writeFileSync(originalFile(file), JSON.stringify({ statusLine: original }, null, 2) + '\n');
    else fs.rmSync(originalFile(file), { force: true });
  }
  const cmd = original && original.type === 'command' && typeof original.command === 'string' ? original.command : '';
  // A non-command status line can't be wrapped: leave it alone.
  if (original && !cmd) return;
  settings.statusLine = { ...(original || {}), type: 'command', command: statusLineCommand(port, cmd) };
}

function uninstall(port, file = settingsPath()) {
  if (!fs.existsSync(file)) return file;
  const settings = stripGlance(readSettings(file), port);
  if (isGlanceStatusLine(settings.statusLine, port)) {
    const original = readOriginal(file);
    if (original) settings.statusLine = original;
    else delete settings.statusLine;
    fs.rmSync(originalFile(file), { force: true });
  }
  write(file, settings);
  return file;
}

function isInstalled(port, file = settingsPath()) {
  try {
    const s = readSettings(file);
    return CORE.map((event) => ({ event })).every(({ event }) =>
      (s.hooks?.[event] || []).some((g) => (g.hooks || []).some((h) => isGlanceHook(h, port)))
    );
  } catch {
    return false;
  }
}

// True when every Glance hook is the latest version of its command.
function isCurrent(port, file = settingsPath()) {
  try {
    const s = readSettings(file);
    const hooksOk = EVENTS.every(({ event, timeout }) =>
      (s.hooks?.[event] || []).some((g) => (g.hooks || []).some((h) => isGlanceHook(h, port) && h.command === commandFor(event, port, timeout)))
    );
    // A status line that isn't a command (and so can't be wrapped) doesn't count against it.
    const sl = s.statusLine;
    const slOk = isGlanceStatusLine(sl, port) || (sl && typeof sl === 'object' && sl.type !== 'command');
    return hooksOk && !!slOk;
  } catch {
    return false;
  }
}

function write(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const backup = file + '.glance-backup';
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { install, uninstall, isInstalled, isCurrent, settingsPath, statusLineCommand, EVENTS };
