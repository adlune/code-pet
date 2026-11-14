const { app, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, nativeImage, powerMonitor, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { describeTool, summarize, lastAssistantText } = require('./events');
const petIcon = require('./icon');
const assistant = require('./assistant'); // optional local AI assistant, off by default

const PORT = Number(process.env.CODE_PET_PORT) || 47321;
const WIN_W = 300;
const WIN_H = 300;
const FOOT_PAD = 16; // transparent strip below the pet's feet (must match renderer/pet.js)
const STALE_MS = 3 * 60 * 60 * 1000;
// Notification types that mean "come back, Claude is blocked on you" vs. just FYI.
const NEEDS_YOU = new Set(['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const INFO = new Set(['agent_completed', 'plugin_notification']);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (!app.isPackaged) app.setAppUserModelId(process.execPath);
else app.setAppUserModelId('com.code-pet.app');

let win = null;
let tray = null;
let dragTimer = null;
const sessions = new Map(); // session_id -> { id, project, cwd, status, activity, updated, turnStart }

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  bubbles: true,
  toastWaiting: true,
  toastDone: true,
  doneToastMinSeconds: 30,
  wander: true,
  ...assistant.DEFAULTS,
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    settings = { ...DEFAULTS };
  }
}
function setSetting(key, value) {
  settings[key] = value;
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {}
  send('settings', settings);
  assistant.onSettingChanged(key);
  refreshTray();
}

// ---------- window ----------
function workAreaFor(x, y) {
  return screen.getDisplayNearestPoint({ x: Math.round(x + WIN_W / 2), y: Math.round(y + WIN_H - 10) }).workArea;
}
function homePosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_W - 40, y: wa.y + wa.height - WIN_H + FOOT_PAD };
}
// The window is much wider than the pet (room for bubbles), so its transparent sides may hang
// off-screen: the horizontal limits are set so the pet's *body* touches the screen edge.
let petHalfWidth = 32; // reported by the renderer (half the sprite's visible width, in px)
function xBounds(wa) {
  const inset = Math.max(0, Math.floor(WIN_W / 2 - petHalfWidth));
  return { minX: wa.x - inset, maxX: wa.x + wa.width - WIN_W + inset };
}
let lastEdges = '';
function place(x, y) {
  if (!win) return;
  x = Math.round(x);
  y = Math.round(y);
  win.setBounds({ x, y, width: WIN_W, height: WIN_H });
  // tell the renderer how much of the window is off-screen so it can keep bubbles visible
  const wa = workAreaFor(x, y);
  const edges = { left: Math.max(0, wa.x - x), right: Math.max(0, x + WIN_W - (wa.x + wa.width)) };
  const key = `${edges.left},${edges.right}`;
  if (key !== lastEdges) (lastEdges = key), send('edges', edges);
  assistant.onPetMoved();
}

function createWindow(pos = homePosition()) {
  const { x, y } = pos;
  lastEdges = '';
  win = new BrowserWindow({
    x,
    y,
    icon: makeIcon(4),
    width: WIN_W,
    height: WIN_H,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    send('settings', settings);
    pushSessions();
    const [px, py] = win.getPosition();
    place(px, py); // sends the current screen edges to the fresh renderer
  });
}

// Re-apply always-on-top once
function reassertTop() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(false);
  win.setAlwaysOnTop(true, 'floating');
}

// Tray → "Reload pet".
function reloadPet() {
  const old = win;
  const pos = old && !old.isDestroyed() ? { x: old.getPosition()[0], y: old.getPosition()[1] } : homePosition();
  clearInterval(dragTimer);
  dragTimer = null;
  createWindow(pos); // create first so the app never has zero windows
  if (old && !old.isDestroyed()) old.destroy();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- IPC from renderer ----------
ipcMain.on('metrics', (_e, m) => {
  if (m && m.halfWidth > 0 && m.halfWidth < WIN_W / 2) petHalfWidth = m.halfWidth;
});

ipcMain.on('set-ignore', (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.handle('move-by', (_e, dx, dy) => {
  if (!win || dragTimer) return { hitX: false, onGround: true };
  const [x, y] = win.getPosition();
  const wa = workAreaFor(x, y);
  const ground = wa.y + wa.height - WIN_H + FOOT_PAD;
  const { minX, maxX } = xBounds(wa);
  let nx = x + dx;
  let ny = y + dy;
  let hitX = false;
  if (nx < minX) (nx = minX), (hitX = true);
  if (nx > maxX) (nx = maxX), (hitX = true);
  const onGround = ny >= ground;
  if (onGround) ny = ground;
  const top = wa.y + 70 - WIN_H; // don't let a throw fling the pet off the top of the screen
  const hitTop = ny < top;
  if (hitTop) ny = top;
  if (nx !== x || ny !== y) place(nx, ny);
  return { hitX, onGround, hitTop };
});

ipcMain.on('drag-start', () => {
  if (!win) return;
  const c = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  const off = { dx: c.x - x, dy: c.y - y };
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    place(p.x - off.dx, p.y - off.dy);
  }, 16);
});

ipcMain.on('drag-end', () => {
  clearInterval(dragTimer);
  dragTimer = null;
  if (!win) return;
  const [x, y] = win.getPosition();
  const wa = workAreaFor(x, y);
  const { minX, maxX } = xBounds(wa);
  const nx = Math.min(Math.max(x, minX), maxX);
  const ny = Math.max(y, wa.y + 70 - WIN_H); // keep the pet's body on screen
  place(nx, ny);
});

ipcMain.on('show-menu', () => {
  buildMenu().popup({ window: win });
});

// ---------- tray ----------
function makeIcon(scale = 2) {
  // the 16x16 mini pet from icon.js, drawn at `scale`x (2 = crisp on high-DPI trays)
  const { width, height, rgba } = petIcon.rgba(scale, true);
  return nativeImage.createFromBitmap(rgba, { width, height, scaleFactor: scale });
}

function buildMenu() {
  const active = [...sessions.values()];
  const check = (label, key) => ({
    label,
    type: 'checkbox',
    checked: !!settings[key],
    click: (item) => setSetting(key, item.checked),
  });
  const login = app.getLoginItemSettings(loginArgs());
  return Menu.buildFromTemplate([
    { label: `Code Pet · ${active.length} session${active.length === 1 ? '' : 's'}`, enabled: false },
    ...active.map((s) => ({ label: `   ${s.project} — ${s.status}`, enabled: false })),
    { type: 'separator' },
    ...assistant.menuItems(check),
    { type: 'separator' },
    check('Speech bubbles', 'bubbles'),
    check('Toast when Claude needs you', 'toastWaiting'),
    check(`Toast when a turn finishes (> ${settings.doneToastMinSeconds}s)`, 'toastDone'),
    check('Wander around when idle', 'wander'),
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...loginArgs() }),
    },
    { type: 'separator' },
    { label: 'Call pet home', click: () => (place(homePosition().x, homePosition().y), send('fall')) },
    { label: 'Reload pet', click: reloadPet },
    { label: 'Clear sessions', click: () => (sessions.clear(), pushSessions()) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}
function loginArgs() {
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  const waiting = [...sessions.values()].filter((s) => s.status === 'waiting').length;
  tray.setToolTip(waiting ? `Code Pet — ${waiting} waiting for you` : 'Code Pet');
}

// ---------- sessions & events ----------
function pushSessions() {
  const list = [...sessions.values()].sort((a, b) => b.updated - a.updated);
  send('sessions', list);
  refreshTray();
}

function toast(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body: body || '', silent: false, icon: makeIcon() }).show();
}

async function handleEvent(ev) {
  const name = ev.hook_event_name;
  if (!name) return;
  const id = ev.session_id || 'unknown';
  const cwd = ev.cwd || '';
  let s = sessions.get(id);
  if (!s) {
    s = { id, cwd, project: cwd ? path.basename(cwd) : 'claude', status: 'idle', activity: '', updated: Date.now(), turnStart: 0 };
    sessions.set(id, s);
  }
  s.updated = Date.now();
  const base = { sessionId: id, project: s.project };

  switch (name) {
    case 'SessionStart':
      s.status = 'idle';
      s.activity = 'session started';
      send('pet-event', { ...base, type: 'hello', text: ev.source === 'resume' ? 'welcome back!' : 'hi! new session' });
      break;

    case 'SessionEnd':
      sessions.delete(id);
      send('pet-event', { ...base, type: 'bye', text: 'session ended' });
      break;

    case 'UserPromptSubmit':
      s.status = 'thinking';
      s.activity = 'thinking…';
      s.turnStart = Date.now();
      send('pet-event', { ...base, type: 'activity', text: 'thinking…' });
      break;

    case 'PreToolUse': {
      const tool = ev.tool_name || '';
      const input = ev.tool_input || {};
      if (tool === 'AskUserQuestion') {
        const q = (input.questions && input.questions[0] && input.questions[0].question) || 'Claude has a question for you';
        markWaiting(s, base, q);
        break;
      }
      if (tool === 'ExitPlanMode') {
        markWaiting(s, base, 'a plan is ready for your review');
        break;
      }
      s.status = 'working';
      s.activity = describeTool(tool, input);
      send('pet-event', { ...base, type: 'activity', text: s.activity });
      break;
    }

    case 'PostToolUse':
      if (s.status === 'waiting') {
        s.status = 'working';
        send('pet-event', { ...base, type: 'resolved' });
      }
      break;

    case 'Notification': {
      const type = ev.notification_type || '';
      const needsYou = !type || NEEDS_YOU.has(type);
      if (needsYou) markWaiting(s, base, ev.message || 'Claude needs your attention');
      else if (INFO.has(type) && ev.message) send('pet-event', { ...base, type: 'activity', text: ev.message });
      break;
    }

    case 'Stop': {
      const took = s.turnStart ? (Date.now() - s.turnStart) / 1000 : 0;
      s.status = 'done';
      s.turnStart = 0;
      let text = ev.last_assistant_message || '';
      if (!text && ev.transcript_path) {
        await new Promise((r) => setTimeout(r, 400)); // let the transcript flush
        text = await lastAssistantText(ev.transcript_path).catch(() => '');
      }
      const summary = summarize(text) || 'all done!';
      s.activity = `done: ${summary}`;
      send('pet-event', { ...base, type: 'done', text: summary });
      if (settings.toastDone && took >= settings.doneToastMinSeconds) toast(`Claude finished · ${s.project}`, summary);
      break;
    }

    default:
      return;
  }
  pushSessions();
}

function markWaiting(s, base, message) {
  const wasWaiting = s.status === 'waiting' && s.activity === message;
  s.status = 'waiting';
  s.activity = message;
  send('pet-event', { ...base, type: 'waiting', text: message });
  if (settings.toastWaiting && !wasWaiting) toast(`Claude needs you · ${s.project}`, message);
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    }
    // Only accept requests from our hook script: custom header, no browser Origin.
    if (req.method !== 'POST' || req.url !== '/event' || req.headers['x-code-pet'] !== '1' || req.headers.origin) {
      res.writeHead(404);
      return res.end();
    }
    let body = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) req.destroy();
      else body += c;
    });
    req.on('end', () => {
      res.writeHead(204);
      res.end();
      try {
        handleEvent(JSON.parse(body)).catch((e) => console.error('[pet] event error', e));
      } catch (e) {
        console.error('[pet] bad payload', e.message);
      }
    });
  });
  server.on('error', (e) => console.error(`[pet] server error on port ${PORT}:`, e.message));
  server.listen(PORT, '127.0.0.1', () => console.log(`[pet] listening on http://127.0.0.1:${PORT}`));
}

// ---------- lifecycle ----------
// Our windows only ever show the pet's own pages: no navigating away, no pop-ups, no permissions.
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
});

app.whenReady().then(() => {
  loadSettings();
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  assistant.setup({
    getWin: () => win,
    send,
    getSettings: () => settings,
    setSetting,
    refreshTray,
    sessions: () => [...sessions.values()].sort((a, b) => b.updated - a.updated),
    makeIcon,
    workAreaFor,
    WIN_W,
    WIN_H,
    preload: path.join(__dirname, 'preload.js'),
  });
  createWindow();
  tray = new Tray(makeIcon());
  tray.on('click', () => tray.popUpContextMenu());
  refreshTray();
  startServer();
  assistant.start(); // only if you turned it on

  screen.on('display-metrics-changed', () => send('fall'));
  screen.on('display-removed', () => (place(homePosition().x, homePosition().y), send('fall')));

  // Windows can drop topmost windows during sleep: re-apply it once after waking (the taskbar has
  // settled by then). If it's still lost, the tray's "Reload pet" rebuilds the window.
  powerMonitor.on('resume', () => setTimeout(reassertTop, 3000));

  setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of sessions) if (now - s.updated > STALE_MS) sessions.delete(id), (changed = true);
    if (changed) pushSessions();
  }, 60 * 1000);
});

app.on('second-instance', () => {
  place(homePosition().x, homePosition().y);
  send('fall');
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => assistant.stop());
