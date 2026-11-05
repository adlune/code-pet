const { app, BrowserWindow, ipcMain, screen, Tray, Menu, Notification, nativeImage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { describeTool, summarize, lastAssistantText } = require('./events');

const PORT = Number(process.env.CLAUDE_PET_PORT) || 47321;
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
else app.setAppUserModelId('com.claude-pet.app');

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
}

function createWindow() {
  const { x, y } = homePosition();
  win = new BrowserWindow({
    x,
    y,
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
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    send('settings', settings);
    pushSessions();
  });
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
function makeIcon() {
  // 16x16 mini pet drawn at 2x into a BGRA bitmap.
  const G = 16;
  const S = 2;
  const N = G * S;
  const buf = Buffer.alloc(N * N * 4);
  const fill = (x, y, w, h, [r, g, b]) => {
    for (let yy = y * S; yy < (y + h) * S; yy++)
      for (let xx = x * S; xx < (x + w) * S; xx++) {
        const i = (yy * N + xx) * 4;
        buf[i] = b;
        buf[i + 1] = g;
        buf[i + 2] = r;
        buf[i + 3] = 255;
      }
  };
  const O = [0xd9, 0x77, 0x57];
  const D = [0xb9, 0x58, 0x3c];
  const K = [0x1f, 0x1a, 0x17];
  fill(2, 4, 12, 8, O);
  fill(2, 11, 12, 1, D);
  fill(0, 7, 2, 2, O);
  fill(14, 7, 2, 2, O);
  fill(5, 6, 1, 2, K);
  fill(10, 6, 1, 2, K);
  for (const lx of [3, 5, 10, 12]) fill(lx, 12, 1, 2, O);
  return nativeImage.createFromBitmap(buf, { width: N, height: N, scaleFactor: S });
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
    { label: `Claude Pet · ${active.length} session${active.length === 1 ? '' : 's'}`, enabled: false },
    ...active.map((s) => ({ label: `   ${s.project} — ${s.status}`, enabled: false })),
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
  tray.setToolTip(waiting ? `Claude Pet — ${waiting} waiting for you` : 'Claude Pet');
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
    if (req.method !== 'POST' || req.url !== '/event' || req.headers['x-claude-pet'] !== '1' || req.headers.origin) {
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
app.whenReady().then(() => {
  loadSettings();
  createWindow();
  tray = new Tray(makeIcon());
  tray.on('click', () => tray.popUpContextMenu());
  refreshTray();
  startServer();

  screen.on('display-metrics-changed', () => send('fall'));
  screen.on('display-removed', () => (place(homePosition().x, homePosition().y), send('fall')));

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
