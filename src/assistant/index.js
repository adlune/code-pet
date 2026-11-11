// Optional local AI assistant: ask the pet questions, answered by a local Ollama model, which can
// also find, open and edit things on this PC (every action asks first, see actions.js).
// It's off by default. While off, nothing here runs: no shortcut, no prompt window, no model,
// no file or folder indexing.
const { BrowserWindow, ipcMain, screen, nativeImage, globalShortcut, clipboard, desktopCapturer } = require('electron');
const path = require('path');
const ollama = require('./ollama');
const actions = require('./actions');
const prompt = require('./prompt');

const DEFAULTS = {
  askEnabled: false, // the whole assistant (tray → "Local AI assistant")
  askModel: 'qwen3.5:4b',
  askShortcut: 'Control+Alt+P', // P for pet
  askActions: true, // let the model find/open files, open apps and edit text files (each one asks first)
};

// what the pet's main process lends us (see setup() in main.js)
let pet = null;
const settings = () => pet.getSettings();
const send = (channel, payload) => pet.send(channel, payload);
const petWin = () => pet.getWin();

let running = false;
let askSeq = 0;
let askAbort = null;
let askCancelled = 0;
let askHistory = [];
let askLastAt = 0;
let askModels = []; // installed models, for the tray picker
let askShortcut = null; // the shortcut actually registered (null = none free)
const askLabel = () => settings().askModel.split(':')[0];

// ---------- on / off ----------
function start() {
  if (running || !settings().askEnabled) return;
  running = true;
  actions.init();
  registerAskShortcut();
  createAskWindow(); // hidden until you ask; preloaded so it opens instantly
  refreshAskModels(); // only if Ollama is already up; it isn't started until you ask something
}
function stop() {
  if (!running) return;
  running = false;
  globalShortcut.unregisterAll();
  askShortcut = null;
  if (askAbort) (askCancelled = askSeq), askAbort.abort();
  for (const done of [...pendingConfirms.values()]) done(false);
  if (askWin && !askWin.isDestroyed()) askWin.destroy();
  askWin = null;
  askBusy = false;
  askHistory = [];
  actions.stop();
}
function onSettingChanged(key) {
  if (key === 'askEnabled') settings().askEnabled ? start() : stop();
  else if (key === 'askShortcut' && running) registerAskShortcut();
}

// Registers the configured shortcut, or the first free fallback if another app already owns it.
function registerAskShortcut() {
  globalShortcut.unregisterAll();
  askShortcut = null;
  for (const k of [settings().askShortcut, 'Control+Alt+P', 'Alt+Shift+A', 'Control+Shift+Alt+Space']) {
    let ok = false;
    try {
      ok = globalShortcut.register(k, openAsk);
    } catch {}
    if (ok) {
      askShortcut = k;
      break;
    }
    console.error(`[pet] couldn't register ${k} (taken by another app?)`);
  }
  pet.refreshTray();
}

async function refreshAskModels() {
  try {
    askModels = (await ollama.isUp()) ? await ollama.listModels() : askModels;
    // the chosen model was uninstalled: switch to one that's still there
    if (askModels.length && !askModels.includes(settings().askModel)) pet.setSetting('askModel', askModels[0]);
  } catch {}
  pet.refreshTray();
}

// ---------- the prompt bar ----------
// The input lives in its own small window: the pet's window is deliberately never focusable (so
// clicking or dragging the pet doesn't steal focus from your apps), and Windows won't reliably
// hand focus to a window that was switched to focusable on the fly.
const ASK_W = 280;
const ASK_H = 60;
let askWin = null;
function createAskWindow() {
  askWin = new BrowserWindow({
    width: ASK_W,
    height: ASK_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    icon: pet.makeIcon(4),
    webPreferences: { preload: pet.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  askWin.setAlwaysOnTop(true, 'pop-up-menu'); // above the pet
  askWin.loadFile(path.join(__dirname, '..', 'renderer', 'ask.html'));
  askWin.on('blur', () => askWin && !askWin.isDestroyed() && askWin.hide());
  askWin.on('closed', () => (askWin = null));
}

// Right above the pet, where its speech bubble appears, kept on screen. While a question is being
// answered the bar stays open (so Enter/Esc can answer Allow/Deny) and sits above the bubble.
let askBusy = false;
let bubbleTop = null; // top of the pet's visible bubble, in pet-window px (null = no bubble)
let petHeight = 104; // the pet canvas's height, reported by the renderer
ipcMain.on('metrics', (_e, m) => {
  if (m && m.height > 0 && m.height < pet.WIN_H) petHeight = m.height;
});
ipcMain.on('bubble-rect', (_e, r) => {
  bubbleTop = r && r.visible ? r.top : null;
  if (askBusy && askWin && !askWin.isDestroyed() && askWin.isVisible()) positionAsk();
});
function positionAsk() {
  const win = petWin();
  if (!win || win.isDestroyed() || !askWin || askWin.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const wa = pet.workAreaFor(x, y);
  const ax = Math.min(Math.max(Math.round(x + pet.WIN_W / 2 - ASK_W / 2), wa.x), wa.x + wa.width - ASK_W);
  const anchor = askBusy && bubbleTop != null ? y + bubbleTop + 2 : y + pet.WIN_H - petHeight + 8;
  const ay = Math.max(wa.y, anchor - ASK_H);
  const b = askWin.getBounds();
  if (b.x !== ax || b.y !== ay) askWin.setBounds({ x: ax, y: ay, width: ASK_W, height: ASK_H });
}
// the prompt bar follows the pet
function onPetMoved() {
  if (askWin && !askWin.isDestroyed() && askWin.isVisible()) positionAsk();
}

function openAsk() {
  const win = petWin();
  if (!running || !win || win.isDestroyed()) return;
  if (!askWin) createAskWindow();
  askBusy = false;
  positionAsk();
  const show = () => {
    askWin.webContents.send('ask-open', { label: askLabel() });
    askWin.show();
    askWin.focus();
    askWin.webContents.focus();
  };
  if (askWin.webContents.isLoading()) askWin.webContents.once('did-finish-load', show);
  else show();
  send('ask-open', { label: askLabel() }); // the pet clears its bubble and waves
  // wake Ollama and load the model while the question is typed
  ollama.ensureRunning().then((up) => {
    if (up) ollama.preload(settings().askModel).catch(() => {});
    refreshAskModels();
  });
  if (settings().askActions) actions.warm(); // and index files and apps
}
function askMode(mode, allowLabel) {
  if (askWin && !askWin.isDestroyed()) askWin.webContents.send('ask-mode', { mode, allowLabel });
}

// ---------- Allow / Deny ----------
// Shown in the pet's bubble. Resolves false on Deny, on a new question, or after 2 minutes.
let confirmSeq = 0;
const pendingConfirms = new Map();
function askConfirm(req, signal) {
  return new Promise((resolve) => {
    const cid = ++confirmSeq;
    const done = (allow) => {
      if (!pendingConfirms.delete(cid)) return;
      clearTimeout(timer);
      send('ask-confirm-close', { cid, allow });
      askMode('busy');
      resolve(allow);
    };
    const timer = setTimeout(() => done(false), 2 * 60 * 1000);
    pendingConfirms.set(cid, done);
    if (signal) signal.addEventListener('abort', () => done(false), { once: true });
    send('ask-confirm', { cid, label: askLabel(), ...req });
    askMode('confirm', req.allowLabel || 'Allow');
  });
}
ipcMain.on('confirm-reply', (_e, r) => {
  const done = r && pendingConfirms.get(r.cid);
  if (done) done(!!r.allow);
});
// Enter / Esc in the prompt bar answer the newest Allow/Deny question
ipcMain.on('confirm-key', (_e, allow) => {
  const last = [...pendingConfirms.values()].pop();
  if (last) last(!!allow);
});

// ---------- what the request refers to: the clipboard (text or image) or the screen ----------
// (this Electron's clipboard is the promise-based, web-style one: images come as image/png blobs)
async function clipboardImage() {
  let img = null;
  try {
    for (const item of await clipboard.read()) {
      const type = (item.types || []).find((t) => /^image\//.test(t));
      if (!type) continue;
      const blob = await item.getType(type);
      img = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
      break;
    }
  } catch {}
  if (!img || img.isEmpty()) return null;
  const { width } = img.getSize();
  if (width > 1280) img = img.resize({ width: 1280 });
  return img.toJPEG(85).toString('base64');
}
async function captureScreen() {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = Math.min(1, 1280 / d.size.width); // plenty for reading text, and keeps the model quick
  const size = { width: Math.round(d.size.width * scale), height: Math.round(d.size.height * scale) };
  // hide our own windows for a moment (opacity, not hide(), so the prompt bar keeps keyboard focus)
  const ours = [petWin(), askWin].filter((w) => w && !w.isDestroyed() && w.isVisible());
  ours.forEach((w) => w.setOpacity(0));
  await new Promise((r) => setTimeout(r, 80));
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
    return src ? src.thumbnail.toJPEG(80).toString('base64') : null;
  } finally {
    ours.forEach((w) => !w.isDestroyed() && w.setOpacity(1));
  }
}

// ---------- undo ----------
async function undoEdit(id) {
  const r = await actions.undo(id, (req) => askConfirm(req));
  pet.refreshTray();
  return r;
}
ipcMain.handle('undo-edit', (_e, id) => (typeof id === 'string' ? undoEdit(id) : { ok: false, message: 'Nothing to undo.' }));

// ---------- answering ----------
// "Opened Spotify." or "Nothing was done." needs no reading, so the bubble closes by itself (ms).
// Answers, paths and anything longer stay up until you close them (0).
function autoCloseFor(text, ctx) {
  if (text.length > 200) return 0;
  if (ctx.opened || ctx.denied) return 5000;
  if (ctx.editIds.length) return 12000; // a little longer, for its Undo button (also in the tray)
  return 0;
}

// Lets the model call tools (search, open, read, edit) until it has an answer for you.
async function answer(q, id, signal) {
  const s = settings();
  const useTools = s.askActions;
  const ctx = {
    question: q,
    mentionText: q,
    readHappened: false,
    editIds: [],
    paths: new Set(),
    confirm: (req) => askConfirm(req, signal),
    status: (text) => id === askSeq && send('ask-stream', { id, text, status: true }),
    sessions: pet.sessions,
  };
  // the screen or the clipboard, only when the question is about them
  const extra = {};
  if (prompt.refersToScreen(q)) {
    ctx.status('Looking at your screen…');
    extra.image = await captureScreen();
    extra.imageKind = 'screen';
  } else if (prompt.refersToClipboard(q)) {
    ctx.status('Reading your clipboard…');
    const text = String((await clipboard.readText()) || '').trim();
    if (text) extra.clipboard = text.length > 8000 ? `${text.slice(0, 8000)}\n[… cut off]` : text;
    else extra.image = await clipboardImage();
    extra.imageKind = 'clipboard';
    ctx.mentionText = `${q}\n${text}`; // "open this" with a copied path counts as naming it
  }
  if (extra.clipboard || extra.image) ctx.readHappened = true; // its content could hold planted instructions
  const messages = [{ role: 'system', content: useTools ? prompt.SYSTEM : ollama.SYSTEM }, ...askHistory, prompt.userMessage(q, extra)];
  // translating or rewriting copied text can be long
  const numPredict = extra.clipboard ? 1500 : undefined;
  const onToken = (t) => id === askSeq && send('ask-stream', { id, text: t });
  const result = (text) => ({
    text,
    editIds: ctx.editIds,
    // paths a tool found that made it into the answer get a Copy button
    paths: [...ctx.paths].filter((p) => text.includes(p) || text.includes(p.replace(/\\$/, ''))),
    copy: !!extra.clipboard, // a translated/fixed text gets a Copy button
    autoClose: autoCloseFor(text, ctx),
  });
  let think = useTools && prompt.wantsThinking(q);
  const seen = new Map();
  for (let step = 0; step < 8; step++) {
    const r = await ollama.chat({ model: s.askModel, messages, tools: useTools ? prompt.TOOLS : undefined, think, numPredict, signal, onToken });
    if (!r.toolCalls.length) return result(r.text);
    messages.push({ role: 'assistant', content: r.raw, tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
      const name = tc.function && tc.function.name;
      const args = (tc.function && tc.function.arguments) || {};
      const key = name + JSON.stringify(args);
      seen.set(key, (seen.get(key) || 0) + 1);
      const out = seen.get(key) > 2 ? 'You already did this. Answer the user now.' : await actions.run(name, args, ctx);
      if (signal.aborted) throw new Error('aborted');
      messages.push({ role: 'tool', tool_name: name, content: out });
    }
    if (ctx.readHappened) think = true; // after reading a file, think: it might hold planted instructions
  }
  // ran out of steps: answer with what it has
  const r = await ollama.chat({ model: s.askModel, messages, think: false, signal, onToken });
  return result(r.text);
}

ipcMain.on('ask-close', () => {
  askBusy = false;
  if (askWin && !askWin.isDestroyed()) askWin.hide();
});
// Esc in the prompt bar while the model is working
ipcMain.on('ask-cancel', () => {
  if (!askAbort) return;
  askCancelled = askSeq;
  askAbort.abort();
});
ipcMain.on('copy-text', (_e, text) => Promise.resolve(clipboard.writeText(String(text || '').slice(0, 100000))).catch(() => {}));

ipcMain.on('ask-submit', async (e, question) => {
  // only from our own prompt bar, and only while the assistant is on
  if (!running || !askWin || askWin.isDestroyed() || e.sender !== askWin.webContents) return;
  const q = String(question || '').trim().slice(0, 500);
  if (!q) return;
  const id = ++askSeq;
  if (askAbort) askAbort.abort(); // a new question replaces one still being answered
  const ac = new AbortController();
  askAbort = ac;
  if (Date.now() - askLastAt > 10 * 60 * 1000) askHistory = [];
  askLastAt = Date.now();
  send('ask-start', { id, label: askLabel() });
  askBusy = true; // the prompt bar stays open above the bubble until the answer is in
  askMode('busy');
  try {
    if (!(await ollama.ensureRunning())) throw new Error("I can't reach Ollama. Is it installed and running?");
    const { text, editIds, paths, copy, autoClose } = await answer(q, id, ac.signal);
    askHistory = [...askHistory, { role: 'user', content: q }, { role: 'assistant', content: text }].slice(-8);
    askLastAt = Date.now();
    send('ask-end', { id, text: text || 'Done.', undo: editIds[editIds.length - 1] || null, paths, copy, autoClose });
    if (editIds.length) pet.refreshTray();
  } catch (err) {
    if (ac.signal.aborted) {
      if (askCancelled === id) send('ask-end', { id, error: 'Cancelled.', autoClose: 3000 });
      else return; // replaced by a newer question, which owns the prompt bar now
    } else send('ask-end', { id, error: err.message || String(err) });
  } finally {
    if (askAbort === ac) askAbort = null;
  }
  if (id === askSeq && askBusy) {
    askBusy = false;
    if (askWin && !askWin.isDestroyed()) askWin.hide(); // focus goes back to where you were
  }
});

// ---------- tray ----------
function agoLabel(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return m <= 1 ? 'just now' : `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
// The tray items: just the on/off switch while it's off.
function menuItems(check) {
  const s = settings();
  const items = [check('Local AI assistant (Ollama)', 'askEnabled')];
  if (!s.askEnabled) return items;
  const e = actions.lastEdit();
  const d = actions.driveInfo();
  const when = d.at ? `${d.count.toLocaleString()} folders, ${agoLabel(d.at)}` : 'not scanned yet';
  items.push(
    {
      label: askShortcut ? `Ask ${askLabel()}…` : `Ask ${askLabel()}… (no free shortcut)`,
      accelerator: askShortcut || undefined,
      registerAccelerator: false,
      click: openAsk,
    },
    {
      label: 'Assistant',
      submenu: [
        ...[...new Set([s.askModel, ...askModels])].map((m) => ({
          label: m,
          type: 'radio',
          checked: m === s.askModel,
          click: () => pet.setSetting('askModel', m),
        })),
        { label: 'Refresh model list', click: refreshAskModels },
        { type: 'separator' },
        check('Let it open apps and edit files (asks first)', 'askActions'),
        {
          label: e ? `Undo last edit (${path.basename(e.path)})` : 'Undo last edit',
          enabled: !!e,
          click: () => undoEdit(e && e.id).then((r) => send('ask-notice', r)),
        },
        {
          label: d.scanning ? 'Scanning drive folders…' : `Rescan drive folders (${when})`,
          enabled: !d.scanning,
          click: () => {
            const p = actions.scanDrives();
            pet.refreshTray();
            p.then(pet.refreshTray);
          },
        },
      ],
    },
  );
  return items;
}

// pet: { getWin, send, getSettings, setSetting, refreshTray, sessions, makeIcon, workAreaFor, WIN_W, WIN_H, preload }
function setup(p) {
  pet = p;
}

module.exports = { DEFAULTS, setup, start, stop, onSettingChanged, onPetMoved, menuItems };
