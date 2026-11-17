'use strict';
// Adds / removes Glance's hooks in ~/.claude/settings.json without touching anything else.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MARKER = '127.0.0.1:%PORT%/hook/';

const EVENTS = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*', timeout: 600 },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PermissionRequest', matcher: '*', timeout: 600 },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];

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

function uninstall(port, file = settingsPath()) {
  if (!fs.existsSync(file)) return file;
  write(file, stripGlance(readSettings(file), port));
  return file;
}

function isInstalled(port, file = settingsPath()) {
  try {
    const s = readSettings(file);
    return EVENTS.every(({ event }) =>
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
    return EVENTS.every(({ event, timeout }) =>
      (s.hooks?.[event] || []).some((g) => (g.hooks || []).some((h) => isGlanceHook(h, port) && h.command === commandFor(event, port, timeout)))
    );
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

module.exports = { install, uninstall, isInstalled, isCurrent, settingsPath, EVENTS };
