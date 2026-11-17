'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, Notification, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { Store } = require('./src/store');
const { startServer, DEFAULT_PORT } = require('./src/server');
const hooks = require('./src/hooks-config');

const PORT = Number(process.env.GLANCE_PORT) || DEFAULT_PORT;
const PAD = 8; // thin transparent margin around the widget
const MARGIN = 4;
const MIN_W = 320;
const MAX_W = 760;
const MIN_H = 140;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId('app.glance.widget');

// Reads just the start of a transcript to learn where the session runs (terminal, Claude app, IDE).
function readEntrypoint(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"entrypoint"\s*:\s*"([^"]+)"/.exec(buf.toString('utf8', 0, n));
    return m ? m[1] : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
}
const store = new Store({ readEntrypoint, statMtime });
setInterval(() => store.sweep(), 60 * 1000).unref?.();
let win = null;
let tray = null;
let collapsed = false;
let quitting = false;
let prefs = { sound: true, setupDone: false, notifications: true, width: 400, height: null };
// Resizing scales the whole widget: text, pets, buttons and spacing all grow together.
const BASE_W = 400;
const zoom = () => prefs.width / BASE_W;
const winWidth = () => Math.round((BASE_W + PAD) * zoom());
function applyZoom() {
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom());
}

const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
function loadPrefs() {
  try {
    prefs = { ...prefs, ...JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) };
  } catch {}
  prefs.width = Math.max(MIN_W, Math.min(MAX_W, Number(prefs.width) || BASE_W));
  prefs.height = Number(prefs.height) > 0 ? Math.round(prefs.height) : null;
}
function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch {}
}

function asset(name) {
  return path.join(__dirname, 'assets', name);
}

function topRight(height) {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - winWidth() - MARGIN, y: workArea.y + MARGIN, width: winWidth(), height };
}

function createWindow() {
  win = new BrowserWindow({
    ...topRight(120),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Glance',
    icon: asset('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', applyZoom);
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.showInactive();
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  win.moveTop();
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function buildTrayMenu() {
  const loginItem = app.getLoginItemSettings();
  const connected = hooks.isInstalled(PORT);
  return Menu.buildFromTemplate([
    { label: 'Show Glance', click: showWindow },
    { type: 'separator' },
    {
      label: connected ? 'Connected to Claude Code' : 'Connect to Claude Code',
      type: 'checkbox',
      checked: connected,
      click: (item) => {
        try {
          if (item.checked) hooks.install(PORT);
          else hooks.uninstall(PORT);
        } catch (err) {
          new Notification({ title: 'Glance', body: `Couldn't update Claude Code settings: ${err.message}` }).show();
        }
        refreshTray();
        send('prefs', publicPrefs());
      },
    },
    {
      label: 'Open when my computer starts',
      type: 'checkbox',
      checked: loginItem.openAtLogin,
      click: (item) => {
        setOpenAtLogin(item.checked);
        refreshTray();
      },
    },
    {
      label: 'Play sounds',
      type: 'checkbox',
      checked: prefs.sound,
      click: (item) => {
        prefs.sound = item.checked;
        savePrefs();
        send('prefs', publicPrefs());
      },
    },
    {
      label: 'Show notifications',
      type: 'checkbox',
      checked: prefs.notifications,
      click: (item) => {
        prefs.notifications = item.checked;
        savePrefs();
      },
    },
    {
      label: 'Reset widget size',
      click: () => {
        prefs.width = BASE_W;
        prefs.height = null;
        savePrefs();
        applyZoom();
        layout();
        send('prefs', publicPrefs());
      },
    },
    { type: 'separator' },
    { label: 'Quit Glance', click: () => { quitting = true; app.quit(); } },
  ]);
}

let trayKey = '';
function refreshTray() {
  if (!tray) return;
  const n = store.attentionCount();
  const total = store.snapshot().length;
  const tip = n ? `Glance · ${n} agent${n > 1 ? 's' : ''} need you` : `Glance · ${total} agent${total === 1 ? '' : 's'}`;
  // Tool calls arrive many times a second; only touch the tray when something it shows changed.
  const key = `${tip}|${hooks.isInstalled(PORT)}|${prefs.sound}|${prefs.notifications}|${app.getLoginItemSettings().openAtLogin}`;
  if (key === trayKey) return;
  trayKey = key;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(tip);
}

function setOpenAtLogin(on) {
  const opts = { openAtLogin: on };
  if (!app.isPackaged) {
    // Dev mode: launch electron with this folder.
    opts.path = process.execPath;
    opts.args = [path.resolve(__dirname)];
  }
  app.setLoginItemSettings(opts);
}

function publicPrefs() {
  const area = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const maxH = Math.max(240, Math.floor((area.height - 60) / zoom()));
  // A height the user dragged to, in page pixels (minus the 4px margin above and below).
  const fixedH = prefs.height ? Math.max(100, Math.floor(prefs.height / zoom()) - 8) : null;
  const connected = hooks.isInstalled(PORT);
  const outdated = connected && !hooks.isCurrent(PORT);
  return { sound: prefs.sound, connected, outdated, collapsed, width: prefs.width, maxH, fixedH };
}

function jumpTo(sessionId) {
  const s = store.sessions.get(sessionId);
  if (!s) return;
  // Sessions from the Claude app (projects, Remote Control, desktop) live in the app.
  if (s.entrypoint && s.entrypoint !== 'cli') {
    if (/vscode/i.test(s.entrypoint) && s.cwd) {
      spawn('code', [s.cwd], { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
    } else {
      // Opens that exact conversation when we know its id, otherwise just the app.
      const url = s.hostId ? `claude://code/continue?session=${encodeURIComponent(s.hostId)}` : 'claude://';
      shell.openExternal(url).catch(() => {});
    }
    return;
  }
  if (!s.cwd) return;
  // Opens (or focuses) the VS Code window for that folder; falls back to Explorer/Finder.
  try {
    const child = spawn('code', [s.cwd], { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => shell.openPath(s.cwd));
    child.on('exit', (code) => { if (code) shell.openPath(s.cwd); });
    child.unref();
  } catch {
    shell.openPath(s.cwd);
  }
}

function wireIpc() {
  ipcMain.handle('glance:init', () => ({ sessions: store.snapshot(), prefs: publicPrefs() }));
  ipcMain.on('glance:permission', (_e, { requestId, decision }) => store.respondPermission(requestId, decision));
  ipcMain.on('glance:answer', (_e, { requestId, answers }) => store.respondQuestion(requestId, answers));
  ipcMain.on('glance:dismiss', (_e, sessionId) => store.dismiss(sessionId));
  ipcMain.on('glance:jump', (_e, sessionId) => jumpTo(sessionId));
  ipcMain.on('glance:hide', () => win?.hide());
  ipcMain.on('glance:collapse', (_e, value) => {
    collapsed = !!value;
    send('prefs', publicPrefs());
  });
  ipcMain.on('glance:sound', (_e, value) => {
    prefs.sound = !!value;
    savePrefs();
    refreshTray();
    send('prefs', publicPrefs());
  });
  ipcMain.on('glance:connect', () => {
    try {
      hooks.install(PORT);
    } catch {}
    refreshTray();
    send('prefs', publicPrefs());
  });
  ipcMain.on('glance:resize', (_e, height) => {
    contentH = height;
    layout();
  });
  ipcMain.on('glance:user-resize', (_e, { start, width, height, done }) => {
    if (start) startScaleDrag();
    if (typeof width === 'number' || height !== undefined) setSize(width, height);
    if (done) {
      stopScaleDrag();
      savePrefs();
      send('prefs', publicPrefs());
    }
  });
}

// ---------------------------------------------------------------- sizing
let contentH = 120; // last height the renderer reported, in page pixels
let drag = null;

function layout() {
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  // The renderer reports its height in page pixels; the window needs screen pixels.
  const want = !collapsed && prefs.height ? prefs.height : Math.ceil(contentH * zoom());
  const h = Math.max(60, Math.min(want, workArea.height - MARGIN * 2));
  const b = win.getBounds();
  const w = winWidth();
  // Keep the right edge where it is, so the widget grows leftwards from its corner.
  if (b.height !== h || b.width !== w) win.setBounds({ x: b.x + b.width - w, y: b.y, width: w, height: h });
}

// width scales everything; height (screen pixels, or null to fit the content)
// only changes how much of the list shows.
function setSize(width, height) {
  let changed = false;
  if (typeof width === 'number') {
    const next = Math.round(Math.max(MIN_W, Math.min(MAX_W, width)));
    if (next !== prefs.width) {
      prefs.width = next;
      applyZoom();
      changed = true;
    }
  }
  if (height !== undefined) {
    let next = null;
    if (typeof height === 'number' && win) {
      const { workArea } = screen.getDisplayMatching(win.getBounds());
      next = Math.round(Math.max(MIN_H, Math.min(workArea.height - MARGIN * 2, height)));
    }
    if (next !== prefs.height) {
      prefs.height = next;
      changed = true;
    }
  }
  if (!changed) return;
  layout();
  send('prefs', publicPrefs());
}

function startScaleDrag() {
  stopScaleDrag();
  const p = screen.getCursorScreenPoint();
  drag = { x: p.x, y: p.y, w: prefs.width, h: win ? win.getBounds().height : 300 };
  // Left/right scales the whole widget; up/down sets how tall it is.
  drag.timer = setInterval(() => {
    const c = screen.getCursorScreenPoint();
    const dx = drag.x - c.x;
    const dy = c.y - drag.y;
    if (Math.abs(dy) > 3) drag.vertical = true;
    // Until you move up or down, the height keeps fitting the content.
    setSize(drag.w + dx, drag.vertical || prefs.height ? drag.h + dy : undefined);
  }, 16);
}

function stopScaleDrag() {
  if (drag) clearInterval(drag.timer);
  drag = null;
}

app.whenReady().then(async () => {
  loadPrefs();

  if (!prefs.setupDone) {
    // First launch: hook into Claude Code and start with the computer.
    try {
      hooks.install(PORT);
    } catch (err) {
      console.error('Glance: could not install hooks', err);
    }
    setOpenAtLogin(true);
    prefs.setupDone = true;
    savePrefs();
  }

  try {
    await startServer(store, { port: PORT });
  } catch (err) {
    new Notification({ title: 'Glance', body: `Port ${PORT} is busy. Is Glance already running?` }).show();
  }

  wireIpc();
  createWindow();

  const trayIcon = nativeImage.createFromPath(asset(process.platform === 'win32' ? 'tray.png' : 'trayTemplate.png'));
  tray = new Tray(trayIcon.isEmpty() ? nativeImage.createFromPath(asset('icon.png')).resize({ width: 16 }) : trayIcon);
  tray.on('click', () => (win.isVisible() ? win.hide() : showWindow()));
  refreshTray();

  store.on('change', (sessions) => {
    send('sessions', sessions);
    refreshTray();
  });
  store.on('attention', ({ session, kind }) => {
    showWindow();
    if (collapsed) {
      collapsed = false;
      send('prefs', publicPrefs());
    }
    send('attention', { id: session.id, kind });
    if (prefs.notifications && Notification.isSupported()) {
      const n = new Notification({
        title: `${session.title || session.project} ${kind === 'permission' ? 'needs permission' : 'has a question'}`,
        body: kind === 'permission' ? session.request?.preview || '' : session.request?.questions?.[0]?.question || '',
        silent: true,
      });
      n.on('click', showWindow);
      n.show();
    }
  });
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault());
