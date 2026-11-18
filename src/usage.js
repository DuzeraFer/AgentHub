'use strict';
// Your Claude plan usage: the 5-hour session window and the weekly window.
//
// Source 1 (official): Claude Code passes `rate_limits` to the status line command
// (Pro and Max plans, after the first reply in a session). Glance's status line
// forwards that JSON to POST /usage.
// Source 2 (optional, unofficial): the endpoint Claude Code's /usage screen reads,
// called with the login Claude Code saved on this computer. Only used when the
// status line has not reported anything recently, and only if the user allows it.
// Glance never estimates usage from token counts: no data means an empty ring.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const POLL_MS = 5 * 60 * 1000;
const FRESH_MS = 10 * 60 * 1000; // status line data newer than this wins over the fallback

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// resets_at is epoch seconds in the status line, an ISO string from the endpoint.
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function windowFrom(w, field) {
  if (!w || typeof w !== 'object') return null;
  const used = pct(w[field]);
  if (used == null) return null;
  return { used, resetsAt: toMs(w.resets_at) };
}

// Status line input -> usage, or null when it carries none (API key users, first message).
function fromStatusLine(json) {
  const r = json && json.rate_limits;
  if (!r || typeof r !== 'object') return null;
  const fiveHour = windowFrom(r.five_hour, 'used_percentage');
  const sevenDay = windowFrom(r.seven_day, 'used_percentage');
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

// /api/oauth/usage response -> usage. `utilization` is a percentage there too.
function fromEndpoint(json) {
  if (!json || typeof json !== 'object') return null;
  const fiveHour = windowFrom(json.five_hour, 'utilization');
  const sevenDay = windowFrom(json.seven_day, 'utilization');
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function credentialsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

// The access token Claude Code saved. Expired tokens are skipped: refreshing one
// would rotate Claude Code's own login, so Glance never does that.
function readToken(file = credentialsPath(), now = Date.now()) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
    if (!c || typeof c.accessToken !== 'string' || !c.accessToken) return null;
    if (c.expiresAt && Number(c.expiresAt) < now + 60 * 1000) return null;
    return c.accessToken;
  } catch {
    return null;
  }
}

class Usage extends EventEmitter {
  constructor({ fetchImpl = globalThis.fetch, tokenReader = readToken, now = () => Date.now() } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.tokenReader = tokenReader;
    this.now = now;
    this.data = null; // { fiveHour, sevenDay, source: 'statusline' | 'login', updatedAt }
    this.fallback = false;
    this.fallbackNote = '';
    this.timer = null;
    this.lastStatusLine = 0;
  }

  ingestStatusLine(json) {
    const u = fromStatusLine(json);
    if (!u) return false;
    this.lastStatusLine = this.now();
    this.set(u, 'statusline');
    return true;
  }

  set(u, source) {
    const prev = this.data;
    // Claude Code drops a window from the status line once it resets; keep the other one.
    const merged = {
      fiveHour: u.fiveHour || (prev && prev.fiveHour) || null,
      sevenDay: u.sevenDay || (prev && prev.sevenDay) || null,
    };
    this.data = { ...merged, source, updatedAt: this.now() };
    this.emit('change', this.snapshot());
  }

  // Windows whose reset time passed start again from zero.
  snapshot() {
    const now = this.now();
    const fix = (w) => (w && w.resetsAt && w.resetsAt <= now ? { used: 0, resetsAt: null, reset: true } : w);
    const d = this.data;
    return {
      fiveHour: d ? fix(d.fiveHour) : null,
      sevenDay: d ? fix(d.sevenDay) : null,
      source: d ? d.source : '',
      updatedAt: d ? d.updatedAt : 0,
      fallback: this.fallback,
      note: this.fallbackNote,
    };
  }

  setFallback(on) {
    this.fallback = !!on;
    clearInterval(this.timer);
    this.timer = null;
    if (this.fallback) {
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.timer.unref?.();
      this.poll();
    } else {
      this.fallbackNote = '';
    }
    this.emit('change', this.snapshot());
  }

  async poll() {
    if (!this.fallback || this.polling) return;
    if (this.now() - this.lastStatusLine < FRESH_MS) return;
    const token = this.tokenReader();
    if (!token) {
      this.note('No Claude Code login found on this computer');
      return;
    }
    this.polling = true;
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json', 'user-agent': 'glance-widget' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        this.note(`Usage lookup failed (${res.status})`);
        return;
      }
      const u = fromEndpoint(await res.json());
      if (!u) {
        this.note('Usage lookup returned no plan limits');
        return;
      }
      this.fallbackNote = '';
      this.set(u, 'login');
    } catch {
      this.note('Usage lookup failed');
    } finally {
      this.polling = false;
    }
  }

  note(text) {
    if (this.fallbackNote === text) return;
    this.fallbackNote = text;
    this.emit('change', this.snapshot());
  }
}

module.exports = { Usage, fromStatusLine, fromEndpoint, readToken, USAGE_URL };
