// Renders the real widget with an optional theme stylesheet. Usage: node render.js <theme|current> <out.png> [dom.json]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const [theme, out, domOut] = process.argv.slice(2);
const now = Date.now();
const sessions = [
  { id: 'idea-scout-1', project: 'idea-scout', title: 'Score trending videos', status: 'permission', activity: 'Waiting', steps: [], log: [], startedAt: now - 200000,
    request: { id: 'r1', kind: 'permission', tool: 'Bash', preview: 'python scripts/score.py --videos 140' } },
  { id: 'reel-kit-2', project: 'reel-kit', title: 'Polish watch videos', status: 'running', activity: 'Rendering 02-problem.mp4', startedAt: now - 400000, log: [],
    steps: [1,2,3,4,5,6].map((i) => ({ text: 's' + i, active: 's' + i, status: i <= 3 ? 'completed' : i === 4 ? 'in_progress' : 'pending' })) },
  { id: 'frameduels-3', project: 'frameduels', title: 'Netcode pass', status: 'done', activity: 'Done', startedAt: now - 252000, finishedAt: now, log: [],
    steps: [1,2,3,4,5,6].map((i) => ({ text: 's' + i, active: 's' + i, status: 'completed' })) },
];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 408, height: 700 }, deviceScaleFactor: 2 });
  await p.addInitScript(({ sessions }) => {
    const noop = () => {};
    window.glance = { init: () => Promise.resolve({ sessions, prefs: { sound: true, connected: true, collapsed: false } }),
      onSessions: noop, onPrefs: noop, onAttention: noop, permission: noop, answer: noop, dismiss: noop, jump: noop,
      hide: noop, collapse: noop, sound: noop, connect: noop, resize: noop, userResize: noop };
  }, { sessions });
  await p.goto('file://' + path.resolve(__dirname, '../renderer/index.html'));
  if (theme !== 'current') await p.addStyleTag({ content: fs.readFileSync(path.join(__dirname, 'themes', theme + '.css'), 'utf8') });
  await p.addStyleTag({ content: 'html,body{background:#0b0b0d} *{animation:none!important;transition:none!important}' });
  await p.waitForTimeout(400);
  const el = await p.$('.widget');
  await el.screenshot({ path: out });
  if (domOut) {
    const tree = await p.evaluate(() => {
      const KEEP = ['display','flexDirection','alignItems','justifyContent','alignSelf','gap','flexGrow','flexShrink','flexBasis','paddingTop','paddingRight','paddingBottom','paddingLeft','width','height','backgroundColor','backgroundImage','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderTopStyle','borderRightStyle','borderBottomStyle','borderLeftStyle','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius','boxShadow','color','fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','lineHeight','textTransform','whiteSpace','overflow','textAlign'];
      const kebab = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      function styleOf(e, isText) {
        const c = getComputedStyle(e);
        const out = [];
        for (const k of KEEP) {
          let v = c[k];
          if (!v || v === 'none' || v === 'normal' && k !== 'whiteSpace' || v === 'auto' && !['width','height'].includes(k)) continue;
          if (/^border.*Width$/.test(k) && v === '0px') continue;
          if (/^border.*(Style|Color)$/.test(k) && c[k.replace(/Style|Color/, 'Width')] === '0px') continue;
          if (/Radius$/.test(k) && v === '0px') continue;
          if (/^padding/.test(k) && v === '0px') continue;
          if (k === 'backgroundColor' && v === 'rgba(0, 0, 0, 0)') continue;
          if (k === 'boxShadow' && /inset/.test(v) === false) {} 
          if (['width','height'].includes(k)) { const r = e.getBoundingClientRect(); v = Math.round(r[k] * 100) / 100 + 'px'; }
          if (k === 'fontFamily') v = v.replace(/"Glance Inter"/g, 'Inter').replace(/"Glance Mono"/g, '"JetBrains Mono"').replace(/"Inter Display"/g, '"Inter Tight"');
          out.push(kebab(k) + ':' + v);
        }
        return out.join(';');
      }
      function walk(e) {
        if (e.nodeType === 3) return e.nodeValue.trim() ? { text: e.nodeValue.replace(/\s+/g, ' ') } : null;
        if (e.nodeType !== 1) return null;
        const c = getComputedStyle(e);
        if (c.display === 'none' || e.classList.contains('grip')) return null;
        if (e.tagName.toLowerCase() === 'svg') {
          const clone = e.cloneNode(true);
          clone.querySelectorAll('.legs-b,.pet-shadow').forEach((n) => n.remove());
          const r = e.getBoundingClientRect();
          clone.setAttribute('width', r.width); clone.setAttribute('height', r.height);
          clone.removeAttribute('class'); clone.removeAttribute('style');
          return { svg: clone.outerHTML.replace(/currentColor/g, c.color) };
        }
        const kids = [...e.childNodes].map(walk).filter(Boolean);
        const before = getComputedStyle(e, '::before').content;
        if (before && before !== 'none' && before !== 'normal') kids.unshift({ text: JSON.parse(before), pseudo: true });
        return { tag: e.tagName.toLowerCase(), cls: e.className, style: styleOf(e), kids };
      }
      return walk(document.querySelector('.widget'));
    });
    fs.writeFileSync(domOut, JSON.stringify(tree));
  }
  await b.close();
})();
