'use strict';
/* global ICONS, PETS */

const api = window.glance;
const root = document.getElementById('root');
// An invisible handle in the bottom-left corner: no indicator, just a resize cursor on hover.
const GRIP = '<div class="grip" title="Drag to resize · double-click to reset"></div>';
let dragging = null;

// The main process zooms the whole page; it tells us how tall the list may get
// in page pixels so it never runs off the screen at any size.
function applySize() {
  if (state.prefs.maxH) root.style.setProperty('--max-h', `${state.prefs.maxH}px`);
  // A height you dragged to: shorter scrolls the list, taller leaves space below.
  const w = root.querySelector('.widget');
  if (w) w.style.height = state.prefs.fixedH && !state.prefs.collapsed ? `${state.prefs.fixedH}px` : '';
}

const state = {
  sessions: [],
  prefs: { sound: true, connected: true, collapsed: false },
  view: 'list', // 'list' | session id (detail)
  usage: null, // { fiveHour: { used, resetsAt }, sevenDay, source, updatedAt, fallback, note }
  usageOpen: false,
  drafts: {}, // requestId -> { picks: [Set per question], text: [string per question] }
};

// ---------------------------------------------------------------- helpers
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function elapsed(from, to = Date.now()) {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function displayName(s) {
  return s.title ? `${s.project} · ${s.title}` : s.project;
}

function progressOf(s) {
  const total = s.steps.length;
  const done = s.steps.filter((t) => t.status === 'completed').length;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

function avatar(s, large = false) {
  const t = PETS.traits(s.id, s.color);
  return `<div class="avatar pet-tile t-${esc(t.color)}${large ? ' lg' : ''}">${PETS.petSvg(s)}</div>`;
}

function draftFor(req) {
  if (!state.drafts[req.id]) {
    state.drafts[req.id] = { picks: req.questions.map(() => new Set()), text: req.questions.map(() => '') };
  }
  return state.drafts[req.id];
}

// ---------------------------------------------------------------- usage
function usageLevel(p) {
  return p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low';
}

// A small radial ring filled to the 5-hour usage (empty with no data).
function ring(size = 20) {
  const u = state.usage;
  const w = u?.fiveHour || u?.sevenDay;
  const p = w ? Math.round(w.used) : null;
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  const fill = p == null ? 0 : Math.max(p ? 0.03 : 0, p / 100);
  const label = p == null ? 'Usage: no data yet' : `Session usage ${p}%`;
  return `<svg class="ring ${p == null ? 'none' : usageLevel(p)}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-label="${label}">
    <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}"/>
    <circle class="fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${(fill * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}

function untilText(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'resetting now';
  const m = Math.round(d / 60000);
  if (m < 60) return `resets in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `resets in ${h}h ${m % 60}m`;
  const when = new Date(ms);
  return `resets ${when.toLocaleDateString(undefined, { weekday: 'short' })} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function agoText(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ago`;
}

function usageMeter(title, w) {
  if (!w) return `<div class="meter"><div class="m-top"><span>${title}</span><span class="m-pct">–</span></div><div class="bar"><i style="width:0"></i></div><div class="m-sub">No data</div></div>`;
  const p = Math.round(w.used);
  return `<div class="meter ${usageLevel(p)}">
    <div class="m-top"><span>${title}</span><span class="m-pct">${p}%</span></div>
    <div class="bar"><i style="width:${p}%"></i></div>
    <div class="m-sub">${w.reset ? 'Reset. Waiting for new data' : esc(untilText(w.resetsAt))}</div>
  </div>`;
}

function usagePanel() {
  if (!state.usageOpen) return '';
  const u = state.usage;
  const has = u && (u.fiveHour || u.sevenDay);
  const src = u?.source === 'login' ? 'your Claude login' : 'Claude Code';
  const foot = has
    ? `Updated ${agoText(u.updatedAt)} · from ${src}`
    : u?.note
      ? esc(u.note)
      : 'Shows up after your next Claude Code reply';
  return `<div class="usage-panel">
    ${has ? `${usageMeter('Current session', u.fiveHour)}${usageMeter('This week', u.sevenDay)}` : `<div class="u-empty">No usage data yet</div>`}
    <div class="u-foot">${foot}</div>
  </div>`;
}

// ---------------------------------------------------------------- sound
let audio;
function chime(kind) {
  if (!state.prefs.sound) return;
  try {
    audio = audio || new AudioContext();
    const notes = kind === 'done' ? [880, 1318.5] : [659.25, 987.77];
    notes.forEach((f, i) => {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = audio.currentTime + i * 0.12;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.55);
    });
  } catch {}
}

// ---------------------------------------------------------------- views
function header() {
  const n = state.sessions.length;
  return `
  <div class="header">
    <div class="title"><h1>Agents</h1>${n ? `<span class="count">${n}</span>` : ''}</div>
    <div class="controls">
      <button class="icon-btn usage-btn${state.usageOpen ? ' on' : ''}" data-act="usage" title="Plan usage">${ring()}</button>
      <button class="icon-btn" data-act="sound" title="${state.prefs.sound ? 'Mute sounds' : 'Turn sounds on'}">${state.prefs.sound ? ICONS.sound : ICONS.mute}</button>
      <button class="icon-btn" data-act="collapse" title="Collapse">${ICONS.up}</button>
      <button class="icon-btn" data-act="hide" title="Hide (Glance keeps running in the tray)">${ICONS.close}</button>
    </div>
  </div>`;
}

function statusLine(s) {
  switch (s.status) {
    case 'permission':
      return `<div class="status orange"><span class="dot"></span>Needs your permission</div>`;
    case 'question':
      return `<div class="status purple"><span class="dot"></span>Has a question</div>`;
    case 'done': {
      const p = progressOf(s);
      const extra = p.total ? ` · ${p.total} steps` : '';
      return `<div class="status green">${ICONS.done}<span>Done${extra} in ${elapsed(s.startedAt, s.finishedAt)}</span></div>`;
    }
    case 'waiting':
      return `<div class="status waiting"><span class="dot"></span>${esc(s.activity)}</div>`;
    case 'background':
      return `<div class="status background"><span class="dot"></span>Reply done · ${s.busy} still working</div>`;
    default:
      return `<div class="sub">${esc(s.activity)}</div>`;
  }
}

function progressBar(s) {
  if (s.status === 'background') return `<div class="progress"><div class="bar indeterminate"><i></i></div></div>`;
  if (s.status !== 'running') return '';
  const p = progressOf(s);
  if (!p.total) return `<div class="progress"><div class="bar indeterminate"><i></i></div></div>`;
  return `<div class="progress"><div class="bar"><i style="width:${p.pct}%"></i></div><span class="fraction">${p.done} of ${p.total}</span></div>`;
}

function rowActions(s) {
  const clear =
    s.status === 'done'
      ? `<button class="icon-btn ok" data-act="dismiss" data-id="${esc(s.id)}" title="Cross off">${ICONS.check}</button>`
      : s.status === 'permission' || s.status === 'question'
        ? ''
        : `<button class="icon-btn plain" data-act="dismiss" data-id="${esc(s.id)}" title="Hide this session">${ICONS.close}</button>`;
  return `<div class="actions">
    <button class="icon-btn plain" data-act="jump" data-id="${esc(s.id)}" title="${s.inApp ? 'Open in Claude' : 'Open in VS Code'}">${ICONS.jump}</button>
    ${clear}
  </div>`;
}

// Sessions running in the Claude app ask there; Glance just makes sure you notice.
function elsewhereCard(s) {
  const r = s.request;
  const body =
    r.kind === 'permission'
      ? `<div class="request-head"><span class="eyebrow">${r.tool === 'Bash' ? 'Run command' : 'Use tool'}</span><span class="meta">${esc(r.tool)}${fromText(r)}</span></div>
    ${r.description ? `<div class="sub" style="white-space:normal">${esc(r.description)}</div>` : ''}
    <div class="code">${esc(r.preview)}</div>`
      : r.questions.map((q) => `<div class="q-text" style="font-size:15px;line-height:20px">${esc(q.question)}</div>`).join('');
  return `
  <div class="request">${body}</div>
  <div class="buttons">
    <button class="pill primary" data-act="jump" data-id="${esc(s.id)}">Answer in Claude</button>
  </div>`;
}

function fromText(r) {
  return r.from ? ` · from ${esc(r.from)}` : '';
}

function permissionCard(s) {
  const r = s.request;
  return `
  <div class="request">
    <div class="request-head"><span class="eyebrow">${r.tool === 'Bash' ? 'Run command' : 'Use tool'}</span><span class="meta">${esc(r.tool)}${fromText(r)}</span></div>
    ${r.description ? `<div class="sub" style="white-space:normal">${esc(r.description)}</div>` : ''}
    <div class="code">${esc(r.preview)}</div>
  </div>
  <div class="buttons">
    <button class="pill" data-act="perm" data-req="${esc(r.id)}" data-decision="deny">Deny</button>
    <button class="pill" data-act="perm" data-req="${esc(r.id)}" data-decision="always" title="Allow similar requests for the rest of this session">Always allow</button>
    <button class="pill primary" data-act="perm" data-req="${esc(r.id)}" data-decision="allow">Allow</button>
  </div>
  <button class="link" data-act="perm" data-req="${esc(r.id)}" data-decision="terminal">Answer in the terminal instead</button>`;
}

function questionCard(s) {
  const r = s.request;
  const d = draftFor(r);
  const qs = r.questions
    .map((q, qi) => {
      const multi = q.multiSelect;
      const opts = q.options
        .map(
          (o, oi) => `
        <button class="option${multi ? ' multi' : ''}${d.picks[qi].has(o.label) ? ' on' : ''}" data-act="pick" data-req="${esc(r.id)}" data-q="${qi}" data-o="${oi}">
          <span class="radio"></span>
          <span><div class="o-label">${esc(o.label)}</div>${o.description ? `<div class="o-desc">${esc(o.description)}</div>` : ''}</span>
        </button>`
        )
        .join('');
      return `
      ${q.header ? `<div class="q-header">${esc(q.header)}</div>` : ''}
      <div class="q-text">${esc(q.question)}</div>
      <div class="options">${opts}</div>
      <div class="reply">
        <input type="text" placeholder="Or type your own answer…" data-input="${esc(r.id)}" data-q="${qi}" value="${esc(d.text[qi])}" />
        ${qi === r.questions.length - 1 ? `<button class="pill purple" data-act="send" data-req="${esc(r.id)}"${ready(r) ? '' : ' disabled'}>Send</button>` : ''}
      </div>`;
    })
    .join('');
  return `${r.from ? `<div class="meta">Asked by ${esc(r.from)}</div>` : ''}${qs}<button class="link" data-act="send-terminal" data-req="${esc(r.id)}">Answer in the terminal instead</button>`;
}

function ready(r) {
  const d = draftFor(r);
  return r.questions.every((_, i) => d.picks[i].size > 0 || d.text[i].trim());
}

// Running subagents and background tasks, so parallel work stays visible.
function workItems(s) {
  const items = (s.children || [])
    .filter((c) => c.status === 'running')
    .map((c) => ({ kind: agentKind(c.type), label: c.label, activity: c.activity, startedAt: c.startedAt, status: 'running' }));
  const childLabels = new Set(items.map((i) => i.label));
  for (const t of s.tasks || []) {
    if (t.type === 'subagent' && childLabels.has(t.label)) continue;
    items.push({ kind: taskKind(t), label: t.label, activity: '', status: 'running' });
  }
  return items;
}

// "general-purpose" is the default subagent: just call it an agent.
function agentKind(type) {
  return !type || type === 'general-purpose' ? 'Agent' : type;
}

function taskKind(t) {
  if (t.type === 'subagent') return agentKind(t.agentType);
  if (t.type === 'shell') return 'Shell';
  return t.type ? t.type.charAt(0).toUpperCase() + t.type.slice(1) : 'Task';
}

function childLines(s) {
  if (s.status === 'permission' || s.status === 'question') return '';
  const items = workItems(s);
  if (!items.length) return '';
  const shown = items.slice(0, 3);
  const more = items.length - shown.length;
  return `<div class="kids">${shown
    .map(
      (k) => `<div class="kid">${ICONS.spinner}<span class="k-type">${esc(k.kind)}</span><span class="k-text">${esc(k.label || k.activity || 'Working')}${k.label && k.activity && k.activity !== 'Starting' ? ` · ${esc(k.activity)}` : ''}</span></div>`
    )
    .join('')}${more > 0 ? `<div class="kid more">+${more} more</div>` : ''}</div>`;
}

function row(s) {
  const attention = s.status === 'permission' || s.status === 'question';
  return `
  <section class="row ${attention ? s.status : 'clickable'}" data-open="${esc(s.id)}">
    <div class="row-main">
      ${avatar(s)}
      <div class="info">
        <div class="name">${esc(displayName(s))}</div>
        ${s.status === 'running' ? `<div class="sub">${esc(s.activity)}</div>` : statusLine(s)}
        ${progressBar(s)}
      </div>
      ${rowActions(s)}
    </div>
    ${childLines(s)}
    ${s.request?.elsewhere ? elsewhereCard(s) : ''}
    ${s.status === 'permission' && s.request && !s.request.elsewhere ? permissionCard(s) : ''}
    ${s.status === 'question' && s.request && !s.request.elsewhere ? questionCard(s) : ''}
  </section>`;
}

function emptyState() {
  if (!state.prefs.connected) {
    return `<div class="empty-state"><strong>Not connected to Claude Code</strong>
      <span>Glance needs a few hooks in your Claude Code settings to see your sessions.</span>
      <button class="pill primary" data-act="connect">Connect</button></div>`;
  }
  return `<div class="empty-state"><strong>No agents running</strong>
    <span>Start Claude Code in VS Code or a terminal and each session shows up here. New sessions appear as soon as you send a prompt.</span></div>`;
}

// Older installs have hooks that can't tell Glance which Claude conversation they belong to.
function updateBanner() {
  if (!state.prefs.connected || !state.prefs.outdated) return '';
  return `<div class="banner"><span>Update the connection to see subagents, background work and your usage.</span>
    <button class="pill primary" data-act="connect">Update</button></div>`;
}

function listView() {
  return `<div class="glass widget list">${header()}${usagePanel()}${updateBanner()}<div class="rows">${state.sessions.length ? state.sessions.map(row).join('') : emptyState()}</div></div>`;
}

function detailView(s) {
  const p = progressOf(s);
  const current = s.steps.find((t) => t.status === 'in_progress');
  const steps = s.steps.length
    ? s.steps
        .map((t) => {
          const icon = t.status === 'completed' ? ICONS.done : t.status === 'in_progress' ? ICONS.spinner : ICONS.pending;
          const label = t.status === 'in_progress' ? t.active : t.text;
          const tag = t.status === 'in_progress' ? 'Running' : '';
          return `<div class="step ${esc(t.status)}">${icon}<span class="s-text">${esc(label)}</span><span class="s-tag">${tag}</span></div>`;
        })
        .join('')
    : s.log.length
      ? s.log
          .slice(-8)
          .map((l, i, arr) => {
            const last = i === arr.length - 1 && s.status === 'running';
            return `<div class="step ${last ? 'in_progress' : 'completed'}">${last ? ICONS.spinner : ICONS.done}<span class="s-text">${esc(l.text)}</span><span class="s-tag">${l.kind === 'prompt' ? 'You' : ''}</span></div>`;
          })
          .join('')
      : `<div class="empty">No steps yet.</div>`;

  return `
  <div class="glass widget detail">
    <div class="detail-head">
      <button class="icon-btn" data-act="back" title="Back">${ICONS.back}</button>
      ${avatar(s, true)}
      <div class="info"><div class="name">${esc(displayName(s))}</div><div class="sub">${esc(s.cwd)} · ${elapsed(s.startedAt, s.finishedAt)}</div></div>
      <button class="icon-btn" data-act="jump" data-id="${esc(s.id)}" title="${s.inApp ? 'Open in Claude' : 'Open in VS Code'}">${ICONS.jump}</button>
    </div>
    ${s.status === 'permission' || s.status === 'question' ? row(s) : `
    <div class="detail-progress">
      <div class="top"><span>${esc(current ? current.active : s.activity)}</span><span>${p.total ? `${p.done} of ${p.total}` : ''}</span></div>
      <div class="bar${(p.total || s.status !== 'running') && s.status !== 'background' ? '' : ' indeterminate'}"><i style="width:${p.total ? p.pct : s.status === 'done' ? 100 : 35}%"></i></div>
    </div>`}
    <div class="steps">${steps}</div>
    ${workSection(s)}
    ${s.lastCommand ? `
    <div class="terminal">
      <div class="t-head">${ICONS.terminal}<span class="eyebrow" style="color:inherit">Last command</span></div>
      <div class="code"><b>$</b> ${esc(s.lastCommand)}</div>
    </div>` : ''}
  </div>`;
}

function workSection(s) {
  const running = workItems(s);
  const done = (s.children || []).filter((c) => c.status !== 'running').slice(-6).reverse();
  if (!running.length && !done.length) return '';
  const line = (icon, cls, kind, text, tag) =>
    `<div class="step ${cls}">${icon}<span class="k-type">${esc(kind)}</span><span class="s-text">${esc(text)}</span><span class="s-tag">${tag}</span></div>`;
  const rows = [
    ...running.map((k) =>
      line(ICONS.spinner, 'in_progress', k.kind, k.label ? `${k.label}${k.activity && k.activity !== 'Starting' ? ` · ${k.activity}` : ''}` : k.activity || 'Working', k.startedAt ? elapsed(k.startedAt) : 'Running')
    ),
    ...done.map((c) => line(c.activity === 'Stopped responding' ? ICONS.pending : ICONS.done, 'completed', agentKind(c.type), c.label || agentKind(c.type), c.finishedAt ? elapsed(c.startedAt, c.finishedAt) : '')),
  ];
  return `<div class="section-title"><span class="eyebrow">Subagents and background</span><span class="meta">${running.length ? `${running.length} working` : 'All finished'}</span></div>
    <div class="steps work">${rows.join('')}</div>`;
}

function collapsedView() {
  const n = state.sessions.length;
  const attn = state.sessions.filter((s) => s.status === 'permission' || s.status === 'question').length;
  const running = state.sessions.filter((s) => s.status === 'running' || s.status === 'background').length;
  const minis = state.sessions.slice(0, 4).map((s) => `<div class="mini t-${esc(PETS.traits(s.id, s.color).color)}">${PETS.petSvg(s, 24)}</div>`).join('');
  return `
  <div class="glass capsule">
    ${n ? `<div class="stack">${minis}</div>` : ''}
    <div class="info">
      <div class="name">${n ? `${n} agent${n > 1 ? 's' : ''}${running ? ' working' : ''}` : 'No agents'}</div>
      ${attn ? `<div class="attn">${attn} need${attn > 1 ? '' : 's'} you</div>` : `<div class="calm">${running ? 'All good' : 'Idle'}</div>`}
    </div>
    <button class="icon-btn usage-btn" data-act="usage-expand" title="Plan usage">${ring()}</button>
    <button class="icon-btn" data-act="expand" title="Expand">${ICONS.down}</button>
  </div>`;
}

// ---------------------------------------------------------------- render
function render() {
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.input ? `${focused.dataset.input}:${focused.dataset.q}` : null;
  const caret = focusKey ? focused.selectionStart : null;

  let html;
  if (state.prefs.collapsed) html = collapsedView();
  else if (state.view !== 'list') {
    const s = state.sessions.find((x) => x.id === state.view);
    if (!s) state.view = 'list';
    html = s ? detailView(s) : listView();
  } else html = listView();
  // Update the page in place: only what changed is touched, so pets keep animating,
  // the list keeps its scroll position and nothing flashes on each update.
  const next = document.createElement('main');
  next.innerHTML = state.prefs.collapsed ? html : html + GRIP;
  morphChildren(root, next);
  applySize();

  if (focusKey) {
    const [req, q] = focusKey.split(':');
    const el = root.querySelector(`input[data-input="${CSS.escape(req)}"][data-q="${q}"]`);
    if (el) {
      el.focus();
      el.setSelectionRange(caret, caret);
    }
  }
  requestAnimationFrame(reportHeight);
}

// Tiny DOM patcher: keeps nodes that did not change and edits the ones that did.
function morphChildren(from, to) {
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  for (let i = 0; i < b.length; i++) {
    const want = b[i];
    const have = a[i];
    if (!have) {
      from.appendChild(want);
      continue;
    }
    morphNode(have, want);
  }
  for (let i = b.length; i < a.length; i++) a[i].remove();
}

function morphNode(have, want) {
  if (have.nodeType !== want.nodeType || have.nodeName !== want.nodeName || (have.dataset && have.dataset.open !== want.dataset?.open)) {
    have.replaceWith(want);
    return;
  }
  if (have.nodeType === Node.TEXT_NODE || have.nodeType === Node.COMMENT_NODE) {
    if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
    return;
  }
  if (have.nodeType !== Node.ELEMENT_NODE) return;
  for (const { name, value } of [...want.attributes]) {
    if (have.getAttribute(name) !== value) have.setAttribute(name, value);
  }
  for (const { name } of [...have.attributes]) {
    if (!want.hasAttribute(name)) have.removeAttribute(name);
  }
  if (have.tagName === 'INPUT') {
    if (document.activeElement !== have && have.value !== want.value) have.value = want.value;
    return;
  }
  if (have.innerHTML === want.innerHTML) return;
  morphChildren(have, want);
}

let lastReported = 0;
function reportHeight() {
  const h = Math.ceil(root.getBoundingClientRect().height);
  if (h === lastReported) return;
  lastReported = h;
  api.resize(h);
}

new ResizeObserver(reportHeight).observe(root);

// Drag the bottom-left corner to scale the whole widget. The main process
// tracks the cursor itself, because page coordinates shift as the zoom changes.
root.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip || e.button !== 0) return;
  dragging = true;
  grip.classList.add('dragging');
  grip.setPointerCapture(e.pointerId);
  api.userResize({ start: true });
  e.preventDefault();
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  e.target.closest?.('.grip')?.classList.remove('dragging');
  api.userResize({ done: true });
  render();
}
root.addEventListener('pointerup', endDrag);
root.addEventListener('pointercancel', endDrag);
root.addEventListener('lostpointercapture', endDrag);
root.addEventListener('dblclick', (e) => {
  if (!e.target.closest('.grip')) return;
  api.userResize({ width: 400, height: null, done: true });
});

// ---------------------------------------------------------------- events
root.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) {
    const open = e.target.closest('[data-open]');
    if (open && !open.classList.contains('permission') && !open.classList.contains('question') && state.view === 'list') {
      state.view = open.dataset.open;
      render();
    }
    return;
  }
  e.stopPropagation();
  const { act, id, req } = btn.dataset;
  switch (act) {
    case 'sound':
      state.prefs.sound = !state.prefs.sound;
      api.sound(state.prefs.sound);
      render();
      break;
    case 'collapse':
      state.prefs.collapsed = true;
      api.collapse(true);
      render();
      break;
    case 'expand':
      state.prefs.collapsed = false;
      api.collapse(false);
      render();
      break;
    case 'hide':
      api.hide();
      break;
    case 'usage':
      state.usageOpen = !state.usageOpen;
      if (state.usageOpen) api.refreshUsage?.();
      render();
      break;
    case 'usage-expand':
      state.prefs.collapsed = false;
      state.usageOpen = true;
      api.collapse(false);
      api.refreshUsage?.();
      render();
      break;
    case 'connect':
      api.connect();
      break;
    case 'back':
      state.view = 'list';
      render();
      break;
    case 'jump':
      api.jump(id);
      break;
    case 'dismiss':
      api.dismiss(id);
      break;
    case 'perm':
      api.permission(req, btn.dataset.decision);
      break;
    case 'pick': {
      const s = state.sessions.find((x) => x.request && x.request.id === req);
      if (!s) return;
      const d = draftFor(s.request);
      const q = s.request.questions[+btn.dataset.q];
      const label = q.options[+btn.dataset.o].label;
      const set = d.picks[+btn.dataset.q];
      if (q.multiSelect) set.has(label) ? set.delete(label) : set.add(label);
      else {
        const was = set.has(label);
        set.clear();
        if (!was) set.add(label);
      }
      render();
      break;
    }
    case 'send': {
      const s = state.sessions.find((x) => x.request && x.request.id === req);
      if (!s || !ready(s.request)) return;
      const d = draftFor(s.request);
      const answers = s.request.questions.map((_, i) => {
        const parts = [...d.picks[i]];
        if (d.text[i].trim()) parts.push(d.text[i].trim());
        return parts.join(', ');
      });
      api.answer(req, answers);
      delete state.drafts[req];
      break;
    }
    case 'send-terminal':
      api.answer(req, 'terminal');
      delete state.drafts[req];
      break;
  }
});

root.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.input) return;
  const s = state.sessions.find((x) => x.request && x.request.id === el.dataset.input);
  if (!s) return;
  draftFor(s.request).text[+el.dataset.q] = el.value;
  const send = root.querySelector(`[data-act="send"][data-req="${CSS.escape(el.dataset.input)}"]`);
  if (send) send.disabled = !ready(s.request);
});

root.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset?.input) {
    root.querySelector(`[data-act="send"][data-req="${CSS.escape(e.target.dataset.input)}"]`)?.click();
  }
  if (e.key === 'Escape' && state.usageOpen) {
    state.usageOpen = false;
    render();
    return;
  }
  if (e.key === 'Escape' && state.view !== 'list') {
    state.view = 'list';
    render();
  }
});

// ---------------------------------------------------------------- wiring
let previous = new Map();
let renderQueued = false;
api.onSessions((sessions) => {
  for (const s of sessions) {
    const before = previous.get(s.id);
    if (before && before !== 'done' && s.status === 'done') chime('done');
  }
  previous = new Map(sessions.map((s) => [s.id, s.status]));
  state.sessions = sessions;
  // Busy sessions send many updates a second; draw at most once per frame.
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }
});
api.onPrefs((p) => {
  state.prefs = { ...state.prefs, ...p };
  if (dragging) {
    applySize();
    return;
  }
  render();
});
api.onAttention(({ id }) => {
  chime('attention');
  if (state.view !== 'list' && state.view !== id) state.view = 'list';
  render();
  const el = root.querySelector(`[data-open="${CSS.escape(id)}"]`);
  if (el) {
    el.classList.add('shake');
    // Requests sit at the top of the list, so scroll up to show it.
    const rows = root.querySelector('.rows');
    if (rows) rows.scrollTop = 0;
    el.scrollIntoView({ block: 'nearest' });
  }
});

setInterval(() => {
  if (state.sessions.some((s) => s.status === 'done' || s.status === 'background') || state.view !== 'list' || state.usageOpen) {
    if (!document.activeElement?.dataset?.input) render();
  }
}, 15000);

api.onUsage?.((u) => {
  state.usage = u;
  render();
});

api.init().then(({ sessions, prefs, usage }) => {
  state.sessions = sessions;
  state.usage = usage || null;
  state.prefs = { ...state.prefs, ...prefs };
  previous = new Map(sessions.map((s) => [s.id, s.status]));
  render();
});
