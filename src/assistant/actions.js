// What the local model may do on this PC: find files, open files and apps, read and edit text files.
// The model only *asks* through these tools; every rule below is enforced here, in code:
//   - only paths on this PC's own drives: network paths (\\server\share) are refused before they're
//     touched, since just looking one up can send your Windows login to that server
//   - files are limited to your personal folders (Documents, Desktop, Downloads, Pictures, Music,
//     Videos) and never include secrets (.ssh, .env, keys, AppData…)
//   - opening anything and every edit needs your click on Allow in the pet's bubble
//   - scripts, shortcuts and installers (.bat, .ps1, .lnk, .msix…) are never opened or run;
//     programs outside the Start menu get a warning
//   - every edit is backed up first and can be undone
const { app, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// the prompt, the tool list and "which request needs what" live in prompt.js
const { FOLDERS } = require('./prompt');

// ---------- rules ----------
const ROOT_NAMES = ['documents', 'desktop', 'downloads', 'pictures', 'music', 'videos'];
let roots = [];
const DENY_DIRS = /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.git|appdata|\$recycle\.bin|\.password-store)$/i;
const DENY_FILES =
  /^(\.env(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|credentials(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|wallet\.dat)$|\.(pem|key|pfx|p12|kdbx?|keystore|jks|ppk|ovpn|gpg|asc|sqlite|db|1pux|1pif|psafe3|opvault)$/i;
const SKIP_DIRS = /^(node_modules|\.git|\.venv|venv|__pycache__|\.next|\.cache|\.gradle|\.idea|\.vs|target|\$recycle\.bin|appdata)$/i;
// Files that run code, install something or point somewhere else when opened: never opened.
const SCRIPTS =
  /\.(bat|cmd|ps1|psm1|psd1|ps1xml|psc1|vb|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|wsc|sct|hta|chm|scr|com|pif|reg|msc|cpl|jar|jnlp|py|pyw|sh|bash|appref-ms|inf|application|xbap|gadget|msp|msu|lnk|url|website|scf|shb|shs|ins|isp|mof|ws|appx|appxbundle|msix|msixbundle|appinstaller|diagcab|diagcfg|diagpkg|search-ms|searchconnector-ms|library-ms|settingcontent-ms|xll|xlam|ppam|rdp|theme|themepack|deskthemepack|vhd|vhdx)$/i;
const PROGRAMS = /\.(exe|msi)$/i;
const BINARY_DOCS = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|7z|rar|gz|tar|png|jpe?g|gif|bmp|webp|ico|mp3|wav|flac|mp4|mkv|mov|avi|exe|msi|dll|iso)$/i;
const MAX_TEXT = 256 * 1024;

const lc = (s) => String(s || '').toLowerCase();
const inside = (p, root) => {
  const rel = path.relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};
const denied = (p) => {
  const parts = p.split(/[\\/]+/);
  return parts.slice(0, -1).some((s) => DENY_DIRS.test(s)) || DENY_DIRS.test(parts[parts.length - 1]) || DENY_FILES.test(path.basename(p));
};

// A path on one of this PC's drives ("C:\…"). Anything else (\\server\share, \\?\…, \\.\device)
// is refused before the file system is asked about it.
const LOCAL_PATH = /^[a-z]:\\/i;
const isLocal = (p) => typeof p === 'string' && LOCAL_PATH.test(p.replace(/\//g, '\\'));

// Resolves a path the model gave us and checks it's an existing, allowed, non-secret location.
function checkPath(p) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p)) return { error: 'Use a full path from search_files.' };
  if (!isLocal(p)) return { error: 'Only files and folders on this PC can be used, not network paths.' };
  let real;
  try {
    real = fs.realpathSync.native(path.resolve(p)); // follows links, so a shortcut folder can't escape
  } catch {
    return { error: `No such file or folder: ${p}` };
  }
  if (!isLocal(real)) return { error: 'Only files and folders on this PC can be used, not network paths.' };
  if (!roots.some((r) => inside(lc(real), lc(r)))) return { error: `That's outside the folders the assistant may use (${roots.map((r) => path.basename(r)).join(', ')}).` };
  if (denied(real)) return { error: "That file may hold passwords or keys, so the assistant won't touch it." };
  return { path: real, stat: fs.statSync(real) };
}

// A folder anywhere on your drives may be *opened* (File Explorer just shows it), as long as it
// isn't a secrets folder. Reading and editing still need checkPath, i.e. your personal folders.
const SECRET_DIRS = /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store)$/i;
function checkFolderAnywhere(p) {
  if (!p || typeof p !== 'string' || !path.isAbsolute(p) || !isLocal(p)) return null;
  try {
    const real = fs.realpathSync.native(path.resolve(p));
    const stat = fs.statSync(real);
    if (!isLocal(real) || !stat.isDirectory() || real.split(/[\\/]+/).some((s) => SECRET_DIRS.test(s))) return null;
    return { path: real, stat };
  } catch {
    return null;
  }
}

// ---------- folder names on every local drive (scanned in the background once a day) ----------
// Only folders, not files: that's what "where's my X folder" needs, and it keeps the list small
// (~100k entries). Walking all of C: takes about a minute, so it's cached on disk.
const DRIVE_SKIP =
  /^(windows|\$.*|system volume information|recovery|perflogs|config\.msi|winsxs|node_modules|\.git|\.venv|venv|__pycache__|\.cache|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store)$/i;
const DAY = 24 * 3600 * 1000;
let drive = { at: 0, folders: [] }; // full paths ending with a separator
let driveNames = []; // their lowercased folder names, same order
let scanning = null;
const driveFile = () => path.join(app.getPath('userData'), 'folder-index.json');
function setDrive(d) {
  drive = d;
  driveNames = d.folders.map((p) => lc(path.basename(p.slice(0, -1))));
}
function localDrives() {
  return new Promise((resolve) => {
    const cmd = "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID -join ','"; // local fixed disks only
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 20000 }, (err, out) => {
      const list = String(out || '')
        .trim()
        .split(',')
        .filter((d) => /^[A-Z]:$/i.test(d))
        .map((d) => d + '\\');
      resolve(list.length ? list : ['C:\\']);
    });
  });
}
function scanDrives() {
  if (scanning) return scanning;
  scanning = (async () => {
    const queue = await localDrives();
    const out = [];
    for (let i = 0; i < queue.length && out.length < 400000; i++) {
      if (!active) return;
      let entries;
      try {
        entries = await fsp.readdir(queue[i], { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        // junctions and links aren't isDirectory() here, so loops like "Application Data" are skipped
        if (!e.isDirectory() || DRIVE_SKIP.test(e.name)) continue;
        const p = path.join(queue[i], e.name);
        out.push(p + path.sep);
        queue.push(p);
      }
    }
    setDrive({ at: Date.now(), folders: out });
    await fsp.writeFile(driveFile(), JSON.stringify(drive));
  })()
    .catch((e) => console.error('[pet] drive scan failed', e.message))
    .finally(() => (scanning = null));
  return scanning;
}
const driveInfo = () => ({ at: drive.at, count: drive.folders.length, scanning: !!scanning });

// ---------- file index (built in the background when you open the prompt bar) ----------
let index = []; // { p, name } (lowercased name); folders end with a separator
let indexAt = 0;
let indexing = null;
function buildIndex() {
  if (indexing) return indexing;
  indexing = (async () => {
    const out = [];
    const queue = roots.map((r) => [r, 0]);
    while (queue.length && out.length < 200000) {
      const [dir, depth] = queue.shift();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.test(e.name) || DENY_DIRS.test(e.name) || e.name.startsWith('.')) continue;
          out.push({ p: p + path.sep, name: lc(e.name) });
          if (depth < 12) queue.push([p, depth + 1]);
        } else if (e.isFile() && !DENY_FILES.test(e.name) && !/^(desktop\.ini|thumbs\.db)$/i.test(e.name)) {
          out.push({ p, name: lc(e.name) });
        }
      }
    }
    index = out;
    indexAt = Date.now();
  })().finally(() => (indexing = null));
  return indexing;
}

const STOP = new Set(['my', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'file', 'files', 'folder', 'mi', 'mis', 'el', 'la', 'los', 'las', 'de', 'del', 'en', 'archivo', 'carpeta']);
const words = (s) => lc(s).split(/[^a-z0-9áéíóúñü]+/).filter((w) => w && !STOP.has(w));
// words people use that folder names don't (Steam keeps games in steamapps\common)
const ALIASES = {
  games: ['games', 'game', 'steamapps'],
  game: ['game', 'games', 'steamapps'],
  juegos: ['juegos', 'games', 'game', 'steamapps'],
  photos: ['photos', 'pictures', 'fotos'],
  fotos: ['fotos', 'photos', 'pictures'],
};

async function searchFiles(query) {
  if (!indexAt || Date.now() - indexAt > 5 * 60 * 1000) await buildIndex();
  const ws = words(query);
  if (!ws.length) return 'Give some words from the file name.';
  // your personal folders (files and folders, live) plus folders anywhere on your drives (daily scan)
  const scored = [];
  const seen = new Set();
  let best = 0;
  const alts = ws.map((w) => ALIASES[w] || [w]);
  const consider = (p, name, bonus) => {
    const full = lc(p);
    let hit = 0;
    let score = bonus;
    for (const a of alts) {
      if (a.some((w) => name.includes(w))) (hit++, (score += 3));
      else if (a.some((w) => full.includes(w))) (hit++, (score += 1));
    }
    if (!hit || seen.has(full)) return;
    seen.add(full);
    if (hit > best) best = hit;
    scored.push({ p, hit, score: score - p.split(path.sep).length * 0.05 });
  };
  for (const e of index) consider(e.p, e.name, 0.3); // a small edge for your own stuff
  for (let i = 0; i < drive.folders.length; i++) consider(drive.folders[i], driveNames[i], 0);
  const hits = scored
    .filter((s) => s.hit === best)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((s) => s.p);
  const pending = drive.at ? '' : '\n(Folders outside your personal folders are still being indexed.)';
  if (!hits.length) return `Nothing found for "${query}".${pending}`;
  const note = best < ws.length ? 'Nothing matches every word; closest matches:\n' : '';
  return note + hits.join('\n') + pending;
}

// ---------- installed apps (the Start menu's list, which includes Store apps and Steam games) ----------
let apps = [];
let appsAt = 0;
let loadingApps = null;
function loadApps() {
  if (loadingApps) return loadingApps;
  loadingApps = new Promise((resolve) => {
    const cmd = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 20000, maxBuffer: 8e6 }, (err, out) => {
      try {
        const j = JSON.parse(out);
        apps = (Array.isArray(j) ? j : [j]).filter((a) => a && a.Name && a.AppID).map((a) => ({ name: a.Name, id: a.AppID }));
        appsAt = Date.now();
      } catch {}
      resolve();
    });
  }).finally(() => (loadingApps = null));
  return loadingApps;
}

const norm = (s) => lc(s).replace(/[^a-z0-9]+/g, ' ').trim();
function appScore(q, a) {
  const qn = norm(q);
  const n = norm(a.name);
  if (!qn) return 0;
  const qc = qn.replace(/ /g, '');
  const nc = n.replace(/ /g, '');
  const nw = n.split(' ');
  let s = 0;
  if (qc === nc) s = 100;
  else if (qc.length >= 3 && (nc.startsWith(qc) || qc.startsWith(nc))) s = 60;
  else {
    // every word matches a word's start, or the initials of a run of words ("vs" = Visual Studio)
    const initials = (i, k) => nw.slice(i, i + k).map((w) => w[0]).join('');
    const ok = (w) => nw.some((x) => x.startsWith(w)) || nw.some((_, i) => [2, 3].some((k) => initials(i, k) === w));
    const qw = qn.split(' ');
    const m = qw.filter(ok).length;
    s = m === qw.length ? 50 : (20 * m) / qw.length;
  }
  if (!s) return 0;
  if (/uninstall/.test(n) && !/uninstall/.test(qn)) s -= 40;
  if (/^https?:/i.test(a.id) || /\.(chm|html?|txt|pdf|url)$/i.test(a.id)) s -= 10;
  return s;
}

const KNOWN_FOLDERS = {
  '{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}': 'C:\\Program Files (x86)',
  '{6D809377-6AF0-444B-8957-A3773F02200E}': 'C:\\Program Files',
  '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': 'C:\\Windows',
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': 'C:\\Windows\\System32',
};
function describeApp(a) {
  const id = a.id.replace(/^\{[0-9A-F-]+\}/i, (g) => KNOWN_FOLDERS[g.toUpperCase()] || g);
  if (/^steam:/i.test(id)) return 'Steam game';
  if (/^https?:/i.test(id)) return id;
  if (/^[a-z]:\\/i.test(id)) return id;
  if (/!/.test(id)) return 'Microsoft Store app';
  return 'Installed app';
}
function launchApp(a) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(a.id) && !/^[a-z]:\\/i.test(a.id)) return shell.openExternal(a.id); // steam://, https://
  const child = spawn('explorer.exe', [`shell:AppsFolder\\${a.id}`], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// ---------- edit backups ----------
const backupDir = () => path.join(app.getPath('userData'), 'backups');
const logFile = () => path.join(backupDir(), 'log.json');
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
function readLog() {
  try {
    return JSON.parse(fs.readFileSync(logFile(), 'utf8'));
  } catch {
    return [];
  }
}
function writeLog(log) {
  // keep the last 50 edits from the last 30 days
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const keep = log.filter((e) => e.at > cutoff).slice(-50);
  for (const e of log) if (!keep.includes(e)) fs.rmSync(path.join(backupDir(), e.backup), { force: true });
  fs.writeFileSync(logFile(), JSON.stringify(keep, null, 2));
}
function backupAndWrite(file, before, after) {
  fs.mkdirSync(backupDir(), { recursive: true });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const backup = `${id}-${path.basename(file)}`;
  fs.writeFileSync(path.join(backupDir(), backup), before);
  fs.writeFileSync(file, after);
  writeLog([...readLog(), { id, path: file, backup, at: Date.now(), after: sha(after) }]);
  return id;
}
const lastEdit = () => readLog().slice(-1)[0] || null;

// Puts a file back the way it was before an edit. confirm() is asked first if the file changed since.
async function undo(id, confirm) {
  const log = readLog();
  const e = id ? log.find((x) => x.id === id) : log[log.length - 1];
  if (!e) return { ok: false, message: 'That edit was already undone or is too old.' };
  const name = path.basename(e.path);
  let current = null;
  try {
    current = fs.readFileSync(e.path);
  } catch {}
  if (current && sha(current) !== e.after) {
    const ok = await confirm({
      title: `Undo the edit to ${name}?`,
      target: e.path,
      warn: 'This file changed after the edit. Undoing will also lose those later changes.',
      allowLabel: 'Undo anyway',
    });
    if (!ok) return { ok: false, message: `Kept ${name} as it is.` };
  }
  fs.writeFileSync(e.path, fs.readFileSync(path.join(backupDir(), e.backup)));
  fs.rmSync(path.join(backupDir(), e.backup), { force: true });
  writeLog(log.filter((x) => x !== e));
  return { ok: true, message: `Undid the edit to ${name}.` };
}

// ---------- running a tool ----------
// Did the user's own request mention this target? If the model wants to open something only after
// reading a file, and you never named it, that's how planted instructions look: warn about it.
function mentioned(question, target) {
  const q = lc(question);
  const base = path.basename(String(target)).replace(/\.[a-z0-9]+$/i, '');
  return words(base).some((w) => w.length >= 3 && q.includes(w));
}
const DENIED = 'The user clicked Deny, so nothing was done. Say so in one short sentence; do not offer to retry.';
const PLANTED =
  'The assistant read a file, your clipboard or your screen before suggesting this, and you never mentioned it. Those can contain instructions meant to trick it.';

function textOf(buf) {
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

function lineDiff(content, start, end, replace) {
  // the whole lines touched by the edit, before and after, trimmed for the bubble
  const ls = content.lastIndexOf('\n', start - 1) + 1;
  let le = content.indexOf('\n', end);
  if (le < 0) le = content.length;
  const before = content.slice(ls, le).split('\n');
  const after = (content.slice(ls, start) + replace + content.slice(end, le)).split('\n');
  const cap = (arr) => (arr.length > 4 ? [...arr.slice(0, 3), `… ${arr.length - 3} more lines`] : arr).map((l) => (l.length > 90 ? l.slice(0, 89) + '…' : l));
  return { del: cap(before), add: cap(after) };
}

// ---------- newest files in a folder ----------
function folderPath(folder) {
  if (folder === 'screenshots') return path.join(app.getPath('pictures'), 'Screenshots');
  return FOLDERS.includes(folder) ? app.getPath(folder) : null;
}
function when(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const m = Math.round((Date.now() - ms) / 60000);
  const ago = m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  return `${stamp} (${ago})`;
}
async function recentFiles(folder, query) {
  const base = folderPath(folder);
  if (!base || !fs.existsSync(base)) return `There is no ${folder} folder.`;
  const ws = words(query || '');
  const files = [];
  const queue = [[base, 0]];
  for (let i = 0; i < queue.length && files.length < 5000; i++) {
    const [dir, depth] = queue[i];
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3 && !SKIP_DIRS.test(e.name) && !DENY_DIRS.test(e.name) && !e.name.startsWith('.')) queue.push([p, depth + 1]);
      } else if (e.isFile() && !DENY_FILES.test(e.name) && !/^(desktop\.ini|thumbs\.db)$/i.test(e.name) && !/\.(tmp|crdownload|part)$/i.test(e.name)) {
        if (ws.every((w) => lc(p).includes(w))) files.push(p);
      }
    }
  }
  const stats = await Promise.all(files.map((p) => fsp.stat(p).then((s) => ({ p, t: s.mtimeMs })).catch(() => null)));
  const newest = stats.filter(Boolean).sort((a, b) => b.t - a.t).slice(0, 8);
  if (!newest.length) return `No files${ws.length ? ` matching "${query}"` : ''} in ${base}.`;
  return newest.map((f) => `${when(f.t)}  ${f.p}`).join('\n');
}

// ---------- Claude Code sessions (the pet already tracks them) ----------
function describeSessions(list) {
  if (!list.length) return 'No Claude Code sessions are running right now.';
  const label = { waiting: 'waiting for the user', working: 'working', thinking: 'thinking', done: 'done', idle: 'idle' };
  return list
    .map((s) => {
      const m = Math.round((Date.now() - s.updated) / 60000);
      return `${s.project}: ${label[s.status] || s.status} (${m < 1 ? 'just now' : `${m} min ago`})${s.activity ? `, ${s.activity}` : ''}${s.cwd ? ` [${s.cwd}]` : ''}`;
    })
    .join('\n');
}

// Remembers full paths a tool returned, so the answer can show a Copy button next to them.
function notePaths(ctx, text) {
  for (const line of String(text).split('\n')) {
    const m = line.match(/([A-Z]:\\.*)$/i);
    if (m) ctx.paths.add(m[1].trim());
  }
  return text;
}

// ctx: { question, confirm(req) -> Promise<bool>, status(text), sessions() -> [], readHappened,
//        editIds: [], paths: Set, opened, denied (set here, so the answer can close itself) }
async function run(name, args, ctx) {
  args = args || {};
  try {
    switch (name) {
      case 'search_files':
        ctx.status(`Searching for "${String(args.query || '').slice(0, 40)}"…`);
        return notePaths(ctx, await searchFiles(String(args.query || '')));

      case 'recent_files':
        ctx.status(`Looking at your newest ${args.folder || 'files'}…`);
        return notePaths(ctx, await recentFiles(String(args.folder || 'downloads').toLowerCase(), String(args.query || '')));

      case 'claude_sessions':
        ctx.status('Checking your Claude Code sessions…');
        ctx.readHappened = true; // what Claude last said comes from your projects' files: data, not instructions
        return describeSessions(ctx.sessions());

      case 'open_file': {
        let c = checkPath(args.path);
        if (c.error) {
          const folder = checkFolderAnywhere(args.path); // folders may be shown from anywhere
          if (!folder) return c.error;
          c = folder;
        }
        if (!c.stat.isDirectory() && SCRIPTS.test(c.path)) return "That's a script or shortcut. The assistant never runs those; for an app, use open_app with its name.";
        if (!c.stat.isDirectory() && PROGRAMS.test(c.path)) return 'That is a program: use open_app with its full path instead.';
        const ok = await ctx.confirm({
          title: c.stat.isDirectory() ? 'Open this folder?' : 'Open this file?',
          target: c.path,
          warn: ctx.readHappened && !mentioned(ctx.mentionText || ctx.question, c.path) ? PLANTED : '',
          allowLabel: 'Open',
        });
        if (!ok) return (ctx.denied = true), DENIED;
        const err = await shell.openPath(c.path);
        return err ? `Couldn't open it: ${err}` : ((ctx.opened = true), `Opened ${c.path}.`);
      }

      case 'open_app': {
        const q = String(args.name || '').trim();
        if (!q) return 'Say which app.';
        if (path.isAbsolute(q) || /\.[a-z0-9]{2,4}$/i.test(q)) {
          if (!path.isAbsolute(q)) return 'Use the app name, or a full path from search_files.';
          const c = checkPath(q);
          if (c.error) return c.error;
          if (SCRIPTS.test(c.path)) return 'The assistant never runs scripts.';
          if (!PROGRAMS.test(c.path)) return 'That is not a program: use open_file for documents.';
          const ok = await ctx.confirm({
            title: `Run ${path.basename(c.path)}?`,
            target: c.path,
            warn: ctx.readHappened && !mentioned(ctx.mentionText || ctx.question, c.path) ? PLANTED : "This program isn't installed in your Start menu. Only run it if you trust where it came from.",
            allowLabel: 'Run',
          });
          if (!ok) return (ctx.denied = true), DENIED;
          const err = await shell.openPath(c.path);
          return err ? `Couldn't start it: ${err}` : ((ctx.opened = true), `Started ${c.path}.`);
        }
        if (!appsAt || Date.now() - appsAt > 10 * 60 * 1000) {
          ctx.status('Looking through your apps…');
          await loadApps();
        }
        const ranked = apps
          .map((a) => ({ a, s: appScore(q, a) }))
          .filter((x) => x.s >= 20)
          .sort((x, y) => y.s - x.s);
        if (!ranked.length) return `No installed app matches "${q}".`;
        const top = ranked[0];
        const rivals = ranked.filter((x) => x.s >= top.s - 5 && x !== top);
        if (top.s < 100 && rivals.length) return `Several apps match: ${[top, ...rivals].slice(0, 6).map((x) => x.a.name).join(', ')}. Call open_app with the exact name, or ask the user which one.`;
        const a = top.a;
        if (SCRIPTS.test(a.id) && !/\.url$/i.test(a.id)) return `"${a.name}" is a script, and the assistant never runs scripts.`;
        const ok = await ctx.confirm({
          title: `Open ${a.name}?`,
          target: describeApp(a),
          warn: ctx.readHappened && !mentioned(ctx.mentionText || ctx.question, a.name) ? PLANTED : '',
          allowLabel: 'Open',
        });
        if (!ok) return (ctx.denied = true), DENIED;
        await launchApp(a);
        ctx.opened = true;
        return `Opened ${a.name}.`;
      }

      case 'read_file': {
        const c = checkPath(args.path);
        if (c.error) return c.error;
        if (c.stat.isDirectory()) return 'That is a folder. Use search_files to find files in it.';
        if (BINARY_DOCS.test(c.path)) return "The assistant can't read that kind of file (only plain text files).";
        if (c.stat.size > MAX_TEXT) return 'That file is too big to read here.';
        ctx.status(`Reading ${path.basename(c.path)}…`);
        const text = textOf(fs.readFileSync(c.path));
        if (text == null) return 'That is not a text file.';
        ctx.readHappened = true;
        const t = text.replace(/\r\n/g, '\n');
        return t.length > 12000 ? `${t.slice(0, 12000)}\n[… the rest of the file was cut off]` : t || '(the file is empty)';
      }

      case 'edit_file': {
        const c = checkPath(args.path);
        if (c.error) return c.error;
        if (c.stat.isDirectory() || BINARY_DOCS.test(c.path)) return 'The assistant can only edit plain text files.';
        if (c.stat.size > MAX_TEXT) return 'That file is too big to edit here.';
        const raw = fs.readFileSync(c.path);
        const text = textOf(raw);
        if (text == null) return 'That is not a text file.';
        const crlf = /\r\n/.test(text);
        const content = text.replace(/\r\n/g, '\n');
        const find = String(args.find ?? '').replace(/\r\n/g, '\n');
        const replace = String(args.replace ?? '').replace(/\r\n/g, '\n');
        if (!find) return 'find is empty: copy the exact text to change from the file.';
        const count = content.split(find).length - 1;
        if (count !== 1) return `The find text appears ${count} times; it must appear exactly once. Read the file and copy a longer, exact piece.`;
        if (find === replace) return 'find and replace are the same, so nothing would change.';
        const start = content.indexOf(find);
        const next = content.slice(0, start) + replace + content.slice(start + find.length);
        const ok = await ctx.confirm({
          title: `Edit ${path.basename(c.path)}?`,
          target: c.path,
          diff: lineDiff(content, start, start + find.length, replace),
          warn: SCRIPTS.test(c.path)
            ? 'This file runs code. Only save the edit if you understand it.'
            : ctx.readHappened && !mentioned(ctx.mentionText || ctx.question, c.path)
              ? PLANTED
              : '',
          allowLabel: 'Save edit',
        });
        if (!ok) return (ctx.denied = true), DENIED;
        const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? '\uFEFF' : '';
        const out = Buffer.from(bom + (crlf ? next.replace(/\n/g, '\r\n') : next), 'utf8');
        ctx.editIds.push(backupAndWrite(c.path, raw, out));
        return `Edited ${path.basename(c.path)}.`;
      }
    }
    return `Unknown tool ${name}.`;
  } catch (e) {
    return `Error: ${e.message || e}`;
  }
}

let active = false;
const timers = [];
function init() {
  if (active) return;
  active = true;
  roots = ROOT_NAMES.map((n) => {
    try {
      return app.getPath(n);
    } catch {
      return null;
    }
  }).filter((p) => p && fs.existsSync(p));
  // the drive folder list: load yesterday's, rescan in the background when it's a day old (first
  // check a couple of minutes after startup, so it never competes with the pet starting up)
  fsp
    .readFile(driveFile(), 'utf8')
    .then((s) => setDrive(JSON.parse(s)))
    .catch(() => {});
  const check = () => (Date.now() - drive.at > DAY ? scanDrives() : null);
  timers.push(setTimeout(check, 2 * 60 * 1000), setInterval(check, 60 * 60 * 1000));
}
// The assistant was turned off: stop the background scans and forget what was indexed.
function stop() {
  active = false;
  timers.splice(0).forEach((t) => clearTimeout(t));
  index = [];
  indexAt = 0;
  setDrive({ at: 0, folders: [] });
  apps = [];
  appsAt = 0;
}
// Called when you open the prompt bar: refresh the file index and app list while you type.
function warm() {
  if (!active) return;
  if (!indexAt || Date.now() - indexAt > 5 * 60 * 1000) buildIndex();
  if (!appsAt || Date.now() - appsAt > 10 * 60 * 1000) loadApps();
}

module.exports = { init, stop, warm, run, undo, lastEdit, scanDrives, driveInfo };
