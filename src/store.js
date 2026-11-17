'use strict';
// Session state for every Claude Code session Glance knows about.
// Pure logic: no Electron, no HTTP. Fed by hook events, read by the UI.

const { EventEmitter } = require('node:events');
const path = require('node:path');

const PALETTE = ['blue', 'pink', 'amber', 'violet', 'teal', 'green', 'indigo', 'orange'];
const GLYPHS = ['play', 'scissors', 'bulb', 'doc', 'spark', 'code', 'leaf', 'cube'];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function truncate(text, max) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

function basename(p) {
  if (!p) return 'Session';
  return path.basename(String(p).replace(/[\\/]+$/, '')) || String(p);
}

// Short human description of what a tool call is doing.
function describeTool(toolName, input = {}) {
  const file = input.file_path || input.notebook_path || input.path;
  switch (toolName) {
    case 'Bash':
      return input.description ? truncate(input.description, 60) : `Running ${truncate(input.command, 48)}`;
    case 'Read':
      return `Reading ${basename(file)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${basename(file)}`;
    case 'Write':
      return `Writing ${basename(file)}`;
    case 'NotebookEdit':
      return `Editing ${basename(file)}`;
    case 'Glob':
    case 'Grep':
      return `Searching ${truncate(input.pattern, 40)}`;
    case 'WebFetch':
      return 'Reading a web page';
    case 'WebSearch':
      return `Searching the web`;
    case 'Task':
    case 'Agent':
      return input.description ? `Subagent: ${truncate(input.description, 48)}` : 'Running a subagent';
    case 'TodoWrite':
      return 'Updating the plan';
    case 'AskUserQuestion':
      return 'Asking you a question';
    default:
      if (toolName && toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        return `Using ${parts[1] || 'a tool'}`;
      }
      return toolName ? `Using ${toolName}` : 'Working';
  }
}

// The command/path line shown in a permission card.
function requestPreview(toolName, input = {}) {
  if (toolName === 'Bash') return input.command || '';
  if (input.file_path) return input.file_path;
  if (input.url) return input.url;
  if (input.pattern) return input.pattern;
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return '';
  }
}

// Subagents report with their parent's session id, from their own transcript file.
function isSubagent(payload) {
  return !!payload.agent_id || /[\\/]subagents[\\/]/i.test(String(payload.transcript_path || ''));
}

// Only plain terminal sessions can be answered from Glance. Claude desktop, project
// and IDE sessions show their own prompt, which a held hook would block for minutes.
const HOLDABLE = new Set(['cli', '']);

const QUIET_MS = 15 * 60 * 1000; // no transcript writes for this long: stop showing "working"
const GONE_MS = 3 * 60 * 60 * 1000; // ...and for this long: drop the session

class Store extends EventEmitter {
  // readEntrypoint(transcriptPath) -> 'cli' | 'claude-desktop' | ... | '' (unknown)
  // statMtime(transcriptPath) -> ms timestamp, or null when the file is gone
  // elsewhereDelay: how long a Claude-app request must stay open before Glance shows it.
  // In auto mode many requests are approved within a moment, and flashing them made the widget pop.
  constructor({ readEntrypoint = () => '', statMtime = () => undefined, elsewhereDelay = 2500 } = {}) {
    super();
    this.elsewhereDelay = elsewhereDelay;
    this.readEntrypoint = readEntrypoint;
    this.statMtime = statMtime;
    this.sessions = new Map();
    this.pending = new Map(); // requestId -> { sessionId, resolve, kind }
    this.alwaysAllow = new Map(); // sessionId -> Set of rule keys
    this.seq = 0;
  }

  session(id, payload = {}) {
    let s = this.sessions.get(id);
    if (!s) {
      const h = hash(id);
      s = {
        id,
        cwd: payload.cwd || '',
        project: basename(payload.cwd),
        title: '',
        status: 'running', // running | permission | question | waiting | done
        activity: 'Starting up',
        steps: [],
        log: [],
        lastCommand: '',
        color: PALETTE[h % PALETTE.length],
        glyph: GLYPHS[(h >>> 8) % GLYPHS.length],
        startedAt: Date.now(),
        updatedAt: Date.now(),
        request: null,
        dismissed: false,
        transcript: '',
        entrypoint: '',
      };
      this.sessions.set(id, s);
    }
    if (!s.transcript && payload.transcript_path && !isSubagent(payload)) s.transcript = String(payload.transcript_path);
    // The transcript may not say where it runs until a few lines in, so keep looking for a while.
    if (s.transcript && !s.entrypoint && (s.lookups = (s.lookups || 0) + 1) <= 30) {
      try {
        s.entrypoint = this.readEntrypoint(s.transcript) || '';
      } catch {
        s.entrypoint = '';
      }
    }
    // The Claude desktop app's id for this conversation, used to open it directly.
    if (!s.hostId && /^local_[A-Za-z0-9-]{1,64}$/.test(payload._host || '')) s.hostId = payload._host;
    if (payload.cwd && !s.cwd) {
      s.cwd = payload.cwd;
      s.project = basename(payload.cwd);
    }
    s.updatedAt = Date.now();
    s.dismissed = false;
    return s;
  }

  changed() {
    this.emit('change', this.snapshot());
  }

  snapshot() {
    return [...this.sessions.values()]
      .filter((s) => !s.dismissed)
      // Anything waiting on you goes first (oldest request on top), then the rest by start time.
      .sort((a, b) => {
        const wa = a.request ? 0 : 1;
        const wb = b.request ? 0 : 1;
        if (wa !== wb) return wa - wb;
        if (!wa) return a.askedAt - b.askedAt;
        return a.startedAt - b.startedAt;
      })
      .map(({ waitingAsk, ...s }) => ({ ...s, inApp: !HOLDABLE.has(s.entrypoint || ''), log: s.log.slice(-40) }));
  }

  pushLog(s, text, kind = 'tool') {
    s.log.push({ text, kind, at: Date.now() });
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
  }

  // Main entry point. Returns either an immediate hook response object
  // (possibly {}), or a Promise that resolves when the user acts.
  handle(event, payload = {}) {
    const id = payload.session_id || 'unknown';
    if (event === 'SessionEnd') {
      this.releaseSession(id);
      this.sessions.delete(id);
      this.changed();
      return {};
    }

    const s = this.session(id, payload);
    const sub = isSubagent(payload);

    // A request answered in the Claude app: anything that happens next means it was handled.
    if (event !== 'Notification' && event !== 'PermissionRequest') {
      if (s.waitingAsk) {
        clearTimeout(s.waitingAsk.timer);
        s.waitingAsk = null;
      }
      if (s.request?.elsewhere) {
        s.request = null;
        s.status = 'running';
      }
    }
    if (s.quiet) s.quiet = false;

    switch (event) {
      case 'SessionStart':
        s.status = 'waiting';
        s.activity = 'Ready for a prompt';
        break;

      case 'UserPromptSubmit': {
        const prompt = truncate(payload.prompt, 80);
        if (!s.title && prompt) s.title = truncate(payload.prompt, 34);
        s.status = 'running';
        s.activity = 'Thinking';
        this.pushLog(s, prompt, 'prompt');
        break;
      }

      case 'PreToolUse': {
        const tool = payload.tool_name;
        const input = payload.tool_input || {};
        if (tool === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length) {
          if (!this.canHold(s)) return this.notifyElsewhere(s, 'question', { tool, input });
          return this.ask(s, 'question', { tool, input });
        }
        if (s.status === 'permission' || s.status === 'question') break;
        s.status = 'running';
        s.activity = sub
          ? `Subagent: ${describeTool(tool, input)}`
          : this.currentStepLabel(s) || describeTool(tool, input);
        if (tool === 'Bash' && input.command) s.lastCommand = input.command;
        this.pushLog(s, describeTool(tool, input));
        break;
      }

      case 'PostToolUse': {
        const tool = payload.tool_name;
        const input = payload.tool_input || {};
        if (tool === 'TodoWrite' && Array.isArray(input.todos) && !sub) {
          s.steps = input.todos.map((t) => ({
            text: truncate(t.content, 80),
            active: truncate(t.activeForm || t.content, 80),
            status: t.status || 'pending',
          }));
        }
        if (s.status === 'permission' || s.status === 'question') break;
        s.status = 'running';
        s.activity = this.currentStepLabel(s) || s.activity;
        break;
      }

      case 'PermissionRequest': {
        const tool = payload.tool_name;
        const input = payload.tool_input || {};
        const key = this.ruleKey(tool, input);
        if (this.alwaysAllow.get(s.id)?.has(key)) {
          return permissionResponse('allow');
        }
        if (!this.canHold(s)) return this.notifyElsewhere(s, 'permission', { tool, input });
        return this.ask(s, 'permission', { tool, input, key });
      }

      case 'Notification': {
        const msg = payload.message || '';
        if (s.status === 'permission' || s.status === 'question') break;
        if (/waiting for your input/i.test(msg) || payload.notification_type === 'idle_prompt') {
          s.status = 'waiting';
          s.activity = 'Waiting for your reply';
        } else if (/permission/i.test(msg)) {
          // A permission prompt Glance didn't intercept (e.g. hook timed out).
          s.status = 'waiting';
          s.activity = 'Needs you in the terminal';
        }
        break;
      }

      case 'Stop':
        if (sub || s.status === 'permission' || s.status === 'question') break;
        s.status = 'done';
        s.activity = 'Finished. Ready for the next prompt';
        s.finishedAt = Date.now();
        break;

      default:
        break;
    }
    this.changed();
    return {};
  }

  canHold(s) {
    return HOLDABLE.has(s.entrypoint || '');
  }

  // Let the Claude app ask it (answer the hook immediately), and show it in Glance too
  // if it is still open after a moment.
  notifyElsewhere(s, kind, details) {
    if (s.waitingAsk) clearTimeout(s.waitingAsk.timer);
    if (this.elsewhereDelay <= 0) {
      this.showElsewhere(s, kind, details);
      return {};
    }
    const waiting = { kind, details };
    waiting.timer = setTimeout(() => {
      if (s.waitingAsk !== waiting || !this.sessions.has(s.id)) return;
      s.waitingAsk = null;
      this.showElsewhere(s, kind, details);
    }, this.elsewhereDelay);
    waiting.timer.unref?.();
    s.waitingAsk = waiting;
    return {};
  }

  showElsewhere(s, kind, details) {
    s.status = kind;
    s.askedAt = Date.now();
    s.activity = kind === 'permission' ? `Wants to use ${details.tool}` : 'Has a question';
    s.request = {
      id: `e${++this.seq}`,
      kind,
      elsewhere: true,
      tool: details.tool,
      preview: kind === 'permission' ? requestPreview(details.tool, details.input) : '',
      description: details.input.description || '',
      questions:
        kind === 'question'
          ? details.input.questions.map((x) => ({ question: x.question, header: x.header || '', options: (x.options || []).map((o) => ({ label: o.label })) }))
          : [],
    };
    this.changed();
    this.emit('attention', { session: s, kind });
  }

  // Called every so often: sessions whose transcript stopped changing went quiet
  // (closed window, parked remote session) or are gone for good.
  sweep(now = Date.now()) {
    let dirty = false;
    for (const s of [...this.sessions.values()]) {
      if (this.pendingFor(s.id)) continue;
      let last = s.updatedAt;
      if (s.transcript) {
        let m;
        try {
          m = this.statMtime(s.transcript);
        } catch {
          m = undefined;
        }
        if (m === null) {
          this.sessions.delete(s.id);
          dirty = true;
          continue;
        }
        if (typeof m === 'number') last = Math.max(last, m);
      }
      const idle = now - last;
      if (idle > GONE_MS) {
        this.sessions.delete(s.id);
        dirty = true;
      } else if (idle > QUIET_MS && !s.quiet && (s.status === 'running' || s.request?.elsewhere)) {
        s.quiet = true;
        s.request = null;
        s.status = 'waiting';
        s.activity = 'No activity for a while';
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  pendingFor(sessionId) {
    for (const [, p] of this.pending) if (p.sessionId === sessionId) return true;
    return false;
  }

  currentStepLabel(s) {
    const active = s.steps.find((t) => t.status === 'in_progress');
    return active ? active.active : '';
  }

  ruleKey(tool, input) {
    if (tool === 'Bash') {
      const first = String(input.command || '').trim().split(/\s+/)[0] || '';
      return `Bash:${first}`;
    }
    return tool;
  }

  ask(s, kind, details) {
    const requestId = `r${++this.seq}`;
    const prevStatus = s.status === 'permission' || s.status === 'question' ? 'running' : s.status;
    s.status = kind;
    s.askedAt = Date.now();
    if (kind === 'permission') {
      s.activity = `Wants to use ${details.tool}`;
      s.request = {
        id: requestId,
        kind,
        tool: details.tool,
        preview: requestPreview(details.tool, details.input),
        description: details.input.description || '',
      };
    } else {
      const q = details.input.questions;
      s.activity = 'Has a question';
      s.request = {
        id: requestId,
        kind,
        questions: q.map((x) => ({
          question: x.question,
          header: x.header || '',
          multiSelect: !!x.multiSelect,
          options: (x.options || []).map((o) => ({ label: o.label, description: o.description || '' })),
        })),
      };
    }
    this.changed();
    this.emit('attention', { session: s, kind });

    const promise = new Promise((resolve) => {
      this.pending.set(requestId, {
        sessionId: s.id,
        kind,
        details,
        resolve: (response) => {
          this.pending.delete(requestId);
          const cur = this.sessions.get(s.id);
          if (cur && cur.request && cur.request.id === requestId) {
            cur.request = null;
            cur.status = prevStatus === 'done' || prevStatus === 'waiting' ? 'running' : prevStatus;
            cur.activity = this.currentStepLabel(cur) || 'Working';
          }
          this.changed();
          resolve(response);
        },
      });
    });
    promise.requestId = requestId;
    return promise;
  }

  // UI actions -------------------------------------------------------------

  // decision: 'allow' | 'deny' | 'always' | 'terminal'
  respondPermission(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p || p.kind !== 'permission') return false;
    if (decision === 'always') {
      if (!this.alwaysAllow.has(p.sessionId)) this.alwaysAllow.set(p.sessionId, new Set());
      this.alwaysAllow.get(p.sessionId).add(p.details.key);
      p.resolve(permissionResponse('allow'));
    } else if (decision === 'allow') {
      p.resolve(permissionResponse('allow'));
    } else if (decision === 'deny') {
      p.resolve(permissionResponse('deny', 'The user denied this from Glance.'));
    } else {
      p.resolve({}); // fall through to Claude Code's own prompt
    }
    return true;
  }

  // answers: array (one per question) of strings; 'terminal' to hand back.
  respondQuestion(requestId, answers) {
    const p = this.pending.get(requestId);
    if (!p || p.kind !== 'question') return false;
    if (answers === 'terminal') {
      p.resolve({});
      return true;
    }
    const qs = p.details.input.questions;
    const lines = qs.map((q, i) => `"${q.question}" → ${answers[i] || '(no answer)'}`);
    p.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'The user already answered this question in the Glance widget, so there is no need to ask again. ' +
          'Their answers: ' + lines.join('; ') + '. Continue the task using these answers.',
      },
    });
    return true;
  }

  dismiss(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.releaseSession(sessionId);
    s.dismissed = true;
    this.changed();
  }

  releaseSession(sessionId) {
    for (const [, p] of this.pending) {
      if (p.sessionId === sessionId) p.resolve({});
    }
  }

  // Called when a hook HTTP request gives up (client disconnected / timeout).
  cancel(requestId) {
    const p = this.pending.get(requestId);
    if (p) p.resolve({});
  }

  attentionCount() {
    return this.snapshot().filter((s) => s.status === 'permission' || s.status === 'question').length;
  }
}

function permissionResponse(behavior, message) {
  const decision = { behavior };
  if (message) decision.message = message;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

module.exports = { Store, describeTool, requestPreview, truncate };
